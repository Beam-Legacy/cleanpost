'use client';
/** CL-04 editors: add or change a provider (NPI checked) or a location, in a small dialog. */
import { useState, useTransition, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, useToast } from '@cleanpost/ui';
import type { LocationRow, ProviderRow } from '@/lib/queries/client-detail';
import { saveLocationAction, saveProviderAction } from '../actions';

function useSave(onDone: () => void) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) return setError(res.message);
      toast({ message: res.message });
      onDone();
      router.refresh();
    });
  return { pending, error, run };
}

export function ProviderEditor({
  clientId,
  provider,
  trigger,
}: {
  clientId: string;
  provider: ProviderRow | null;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [npi, setNpi] = useState(provider?.npi ?? '');
  const [name, setName] = useState(provider?.name ?? '');
  const [taxonomy, setTaxonomy] = useState(provider?.taxonomy ?? '');
  const [role, setRole] = useState(provider?.role ?? 'rendering');
  const { pending, error, run } = useSave(() => setOpen(false));
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={provider ? `Edit ${provider.name}` : 'Add provider'}
      size="sm"
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(() =>
                saveProviderAction(clientId, provider?.id ?? null, {
                  npi: npi.trim(),
                  name,
                  taxonomy: taxonomy || null,
                  role: role as 'rendering',
                }),
              )
            }
          >
            {provider ? 'Save provider' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="pv-npi">NPI</label>
          <input
            id="pv-npi"
            className="input mono"
            inputMode="numeric"
            maxLength={10}
            value={npi}
            onChange={(e) => setNpi(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pv-name">Name as billed</label>
          <input
            id="pv-name"
            className="input"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pv-tax">Taxonomy code</label>
          <input
            id="pv-tax"
            className="input mono"
            maxLength={10}
            value={taxonomy}
            onChange={(e) => setTaxonomy(e.target.value)}
            placeholder="207Q00000X"
          />
        </div>
        <div className="field">
          <label htmlFor="pv-role">Role on claims</label>
          <select id="pv-role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="rendering">Rendering</option>
            <option value="billing">Billing</option>
            <option value="referring">Referring</option>
          </select>
        </div>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </Modal>
  );
}

export function LocationEditor({
  clientId,
  location,
  trigger,
}: {
  clientId: string;
  location: LocationRow | null;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(location?.name ?? '');
  const [line1, setLine1] = useState(location?.address?.line1 ?? '');
  const [city, setCity] = useState(location?.address?.city ?? '');
  const [state, setState] = useState(location?.address?.state ?? '');
  const [zip, setZip] = useState(location?.address?.zip ?? '');
  const [pos, setPos] = useState(location?.placeOfService ?? '11');
  const [npi, setNpi] = useState(location?.npi ?? '');
  const { pending, error, run } = useSave(() => setOpen(false));
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      title={location ? `Edit ${location.name}` : 'Add location'}
      size="sm"
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              run(() =>
                saveLocationAction(clientId, location?.id ?? null, {
                  name,
                  line1,
                  city,
                  state,
                  zip,
                  placeOfService: pos.trim(),
                  npi: npi.trim() || null,
                }),
              )
            }
          >
            {location ? 'Save location' : 'Add location'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="field">
          <label htmlFor="lc-name">Name</label>
          <input
            id="lc-name"
            className="input"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="lc-line1">Street</label>
          <input
            id="lc-line1"
            className="input"
            maxLength={120}
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
          />
        </div>
        <div className="grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="lc-city">City</label>
            <input
              id="lc-city"
              className="input"
              maxLength={60}
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div className="row dense" style={{ gap: 8 }}>
            <div className="field">
              <label htmlFor="lc-state">State</label>
              <input
                id="lc-state"
                className="input"
                maxLength={2}
                value={state}
                onChange={(e) => setState(e.target.value)}
                style={{ width: 60 }}
              />
            </div>
            <div className="field">
              <label htmlFor="lc-zip">ZIP</label>
              <input
                id="lc-zip"
                className="input"
                maxLength={10}
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                style={{ width: 110 }}
              />
            </div>
          </div>
        </div>
        <div className="grid-2" style={{ gap: 12 }}>
          <div className="field">
            <label htmlFor="lc-pos">Place of service</label>
            <input
              id="lc-pos"
              className="input mono"
              maxLength={2}
              value={pos}
              onChange={(e) => setPos(e.target.value)}
              style={{ width: 70 }}
            />
            <span className="help">11 office, 22 outpatient hospital, 02 telehealth.</span>
          </div>
          <div className="field">
            <label htmlFor="lc-npi">Facility NPI (optional)</label>
            <input
              id="lc-npi"
              className="input mono"
              inputMode="numeric"
              maxLength={10}
              value={npi}
              onChange={(e) => setNpi(e.target.value)}
            />
          </div>
        </div>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </Modal>
  );
}
