/**
 * Usage metering for invoicing (docs/01 `usage.meter`, S-11). A claim counts once, on the day
 * (Pacific) Cleanpost first released it; corrections and resubmissions of the same claim do not
 * count again, and a claim the PM sent without Cleanpost's release does not count at all.
 */
import { and, asc, gte, lte, sql } from 'drizzle-orm';
import { clients, recordAudit, usageRecords, withTenant, type Database, type Tx } from '@cleanpost/db';

export type ModeCounts = { A: number; B: number; C: number };
const NO_MODES: ModeCounts = { A: 0, B: 0, C: 0 };

/** Released through Cleanpost: by the adapter or at the PM's batch after Cleanpost approved it. */
const BILLABLE_VIA = ['adapter', 'pm_schedule'];

/** Claims first released through Cleanpost on each day of [from, to], per client and mode. */
async function released(tx: Tx, from: string, to: string) {
  const rows = await tx.execute<{ client_id: string; day: string; mode: string; n: number }>(sql`
    with firsts as (
      select distinct on (e.claim_id) e.claim_id,
        (e.occurred_at at time zone 'America/Los_Angeles')::date as day
      from claim_events e
      where e.type = 'released' and e.payload->>'via' in (${sql.join(
        BILLABLE_VIA.map((v) => sql`${v}`),
        sql`, `,
      )})
      order by e.claim_id, e.occurred_at)
    select c.client_id, f.day::text as day, c.mode, count(*)::int as n
    from firsts f join claims c on c.id = f.claim_id
    where f.day between ${from}::date and ${to}::date
    group by 1, 2, 3`);
  const out = new Map<string, { clientId: string; day: string; byMode: ModeCounts }>();
  for (const r of rows.rows) {
    const key = `${r.client_id}:${r.day}`;
    const rec = out.get(key) ?? { clientId: r.client_id, day: r.day, byMode: { ...NO_MODES } };
    rec.byMode[r.mode as keyof ModeCounts] = (rec.byMode[r.mode as keyof ModeCounts] ?? 0) + Number(r.n);
    out.set(key, rec);
  }
  return [...out.values()];
}

const total = (m: ModeCounts) => m.A + m.B + m.C;

/** usage.meter: write (or rewrite) one day's records for a company. Safe to run again. */
export async function meterUsageDay(db: Database, tenantId: string, day: string): Promise<number> {
  return withTenant(db, { tenantId }, async (tx) => {
    const rows = await released(tx, day, day);
    for (const r of rows) {
      await tx
        .insert(usageRecords)
        .values({
          tenantId,
          clientId: r.clientId,
          date: day,
          claimsReleased: total(r.byMode),
          claimsByMode: r.byMode,
        })
        .onConflictDoUpdate({
          target: [usageRecords.clientId, usageRecords.date],
          set: { claimsReleased: total(r.byMode), claimsByMode: r.byMode, updatedAt: sql`app.now()` },
        });
    }
    await recordAudit(tx, {
      actor: 'automation:usage.meter',
      action: 'usage.metered',
      entityType: 'tenant',
      entityId: tenantId,
      metadata: { day, clients: rows.length, claims: rows.reduce((t, r) => t + total(r.byMode), 0) },
    });
    return rows.length;
  });
}

/** Whether a company has any usage records yet (the worker backfills one that has none). */
export async function hasUsage(db: Database, tenantId: string): Promise<boolean> {
  return withTenant(db, { tenantId }, async (tx) => {
    const [row] = await tx.select({ id: usageRecords.id }).from(usageRecords).limit(1);
    return Boolean(row);
  });
}

export interface UsageRow {
  clientId: string;
  clientName: string;
  released: number;
  byMode: ModeCounts;
}

/**
 * S-11: claims released per client in [from, to]: the metered records, and today (not metered yet)
 * counted live the same way.
 */
export async function usageForPeriod(
  db: Database,
  ctx: { tenantId: string; userId: string },
  from: string,
  to: string,
  today: string,
): Promise<{ rows: UsageRow[]; total: number; byMode: ModeCounts; includesToday: boolean }> {
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const metered = await tx
      .select({ clientId: usageRecords.clientId, byMode: usageRecords.claimsByMode })
      .from(usageRecords)
      .where(and(gte(usageRecords.date, from), lte(usageRecords.date, to < today ? to : prevDay(today))));
    const includesToday = from <= today && today <= to;
    const live = includesToday ? await released(tx, today, today) : [];
    const names = await tx
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .orderBy(asc(clients.name));
    const by = new Map<string, ModeCounts>();
    for (const r of [
      ...metered.map((m) => ({ clientId: m.clientId, byMode: m.byMode as ModeCounts })),
      ...live,
    ]) {
      const acc = by.get(r.clientId) ?? { ...NO_MODES };
      for (const k of ['A', 'B', 'C'] as const) acc[k] += Number(r.byMode[k] ?? 0);
      by.set(r.clientId, acc);
    }
    const rows = names
      .filter((n) => by.has(n.id))
      .map((n) => ({
        clientId: n.id,
        clientName: n.name,
        byMode: by.get(n.id)!,
        released: total(by.get(n.id)!),
      }));
    const byMode = rows.reduce(
      (acc, r) => ({ A: acc.A + r.byMode.A, B: acc.B + r.byMode.B, C: acc.C + r.byMode.C }),
      { ...NO_MODES },
    );
    return { rows, total: total(byMode), byMode, includesToday };
  });
}

function prevDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
