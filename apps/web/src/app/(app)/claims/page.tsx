import type { Metadata } from 'next';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { z } from 'zod';
import { CountBadge, EmptyState, ModeBadge, StatusChip } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { CLAIM_STATUS, daysSince, LAST_EVENT } from '@/lib/claim-display';
import { formatCount, formatDate, formatMoney } from '@/lib/format';
import { CLAIM_VIEWS, listClaims, type ClaimView } from '@/lib/queries/claims';
import { requireActiveContext } from '@/lib/session';
import { ClaimFilterSelects } from './claim-filters';

export const metadata: Metadata = { title: 'Claims' };

const Id = z.uuid();

/** C-01 Claims list: saved views with counts, search, filters, server pagination. */
export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const view = (CLAIM_VIEWS.some((v) => v.key === sp.view) ? sp.view : 'open') as ClaimView;
  const page = Math.max(1, Math.min(1000, Number.parseInt(sp.page ?? '1', 10) || 1));
  const filters = {
    view,
    q: (sp.q ?? '').slice(0, 100),
    clientId: Id.safeParse(sp.client).success ? sp.client! : null,
    payerId: Id.safeParse(sp.payer).success ? sp.payer! : null,
    status: sp.status && sp.status in CLAIM_STATUS ? sp.status : null,
    page,
  };
  const data = await listClaims(ctx, filters);
  const href = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, page: null, ...extra })) if (v) p.set(k, v);
    return `/claims${p.size ? `?${p}` : ''}`;
  };
  const now = new Date();
  const first = (page - 1) * data.pageSize + 1;
  const last = first + data.rows.length - 1;

  return (
    <>
      <PageHead
        title="Claims"
        subtitle={`${formatCount(data.counts.open ?? 0)} open claims · ${formatMoney(data.openBalanceCents).replace(/\.\d\d$/, '')} open balance`}
      />
      <nav className="tabs" aria-label="Saved views">
        {CLAIM_VIEWS.map((v) => (
          <Link
            key={v.key}
            href={href({ view: v.key === 'open' ? null : v.key })}
            className={v.key === view ? 'active' : undefined}
            aria-current={v.key === view ? 'page' : undefined}
          >
            {v.label} {v.key !== 'closed' && <CountBadge count={data.counts[v.key] ?? 0} />}
          </Link>
        ))}
      </nav>
      <form className="filters" action="/claims" role="search">
        {Object.entries(sp)
          .filter(([k, v]) => v && !['q', 'page'].includes(k))
          .map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
        <label className="search" style={{ maxWidth: 320 }}>
          <Search aria-hidden />
          <span className="sr-only">Search claims</span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Patient last name or control number"
          />
        </label>
        <ClaimFilterSelects payers={data.payers} statuses={Object.entries(CLAIM_STATUS)} />
      </form>

      {data.rows.length === 0 ? (
        <EmptyState
          title={filters.q ? 'No claims match this search' : 'No claims in this view'}
          tone="neutral"
        >
          {filters.q ? (
            'Check the client filter in the top bar, or search by control number.'
          ) : (
            <Link className="btn btn-secondary" href="/claims">
              Show all open claims
            </Link>
          )}
        </EmptyState>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="table nowrap" aria-label="Claims">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>DOS</th>
                  <th>Client</th>
                  <th>Payer</th>
                  <th className="num">Charge</th>
                  <th className="num">Paid</th>
                  <th className="num">Balance</th>
                  <th>Status</th>
                  <th className="num">Age</th>
                  <th>Last event</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/claims/${r.id}`}>{r.patient}</Link>
                    </td>
                    <td>{formatDate(r.dateOfService).replace(/, \d{4}$/, '')}</td>
                    <td>
                      {r.clientName} <ModeBadge mode={r.mode} />
                    </td>
                    <td>
                      <span className="truncate" style={{ maxWidth: 180 }}>
                        {r.payerName ?? '—'}
                      </span>
                    </td>
                    <td className="num">{formatMoney(r.chargeCents)}</td>
                    <td className="num">—</td>
                    <td className="num">{formatMoney(r.balanceCents)}</td>
                    <td>
                      {CLAIM_STATUS[r.status] ? <StatusChip status={CLAIM_STATUS[r.status]!} /> : r.status}
                    </td>
                    <td className="num">{daysSince(r.dateOfService, now)} d</td>
                    <td className="muted">{r.lastEvent ? (LAST_EVENT[r.lastEvent] ?? r.lastEvent) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-foot">
            <span>
              Showing {formatCount(first)}–{formatCount(last)} of {formatCount(data.total)}
            </span>
            <span className="spacer" />
            {page > 1 ? (
              <Link className="btn btn-secondary btn-sm" href={href({ page: String(page - 1) })}>
                Previous
              </Link>
            ) : (
              <span className="btn btn-secondary btn-sm" aria-disabled="true">
                Previous
              </span>
            )}
            {last < data.total ? (
              <Link className="btn btn-secondary btn-sm" href={href({ page: String(page + 1) })}>
                Next
              </Link>
            ) : (
              <span className="btn btn-secondary btn-sm" aria-disabled="true">
                Next
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}
