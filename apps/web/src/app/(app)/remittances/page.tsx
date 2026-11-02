import type { Metadata } from 'next';
import Link from 'next/link';
import { Banknote } from 'lucide-react';
import { z } from 'zod';
import { policy } from '@cleanpost/domain';
import { EmptyState, ModeBadge, StatusChip } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { SimClockSlot } from '@/components/sim-clock-slot';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { listRemittances, REMIT_VIEWS, type RemitView } from '@/lib/queries/remittances';
import { REMIT_STATUS } from '@/lib/remit-display';
import { requireActiveContext } from '@/lib/session';
import { UploadButton } from './upload';

export const metadata: Metadata = { title: 'Remittances' };

const Id = z.uuid();
const SOURCE: Record<string, string> = { pm: 'PM', file: 'Upload', stedi: 'Stedi' };

/** R-01 Remittances: every payment, newest first, and what each still needs, in words. */
export default async function RemittancesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'remittance.view');
  const sp = await searchParams;
  const view = (REMIT_VIEWS.some((v) => v.key === sp.view) ? sp.view : 'all') as RemitView;
  const data = await listRemittances(ctx, {
    view,
    clientId: Id.safeParse(sp.client).success ? sp.client! : null,
  });
  const href = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...extra })) if (v) p.set(k, v);
    return `/remittances${p.size ? `?${p}` : ''}`;
  };
  const canUpload = policy.authorize(ctx.actor, 'payment.post').allowed;
  const monthName = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/Los_Angeles' });

  return (
    <>
      <PageHead
        title="Remittances"
        subtitle={`${formatCount(data.month.count)} ${data.month.count === 1 ? 'payment' : 'payments'} in ${monthName} · ${formatMoney(data.month.totalCents)}`}
        actions={canUpload ? <UploadButton /> : undefined}
      />
      <SimClockSlot ctx={ctx} />
      {data.counts.all === 0 ? (
        <EmptyState title="No payments yet" tone="neutral" icon={<Banknote />}>
          Payments appear after the first sync reads them from a PM, or when you upload 835 files (Tebra
          clients send theirs as uploads).
        </EmptyState>
      ) : (
        <>
          <div className="filters" role="toolbar" aria-label="Filter payments">
            {REMIT_VIEWS.map((v) => (
              <Link
                key={v.key}
                className={`filter-chip${v.key === view ? ' on' : ''}`}
                aria-current={v.key === view ? 'true' : undefined}
                href={href({ view: v.key === 'all' ? null : v.key })}
              >
                {v.label} <span className="n">{formatCount(data.counts[v.key])}</span>
              </Link>
            ))}
          </div>
          {data.rows.length === 0 ? (
            <div className="card">
              <div className="empty">
                <h2>No payments in this view</h2>
                <Link className="btn btn-secondary" href="/remittances">
                  Show all payments
                </Link>
              </div>
            </div>
          ) : (
            <div className="card flush">
              <div className="table-wrap">
                <table className="table nowrap" aria-label="Payments">
                  <thead>
                    <tr>
                      <th>Paid on</th>
                      <th>Client</th>
                      <th>Payer</th>
                      <th>Trace</th>
                      <th>Method</th>
                      <th className="num">Amount</th>
                      <th className="num">Claims</th>
                      <th>Source</th>
                      <th>Status</th>
                      <th>Attention</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link href={`/remittances/${r.id}`}>
                            {formatDate(r.paymentDate).replace(/, \d{4}$/, '')}
                          </Link>
                        </td>
                        <td>
                          {r.clientName} <ModeBadge mode={r.mode as 'A' | 'B' | 'C'} />
                        </td>
                        <td>
                          <span className="truncate" style={{ maxWidth: 170 }}>
                            {r.payerName}
                          </span>
                        </td>
                        <td className="code">{r.traceNumber}</td>
                        <td>{r.method}</td>
                        <td className="num">{formatMoney(r.amountCents)}</td>
                        <td className="num">{r.claims}</td>
                        <td>{SOURCE[r.source] ?? r.source}</td>
                        <td>
                          <StatusChip status={REMIT_STATUS[r.status] ?? 'Waiting for PM'} />
                        </td>
                        <td
                          className={r.attention ? undefined : 'muted'}
                          style={{ whiteSpace: 'normal', minWidth: 220, maxWidth: 320 }}
                        >
                          {r.attention ??
                            (r.status === 'verifying'
                              ? 'Waiting for the PM to post'
                              : r.amountCents === 0
                                ? 'No payment: denials only'
                                : '—')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-foot">
                <span>
                  Showing {formatCount(data.rows.length)} of{' '}
                  {formatCount(view === 'all' ? data.counts.all : data.counts[view])}
                </span>
                <span className="spacer" />
                <span>PM payments refresh at each sync; Tebra clients upload their 835s.</span>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
