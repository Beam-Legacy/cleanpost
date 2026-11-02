import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { z } from 'zod';
import { remit } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { CodeChip } from '@/components/code-chip';
import { PageHead } from '@/components/page';
import { formatCount, formatDate, formatMoney, formatWhen } from '@/lib/format';
import { listDenials } from '@/lib/queries/denials';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Denials' };

const Id = z.uuid();
const KINDS = Object.keys(remit.DENIAL_KIND_LABEL) as remit.DenialKind[];

/** D-01 Denials: open balance at risk by category, and the denials to work (row opens W-16). */
export default async function DenialsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const kind = KINDS.includes(sp.kind as remit.DenialKind) ? (sp.kind as remit.DenialKind) : null;
  const data = await listDenials(ctx, {
    kind,
    clientId: Id.safeParse(sp.client).success ? sp.client! : null,
  });
  const href = (k: string | null) => {
    const p = new URLSearchParams();
    for (const [key, v] of Object.entries({ ...sp, kind: k })) if (v) p.set(key, v);
    return `/denials${p.size ? `?${p}` : ''}`;
  };

  return (
    <>
      <PageHead
        title="Denials"
        subtitle={`${formatCount(data.totals.count)} open · ${formatMoney(data.totals.cents)} at risk`}
      />
      {data.totals.count === 0 ? (
        <EmptyState title="No open denials" tone="good" icon={<CircleCheck />}>
          This month: {formatCount(data.month.corrected.count)} corrected and accepted (
          {formatMoney(data.month.corrected.cents)}), {formatCount(data.month.writtenOff.count)} written off (
          {formatMoney(data.month.writtenOff.cents)}).
        </EmptyState>
      ) : (
        <>
          <div className="filters" role="toolbar" aria-label="Denial categories">
            <Link
              className={`filter-chip${kind === null ? ' on' : ''}`}
              aria-current={kind === null ? 'true' : undefined}
              href={href(null)}
            >
              All <span className="n">{formatCount(data.totals.count)}</span>
            </Link>
            {data.byKind.map((k) => (
              <Link
                key={k.kind}
                className={`filter-chip${kind === k.kind ? ' on' : ''}`}
                aria-current={kind === k.kind ? 'true' : undefined}
                href={href(k.kind)}
              >
                {remit.DENIAL_KIND_LABEL[k.kind]} <span className="n">{formatCount(k.count)}</span>{' '}
                <span className="muted">{formatMoney(k.cents).replace(/\.\d\d$/, '')}</span>
              </Link>
            ))}
          </div>
          <div className="card flush">
            <div className="table-wrap">
              <table className="table nowrap" aria-label="Open denials">
                <thead>
                  <tr>
                    <th>Patient</th>
                    <th>DOS</th>
                    <th>Client</th>
                    <th>Payer</th>
                    <th>Category</th>
                    <th>Code</th>
                    <th className="num">At risk</th>
                    <th>Denied</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.itemId}>
                      <td>
                        <Link href={`/work?item=${r.itemId}`}>{r.patient ?? 'Claim'}</Link>
                      </td>
                      <td>{formatDate(r.dateOfService).replace(/, \d{4}$/, '')}</td>
                      <td>{r.clientName ?? '—'}</td>
                      <td>
                        <span className="truncate" style={{ maxWidth: 180 }}>
                          {r.payerName ?? '—'}
                        </span>
                      </td>
                      <td>{remit.DENIAL_KIND_LABEL[r.kind]}</td>
                      <td>
                        <CodeChip code={`CO-${r.carc}`} bad />
                      </td>
                      <td className="num">{formatMoney(r.amountCents)}</td>
                      <td>{formatWhen(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span>
                Showing {formatCount(data.rows.length)} of {formatCount(data.totals.count)}
              </span>
              <span className="spacer" />
              <span>Amounts are the open balance at risk, not billed charges.</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
