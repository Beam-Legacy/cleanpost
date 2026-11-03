import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3, Download } from 'lucide-react';
import { policy } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { BarList, ChartCard, WeeklyLine } from '@/components/reports/charts';
import { MetricTile } from '@/components/reports/metric';
import { formatMoney } from '@/lib/format';
import { getOverview, todayPacific } from '@/lib/queries/reports';
import { deltaFor, resolvePeriod } from '@/lib/report-display';
import { workingFor } from '@/lib/report-working';
import { requireActiveContext } from '@/lib/session';
import { ReportHead } from './report-head';

export const metadata: Metadata = { title: 'Reports' };

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

/** RP-01 Reports overview: every client in scope for the period, against the period before. */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const { preset, period, label } = resolvePeriod(sp.period, todayPacific());
  const o = await getOverview(ctx, period);
  const showTeam = policy.authorize(ctx.actor, 'reports.team').allowed;
  const k = o.kpis;
  const w = workingFor(k, label);
  const scope = `All clients · ${label}`;
  const query = `period=${preset}`;

  return (
    <>
      <ReportHead
        title="Reports"
        scope={scope}
        tab="overview"
        preset={preset}
        showTeam={showTeam}
        firstClientId={o.clients[0]?.client.id ?? null}
        query={query}
        actions={
          <a className="btn btn-secondary btn-sm" href={`/reports/export?report=overview&${query}`} download>
            <Download aria-hidden />
            Export CSV
          </a>
        }
      />
      {k.claims === 0 && k.collectionsCents === 0 ? (
        <EmptyState title="No claims in this period" icon={<BarChart3 />}>
          Choose a longer period above.
        </EmptyState>
      ) : (
        <>
          <section className="kpis" aria-label="Key figures">
            <MetricTile
              metric="collections"
              value={k.collectionsCents}
              unit="cents"
              delta={deltaFor('collections', k.collectionsCents, o.before.collectionsCents, o.previous)}
              working={w.collections}
              scope={scope}
            />
            <MetricTile
              metric="firstPass"
              value={k.firstPass}
              unit="percent"
              delta={deltaFor('firstPass', k.firstPass, o.before.firstPass, o.previous)}
              working={w.firstPass}
              scope={scope}
            />
            <MetricTile
              metric="denialRate"
              value={k.denialRate}
              unit="percent"
              delta={deltaFor('denialRate', k.denialRate, o.before.denialRate, o.previous)}
              working={w.denialRate}
              scope={scope}
            />
            <MetricTile
              metric="daysInAr"
              value={k.daysInAr}
              unit="days"
              delta={null}
              working={w.daysInAr}
              scope="All clients · today"
            />
            <MetricTile
              metric="releasedWithoutReview"
              value={k.releasedWithoutReview}
              unit="percent"
              delta={deltaFor(
                'releasedWithoutReview',
                k.releasedWithoutReview,
                o.before.releasedWithoutReview,
                o.previous,
              )}
              working={w.releasedWithoutReview}
              scope={scope}
            />
            <MetricTile
              metric="linesWithoutTouch"
              value={k.linesWithoutTouch}
              unit="percent"
              delta={{ text: 'Target 90%', tone: 'neutral' }}
              working={w.linesWithoutTouch}
              scope={scope}
            />
          </section>

          <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
            <ChartCard
              title="First-pass acceptance by week"
              chart={
                <WeeklyLine
                  unit="percent"
                  label={`First-pass acceptance by week, all clients, ${label}`}
                  points={o.weekly.map((x) => ({
                    week: x.week,
                    value: x.rate,
                    detail: `${x.accepted} of ${x.total} accepted`,
                  }))}
                />
              }
              table={
                <table className="table" aria-label="First-pass acceptance by week">
                  <thead>
                    <tr>
                      <th>Week of</th>
                      <th className="num">Accepted</th>
                      <th className="num">First 277CAs</th>
                      <th className="num">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.weekly.map((x) => (
                      <tr key={x.week}>
                        <td>{x.week}</td>
                        <td className="num">{x.accepted}</td>
                        <td className="num">{x.total}</td>
                        <td className="num">{pct(x.rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }
            />
            <ChartCard
              title="Released without review"
              note="Share of claims released automatically above each client’s threshold."
              chart={
                <BarList
                  unit="percent"
                  max={100}
                  rows={o.clients
                    .filter((c) => c.kpis.inputs.released.total > 0)
                    .map((c) => ({ label: c.client.name, value: c.kpis.releasedWithoutReview }))}
                />
              }
              table={
                <table className="table" aria-label="Released without review by client">
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th className="num">Without review</th>
                      <th className="num">Released</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.clients.map((c) => (
                      <tr key={c.client.id}>
                        <td>{c.client.name}</td>
                        <td className="num">{c.kpis.inputs.released.auto}</td>
                        <td className="num">{c.kpis.inputs.released.total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }
            />
          </div>

          <div className="card flush">
            <div className="card-head">
              <h2>By client</h2>
              <span className="muted dense">Open a client for its report</span>
            </div>
            <div className="table-wrap">
              <table className="table nowrap" aria-label="Results by client">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Mode</th>
                    <th className="num">Claims</th>
                    <th className="num">Collections</th>
                    <th className="num">First-pass</th>
                    <th className="num">Denial rate</th>
                    <th className="num">Days in A/R</th>
                    <th className="num">Without review</th>
                    <th className="num">Open items</th>
                  </tr>
                </thead>
                <tbody>
                  {o.clients.map((c) => (
                    <tr key={c.client.id}>
                      <td>
                        <Link href={`/reports/clients/${c.client.id}?${query}`}>{c.client.name}</Link>
                      </td>
                      <td>
                        <span className="mode">{c.client.mode}</span>
                      </td>
                      <td className="num">{c.kpis.claims.toLocaleString('en-US')}</td>
                      <td className="num">{formatMoney(c.kpis.collectionsCents)}</td>
                      <td className="num">{pct(c.kpis.firstPass)}</td>
                      <td className="num">{pct(c.kpis.denialRate)}</td>
                      <td className="num">{c.kpis.daysInAr === null ? '—' : Math.round(c.kpis.daysInAr)}</td>
                      <td className="num">{pct(c.kpis.releasedWithoutReview)}</td>
                      <td className="num">{c.openItems}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
