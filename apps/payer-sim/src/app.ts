/**
 * payer-sim HTTP API (docs/12-testing.md). Synthetic data only; runs in local, CI and preview.
 *
 *   POST /claims            a submitter (pm-mock's clearinghouse) sends claims
 *   GET  /acks?source=&since=  277CA results whose time has come on the simulated clock
 *   GET  /clock, POST /clock/advance?minutes=&days=   time control for tests and demos
 */
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Logger } from '@cleanpost/log';
import { acknowledge, ackDelayMinutes, submittedClaimSchema } from './ack';
import type { SimDb } from './db';
import { clock, submissions } from './schema';

export interface SimDeps {
  db: SimDb;
  log: Logger;
  /** Shared secret for submitters; open when absent (local only). */
  token?: string;
  realNow?: () => Date;
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
    app.use('/clock/*', auth);
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
      const row = {
        id,
        source: body.data.source,
        patientControlNumber: claim.patientControlNumber,
        payerName: claim.payerName,
        claim,
        receivedAt: now,
        ackDueAt: new Date(now.getTime() + ackDelayMinutes(id) * 60_000),
        ackStatus: ack.status,
        ackCodes: ack.codes,
        ackReasons: ack.reasons,
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
