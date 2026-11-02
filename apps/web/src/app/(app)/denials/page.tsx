import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { z } from 'zod';
import { policy, remit } from '@cleanpost/domain';
import { EmptyState } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { formatCount, formatMoney } from '@/lib/format';
import { getDenialDrawer, listDenials, writeOffOptionsFor } from '@/lib/queries/denials';
import { requireActiveContext } from '@/lib/session';
import { DenialDrawer } from './denial-drawer';
import { DenialsTable } from './denials-table';

export const metadata: Metadata = { title: 'Denials' };

const Id = z.uuid();
const KINDS = Object.keys(remit.DENIAL_KIND_LABEL) as remit.DenialKind[];

/** D-01 Denials: open balance at risk by category, and the denials to work (a row opens D-02). */
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
  const link = (over: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [key, v] of Object.entries({ ...sp, ...over })) if (v) p.set(key, v);
    return `/denials${p.size ? `?${p}` : ''}`;
  };
  const href = (k: string | null) => link({ kind: k, denial: null });
  const open = Id.safeParse(sp.denial).success ? sp.denial! : null;
  const drawer = open ? await getDenialDrawer(ctx, open) : null;
  const canBulk = policy.authorize(ctx.actor, 'denial.write_off', { clientId: null }).allowed;
  const options = canBulk
    ? await writeOffOptionsFor(
        ctx,
        data.rows.flatMap((r) => (r.clientId ? [r.clientId] : [])),
      )
    : {};
  const clientOf = drawer?.detail.item.clientId ?? null;

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
                <span className={kind === k.kind ? undefined : 'muted'}>
                  {formatMoney(k.cents).replace(/\.\d\d$/, '')}
                </span>
              </Link>
            ))}
          </div>
          <DenialsTable
            rows={data.rows}
            hrefs={Object.fromEntries(data.rows.map((r) => [r.itemId, link({ denial: r.itemId })]))}
            total={data.totals.count}
            canBulk={canBulk}
            options={options}
          />
        </>
      )}
      {drawer && (
        <DenialDrawer
          data={drawer}
          closeHref={link({ denial: null })}
          can={{
            correct: policy.authorize(ctx.actor, 'claim.edit', { clientId: clientOf }).allowed,
            overLimit: policy.authorize(ctx.actor, 'denial.write_off', { clientId: clientOf }).allowed,
            assign: policy.authorize(ctx.actor, 'work.resolve', { clientId: clientOf }).allowed,
          }}
        />
      )}
    </>
  );
}
