import type { Metadata } from 'next';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { summaryLevel } from '@cleanpost/adapters';
import { policy } from '@cleanpost/domain';
import { Banner, EmptyState } from '@cleanpost/ui';
import { ConnectionChip } from '@/components/connection-status';
import { NoAccess, PageHead } from '@/components/page';
import { formatWhen } from '@/lib/format';
import { listConnections, type ConnectionRow } from '@/lib/queries/integrations';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Integrations' };

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  {
    key: 'attention',
    label: 'Needs attention',
    match: (c: ConnectionRow) => c.status === 'failed' || c.status === 'degraded',
  },
  { key: 'healthy', label: 'Healthy', match: (c: ConnectionRow) => c.status === 'healthy' },
  {
    key: 'setup',
    label: 'Setup',
    match: (c: ConnectionRow) => c.status === 'setup' || c.status === 'testing',
  },
] as const;

function issue(c: ConnectionRow): string {
  if (c.status === 'failed' || c.status === 'degraded') return c.latestError ?? 'Sync runs are failing';
  if (c.status === 'paused') return 'Paused by an admin';
  if (c.adapterKey === 'mock' && c.status === 'setup') return 'Waiting for the first sync';
  if (c.adapterKey === 'manual') return 'Charges by file; other work is manual tasks';
  if (c.status === 'setup') return 'Integration not built yet; manual tasks until then';
  return '—';
}

/** I-01 Integrations. Admins only (billers get G-23). Failed and degraded first. */
export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'integration.manage').allowed) return <NoAccess />;
  const { filter = 'all' } = await searchParams;
  const all = await listConnections(ctx);
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const rows = all.filter(active.match);
  const failed = all.filter((c) => c.status === 'failed');
  const degraded = all.filter((c) => c.status === 'degraded');

  return (
    <>
      <PageHead
        title="Integrations"
        subtitle={`${all.length} connections · ${failed.length} failed · ${degraded.length} degraded`}
        actions={
          <span title="Integration requests arrive in milestone M5">
            <button type="button" className="btn btn-secondary" disabled>
              <Plus aria-hidden />
              Request an integration
            </button>
          </span>
        }
      />
      {failed.map((c) => (
        <Banner key={c.id} tone="bad">
          <b>{c.clientName} cannot sync.</b> {c.latestError ?? 'Recent runs failed.'} New charges and payments
          are not arriving.
        </Banner>
      ))}
      <nav className="filters" aria-label="Filter connections">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === 'all' ? '/integrations' : `/integrations?filter=${f.key}`}
            className={`filter-chip${active.key === f.key ? ' on' : ''}`}
            aria-current={active.key === f.key ? 'true' : undefined}
          >
            {f.label} <span className="n">{all.filter(f.match).length}</span>
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title="No connections here" tone="neutral">
          Connections are created when a client is onboarded.
        </EmptyState>
      ) : (
        <section className="card flush" aria-label="Connections">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Client</th>
                  <th scope="col">PM system</th>
                  <th scope="col">Integration</th>
                  <th scope="col">Last success</th>
                  <th scope="col">Issue</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={c.status === 'failed' ? 'row-bad' : undefined}>
                    <td>
                      <ConnectionChip status={c.status} />
                    </td>
                    <td>
                      <Link href={`/integrations/${c.id}`}>{c.clientName}</Link>
                    </td>
                    <td>
                      {c.pmName}
                      {c.adapterKey === 'mock' && <span className="subtle"> (mock PM)</span>}
                    </td>
                    <td>{summaryLevel(c.levels)}</td>
                    <td>{formatWhen(c.lastSuccessAt)}</td>
                    <td className="muted">{issue(c)}</td>
                    <td>
                      <Link className="btn btn-secondary btn-sm" href={`/integrations/${c.id}`}>
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
