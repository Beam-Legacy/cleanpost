'use client';
/**
 * O-09 Automation: start by reviewing everything for two weeks (recommended), or release claims at
 * or above a threshold from day one. The threshold is kept either way and applies after the date.
 */
import { useState } from 'react';
import { Button } from '@cleanpost/ui';
import { setAutomationAction } from '../actions';
import { StepError, StepFoot, useStepAction } from '../wizard-client';

export function AutomationStep({
  clientId,
  clientName,
  reviewEndsOn,
  initial,
  companyDefault,
  back,
}: {
  clientId: string;
  clientName: string;
  /** "Nov 19, 2026": two weeks from today in the client's calendar. */
  reviewEndsOn: string;
  initial: { reviewEverything: boolean; threshold: number | null };
  companyDefault: number;
  back: string;
}) {
  const [review, setReview] = useState(initial.reviewEverything);
  const [threshold, setThreshold] = useState(initial.threshold ?? companyDefault);
  const { pending, error, run } = useStepAction();
  return (
    <>
      <div className="grid-2" role="radiogroup" aria-label="How claims start">
        <button
          type="button"
          role="radio"
          aria-checked={review}
          className={`option-card${review ? ' selected' : ''}`}
          onClick={() => setReview(true)}
        >
          <span className="row" style={{ gap: 8 }}>
            <b>Review everything for 2 weeks</b>
            <span className="chip chip-good">Recommended</span>
          </span>
          <span className="muted dense">
            Billers approve every claim until {reviewEndsOn}. Then you can see how often they changed what
            Cleanpost proposed and set the threshold with real numbers.
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!review}
          className={`option-card${!review ? ' selected' : ''}`}
          onClick={() => setReview(false)}
        >
          <b>Release automatically from day one</b>
          <span className="muted dense">
            Claims at or above the threshold go out without review starting at go-live.
          </span>
        </button>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>{review ? 'Threshold after the review period' : 'Threshold'}</h2>
        </div>
        <div className="card-body stack">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <span className="dense muted">More review</span>
            <input
              type="range"
              min={50}
              max={100}
              step={1}
              value={threshold}
              aria-label="Release threshold"
              onChange={(e) => setThreshold(Number(e.target.value))}
              style={{ flex: 1, minWidth: 160, accentColor: 'var(--cobalt)' }}
            />
            <span className="dense muted">More automatic</span>
            <input
              className="input mono"
              style={{ width: 72 }}
              aria-label="Threshold"
              inputMode="numeric"
              value={threshold}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                if (n <= 100) setThreshold(n);
              }}
            />
          </div>
          <p className="dense" style={{ margin: 0 }}>
            Claims for {clientName} scoring <b>{threshold}</b> or higher go out without review
            {review ? ` after ${reviewEndsOn}` : ''}; the rest wait in the work queue. The company default is{' '}
            {companyDefault}.
          </p>
          {threshold < 80 && (
            <p className="dense" role="status" style={{ margin: 0, color: 'var(--warning)' }}>
              Below 80, more claims go out with problems a biller would have caught, so expect more rejections
              and denials.
            </p>
          )}
          {threshold === 100 && (
            <p className="dense muted" style={{ margin: 0 }}>
              100 means every claim waits for a person.
            </p>
          )}
        </div>
      </div>
      <StepFoot back={back} aside={<StepError error={error} />}>
        <Button
          variant="primary"
          disabled={pending || threshold < 50 || threshold > 100}
          onClick={() =>
            run(() =>
              setAutomationAction(clientId, {
                reviewEverything: review,
                threshold: threshold === companyDefault ? null : threshold,
              }),
            )
          }
        >
          {pending ? 'Saving…' : 'Continue'}
        </Button>
      </StepFoot>
    </>
  );
}
