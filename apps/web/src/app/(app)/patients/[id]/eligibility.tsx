'use client';
/**
 * P-01 Check eligibility again and P-03 Eligibility result: a 270 per coverage (billed per check:
 * a second check within the hour asks first), and the 271 in plain terms. Missing values say
 * "Not returned by payer".
 */
import { nowMs } from '@cleanpost/clock';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Drawer, StatusChip, useToast } from '@cleanpost/ui';
import { ELIGIBILITY_STATUS } from '@/lib/eligibility-display';
import { formatDate, formatMoney, formatWhen } from '@/lib/format';
import type { CoverageView, EligibilityView } from '@/lib/queries/patients';
import { checkEligibilityAction } from '../actions';

const HOUR = 3_600_000;

export function CheckEligibilityButton({
  coverage,
  patientId,
  variant = 'secondary',
  label = 'Check eligibility again',
}: {
  coverage: CoverageView;
  patientId: string;
  variant?: 'primary' | 'secondary';
  label?: string;
}) {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();
  const router = useRouter();
  const recent = coverage.latest && nowMs() - new Date(coverage.latest.requestedAt).getTime() < HOUR;
  const run = () =>
    start(async () => {
      setConfirm(false);
      const res = await checkEligibilityAction(coverage.id);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.checkId) router.push(`/patients/${patientId}?eligibility=${res.checkId}`, { scroll: false });
      else router.refresh();
    });
  if (confirm)
    return (
      <span className="row" style={{ gap: 6 }} role="group" aria-label="Check again">
        <span className="dense">
          Checked {formatWhen(coverage.latest!.requestedAt)}; each check is billed.
        </span>
        <Button size="sm" variant="primary" disabled={pending} onClick={run}>
          Check anyway
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
          Cancel
        </Button>
      </span>
    );
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() => (recent ? setConfirm(true) : run())}
    >
      {pending ? `Checking with ${coverage.payerName}…` : label}
    </Button>
  );
}

const value = (v: string | null) => v ?? 'Not returned by payer';

/** P-03: the latest (or a chosen) 271 for a coverage. */
export function EligibilityDrawer({
  patientLabel,
  patientId,
  coverage,
  check,
  others,
  closeHref,
}: {
  patientLabel: string;
  patientId: string;
  coverage: CoverageView;
  check: EligibilityView;
  /** The patient's other coverages checked at about the same time. */
  others: CoverageView[];
  closeHref: string;
}) {
  const router = useRouter();
  const status = ELIGIBILITY_STATUS[check.status] ?? 'Not confirmed';
  return (
    <Drawer
      open
      onOpenChange={(o) => !o && router.push(closeHref, { scroll: false })}
      title="Eligibility"
      description={`${patientLabel} · ${coverage.payerName} · checked ${formatWhen(check.requestedAt)}`}
      footer={
        <>
          <Button onClick={() => router.push(closeHref, { scroll: false })}>Close</Button>
          <span className="spacer" />
          <CheckEligibilityButton coverage={coverage} patientId={patientId} label="Check again" />
        </>
      }
    >
      <div className="stack">
        <div className="row" style={{ gap: 8 }}>
          <StatusChip status={status} />
          {check.status === 'inactive' && check.planEnd && (
            <span>Coverage ended {formatDate(check.planEnd)}</span>
          )}
        </div>
        {check.status === 'error' || check.status === 'unknown' ? (
          <p style={{ margin: 0 }}>
            {coverage.payerName} could not confirm this coverage
            {check.errorCodes.length ? ` (code ${check.errorCodes.join(', ')})` : ''}. Check the member ID and
            the patient’s details, then check again.
          </p>
        ) : null}
        <dl className="kv">
          <dt>Coverage dates</dt>
          <dd>
            {check.planBegin || check.planEnd
              ? `${check.planBegin ? formatDate(check.planBegin) : '…'} – ${check.planEnd ? formatDate(check.planEnd) : 'open'}`
              : value(null)}
          </dd>
          <dt>Copay, office visit</dt>
          <dd className="num">{check.copayCents === null ? value(null) : formatMoney(check.copayCents)}</dd>
          <dt>Deductible remaining</dt>
          <dd className="num">
            {check.deductibleRemainingCents === null
              ? value(null)
              : formatMoney(check.deductibleRemainingCents)}
          </dd>
          <dt>Coinsurance</dt>
          <dd className="num">
            {check.coinsurancePercent === null ? value(null) : `${check.coinsurancePercent}%`}
          </dd>
        </dl>
        {others
          .filter((o) => o.latest)
          .map((o) => (
            <span key={o.id} className="muted dense">
              {o.payerName}: {o.latest!.status === 'active' ? 'active' : 'not active'} (checked{' '}
              {formatWhen(o.latest!.requestedAt)}).
            </span>
          ))}
      </div>
    </Drawer>
  );
}
