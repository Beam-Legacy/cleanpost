import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { nowMs } from '@cleanpost/clock';
import { policy, reports, vsBaseline } from '@cleanpost/domain';
import { ChartCard, WeeklyLine } from '@/components/reports/charts';
import { MetricTile } from '@/components/reports/metric';
import { formatDate, formatWhen } from '@/lib/format';
import { clientHeader, clientOverview } from '@/lib/queries/client-detail';
import { getOverview, todayPacific } from '@/lib/queries/reports';
import { workingFor } from '@/lib/report-working';
import { requireActiveContext } from '@/lib/session';
import { BaselineForm } from './baseline-form';

export const metadata: Metadata = { title: 'Client overview' };

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

/**
 * CL-02 Client overview: month to date against the onboarding baseline, first pass by week, what is
 * open in the queue for this client, and who works it.
 */
export default async function ClientOverviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireActiveContext();
  const c = await clientHeader(ctx, id);
  if (!c) notFound();
  const period = reports.periodFor('this_month', todayPacific());
  const [o, { open, team }] = await Promise.all([getOverview(ctx, period, id), clientOverview(ctx, id)]);
  const k = o.kpis;
  const w = workingFor(k, 'month to date');
  const scope = `${c.name} · month to date`;
  const isAdmin = policy.authorize(ctx.actor, 'client.manage', { clientId: id }).allowed;
  const early = c.goLiveAt !== null && nowMs() - c.goLiveAt.getTime() < 30 * 86_400_000;
  const d = (m: 'collections' | 'firstPass' | 'denialRate' | 'daysInAr', v: number | null) =>
    early ? null : vsBaseline(m, v, c.baseline);
  const now = new Date(nowMs());
  const batch = c.pmBatchTime
    ? new Date(`1970-01-01T${c.pmBatchTime}Z`).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC',
      })
    : null;

  return (
    <>
      <div className="row-between" style={{ gap: 8 }}>
        <span className="muted dense">
          {early
            ? 'Baseline comparison starts after 30 days live.'
            : c.baseline
              ? `Compared with the baseline recorded ${formatDate(c.baseline.recordedAt.slice(0, 10))}${c.baseline.source ? ` (${c.baseline.source})` : ''}.`
              : 'No baseline was recorded, so figures are shown without a comparison.'}
        </span>
        {isAdmin && <BaselineForm clientId={c.id} baseline={c.baseline} />}
      </div>
      <section className="kpis" aria-label="Month to date">
        <MetricTile
          metric="collections"
          value={k.collectionsCents}
          unit="cents"
          delta={d('collections', k.collectionsCents)}
          working={w.collections}
          scope={scope}
        />
        <MetricTile
          metric="firstPass"
          value={k.firstPass}
          unit="percent"
          delta={d('firstPass', k.firstPass)}
          working={w.firstPass}
          scope={scope}
        />
        <MetricTile
          metric="denialRate"
          value={k.denialRate}
          unit="percent"
          delta={d('denialRate', k.denialRate)}
          working={w.denialRate}
          scope={scope}
        />
        <MetricTile
          metric="daysInAr"
          value={k.daysInAr}
          unit="days"
          delta={d('daysInAr', k.daysInAr)}
          working={w.daysInAr}
          scope={`${c.name} · today`}
        />
        <MetricTile
          metric="releasedWithoutReview"
          value={k.releasedWithoutReview}
          unit="percent"
          delta={{
            text: c.threshold >= 100 ? 'Reviewing everything' : `Threshold ${c.threshold}`,
            tone: 'neutral',
          }}
          working={w.releasedWithoutReview}
          scope={scope}
        />
      </section>
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 2fr)' }}>
        <ChartCard
          title="First-pass acceptance by week"
          chart={
            <WeeklyLine
              unit="percent"
              label={`First-pass acceptance by week, ${c.name}, month to date`}
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
        <div className="stack">
          <div className="card flush">
            <div className="card-head">
              <h2>Open items</h2>
              <Link
                className="btn btn-ghost btn-sm"
                href={`/work?client=${c.id}`}
                style={{ marginLeft: 'auto' }}
              >
                Open in queue
              </Link>
            </div>
            {open.length === 0 ? (
              <p className="muted" style={{ margin: 16 }}>
                Nothing open for this client.
              </p>
            ) : (
              <table className="table" aria-label="Open items by kind">
                <tbody>
                  {open.map((g) => (
                    <tr key={g.key}>
                      <th scope="row" style={{ fontWeight: 500 }}>
                        <Link href={`/work?client=${c.id}&type=${g.key}`}>{g.label}</Link>
                      </th>
                      <td className="num">{g.count}</td>
                      <td className="muted">
                        {g.dueAt
                          ? `${g.dueAt < now ? 'overdue since' : 'due'} ${formatWhen(g.dueAt, now)}`
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Team and setup</h2>
            </div>
            <div className="card-body">
              <dl className="kv dense">
                <dt>Billers</dt>
                <dd>
                  {team.billers.length === 0
                    ? 'No biller assigned'
                    : team.billers
                        .map((b) => `${b.name}${b.role === 'Assigned' ? '' : ' (all clients)'}`)
                        .join(', ')}
                </dd>
                <dt>PM batch time</dt>
                <dd>
                  {batch
                    ? `${batch} daily (${c.timezone.replace('America/', '').replace('_', ' ')} time)`
                    : 'Not set'}
                </dd>
                <dt>Release threshold</dt>
                <dd>
                  {c.threshold >= 100 ? 'Review everything' : c.threshold}
                  {c.ownThreshold ? '' : ' (company default)'}
                </dd>
                <dt>Payers</dt>
                <dd>{team.payers} set up</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
