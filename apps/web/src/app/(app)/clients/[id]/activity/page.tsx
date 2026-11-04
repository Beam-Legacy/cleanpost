import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { History } from 'lucide-react';
import { EmptyState } from '@cleanpost/ui';
import { actionLabel, detailsOf, recordLabel } from '@/lib/audit-display';
import { formatWhen } from '@/lib/format';
import { clientActivity, clientHeader } from '@/lib/queries/client-detail';
import { requireActiveContext } from '@/lib/session';

export const metadata: Metadata = { title: 'Client activity' };

const KINDS = [
  { key: 'all', label: 'All' },
  { key: 'settings', label: 'Settings and status' },
  { key: 'connection', label: 'Connection' },
] as const;

/** CL-07 Client activity: settings, status and connection history. PHI views are in S-13. */
export default async function ClientActivityPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const ctx = await requireActiveContext();
  const c = await clientHeader(ctx, id);
  if (!c) notFound();
  const sp = await searchParams;
  const kind = (KINDS.find((k) => k.key === sp.kind)?.key ?? 'all') as (typeof KINDS)[number]['key'];
  const rows = await clientActivity(ctx, id, kind);
  const now = new Date();

  return (
    <>
      <nav className="tabs" aria-label="Activity kind">
        {KINDS.map((k) => (
          <Link
            key={k.key}
            href={`/clients/${id}/activity${k.key === 'all' ? '' : `?kind=${k.key}`}`}
            className={k.key === kind ? 'active' : undefined}
            aria-current={k.key === kind ? 'page' : undefined}
          >
            {k.label}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <EmptyState title="Nothing yet" icon={<History />}>
          Changes to this client will appear here.
        </EmptyState>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="table" aria-label="Client activity">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{formatWhen(r.at, now)}</td>
                    <td>{r.who}</td>
                    <td>
                      {recordLabel(r.entityType)}: {actionLabel(r.action).toLowerCase()}
                    </td>
                    <td className="dense audit-details">{detailsOf(r.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="muted dense" style={{ margin: 0 }}>
        Who viewed patient data is in the{' '}
        <Link className="inline-link" href={`/audit`}>
          audit log
        </Link>
        .
      </p>
    </>
  );
}
