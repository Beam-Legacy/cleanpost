'use client';
/**
 * W-16 Panel: denial. Per denied line: the category, the code explained, what to do and why (rules,
 * labeled as a suggestion), then Build correction (C-09 opens with the fix applied) or Write off
 * (C-14). A correction already on its way shows instead of the actions.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { remit } from '@cleanpost/domain';
import { Button, Modal, useToast } from '@cleanpost/ui';
import { CodeChip } from '@/components/code-chip';
import { formatMoney } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { buildCorrectionFromItem, writeOffAction } from './actions';

const REASONS = [
  'Not worth pursuing',
  'Timely filing missed',
  'Patient not covered and not billable',
  'Practice instruction',
  'Other',
] as const;

export function DenialPanel({
  itemId,
  claimId,
  denial,
  canCorrect,
}: {
  itemId: string;
  claimId: string;
  denial: NonNullable<WorkDetail['denial']>;
  canCorrect: boolean;
}) {
  const [pending, start] = useTransition();
  const [writeOff, setWriteOff] = useState(false);
  const toast = useToast();
  const router = useRouter();
  const correct = (lineNumber: number | null) =>
    start(async () => {
      const res = await buildCorrectionFromItem(itemId, lineNumber);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok && res.claimId) router.push(`/claims/${res.claimId}?edit=1`);
    });

  if (denial.inFlight)
    return (
      <div className="callout stack-sm">
        <span>
          A corrected claim for this denial is on its way. This item closes when the payer accepts it.
        </span>
        <div>
          <Link className="btn btn-secondary btn-sm" href={`/claims/${claimId}`}>
            See its status
          </Link>
        </div>
      </div>
    );

  const first = denial.advice[0];
  return (
    <div className="stack-sm">
      {denial.advice.map((a) => (
        <div key={`${a.lineNumber}-${a.carc}`} className="stack-sm">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="chip chip-outline">{remit.DENIAL_KIND_LABEL[a.advice.kind]}</span>
            <span>
              Line {a.lineNumber} <span className="code">{a.code}</span> denied {formatMoney(a.amountCents)}
            </span>
            <CodeChip code={`${a.group}-${a.carc}`} bad />
          </div>
          <p className="dense" style={{ margin: 0 }}>
            <span className="overline">Suggested</span> {a.advice.explanation}
          </p>
          {a.advice.suggestion && (
            <div className="callout dense">
              <b>{a.advice.suggestion.label}</b>
              {a.advice.suggestion.needsInput ? ' (in the editor)' : ''}
            </div>
          )}
        </div>
      ))}
      {denial.payerClaimNumber && (
        <span className="muted dense">
          Payer claim number <span className="code">{denial.payerClaimNumber}</span> (a corrected claim
          references it)
        </span>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {canCorrect && first && first.advice.primary === 'correct' && (
          <Button
            variant="primary"
            size="sm"
            disabled={pending || !denial.payerClaimNumber}
            onClick={() => correct(first.lineNumber)}
          >
            {first.advice.suggestion && !first.advice.suggestion.needsInput
              ? 'Build correction with this fix'
              : 'Build correction'}
          </Button>
        )}
        {first?.advice.primary === 'check_coverage' && (
          <Link className="btn btn-primary btn-sm" href={`/claims/${claimId}?tab=patient`}>
            Check coverage
          </Link>
        )}
        {canCorrect && (
          <Button
            variant={first?.advice.primary === 'write_off' ? 'primary' : 'secondary'}
            size="sm"
            disabled={pending || denial.balanceCents <= 0}
            onClick={() => setWriteOff(true)}
          >
            Write off
          </Button>
        )}
      </div>
      {writeOff && (
        <WriteOffDialog
          claimId={claimId}
          balanceCents={denial.balanceCents}
          onClose={() => setWriteOff(false)}
        />
      )}
    </div>
  );
}

/** C-14 Write off balance: amount (up to the balance), reason, note, the PM's adjustment code. */
function WriteOffDialog({
  claimId,
  balanceCents,
  onClose,
}: {
  claimId: string;
  balanceCents: number;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2));
  const [reason, setReason] = useState<string>(REASONS[0]);
  const [note, setNote] = useState('');
  const [pmCode, setPmCode] = useState('WO');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const cents = Math.round(Number.parseFloat(amount) * 100);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Write off balance"
      description="Writes the amount off in the PM (a task for a person in Mode A). This cannot be undone here."
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={pending || !Number.isFinite(cents) || cents <= 0 || cents > balanceCents}
            onClick={() =>
              start(async () => {
                const res = await writeOffAction(claimId, { amountCents: cents, reason, note, pmCode });
                toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
                if (res.ok) {
                  onClose();
                  router.refresh();
                }
              })
            }
          >
            Write off {Number.isFinite(cents) && cents > 0 ? formatMoney(cents) : ''}
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        <label className="field">
          <span className="label">Amount (open balance {formatMoney(balanceCents)})</span>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </label>
        <label className="field">
          <span className="label">Reason</span>
          <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="label">Note (needed for “Other” and over $100)</span>
          <textarea
            className="input"
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">PM adjustment code</span>
          <input
            className="input"
            value={pmCode}
            maxLength={20}
            onChange={(e) => setPmCode(e.target.value)}
          />
        </label>
      </div>
    </Modal>
  );
}
