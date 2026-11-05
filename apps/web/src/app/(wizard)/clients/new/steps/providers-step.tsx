'use client';
/** O-02 Providers and locations: who sees patients and where, with the NPI check digit. */
import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from '@cleanpost/ui';
import type { LocationRow, ProviderRow } from '@/lib/queries/client-detail';
import { LocationEditor, ProviderEditor } from '@/app/(app)/clients/[id]/providers/editors';
import { continueProvidersAction, removeSetupRowAction } from '../actions';
import { ContinueButton, StepError, StepFoot, useStepAction } from '../wizard-client';

const ROLE = { rendering: 'Rendering', billing: 'Billing', referring: 'Referring' } as const;

export function ProvidersStep({
  clientId,
  providers,
  locations,
  back,
}: {
  clientId: string;
  providers: ProviderRow[];
  locations: LocationRow[];
  back: string;
}) {
  const remove = useStepAction();
  const rendering = providers.filter((p) => p.role === 'rendering').length;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Providers</h2>
          <span className="spacer" />
          <ProviderEditor
            clientId={clientId}
            provider={null}
            trigger={
              <Button size="sm">
                <Plus aria-hidden />
                Add provider
              </Button>
            }
          />
        </div>
        {providers.length ? (
          <div className="table-wrap">
            <table className="table" aria-label="Providers">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>NPI</th>
                  <th>Taxonomy</th>
                  <th>Role</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <b>{p.name}</b>
                    </td>
                    <td className="mono">{p.npi}</td>
                    <td className="mono">{p.taxonomy ?? '—'}</td>
                    <td>{ROLE[p.role as keyof typeof ROLE] ?? p.role}</td>
                    <td className="num">
                      <IconButton
                        ghost
                        label={`Remove ${p.name}`}
                        icon={<Trash2 />}
                        disabled={remove.pending}
                        onClick={() => remove.run(() => removeSetupRowAction(clientId, 'provider', p.id))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-body muted dense">
            Add each clinician who sees patients. At least one rendering provider is needed.
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Locations</h2>
          <span className="spacer" />
          <LocationEditor
            clientId={clientId}
            location={null}
            trigger={
              <Button size="sm">
                <Plus aria-hidden />
                Add location
              </Button>
            }
          />
        </div>
        {locations.length ? (
          <div className="table-wrap">
            <table className="table" aria-label="Locations">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Place of service</th>
                  <th>
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <b>{l.name}</b>
                    </td>
                    <td>
                      {[l.address?.line1, l.address?.city, [l.address?.state, l.address?.zip].join(' ')]
                        .filter((x) => x && x.trim())
                        .join(', ') || '—'}
                    </td>
                    <td>
                      <span className="code">{l.placeOfService}</span>
                    </td>
                    <td className="num">
                      <IconButton
                        ghost
                        label={`Remove ${l.name}`}
                        icon={<Trash2 />}
                        disabled={remove.pending}
                        onClick={() => remove.run(() => removeSetupRowAction(clientId, 'location', l.id))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-body muted dense">Add the places where the practice sees patients.</div>
        )}
      </div>
      <StepError error={remove.error} />
      <p className="dense muted" style={{ margin: 0 }}>
        Providers can be added later from the client&apos;s Providers tab. Charges from an NPI that is not set
        up wait with a work item.
      </p>
      <StepFoot back={back}>
        <ContinueButton
          disabled={!rendering || !locations.length}
          action={() => continueProvidersAction(clientId)}
        />
      </StepFoot>
    </>
  );
}
