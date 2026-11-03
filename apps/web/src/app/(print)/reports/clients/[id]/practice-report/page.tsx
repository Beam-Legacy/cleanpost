import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { recordAudit, tenants, withTenant } from '@cleanpost/db';
import { reports } from '@cleanpost/domain';
import { formatDate, formatMoney } from '@/lib/format';
import {
  DENIAL_GROUPS,
  getAging,
  getDenialsReport,
  getOverview,
  getPayerResults,
  getReportClient,
  todayPacific,
} from '@/lib/queries/reports';
import { formatValue, resolvePeriod } from '@/lib/report-display';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';
import { PracticeNote, PrintBar } from './print-bar';

export const metadata: Metadata = { title: 'Practice report' };

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

/**
 * F-01 Client monthly report: the billing company's report to its practice, under its own name.
 * Totals only (no patient-level data); US Letter, 0.5 in margins; Cleanpost only in the footer.
 * Generating it is audit-logged as an export.
 */
export default async function PracticeReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const client = await getReportClient(ctx, id);
  if (!client) notFound();
  const sp = await searchParams;
  const today = todayPacific();
  const { preset, period, label } = resolvePeriod(sp.period ?? 'last_month', today);
  const [o, payers, aging, denials, company] = await Promise.all([
    getOverview(ctx, period, id),
    getPayerResults(ctx, id, period),
    getAging(ctx, { view: 'insurance', groupBy: 'client', clientId: id }),
    getDenialsReport(ctx, period, { clientId: id }),
    withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
      const [t] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, ctx.tenantId));
      await recordAudit(tx, {
        actor: `user:${ctx.user.id}`,
        action: 'report.exported',
        entityType: 'client',
        entityId: id,
        clientId: id,
        metadata: { report: 'practice', format: 'pdf', from: period.from, to: period.to },
      });
      return t?.name ?? 'Your billing company';
    }),
  ]);
  const k = o.kpis;
  const byGroup = DENIAL_GROUPS.map((g) => ({
    label: g,
    lines: denials.codes.filter((c) => c.group === g).reduce((s, c) => s + c.lines, 0),
  }));
  const maxGroup = Math.max(1, ...byGroup.map((g) => g.lines));
  const corrected = denials.codes.reduce(
    (s, c) => s + Math.round(((c.correctedShare ?? 0) / 100) * c.lines),
    0,
  );
  const kpis: [string, string][] = [
    ['Collections', formatValue(k.collectionsCents, 'cents')],
    ['First-pass acceptance', formatValue(k.firstPass, 'percent')],
    ['Denial rate', formatValue(k.denialRate, 'percent')],
    ['Days in A/R', k.daysInAr === null ? '—' : String(Math.round(k.daysInAr))],
    ['Charge to submission (median)', formatValue(k.chargeToSubmission, 'days')],
    ['Claims', k.claims.toLocaleString('en-US')],
  ];

  return (
    <>
      <PrintBar backHref={`/reports/clients/${id}?period=${preset}`} />
      <article className="doc-page" aria-label={`Revenue cycle report for ${client.name}`}>
        <header className="doc-head">
          <div>
            <div className="doc-brand">{company}</div>
          </div>
          <div className="doc-meta">
            <span>Prepared {formatDate(today)}</span>
            <span>For {client.name}</span>
          </div>
        </header>
        <h1>Revenue cycle report · {label}</h1>
        <p className="doc-sub">
          {client.name}. No baseline was recorded at onboarding, so figures are shown without a comparison.
        </p>

        <section className="doc-kpis" aria-label="Key figures">
          {kpis.map(([l, v]) => (
            <div key={l}>
              <span>{l}</span>
              <b>{v}</b>
            </div>
          ))}
        </section>

        <section>
          <h2>By payer</h2>
          <table className="doc-table">
            <thead>
              <tr>
                <th>Payer</th>
                <th className="num">Claims</th>
                <th className="num">First-pass accepted</th>
                <th className="num">Denial rate</th>
                <th className="num">Paid</th>
                <th className="num">Median days to pay</th>
              </tr>
            </thead>
            <tbody>
              {payers.rows.map((r) => (
                <tr key={r.payerName}>
                  <td>{r.payerName}</td>
                  <td className="num">{r.claims.toLocaleString('en-US')}</td>
                  <td className="num">{pct(r.firstPass)}</td>
                  <td className="num">{pct(r.denialRate)}</td>
                  <td className="num">{formatMoney(r.paidCents)}</td>
                  <td className="num">{r.daysToPay ?? '—'}</td>
                </tr>
              ))}
              {payers.other && (
                <tr>
                  <td>Other payers ({payers.other.payers})</td>
                  <td className="num" />
                  <td className="num" />
                  <td className="num" />
                  <td className="num">{formatMoney(payers.other.paidCents)}</td>
                  <td className="num" />
                </tr>
              )}
            </tbody>
          </table>
        </section>

        <div className="doc-grid">
          <section>
            <h2>Insurance A/R by age · {formatMoney(aging.total.totalCents)}</h2>
            <table className="doc-table">
              <tbody>
                {reports.AGING_BUCKETS.map((b) => (
                  <tr key={b}>
                    <td>{b} days</td>
                    <td className="num">{formatMoney(aging.total.buckets[b])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h2>
              Denials · {denials.lines} lines · {formatMoney(denials.deniedCents)} · {corrected} corrected
            </h2>
            <div className="bars">
              {byGroup.map((g) => (
                <div key={g.label} className="bar-row">
                  <span>{g.label}</span>
                  <div className="bar-track" aria-hidden>
                    <div className="bar-fill" style={{ width: `${(g.lines / maxGroup) * 100}%` }} />
                  </div>
                  <span className="v">{g.lines}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <PracticeNote company={company} />

        <footer className="doc-foot">
          <span>{company} · Confidential · Contains no patient-level information</span>
          <span>Prepared with Cleanpost</span>
        </footer>
      </article>
    </>
  );
}
