'use client';
/**
 * S-04 Default release threshold: a slider and number, the simulation of last month's claims at the
 * chosen value (computed here from the score counts, so it updates as you move), and Save. Lowering by
 * more than 5 asks first (G-11).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, useToast } from '@cleanpost/ui';
import { simulateRelease } from '@cleanpost/domain';
import { saveCompanyThreshold } from './actions';

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);

export function DefaultThreshold({
  current,
  scores,
  scrubbed,
}: {
  current: number;
  scores: number[];
  scrubbed: number;
}) {
  const [value, setValue] = useState(current);
  const [confirm, setConfirm] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const share = simulateRelease(scores, scrubbed, value);
  const save = () =>
    start(async () => {
      const res = await saveCompanyThreshold(value);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      router.refresh();
    });

  return (
    <div className="card">
      <div className="card-body stack">
        <div className="row-between">
          <div>
            <h3 className="title-s" style={{ margin: 0 }}>
              Default release threshold
            </h3>
            <p className="muted dense" style={{ margin: 0, maxWidth: 640 }}>
              Claims with no blocking findings and a confidence score at or above this number are released
              automatically. Lower means more automation and more risk. Clients without their own number
              follow it.
            </p>
          </div>
          <Button
            variant="primary"
            disabled={pending || value === current}
            onClick={() => (current - value > 5 ? setConfirm(true) : save())}
          >
            Save
          </Button>
        </div>
        <div className="row" style={{ gap: 16, alignItems: 'center' }}>
          <input
            type="range"
            min={0}
            max={100}
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            aria-label="Default release threshold"
            style={{ flex: 1, maxWidth: 480, accentColor: 'var(--cobalt)' }}
          />
          <input
            className="input num"
            type="number"
            min={0}
            max={100}
            value={value}
            onChange={(e) => setValue(Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0))))}
            aria-label="Default release threshold, number"
            style={{ width: 80 }}
          />
        </div>
        <div className="row-between dense muted" style={{ maxWidth: 480 }}>
          <span>0 · release everything</span>
          <span>100 · review everything</span>
        </div>
        <p style={{ margin: 0 }} aria-live="polite">
          {scrubbed === 0 ? (
            <span className="muted">No claims were scrubbed in the last 30 days to simulate with.</span>
          ) : value >= 100 ? (
            <>At 100, every claim waits for a person.</>
          ) : (
            <>
              At {value}, about <b className="num">{pct(share)}</b> of the last 30 days&apos; claims across
              all clients would have gone out without review.
            </>
          )}
        </p>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Lower the default to ${value}?`}
        description={
          <p style={{ margin: 0 }}>
            From {current} to {value}: about {pct(share)} of claims would go out without review, against{' '}
            {pct(simulateRelease(scores, scrubbed, current))} now. It applies to claims scrubbed from now on.
          </p>
        }
        confirmLabel={`Lower to ${value}`}
        onConfirm={() => {
          setConfirm(false);
          save();
        }}
      />
    </div>
  );
}
