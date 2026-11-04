'use client';
/** CL-05 inline edit of a payer's timely filing limit. */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { savePayerSettingsAction } from '../actions';

export function TimelyFiling({
  clientId,
  settingsId,
  payerName,
  days,
  canEdit,
}: {
  clientId: string;
  settingsId: string;
  payerName: string;
  days: number;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(days));
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  if (!editing)
    return (
      <span className="row dense" style={{ gap: 8, flexWrap: 'nowrap' }}>
        <span className="num">{days} days</span>
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            Edit<span className="sr-only"> timely filing for {payerName}</span>
          </Button>
        )}
      </span>
    );
  return (
    <span className="row dense" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <input
        className="input num"
        type="number"
        min={30}
        max={730}
        aria-label={`Timely filing days for ${payerName}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 80 }}
      />
      <Button size="sm" onClick={() => setEditing(false)} disabled={pending}>
        Cancel
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await savePayerSettingsAction(clientId, settingsId, Number(value));
            toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
            if (res.ok) {
              setEditing(false);
              router.refresh();
            }
          })
        }
      >
        Save<span className="sr-only"> timely filing for {payerName}</span>
      </Button>
    </span>
  );
}
