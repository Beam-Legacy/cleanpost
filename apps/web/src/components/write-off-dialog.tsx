'use client';
/**
 * D-03 Write off denial (C-14 from a claim): reason, the client's PM write-off code, amount (the
 * denied amount by default; partial allowed), note. Bulk mode (admins, from D-01) shows the count
 * and total and writes off each denial's denied amount. Over the tenant's approval limit a biller
 * sees Request approval instead: an admin decides in the queue.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Modal, useToast } from '@cleanpost/ui';
import { bulkWriteOffAction, requestWriteOffAction, writeOffAction } from '@/app/(app)/work/actions';
import { formatMoney } from '@/lib/format';

/** The same list as packages/claims WRITE_OFF_REASONS (the server checks it). */
const REASONS = [
  'Not worth pursuing',
  'Timely filing missed',
  'Patient not covered and not billable',
  'Practice instruction',
  'Other',
] as const;
const NOTE_OVER_CENTS = 10_000;
const OTHER = '__other__';

export type WriteOffTarget =
  | {
      kind: 'one';
      claimId: string;
      itemId: string | null;
      /** One line about what is written off: category, patient, payer, claim. */
      label: string;
      deniedCents: number;
      balanceCents: number;
      /** A suggested correction exists and the person is writing off instead (recorded). */
      suggestionNotTaken?: boolean;
    }
  | { kind: 'bulk'; items: { itemId: string; amountCents: number }[] };

export function WriteOffDialog({
  target,
  pmName,
  pmCodes,
  limitCents,
  canOverLimit,
  onClose,
  onDone,
}: {
  target: WriteOffTarget;
  pmName: string;
  pmCodes: string[];
  limitCents: number;
  canOverLimit: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const one = target.kind === 'one' ? target : null;
  const defaultCents = one ? Math.max(0, Math.min(one.deniedCents, one.balanceCents)) : 0;
  const [amount, setAmount] = useState((defaultCents / 100).toFixed(2));
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [note, setNote] = useState('');
  const [code, setCode] = useState(pmCodes.includes('WO') ? 'WO' : (pmCodes[0] ?? OTHER));
  const [otherCode, setOtherCode] = useState(pmCodes.length ? '' : 'WO');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();

  const pmLabel = pmName === 'the PM' ? 'PM' : pmName;
  const cents = one ? Math.round(Number.parseFloat(amount) * 100) : 0;
  const bulkTotal = target.kind === 'bulk' ? target.items.reduce((s, i) => s + i.amountCents, 0) : 0;
  const largest = one
    ? cents
    : Math.max(0, ...(target.kind === 'bulk' ? target.items.map((i) => i.amountCents) : []));
  const noteNeeded = reason === 'Other' || largest > NOTE_OVER_CENTS;
  const pmCode = (code === OTHER ? otherCode : code).trim();
  const amountOk = !one || (Number.isFinite(cents) && cents > 0 && cents <= one.balanceCents);
  const overLimit = one !== null && cents > limitCents && !canOverLimit;
  const ready = amountOk && pmCode.length > 0 && (!noteNeeded || note.trim().length > 0);

  const submit = () =>
    start(async () => {
      const res =
        target.kind === 'bulk'
          ? await bulkWriteOffAction(
              target.items.map((i) => i.itemId),
              { reason, note, pmCode },
            )
          : await (overLimit ? requestWriteOffAction : writeOffAction)(target.claimId, {
              amountCents: cents,
              reason: reason as (typeof REASONS)[number],
              note,
              pmCode,
              itemId: target.itemId,
              suggestionNotTaken: target.suggestionNotTaken ?? false,
            });
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        onClose();
        onDone?.();
        router.refresh();
      }
    });

  const title =
    target.kind === 'bulk'
      ? `Write off ${target.items.length} ${target.items.length === 1 ? 'denial' : 'denials'}`
      : `Write off ${amountOk ? formatMoney(cents) : ''}`.trim();
  const action =
    target.kind === 'bulk'
      ? `Write off ${formatMoney(bulkTotal)}`
      : overLimit
        ? 'Request approval'
        : `Write off ${amountOk ? formatMoney(cents) : ''}`.trim();

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={
        target.kind === 'bulk'
          ? `${target.items.length} denied lines, ${formatMoney(bulkTotal)} in all: each denial's denied amount.`
          : one!.label
      }
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={overLimit ? 'primary' : 'danger'} disabled={pending || !ready} onClick={submit}>
            {action}
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <label className="field">
          <span className="label">Reason</span>
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        {pmCodes.length > 0 && (
          <label className="field">
            <span className="label">{pmLabel} write-off code</span>
            <select className="select" value={code} onChange={(e) => setCode(e.target.value)}>
              {pmCodes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
              <option value={OTHER}>Another code</option>
            </select>
          </label>
        )}
        {code === OTHER && (
          <label className="field">
            <span className="label">
              {pmCodes.length ? `Code as it is in ${pmName}` : `${pmLabel} write-off code`}
            </span>
            <input
              className="input"
              value={otherCode}
              maxLength={20}
              onChange={(e) => setOtherCode(e.target.value.replace(/[^A-Za-z0-9_.-]/g, ''))}
            />
          </label>
        )}
        {one && (
          <label className="field">
            <span className="label">
              Amount (denied {formatMoney(one.deniedCents)}, open balance {formatMoney(one.balanceCents)})
            </span>
            <input
              className="input"
              inputMode="decimal"
              value={amount}
              aria-invalid={!amountOk || undefined}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            />
          </label>
        )}
        <label className="field">
          <span className="label">Note{noteNeeded ? ' (required for “Other” and over $100)' : ''}</span>
          <textarea
            className="input"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {overLimit ? (
          <div className="callout dense">
            Over your approval limit of {formatMoney(limitCents)}: an admin approves or declines it, and you
            are told which.
          </div>
        ) : (
          <div className="callout dense" role="note">
            This writes the balance off in {pmName} (a task for a person there in Mode A) and cannot be undone
            from Cleanpost.
          </div>
        )}
      </div>
    </Modal>
  );
}
