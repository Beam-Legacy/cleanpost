import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleCheck } from 'lucide-react';
import { z } from 'zod';
import { policy, work } from '@cleanpost/domain';
import { EmptyState, KpiRow, KpiTile } from '@cleanpost/ui';
import { PageHead } from '@/components/page';
import { formatCount } from '@/lib/format';
import { getWorkDetail, listWork, type WorkFilters } from '@/lib/queries/work';
import { requireActiveContext } from '@/lib/session';
import { WorkFilterSelects } from './work-filters';
import { WorkQueue } from './work-queue';

export const metadata: Metadata = { title: 'Work' };

const Id = z.uuid();

/** W-01 Work queue (home): summary strip, filters, list and side panel; W-03 when nothing is due. */
export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const sp = await searchParams;
  const group = sp.type && work.typesOfGroup(sp.type) ? sp.type : 'all';
  const filters: WorkFilters = {
    group,
    clientId: Id.safeParse(sp.client).success ? sp.client! : null,
    payerId: Id.safeParse(sp.payer).success ? sp.payer! : null,
    assignee: sp.assignee === 'me' || sp.assignee === 'unassigned' ? sp.assignee : 'anyone',
    snoozed: sp.snoozed === '1',
  };
  const now = new Date();
  const queue = await listWork(ctx, filters, now);
  const itemId = Id.safeParse(sp.item).success ? sp.item! : null;
  const detail = itemId ? await getWorkDetail(ctx, itemId) : null;
  const can = {
    release: policy.authorize(ctx.actor, 'claim.release').allowed,
    edit: policy.authorize(ctx.actor, 'claim.edit').allowed,
    resolve: policy.authorize(ctx.actor, 'work.resolve').allowed,
    admin: ctx.actor.role === 'admin',
  };

  const link = (extra: Record<string, string | null>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, item: null, ...extra })) if (v) p.set(k, v);
    return `/work${p.size ? `?${p}` : ''}`;
  };
  const k = queue.kpis;
  const autoShare = k.releasedToday
    ? `${Math.round((k.releasedWithoutReviewToday / k.releasedToday) * 100)}%`
    : '—';
  const subtitle = filters.snoozed
    ? `${queue.total} snoozed`
    : `${formatCount(queue.total)} ${queue.total === 1 ? 'item' : 'items'}${
        queue.clientsInQueue > 1 ? ` across ${queue.clientsInQueue} clients` : ''
      }`;
  const caughtUp = !filters.snoozed && queue.openInScope === 0;
  const filtered =
    group !== 'all' ||
    filters.payerId ||
    filters.assignee !== 'anyone' ||
    (filters.clientId && queue.total === 0);

  return (
    <>
      <PageHead title="Work" subtitle={caughtUp ? 'Nothing assigned to you is due' : subtitle} />
      <KpiRow label="Today">
        <KpiTile label="Due today" value={formatCount(k.dueToday)} />
        <KpiTile
          label="Overdue"
          value={formatCount(k.overdue)}
          {...(k.overdue ? { tone: 'bad' as const } : {})}
        />
        <KpiTile label="Ready to release" value={formatCount(k.readyToRelease)} />
        <KpiTile label="Released today" value={formatCount(k.releasedToday)} />
        <KpiTile label="Posted today" value="—" />
        <KpiTile label="Released without review today" value={autoShare} />
      </KpiRow>

      {caughtUp ? (
        // W-03: an empty queue reads as success. Counts never link to PHI lists from here.
        <EmptyState title="Nothing needs you right now" tone="good" icon={<CircleCheck />}>
          {k.releasedWithoutReviewToday
            ? `${formatCount(k.releasedWithoutReviewToday)} ${k.releasedWithoutReviewToday === 1 ? 'claim' : 'claims'} went out without review today.`
            : 'Claim reviews, rejections and posting differences appear here as they come in.'}
          {queue.snoozedInScope ? ` ${formatCount(queue.snoozedInScope)} snoozed.` : ''}
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            {queue.snoozedInScope > 0 && (
              <Link className="btn btn-secondary" href={link({ snoozed: '1' })}>
                Show snoozed items
              </Link>
            )}
            <Link className="btn btn-ghost" href="/claims">
              Open claims list
            </Link>
          </div>
        </EmptyState>
      ) : (
        <>
          <div className="filters" role="toolbar" aria-label="Filter work items">
            {filters.snoozed ? (
              <Link className="filter-chip" href={link({ snoozed: null })}>
                Back to the queue
              </Link>
            ) : (
              <>
                <Link
                  className={`filter-chip${group === 'all' ? ' on' : ''}`}
                  aria-current={group === 'all' ? 'true' : undefined}
                  href={link({ type: null })}
                >
                  All <span className="n">{queue.counts.all ?? 0}</span>
                </Link>
                {work.WORK_TYPE_GROUPS.filter((g) => (queue.counts[g.key] ?? 0) > 0 || g.key === group).map(
                  (g) => (
                    <Link
                      key={g.key}
                      className={`filter-chip${group === g.key ? ' on' : ''}`}
                      aria-current={group === g.key ? 'true' : undefined}
                      href={link({ type: g.key })}
                    >
                      {g.label} <span className="n">{queue.counts[g.key] ?? 0}</span>
                    </Link>
                  ),
                )}
              </>
            )}
            <span className="spacer" />
            <WorkFilterSelects payers={queue.payers} />
          </div>
          {queue.rows.length === 0 ? (
            <div className="card">
              <div className="empty">
                <h2>No items match these filters</h2>
                <Link
                  className="btn btn-secondary"
                  href={link({ type: null, payer: null, assignee: null, snoozed: null })}
                >
                  Clear filters
                </Link>
              </div>
            </div>
          ) : (
            <WorkQueue
              rows={queue.rows}
              selectedId={detail ? detail.item.id : null}
              detail={detail}
              can={can}
              now={now.toISOString()}
              total={queue.total}
            />
          )}
          {filtered && queue.rows.length > 0 && (
            <div className="row subtle dense" style={{ marginTop: 8 }}>
              Filters applied.
              <Link className="btn btn-ghost btn-sm" href={link({ type: null, payer: null, assignee: null })}>
                Clear filters
              </Link>
            </div>
          )}
        </>
      )}
    </>
  );
}
