'use client';
/**
 * M-01 Manual posting task actions: download the worksheet (F-02), mark as posted with the PM's
 * payment ID, or M-02 Couldn't complete with a reason (the task goes to the owner).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { couldNotComplete, markPosted } from './actions';

const REASONS = [
  'The PM would not accept a value',
  'Claim or charge not found in the PM',
  'Amounts differ from what the PM shows',
  'No access in the PM',
  'Other',
] as const;

export function PostingTask({ itemId, pmName }: { itemId: string; pmName: string }) {
  const [ref, setRef] = useState('');
  const [stuck, setStuck] = useState(false);
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const res = await fn();
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) router.refresh();
    });
  return (
    <div className="stack-sm">
      <div>
        <a className="btn btn-secondary btn-sm" href={`/work/${itemId}/worksheet`} download>
          Download worksheet (CSV)
        </a>
      </div>
      <form
        className="row"
        style={{ gap: 8, alignItems: 'flex-end' }}
        aria-label="Mark as posted"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => markPosted(itemId, ref));
        }}
      >
        <label className="field" style={{ flex: 1 }}>
          <span className="label">{pmName} payment ID</span>
          <input className="input" value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} />
        </label>
        <Button type="submit" variant="primary" size="sm" disabled={pending || !ref.trim()}>
          Mark as posted
        </Button>
      </form>
      {!stuck ? (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setStuck(true)}>
            I couldn&apos;t complete this
          </Button>
        </div>
      ) : (
        <form
          className="stack-sm"
          aria-label="Couldn't complete"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => couldNotComplete(itemId, reason, note));
          }}
        >
          <label className="field">
            <span className="label">What stopped you</span>
            <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Note (which rows you entered, if any)</span>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <Button type="submit" size="sm" disabled={pending}>
              Send to the owner
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStuck(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
