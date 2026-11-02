'use client';
/** C-13 Void claim and C-16 Add note. */
import { useState, useTransition } from 'react';
import { Button, Modal, useToast } from '@cleanpost/ui';
import { addNoteAction, holdAction, releaseHoldAction, voidClaimAction } from './actions';

const VOID_REASONS = ['Duplicate', 'Entered in error', 'Patient will pay', 'Not billable', 'Other'];

export function VoidClaimButton({ claimId, pmName }: { claimId: string; pmName: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  const ready = Boolean(reason) && (reason !== 'Other' || note.trim().length > 0);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Void
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Void claim"
        size="sm"
        description="This claim was never sent. Voiding removes it from the queue."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={!ready || pending}
              onClick={() =>
                start(async () => {
                  const res = await voidClaimAction(claimId, reason, note.trim() || null);
                  toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
                  if (res.ok) setOpen(false);
                })
              }
            >
              Void claim
            </Button>
          </>
        }
      >
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Reason</legend>
          {VOID_REASONS.map((r) => (
            <label key={r} className="check">
              <input type="radio" name="void-reason" checked={reason === r} onChange={() => setReason(r)} />
              <span>{r}</span>
            </label>
          ))}
        </fieldset>
        <label className="field" style={{ marginTop: 12 }}>
          <span className="label">Note{reason === 'Other' ? ' (required for Other)' : ' (optional)'}</span>
          <textarea
            className="textarea"
            rows={2}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <p className="muted dense" style={{ marginTop: 12 }}>
          The charge stays in {pmName}. Reject or void the encounter there too, so {pmName} never bills it.
        </p>
      </Modal>
    </>
  );
}

export function AddNote({ claimId }: { claimId: string }) {
  const [text, setText] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  const submit = () =>
    start(async () => {
      const res = await addNoteAction(claimId, text);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) setText('');
    });
  return (
    <div className="stack-sm">
      <label className="field">
        <span className="label">Add a note</span>
        <textarea
          className="textarea"
          rows={2}
          value={text}
          maxLength={2000}
          placeholder="A call, a decision, what happens next. Only this claim's details."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) submit();
          }}
        />
      </label>
      <div>
        <Button size="sm" disabled={!text.trim() || pending} onClick={submit}>
          Add note
        </Button>
      </div>
    </div>
  );
}

const HOLD_REASONS = [
  'Waiting for records',
  'Waiting for prior authorization',
  'Waiting for coverage information',
  'Provider credentialing',
  'Other',
];

/** C-12 Hold claim, or Release hold when it is on hold. */
export function HoldButton({ claimId, onHold }: { claimId: string; onHold: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  if (onHold)
    return (
      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await releaseHoldAction(claimId);
            toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
          })
        }
      >
        Release hold
      </Button>
    );
  const ready = Boolean(reason) && (reason !== 'Other' || note.trim().length > 0);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Hold</Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Hold claim"
        size="sm"
        description="A held claim is not released until you release the hold."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!ready || pending}
              onClick={() =>
                start(async () => {
                  const res = await holdAction(claimId, reason, until || null, note.trim() || null);
                  toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
                  if (res.ok) setOpen(false);
                })
              }
            >
              Hold claim
            </Button>
          </>
        }
      >
        <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Reason</legend>
          {HOLD_REASONS.map((r) => (
            <label key={r} className="check">
              <input type="radio" name="hold-reason" checked={reason === r} onChange={() => setReason(r)} />
              <span>{r}</span>
            </label>
          ))}
        </fieldset>
        <label className="field" style={{ marginTop: 12 }}>
          <span className="label">Remind me on (optional)</span>
          <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <label className="field" style={{ marginTop: 12 }}>
          <span className="label">Note{reason === 'Other' ? ' (required for Other)' : ' (optional)'}</span>
          <textarea
            className="textarea"
            rows={2}
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </Modal>
    </>
  );
}
