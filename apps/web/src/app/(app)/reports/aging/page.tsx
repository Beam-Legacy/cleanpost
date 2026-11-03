import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, TriangleAlert, Wallet } from 'lucide-react';
import { z } from 'zod';
import { policy, reports } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { formatDate, formatMoney } from '@/lib/format';
import { getAging, getReportClients, todayPacific } from '@/lib/queries/reports';
import { requireActiveContext } from '@/lib/session';
import { ReportHead } from '../report-head';

export const metadata: Metadata = { title: 'A/R aging' };

/**
 * RP-03 A/R aging: open balances by payer (or client) and age, insurance or patient. Buckets are
 * calendar days from the first accepted submission (the patient view: from the payment date).
 */
export default async function AgingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const view = sp.view === 'patient' ? 'patient' : 'insurance';
  const groupBy = sp.group === 'client' ? 'client' : 'payer';
  const clientId = z.uuid().safeParse(sp.client).success ? sp.client : undefined;
  const today = todayPacific();
  const [aging, clients] = await Promise.all([
    getAging(ctx, { view, groupBy, ...(clientId ? { clientId } : {}) }),
    getReportClients(ctx),
  ]);
  const clientName = clientId ? clients.find((c) => c.id === clientId)?.name : null;
  const link = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    const next = { view, group: groupBy, client: clientId, ...over };
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    return `/reports/aging?${q.toString()}`;
  };
  const over90 = (r: (typeof aging.rows)[number]) =>
    r.totalCents ? reports.rate(r.buckets['91–120'] + r.buckets['120+'], r.totalCents) : null;
  const claimsHref = (r: (typeof aging.rows)[number]) => {
    const q = new URLSearchParams({ view: 'open' });
    if (r.payerId) q.set('payer', r.payerId);
    if (r.clientId) q.set('client', r.clientId);
    return `/claims?${q.toString()}`;
  };
  const first = groupBy === 'payer' ? 'Payer' : 'Client';

  return (
    <>
      <ReportHead
        title="A/R aging"
        scope={`${clientName ?? 'All clients'} · ${view} balances as of ${formatDate(today)}`}
        tab="aging"
        showTeam={policy.authorize(ctx.actor, 'reports.team').allowed}
        firstClientId={clientId ?? clients[0]?.id ?? null}
        query=""
        actions={
          <a
            className="btn btn-secondary btn-sm"
            href={`/reports/export?report=aging&view=${view}&group=${groupBy}${clientId ? `&client=${clientId}` : ''}`}
            download
          >
            <Download aria-hidden />
            Export CSV
          </a>
        }
      />
      <div className="filters">
        <nav className="segmented" aria-label="Balance">
          {(['insurance', 'patient'] as const).map((v) => (
            <Link
              key={v}
              href={link({ view: v })}
              className={v === view ? 'active' : undefined}
              aria-current={v === view ? 'page' : undefined}
            >
              {v === 'insurance' ? 'Insurance' : 'Patient'}
            </Link>
          ))}
        </nav>
        <nav className="segmented" aria-label="Group by">
          {(['payer', 'client'] as const).map((g) => (
            <Link
              key={g}
              href={link({ group: g })}
              className={g === groupBy ? 'active' : undefined}
              aria-current={g === groupBy ? 'page' : undefined}
            >
              By {g}
            </Link>
          ))}
        </nav>
        {clientId && (
          <Link className="btn btn-ghost btn-sm" href={link({ client: undefined })}>
            All clients
          </Link>
        )}
        <span className="spacer" />
        <span className="muted dense">
          Total {formatMoney(aging.total.totalCents)} · {aging.total.claims.toLocaleString('en-US')} claims
        </span>
      </div>
      {aging.rows.length === 0 ? (
        <EmptyState title="No open balances." icon={<Wallet />} />
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table
              className="table nowrap"
              aria-label={`${view === 'insurance' ? 'Insurance' : 'Patient'} balances by ${groupBy} and age`}
            >
              <thead>
                <tr>
                  <th>{first}</th>
                  {reports.AGING_BUCKETS.map((b) => (
                    <th key={b} className="num">
                      {b}
                    </th>
                  ))}
                  <th className="num">Total</th>
                  <th className="num">Over 90 days</th>
                </tr>
              </thead>
              <tbody>
                {aging.rows.map((r) => (
                  <tr key={r.key} className={r.slow ? 'row-warn' : undefined}>
                    <td>
                      {r.label}{' '}
                      {r.slow && view === 'insurance' && groupBy === 'payer' && (
                        <span className="chip chip-warn">
                          <TriangleAlert aria-hidden />
                          Slow
                        </span>
                      )}
                    </td>
                    {reports.AGING_BUCKETS.map((b) => (
                      <td key={b} className="num">
                        {r.buckets[b] ? <Link href={claimsHref(r)}>{formatMoney(r.buckets[b])}</Link> : '—'}
                      </td>
                    ))}
                    <td className="num">
                      <b>{formatMoney(r.totalCents)}</b>
                    </td>
                    <td className="num">{over90(r) === null ? '—' : `${over90(r)!.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  {reports.AGING_BUCKETS.map((b) => (
                    <td key={b} className="num">
                      {formatMoney(aging.total.buckets[b])}
                    </td>
                  ))}
                  <td className="num">
                    <b>{formatMoney(aging.total.totalCents)}</b>
                  </td>
                  <td className="num">
                    {over90(aging.total) === null ? '—' : `${over90(aging.total)!.toFixed(1)}%`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="table-foot">
            <span>
              {view === 'insurance'
                ? 'Age is calendar days from the first accepted submission (the release, until the payer accepts). Amounts open the claims for that payer.'
                : 'Patient responsibility from the payers’ 835s, aged from the payment date.'}
            </span>
          </div>
        </div>
      )}
    </>
  );
}
