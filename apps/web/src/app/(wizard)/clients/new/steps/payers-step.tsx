'use client';
/**
 * O-06 Payers: match each payer name the PM uses to a payer, and set how long each allows to file.
 * Suggestions come from payer names and aliases; every name needs a payer before Continue.
 */
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton } from '@cleanpost/ui';
import type { PayerMatchRow } from '@/lib/queries/onboarding';
import { savePayersAction } from '../actions';
import { StepError, StepFoot, useStepAction } from '../wizard-client';

interface Choice {
  id: string;
  name: string;
  stediPayerId: string | null;
  defaultDays: number;
}

interface Row {
  pmName: string;
  payerId: string;
  days: string;
  suggested: boolean;
  /** Added by hand (a manual PM, or a payer the dry run did not see). */
  extra: boolean;
}

export function PayersStep({
  clientId,
  pmName,
  rows: initial,
  choices,
  back,
}: {
  clientId: string;
  pmName: string;
  rows: PayerMatchRow[];
  choices: Choice[];
  back: string;
}) {
  const days = (id: string | null) => String(choices.find((c) => c.id === id)?.defaultDays ?? 90);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((r) => ({
      pmName: r.pmName,
      payerId: r.payerId ?? '',
      days: r.timelyFilingDays ? String(r.timelyFilingDays) : r.payerId ? days(r.payerId) : '',
      suggested: Boolean(r.payerId) && !r.saved,
      extra: r.patients === null,
    })),
  );
  const [adding, setAdding] = useState('');
  const { pending, error, run } = useStepAction();
  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const unmatched = rows.filter((r) => !r.payerId).length;
  const used = new Set(rows.map((r) => r.payerId).filter(Boolean));
  const ready = rows.length > 0 && unmatched === 0 && rows.every((r) => /^\d+$/.test(r.days));

  return (
    <>
      <div className="card flush">
        <div className="table-wrap">
          <table className="table" aria-label="Payer matches">
            <thead>
              <tr>
                <th>Name in {pmName}</th>
                <th>Payer</th>
                <th>Status</th>
                <th>Timely filing (days)</th>
                <th>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.pmName}-${i}`}>
                  <td className="mono">{r.pmName}</td>
                  <td>
                    <select
                      className="select"
                      aria-label={`Payer for ${r.pmName}`}
                      value={r.payerId}
                      onChange={(e) =>
                        update(i, {
                          payerId: e.target.value,
                          suggested: false,
                          days: r.days || days(e.target.value),
                        })
                      }
                    >
                      <option value="">Choose payer…</option>
                      {choices.map((c) => (
                        <option key={c.id} value={c.id} disabled={used.has(c.id) && c.id !== r.payerId}>
                          {c.name}
                          {c.stediPayerId ? ` · ${c.stediPayerId}` : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {r.payerId ? (
                      <span className="chip chip-good">{r.suggested ? 'Suggested' : 'Matched'}</span>
                    ) : (
                      <span className="chip chip-warn">Choose payer</span>
                    )}
                  </td>
                  <td>
                    <input
                      className="input mono"
                      style={{ width: 96 }}
                      inputMode="numeric"
                      aria-label={`Timely filing days for ${r.pmName}`}
                      placeholder="Days"
                      value={r.days}
                      onChange={(e) => update(i, { days: e.target.value.replace(/\D/g, '') })}
                    />
                  </td>
                  <td className="num">
                    {r.extra && (
                      <IconButton
                        ghost
                        label={`Remove ${r.pmName}`}
                        icon={<Trash2 />}
                        onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-foot row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select
            className="select"
            aria-label="Add a payer"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            style={{ maxWidth: 320 }}
          >
            <option value="">Add a payer this practice bills…</option>
            {choices
              .filter((c) => !used.has(c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
          <Button
            size="sm"
            disabled={!adding}
            onClick={() => {
              const c = choices.find((x) => x.id === adding);
              if (!c) return;
              setRows((rs) => [
                ...rs,
                { pmName: c.name, payerId: c.id, days: String(c.defaultDays), suggested: false, extra: true },
              ]);
              setAdding('');
            }}
          >
            <Plus aria-hidden />
            Add
          </Button>
          <span className="spacer" />
          <span className="subtle dense">
            Defaults: 90 days commercial, 365 days Medicare and Medicaid. Check each payer contract.
          </span>
        </div>
      </div>
      <StepFoot
        back={back}
        aside={
          <>
            {unmatched > 0 && (
              <span className="subtle dense">
                {unmatched === 1 ? '1 name needs' : `${unmatched} names need`} a payer
              </span>
            )}
            <StepError error={error} />
          </>
        }
      >
        <Button
          variant="primary"
          disabled={!ready || pending}
          onClick={() =>
            run(() =>
              savePayersAction(
                clientId,
                rows.map((r) => ({ pmName: r.pmName, payerId: r.payerId, timelyFilingDays: Number(r.days) })),
              ),
            )
          }
        >
          {pending ? 'Saving…' : 'Continue'}
        </Button>
      </StepFoot>
    </>
  );
}
