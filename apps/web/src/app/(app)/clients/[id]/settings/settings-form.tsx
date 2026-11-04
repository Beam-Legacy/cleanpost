'use client';
/**
 * CL-03 Client settings: release threshold (company default, its own number, or review everything),
 * review everything until a date, PM batch time and time zone, primary and backup biller. A footer
 * appears with the count of unsaved changes. Read-only for billers.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import type { ClientSettingsData } from '@/lib/queries/client-detail';
import { saveClientSettingsAction } from '../actions';

type Mode = 'default' | 'own' | 'review';

const ZONES = [
  ['America/New_York', 'Eastern'],
  ['America/Chicago', 'Central'],
  ['America/Denver', 'Mountain'],
  ['America/Phoenix', 'Arizona'],
  ['America/Los_Angeles', 'Pacific'],
  ['America/Anchorage', 'Alaska'],
  ['Pacific/Honolulu', 'Hawaii'],
] as const;

export function ClientSettingsForm({
  clientId,
  initial,
  canEdit,
}: {
  clientId: string;
  initial: ClientSettingsData;
  canEdit: boolean;
}) {
  const start0 = {
    mode: (initial.threshold === null ? 'default' : initial.threshold >= 100 ? 'review' : 'own') as Mode,
    own: initial.threshold !== null && initial.threshold < 100 ? initial.threshold : initial.company,
    reviewOn: initial.reviewUntil !== null,
    reviewUntil: initial.reviewUntil ?? '',
    batch: initial.pmBatchTime ?? '',
    timezone: initial.timezone,
    primary: initial.primaryBillerId ?? '',
    backup: initial.backupBillerId ?? '',
  };
  const [f, setF] = useState(start0);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  // Count settings, not fields: the threshold and the review date are one setting each.
  const effective = (x: typeof f) => [
    x.mode === 'default' ? null : x.mode === 'review' ? 100 : x.own,
    x.reviewOn && x.reviewUntil ? x.reviewUntil : null,
    x.batch || null,
    x.timezone,
    x.primary || null,
    x.backup || null,
  ];
  const was = effective(start0);
  const changes = effective(f).filter((v, i) => v !== was[i]).length;
  const save = () =>
    start(async () => {
      setError(null);
      const res = await saveClientSettingsAction(clientId, {
        threshold: f.mode === 'default' ? null : f.mode === 'review' ? 100 : f.own,
        reviewUntil: f.reviewOn && f.reviewUntil ? f.reviewUntil : null,
        pmBatchTime: f.batch || null,
        timezone: f.timezone as (typeof ZONES)[number][0],
        primaryBillerId: f.primary || null,
        backupBillerId: f.backup || null,
      });
      if (!res.ok) return setError(res.message);
      toast({ message: res.message });
      router.refresh();
    });

  return (
    <fieldset disabled={!canEdit || pending} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Automation</h2>
        </div>
        <div className="card-body stack">
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 6 }}>
              Release threshold
            </legend>
            <div className="stack-sm">
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={f.mode === 'default'}
                  onChange={() => set('mode', 'default')}
                />
                <span>
                  Company default ({initial.company >= 100 ? 'review everything' : initial.company})
                </span>
              </label>
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={f.mode === 'own'}
                  onChange={() => set('mode', 'own')}
                />
                <span>Its own number</span>
              </label>
              {f.mode === 'own' && (
                <input
                  className="input num"
                  type="number"
                  min={0}
                  max={99}
                  aria-label="Release threshold for this client"
                  value={f.own}
                  onChange={(e) =>
                    set('own', Math.max(0, Math.min(99, Math.round(Number(e.target.value) || 0))))
                  }
                  style={{ width: 90, marginLeft: 24 }}
                />
              )}
              <label className="check">
                <input
                  type="radio"
                  name="mode"
                  checked={f.mode === 'review'}
                  onChange={() => set('mode', 'review')}
                />
                <span>Review everything</span>
              </label>
            </div>
          </fieldset>
          <div className="stack-sm">
            <label className="check">
              <input
                type="checkbox"
                checked={f.reviewOn}
                onChange={(e) => set('reviewOn', e.target.checked)}
              />
              <span>Review everything until a date, then use the threshold</span>
            </label>
            {f.reviewOn && (
              <input
                className="input"
                type="date"
                aria-label="Review everything until"
                value={f.reviewUntil}
                onChange={(e) => set('reviewUntil', e.target.value)}
                style={{ width: 180, marginLeft: 24 }}
              />
            )}
          </div>
          <p className="muted dense" style={{ margin: 0 }}>
            Mode {initial.mode}: the PM sends claims and posts payments; Cleanpost checks them. Changing mode
            comes with CL-09.
          </p>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>PM and team</h2>
        </div>
        <div className="card-body grid-2" style={{ gap: 16 }}>
          <div className="field">
            <label htmlFor="cs-batch">PM batch time</label>
            <input
              id="cs-batch"
              className="input"
              type="time"
              value={f.batch}
              onChange={(e) => set('batch', e.target.value)}
              style={{ width: 140 }}
            />
            <span className="help">When the PM sends its daily claim batch; follow-ups count from it.</span>
          </div>
          <div className="field">
            <label htmlFor="cs-tz">Time zone</label>
            <select
              id="cs-tz"
              className="select"
              value={f.timezone}
              onChange={(e) => set('timezone', e.target.value)}
            >
              {ZONES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cs-primary">Primary biller</label>
            <select
              id="cs-primary"
              className="select"
              value={f.primary}
              onChange={(e) => set('primary', e.target.value)}
            >
              <option value="">Not set</option>
              {initial.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cs-backup">Backup biller</label>
            <select
              id="cs-backup"
              className="select"
              value={f.backup}
              onChange={(e) => set('backup', e.target.value)}
            >
              <option value="">Not set</option>
              {initial.people
                .filter((p) => p.id !== f.primary)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.role})
                  </option>
                ))}
            </select>
          </div>
        </div>
      </div>
      {error && (
        <div className="banner bad" role="alert">
          {error}
        </div>
      )}
      {canEdit && changes > 0 && (
        <div className="card" style={{ position: 'sticky', bottom: 16 }}>
          <div className="card-body row-between">
            <span>{changes === 1 ? '1 unsaved change' : `${changes} unsaved changes`}</span>
            <span className="row dense" style={{ gap: 8 }}>
              <Button onClick={() => setF(start0)}>Discard</Button>
              <Button variant="primary" onClick={save} aria-busy={pending}>
                Save changes
              </Button>
            </span>
          </div>
        </div>
      )}
    </fieldset>
  );
}
