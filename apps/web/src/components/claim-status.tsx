'use client';
/**
 * C-15 Status check result, and the pieces W-15 reuses: Check status (a 276, up to 15 seconds),
 * the answer in plain words with its codes, the suggested next step (rules, labelled Suggested),
 * and Create task where the answer implies one.
 */
import { nowMs } from '@cleanpost/clock';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { claimStatus } from '@cleanpost/domain';
import { Button, Drawer, SkeletonRows, StatusChip, Suggestion, useToast } from '@cleanpost/ui';
import { checkStatusAction, createStatusTaskAction } from '@/app/(app)/claims/status-actions';
import { CLAIM_STATUS } from '@/lib/claim-display';
import { formatDate, formatMoney, formatWhen } from '@/lib/format';
import type { StatusView } from '@/lib/queries/claim-status';

export function CheckStatusButton({
  view,
  after,
  variant = 'secondary',
}: {
  view: StatusView;
  /** Open the result (claim page) or refresh in place (work panel). */
  after: 'open' | 'refresh';
  variant?: 'primary' | 'secondary';
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  if (!view.canCheck) return null;
  const limited = view.manualAfter && view.manualAfter.getTime() > nowMs();
  const reason = !view.configured
    ? 'Status checks are not set up here yet.'
    : limited
      ? `Checked today; next check after ${formatWhen(view.manualAfter)}.`
      : null;
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={pending || Boolean(reason)}
      title={reason ?? undefined}
      aria-busy={pending || undefined}
      onClick={() =>
        start(async () => {
          const res = await checkStatusAction(view.claimId);
          toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
          if (res.checked && after === 'open')
            router.push(`/claims/${view.claimId}?status=last`, { scroll: false });
          else router.refresh();
        })
      }
    >
      {pending ? `Checking with ${view.payerName}…` : 'Check status'}
    </Button>
  );
}

export function CreateStatusTaskButton({ view }: { view: StatusView }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const task = view.last?.advice.task;
  if (!task || view.taskOpen) return null;
  return (
    <Button
      variant="primary"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await createStatusTaskAction(view.claimId);
          toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
          router.refresh();
        })
      }
    >
      {task.operation === 'requestRecords' ? 'Create records request task' : 'Create resubmission task'}
    </Button>
  );
}

/** The latest answer in plain words, its codes, and what to do next. */
export function StatusResult({ view, checking }: { view: StatusView; checking?: boolean }) {
  if (checking) return <SkeletonRows rows={3} label={`Checking with ${view.payerName}`} />;
  const last = view.last;
  if (!last)
    return (
      <p className="muted dense" style={{ margin: 0 }}>
        No status check yet. {view.canCheck ? `Check status asks ${view.payerName} what it has.` : ''}
      </p>
    );
  const r = last.result;
  const kind = last.advice.kind;
  return (
    <div className="stack-sm">
      <div>
        <b>{last.advice.headline}</b> <span className="muted dense">{last.advice.explanation}</span>
      </div>
      <dl className="kv dense">
        <dt>Status category</dt>
        <dd>
          <span className="code">{r.category}</span> {claimStatus.categoryLabel(r.category)}
        </dd>
        {r.code && (
          <>
            <dt>Status</dt>
            <dd>
              <span className="code">{r.code}</span> {claimStatus.statusCodeLabel(r.code)}
            </dd>
          </>
        )}
        {r.payerClaimNumber && (
          <>
            <dt>Payer claim number</dt>
            <dd className="code">{r.payerClaimNumber}</dd>
          </>
        )}
        {r.effectiveDate && (
          <>
            <dt>Effective</dt>
            <dd>{formatDate(r.effectiveDate)}</dd>
          </>
        )}
        {r.submittedCents !== null && (
          <>
            <dt>Billed</dt>
            <dd className="num">{formatMoney(r.submittedCents)}</dd>
          </>
        )}
        {(kind === 'paid' || kind === 'denied') && (
          <>
            <dt>Paid</dt>
            <dd className="num">
              {formatMoney(r.paidCents ?? 0)}
              {r.checkNumber ? (
                <>
                  {' '}
                  · <span className="code">{r.checkNumber}</span>
                </>
              ) : null}
            </dd>
          </>
        )}
      </dl>
      <span className="muted dense">
        Checked {formatWhen(last.at)} via {last.source === 'stedi' ? 'Stedi' : 'the payer simulator'}
        {last.trigger === 'manual' ? '' : ' (automatic check)'}.
      </span>
      {last.advice.suggestion && <Suggestion>{last.advice.suggestion}</Suggestion>}
    </div>
  );
}

/** C-15: the latest status check of a claim, opened after a check or from the claim summary. */
export function StatusDrawer({ view, closeHref }: { view: StatusView; closeHref: string }) {
  const router = useRouter();
  const status = CLAIM_STATUS[view.claimStatus];
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && router.push(closeHref, { scroll: false })}
      title="Status check"
      description={[view.patient, view.payerName, view.pcn].filter(Boolean).join(' · ')}
      footer={
        <>
          <Button onClick={() => router.push(closeHref, { scroll: false })}>Close</Button>
          <span className="spacer" />
          <CheckStatusButton view={view} after="refresh" />
          <CreateStatusTaskButton view={view} />
        </>
      }
    >
      <div className="stack">
        {status && (
          <div className="row">
            <StatusChip status={status} />
          </div>
        )}
        <StatusResult view={view} />
        <span className="muted dense">
          {view.nextAutoCheck
            ? `Next automatic check: ${formatDate(view.nextAutoCheck.toISOString().slice(0, 10))}. `
            : ''}
          Manual checks are limited to one a day per claim.
        </span>
      </div>
    </Drawer>
  );
}
