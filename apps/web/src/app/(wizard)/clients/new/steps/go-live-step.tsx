'use client';
/**
 * O-10 Go-live checklist: every docs/13 item computed from what was saved, the billers and the
 * practice-informed tick set here, a template email for the practice, and Go live once all pass.
 */
import { useState } from 'react';
import Link from 'next/link';
import { CircleCheck, Copy } from 'lucide-react';
import type { ChecklistItem } from '@cleanpost/domain';
import { Button, useToast } from '@cleanpost/ui';
import { goLiveAction, practiceInformedAction, setBillersAction } from '../actions';
import { StepError, StepFoot, useStepAction } from '../wizard-client';

export function GoLiveStep({
  clientId,
  items,
  details,
  billers,
  primaryId,
  backupId,
  informed,
  email,
  firstSyncNote,
  back,
}: {
  clientId: string;
  items: ChecklistItem[];
  /** One line under each item, by key. */
  details: Record<string, string>;
  billers: { id: string; name: string; role: string }[];
  primaryId: string | null;
  backupId: string | null;
  informed: boolean;
  email: string;
  firstSyncNote: string;
  back: string;
}) {
  const [primary, setPrimary] = useState(primaryId ?? '');
  const [backup, setBackup] = useState(backupId ?? '');
  // Ticks at once; the saved value comes back with the refresh.
  const [told, setTold] = useState(informed);
  const people = useStepAction();
  const tick = useStepAction();
  const live = useStepAction();
  const toast = useToast();
  const left = items.filter((i) => !i.ok).length;
  const billersChanged = (primary || null) !== primaryId || (backup || null) !== backupId;

  return (
    <>
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
            <ul
              className="stack-sm"
              style={{ listStyle: 'none', margin: 0, padding: 0, gap: 0 }}
              aria-label="Checklist"
            >
              {items.map((i) => (
                <li
                  key={i.key}
                  className="row-between"
                  style={{
                    padding: '10px 0',
                    borderBottom: '1px solid var(--border)',
                    flexWrap: 'nowrap',
                    gap: 12,
                  }}
                >
                  <span>
                    <b>{i.label}</b>
                    <br />
                    <span className="subtle dense">{details[i.key] ?? ''}</span>
                  </span>
                  {i.ok ? (
                    <span className="chip chip-good">
                      <CircleCheck aria-hidden />
                      Done
                    </span>
                  ) : i.fix === 'go-live' ? (
                    <span className="chip chip-warn">Below</span>
                  ) : (
                    <Link
                      className="btn btn-secondary btn-sm"
                      href={`/clients/new/${i.fix}?client=${clientId}`}
                    >
                      Fix
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Billers</h2>
            </div>
            <div className="card-body stack">
              <div className="field">
                <label htmlFor="o10p">Primary biller</label>
                <select
                  id="o10p"
                  className="select"
                  value={primary}
                  onChange={(e) => setPrimary(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {billers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.role})
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="o10b">Backup biller</label>
                <select
                  id="o10b"
                  className="select"
                  value={backup}
                  onChange={(e) => setBackup(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {billers
                    .filter((b) => b.id !== primary)
                    .map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.role})
                      </option>
                    ))}
                </select>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Button
                  size="sm"
                  disabled={!billersChanged || people.pending}
                  onClick={() =>
                    people.run(() => setBillersAction(clientId, primary || null, backup || null))
                  }
                >
                  {people.pending ? 'Saving…' : 'Save billers'}
                </Button>
                <StepError error={people.error} />
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Tell the practice</h2>
            </div>
            <div className="card-body stack">
              <p className="dense muted" style={{ margin: 0 }}>
                {firstSyncNote}
              </p>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Button
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(email);
                      toast({ message: 'Email copied. Paste it into your own email to the practice.' });
                    } catch {
                      toast({ message: 'Copying was blocked by the browser.', tone: 'bad' });
                    }
                  }}
                >
                  <Copy aria-hidden />
                  Copy email for the practice
                </Button>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={told}
                  disabled={tick.pending}
                  onChange={(e) => {
                    const v = e.target.checked;
                    setTold(v);
                    tick.run(() => practiceInformedAction(clientId, v), { quiet: true });
                  }}
                />
                <span>The practice knows Cleanpost starts today</span>
              </label>
              <StepError error={tick.error} />
            </div>
          </div>
        </div>
      </div>
      <StepFoot
        back={back}
        aside={
          <>
            {left > 0 && (
              <span className="subtle dense">{left === 1 ? '1 item left' : `${left} items left`}</span>
            )}
            <StepError error={live.error} />
          </>
        }
      >
        <Button
          variant="primary"
          disabled={left > 0 || live.pending}
          onClick={() => live.run(() => goLiveAction(clientId))}
        >
          {live.pending ? 'Going live…' : 'Go live'}
        </Button>
      </StepFoot>
    </>
  );
}
