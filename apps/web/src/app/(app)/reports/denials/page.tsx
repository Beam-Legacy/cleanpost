import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import { policy, remit } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { ChartCard, StackedWeekly } from '@/components/reports/charts';
import { formatMoney } from '@/lib/format';
import { DENIAL_GROUPS, getDenialsReport, getReportClients, todayPacific } from '@/lib/queries/reports';
import { CARC_LABEL } from '@/lib/remit-display';
import { resolvePeriod } from '@/lib/report-display';
import { requireActiveContext } from '@/lib/session';
import { ReportHead } from '../report-head';

export const metadata: Metadata = { title: 'Denials report' };

const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(0)}%`);
const meaning = (carc: string) => {
  const m = CARC_LABEL[carc];
  return m ? m.charAt(0).toUpperCase() + m.slice(1) : 'No description on file';
};

/** RP-04 Denials report: what is denied, what it costs, and how much is recovered. */
export default async function DenialsReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const { preset, period, label } = resolvePeriod(sp.period, todayPacific());
  const clientId = z.uuid().safeParse(sp.client).success ? sp.client : undefined;
  const [d, clients] = await Promise.all([
    getDenialsReport(ctx, period, clientId ? { clientId } : {}),
    getReportClients(ctx),
  ]);
  const clientName = clientId ? clients.find((c) => c.id === clientId)?.name : null;
  const query = `period=${preset}${clientId ? `&client=${clientId}` : ''}`;
  const change = d.linesBefore ? Math.round(((d.lines - d.linesBefore) / d.linesBefore) * 100) : null;
  const share = (cents: number) =>
    d.deniedCents ? `${Math.round((cents / d.deniedCents) * 100)}% of denied dollars` : '';

  return (
    <>
      <ReportHead
        title="Denials report"
        scope={`${clientName ?? 'All clients'} · ${label}`}
        tab="denials"
        preset={preset}
        showTeam={policy.authorize(ctx.actor, 'reports.team').allowed}
        firstClientId={clientId ?? clients[0]?.id ?? null}
        query={`period=${preset}`}
        actions={
          <a className="btn btn-secondary btn-sm" href={`/reports/export?report=denials&${query}`} download>
            <Download aria-hidden />
            Export CSV
          </a>
        }
      />
      {d.lines === 0 ? (
        <EmptyState title="No denials in this period" icon={<ShieldCheck />}>
          Choose a longer period, or another client.
        </EmptyState>
      ) : (
        <>
          <section className="kpis" aria-label="Denial figures">
            <div className="kpi">
              <div className="kpi-label">Denied lines</div>
              <div className="kpi-value lg">{d.lines.toLocaleString('en-US')}</div>
              {change !== null && (
                <div className={`kpi-delta ${change <= 0 ? 'good' : 'bad'}`}>
                  {change > 0 ? '+' : change < 0 ? '−' : '±'}
                  {Math.abs(change)}% vs the period before
                </div>
              )}
            </div>
            <div className="kpi">
              <div className="kpi-label">Dollars denied</div>
              <div className="kpi-value lg">{formatMoney(d.deniedCents)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Recovered by correction</div>
              <div className="kpi-value lg">{formatMoney(d.recoveredCents)}</div>
              <div className="kpi-delta">{share(d.recoveredCents)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Written off</div>
              <div className="kpi-value lg">{formatMoney(d.writtenOffCents)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Still open</div>
              <div className="kpi-value lg">{formatMoney(d.openCents)}</div>
            </div>
          </section>

          <ChartCard
            title="Denied lines per week by category"
            chart={
              <StackedWeekly
                label={`Denied lines per week by category, ${clientName ?? 'all clients'}, ${label}`}
                series={[...DENIAL_GROUPS]}
                weeks={d.weekly.map((w) => ({
                  week: w.week,
                  values: DENIAL_GROUPS.map((g) => w.byGroup[g]),
                }))}
              />
            }
            table={
              <table className="table" aria-label="Denied lines per week by category">
                <thead>
                  <tr>
                    <th>Week of</th>
                    {DENIAL_GROUPS.map((g) => (
                      <th key={g} className="num">
                        {g}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.weekly.map((w) => (
                    <tr key={w.week}>
                      <td>{w.week}</td>
                      {DENIAL_GROUPS.map((g) => (
                        <td key={g} className="num">
                          {w.byGroup[g]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            }
          />

          <div className="card flush">
            <div className="card-head">
              <h2>Top codes</h2>
              <span className="muted dense">Open a code for the open denials of its kind</span>
            </div>
            <div className="table-wrap">
              <table className="table nowrap" aria-label="Top denial codes">
                <thead>
                  <tr>
                    <th>Meaning</th>
                    <th>Code</th>
                    <th>Category</th>
                    <th className="num">Lines</th>
                    <th className="num">Dollars</th>
                    <th className="num">Corrected</th>
                    <th className="num">Written off</th>
                    <th>Top payer</th>
                  </tr>
                </thead>
                <tbody>
                  {d.codes.map((c) => (
                    <tr key={c.code}>
                      <td>
                        <Link
                          href={`/denials?kind=${remit.denialKind(c.carc)}${clientId ? `&client=${clientId}` : ''}`}
                        >
                          {meaning(c.carc)}
                        </Link>
                      </td>
                      <td className="code">{c.code}</td>
                      <td>{c.group}</td>
                      <td className="num">{c.lines}</td>
                      <td className="num">{formatMoney(c.cents)}</td>
                      <td className="num">{pct(c.correctedShare)}</td>
                      <td className="num">{pct(c.writtenOffShare)}</td>
                      <td>{c.topPayer}</td>
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
