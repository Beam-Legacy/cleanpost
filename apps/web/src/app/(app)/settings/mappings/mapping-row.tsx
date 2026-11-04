'use client';
/** S-08 row: the code's mapping, edited in place (PM code and what it does), or a new code to add. */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert } from 'lucide-react';
import { Button, useToast } from '@cleanpost/ui';
import { MAPPING_ACTIONS, mappingActionLabel } from '@/lib/mapping-display';
import { saveCompanyMapping } from './actions';

export interface RowData {
  groupCode: string;
  carc: string;
  meaning: string;
  pmCode: string | null;
  action: string | null;
  source: 'yours' | 'default' | 'unmapped';
  overrides: number;
  waiting: number;
}

function useSave(onDone: () => void) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const save = (input: Parameters<typeof saveCompanyMapping>[0]) =>
    start(async () => {
      const res = await saveCompanyMapping(input);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        onDone();
        router.refresh();
      }
    });
  return { pending, save };
}

export function MappingRow({ row, pmType, pmName }: { row: RowData; pmType: string; pmName: string }) {
  const pair = `${row.groupCode}-${row.carc}`;
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(row.pmCode ?? '');
  const [action, setAction] = useState<string>(row.action ?? 'write_off');
  const { pending, save } = useSave(() => setEditing(false));

  return (
    <tr className={row.source === 'unmapped' ? 'row-warn' : undefined}>
      <th scope="row" className="code" style={{ fontWeight: 600 }}>
        {pair}
      </th>
      <td>{row.meaning}</td>
      <td>
        {editing ? (
          <input
            className="input mono"
            aria-label={`${pmName} code for ${pair}`}
            value={code}
            maxLength={20}
            autoComplete="off"
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
        {row.source === 'yours'
          ? 'Your mapping'
          : row.source === 'default'
            ? 'Cleanpost default'
            : row.waiting
              ? `${row.waiting === 1 ? '1 client' : `${row.waiting} clients`} waiting`
              : 'Not mapped'}
        {row.overrides > 0 &&
          ` · ${row.overrides === 1 ? '1 client override' : `${row.overrides} client overrides`}`}
      </td>
      <td style={{ textAlign: 'right' }}>
        {editing ? (
          <span className="row dense" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
            <Button size="sm" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={pending || code.trim().length === 0}
              onClick={() =>
                save({ pmType, groupCode: row.groupCode, carc: row.carc, pmAdjustmentCode: code, action })
              }
            >
              Save<span className="sr-only"> {pair}</span>
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {row.pmCode ? 'Edit' : 'Map'}
            <span className="sr-only"> {pair}</span>
          </Button>
        )}
      </td>
    </tr>
  );
}

const GROUPS = ['CO', 'PR', 'OA', 'PI', 'CR'] as const;

/** Add a code that has not come up yet, so it posts right the first time. */
export function AddMapping({ pmType, pmName }: { pmType: string; pmName: string }) {
  const [group, setGroup] = useState<string>('OA');
  const [carc, setCarc] = useState('');
  const [code, setCode] = useState('');
  const [action, setAction] = useState<string>('adjust');
  const { pending, save } = useSave(() => {
    setCarc('');
    setCode('');
  });
  return (
    <form
      className="row dense"
      aria-label="Add a code"
      style={{ gap: 8, alignItems: 'flex-end' }}
      onSubmit={(e) => {
        e.preventDefault();
        save({ pmType, groupCode: group, carc, pmAdjustmentCode: code, action });
      }}
    >
      <div className="field">
        <label htmlFor="add-group">Group</label>
        <select id="add-group" className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
          {GROUPS.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="add-carc">Reason code</label>
        <input
          id="add-carc"
          className="input mono"
          value={carc}
          maxLength={5}
          placeholder="94"
          onChange={(e) => setCarc(e.target.value)}
          style={{ width: 90 }}
        />
      </div>
      <div className="field">
        <label htmlFor="add-code">{pmName} code</label>
        <input
          id="add-code"
          className="input mono"
          value={code}
          maxLength={20}
          autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
          style={{ width: 120 }}
        />
      </div>
      <div className="field">
        <label htmlFor="add-action">What it does</label>
        <select id="add-action" className="select" value={action} onChange={(e) => setAction(e.target.value)}>
          {MAPPING_ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" size="sm" disabled={pending || !carc.trim() || !code.trim()}>
        Add code
      </Button>
    </form>
  );
}
