'use client';
/**
 * CL-08 Pause client (reason, note, optional resume date) and Resume. Pausing keeps syncing and
 * eligibility running; releases and PM write-backs wait until resume.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, useToast } from '@cleanpost/ui';
import { state } from '@cleanpost/domain';
import { pauseClientAction, resumeClientAction } from './actions';

export function PauseClient({
  clientId,
  clientName,
  pmName,
}: {
  clientId: string;
  clientName: string;
  pmName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<(typeof state.PAUSE_REASONS)[number]>(state.PAUSE_REASONS[0]);
  const [note, setNote] = useState('');
  const [resumeOn, setResumeOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const pm = pmName === '—' ? 'the PM' : pmName;
  const submit = () =>
    start(async () => {
      setError(null);
      const res = await pauseClientAction(clientId, {
        reason,
        note: note.trim() || null,
        resumeOn: resumeOn || null,
      });
      if (!res.ok) return setError(res.message);
      toast({ message: res.message });
      setOpen(false);
      router.refresh();
    });
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      trigger={<Button size="sm">Pause client</Button>}
      title={`Pause ${clientName}?`}
      description={`Nothing will be sent to payers or written to ${pm} until you resume.`}
      size="sm"
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={pending || (reason === 'Other' && !note.trim())}
            onClick={submit}
          >
            Pause client
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2 dense" style={{ gap: 12 }}>
          <div>
            <b>Keeps running</b>
            <p className="muted" style={{ margin: 0 }}>
              Syncing charges, claim status and payments; eligibility checks; the scrub.
            </p>
          </div>
          <div>
            <b>Stops</b>
            <p className="muted" style={{ margin: 0 }}>
              Releasing claims and writing corrections to {pm}. They wait and go out on resume.
            </p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="pause-reason">Reason</label>
          <select
            id="pause-reason"
            className="select"
            value={reason}
            onChange={(e) => setReason(e.target.value as (typeof state.PAUSE_REASONS)[number])}
          >
            {state.PAUSE_REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pause-note">Note{reason === 'Other' ? '' : ' (optional)'}</label>
          <textarea
            id="pause-note"
            className="textarea"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="pause-resume">Plan to resume on (optional)</label>
          <input
            id="pause-resume"
            className="input"
            type="date"
            value={resumeOn}
            onChange={(e) => setResumeOn(e.target.value)}
            style={{ width: 180 }}
          />
          <span className="help">A reminder on the client; resuming is still your decision.</span>
        </div>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </div>
    </Modal>
  );
}

export function ResumeClient({ clientId }: { clientId: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  return (
    <Button
      size="sm"
      variant="primary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await resumeClientAction(clientId);
          toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
          router.refresh();
        })
      }
    >
      Resume
    </Button>
  );
}
