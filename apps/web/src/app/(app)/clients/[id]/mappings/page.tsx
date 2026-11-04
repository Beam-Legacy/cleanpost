import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { policy } from '@cleanpost/domain';
import { codeMeaning } from '@/lib/mapping-display';
import { clientMappings } from '@/lib/queries/client-detail';
import { requireActiveContext } from '@/lib/session';
import { ClientMappingRow } from './client-mapping-row';

export const metadata: Metadata = { title: 'Client adjustment mappings' };

/**
 * CL-06 Adjustment mappings for one client: what applies to each code in this client's PM (its own
 * override, the company's mapping, or Cleanpost's default), codes its payments wait on first.
 */
export default async function ClientMappingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'client.view', { clientId: id }).allowed) notFound();
  const { pmName, pmType, rows } = await clientMappings(ctx, id);
  const canEdit = policy.authorize(ctx.actor, 'mappings.manage', { clientId: id }).allowed;
  if (!pmType)
    return <p className="muted">This client has no PM connection, so there is nothing to map yet.</p>;
  return (
    <>
      <div className="card flush">
        <div className="table-wrap">
          <table className="table" aria-label={`${pmName} adjustment mappings for this client`}>
            <thead>
              <tr>
                <th>835 code</th>
                <th>Meaning</th>
                <th>{pmName} code</th>
                <th>What happens</th>
                <th>Source</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ClientMappingRow
                  key={`${r.groupCode}-${r.carc}`}
                  clientId={id}
                  row={r}
                  meaning={codeMeaning(r.groupCode, r.carc)}
                  pmName={pmName}
                  canEdit={canEdit}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted dense" style={{ margin: 0 }}>
        Company mappings for every client on {pmName} are in{' '}
        <Link className="inline-link" href={`/settings/mappings?pm=${encodeURIComponent(pmType)}`}>
          Settings, adjustment mappings
        </Link>
        . Denial codes are never mapped: their balance stays open for the denial queue.
      </p>
    </>
  );
}
