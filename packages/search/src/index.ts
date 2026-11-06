/**
 * G-03 Global search over the records a person may see: patients (name or date of birth), claims
 * (patient control number, the payer's claim number, or the patient), remittances (trace number, or
 * the patients they pay for) and clients. Client scope and role apply to every group; the query is
 * audit-logged as a hash with the result counts, never its text (a name is PHI).
 *
 * Results show the least they can: "Rivera, A." and an age; a full date of birth only when the query
 * was that date.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { auditEvents, withAudit, withTenant, type Database, type Tx } from '@cleanpost/db';
import { policy, search } from '@cleanpost/domain';

export interface SearchContext {
  tenantId: string;
  userId: string;
  actor: policy.Actor;
}

export interface PatientHit {
  id: string;
  name: string;
  age: number;
  /** Only when the query was this date of birth. */
  dob: string | null;
  client: string;
}

export interface ClaimHit {
  id: string;
  pcn: string | null;
  patient: string;
  dateOfService: string | null;
  payer: string | null;
  status: string;
  client: string;
}

export interface RemittanceHit {
  id: string;
  payer: string;
  method: string;
  trace: string;
  amountCents: number;
  paymentDate: string;
  /** "includes Rivera, A." when found through a patient. */
  patient: string | null;
}

export interface ClientHit {
  id: string;
  name: string;
  pmName: string | null;
  mode: string;
  status: string;
}

export interface SearchResults {
  kind: search.QueryKind;
  patients: PatientHit[];
  claims: ClaimHit[];
  remittances: RemittanceHit[];
  clients: ClientHit[];
}

const LIMITS = { patients: 6, claims: 6, remittances: 4, clients: 5 } as const;
const EMPTY = (kind: search.QueryKind): SearchResults => ({
  kind,
  patients: [],
  claims: [],
  remittances: [],
  clients: [],
});

/** The audit log keeps a hash of the query, so the same search can be told apart without its text. */
export const queryHash = (text: string) =>
  createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 16);

const can = (ctx: SearchContext, action: policy.Action) => policy.authorize(ctx.actor, action).allowed;

/** `column in (scope)` for the person's clients, or nothing for all. */
function inScope(ctx: SearchContext, column: SQL): SQL {
  const scope = policy.clientFilter(ctx.actor);
  if (scope === 'all') return sql`true`;
  if (!scope.length) return sql`false`;
  return sql`${column} in (${sql.join(
    scope.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

const like = (s: string) => `${search.likeEscape(s.toLowerCase())}%`;
const contains = (s: string) => `%${search.likeEscape(s.toLowerCase())}%`;

async function findPatients(tx: Tx, ctx: SearchContext, q: search.ParsedQuery, today: string) {
  let match: SQL;
  if (q.kind === 'dob') match = sql`p.dob = ${q.dob}::date`;
  else if (q.kind === 'name' && q.names) {
    const { a, b, comma } = q.names;
    match = b
      ? comma
        ? sql`lower(p.last_name) like ${like(a)} and lower(p.first_name) like ${like(b)}`
        : sql`(lower(p.last_name) like ${like(a)} and lower(p.first_name) like ${like(b)})
            or (lower(p.first_name) like ${like(a)} and lower(p.last_name) like ${like(b)})`
      : sql`lower(p.last_name) like ${like(a)} or lower(p.first_name) like ${like(a)}`;
  } else return [];
  const rows = await tx.execute<{
    id: string;
    first_name: string;
    last_name: string;
    dob: string;
    client: string;
  }>(sql`
    select p.id, p.first_name, p.last_name, p.dob::text as dob, cl.name as client
    from patients p join clients cl on cl.id = p.client_id
    where (${match}) and ${inScope(ctx, sql`p.client_id`)}
    order by p.last_name, p.first_name, p.dob
    limit ${LIMITS.patients}`);
  return rows.rows.map((r) => ({
    id: r.id,
    name: search.shortName(r.last_name, r.first_name),
    age: search.ageYears(r.dob, today),
    dob: q.kind === 'dob' ? r.dob : null,
    client: r.client,
  }));
}

const claimSelect = sql`
  select c.id, c.patient_control_number as pcn, p.first_name, p.last_name, e.date_of_service::text as dos,
    py.name as payer, c.status, cl.name as client
  from claims c join patients p on p.id = c.patient_id join clients cl on cl.id = c.client_id
    left join encounters e on e.id = c.encounter_id left join payers py on py.id = c.payer_id`;

type ClaimRow = {
  id: string;
  pcn: string | null;
  first_name: string;
  last_name: string;
  dos: string | null;
  payer: string | null;
  status: string;
  client: string;
};
const claimHit = (r: ClaimRow): ClaimHit => ({
  id: r.id,
  pcn: r.pcn,
  patient: search.shortName(r.last_name, r.first_name),
  dateOfService: r.dos,
  payer: r.payer,
  status: r.status,
  client: r.client,
});

async function findClaims(tx: Tx, ctx: SearchContext, q: search.ParsedQuery, patientIds: string[]) {
  let match: SQL;
  if (q.kind === 'number')
    match = sql`(lower(c.patient_control_number) like ${contains(q.text)}
      or c.id in (select rc.claim_id from remit_claims rc
        where lower(rc.payer_claim_control_number) like ${like(q.text)} and rc.claim_id is not null))`;
  else if (patientIds.length)
    match = sql`c.patient_id in (${sql.join(
      patientIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`;
  else return [];
  const rows = await tx.execute<ClaimRow>(sql`${claimSelect}
    where (${match}) and c.status <> 'voided' and ${inScope(ctx, sql`c.client_id`)}
    order by e.date_of_service desc nulls last, c.created_at desc
    limit ${LIMITS.claims}`);
  return rows.rows.map(claimHit);
}

async function findRemittances(tx: Tx, ctx: SearchContext, q: search.ParsedQuery, patientIds: string[]) {
  if (q.kind === 'number') {
    const rows = await tx.execute<{
      id: string;
      payer: string;
      method: string;
      trace: string;
      amount: string;
      date: string;
    }>(sql`
      select r.id, r.payer_name as payer, r.payment_method as method, r.trace_number as trace,
        r.payment_amount_cents as amount, r.payment_date::text as date
      from remittances r
      where lower(r.trace_number) like ${contains(q.text)} and ${inScope(ctx, sql`r.client_id`)}
      order by r.payment_date desc
      limit ${LIMITS.remittances}`);
    return rows.rows.map((r) => ({
      id: r.id,
      payer: r.payer,
      method: r.method,
      trace: r.trace,
      amountCents: Number(r.amount),
      paymentDate: r.date,
      patient: null,
    }));
  }
  if (!patientIds.length) return [];
  const rows = await tx.execute<{
    id: string;
    payer: string;
    method: string;
    trace: string;
    amount: string;
    date: string;
    first_name: string;
    last_name: string;
  }>(sql`
    select distinct on (r.payment_date, r.id) r.id, r.payer_name as payer, r.payment_method as method,
      r.trace_number as trace, r.payment_amount_cents as amount, r.payment_date::text as date,
      p.first_name, p.last_name
    from remit_claims rc join remittances r on r.id = rc.remittance_id
      join claims c on c.id = rc.claim_id join patients p on p.id = c.patient_id
    where c.patient_id in (${sql.join(
      patientIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) and ${inScope(ctx, sql`r.client_id`)}
    order by r.payment_date desc, r.id
    limit ${LIMITS.remittances}`);
  return rows.rows.map((r) => ({
    id: r.id,
    payer: r.payer,
    method: r.method,
    trace: r.trace,
    amountCents: Number(r.amount),
    paymentDate: r.date,
    patient: search.shortName(r.last_name, r.first_name),
  }));
}

async function findClients(tx: Tx, ctx: SearchContext, q: search.ParsedQuery) {
  if (q.kind !== 'name' && q.kind !== 'number') return [];
  const rows = await tx.execute<{
    id: string;
    name: string;
    pm: string | null;
    mode: string;
    status: string;
  }>(sql`
    select cl.id, cl.name, cl.default_mode as mode, cl.status,
      (select conn.settings->>'pmName' from connections conn where conn.client_id = cl.id limit 1) as pm
    from clients cl
    where lower(cl.name) like ${contains(q.text)} and cl.status <> 'offboarded' and ${inScope(ctx, sql`cl.id`)}
    order by cl.name
    limit ${LIMITS.clients}`);
  return rows.rows.map((r) => ({ id: r.id, name: r.name, pmName: r.pm, mode: r.mode, status: r.status }));
}

/**
 * Search the records the person may see. Records in the result are PHI, so the search is recorded
 * (`search.performed`): the query's kind and hash and how many of each it found.
 */
export async function searchRecords(
  db: Database,
  ctx: SearchContext,
  raw: string,
  today: string,
): Promise<SearchResults> {
  const q = search.parseQuery(raw);
  if (q.kind === 'empty' || q.kind === 'command') return EMPTY(q.kind);
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
    withAudit(
      tx,
      (r: SearchResults) => ({
        actor: `user:${ctx.userId}`,
        action: 'search.performed',
        entityType: 'search',
        metadata: {
          kind: q.kind,
          queryHash: queryHash(q.text),
          found: {
            patients: r.patients.length,
            claims: r.claims.length,
            remittances: r.remittances.length,
            clients: r.clients.length,
          },
        },
      }),
      async () => {
        const patients = can(ctx, 'patient.view') ? await findPatients(tx, ctx, q, today) : [];
        const ids = patients.map((p) => p.id);
        const claims = can(ctx, 'claim.view') ? await findClaims(tx, ctx, q, ids) : [];
        const remittances = can(ctx, 'remittance.view') ? await findRemittances(tx, ctx, q, ids) : [];
        const clients = can(ctx, 'client.view') ? await findClients(tx, ctx, q) : [];
        return { kind: q.kind, patients, claims, remittances, clients };
      },
    ),
  );
}

export interface RecentRecord {
  type: 'patient' | 'claim' | 'remittance';
  id: string;
  label: string;
  detail: string;
}

/**
 * G-03 with an empty query: the records the person opened last (from their own `*.viewed` audit
 * events), shown with today's labels and only while still in their scope. Nothing about them is
 * kept in the browser.
 */
export async function recentRecords(db: Database, ctx: SearchContext, limit = 5): Promise<RecentRecord[]> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const seen = await tx
      .select({ type: auditEvents.entityType, id: auditEvents.entityId, at: auditEvents.at })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actor, `user:${ctx.userId}`),
          inArray(auditEvents.action, ['patient.viewed', 'claim.viewed', 'remittance.viewed']),
        ),
      )
      .orderBy(desc(auditEvents.at))
      .limit(60);
    const picked: { type: RecentRecord['type']; id: string }[] = [];
    for (const s of seen) {
      if (!s.id || picked.some((p) => p.id === s.id)) continue;
      picked.push({ type: s.type as RecentRecord['type'], id: s.id });
      if (picked.length === limit) break;
    }
    if (!picked.length) return [];
    const idsOf = (t: RecentRecord['type']) => picked.filter((p) => p.type === t).map((p) => p.id);
    const list = (ids: string[]) =>
      sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
    const out = new Map<string, RecentRecord>();
    const patientIds = can(ctx, 'patient.view') ? idsOf('patient') : [];
    if (patientIds.length) {
      const rows = await tx.execute<{
        id: string;
        first_name: string;
        last_name: string;
        client: string;
      }>(sql`
        select p.id, p.first_name, p.last_name, cl.name as client from patients p join clients cl on cl.id = p.client_id
        where p.id in (${list(patientIds)}) and ${inScope(ctx, sql`p.client_id`)}`);
      for (const r of rows.rows)
        out.set(r.id, {
          type: 'patient',
          id: r.id,
          label: search.shortName(r.last_name, r.first_name),
          detail: r.client,
        });
    }
    const claimIds = can(ctx, 'claim.view') ? idsOf('claim') : [];
    if (claimIds.length) {
      const rows = await tx.execute<ClaimRow>(sql`${claimSelect}
        where c.id in (${list(claimIds)}) and ${inScope(ctx, sql`c.client_id`)}`);
      for (const r of rows.rows) {
        const h = claimHit(r);
        out.set(r.id, {
          type: 'claim',
          id: r.id,
          label: h.pcn ?? 'Claim',
          detail: [h.patient, h.payer].filter(Boolean).join(' · '),
        });
      }
    }
    const remitIds = can(ctx, 'remittance.view') ? idsOf('remittance') : [];
    if (remitIds.length) {
      const rows = await tx.execute<{ id: string; payer: string; trace: string; date: string }>(sql`
        select r.id, r.payer_name as payer, r.trace_number as trace, r.payment_date::text as date
        from remittances r where r.id in (${list(remitIds)}) and ${inScope(ctx, sql`r.client_id`)}`);
      for (const r of rows.rows)
        out.set(r.id, { type: 'remittance', id: r.id, label: `${r.payer} ${r.trace}`, detail: r.date });
    }
    const recent = picked.map((p) => out.get(p.id)).filter((r): r is RecentRecord => Boolean(r));
    if (recent.some((r) => r.type !== 'remittance'))
      await withAudit(
        tx,
        {
          actor: `user:${ctx.userId}`,
          action: 'search.recents_viewed',
          entityType: 'search',
          metadata: { shown: recent.length },
        },
        async () => undefined,
      );
    return recent;
  });
}
