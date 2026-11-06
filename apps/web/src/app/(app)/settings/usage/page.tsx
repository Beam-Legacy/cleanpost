import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3 } from 'lucide-react';
import { policy } from '@cleanpost/domain';
import { todayPacific, usageForPeriod } from '@cleanpost/reports';
import { EmptyState, ModeBadge } from '@cleanpost/ui';
import { formatCount, formatDate } from '@/lib/format';
import { getDb } from '@/lib/server';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Usage and billing' };

const PERIODS = {
  this_month: 'This month',
  last_month: 'Last month',
  last_90: 'Last 90 days',
} as const;
type Period = keyof typeof PERIODS;

function range(period: Period, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  if (period === 'last_month')
    return { from: ymd(new Date(Date.UTC(y, m - 2, 1))), to: ymd(new Date(Date.UTC(y, m - 1, 0))) };
  if (period === 'last_90') {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 89);
    return { from: ymd(d), to: today };
  }
  return { from: ymd(new Date(Date.UTC(y, m - 1, 1))), to: today };
}

/**
 * S-11 Usage and billing (usage only until invoicing, M7): claims released through Cleanpost per
 * client and mode for a period, from the daily usage records with today counted live. A claim counts
 * once, at its first release.
 */
export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'billing.view');
  const sp = await searchParams;
  const period: Period = sp.period && sp.period in PERIODS ? (sp.period as Period) : 'this_month';
  const today = todayPacific();
  const { from, to } = range(period, today);
  const u = await usageForPeriod(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, from, to, today);

  return (
    <>
      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="title-m">Usage and billing</h2>
          <p className="muted dense" style={{ margin: 0 }}>
            Claims released through Cleanpost, {formatDate(from)} to {formatDate(to)}
            {u.includesToday ? ' (today so far included)' : ''}
          </p>
        </div>
        <nav className="segmented" aria-label="Period">
          {(Object.keys(PERIODS) as Period[]).map((p) => (
            <Link
              key={p}
              href={`/settings/usage?period=${p}`}
              className={p === period ? 'active' : undefined}
              aria-current={p === period ? 'page' : undefined}
            >
              {PERIODS[p]}
            </Link>
          ))}
        </nav>
      </div>

      <dl className="dl" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        <div>
          <dt>Claims released</dt>
          <dd className="fig">{formatCount(u.total)}</dd>
        </div>
        {(['A', 'B', 'C'] as const).map((m) => (
          <div key={m}>
            <dt>
              Mode <ModeBadge mode={m} />
            </dt>
            <dd className="fig">{formatCount(u.byMode[m])}</dd>
          </div>
        ))}
      </dl>

      {u.rows.length === 0 ? (
        <EmptyState title="No claims released in this period" icon={<BarChart3 />}>
          Claims count here when Cleanpost first releases them.
        </EmptyState>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="table" aria-label="Claims released by client">
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="num">Mode A</th>
                  <th className="num">Mode B</th>
                  <th className="num">Mode C</th>
                  <th className="num">Claims released</th>
                </tr>
              </thead>
              <tbody>
                {u.rows.map((r) => (
                  <tr key={r.clientId}>
                    <td>
                      <Link href={`/clients/${r.clientId}`}>{r.clientName}</Link>
                    </td>
                    <td className="num">{formatCount(r.byMode.A)}</td>
                    <td className="num">{formatCount(r.byMode.B)}</td>
                    <td className="num">{formatCount(r.byMode.C)}</td>
                    <td className="num">
                      <b>{formatCount(r.released)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="muted dense">
        A claim counts once, on the day Cleanpost first releases it; corrections and resubmissions of the same
        claim are not counted again, and claims a PM sent without Cleanpost&apos;s release are not counted.
        Usage is recorded each night. Your plan and invoices appear here once invoicing starts.
      </p>
    </>
  );
}
