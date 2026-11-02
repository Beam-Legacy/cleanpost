'use client';
/**
 * W-01 side panel, by item type: W-10 claim review, W-11 claim blocked, W-12 rejection, W-16
 * denial, W-17 to W-19 payments, W-21 manual task, W-23 connection problem, the write-off approval
 * (D-03), and a plain panel for types whose screens come later.
 * Codes only, never CPT descriptions (CLAUDE.md rule 11). AI text is labelled "Suggested".
 */
import Link from 'next/link';
import { CircleHelp, ExternalLink, X } from 'lucide-react';
import { isOneClickFix, work, type Finding } from '@cleanpost/domain';
import {
  Button,
  ConfidenceMeter,
  FindingRow,
  IconButton,
  Kbd,
  ModeBadge,
  StatusChip,
  Suggestion,
  type Status,
} from '@cleanpost/ui';
import { CLAIM_STATUS } from '@/lib/claim-display';
import { formatDate, formatMoney } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { ApprovalPanel } from './approval-panel';
import { LinkPayment } from './link-payment';
import { DenialPanel } from './denial-panel';
import { MappingForm } from './mapping-form';
import { PostingTask } from './posting-task';
import type { Permissions } from './work-queue';

const STEP_LABEL: Record<string, string> = {
  structural: 'Claim data',
  eligibility: 'Eligibility',
  codes: 'Codes',
  ncci: 'NCCI and units',
  payer: 'Payer rule',
  client: 'Client rule',
  history: 'History',
  ai: 'AI review',
};

const SCORE_NOTES: Record<string, { title: string; step: string }> = {
  first_claim_for_client_payer: { title: 'First claim for this client and payer', step: 'History' },
  payer_first_pass_below_90: { title: 'This payer accepted under 90% first time lately', step: 'History' },
  ai_concern: { title: 'The AI review raised a concern (see warnings)', step: 'AI review' },
};

/** Warnings with a fix that needs no choice: "Apply fix and release" applies them first. */
export function fixableFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'warn' && f.suggestedFix && isOneClickFix(f.suggestedFix));
}

export interface Primary {
  label: string;
  ruleIds: string[];
}

/** W-10's primary button, or none (blocked, not in review, or no permission). */
export function primaryAction(d: WorkDetail, can: Permissions): Primary | null {
  if (d.item.type !== 'claim_review' || !d.claim || !d.scrub || !can.release) return null;
  if (d.claim.status !== 'needs_review' && d.claim.status !== 'ready') return null;
  if (d.scrub.findings.some((f) => f.severity === 'block')) return null;
  const fixes = can.edit ? fixableFindings(d.scrub.findings).map((f) => f.ruleId) : [];
  if (fixes.length)
    return {
      label: fixes.length === 1 ? 'Apply fix and release' : 'Apply fixes and release',
      ruleIds: fixes,
    };
  const allInfo = d.scrub.findings.every((f) => f.severity === 'info');
  return { label: allInfo ? 'Release' : 'Approve and release', ruleIds: [] };
}

function deduction(f: Finding, deductions: { reason: string; points: number }[]) {
  const d = deductions.find((x) => x.reason === f.ruleId);
  return d && d.points > 0 ? ` · −${d.points}` : '';
}

function whyHere(d: WorkDetail): string {
  const c = d.claim;
  if (c?.correctionPending)
    return `Waiting for the change in ${d.connection?.pmName ?? 'the PM'}. Cleanpost releases the claim after the next sync shows it.`;
  switch (d.item.type) {
    case 'claim_review': {
      const first = d.scrub?.deductions.some((x) => x.reason === 'first_claim_for_client_payer');
      return first
        ? `In review because confidence is below this client's threshold of ${d.threshold}; the first claims to a payer always score lower until history builds up.`
        : `In review because confidence is below this client's threshold of ${d.threshold}.`;
    }
    case 'claim_blocked':
      return 'Blocked: release is unavailable while any blocking finding remains.';
    case 'rejection':
      return 'Rejected before adjudication, so the fix goes out as a new claim (frequency 1), not a replacement.';
    case 'manual_task':
      return `${d.connection?.pmName ?? 'The PM'} cannot do this through its API, so it is a task for a person.`;
    case 'sync_failure':
    case 'system':
      return 'Closes itself when the next sync succeeds.';
    case 'denial':
      return 'The payer denied all or part of this claim. The balance stays open until it is corrected and resubmitted, appealed or written off.';
    case 'posting_exception':
      return `${d.connection?.pmName ?? 'The PM'} posted this payment differently from the 835. Correct it in ${d.connection?.pmName ?? 'the PM'}; this closes itself when the next sync shows the posting matches.`;
    case 'out_of_balance':
      return 'The 835 does not add up, so nothing from it is checked or posted until the payer corrects it or an admin accepts the difference.';
    case 'remit_unmatched':
      return 'A payment in the 835 does not match any claim in Cleanpost; often a claim billed before this client went live.';
    case 'mapping_needed':
      return 'An adjustment code in an 835 has no matching code in the PM, so postings with it cannot be checked until an admin maps it.';
    default:
      return d.item.summary;
  }
}

export function WorkPanel({
  detail: d,
  can,
  pending,
  primary,
  onPrimary,
  onFix,
  onSnooze,
  onResolve,
  onAssign,
  onClose,
}: {
  detail: WorkDetail;
  can: Permissions;
  pending: boolean;
  primary: Primary | null;
  onPrimary: () => void;
  onFix: (ruleId: string) => void;
  onSnooze: () => void;
  onResolve: () => void;
  onAssign: () => void;
  onClose: () => void;
}) {
  const c = d.claim;
  const label = work.WORK_TYPE_LABEL[d.item.type as work.WorkItemType] ?? d.item.type;
  const chip: Status | null = c
    ? d.item.type === 'claim_blocked'
      ? 'Blocked'
      : (CLAIM_STATUS[c.status] ?? null)
    : d.item.type === 'sync_failure'
      ? 'Failed'
      : null;
  const findings = d.scrub?.findings ?? [];
  const ordered = [...findings].sort(
    (a, b) => ['block', 'warn', 'info'].indexOf(a.severity) - ['block', 'warn', 'info'].indexOf(b.severity),
  );
  const editable = c && ['needs_review', 'blocked', 'ready', 'built'].includes(c.status);
  // Deductions that are not findings of their own (docs/06 confidence formula).
  const extra = (d.scrub?.deductions ?? []).flatMap((x) => {
    const known = SCORE_NOTES[x.reason];
    return known ? [{ ...known, reason: x.reason, points: x.points }] : [];
  });

  return (
    <aside className="panel" aria-label={label} style={{ boxShadow: 'none', position: 'sticky', top: 16 }}>
      <div className="panel-head">
        <div className="row">
          {chip && <StatusChip status={chip} />}
          {!chip && <span className="tag">{label}</span>}
          {c && <ModeBadge mode={c.mode} long />}
          <span className="spacer" />
          {c && (
            <Link href={`/claims/${c.id}`} className="icon-btn ghost" aria-label="Open full claim">
              <ExternalLink aria-hidden />
            </Link>
          )}
          <IconButton label="Close panel" icon={<X />} ghost onClick={onClose} />
        </div>
        <h2>
          {c
            ? [c.patient, c.ageYears !== null ? `${c.ageYears} y` : null, formatDate(c.dateOfService)]
                .filter(Boolean)
                .join(' · ')
            : label}
        </h2>
        <div className="muted dense">
          {[d.clientName, c?.payerName].filter(Boolean).join(' · ')}
          {c?.pcn && (
            <>
              {' · '}
              <span className="code">{c.pcn}</span>
            </>
          )}
          {c && ` · ${formatMoney(c.totalChargeCents)}`}
        </div>
      </div>

      <div className="panel-body">
        {d.scrub && (d.item.type === 'claim_review' || d.item.type === 'claim_blocked') && (
          <>
            <ConfidenceMeter score={d.scrub.confidence} threshold={d.threshold} />
            {d.scrub.aiSummary && <Suggestion>{d.scrub.aiSummary}</Suggestion>}
            <div className="stack-sm">
              <span className="overline">Findings</span>
              {ordered.length === 0 && extra.length === 0 && <span className="muted">No findings.</span>}
              {ordered.map((f, i) => {
                const fix = f.suggestedFix;
                const oneClick = fix && isOneClickFix(fix) && can.edit && editable;
                const needsPm =
                  !fix && f.severity === 'block' && (f.step === 'structural' || f.step === 'eligibility');
                return (
                  <FindingRow
                    key={`${f.ruleId}-${i}`}
                    severity={f.severity}
                    title={f.message}
                    meta={`${STEP_LABEL[f.step] ?? f.step}${deduction(f, d.scrub!.deductions)}${needsPm ? ` · Fix in ${d.connection?.pmName ?? 'the PM'}` : ''}`}
                    action={
                      oneClick ? (
                        <Button size="sm" disabled={pending} onClick={() => onFix(f.ruleId)}>
                          Apply fix
                        </Button>
                      ) : fix && can.edit && editable ? (
                        <Button size="sm" asChild>
                          <Link href={`/claims/${c!.id}?edit=1`}>Open editor</Link>
                        </Button>
                      ) : undefined
                    }
                  />
                );
              })}
              {extra.map((x) => (
                <FindingRow
                  key={x.reason}
                  severity="info"
                  title={x.title}
                  meta={`${x.step} · −${x.points}`}
                />
              ))}
            </div>
          </>
        )}

        {c && c.lines.length > 0 && (
          <table className="table" aria-label="Claim lines">
            <thead>
              <tr>
                <th>#</th>
                <th>Code</th>
                <th>Mod</th>
                <th className="num">Units</th>
                <th>Dx</th>
                <th className="num">Charge</th>
              </tr>
            </thead>
            <tbody>
              {c.lines.map((l) => (
                <tr key={l.lineNumber} className={l.flagged ? 'row-warn' : undefined}>
                  <td>{l.lineNumber}</td>
                  <td className="code">{l.code}</td>
                  <td>{l.modifiers.length ? l.modifiers.join(', ') : '—'}</td>
                  <td className="num">{l.units}</td>
                  <td className="code">
                    {l.dxPointers.map((p) => c.diagnoses[p - 1]?.icd10 ?? p).join(', ') || '—'}
                  </td>
                  <td className="num">{formatMoney(l.chargeCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {d.item.type === 'rejection' && (
          <div className="stack-sm">
            <span className="overline">Reason</span>
            <div>{d.item.summary.replace(/^Rejected: /, '')}</div>
            <div className="muted dense">
              Correct the claim in {d.connection?.pmName ?? 'the PM'} and resubmit it from there; Cleanpost
              tracks the new submission on the next sync.
            </div>
          </div>
        )}

        {d.item.type === 'manual_task' && d.manualTask && (
          <div className="stack-sm">
            <span className="overline">{d.manualTask.title}</span>
            <ol className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>
              {d.manualTask.instructions
                .filter((s) => !s.startsWith('Worksheet:'))
                .map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
            </ol>
            {d.manualTask.instructions.some((s) => s.startsWith('Worksheet:')) && (
              <>
                <span className="overline">Worksheet</span>
                <ul className="stack-sm" style={{ paddingLeft: 18, margin: 0 }}>
                  {d.manualTask.instructions
                    .filter((s) => s.startsWith('Worksheet:'))
                    .map((s, i) => (
                      <li key={i}>{s.replace(/^Worksheet: /, '')}</li>
                    ))}
                </ul>
              </>
            )}
          </div>
        )}

        {d.item.type === 'manual_task' &&
          d.item.reasonCode === 'postPayment' &&
          d.item.status !== 'resolved' &&
          can.resolve && <PostingTask itemId={d.item.id} pmName={d.connection?.pmName ?? 'the PM'} />}

        {(d.item.type === 'sync_failure' || d.item.type === 'system') && (
          <div className="stack-sm">
            <div>{d.item.summary}</div>
            {d.connection && (
              <div className="muted dense">
                Connection to {d.connection.pmName}: {d.connection.status}.
              </div>
            )}
            {!can.admin && <div className="muted dense">An admin has been notified.</div>}
          </div>
        )}

        {d.remittance && (
          <div className="stack-sm">
            <span className="overline">Payment</span>
            <div>{d.item.summary}</div>
            <div className="muted dense">
              {d.remittance.payerName} · trace <span className="code">{d.remittance.traceNumber}</span> ·{' '}
              {formatMoney(d.remittance.amountCents)} · {formatDate(d.remittance.paymentDate)}
            </div>
            {d.item.type === 'denial' && d.denial && d.claim && (
              <DenialPanel
                itemId={d.item.id}
                claimId={d.claim.id}
                denial={d.denial}
                canCorrect={can.edit}
                canOverLimit={can.admin}
                label={[d.claim.patient, d.claim.payerName, d.claim.pcn].filter(Boolean).join(' · ')}
              />
            )}
            <div>
              <Link className="btn btn-secondary btn-sm" href={`/remittances/${d.remittance.id}`}>
                Open remittance
              </Link>
            </div>
            {d.item.type === 'remit_unmatched' && d.linkCandidates && can.resolve && (
              <LinkPayment itemId={d.item.id} candidates={d.linkCandidates} />
            )}
            {d.item.type === 'mapping_needed' && d.item.status !== 'resolved' && can.admin && (
              <MappingForm
                itemId={d.item.id}
                pair={d.item.reasonCode}
                pmName={d.connection?.pmName ?? 'the PM'}
                clientName={d.clientName}
              />
            )}
          </div>
        )}

        {d.item.type === 'write_off_approval' && d.writeOffRequest && (
          <ApprovalPanel
            itemId={d.item.id}
            request={d.writeOffRequest}
            balanceCents={c?.balanceCents ?? null}
            canDecide={can.admin}
            onDone={onClose}
          />
        )}

        {!d.remittance &&
          ![
            'claim_review',
            'claim_blocked',
            'rejection',
            'manual_task',
            'sync_failure',
            'system',
            'write_off_approval',
          ].includes(d.item.type) && <div>{d.item.summary}</div>}

        <div className="why">
          <CircleHelp aria-hidden />
          <span>{whyHere(d)}</span>
        </div>
      </div>

      <div className="panel-foot">
        {primary && (
          <Button variant="primary" disabled={pending} onClick={onPrimary}>
            {primary.label} <Kbd>A</Kbd>
          </Button>
        )}
        {c && can.edit && editable && (
          <Button asChild>
            <Link href={`/claims/${c.id}?edit=1`}>
              Edit <Kbd>E</Kbd>
            </Link>
          </Button>
        )}
        {(d.item.type === 'sync_failure' || d.item.type === 'system') && can.admin && d.connection && (
          <Button asChild>
            <Link href={`/integrations/${d.connection.id}`}>View connection</Link>
          </Button>
        )}
        {can.resolve && (
          <>
            <Button disabled={pending} onClick={onSnooze}>
              Snooze <Kbd>S</Kbd>
            </Button>
            {!work.DECIDED_TYPES.includes(d.item.type as work.WorkItemType) && (
              <Button disabled={pending} onClick={onResolve}>
                Resolve <Kbd>R</Kbd>
              </Button>
            )}
            <Button variant="ghost" disabled={pending} onClick={onAssign}>
              {d.item.assigneeId ? 'Reassign' : 'Assign'}
            </Button>
          </>
        )}
        <span className="spacer" />
        {c && (
          <Link href={`/claims/${c.id}`} className="dense">
            Full claim
          </Link>
        )}
      </div>
    </aside>
  );
}
