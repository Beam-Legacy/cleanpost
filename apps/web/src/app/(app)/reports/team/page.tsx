import type { Metadata } from 'next';
import Link from 'next/link';
import { Download } from 'lucide-react';
import { policy } from '@cleanpost/domain';
import { Banner } from '@cleanpost/ui';
import { NoAccess } from '@/components/page';
import { getTeamReport, todayPacific } from '@/lib/queries/reports';
import { resolvePeriod } from '@/lib/report-display';
import { requireActiveContext } from '@/lib/session';
import { ReportHead } from '../report-head';

export const metadata: Metadata = { title: 'Team report' };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/**
 * RP-05 Team productivity: workload and pace per biller and per client. Framed as workload, not a
 * ranking: sorted by name. Admins and the owner only.
 */
export default async function TeamReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'reports.team').allowed) return <NoAccess />;
  const sp = await searchParams;
  const { preset, period, label } = resolvePeriod(sp.period, todayPacific());
  const t = await getTeamReport(ctx, period);
  const query = `period=${preset}`;

  return (
    <>
      <ReportHead
        title="Team"
        scope={`${label} · admins only`}
        tab="team"
        preset={preset}
        showTeam
        firstClientId={t.backlog[0]?.clientId ?? null}
        query={query}
        actions={
          <a className="btn btn-secondary btn-sm" href={`/reports/export?report=team&${query}`} download>
            <Download aria-hidden />
            Export CSV
          </a>
        }
      />
      {!t.enoughHistory && <Banner tone="info">Not enough history yet: under 7 days of work items.</Banner>}
      <section className="kpis" aria-label="Team figures">
        <div className="kpi">
          <div className="kpi-label">Items resolved</div>
          <div className="kpi-value lg">{t.resolved.toLocaleString('en-US')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Resolved by automation</div>
          <div className="kpi-value lg">{t.byAutomation.toLocaleString('en-US')}</div>
          <div className="kpi-delta">Closed themselves when the condition cleared</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Median time to resolve</div>
          <div className="kpi-value lg">{t.medianHours === null ? '—' : `${t.medianHours} h`}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Claims per biller per day</div>
          <div className="kpi-value lg">{t.claimsPerBillerPerDay ?? '—'}</div>
          <div className="kpi-delta">Claims released ÷ billers ÷ weekdays</div>
        </div>
      </section>

      <div className="card flush">
        <div className="card-head">
          <h2>By biller</h2>
        </div>
        <div className="table-wrap">
          <table className="table nowrap" aria-label="Work by biller">
            <thead>
              <tr>
                <th>Biller</th>
                <th className="num">Clients</th>
                <th className="num">Resolved</th>
                <th className="num">Median time</th>
                <th className="num">Past SLA</th>
                <th className="num">Open now</th>
                <th className="num">Overdue now</th>
              </tr>
            </thead>
            <tbody>
              {t.billers.map((b) => (
                <tr key={b.userId}>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="avatar sm" aria-hidden>
                        {initials(b.name)}
                      </span>
                      {b.name}
                    </span>
                  </td>
                  <td className="num">{b.clients === 'all' ? 'All' : b.clients}</td>
                  <td className="num">{b.resolved.toLocaleString('en-US')}</td>
                  <td className="num">{b.medianHours === null ? '—' : `${b.medianHours} h`}</td>
                  <td className="num">{b.pastSla === null ? '—' : `${b.pastSla.toFixed(1)}%`}</td>
                  <td className="num">{b.openNow}</td>
                  <td className="num">{b.overdueNow}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <h2>Backlog by client</h2>
        </div>
        <div className="table-wrap">
          <table className="table nowrap" aria-label="Backlog by client">
            <thead>
              <tr>
                <th>Client</th>
                <th>Primary biller</th>
                <th className="num">Open items</th>
                <th className="num">Oldest item</th>
                <th className="num">Manual tasks</th>
              </tr>
            </thead>
            <tbody>
              {t.backlog.map((c) => (
                <tr key={c.clientId}>
                  <td>
                    <Link href={`/work?client=${c.clientId}`}>{c.clientName}</Link>
                  </td>
                  <td>{c.primaryBiller ?? '—'}</td>
                  <td className="num">{c.openItems}</td>
                  <td className="num">
                    {c.oldestDays === null ? '—' : `${c.oldestDays} ${c.oldestDays === 1 ? 'day' : 'days'}`}
                  </td>
                  <td className="num">{c.manualTasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
