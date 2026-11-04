'use client';
/** S-04 client override row: follow the company default, a number of its own, or review everything. */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { saveClientThreshold } from './actions';

type Mode = 'default' | 'own' | 'review';

export function ClientThreshold({
  clientId,
  clientName,
  threshold,
  company,
}: {
  clientId: string;
  clientName: string;
  threshold: number | null;
  company: number;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Mode>(
    threshold === null ? 'default' : threshold >= 100 ? 'review' : 'own',
  );
  const [own, setOwn] = useState(threshold !== null && threshold < 100 ? threshold : company);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const shown =
    threshold === null
      ? `Default (${company >= 100 ? 'review everything' : company})`
      : threshold >= 100
        ? 'Review everything'
        : String(threshold);

  if (!editing)
    return (
      <span className="row dense" style={{ gap: 8, flexWrap: 'nowrap', justifyContent: 'space-between' }}>
        <span className={threshold === null ? 'muted' : undefined}>{shown}</span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit<span className="sr-only"> {clientName}</span>
        </Button>
      </span>
    );

  const save = () =>
    start(async () => {
      const res = await saveClientThreshold(
        clientId,
        mode === 'default' ? null : mode === 'review' ? 100 : own,
      );
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      }
    });

  return (
    <span className="row dense" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <select
        className="select"
        aria-label={`Threshold for ${clientName}`}
        value={mode}
        onChange={(e) => setMode(e.target.value as Mode)}
      >
        <option value="default">Company default</option>
        <option value="own">Its own number</option>
        <option value="review">Review everything</option>
      </select>
      {mode === 'own' && (
        <input
          className="input num"
          type="number"
          min={0}
          max={99}
          value={own}
          aria-label={`${clientName} threshold`}
          onChange={(e) => setOwn(Math.max(0, Math.min(99, Math.round(Number(e.target.value) || 0))))}
          style={{ width: 70 }}
        />
      )}
      <Button size="sm" onClick={() => setEditing(false)} disabled={pending}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" onClick={save} disabled={pending}>
        Save<span className="sr-only"> {clientName}</span>
      </Button>
    </span>
  );
}
