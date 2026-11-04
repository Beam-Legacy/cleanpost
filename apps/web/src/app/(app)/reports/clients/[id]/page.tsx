import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, FileText } from 'lucide-react';
import { z } from 'zod';
import { nowMs } from '@cleanpost/clock';
import { policy, reports, vsBaseline } from '@cleanpost/domain';
import { Banner } from '@cleanpost/ui';
import { BarList, ChartCard } from '@/components/reports/charts';
import { MetricTile } from '@/components/reports/metric';
import { formatMoney } from '@/lib/format';
import {
  DENIAL_GROUPS,
  getAging,
  getDenialsReport,
  getOverview,
  getPayerResults,
  getReportClient,
  todayPacific,
} from '@/lib/queries/reports';
import { clientHeader } from '@/lib/queries/client-detail';
import { resolvePeriod } from '@/lib/report-display';
import { workingFor } from '@/lib/report-working';
import { requireActiveContext } from '@/lib/session';
import { ReportHead } from '../../report-head';

export const metadata: Metadata = { title: 'Client report' };

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);
const NO_BASELINE = { text: 'No baseline', tone: 'neutral' as const };

/** RP-02 Client report: one client's period, the layout the monthly practice PDF (F-01) uses. */
export default async function ClientReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const client = await getReportClient(ctx, id);
  if (!client) notFound();
  const { preset, period, label } = resolvePeriod(sp.period, todayPacific());
  const [o, payers, aging, denials, header] = await Promise.all([
    getOverview(ctx, period, id),
    getPayerResults(ctx, id, period),
    getAging(ctx, { view: 'insurance', groupBy: 'client', clientId: id }),
    getDenialsReport(ctx, period, { clientId: id }),
    clientHeader(ctx, id),
  ]);
  const baseline = header?.baseline ?? null;
  const vs = (m: 'collections' | 'firstPass' | 'denialRate' | 'daysInAr', v: number | null) =>
    baseline ? vsBaseline(m, v, baseline) : NO_BASELINE;
  const k = o.kpis;
  const w = workingFor(k, label);
  const scope = `${client.name} · ${label}`;
  const query = `period=${preset}`;
  const isAdmin = policy.authorize(ctx.actor, 'client.manage').allowed;
  const early =
    client.goLiveAt !== null &&
    nowMs() >= client.goLiveAt.getTime() &&
    nowMs() - client.goLiveAt.getTime() < 30 * 86_400_000;
  const byGroup = DENIAL_GROUPS.map((g) => ({
    label: g,
    value: denials.codes.filter((c) => c.group === g).reduce((s, c) => s + c.lines, 0),
  }));
  const corrected = denials.codes.reduce(
    (s, c) => s + Math.round(((c.correctedShare ?? 0) / 100) * c.lines),
    0,
  );

  return (
    <>
      <ReportHead
        title={client.name}
        scope={`${label} · Mode ${client.mode}`}
        tab="client"
        preset={preset}
        showTeam={policy.authorize(ctx.actor, 'reports.team').allowed}
        firstClientId={id}
        query={query}
        actions={
          <>
            <a
              className="btn btn-secondary btn-sm"
              href={`/reports/export?report=client&client=${id}&${query}`}
              download
            >
              <Download aria-hidden />
              CSV
            </a>
            <Link className="btn btn-primary btn-sm" href={`/reports/clients/${id}/practice-report?${query}`}>
              <FileText aria-hidden />
              Practice report (PDF)
            </Link>
          </>
        }
      />
      {early && <Banner tone="info">Early results; automation thresholds are still being tuned.</Banner>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="muted dense">
          {baseline
            ? `Compared with the baseline recorded ${baseline.recordedAt.slice(0, 10)}${baseline.source ? ` (${baseline.source})` : ''}.`
            : 'No baseline was recorded at onboarding, so figures are shown without a comparison.'}
        </span>
        {isAdmin && !baseline && (
          <Link className="btn btn-ghost btn-sm" href={`/clients/${id}`}>
            Record the baseline
          </Link>
        )}
      </div>
      <section className="kpis" aria-label="Key figures">
        <MetricTile
          metric="collections"
          value={k.collectionsCents}
          unit="cents"
          delta={vs('collections', k.collectionsCents)}
          working={w.collections}
          scope={scope}
        />
        <MetricTile
          metric="firstPass"
          value={k.firstPass}
          unit="percent"
          delta={vs('firstPass', k.firstPass)}
          working={w.firstPass}
          scope={scope}
        />
        <MetricTile
          metric="denialRate"
          value={k.denialRate}
          unit="percent"
          delta={vs('denialRate', k.denialRate)}
          working={w.denialRate}
          scope={scope}
        />
        <MetricTile
          metric="daysInAr"
          value={k.daysInAr}
          unit="days"
          delta={vs('daysInAr', k.daysInAr)}
          working={w.daysInAr}
          scope={`${client.name} · today`}
        />
        <MetricTile
          metric="chargeToSubmission"
          value={k.chargeToSubmission}
          unit="days"
          delta={NO_BASELINE}
          working={w.chargeToSubmission}
          scope={scope}
        />
        <MetricTile
          metric="releasedWithoutReview"
          value={k.releasedWithoutReview}
          unit="percent"
          delta={null}
          working={w.releasedWithoutReview}
          scope={scope}
        />
      </section>

      <div className="grid-2">
        <ChartCard
          title="A/R aging"
          note={`Insurance balance ${formatMoney(aging.total.totalCents)} on ${aging.total.claims} claims, as of today.`}
          chart={
            <BarList
              unit="cents"
              rows={reports.AGING_BUCKETS.map((b) => ({
                label: `${b} days`,
                value: aging.total.buckets[b],
                href: `/reports/aging?client=${id}`,
              }))}
            />
          }
          table={
            <table className="table" aria-label="A/R aging">
              <thead>
                <tr>
                  <th>Age</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {reports.AGING_BUCKETS.map((b) => (
                  <tr key={b}>
                    <td>{b} days</td>
                    <td className="num">{formatMoney(aging.total.buckets[b])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
        <ChartCard
          title="Top denial reasons"
          note={`${denials.lines} lines · ${formatMoney(denials.deniedCents)} · ${corrected} corrected`}
          chart={
            <BarList
              unit="count"
              rows={byGroup.map((g) => ({ ...g, href: `/reports/denials?client=${id}&${query}` }))}
            />
          }
          table={
            <table className="table" aria-label="Denials by reason">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th className="num">Lines</th>
                </tr>
              </thead>
              <tbody>
                {byGroup.map((g) => (
                  <tr key={g.label}>
                    <td>{g.label}</td>
                    <td className="num">{g.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      </div>

      <div className="card flush">
        <div className="card-head">
          <h2>By payer</h2>
        </div>
        <div className="table-wrap">
          <table className="table nowrap" aria-label="Results by payer">
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
              {payers.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    No payer has 20 or more claims in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {payers.other && (
          <div className="table-foot">
            <span>
              Other payers: {formatMoney(payers.other.paidCents)} paid across {payers.other.payers}{' '}
              {payers.other.payers === 1 ? 'payer' : 'payers'} with under 20 claims
            </span>
          </div>
        )}
      </div>
    </>
  );
}
