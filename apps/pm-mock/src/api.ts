/**
 * The mock PM's REST API: one route per adapter operation (docs/05-adapters.md). The JSON is the
 * PM's own shape; Cleanpost's mock adapter maps it to the contract the way a real adapter would.
 *
 * Every request needs `Authorization: Bearer <account key>` and names a practice in that account.
 * Lists page by (updated_at, id) from `since`, so repeated pulls return the same records in the
 * same order. Errors are `{ error, message }` with fixed messages that never echo record data.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, inArray, or, type AnyColumn, type SQL } from 'drizzle-orm';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { PmDb } from './db';
import { parseFaultHeader, takeAccountFault } from './faults';
import { hashApiKey } from './keys';
import { PROFILE_RULES, type Endpoint, type ProfileRules } from './profiles';
import type { RateLimiter } from './rate-limit';
import {
  accounts,
  charges,
  claims,
  encounters,
  locations,
  patients,
  payments,
  policies,
  postings,
  practices,
  providers,
  remittances,
  writeLog,
} from './schema';

type Account = typeof accounts.$inferSelect;
type Practice = typeof practices.$inferSelect;

export type ApiEnv = {
  Variables: { account: Account; practice: Practice; rules: ProfileRules; partialPage?: boolean };
};

export interface ApiDeps {
  db: PmDb;
  limiter: RateLimiter;
  /** Multiplies every profile rate limit; tests raise it so contract runs stay fast. */
  rateScale: number;
  now: () => Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fail = (
  c: Context,
  status: 400 | 401 | 404 | 409 | 422 | 429 | 500 | 504,
  error: string,
  message: string,
) => c.json({ error, message }, status);

const notAvailable = (c: Context, what: string) =>
  fail(c, 404, 'not_available', `${what} is not available in this PM's API`);

// ---------- paging ----------

const pageQuery = z.object({
  since: z.iso.datetime({ offset: true }),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Cursor = [string, string];

const encodeCursor = (at: Date, id: string | number) =>
  Buffer.from(JSON.stringify([at.toISOString(), String(id)])).toString('base64url');

function decodeCursor(raw: string | undefined): Cursor | null | 'invalid' {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string') {
      if (Number.isNaN(Date.parse(v[0]))) return 'invalid';
      return [v[0], v[1]];
    }
  } catch {
    // fall through
  }
  return 'invalid';
}

function after(
  tsCol: AnyColumn,
  idCol: AnyColumn,
  cursor: Cursor | null,
  numericId = false,
): SQL | undefined {
  if (!cursor) return undefined;
  const at = new Date(cursor[0]);
  const id = numericId ? Number(cursor[1]) : cursor[1];
  return or(gt(tsCol, at), and(eq(tsCol, at), gt(idCol, id)));
}

function readPage(c: Context) {
  const q = pageQuery.safeParse(c.req.query());
  if (!q.success) return { ok: false, error: 'since (ISO date-time) is required; limit is 1-200' } as const;
  const cursor = decodeCursor(q.data.cursor);
  if (cursor === 'invalid') return { ok: false, error: 'cursor is not valid' } as const;
  return { ok: true, since: new Date(q.data.since), cursor, limit: q.data.limit } as const;
}

// ---------- serializers (the PM's JSON) ----------

function encounterJson(
  e: typeof encounters.$inferSelect,
  lines: (typeof charges.$inferSelect)[],
  rules: ProfileRules,
) {
  return {
    id: e.id,
    patientId: e.patientId,
    dateOfService: e.dateOfService,
    renderingProviderNpi: e.renderingNpi,
    ...(e.referringNpi ? { referringProviderNpi: e.referringNpi } : {}),
    locationId: e.locationId,
    placeOfService: e.placeOfService,
    ...(e.priorAuthNumber ? { priorAuthNumber: e.priorAuthNumber } : {}),
    diagnoses: e.diagnoses.map((d) => ({ sequence: d.sequence, code: d.icd10 })),
    charges: lines
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        id: l.id,
        line: l.lineNumber,
        code: l.code,
        modifiers: l.modifiers,
        units: l.units,
        amountCents: l.chargeCents,
        diagnosisPointers: l.pointers,
        ...(l.ndc ? { ndc: l.ndc } : {}),
      })),
    ...(rules.hold === 'workflow'
      ? { workflowStatus: e.workflowStatus }
      : { status: e.status, onHold: e.onHold }),
    ...(e.patientControlNumber ? { patientControlNumber: e.patientControlNumber } : {}),
    updatedAt: e.updatedAt.toISOString(),
  };
}

// ---------- request bodies ----------

const billedBody = z.object({ patientControlNumber: z.string().min(1).max(38) });

const correctionBody = z.object({
  changes: z
    .array(
      z.object({
        lineId: z.string().optional(),
        lineNumber: z.number().int().min(1).optional(),
        field: z.enum(['code', 'modifiers', 'units', 'diagnosisPointers', 'priorAuthNumber', 'diagnoses']),
        value: z.unknown(),
      }),
    )
    .min(1)
    .max(50),
});

const paymentBody = z.object({
  traceNumber: z.string().min(1).max(50),
  paymentDate: z.iso.date(),
  amountCents: z.number().int(),
  payerName: z.string().max(100).optional(),
  method: z.enum(['ACH', 'CHK', 'NON']).default('ACH'),
  lines: z
    .array(
      z.object({
        encounterId: z.string(),
        chargeId: z.string(),
        paidCents: z.number().int(),
        adjustments: z.array(z.object({ code: z.string().max(20), amountCents: z.number().int() })),
        patientRespCents: z.number().int(),
      }),
    )
    .max(1000)
    .default([]),
});

// ---------- routes ----------

export function apiRoutes(deps: ApiDeps) {
  const { db } = deps;
  const app = new Hono<ApiEnv>();

  const auth: MiddlewareHandler<ApiEnv> = async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key) return fail(c, 401, 'invalid_key', 'An API key is required');
    const [account] = await db
      .select()
      .from(accounts)
      .where(eq(accounts.apiKeyHash, hashApiKey(key)));
    if (!account) return fail(c, 401, 'invalid_key', 'The API key is not valid');
    const [practice] = await db
      .select()
      .from(practices)
      .where(and(eq(practices.id, c.req.param('pid') ?? ''), eq(practices.accountId, account.id)));
    if (!practice) return fail(c, 404, 'not_found', 'Practice not found in this account');
    c.set('account', account);
    c.set('practice', practice);
    c.set('rules', PROFILE_RULES[account.profile]);
    await next();
  };
  app.use('/practices/:pid', auth);
  app.use('/practices/:pid/*', auth);

  /** Faults, then the account's rate limit for this endpoint. */
  const guard =
    (endpoint: Endpoint): MiddlewareHandler<ApiEnv> =>
    async (c, next) => {
      const account = c.get('account');
      const rules = c.get('rules');
      const name = rules.endpointNames[endpoint];
      const fault =
        parseFaultHeader(c.req.header('x-mock-fault')) ??
        (await takeAccountFault(db, account, name, deps.now()));
      switch (fault?.kind) {
        case 'auth_expired':
          return fail(c, 401, 'token_expired', 'The session has expired; sign in again');
        case 'error_500':
          return fail(c, 500, 'server_error', 'Internal error');
        case 'rate_limited':
          c.header('Retry-After', '2');
          return fail(c, 429, 'rate_limited', `Rate limit exceeded for ${name}`);
        case 'timeout':
          await sleep(fault.latencyMs ?? 20_000);
          return fail(c, 504, 'timeout', 'The request timed out');
        case 'latency':
          await sleep(fault.latencyMs ?? 500);
          break;
        case 'partial_page':
          c.set('partialPage', true);
          break;
        default:
          break;
      }
      const waitMs = deps.limiter.take(`${account.id}:${name}`, rules.rates[endpoint] * deps.rateScale);
      if (waitMs > 0) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(waitMs / 1000))));
        return fail(c, 429, 'rate_limited', `Rate limit exceeded for ${name}`);
      }
      await next();
      if (c.get('partialPage') && c.res.status === 200) {
        // The connection drops halfway through the body.
        const text = await c.res.text();
        c.res = new Response(text.slice(0, Math.floor(text.length / 2)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    };

  const log = (practiceId: string, operation: string, target: string, result: string, details = {}) =>
    db.insert(writeLog).values({ practiceId, operation, target, result, details });

  app.get('/practices/:pid', guard('practice'), async (c) => {
    const p = c.get('practice');
    const [provs, locs] = await Promise.all([
      db.select().from(providers).where(eq(providers.practiceId, p.id)),
      db.select().from(locations).where(eq(locations.practiceId, p.id)),
    ]);
    return c.json({
      id: p.id,
      name: p.name,
      profile: c.get('account').profile,
      specialty: p.specialty,
      providers: provs.map((x) => ({ npi: x.npi })),
      locations: locs.map((l) => ({ id: l.id, name: l.name, placeOfService: l.placeOfService })),
    });
  });

  app.get('/practices/:pid/patients', guard('patients'), async (c) => {
    const page = readPage(c);
    if (!page.ok) return fail(c, 400, 'invalid', page.error);
    const pid = c.get('practice').id;
    const rows = await db
      .select()
      .from(patients)
      .where(
        and(
          eq(patients.practiceId, pid),
          gte(patients.updatedAt, page.since),
          after(patients.updatedAt, patients.id, page.cursor),
        ),
      )
      .orderBy(asc(patients.updatedAt), asc(patients.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const pols = items.length
      ? await db
          .select()
          .from(policies)
          .where(
            inArray(
              policies.patientId,
              items.map((r) => r.id),
            ),
          )
      : [];
    const last = items.at(-1);
    return c.json({
      items: items.map((p) => ({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        dateOfBirth: p.dob,
        sex: p.sex,
        ...(p.address ? { address: p.address } : {}),
        ...(p.phone ? { phone: p.phone } : {}),
        policies: pols
          .filter((x) => x.patientId === p.id)
          .sort((a, b) => a.priority - b.priority)
          .map((x) => ({
            id: x.id,
            payerName: x.payerName,
            priority: x.priority,
            memberId: x.memberId,
            ...(x.groupNumber ? { groupNumber: x.groupNumber } : {}),
            relationship: x.relationship,
            ...(x.subscriber ? { subscriber: x.subscriber } : {}),
            ...(x.effectiveDate ? { effectiveDate: x.effectiveDate } : {}),
            ...(x.terminationDate ? { terminationDate: x.terminationDate } : {}),
          })),
        updatedAt: p.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > page.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
    });
  });

  app.get('/practices/:pid/encounters', guard('encounters'), async (c) => {
    const page = readPage(c);
    if (!page.ok) return fail(c, 400, 'invalid', page.error);
    const pid = c.get('practice').id;
    const rows = await db
      .select()
      .from(encounters)
      .where(
        and(
          eq(encounters.practiceId, pid),
          gte(encounters.updatedAt, page.since),
          after(encounters.updatedAt, encounters.id, page.cursor),
        ),
      )
      .orderBy(asc(encounters.updatedAt), asc(encounters.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const lines = items.length
      ? await db
          .select()
          .from(charges)
          .where(
            inArray(
              charges.encounterId,
              items.map((e) => e.id),
            ),
          )
      : [];
    const last = items.at(-1);
    return c.json({
      items: items.map((e) =>
        encounterJson(
          e,
          lines.filter((l) => l.encounterId === e.id),
          c.get('rules'),
        ),
      ),
      nextCursor: rows.length > page.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
    });
  });

  app.get('/practices/:pid/claims', guard('claims'), async (c) => {
    const page = readPage(c);
    if (!page.ok) return fail(c, 400, 'invalid', page.error);
    const pid = c.get('practice').id;
    const rows = await db
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.practiceId, pid),
          gte(claims.updatedAt, page.since),
          after(claims.updatedAt, claims.encounterId, page.cursor),
        ),
      )
      .orderBy(asc(claims.updatedAt), asc(claims.encounterId))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return c.json({
      items: items.map((x) => ({
        encounterId: x.encounterId,
        patientControlNumber: x.patientControlNumber,
        status: x.status,
        rejectionReasons: x.rejectionReasons,
        updatedAt: x.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > page.limit && last ? encodeCursor(last.updatedAt, last.encounterId) : null,
    });
  });

  app.get('/practices/:pid/postings', guard('postings'), async (c) => {
    const page = readPage(c);
    if (!page.ok) return fail(c, 400, 'invalid', page.error);
    const pid = c.get('practice').id;
    const rows = await db
      .select({ posting: postings, traceNumber: payments.traceNumber })
      .from(postings)
      .innerJoin(payments, eq(payments.id, postings.paymentId))
      .where(
        and(
          eq(postings.practiceId, pid),
          gte(postings.postedAt, page.since),
          after(postings.postedAt, postings.id, page.cursor, true),
        ),
      )
      .orderBy(asc(postings.postedAt), asc(postings.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const last = items.at(-1)?.posting;
    return c.json({
      items: items.map(({ posting: p, traceNumber }) => ({
        paymentId: p.paymentId,
        traceNumber,
        encounterId: p.encounterId,
        ...(p.chargeId ? { chargeId: p.chargeId } : {}),
        paidCents: p.paidCents,
        adjustments: p.adjustments,
        patientRespCents: p.patientRespCents,
        postedAt: p.postedAt.toISOString(),
      })),
      nextCursor: rows.length > page.limit && last ? encodeCursor(last.postedAt, last.id) : null,
    });
  });

  app.get('/practices/:pid/remittances', guard('remittances'), async (c) => {
    if (!c.get('rules').remittances) return notAvailable(c, 'Remittance files');
    const page = readPage(c);
    if (!page.ok) return fail(c, 400, 'invalid', page.error);
    const pid = c.get('practice').id;
    const rows = await db
      .select()
      .from(remittances)
      .where(
        and(
          eq(remittances.practiceId, pid),
          gte(remittances.receivedAt, page.since),
          after(remittances.receivedAt, remittances.id, page.cursor),
        ),
      )
      .orderBy(asc(remittances.receivedAt), asc(remittances.id))
      .limit(page.limit + 1);
    const items = rows.slice(0, page.limit);
    const last = items.at(-1);
    return c.json({
      items: items.map((r) => ({ id: r.id, receivedAt: r.receivedAt.toISOString(), era: r.payload })),
      nextCursor: rows.length > page.limit && last ? encodeCursor(last.receivedAt, last.id) : null,
    });
  });

  const loadEncounter = async (c: Context<ApiEnv>) => {
    const [e] = await db
      .select()
      .from(encounters)
      .where(
        and(eq(encounters.id, c.req.param('eid') ?? ''), eq(encounters.practiceId, c.get('practice').id)),
      );
    return e;
  };

  app.post('/practices/:pid/encounters/:eid/hold', guard('encounter_update'), async (c) => {
    const rules = c.get('rules');
    const pid = c.get('practice').id;
    if (!rules.hold) return notAvailable(c, 'Holding charges');
    const e = await loadEncounter(c);
    if (!e) return fail(c, 404, 'not_found', 'Encounter not found');
    if (rules.hold === 'workflow') {
      if (e.workflowStatus === 'Approved' || e.workflowStatus === 'Rejected') {
        await log(pid, 'hold', e.id, 'conflict');
        return fail(c, 409, 'conflict', 'The encounter has already left review');
      }
      await log(pid, 'hold', e.id, 'ok', { workflowStatus: e.workflowStatus });
      return c.json({ ok: true, workflowStatus: e.workflowStatus });
    }
    if (e.status === 'billed' || e.status === 'void') {
      await log(pid, 'hold', e.id, 'conflict');
      return fail(c, 409, 'conflict', 'The encounter is already billed or void');
    }
    if (!e.onHold) {
      await db.update(encounters).set({ onHold: true, updatedAt: deps.now() }).where(eq(encounters.id, e.id));
    }
    await log(pid, 'hold', e.id, 'ok');
    return c.json({ ok: true, onHold: true });
  });

  app.post('/practices/:pid/encounters/:eid/release', guard('encounter_update'), async (c) => {
    const rules = c.get('rules');
    const pid = c.get('practice').id;
    if (!rules.hold) return notAvailable(c, 'Releasing charges');
    const e = await loadEncounter(c);
    if (!e) return fail(c, 404, 'not_found', 'Encounter not found');
    if (rules.hold === 'workflow') {
      if (e.workflowStatus === 'Draft' || e.workflowStatus === 'Rejected') {
        await log(pid, 'release', e.id, 'conflict', { workflowStatus: e.workflowStatus });
        return fail(c, 409, 'conflict', 'Only encounters in review can be approved');
      }
      if (e.workflowStatus === 'Review') {
        await db
          .update(encounters)
          .set({ workflowStatus: 'Approved', updatedAt: deps.now() })
          .where(eq(encounters.id, e.id));
      }
      await log(pid, 'release', e.id, 'ok', { workflowStatus: 'Approved' });
      return c.json({ ok: true, workflowStatus: 'Approved' });
    }
    if (e.status === 'void') {
      await log(pid, 'release', e.id, 'conflict');
      return fail(c, 409, 'conflict', 'The encounter is void');
    }
    if (e.onHold) {
      await db
        .update(encounters)
        .set({ onHold: false, updatedAt: deps.now() })
        .where(eq(encounters.id, e.id));
    }
    await log(pid, 'release', e.id, 'ok');
    return c.json({ ok: true, onHold: false });
  });

  app.post('/practices/:pid/encounters/:eid/billed', guard('encounter_update'), async (c) => {
    const rules = c.get('rules');
    const pid = c.get('practice').id;
    if (!rules.markBilled) return notAvailable(c, 'Marking charges billed');
    const body = billedBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 422, 'invalid', 'patientControlNumber is required');
    const e = await loadEncounter(c);
    if (!e) return fail(c, 404, 'not_found', 'Encounter not found');
    if (e.status === 'void') {
      await log(pid, 'mark_billed', e.id, 'conflict');
      return fail(c, 409, 'conflict', 'The encounter is void');
    }
    const now = deps.now();
    await db.transaction(async (tx) => {
      await tx
        .update(encounters)
        .set({
          status: 'billed',
          onHold: false,
          patientControlNumber: body.data.patientControlNumber,
          updatedAt: now,
        })
        .where(eq(encounters.id, e.id));
      await tx
        .insert(claims)
        .values({
          encounterId: e.id,
          practiceId: pid,
          patientControlNumber: body.data.patientControlNumber,
          status: 'queued',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: claims.encounterId,
          set: { patientControlNumber: body.data.patientControlNumber, updatedAt: now },
        });
    });
    await log(pid, 'mark_billed', e.id, 'ok');
    return c.json({ ok: true });
  });

  app.post('/practices/:pid/encounters/:eid/corrections', guard('encounter_update'), async (c) => {
    const rules = c.get('rules');
    const pid = c.get('practice').id;
    if (!rules.corrections) return notAvailable(c, 'Charge corrections');
    const body = correctionBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(c, 422, 'invalid', 'changes must list field and value');
    const e = await loadEncounter(c);
    if (!e) return fail(c, 404, 'not_found', 'Encounter not found');
    if (e.status === 'billed' || e.status === 'void') {
      await log(pid, 'correct', e.id, 'conflict');
      return fail(c, 409, 'conflict', 'Billed or void encounters cannot be changed');
    }
    const lines = await db.select().from(charges).where(eq(charges.encounterId, e.id));
    const result = await db.transaction(async (tx) => {
      for (const ch of body.data.changes) {
        if (ch.field === 'priorAuthNumber' || ch.field === 'diagnoses') {
          if (ch.field === 'priorAuthNumber' && typeof ch.value !== 'string' && ch.value !== null)
            return 'invalid';
          if (ch.field === 'diagnoses') {
            const dx = z
              .array(z.object({ sequence: z.number().int(), icd10: z.string() }))
              .safeParse(ch.value);
            if (!dx.success) return 'invalid';
            await tx.update(encounters).set({ diagnoses: dx.data }).where(eq(encounters.id, e.id));
          } else {
            await tx
              .update(encounters)
              .set({ priorAuthNumber: (ch.value as string | null) ?? null })
              .where(eq(encounters.id, e.id));
          }
          continue;
        }
        const line = lines.find((l) =>
          ch.lineId ? l.id === ch.lineId : l.lineNumber === (ch.lineNumber ?? 1),
        );
        if (!line) return 'missing_line';
        const value = ch.value;
        const set =
          ch.field === 'code' && typeof value === 'string'
            ? { code: value }
            : ch.field === 'units' && Number.isInteger(value) && (value as number) > 0
              ? { units: value as number }
              : ch.field === 'modifiers' && z.array(z.string().max(2)).max(4).safeParse(value).success
                ? { modifiers: value as string[] }
                : ch.field === 'diagnosisPointers' &&
                    z.array(z.number().int().min(1).max(12)).max(4).safeParse(value).success
                  ? { pointers: value as number[] }
                  : null;
        if (!set) return 'invalid';
        await tx.update(charges).set(set).where(eq(charges.id, line.id));
      }
      await tx.update(encounters).set({ updatedAt: deps.now() }).where(eq(encounters.id, e.id));
      return 'ok';
    });
    if (result === 'missing_line') return fail(c, 404, 'not_found', 'Charge line not found');
    if (result === 'invalid') return fail(c, 422, 'invalid', 'A change has a value of the wrong type');
    await log(pid, 'correct', e.id, 'ok', { fields: body.data.changes.map((ch) => ch.field) });
    return c.json({ ok: true });
  });

  app.post('/practices/:pid/payments', guard('payments'), async (c) => {
    const rules = c.get('rules');
    const pid = c.get('practice').id;
    const body = paymentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return fail(c, 422, 'invalid', 'traceNumber, paymentDate and amountCents are required');
    const p = body.data;
    const [existing] = await db
      .select()
      .from(payments)
      .where(and(eq(payments.practiceId, pid), eq(payments.traceNumber, p.traceNumber)));
    if (existing)
      return c.json({ ok: true, id: existing.id, existing: true, headerOnly: existing.headerOnly });
    const headerOnly = rules.payments === 'header';
    if (!headerOnly && p.lines.length) {
      const ids = [...new Set(p.lines.map((l) => l.chargeId))];
      const found = await db
        .select({ id: charges.id, encounterId: charges.encounterId })
        .from(charges)
        .innerJoin(encounters, eq(encounters.id, charges.encounterId))
        .where(and(inArray(charges.id, ids), eq(encounters.practiceId, pid)));
      const known = new Map(found.map((f) => [f.id, f.encounterId]));
      if (p.lines.some((l) => known.get(l.chargeId) !== l.encounterId)) {
        await log(pid, 'post_payment', p.traceNumber, 'invalid');
        return fail(c, 422, 'invalid', 'A payment line refers to a charge that is not in this practice');
      }
    }
    const id = `PAY-${randomUUID().slice(0, 8).toUpperCase()}`;
    const now = deps.now();
    await db.transaction(async (tx) => {
      await tx.insert(payments).values({
        id,
        practiceId: pid,
        payerName: p.payerName ?? null,
        traceNumber: p.traceNumber,
        method: p.method,
        amountCents: p.amountCents,
        paymentDate: p.paymentDate,
        headerOnly,
        source: 'api',
      });
      if (!headerOnly && p.lines.length) {
        await tx.insert(postings).values(
          p.lines.map((l) => ({
            practiceId: pid,
            paymentId: id,
            encounterId: l.encounterId,
            chargeId: l.chargeId,
            paidCents: l.paidCents,
            adjustments: l.adjustments,
            patientRespCents: l.patientRespCents,
            postedAt: now,
          })),
        );
      }
    });
    await log(pid, 'post_payment', p.traceNumber, 'ok', {
      lines: headerOnly ? 0 : p.lines.length,
      headerOnly,
    });
    return c.json({ ok: true, id, headerOnly });
  });

  return app;
}
