'use client';
/**
 * O-03 PM system: what Cleanpost can do in each PM today, per operation, before anything connects.
 * "My PM is not listed" chooses the manual adapter with the PM's name.
 */
import { useState } from 'react';
import { Ban, CircleCheck, FileText, ListChecks, PlugZap, Plus } from 'lucide-react';
import { Button } from '@cleanpost/ui';
import type { PmChoice } from '@/lib/onboarding/options';
import { choosePmAction } from '../actions';
import { StepError, StepFoot, useStepAction } from '../wizard-client';

export interface PmCard extends PmChoice {
  available: boolean;
  /** Operation label, level label, level (0 to 4 or unavailable). */
  ops: { label: string; level: string; value: number | 'unavailable' }[];
}

function LevelIcon({ value }: { value: number | 'unavailable' }) {
  if (value === 'unavailable') return <Ban aria-hidden />;
  if (value === 4) return <CircleCheck aria-hidden />;
  if (value === 3) return <FileText aria-hidden />;
  if (value === 0) return <ListChecks aria-hidden />;
  return <PlugZap aria-hidden />;
}

const tone = (v: number | 'unavailable') =>
  v === 'unavailable' ? 'chip-outline' : v === 4 ? 'chip-good' : v === 0 ? 'chip-warn' : 'chip-ready';

export function PmStep({
  clientId,
  clientName,
  cards,
  chosen,
  otherName,
  back,
}: {
  clientId: string;
  clientName: string;
  cards: PmCard[];
  chosen: string | null;
  otherName: string | null;
  back: string;
}) {
  const [pick, setPick] = useState<string | null>(chosen);
  const [other, setOther] = useState(otherName ?? '');
  const { pending, error, run } = useStepAction();
  const listed = cards.filter((c) => c.key !== 'manual');
  const manual = cards.find((c) => c.key === 'manual')!;
  const selected = cards.find((c) => c.key === pick);
  return (
    <>
      <div className="grid-2" role="radiogroup" aria-label={`PM system for ${clientName}`}>
        {listed.map((c) => (
          <button
            key={c.key}
            type="button"
            role="radio"
            aria-checked={pick === c.key}
            disabled={!c.available}
            className={`option-card${pick === c.key ? ' selected' : ''}`}
            onClick={() => setPick(c.key)}
          >
            <span className="row-between" style={{ width: '100%' }}>
              <b style={{ fontSize: 15 }}>{c.pmName}</b>
              <span className="tag">{c.available ? 'Demo PM' : 'Not in this environment'}</span>
            </span>
            <span className="subtle">{c.maker}</span>
            <span className="stack-sm" style={{ gap: 0, width: '100%' }}>
              {c.ops.map((o) => (
                <span
                  key={o.label}
                  className="row-between dense"
                  style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}
                >
                  <span>{o.label}</span>
                  <span className={`chip ${tone(o.value)}`}>
                    <LevelIcon value={o.value} />
                    {o.level}
                  </span>
                </span>
              ))}
            </span>
            <span className="muted dense">{c.note}</span>
          </button>
        ))}
      </div>
      <div className="card">
        <div className="card-body stack-sm">
          <button
            type="button"
            role="radio"
            aria-checked={pick === 'manual'}
            className={`option-card${pick === 'manual' ? ' selected' : ''}`}
            onClick={() => setPick('manual')}
          >
            <span className="row" style={{ gap: 8 }}>
              <Plus aria-hidden size={16} />
              <b>My PM is not listed</b>
            </span>
            <span className="muted dense">{manual.note}</span>
          </button>
          {pick === 'manual' && (
            <div className="field" style={{ maxWidth: 420 }}>
              <label htmlFor="o3other">Name of the PM system</label>
              <input
                id="o3other"
                className="input"
                placeholder="e.g. Office Ally"
                value={other}
                onChange={(e) => setOther(e.target.value)}
              />
            </div>
          )}
        </div>
      </div>
      <p className="dense muted" style={{ margin: 0 }}>
        Choosing a PM connects nothing yet; that happens in the next step. Operations shown as Manual are
        prepared by Cleanpost and completed by a biller in the PM.
      </p>
      <StepFoot back={back} aside={<StepError error={error} />}>
        <Button
          variant="primary"
          disabled={!selected || pending || (pick === 'manual' && other.trim().length < 2)}
          onClick={() => run(() => choosePmAction(clientId, pick!, pick === 'manual' ? other : null))}
        >
          {pending
            ? 'Saving…'
            : selected && selected.key !== 'manual'
              ? `Continue with ${selected.pmName}`
              : 'Continue'}
        </Button>
      </StepFoot>
    </>
  );
}
