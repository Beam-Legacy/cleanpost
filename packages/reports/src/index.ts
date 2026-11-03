/**
 * Reports (RP-01 to RP-05, DEC-20): aggregates over claims, claim events, 835s and work items for the
 * clients in a scope. Totals only; no patient appears in any report, so nothing here is
 * a PHI read. Dates are Pacific calendar days; "today" is demo time (DEC-18) where that applies.
 * Computed on request; the hourly rollup tables in the RP-01 design come when volume needs them.
 */
import { sql, type SQL } from 'drizzle-orm';
import { now as clockNow } from '@cleanpost/clock';
import { withTenant, type Database, type Tx } from '@cleanpost/db';
import { remit, reports } from '@cleanpost/domain';

const TZ = 'America/Los_Angeles';
const NONE = '00000000-0000-0000-0000-000000000000';
/** Claim states whose balance is still owed by the payer (insurance A/R). */
const INSURANCE_AR = ['submitted', 'accepted', 'denied', 'rejected'];

export const todayPacific = (d = clockNow()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

/** Who is asking and which clients they may see (the web passes the session's scope). */
export interface ReportScope {
  tenantId: string;
  userId?: string;
  clients: readonly string[] | 'all';
}

function scopeIds(scope: ReportScope, clientId?: string): string[] | 'all' {
  const s = scope.clients;
  if (clientId) return s === 'all' || s.includes(clientId) ? [clientId] : [NONE];
  return s === 'all' ? 'all' : s.length ? [...s] : [NONE];
}

const tenantOf = (scope: ReportScope) => ({
  tenantId: scope.tenantId,
  ...(scope.userId ? { userId: scope.userId } : {}),
});

/** `alias.client_id` limited to the scope, as bound parameters. */
function inScope(ids: string[] | 'all', column: SQL): SQL {
  if (ids === 'all') return sql`true`;
  return sql`${column} in (${sql.join(
    ids.map((i) => sql`${i}::uuid`),
    sql`, `,
  )})`;
}

const pacificDate = (column: SQL) => sql`(${column} at time zone ${TZ})::date`;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

// ---------- per-client figures for a period ----------

export interface ClientFigures {
  clientId: string;
  claims: number;
  chargesCents: number;
  collectionsCents: number;
  adjustmentsCents: number;
  firstPass: { accepted: number; total: number };
  lines: { denied: number; total: number; deniedCents: number };
  released: { auto: number; total: number };
  era: { clean: number; total: number };
  chargeToSubmissionDays: number | null;
  remitToPostedDays: number | null;
}

const empty = (clientId: string): ClientFigures => ({
  clientId,
  claims: 0,
  chargesCents: 0,
  collectionsCents: 0,
  adjustmentsCents: 0,
  firstPass: { accepted: 0, total: 0 },
  lines: { denied: 0, total: 0, deniedCents: 0 },
  released: { auto: 0, total: 0 },
  era: { clean: 0, total: 0 },
  chargeToSubmissionDays: null,
  remitToPostedDays: null,
});

async function figures(
  tx: Tx,
  ids: string[] | 'all',
  p: reports.Period,
): Promise<Map<string, ClientFigures>> {
  const out = new Map<string, ClientFigures>();
  const get = (id: string) => out.get(id) ?? out.set(id, empty(id)).get(id)!;

  const charges = await tx.execute<{ client_id: string; n: number; cents: string }>(sql`
    select c.client_id, count(*)::int as n, sum(c.total_charge_cents) as cents
    from claims c join encounters e on e.id = c.encounter_id
    where c.status <> 'voided' and e.date_of_service between ${p.from} and ${p.to}
      and ${inScope(ids, sql`c.client_id`)}
    group by 1`);
  for (const r of charges.rows) Object.assign(get(r.client_id), { claims: r.n, chargesCents: num(r.cents) });

  const paid = await tx.execute<{ client_id: string; paid: string; adj: string }>(sql`
    select rc.client_id, sum(rc.paid_cents) as paid,
      (select coalesce(sum(a.amount_cents), 0) from remit_adjustments a
        left join remit_lines xl on xl.id = a.remit_line_id
        join remit_claims x on x.id = coalesce(a.remit_claim_id, xl.remit_claim_id)
        join remittances y on y.id = x.remittance_id
        where x.client_id = rc.client_id and a.group_code in ('CO', 'OA')
          and y.payment_date between ${p.from} and ${p.to}) as adj
    from remit_claims rc join remittances r on r.id = rc.remittance_id
    where r.payment_date between ${p.from} and ${p.to} and rc.claim_id is not null
      and ${inScope(ids, sql`rc.client_id`)}
    group by 1`);
  for (const r of paid.rows)
    Object.assign(get(r.client_id), { collectionsCents: num(r.paid), adjustmentsCents: num(r.adj) });

  const first = await tx.execute<{ client_id: string; accepted: number; total: number }>(sql`
    with first as (
      select distinct on (claim_id) claim_id, client_id, type, occurred_at from claim_events
      where type in ('ack_277ca', 'rejected') and ${inScope(ids, sql`client_id`)}
      order by claim_id, occurred_at)
    select client_id, count(*) filter (where type = 'ack_277ca')::int as accepted, count(*)::int as total
    from first where ${pacificDate(sql`occurred_at`)} between ${p.from} and ${p.to}
    group by 1`);
  for (const r of first.rows) get(r.client_id).firstPass = { accepted: r.accepted, total: r.total };

  // Lines on 835s paid in the period, with their adjustments; denials as the 835 ingest sees them.
  const adj = await tx.execute<{
    client_id: string;
    line_id: string;
    group_code: string | null;
    carc: string | null;
    amount_cents: string | null;
  }>(sql`
    select l.client_id, l.id as line_id, a.group_code, a.carc, a.amount_cents
    from remit_lines l join remit_claims rc on rc.id = l.remit_claim_id
    join remittances r on r.id = rc.remittance_id
    left join remit_adjustments a on a.remit_line_id = l.id
    where r.payment_date between ${p.from} and ${p.to} and rc.claim_id is not null
      and ${inScope(ids, sql`l.client_id`)}`);
  const lines = new Map<string, { clientId: string; deniedCents: number }>();
  for (const r of adj.rows) {
    const l =
      lines.get(r.line_id) ?? lines.set(r.line_id, { clientId: r.client_id, deniedCents: 0 }).get(r.line_id)!;
    if (
      r.group_code &&
      r.carc &&
      remit.isDenialAdjustment({
        group: r.group_code as remit.Adjustment['group'],
        carc: r.carc,
        amountCents: num(r.amount_cents),
      })
    )
      l.deniedCents += num(r.amount_cents);
  }
  for (const l of lines.values()) {
    const f = get(l.clientId);
    f.lines.total++;
    if (l.deniedCents > 0) {
      f.lines.denied++;
      f.lines.deniedCents += l.deniedCents;
    }
  }

  const released = await tx.execute<{
    client_id: string;
    total: number;
    auto: number;
    days: string | null;
  }>(sql`
    with rel as (
      select distinct on (claim_id) claim_id, client_id, occurred_at from claim_events
      where type = 'released' and ${inScope(ids, sql`client_id`)} order by claim_id, occurred_at)
    select r.client_id, count(*)::int as total,
      count(*) filter (where not exists (select 1 from claim_events a
        where a.claim_id = r.claim_id and a.type = 'approved' and a.occurred_at <= r.occurred_at))::int as auto,
      percentile_cont(0.5) within group (order by ${pacificDate(sql`r.occurred_at`)} - e.date_of_service) as days
    from rel r join claims c on c.id = r.claim_id join encounters e on e.id = c.encounter_id
    where ${pacificDate(sql`r.occurred_at`)} between ${p.from} and ${p.to}
    group by 1`);
  for (const r of released.rows)
    Object.assign(get(r.client_id), {
      released: { auto: r.auto, total: r.total },
      chargeToSubmissionDays: numOrNull(r.days),
    });

  const era = await tx.execute<{ client_id: string; total: number; clean: number }>(sql`
    select l.client_id, count(*)::int as total,
      count(*) filter (where l.verify_status = 'verified' and not exists (select 1 from work_items w
        where w.remittance_id = r.id and w.type in ('posting_exception', 'out_of_balance')))::int as clean
    from remit_lines l join remit_claims rc on rc.id = l.remit_claim_id
    join remittances r on r.id = rc.remittance_id
    where ${pacificDate(sql`r.created_at`)} between ${p.from} and ${p.to} and rc.claim_id is not null
      and ${inScope(ids, sql`l.client_id`)}
    group by 1`);
  for (const r of era.rows) get(r.client_id).era = { clean: r.clean, total: r.total };

  const posted = await tx.execute<{ client_id: string; days: string | null }>(sql`
    with done as (
      select r.client_id, r.created_at, max(l.verified_at) as at
      from remittances r join remit_claims rc on rc.remittance_id = r.id
      join remit_lines l on l.remit_claim_id = rc.id
      where ${inScope(ids, sql`r.client_id`)}
      group by r.id, r.client_id, r.created_at
      having bool_and(l.verify_status = 'verified'))
    select client_id, percentile_cont(0.5) within group (order by extract(epoch from at - created_at) / 86400) as days
    from done where ${pacificDate(sql`at`)} between ${p.from} and ${p.to}
    group by 1`);
  for (const r of posted.rows) get(r.client_id).remitToPostedDays = numOrNull(r.days);
  return out;
}

/** Sums client figures (medians are not additive: weighted by released claims, an approximation). */
function total(list: ClientFigures[]): ClientFigures {
  const t = empty('all');
  let c2s = 0;
  let c2sW = 0;
  let r2p = 0;
  let r2pW = 0;
  for (const f of list) {
    t.claims += f.claims;
    t.chargesCents += f.chargesCents;
    t.collectionsCents += f.collectionsCents;
    t.adjustmentsCents += f.adjustmentsCents;
    t.firstPass.accepted += f.firstPass.accepted;
    t.firstPass.total += f.firstPass.total;
    t.lines.denied += f.lines.denied;
    t.lines.total += f.lines.total;
    t.lines.deniedCents += f.lines.deniedCents;
    t.released.auto += f.released.auto;
    t.released.total += f.released.total;
    t.era.clean += f.era.clean;
    t.era.total += f.era.total;
    if (f.chargeToSubmissionDays !== null) {
      c2s += f.chargeToSubmissionDays * f.released.total;
      c2sW += f.released.total;
    }
    if (f.remitToPostedDays !== null) {
      r2p += f.remitToPostedDays * Math.max(1, f.era.total);
      r2pW += Math.max(1, f.era.total);
    }
  }
  t.chargeToSubmissionDays = c2sW ? Math.round((c2s / c2sW) * 10) / 10 : null;
  t.remitToPostedDays = r2pW ? Math.round((r2p / r2pW) * 10) / 10 : null;
  return t;
}

// ---------- A/R ----------

interface ArRow {
  clientId: string;
  payerId: string | null;
  payerName: string;
  balanceCents: number;
  days: number;
}

async function insuranceAr(tx: Tx, ids: string[] | 'all', today: string): Promise<ArRow[]> {
  const res = await tx.execute<{
    client_id: string;
    payer_id: string | null;
    payer: string | null;
    balance: string;
    days: number;
  }>(sql`
    with sent as (
      select claim_id, min(occurred_at) filter (where type = 'ack_277ca') as accepted,
        min(occurred_at) filter (where type = 'released') as released
      from claim_events where type in ('ack_277ca', 'released') and ${inScope(ids, sql`client_id`)}
      group by claim_id)
    select c.client_id, c.payer_id, p.name as payer, c.balance_cents as balance,
      (${today}::date - ${pacificDate(sql`coalesce(s.accepted, s.released, c.created_at)`)})::int as days
    from claims c left join sent s on s.claim_id = c.id left join payers p on p.id = c.payer_id
    where c.status in (${sql.join(
      INSURANCE_AR.map((x) => sql`${x}`),
      sql`, `,
    )}) and c.balance_cents > 0
      and ${inScope(ids, sql`c.client_id`)}`);
  return res.rows.map((r) => ({
    clientId: r.client_id,
    payerId: r.payer_id,
    payerName: r.payer ?? 'Unknown payer',
    balanceCents: num(r.balance),
    days: Math.max(0, r.days),
  }));
}

async function patientAr(tx: Tx, ids: string[] | 'all', today: string): Promise<ArRow[]> {
  const res = await tx.execute<{
    client_id: string;
    payer_id: string | null;
    payer: string | null;
    resp: string;
    days: number;
  }>(sql`
    select rc.client_id, c.payer_id, coalesce(p.name, r.payer_name) as payer, rc.patient_resp_cents as resp,
      (${today}::date - r.payment_date)::int as days
    from remit_claims rc join remittances r on r.id = rc.remittance_id
    join claims c on c.id = rc.claim_id left join payers p on p.id = c.payer_id
    where rc.patient_resp_cents > 0 and c.status in ('paid', 'partially_paid')
      and ${inScope(ids, sql`rc.client_id`)}`);
  return res.rows.map((r) => ({
    clientId: r.client_id,
    payerId: r.payer_id,
    payerName: r.payer ?? 'Unknown payer',
    balanceCents: num(r.resp),
    days: Math.max(0, r.days),
  }));
}

async function charges90(tx: Tx, ids: string[] | 'all', today: string) {
  const res = await tx.execute<{ client_id: string; cents: string }>(sql`
    select c.client_id, sum(c.total_charge_cents) as cents
    from claims c join encounters e on e.id = c.encounter_id
    where c.status <> 'voided' and e.date_of_service > ${today}::date - 90 and e.date_of_service <= ${today}::date
      and ${inScope(ids, sql`c.client_id`)}
    group by 1`);
  return new Map(res.rows.map((r) => [r.client_id, num(r.cents)]));
}

// ---------- clients ----------

export interface ReportClient {
  id: string;
  name: string;
  mode: string;
  status: string;
  goLiveAt: Date | null;
}

async function clientsIn(tx: Tx, ids: string[] | 'all'): Promise<ReportClient[]> {
  const res = await tx.execute<{
    id: string;
    name: string;
    default_mode: string;
    status: string;
    go_live_at: Date | null;
  }>(sql`
    select id, name, default_mode, status, go_live_at from clients
    where status <> 'offboarded' and ${inScope(ids, sql`id`)} order by name`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    mode: r.default_mode,
    status: r.status,
    goLiveAt: r.go_live_at ? new Date(r.go_live_at) : null,
  }));
}

// ---------- RP-01 overview ----------

export interface Kpis {
  collectionsCents: number;
  chargesCents: number;
  adjustmentsCents: number;
  firstPass: number | null;
  denialRate: number | null;
  deniedCents: number;
  daysInAr: number | null;
  releasedWithoutReview: number | null;
  linesWithoutTouch: number | null;
  chargeToSubmission: number | null;
  remitToPosted: number | null;
  claims: number;
  /** The raw counts, for RP-07's "with this client's numbers". */
  inputs: {
    firstPass: { accepted: number; total: number };
    lines: { denied: number; total: number };
    released: { auto: number; total: number };
    era: { clean: number; total: number };
    openArCents: number;
    charges90Cents: number;
  };
}

function kpisOf(f: ClientFigures, openArCents: number, charges90Cents: number): Kpis {
  return {
    collectionsCents: f.collectionsCents,
    chargesCents: f.chargesCents,
    adjustmentsCents: f.adjustmentsCents,
    firstPass: reports.rate(f.firstPass.accepted, f.firstPass.total),
    denialRate: reports.rate(f.lines.denied, f.lines.total),
    deniedCents: f.lines.deniedCents,
    daysInAr: reports.daysInAr(openArCents, charges90Cents),
    releasedWithoutReview: reports.rate(f.released.auto, f.released.total),
    linesWithoutTouch: reports.rate(f.era.clean, f.era.total),
    chargeToSubmission: f.chargeToSubmissionDays,
    remitToPosted: f.remitToPostedDays,
    claims: f.claims,
    inputs: {
      firstPass: f.firstPass,
      lines: { denied: f.lines.denied, total: f.lines.total },
      released: f.released,
      era: f.era,
      openArCents,
      charges90Cents,
    },
  };
}

export interface ClientRow {
  client: ReportClient;
  kpis: Kpis;
  openItems: number;
}

export interface Overview {
  period: reports.Period;
  previous: reports.Period;
  kpis: Kpis;
  before: Kpis;
  clients: ClientRow[];
  /** First-pass acceptance by Monday-start week. */
  weekly: { week: string; accepted: number; total: number; rate: number | null }[];
}

async function weeklyFirstPass(tx: Tx, ids: string[] | 'all', p: reports.Period) {
  const res = await tx.execute<{ week: string; accepted: number; total: number }>(sql`
    with first as (
      select distinct on (claim_id) claim_id, type, occurred_at from claim_events
      where type in ('ack_277ca', 'rejected') and ${inScope(ids, sql`client_id`)}
      order by claim_id, occurred_at)
    select to_char(date_trunc('week', ${pacificDate(sql`occurred_at`)}), 'YYYY-MM-DD') as week,
      count(*) filter (where type = 'ack_277ca')::int as accepted, count(*)::int as total
    from first where ${pacificDate(sql`occurred_at`)} between ${p.from} and ${p.to}
    group by 1 order by 1`);
  const by = new Map(res.rows.map((r) => [r.week, r]));
  return reports.weeksOf(p).map((week) => {
    const r = by.get(week);
    return {
      week,
      accepted: r?.accepted ?? 0,
      total: r?.total ?? 0,
      rate: r ? reports.rate(r.accepted, r.total) : null,
    };
  });
}

async function openItemsBy(tx: Tx, ids: string[] | 'all') {
  const res = await tx.execute<{ client_id: string; n: number }>(sql`
    select client_id, count(*)::int as n from work_items
    where status <> 'resolved' and client_id is not null and ${inScope(ids, sql`client_id`)}
    group by 1`);
  return new Map(res.rows.map((r) => [r.client_id, r.n]));
}

export async function getOverview(
  db: Database,
  scope: ReportScope,
  period: reports.Period,
  clientId?: string,
  today = todayPacific(),
): Promise<Overview> {
  const ids = scopeIds(scope, clientId);
  const previous = reports.previousPeriod(period);
  return withTenant(db, tenantOf(scope), async (tx) => {
    const [clients, now, before, ar, c90, open, weekly] = [
      await clientsIn(tx, ids),
      await figures(tx, ids, period),
      await figures(tx, ids, previous),
      await insuranceAr(tx, ids, today),
      await charges90(tx, ids, today),
      await openItemsBy(tx, ids),
      await weeklyFirstPass(tx, ids, period),
    ];
    const arBy = new Map<string, number>();
    for (const a of ar) arBy.set(a.clientId, (arBy.get(a.clientId) ?? 0) + a.balanceCents);
    const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
    return {
      period,
      previous,
      kpis: kpisOf(total([...now.values()]), sum(arBy), sum(c90)),
      before: kpisOf(total([...before.values()]), 0, 0),
      clients: clients.map((c) => ({
        client: c,
        kpis: kpisOf(now.get(c.id) ?? empty(c.id), arBy.get(c.id) ?? 0, c90.get(c.id) ?? 0),
        openItems: open.get(c.id) ?? 0,
      })),
      weekly,
    };
  });
}

// ---------- RP-02 client report: payers ----------

export interface PayerRow {
  payerName: string;
  /** Claims for dates of service in the period. */
  claims: number;
  firstPass: number | null;
  denialRate: number | null;
  paidCents: number;
  /** Median days from release to the payer's payment. */
  daysToPay: number | null;
}

/** RP-02 "By payer"; payers with under 20 claims roll into "Other payers" (RP-02 rule). */
export async function getPayerResults(
  db: Database,
  scope: ReportScope,
  clientId: string,
  p: reports.Period,
): Promise<{ rows: PayerRow[]; other: { payers: number; paidCents: number } | null }> {
  const ids = scopeIds(scope, clientId);
  return withTenant(db, tenantOf(scope), async (tx) => {
    const claimsBy = await tx.execute<{ payer_id: string | null; name: string | null; n: number }>(sql`
      select c.payer_id, p.name, count(*)::int as n
      from claims c join encounters e on e.id = c.encounter_id left join payers p on p.id = c.payer_id
      where c.status <> 'voided' and e.date_of_service between ${p.from} and ${p.to}
        and ${inScope(ids, sql`c.client_id`)}
      group by 1, 2`);
    const first = await tx.execute<{ payer_id: string | null; accepted: number; total: number }>(sql`
      with first as (
        select distinct on (claim_id) claim_id, type, occurred_at from claim_events
        where type in ('ack_277ca', 'rejected') and ${inScope(ids, sql`client_id`)}
        order by claim_id, occurred_at)
      select c.payer_id, count(*) filter (where f.type = 'ack_277ca')::int as accepted, count(*)::int as total
      from first f join claims c on c.id = f.claim_id
      where ${pacificDate(sql`f.occurred_at`)} between ${p.from} and ${p.to}
      group by 1`);
    const paid = await tx.execute<{ payer_id: string | null; paid: string; days: string | null }>(sql`
      with rel as (select claim_id, min(occurred_at) as at from claim_events where type = 'released' group by 1)
      select c.payer_id, sum(rc.paid_cents) as paid,
        percentile_cont(0.5) within group (order by r.payment_date - ${pacificDate(sql`rel.at`)}) as days
      from remit_claims rc join remittances r on r.id = rc.remittance_id
      join claims c on c.id = rc.claim_id left join rel on rel.claim_id = rc.claim_id
      where r.payment_date between ${p.from} and ${p.to} and ${inScope(ids, sql`rc.client_id`)}
      group by 1`);
    const lines = await tx.execute<{
      payer_id: string | null;
      line_id: string;
      group_code: string | null;
      carc: string | null;
      amount_cents: string | null;
    }>(sql`
      select c.payer_id, l.id as line_id, a.group_code, a.carc, a.amount_cents
      from remit_lines l join remit_claims rc on rc.id = l.remit_claim_id
      join remittances r on r.id = rc.remittance_id join claims c on c.id = rc.claim_id
      left join remit_adjustments a on a.remit_line_id = l.id
      where r.payment_date between ${p.from} and ${p.to} and ${inScope(ids, sql`l.client_id`)}`);
    const lineState = new Map<string, { payer: string; denied: boolean }>();
    for (const r of lines.rows) {
      const key = r.payer_id ?? '';
      const l =
        lineState.get(r.line_id) ?? lineState.set(r.line_id, { payer: key, denied: false }).get(r.line_id)!;
      if (
        r.group_code &&
        r.carc &&
        remit.isDenialAdjustment({
          group: r.group_code as remit.Adjustment['group'],
          carc: r.carc,
          amountCents: num(r.amount_cents),
        })
      )
        l.denied = true;
    }
    const denialBy = new Map<string, { denied: number; total: number }>();
    for (const l of lineState.values()) {
      const o = denialBy.get(l.payer) ?? denialBy.set(l.payer, { denied: 0, total: 0 }).get(l.payer)!;
      o.total++;
      if (l.denied) o.denied++;
    }
    const firstBy = new Map(first.rows.map((r) => [r.payer_id ?? '', r]));
    const paidBy = new Map(paid.rows.map((r) => [r.payer_id ?? '', r]));
    const all = claimsBy.rows.map((r) => {
      const key = r.payer_id ?? '';
      const f = firstBy.get(key);
      const d = denialBy.get(key);
      const pd = paidBy.get(key);
      return {
        payerName: r.name ?? 'Unknown payer',
        claims: r.n,
        firstPass: f ? reports.rate(f.accepted, f.total) : null,
        denialRate: d ? reports.rate(d.denied, d.total) : null,
        paidCents: num(pd?.paid),
        daysToPay: pd?.days === null || pd?.days === undefined ? null : Math.round(Number(pd.days)),
      };
    });
    all.sort((a, b) => b.claims - a.claims);
    const big = all.filter((r) => r.claims >= 20);
    const small = all.filter((r) => r.claims < 20);
    return {
      rows: big,
      other: small.length
        ? { payers: small.length, paidCents: small.reduce((s, r) => s + r.paidCents, 0) }
        : null,
    };
  });
}

/** The clients a report can show (in scope, not offboarded). */
export async function getReportClients(db: Database, scope: ReportScope): Promise<ReportClient[]> {
  const ids = scopeIds(scope);
  return withTenant(db, tenantOf(scope), (tx) => clientsIn(tx, ids));
}

export async function getReportClient(
  db: Database,
  scope: ReportScope,
  clientId: string,
): Promise<ReportClient | null> {
  const ids = scopeIds(scope, clientId);
  return withTenant(db, tenantOf(scope), async (tx) => {
    const list = await clientsIn(tx, ids);
    return list.find((c) => c.id === clientId) ?? null;
  });
}

// ---------- RP-03 A/R aging ----------

export interface AgingRow {
  key: string;
  label: string;
  /** For the C-01 link (claims for this payer or client). */
  payerId: string | null;
  clientId: string | null;
  buckets: Record<reports.AgingBucket, number>;
  totalCents: number;
  claims: number;
  slow: boolean;
}

export interface Aging {
  asOf: string;
  rows: AgingRow[];
  total: AgingRow;
}

export async function getAging(
  db: Database,
  scope: ReportScope,
  opts: { view: 'insurance' | 'patient'; groupBy: 'payer' | 'client'; clientId?: string },
  today = todayPacific(),
): Promise<Aging> {
  const ids = scopeIds(scope, opts.clientId);
  return withTenant(db, tenantOf(scope), async (tx) => {
    const rows =
      opts.view === 'insurance' ? await insuranceAr(tx, ids, today) : await patientAr(tx, ids, today);
    const names = new Map((await clientsIn(tx, ids)).map((c) => [c.id, c.name]));
    const zero = () =>
      Object.fromEntries(reports.AGING_BUCKETS.map((b) => [b, 0])) as Record<reports.AgingBucket, number>;
    const by = new Map<string, AgingRow>();
    const all: AgingRow = {
      key: 'total',
      label: 'Total',
      payerId: null,
      clientId: opts.clientId ?? null,
      buckets: zero(),
      totalCents: 0,
      claims: 0,
      slow: false,
    };
    for (const r of rows) {
      const key = opts.groupBy === 'payer' ? (r.payerId ?? r.payerName) : r.clientId;
      const row =
        by.get(key) ??
        by
          .set(key, {
            key,
            label: opts.groupBy === 'payer' ? r.payerName : (names.get(r.clientId) ?? 'Client'),
            payerId: opts.groupBy === 'payer' ? r.payerId : null,
            clientId: opts.groupBy === 'client' ? r.clientId : (opts.clientId ?? null),
            buckets: zero(),
            totalCents: 0,
            claims: 0,
            slow: false,
          })
          .get(key)!;
      const b = reports.agingBucket(r.days);
      for (const t of [row, all]) {
        t.buckets[b] += r.balanceCents;
        t.totalCents += r.balanceCents;
        t.claims++;
      }
    }
    const list = [...by.values()].map((r) => ({ ...r, slow: reports.isSlowPayer(r.buckets) }));
    list.sort((a, b) => b.totalCents - a.totalCents);
    return { asOf: today, rows: list, total: all };
  });
}

// ---------- RP-04 denials ----------

export const DENIAL_GROUPS = [
  'Eligibility',
  'Coding or modifier',
  'Authorization',
  'Missing information',
  'Other',
] as const;
export type DenialGroup = (typeof DENIAL_GROUPS)[number];

export function denialGroup(carc: string): DenialGroup {
  const k = remit.denialKind(carc);
  if (k === 'eligibility' || k === 'cob') return 'Eligibility';
  if (k === 'coding' || k === 'bundling') return 'Coding or modifier';
  if (k === 'authorization') return 'Authorization';
  if (k === 'missing_info') return 'Missing information';
  return 'Other';
}

export interface DenialCodeRow {
  code: string;
  carc: string;
  group: DenialGroup;
  lines: number;
  cents: number;
  correctedShare: number | null;
  writtenOffShare: number | null;
  topPayer: string;
}

export interface DenialsReport {
  period: reports.Period;
  lines: number;
  linesBefore: number;
  deniedCents: number;
  recoveredCents: number;
  writtenOffCents: number;
  openCents: number;
  weekly: { week: string; byGroup: Record<DenialGroup, number> }[];
  codes: DenialCodeRow[];
}

export async function getDenialsReport(
  db: Database,
  scope: ReportScope,
  p: reports.Period,
  filters: { clientId?: string; payer?: string } = {},
): Promise<DenialsReport> {
  const ids = scopeIds(scope, filters.clientId);
  const before = reports.previousPeriod(p);
  return withTenant(db, tenantOf(scope), async (tx) => {
    const payerFilter = filters.payer ? sql`r.payer_name = ${filters.payer}` : sql`true`;
    const res = await tx.execute<{
      line_id: string;
      claim_id: string;
      payer: string | null;
      payment_date: string;
      group_code: string;
      carc: string;
      amount_cents: string;
      claim_status: string;
      corrected: boolean;
      written_off: boolean;
    }>(sql`
      select l.id as line_id, rc.claim_id, r.payer_name as payer, r.payment_date::text as payment_date,
        a.group_code, a.carc, a.amount_cents, c.status as claim_status,
        exists (select 1 from claim_events e where e.claim_id = rc.claim_id and e.type = 'corrected') as corrected,
        exists (select 1 from claim_events e where e.claim_id = rc.claim_id and e.payload ? 'writeOffCents') as written_off
      from remit_adjustments a join remit_lines l on l.id = a.remit_line_id
      join remit_claims rc on rc.id = l.remit_claim_id
      join remittances r on r.id = rc.remittance_id
      join claims c on c.id = rc.claim_id
      where r.payment_date between ${before.from} and ${p.to} and ${payerFilter}
        and ${inScope(ids, sql`l.client_id`)}`);
    const denied = res.rows.filter((r) =>
      remit.isDenialAdjustment({
        group: r.group_code as remit.Adjustment['group'],
        carc: r.carc,
        amountCents: num(r.amount_cents),
      }),
    );
    const inPeriod = denied.filter((r) => r.payment_date >= p.from);
    const linesOf = (rows: typeof denied) => new Set(rows.map((r) => r.line_id)).size;
    const weeks = reports.weeksOf(p);
    const zero = () => Object.fromEntries(DENIAL_GROUPS.map((g) => [g, 0])) as Record<DenialGroup, number>;
    const weekly = weeks.map((week) => ({ week, byGroup: zero() }));
    const seen = new Set<string>();
    for (const r of inPeriod) {
      if (seen.has(r.line_id)) continue;
      seen.add(r.line_id);
      const i = weeks.findLastIndex((w) => w <= r.payment_date);
      if (i >= 0) weekly[i]!.byGroup[denialGroup(r.carc)]++;
    }
    const byCode = new Map<string, { rows: typeof denied; payers: Map<string, number> }>();
    for (const r of inPeriod) {
      const code = `${r.group_code}-${r.carc}`;
      const e = byCode.get(code) ?? byCode.set(code, { rows: [], payers: new Map() }).get(code)!;
      e.rows.push(r);
      e.payers.set(r.payer ?? 'Unknown payer', (e.payers.get(r.payer ?? 'Unknown payer') ?? 0) + 1);
    }
    const codes = [...byCode.entries()].map(([code, e]) => {
      const claimsWith = new Map(e.rows.map((r) => [r.claim_id, r]));
      const n = claimsWith.size;
      return {
        code,
        carc: e.rows[0]!.carc,
        group: denialGroup(e.rows[0]!.carc),
        lines: linesOf(e.rows),
        cents: e.rows.reduce((s, r) => s + num(r.amount_cents), 0),
        correctedShare: reports.rate([...claimsWith.values()].filter((r) => r.corrected).length, n),
        writtenOffShare: reports.rate([...claimsWith.values()].filter((r) => r.written_off).length, n),
        topPayer: [...e.payers.entries()].sort((a, b) => b[1] - a[1])[0]![0],
      };
    });
    codes.sort((a, b) => b.lines - a.lines);
    const centsWhere = (f: (r: (typeof inPeriod)[number]) => boolean) =>
      inPeriod.filter(f).reduce((s, r) => s + num(r.amount_cents), 0);
    const recovered = centsWhere(
      (r) => r.corrected && ['paid', 'partially_paid', 'closed'].includes(r.claim_status),
    );
    const writtenOff = centsWhere((r) => r.written_off);
    const deniedCents = centsWhere(() => true);
    return {
      period: p,
      lines: linesOf(inPeriod),
      linesBefore: linesOf(denied.filter((r) => r.payment_date < p.from)),
      deniedCents,
      recoveredCents: recovered,
      writtenOffCents: writtenOff,
      openCents: Math.max(0, deniedCents - recovered - writtenOff),
      weekly,
      codes,
    };
  });
}

// ---------- RP-05 team ----------

export interface TeamRow {
  userId: string;
  name: string;
  clients: number | 'all';
  resolved: number;
  medianHours: number | null;
  pastSla: number | null;
  openNow: number;
  overdueNow: number;
}

export interface BacklogRow {
  clientId: string;
  clientName: string;
  primaryBiller: string | null;
  openItems: number;
  oldestDays: number | null;
  manualTasks: number;
}

export interface TeamReport {
  period: reports.Period;
  resolved: number;
  byAutomation: number;
  medianHours: number | null;
  claimsPerBillerPerDay: number | null;
  billers: TeamRow[];
  backlog: BacklogRow[];
  enoughHistory: boolean;
}

export async function getTeamReport(
  db: Database,
  scope: ReportScope,
  p: reports.Period,
  nowAt = clockNow(),
): Promise<TeamReport> {
  const ids = scopeIds(scope);
  return withTenant(db, tenantOf(scope), async (tx) => {
    const resolved = await tx.execute<{ who: string; n: number; hours: string | null; late: number }>(sql`
      select resolved_by as who, count(*)::int as n,
        percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at) / 3600) as hours,
        count(*) filter (where resolved_at > due_at)::int as late
      from work_items
      where status = 'resolved' and resolved_by is not null
        and ${pacificDate(sql`resolved_at`)} between ${p.from} and ${p.to}
        and ${inScope(ids, sql`client_id`)}
      group by 1`);
    const people = await tx.execute<{
      user_id: string;
      name: string;
      role: string;
      scope: string;
      n: number | null;
    }>(sql`
      select m.user_id, u.name, m.role, m.client_scope as scope, cardinality(m.client_ids) as n
      from memberships m join users u on u.id = m.user_id
      where m.role in ('biller', 'admin') order by u.name`);
    const open = await tx.execute<{ who: string | null; n: number; overdue: number }>(sql`
      select assignee_id::text as who, count(*)::int as n, count(*) filter (where due_at < ${nowAt})::int as overdue
      from work_items where status <> 'resolved' and ${inScope(ids, sql`client_id`)} group by 1`);
    const backlog = await tx.execute<{
      client_id: string;
      name: string;
      n: number;
      oldest: Date | null;
      manual: number;
    }>(sql`
      select w.client_id, c.name, count(*)::int as n, min(w.created_at) as oldest,
        count(*) filter (where w.type = 'manual_task')::int as manual
      from work_items w join clients c on c.id = w.client_id
      where w.status <> 'resolved' and ${inScope(ids, sql`w.client_id`)}
      group by 1, 2 order by 3 desc`);
    const primary = await tx.execute<{ client_id: string; who: string }>(sql`
      select distinct on (client_id) client_id, resolved_by as who from work_items
      where status = 'resolved' and resolved_by like 'user:%' and ${inScope(ids, sql`client_id`)}
      group by client_id, resolved_by order by client_id, count(*) desc`);
    const released = await tx.execute<{ n: number }>(sql`
      select count(distinct claim_id)::int as n from claim_events
      where type = 'released' and ${pacificDate(sql`occurred_at`)} between ${p.from} and ${p.to}
        and ${inScope(ids, sql`client_id`)}`);
    const firstItem = await tx.execute<{ at: Date | null }>(
      sql`select min(created_at) as at from work_items`,
    );

    const byUser = new Map(resolved.rows.map((r) => [r.who, r]));
    const openBy = new Map(open.rows.map((r) => [r.who ?? '', r]));
    const nameOf = new Map(people.rows.map((r) => [`user:${r.user_id}`, r.name]));
    const billers = people.rows
      .filter((r) => r.role === 'biller' || byUser.has(`user:${r.user_id}`))
      .map((r) => {
        const s = byUser.get(`user:${r.user_id}`);
        return {
          userId: r.user_id,
          name: r.name,
          clients: r.scope === 'all' ? ('all' as const) : (r.n ?? 0),
          resolved: s?.n ?? 0,
          medianHours: s?.hours ? Math.round(Number(s.hours) * 10) / 10 : null,
          pastSla: s ? reports.rate(s.late, s.n) : null,
          openNow: openBy.get(r.user_id)?.n ?? 0,
          overdueNow: openBy.get(r.user_id)?.overdue ?? 0,
        };
      });
    const all = resolved.rows.reduce((s, r) => s + r.n, 0);
    const auto = resolved.rows.filter((r) => r.who.startsWith('automation:')).reduce((s, r) => s + r.n, 0);
    const people_ = resolved.rows.filter((r) => r.who.startsWith('user:'));
    const weighted = people_.reduce((s, r) => s + num(r.hours) * r.n, 0);
    const n = people_.reduce((s, r) => s + r.n, 0);
    const billerCount = people.rows.filter((r) => r.role === 'biller').length;
    const weekdays = Array.from({ length: reports.periodDays(p) }, (_, i) =>
      new Date(Date.parse(`${p.from}T12:00:00Z`) + i * 86_400_000).getUTCDay(),
    ).filter((d) => d !== 0 && d !== 6).length;
    const primaryOf = new Map(primary.rows.map((r) => [r.client_id, nameOf.get(r.who) ?? null]));
    const first = firstItem.rows[0]?.at ? new Date(firstItem.rows[0].at) : null;
    return {
      period: p,
      resolved: all,
      byAutomation: auto,
      medianHours: n ? Math.round((weighted / n) * 10) / 10 : null,
      claimsPerBillerPerDay:
        billerCount && weekdays
          ? Math.round((num(released.rows[0]?.n) / billerCount / weekdays) * 10) / 10
          : null,
      billers,
      backlog: backlog.rows.map((r) => ({
        clientId: r.client_id,
        clientName: r.name,
        primaryBiller: primaryOf.get(r.client_id) ?? null,
        openItems: r.n,
        oldestDays: r.oldest
          ? Math.floor((nowAt.getTime() - new Date(r.oldest).getTime()) / 86_400_000)
          : null,
        manualTasks: r.manual,
      })),
      enoughHistory: first !== null && nowAt.getTime() - first.getTime() >= 7 * 86_400_000,
    };
  });
}
