/**
 * RP-06 CSV export: aggregate figures only (no patient appears in any report), with the metric
 * definitions as comment lines. Each export is audit-logged with the user, scope and format.
 */
import { z } from 'zod';
import { recordAudit, withTenant } from '@cleanpost/db';
import { policy, reports } from '@cleanpost/domain';
import {
  getAging,
  getDenialsReport,
  getOverview,
  getPayerResults,
  getReportClient,
  getTeamReport,
  todayPacific,
} from '@/lib/queries/reports';
import { CARC_LABEL } from '@/lib/remit-display';
import { resolvePeriod } from '@/lib/report-display';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

const query = z.object({
  report: z.enum(['overview', 'client', 'aging', 'denials', 'team']),
  period: z.string().optional(),
  client: z.uuid().optional(),
  view: z.enum(['insurance', 'patient']).optional(),
  group: z.enum(['payer', 'client']).optional(),
});

const cents = (c: number) => Math.round(c) / 100;

export async function GET(req: Request) {
  const ctx = await requireActiveContext();
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return new Response('Not found', { status: 404 });
  const { report, client } = q.data;
  if (report === 'team' && !policy.authorize(ctx.actor, 'reports.team').allowed)
    return new Response('Forbidden', { status: 403 });
  if (client && !(await getReportClient(ctx, client))) return new Response('Not found', { status: 404 });
  const today = todayPacific();
  const { period, label } = resolvePeriod(q.data.period, today);
  let csv: string;

  if (report === 'overview') {
    const o = await getOverview(ctx, period);
    csv = reports.toCsv(
      [
        'Client',
        'Mode',
        'Claims',
        'Charges ($)',
        'Collections ($)',
        'First-pass acceptance (%)',
        'Denial rate (%)',
        'Days in A/R',
        'Released without review (%)',
        'Open items',
      ],
      o.clients.map((c) => [
        c.client.name,
        c.client.mode,
        c.kpis.claims,
        cents(c.kpis.chargesCents),
        cents(c.kpis.collectionsCents),
        c.kpis.firstPass,
        c.kpis.denialRate,
        c.kpis.daysInAr,
        c.kpis.releasedWithoutReview,
        c.openItems,
      ]),
      [
        `Reports overview, ${label}`,
        ...reports.definitionComments([
          'collections',
          'firstPass',
          'denialRate',
          'daysInAr',
          'releasedWithoutReview',
        ]),
      ],
    );
  } else if (report === 'client') {
    if (!client) return new Response('Not found', { status: 404 });
    const [c, payers] = await Promise.all([
      getReportClient(ctx, client),
      getPayerResults(ctx, client, period),
    ]);
    csv = reports.toCsv(
      ['Payer', 'Claims', 'First-pass accepted (%)', 'Denial rate (%)', 'Paid ($)', 'Median days to pay'],
      [
        ...payers.rows.map((r) => [
          r.payerName,
          r.claims,
          r.firstPass,
          r.denialRate,
          cents(r.paidCents),
          r.daysToPay,
        ]),
        ...(payers.other
          ? [[`Other payers (${payers.other.payers})`, null, null, null, cents(payers.other.paidCents), null]]
          : []),
      ],
      [`${c?.name ?? 'Client'} report, ${label}`, ...reports.definitionComments(['firstPass', 'denialRate'])],
    );
  } else if (report === 'aging') {
    const view = q.data.view ?? 'insurance';
    const groupBy = q.data.group ?? 'payer';
    const a = await getAging(ctx, { view, groupBy, ...(client ? { clientId: client } : {}) });
    csv = reports.toCsv(
      [
        groupBy === 'payer' ? 'Payer' : 'Client',
        ...reports.AGING_BUCKETS.map((b) => `${b} days ($)`),
        'Total ($)',
        'Claims',
      ],
      [...a.rows, a.total].map((r) => [
        r.label,
        ...reports.AGING_BUCKETS.map((b) => cents(r.buckets[b])),
        cents(r.totalCents),
        r.claims,
      ]),
      [
        `A/R aging, ${view} balances as of ${today}`,
        view === 'insurance'
          ? 'Age: calendar days from the first accepted submission (the release, until the payer accepts).'
          : 'Patient responsibility from the payers’ 835s, aged from the payment date.',
      ],
    );
  } else if (report === 'denials') {
    const d = await getDenialsReport(ctx, period, client ? { clientId: client } : {});
    csv = reports.toCsv(
      [
        'Code',
        'Meaning',
        'Category',
        'Lines',
        'Dollars ($)',
        'Corrected (%)',
        'Written off (%)',
        'Top payer',
      ],
      d.codes.map((c) => [
        c.code,
        CARC_LABEL[c.carc] ?? null,
        c.group,
        c.lines,
        cents(c.cents),
        c.correctedShare,
        c.writtenOffShare,
        c.topPayer,
      ]),
      [
        `Denials, ${label}`,
        'A denial: a CO or PI adjustment that is not contractual (as the 835 ingest reads it).',
      ],
    );
  } else {
    const t = await getTeamReport(ctx, period);
    csv = reports.toCsv(
      ['Biller', 'Clients', 'Resolved', 'Median hours to resolve', 'Past SLA (%)', 'Open now', 'Overdue now'],
      t.billers.map((b) => [
        b.name,
        b.clients === 'all' ? 'All' : b.clients,
        b.resolved,
        b.medianHours,
        b.pastSla,
        b.openNow,
        b.overdueNow,
      ]),
      [`Team, ${label}`, `Items resolved ${t.resolved}; by automation ${t.byAutomation}.`],
    );
  }

  await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, (tx) =>
    recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: 'report.exported',
      entityType: 'tenant',
      entityId: ctx.tenantId,
      clientId: client ?? null,
      metadata: { report, format: 'csv', from: period.from, to: period.to },
    }),
  );
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="cleanpost-${report}-${report === 'aging' ? today : `${period.from}-to-${period.to}`}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
