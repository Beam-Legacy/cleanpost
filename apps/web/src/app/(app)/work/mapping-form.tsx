'use client';
/**
 * W-19 Map an adjustment code: the 835's group code and CARC to the PM's own code, and what it does.
 * Applies to every client on this PM, or to this client only. Admins only.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { MAPPING_ACTIONS } from '@/lib/mapping-display';
import { mapAdjustmentCode } from './actions';

const ACTIONS = MAPPING_ACTIONS;

export function MappingForm({
  itemId,
  pair,
  pmName,
  clientName,
}: {
  itemId: string;
  pair: string;
  pmName: string;
  clientName: string | null;
}) {
  const [code, setCode] = useState('');
  const [action, setAction] = useState<string>('write_off');
  const [scope, setScope] = useState<'pm_type' | 'client'>('pm_type');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const save = () =>
    start(async () => {
      const res = await mapAdjustmentCode(itemId, { pmAdjustmentCode: code, action, scope });
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) router.refresh();
    });
  return (
    <form
      className="stack-sm"
      aria-label={`Map ${pair}`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <span className="overline">Map {pair}</span>
      <label className="field">
        <span className="label">{pmName} adjustment code</span>
        <input
          className="input"
          value={code}
          maxLength={20}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="label">What it does</span>
        <select className="select" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label">Applies to</legend>
        <label className="check">
          <input
            type="radio"
            name="scope"
            checked={scope === 'pm_type'}
            onChange={() => setScope('pm_type')}
          />
          Every client on {pmName}
        </label>
        <label className="check">
          <input type="radio" name="scope" checked={scope === 'client'} onChange={() => setScope('client')} />
          Only {clientName ?? 'this client'}
        </label>
      </fieldset>
      <div>
        <Button type="submit" variant="primary" size="sm" disabled={pending || !code.trim()}>
          Save mapping
        </Button>
      </div>
    </form>
  );
}
