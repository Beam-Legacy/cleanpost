'use client';
/**
 * Record the onboarding baseline: the practice's figures before Cleanpost, from its own reports, so
 * CL-02, RP-02 and the practice report compare against where the practice started. Admins only.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, useToast } from '@cleanpost/ui';
import type { ClientBaseline } from '@cleanpost/domain';
import { saveBaselineAction } from './actions';

const num = (s: string) => (s.trim() === '' ? null : Number(s.replace(/[$,%\s]/g, '')));

export function BaselineForm({ clientId, baseline }: { clientId: string; baseline: ClientBaseline | null }) {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState(
    baseline?.collectionsCents != null ? String(Math.round(baseline.collectionsCents / 100)) : '',
  );
  const [firstPass, setFirstPass] = useState(baseline?.firstPass != null ? String(baseline.firstPass) : '');
  const [denialRate, setDenialRate] = useState(
    baseline?.denialRate != null ? String(baseline.denialRate) : '',
  );
  const [daysInAr, setDaysInAr] = useState(baseline?.daysInAr != null ? String(baseline.daysInAr) : '');
  const [source, setSource] = useState(baseline?.source ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const save = () =>
    start(async () => {
      setError(null);
      const dollars = num(collections);
      const values = [dollars, num(firstPass), num(denialRate), num(daysInAr)];
      if (values.some((v) => v !== null && !Number.isFinite(v))) return setError('Use numbers only.');
      const res = await saveBaselineAction(clientId, {
        collectionsCents: dollars === null ? null : Math.round(dollars * 100),
        firstPass: values[1] ?? null,
        denialRate: values[2] ?? null,
        daysInAr: values[3] ?? null,
        source: source.trim() || null,
      });
      if (!res.ok) return setError(res.message);
      toast({ message: res.message });
      setOpen(false);
      router.refresh();
    });

  const field = (id: string, label: string, value: string, set: (v: string) => void, help: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input num"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
      />
      <span className="help">{help}</span>
    </div>
  );

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button size="sm" variant={baseline ? 'ghost' : 'secondary'}>
          {baseline ? 'Edit baseline' : 'Record the baseline'}
        </Button>
      }
      title="Onboarding baseline"
      description="The practice's figures before Cleanpost, from its own reports. Leave out what you do not have."
      size="sm"
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={pending}>
            Save baseline
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2" style={{ gap: 12 }}>
          {field(
            'bl-collections',
            'Collections in a typical month ($)',
            collections,
            setCollections,
            'Insurance and patient payments.',
          )}
          {field(
            'bl-firstpass',
            'First-pass acceptance (%)',
            firstPass,
            setFirstPass,
            'Claims accepted the first time.',
          )}
          {field('bl-denials', 'Denial rate (%)', denialRate, setDenialRate, 'Service lines denied.')}
          {field('bl-ar', 'Days in A/R', daysInAr, setDaysInAr, 'Open insurance A/R over daily charges.')}
        </div>
        <div className="field">
          <label htmlFor="bl-source">Where the figures came from</label>
          <input
            id="bl-source"
            className="input"
            maxLength={200}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="Practice PM reports, Jan to Jun 2026"
          />
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
