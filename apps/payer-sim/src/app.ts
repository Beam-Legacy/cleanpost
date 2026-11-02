/**
 * payer-sim HTTP API (docs/12-testing.md). Synthetic data only; runs in local, CI and preview.
 *
 *   POST /claims            a submitter (pm-mock's clearinghouse) sends claims
 *   GET  /acks?source=&since=  277CA results whose time has come on the simulated clock
 *   GET  /remits?source=&after=  835s for a submitter, after a control number (runs payments first)
 *   POST /payments/run      decide the claims that are due and batch them into 835s
 *   GET  /clock, POST /clock/advance?minutes=&days=   time control for tests and demos
 */
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Logger } from '@cleanpost/log';
import { acknowledge, ackDelayMinutes, submittedClaimSchema } from './ack';
import type { NcciPair } from './adjudicate';
import type { SimDb } from './db';
import { eligibilityRequestSchema, memberRosterSchema, respond271 } from './eligibility';
import { adjudicationDelayDays, payerProfile } from './payers';
import { runPayments } from './payments';
import { loadNcci } from './reference';
import { clock, members, remittances, submissions } from './schema';

export interface SimDeps {
  db: SimDb;
  log: Logger;
  /** Shared secret for submitters; open when absent (local only). */
  token?: string;
  realNow?: () => Date;
  /** The NCCI pairs payers edit with; read from rules/seed/reference.json when absent. */
  ncci?: readonly NcciPair[];
}

export async function simNow(db: SimDb, realNow: () => Date): Promise<Date> {
  const [row] = await db.select().from(clock).where(eq(clock.id, 1));
  return new Date(realNow().getTime() + (row?.offsetMs ?? 0));
}

const submitBody = z.object({
  source: z.string().min(1).max(100),
  claims: z.array(submittedClaimSchema).min(1).max(500),
});

export function createPayerSimApp(deps: SimDeps) {
  const realNow = deps.realNow ?? (() => new Date());
  const ncci = deps.ncci ?? loadNcci();
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    deps.log.error({ err }, 'payer-sim error');
    return c.json({ error: 'internal' }, 500);
  });
  app.get('/health', (c) => c.json({ ok: true }));
  if (deps.token) {
    const auth = bearerAuth({ token: deps.token });
    app.use('/claims', auth);
    app.use('/acks', auth);
    app.use('/remits', auth);
    app.use('/payments/*', auth);
    app.use('/clock/*', auth);
    app.use('/members', auth);
    app.use('/2024-04-01/*', async (c, next) => {
      // Stedi sends the raw key in Authorization (no Bearer prefix); accept either here.
      const h = c.req.header('authorization') ?? '';
      if (h.replace(/^(Bearer|Key) /, '') !== deps.token) return c.json({ error: 'unauthorized' }, 401);
      await next();
    });
  }

  app.post('/claims', async (c) => {
    const body = submitBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid', field: body.error.issues[0]?.path.join('.') }, 422);
    const now = await simNow(deps.db, realNow);
    let accepted = 0;
    let rejected = 0;
    for (const claim of body.data.claims) {
      const id = `${body.data.source}:${claim.patientControlNumber}`;
      const ack = acknowledge(claim);
      if (ack.status === 'accepted') accepted++;
      else rejected++;
      const ackDueAt = new Date(now.getTime() + ackDelayMinutes(id) * 60_000);
      // A claim the payer already processed stays on file under another ID: the new one is a
      // replacement or void (frequency 7 or 8) of it, or an exact duplicate (CO-18).
      const [prior] = await deps.db
        .select({ id: submissions.id, adjudication: submissions.adjudication })
        .from(submissions)
        .where(eq(submissions.id, id));
      let replaces: string | null = null;
      if (prior?.adjudication) {
        const archived = `${id}#${now.getTime()}`;
        await deps.db.update(submissions).set({ id: archived }).where(eq(submissions.id, id));
        if (claim.frequencyCode === '7' || claim.frequencyCode === '8') replaces = archived;
      }
      const row = {
        id,
        source: body.data.source,
        patientControlNumber: claim.patientControlNumber,
        payerName: claim.payerName,
        claim,
        receivedAt: now,
        ackDueAt,
        ackStatus: ack.status,
        ackCodes: ack.codes,
        ackReasons: ack.reasons,
        payerId: payerProfile(claim.payerId, claim.payerName).id,
        memberId: claim.memberId ?? null,
        dateOfService: claim.dateOfService,
        adjudicateAt:
          ack.status === 'accepted'
            ? new Date(ackDueAt.getTime() + adjudicationDelayDays(id) * 86_400_000)
            : null,
        adjudication: null,
        remittanceId: null,
        replaces,
      };
      await deps.db.insert(submissions).values(row).onConflictDoUpdate({ target: submissions.id, set: row });
    }
    deps.log.info(
      { source: body.data.source, received: body.data.claims.length, accepted, rejected },
      'claims received',
    );
    return c.json({ received: body.data.claims.length });
  });

  app.get('/acks', async (c) => {
    const q = z
      .object({ source: z.string().min(1), since: z.iso.datetime({ offset: true }).optional() })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'source is required' }, 422);
    const now = await simNow(deps.db, realNow);
    const rows = await deps.db
      .select()
      .from(submissions)
      .where(
        and(
          eq(submissions.source, q.data.source),
          lte(submissions.ackDueAt, now),
          q.data.since ? gt(submissions.ackDueAt, new Date(q.data.since)) : undefined,
        ),
      )
      .orderBy(asc(submissions.ackDueAt))
      .limit(500);
    return c.json({
      now: now.toISOString(),
      acks: rows.map((r) => ({
        patientControlNumber: r.patientControlNumber,
        status: r.ackStatus,
        codes: r.ackCodes,
        reasons: r.ackReasons,
        at: r.ackDueAt.toISOString(),
      })),
    });
  });

  app.post('/payments/run', async (c) => {
    const run = await runPayments(deps.db, await simNow(deps.db, realNow), ncci);
    if (run.claims) deps.log.info(run, 'payment run');
    return c.json(run);
  });

  app.get('/remits', async (c) => {
    const q = z
      .object({ source: z.string().min(1), after: z.coerce.number().int().min(0).default(0) })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'source is required' }, 422);
    const now = await simNow(deps.db, realNow);
    const run = await runPayments(deps.db, now, ncci);
    if (run.claims) deps.log.info(run, 'payment run');
    const rows = await deps.db
      .select()
      .from(remittances)
      .where(and(eq(remittances.source, q.data.source), gt(remittances.control, q.data.after)))
      .orderBy(asc(remittances.control))
      .limit(100);
    return c.json({
      now: now.toISOString(),
      remits: rows.map((r) => ({
        id: r.id,
        control: r.control,
        payerId: r.payerId,
        payerName: r.payerName,
        traceNumber: r.traceNumber,
        method: r.method,
        amountCents: r.amountCents,
        paymentDate: r.paymentDate,
        claimCount: r.claimCount,
        x12: r.x12,
      })),
    });
  });

  // The payer's member file (pm-mock's seed loads it).
  app.post('/members', async (c) => {
    const body = memberRosterSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid', field: body.error.issues[0]?.path.join('.') }, 422);
    for (const m of body.data.members) {
      const row = {
        payerId: m.payerId,
        memberId: m.memberId,
        dateOfBirth: m.dateOfBirth,
        status: m.status,
        planBegin: m.planBegin ?? null,
        planEnd: m.planEnd ?? null,
        copayCents: m.copayCents ?? null,
        deductibleRemainingCents: m.deductibleRemainingCents ?? null,
        coinsurancePercent: m.coinsurancePercent ?? null,
      };
      await deps.db
        .insert(members)
        .values(row)
        .onConflictDoUpdate({ target: [members.payerId, members.memberId], set: row });
    }
    return c.json({ loaded: body.data.members.length });
  });

  // Stedi's real-time eligibility path and response shape (src/eligibility.ts).
  app.post('/2024-04-01/change/medicalnetwork/eligibility/v3', async (c) => {
    const req = eligibilityRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!req.success)
      return c.json({ errors: [{ code: '33', description: 'Input Errors', field: 'AAA' }] }, 400);
    const [member] = req.data.subscriber.memberId
      ? await deps.db
          .select()
          .from(members)
          .where(
            and(
              eq(members.payerId, req.data.tradingPartnerServiceId),
              eq(members.memberId, req.data.subscriber.memberId),
            ),
          )
      : [];
    return c.json(respond271(req.data, member ?? null));
  });

  app.get('/clock', async (c) => c.json({ now: (await simNow(deps.db, realNow)).toISOString() }));

  app.post('/clock/advance', async (c) => {
    const q = z
      .object({
        minutes: z.coerce.number().int().min(0).max(100_000).default(0),
        days: z.coerce.number().int().min(0).max(365).default(0),
      })
      .safeParse(c.req.query());
    if (!q.success) return c.json({ error: 'minutes and days must be whole numbers' }, 422);
    const ms = (q.data.minutes + q.data.days * 1440) * 60_000;
    await deps.db
      .insert(clock)
      .values({ id: 1, offsetMs: ms })
      .onConflictDoUpdate({ target: clock.id, set: { offsetMs: sql`${clock.offsetMs} + ${ms}` } });
    return c.json({ now: (await simNow(deps.db, realNow)).toISOString() });
  });

  return app;
}
