'use client';
/**
 * W-13 Eligibility issue (DEC-30): the claim's coverage did not check out with the payer. Shows the
 * patient's coverages with each one's latest answer, and the ways out: check again, bill another
 * active coverage, correct the coverage (P-02), mark the visit self-pay, or open the patient. Each
 * fix that needs the PM says so before it is made, and leaves a task for it.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Button, Callout, ConfirmDialog, StatusChip, useToast } from '@cleanpost/ui';
import { CardUploadDialog } from '@/components/card-capture';
import { CoverageDialog } from '@/components/record-dialogs';
import { AAA_REASON, ELIGIBILITY_STATUS } from '@/lib/eligibility-display';
import { formatDate, formatWhen } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { checkEligibilityAction, markSelfPayAction, useOtherCoverageAction } from '../patients/actions';

const ORDER: Record<number, string> = { 1: 'Primary', 2: 'Secondary', 3: 'Tertiary' };

export function EligibilityPanel({
  claimId,
  eligibility: e,
  pmName,
  canEdit,
  onDone,
}: {
  claimId: string;
  eligibility: NonNullable<WorkDetail['eligibility']>;
  pmName: string;
  canEdit: boolean;
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [checking, setChecking] = useState(false);
  const [selfPay, setSelfPay] = useState(false);
  const toast = useToast();
  const router = useRouter();
  const current = e.coverages.find((c) => c.id === e.claimCoverageId) ?? null;
  const others = e.coverages.filter((c) => c.id !== e.claimCoverageId && c.latest?.status === 'active');
  const waitingOn = e.pmTasks;

  const run = (fn: () => Promise<{ ok: boolean; message: string }>, done = false) =>
    start(async () => {
      const res = await fn();
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok && done) onDone();
      router.refresh();
    });

  const checkAgain = () => {
    if (!current) return;
    setChecking(true);
    run(async () => {
      try {
        return await checkEligibilityAction(current.id);
      } finally {
        setChecking(false);
      }
    });
  };

  return (
    <div className="stack">
      {waitingOn.length > 0 && (
        <Callout>
          <b>Waiting for {pmName}.</b> {waitingOn.map((t) => t.title).join('; ')}. The claim goes on after a
          sync shows the change.
        </Callout>
      )}
      <div className="stack-sm">
        <span className="overline">Coverage</span>
        <ul className="stack-sm" style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Coverage">
          {e.coverages.map((c) => {
            const chk = c.latest;
            const isClaim = c.id === e.claimCoverageId;
            return (
              <li
                key={c.id}
                className="stack-sm"
                style={
                  isClaim ? { borderLeft: '3px solid var(--warning)', paddingLeft: 10 } : { paddingLeft: 13 }
                }
              >
                <div className="row-between" style={{ gap: 8 }}>
                  <b>
                    {c.payerName} · {ORDER[c.priority] ?? `priority ${c.priority}`}
                    {isClaim && <span className="muted dense"> · this claim</span>}
                  </b>
                  {checking && isClaim ? (
                    <span className="skeleton" style={{ width: 80 }} aria-label="Checking" />
                  ) : chk ? (
                    <StatusChip status={ELIGIBILITY_STATUS[chk.status] ?? 'Not confirmed'} />
                  ) : (
                    <span className="muted dense">Not checked</span>
                  )}
                </div>
                <span className="muted dense">
                  Member <span className="code">{c.memberIdMasked}</span>
                  {c.groupNumber && (
                    <>
                      {' '}
                      · group <span className="code">{c.groupNumber}</span>
                    </>
                  )}
                  {c.terminationDate ? ` · ends ${formatDate(c.terminationDate)}` : ''}
                  {chk ? ` · checked ${formatWhen(chk.requestedAt)}` : ''}
                  {c.source !== 'pm' ? ` · corrected in Cleanpost, not yet in ${pmName}` : ''}
                </span>
                {chk && chk.errorCodes.length > 0 && (
                  <span className="dense">
                    {chk.errorCodes.map((code) => (
                      <span key={code} style={{ marginRight: 8 }}>
                        <span className="codechip bad">{code}</span>{' '}
                        {AAA_REASON[code] ?? 'The payer rejected the inquiry'}
                      </span>
                    ))}
                  </span>
                )}
                {!isClaim && chk?.status === 'active' && canEdit && (
                  <div>
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => run(() => useOtherCoverageAction(claimId, c.id))}
                    >
                      Bill {c.payerName} instead
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {canEdit && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {current && (
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              aria-busy={checking || undefined}
              onClick={checkAgain}
            >
              {checking ? `Checking with ${current.payerName}…` : 'Check again'}
            </Button>
          )}
          {current && (
            <CoverageDialog
              coverage={current}
              payers={e.payers}
              pmName={pmName}
              trigger={
                <Button size="sm" disabled={pending}>
                  Update coverage
                </Button>
              }
            />
          )}
          <CardUploadDialog
            patientId={e.patientId}
            coverageId={current?.id ?? null}
            demo={e.demo}
            trigger={
              <Button size="sm" disabled={pending}>
                Upload card photo
              </Button>
            }
          />
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setSelfPay(true)}>
            Mark self-pay
          </Button>
          <Link className="btn btn-ghost btn-sm" href={`/patients/${e.patientId}`}>
            Open patient
          </Link>
        </div>
      )}
      {others.length === 0 && e.coverages.length > 1 && (
        <span className="muted dense">
          No other coverage is confirmed active; check it first to bill it instead.
        </span>
      )}
      <ConfirmDialog
        open={selfPay}
        onOpenChange={setSelfPay}
        title="Bill the patient instead?"
        description={`The insurance claim is voided in Cleanpost and a task asks you to set the visit to self-pay in ${pmName}.`}
        confirmLabel="Void and mark self-pay"
        danger
        onConfirm={() => {
          setSelfPay(false);
          run(() => markSelfPayAction(claimId), true);
        }}
      />
    </div>
  );
}
