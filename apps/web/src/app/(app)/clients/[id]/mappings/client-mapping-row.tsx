'use client';
/** CL-06 row: the code's mapping for this client; set the client's own, or go back to the company's. */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert } from 'lucide-react';
import { Button, useToast } from '@cleanpost/ui';
import { MAPPING_ACTIONS, mappingActionLabel } from '@/lib/mapping-display';
import type { ClientMappingRow as Row } from '@/lib/queries/client-detail';
import { resetClientMappingAction, saveClientMappingAction } from '../actions';

const SOURCE = {
  client: 'This client',
  company: 'Company',
  default: 'Cleanpost default',
  unmapped: 'Not mapped',
};

export function ClientMappingRow({
  clientId,
  row,
  meaning,
  pmName,
  canEdit,
}: {
  clientId: string;
  row: Row;
  meaning: string;
  pmName: string;
  canEdit: boolean;
}) {
  const pair = `${row.groupCode}-${row.carc}`;
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(row.pmCode ?? '');
  const [action, setAction] = useState<string>(row.action ?? 'write_off');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const res = await fn();
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        setEditing(false);
        router.refresh();
      }
    });
  return (
    <tr className={row.waiting ? 'row-warn' : undefined}>
      <th scope="row" className="code" style={{ fontWeight: 600 }}>
        {pair}
      </th>
      <td>{meaning}</td>
      <td>
        {editing ? (
          <input
            className="input mono"
            aria-label={`${pmName} code for ${pair}`}
            value={code}
            maxLength={20}
            onChange={(e) => setCode(e.target.value)}
            style={{ width: 120 }}
          />
        ) : row.pmCode ? (
          <span className="code">{row.pmCode}</span>
        ) : (
          <span className="chip chip-warn">
            <CircleAlert aria-hidden />
            Not mapped
          </span>
        )}
      </td>
      <td>
        {editing ? (
          <select
            className="select"
            aria-label={`What ${pair} does`}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            {MAPPING_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        ) : (
          mappingActionLabel(row.action)
        )}
      </td>
      <td className="muted">
        {SOURCE[row.source]}
        {row.waiting ? ' · payments wait for it' : ''}
        {row.fallback ? ` · otherwise ${row.fallback}` : ''}
      </td>
      <td style={{ textAlign: 'right' }}>
        {canEdit &&
          (editing ? (
            <span className="row dense" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
              <Button size="sm" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !code.trim()}
                onClick={() =>
                  run(() =>
                    saveClientMappingAction(clientId, {
                      groupCode: row.groupCode,
                      carc: row.carc,
                      pmAdjustmentCode: code,
                      action,
                    }),
                  )
                }
              >
                Save<span className="sr-only"> {pair}</span>
              </Button>
            </span>
          ) : (
            <span className="row dense" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
              {row.source === 'client' && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => run(() => resetClientMappingAction(clientId, row.groupCode, row.carc))}
                >
                  Reset to default<span className="sr-only"> {pair}</span>
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                {row.source === 'client' ? 'Edit' : 'Set for this client'}
                <span className="sr-only"> {pair}</span>
              </Button>
            </span>
          ))}
      </td>
    </tr>
  );
}
