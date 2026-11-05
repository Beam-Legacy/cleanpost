'use client';
/**
 * O-07 Mode: how claims leave and payments come back. Mode A is the one built today (docs/04 and
 * DEC-01): the PM keeps sending claims and posting payments; Cleanpost checks both. B and C are
 * shown with what they would need, and cannot be chosen yet.
 */
import { useState } from 'react';
import { Button } from '@cleanpost/ui';
import { chooseModeAction } from '../actions';
import { StepError, StepFoot, useStepAction } from '../wizard-client';

export function ModeStep({
  clientId,
  pmName,
  reason,
  canHold,
  payers,
  back,
}: {
  clientId: string;
  pmName: string;
  reason: string;
  canHold: boolean;
  payers: { name: string; timelyFilingDays: number }[];
  back: string;
}) {
  const [mode, setMode] = useState<'A'>('A');
  const { pending, error, run } = useStepAction();
  return (
    <>
      <p className="muted" style={{ margin: '-8px 0 0', maxWidth: 720 }}>
        We recommend Mode A. {reason}
      </p>
      <div className="grid-3" role="radiogroup" aria-label="Mode">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'A'}
          className={`option-card${mode === 'A' ? ' selected' : ''}`}
          onClick={() => setMode('A')}
        >
          <span className="row" style={{ gap: 8 }}>
            <span className="mode">Mode A</span>
            <span className="chip chip-good">Recommended</span>
          </span>
          <b>{pmName} sends, Cleanpost checks</b>
          <span className="muted dense">
            Claims keep going out through {pmName}&apos;s clearinghouse. Cleanpost scrubs each charge first
            {canHold ? `, holding it in ${pmName} until it is ready,` : ''} and checks every posted payment
            line.
          </span>
          <span className="stack-sm dense" style={{ gap: 4 }}>
            <span>· Live this week</span>
            <span>· No payer re-enrollment</span>
            <span>
              ·{' '}
              {canHold
                ? `Late fixes wait for the next ${pmName} batch`
                : `${pmName} cannot hold charges, so a fix may reach it after the claim went out`}
            </span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={false} disabled className="option-card">
          <span className="row" style={{ gap: 8 }}>
            <span className="mode">Mode B</span>
            <span className="tag">Later</span>
          </span>
          <b>Cleanpost sends and posts</b>
          <span className="muted dense">
            Claims go out through Stedi from Cleanpost and payments come to Cleanpost. Needs ERA enrollment
            with each payer. Not available yet.
          </span>
        </button>
        <button type="button" role="radio" aria-checked={false} disabled className="option-card">
          <span className="row" style={{ gap: 8 }}>
            <span className="mode">Mode C</span>
            <span className="tag">Later</span>
          </span>
          <b>Cleanpost sends, {pmName} posts</b>
          <span className="muted dense">
            Claims go out through Stedi from Cleanpost; payments stay with {pmName}. You would turn off
            {` ${pmName}`}&apos;s claim submission. Not available yet.
          </span>
        </button>
      </div>
      {payers.length > 0 && (
        <div className="card flush">
          <div className="card-head">
            <h2>Per-payer settings</h2>
            <span className="spacer" />
            <span className="subtle dense">All payers follow Mode A.</span>
          </div>
          <div className="table-wrap">
            <table className="table nowrap" aria-label="Payers">
              <thead>
                <tr>
                  <th>Payer</th>
                  <th>Mode</th>
                  <th>ERA enrollment with Stedi</th>
                  <th className="num">Timely filing</th>
                </tr>
              </thead>
              <tbody>
                {payers.map((p) => (
                  <tr key={p.name}>
                    <td>
                      <b>{p.name}</b>
                    </td>
                    <td>Follows client (A)</td>
                    <td className="muted">Not needed in Mode A</td>
                    <td className="num">{p.timelyFilingDays} days</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <StepFoot back={back} aside={<StepError error={error} />}>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => run(() => chooseModeAction(clientId, mode))}
        >
          {pending ? 'Saving…' : 'Continue with Mode A'}
        </Button>
      </StepFoot>
    </>
  );
}
