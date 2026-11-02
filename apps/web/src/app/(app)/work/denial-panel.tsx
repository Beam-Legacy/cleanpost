'use client';
/**
 * W-16 Panel: denial. Per denied line: the category, the code explained, what to do and why (rules,
 * labeled as a suggestion), then Build correction (C-09 opens with the fix applied) or Write off
 * (D-03, shared with D-02). A correction already on its way shows instead of the actions.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { remit } from '@cleanpost/domain';
import { Button, useToast } from '@cleanpost/ui';
import { CodeChip } from '@/components/code-chip';
import { WriteOffDialog } from '@/components/write-off-dialog';
import { formatMoney, formatWhen } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { buildCorrectionFromItem } from './actions';

export function DenialPanel({
  itemId,
  claimId,
  denial,
  canCorrect,
  canOverLimit,
  label,
}: {
  itemId: string;
  claimId: string;
  denial: NonNullable<WorkDetail['denial']>;
  canCorrect: boolean;
  /** Admins write off above the tenant's approval limit; billers request approval. */
  canOverLimit: boolean;
  /** One line about the denial for the write-off dialog. */
  label: string;
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
            disabled={pending || denial.balanceCents <= 0 || Boolean(denial.pendingRequest)}
            onClick={() => setWriteOff(true)}
          >
            Write off
          </Button>
        )}
      </div>
      {denial.pendingRequest && (
        <div className="callout dense" role="status">
          A write-off of {formatMoney(denial.pendingRequest.amountCents)} is waiting for an admin (asked by{' '}
          {denial.pendingRequest.requestedByName ?? 'a biller'}, {formatWhen(denial.pendingRequest.createdAt)}
          ).
        </div>
      )}
      {writeOff && (
        <WriteOffDialog
          target={{
            kind: 'one',
            claimId,
            itemId,
            label: [first ? remit.DENIAL_KIND_LABEL[first.advice.kind] : 'Denial', label]
              .filter(Boolean)
              .join(' · '),
            deniedCents: denial.deniedCents,
            balanceCents: denial.balanceCents,
            suggestionNotTaken: Boolean(first?.advice.primary === 'correct' && first.advice.suggestion),
          }}
          pmName={denial.writeOff.pmName}
          pmCodes={denial.writeOff.pmCodes}
          limitCents={denial.writeOff.limitCents}
          canOverLimit={canOverLimit}
          onClose={() => setWriteOff(false)}
        />
      )}
    </div>
  );
}
