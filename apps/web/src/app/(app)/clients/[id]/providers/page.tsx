import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Plus } from 'lucide-react';
import { policy } from '@cleanpost/domain';
import { formatDate } from '@/lib/format';
import { clientProviders } from '@/lib/queries/client-detail';
import { requireActiveContext } from '@/lib/session';
import { LocationEditor, ProviderEditor } from './editors';

export const metadata: Metadata = { title: 'Providers and locations' };

const ROLE: Record<string, string> = { rendering: 'Rendering', billing: 'Billing', referring: 'Referring' };

/** CL-04 Providers and locations: the NPIs, taxonomies and places of service that go on claims. */
export default async function ClientProvidersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireActiveContext();
  if (!policy.authorize(ctx.actor, 'client.view', { clientId: id }).allowed) notFound();
  const { providers, locations } = await clientProviders(ctx, id);
  const canEdit = policy.authorize(ctx.actor, 'client.manage', { clientId: id }).allowed;
  const seen = (d: string | null) => (d ? formatDate(d) : 'Not yet');

  return (
    <>
      <div className="card flush">
        <div className="card-head">
          <h2>Providers</h2>
          {canEdit && (
            <div style={{ marginLeft: 'auto' }}>
              <ProviderEditor
                clientId={id}
                provider={null}
                trigger={
                  <button type="button" className="btn btn-secondary btn-sm">
                    <Plus aria-hidden />
                    Add provider
                  </button>
                }
              />
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="table" aria-label="Providers">
            <thead>
              <tr>
                <th>Name</th>
                <th>NPI</th>
                <th>Taxonomy</th>
                <th>Role</th>
                <th>Last on a visit</th>
                {canEdit && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {p.name}
                  </th>
                  <td className="code">{p.npi}</td>
                  <td className="code">{p.taxonomy ?? '—'}</td>
                  <td>{ROLE[p.role] ?? p.role}</td>
                  <td className="muted">{seen(p.lastSeen)}</td>
                  {canEdit && (
                    <td>
                      <ProviderEditor
                        clientId={id}
                        provider={p}
                        trigger={
                          <button type="button" className="btn btn-ghost btn-sm">
                            Edit<span className="sr-only"> {p.name}</span>
                          </button>
                        }
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card flush">
        <div className="card-head">
          <h2>Locations</h2>
          {canEdit && (
            <div style={{ marginLeft: 'auto' }}>
              <LocationEditor
                clientId={id}
                location={null}
                trigger={
                  <button type="button" className="btn btn-secondary btn-sm">
                    <Plus aria-hidden />
                    Add location
                  </button>
                }
              />
            </div>
          )}
        </div>
        <div className="table-wrap">
          <table className="table" aria-label="Locations">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Place of service</th>
                <th>NPI</th>
                <th>Last on a visit</th>
                {canEdit && (
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => (
                <tr key={l.id}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {l.name}
                  </th>
                  <td>
                    {l.address?.line1
                      ? `${l.address.line1}, ${l.address.city ?? ''} ${l.address.state ?? ''} ${l.address.zip ?? ''}`.trim()
                      : '—'}
                  </td>
                  <td className="code">{l.placeOfService}</td>
                  <td className="code">{l.npi ?? '—'}</td>
                  <td className="muted">{seen(l.lastSeen)}</td>
                  {canEdit && (
                    <td>
                      <LocationEditor
                        clientId={id}
                        location={l}
                        trigger={
                          <button type="button" className="btn btn-ghost btn-sm">
                            Edit<span className="sr-only"> {l.name}</span>
                          </button>
                        }
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="muted dense" style={{ margin: 0 }}>
        NPIs pass their check digit before they are saved. Changes apply to claims built from now on.
      </p>
    </>
  );
}
