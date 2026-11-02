import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { z } from 'zod';
import { policy, work } from '@cleanpost/domain';
import {
  Banner,
  ConfidenceMeter,
  DueChip,
  EmptyState,
  FindingRow,
  KeyValue,
  ModeBadge,
  StatusChip,
  Suggestion,
  Timeline,
} from '@cleanpost/ui';
import { actorLabel, CLAIM_STATUS, describeEvent, FREQUENCY_LABEL } from '@/lib/claim-display';
import { formatDate, formatMoney, formatWhen } from '@/lib/format';
import { getClaim, getClaimCoverage, type ClaimDetail } from '@/lib/queries/claims';
import { getClaimPayments } from '@/lib/queries/remittances';
import { lineResult } from '@/lib/remit-display';
import { requireActiveContext } from '@/lib/session';
import { ClaimActions } from './claim-actions';
import { AddNote, HoldButton, VoidClaimButton } from './claim-more';
import { RevealField } from './reveal-field';
import { ClaimEditor } from './claim-editor';

export const metadata: Metadata = { title: 'Claim' };

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'lines', label: 'Lines' },
  { key: 'payments', label: 'Payments' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'versions', label: 'Versions' },
  { key: 'patient', label: 'Patient and coverage' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const EDITABLE = ['built', 'needs_review', 'blocked', 'ready'];

/** C-02 to C-05 Claim detail, and C-08 the editor (?edit=1). */
export default async function ClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const sp = await searchParams;
  const d = await getClaim(ctx, id);
  if (!d) notFound();
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : 'summary';
  const c = d.claim;
  const canEdit =
    policy.authorize(ctx.actor, 'claim.edit', { clientId: c.clientId }).allowed &&
    EDITABLE.includes(c.status);
  const canRelease =
    policy.authorize(ctx.actor, 'claim.release', { clientId: c.clientId }).allowed &&
    (c.status === 'needs_review' || c.status === 'ready') &&
    !d.scrub?.findings.some((f) => f.severity === 'block') &&
    !d.correctionPending;
  const now = new Date();
  const deadlineDays = c.filingDeadline
    ? Math.ceil((Date.parse(`${c.filingDeadline}T00:00:00Z`) - now.getTime()) / 86_400_000)
    : null;
  const editing = sp.edit === '1' && canEdit;
  const canNote = policy.authorize(ctx.actor, 'work.resolve', { clientId: c.clientId }).allowed;

  return (
    <>
      <Link className="breadcrumb" href="/claims">
        <ArrowLeft aria-hidden />
        Claims
      </Link>
      <div className="card card-body stack">
        <div className="row-between">
          <div className="stack-sm">
            <div className="row">
              {CLAIM_STATUS[c.status] && <StatusChip status={CLAIM_STATUS[c.status]!} />}
              <ModeBadge mode={c.mode as 'A' | 'B' | 'C'} long />
              <span className="code muted">
                {[c.patientControlNumber, `v${d.versionNumber}`, `freq ${d.payload.frequencyCode}`]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <h1 className="title-l">
              {d.patient}
              {d.ageYears !== null ? ` · ${d.ageYears} y` : ''} · DOS {formatDate(d.payload.dateOfService)}
            </h1>
            <div className="muted dense">
              {d.clientName} · {d.payerName ?? 'No payer'}
              {d.renderingNpi && (
                <>
                  {' · rendering NPI '}
                  <span className="code">{d.renderingNpi}</span>
                </>
              )}
              {d.payload.facility?.placeOfService && (
                <>
                  {' · POS '}
                  <span className="code">{d.payload.facility.placeOfService}</span>
                </>
              )}
            </div>
          </div>
          {!editing && (
            <div className="row">
              <ClaimActions
                claimId={c.id}
                canRelease={canRelease}
                canEdit={canEdit}
                inReview={c.status === 'needs_review'}
              />
              {(canEdit || c.status === 'on_hold') &&
                policy.authorize(ctx.actor, 'claim.edit', { clientId: c.clientId }).allowed && (
                  <HoldButton claimId={c.id} onHold={c.status === 'on_hold'} />
                )}
              {canEdit && <VoidClaimButton claimId={c.id} pmName={d.pmName} />}
            </div>
          )}
        </div>
        <dl className="dl" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          <div>
            <dt>Charge</dt>
            <dd className="fig">{formatMoney(c.totalChargeCents)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd className="fig">—</dd>
          </div>
          <div>
            <dt>Patient responsibility</dt>
            <dd className="fig">—</dd>
          </div>
          <div>
            <dt>Open balance</dt>
            <dd className="fig">{formatMoney(c.balanceCents)}</dd>
          </div>
          <div>
            <dt>Filing deadline</dt>
            <dd
              className="fig"
              style={deadlineDays !== null && deadlineDays <= 14 ? { color: 'var(--warning)' } : undefined}
            >
              {formatDate(c.filingDeadline)}
            </dd>
          </div>
        </dl>
      </div>

      {deadlineDays !== null &&
        deadlineDays <= 14 &&
        !['submitted', 'accepted', 'paid', 'closed', 'voided'].includes(c.status) && (
          <Banner tone="warn">
            <b>Filing deadline in {Math.max(0, deadlineDays)} days.</b> Release or correct this claim before{' '}
            {formatDate(c.filingDeadline)}.
          </Banner>
        )}
      {d.correctionPending && (
        <Banner tone="info">
          <b>Waiting for the change in {d.pmName}.</b> Cleanpost releases the claim after the next sync shows
          it.
        </Banner>
      )}

      {editing ? (
        <ClaimEditor
          claimId={c.id}
          versionId={d.versionId}
          payload={d.payload}
          threshold={d.threshold}
          initial={
            d.scrub
              ? { confidence: d.scrub.confidence, findings: d.scrub.findings, deductions: d.scrub.deductions }
              : null
          }
          mode={c.mode as 'A' | 'B' | 'C'}
          pmName={d.pmName}
          canRelease={policy.authorize(ctx.actor, 'claim.release', { clientId: c.clientId }).allowed}
        />
      ) : (
        <>
          <nav className="tabs" aria-label="Claim sections">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key === 'summary' ? `/claims/${c.id}` : `/claims/${c.id}?tab=${t.key}`}
                className={t.key === tab ? 'active' : undefined}
                aria-current={t.key === tab ? 'page' : undefined}
              >
                {t.label}
                {t.key === 'versions' ? ` (${d.versions.length})` : ''}
              </Link>
            ))}
          </nav>
          {tab === 'summary' && <Summary d={d} now={now} canNote={canNote} />}
          {tab === 'lines' && <Lines d={d} />}
          {tab === 'payments' && <ClaimPayments claimId={c.id} ctx={ctx} pmName={d.pmName} />}
          {tab === 'timeline' && <ClaimTimeline d={d} filter={sp.filter ?? 'all'} />}
          {tab === 'versions' && <Versions d={d} compare={Number.parseInt(sp.compare ?? '', 10) || null} />}
          {tab === 'patient' && <PatientCoverage claimId={c.id} ctx={ctx} />}
        </>
      )}
    </>
  );
}

function Summary({ d, now, canNote }: { d: ClaimDetail; now: Date; canNote: boolean }) {
  const item = d.openItem;
  const recent = d.events.slice(0, 4);
  return (
    <div className="split">
      <div className="split-main stack">
        {item && (
          <div className="card">
            <div className="card-head">
              <h2>{work.WORK_TYPE_LABEL[item.type as work.WorkItemType] ?? item.type}</h2>
              <span className="tag">Open item</span>
              <span className="spacer" />
              <DueChip
                {...(work.dueState(item.dueAt, now) === 'ok'
                  ? {}
                  : { state: work.dueState(item.dueAt, now) as 'soon' | 'over' })}
              >
                {item.assigneeName ? `Assigned to ${item.assigneeName} · ` : ''}
                {work.dueLabel(item.dueAt, now)}
              </DueChip>
            </div>
            <div className="card-body row-between">
              <span>{item.summary}</span>
              <Link className="btn btn-secondary btn-sm" href={`/work?item=${item.id}`}>
                Open in the queue
              </Link>
            </div>
          </div>
        )}
        <div className="card">
          <div className="card-head">
            <h2>
              {['submitted', 'accepted', 'paid', 'partially_paid', 'denied', 'closed'].includes(
                d.claim.status,
              )
                ? 'Findings at release'
                : 'Findings'}
            </h2>
            {d.scrub && (
              <span className="muted dense">
                Scrubbed {formatWhen(d.scrub.scrubbedAt)} · rule set{' '}
                {d.scrub.rulesVersion.replace(/^rules-/, '')} · confidence {d.scrub.confidence}
              </span>
            )}
          </div>
          <div className="card-body stack-sm">
            {!d.scrub && (
              <span className="muted">
                Not scrubbed yet. Cleanpost scrubs each version as soon as it is built.
              </span>
            )}
            {d.scrub && <ConfidenceMeter score={d.scrub.confidence} threshold={d.threshold} />}
            {d.scrub?.aiSummary && <Suggestion>{d.scrub.aiSummary}</Suggestion>}
            {d.scrub?.findings.length === 0 && <span className="muted">No findings.</span>}
            {d.scrub?.findings.map((f, i) => (
              <FindingRow key={`${f.ruleId}-${i}`} severity={f.severity} title={f.message} meta={f.ruleId} />
            ))}
          </div>
        </div>
      </div>
      <div className="card" style={{ width: 380, flex: 'none' }}>
        <div className="card-head">
          <h2>Recent activity</h2>
          <Link href={`/claims/${d.claim.id}?tab=timeline`} className="dense" style={{ marginLeft: 'auto' }}>
            Full timeline
          </Link>
        </div>
        <div className="card-body">
          <Timeline
            label="Recent activity"
            events={recent.map((e) => {
              const x = describeEvent(e, d.pmName);
              return {
                title: x.title,
                meta: `${actorLabel(e.actor, e.actorName)} · ${formatWhen(e.occurredAt)}`,
                ...(x.tone ? { tone: x.tone } : {}),
              };
            })}
          />
        </div>
        {canNote && (
          <div className="card-foot">
            <AddNote claimId={d.claim.id} />
          </div>
        )}
      </div>
    </div>
  );
}

/** C-03: codes only, never CPT descriptions (CLAUDE.md rule 11). Adjudication columns arrive in M3. */
function Lines({ d }: { d: ClaimDetail }) {
  const p = d.payload;
  return (
    <div className="stack">
      <div className="card flush">
        <div className="table-wrap">
          <table className="table nowrap" aria-label="Claim lines">
            <thead>
              <tr>
                <th>#</th>
                <th>Code</th>
                <th>Modifiers</th>
                <th className="num">Units</th>
                <th>Diagnosis pointers</th>
                <th className="num">Charge</th>
                <th className="num">Allowed</th>
                <th className="num">Paid</th>
                <th>Adjustments</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l) => (
                <tr key={l.chargeLineId}>
                  <td>{l.lineNumber}</td>
                  <td className="code">{l.code}</td>
                  <td className="code">{l.modifiers.join(', ') || '—'}</td>
                  <td className="num">{l.units}</td>
                  <td className="code">{l.dxPointers.join(', ') || '—'}</td>
                  <td className="num">{formatMoney(l.chargeCents)}</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                  <td>—</td>
                  <td className="num">—</td>
                </tr>
              ))}
              <tr>
                <td colSpan={5}>
                  <b>Total</b>
                </td>
                <td className="num">
                  <b>{formatMoney(p.totalChargeCents)}</b>
                </td>
                <td className="num">—</td>
                <td className="num">—</td>
                <td />
                <td className="num">{formatMoney(d.claim.balanceCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>
            Allowed, paid and adjustments appear when the payer's 835 is read (not yet adjudicated).
          </span>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Diagnoses</h2>
        </div>
        <div className="card-body">
          <table className="table" aria-label="Diagnoses">
            <thead>
              <tr>
                <th>Pointer</th>
                <th>ICD-10</th>
              </tr>
            </thead>
            <tbody>
              {p.diagnoses.map((x) => (
                <tr key={x.sequence}>
                  <td>{x.sequence}</td>
                  <td className="code">{x.icd10}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'payer', label: 'Payer responses' },
  { key: 'people', label: 'People' },
  { key: 'automation', label: 'Automation' },
] as const;

function ClaimTimeline({ d, filter }: { d: ClaimDetail; filter: string }) {
  const events = d.events.filter((e) =>
    filter === 'payer'
      ? ['ack_277ca', 'rejected', 'status_277', 'ack_999'].includes(e.type)
      : filter === 'people'
        ? e.actor.startsWith('user:')
        : filter === 'automation'
          ? !e.actor.startsWith('user:')
          : true,
  );
  return (
    <div className="card">
      <div className="card-head">
        <div className="segmented" role="group" aria-label="Show events">
          {SEGMENTS.map((s) => (
            <Link
              key={s.key}
              href={`/claims/${d.claim.id}?tab=timeline${s.key === 'all' ? '' : `&filter=${s.key}`}`}
              className={s.key === filter ? 'active' : undefined}
              aria-current={s.key === filter ? 'true' : undefined}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>
      <div className="card-body">
        {events.length === 0 ? (
          <span className="muted">No events of this kind yet.</span>
        ) : (
          <Timeline
            label="Claim timeline"
            events={events.map((e) => {
              const x = describeEvent(e, d.pmName);
              return {
                title: x.title,
                meta: `${actorLabel(e.actor, e.actorName)} · ${formatWhen(e.occurredAt)}${e.versionNumber ? ` · v${e.versionNumber}` : ''}`,
                ...(x.tone ? { tone: x.tone } : {}),
              };
            })}
          />
        )}
      </div>
    </div>
  );
}

function Versions({ d, compare }: { d: ClaimDetail; compare: number | null }) {
  const shown = compare ? d.versions.find((v) => v.version === compare) : null;
  return (
    <div className="stack">
      {shown && <CompareVersions d={d} v={shown} />}
      <div className="card flush">
        <div className="table-wrap">
          <table className="table" aria-label="Claim versions">
            <thead>
              <tr>
                <th>Version</th>
                <th>Frequency</th>
                <th>Made by</th>
                <th>Created</th>
                <th>Scrub</th>
                <th>Released</th>
                <th className="num">Charge</th>
                <th>What changed</th>
                <th>
                  <span className="sr-only">Compare</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {d.versions.map((v) => (
                <tr key={v.id}>
                  <td>
                    v{v.version}
                    {v.id === d.versionId && (
                      <span className="tag" style={{ marginLeft: 6 }}>
                        Current
                      </span>
                    )}
                  </td>
                  <td>{FREQUENCY_LABEL[v.frequencyCode] ?? v.frequencyCode}</td>
                  <td>
                    {v.createdBy.startsWith('user:')
                      ? (v.createdByName ?? 'A user')
                      : `Built from ${d.pmName}`}
                  </td>
                  <td>{formatWhen(v.createdAt)}</td>
                  <td>{v.confidence !== null ? `${v.confidence}` : '—'}</td>
                  <td>{v.releasedAt ? formatWhen(v.releasedAt) : '—'}</td>
                  <td className="num">{formatMoney(v.totalChargeCents)}</td>
                  <td>
                    {v.changes.length
                      ? v.changes.map((x) => x.label).join('; ')
                      : v.version === 1
                        ? 'First version'
                        : '—'}
                  </td>
                  <td>
                    {v.version > 1 && (
                      <Link
                        className="btn btn-ghost btn-sm"
                        href={`/claims/${d.claim.id}?tab=versions&compare=${v.version}`}
                      >
                        Compare with v{v.version - 1}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-foot">
          <span>
            Released versions never change; a correction after release is a new version (frequency 7).
          </span>
        </div>
      </div>
    </div>
  );
}

const show = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : Array.isArray(v)
      ? v
          .map((x) =>
            x && typeof x === 'object' ? ((x as { icd10?: string }).icd10 ?? JSON.stringify(x)) : String(x),
          )
          .join(', ') || '—'
      : String(v);

/** C-10 Compare versions: what changed from the version before, field by field. */
function CompareVersions({ d, v }: { d: ClaimDetail; v: ClaimDetail['versions'][number] }) {
  return (
    <div className="card" aria-label={`Compare v${v.version - 1} and v${v.version}`}>
      <div className="card-head">
        <h2>
          v{v.version - 1} to v{v.version}
        </h2>
        <span className="spacer" />
        <Link href={`/claims/${d.claim.id}?tab=versions`}>Close</Link>
      </div>
      <div className="card-body">
        {v.changes.length === 0 ? (
          <span className="muted">No field changed.</span>
        ) : (
          <table className="table" aria-label="Changed fields">
            <thead>
              <tr>
                <th>Change</th>
                <th>v{v.version - 1}</th>
                <th>v{v.version}</th>
              </tr>
            </thead>
            <tbody>
              {v.changes.map((x) => (
                <tr key={x.fieldPath}>
                  <td>{x.label}</td>
                  <td className="code">
                    <s>{show(x.before)}</s>
                  </td>
                  <td className="code">
                    <b>{show(x.after)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** C-06 Patient and coverage: masked values; full ones through G-12, each recorded. */
async function PatientCoverage({
  claimId,
  ctx,
}: {
  claimId: string;
  ctx: Awaited<ReturnType<typeof requireActiveContext>>;
}) {
  const v = await getClaimCoverage(ctx, claimId);
  if (!v) return null;
  const e = v.eligibility;
  const s = (e?.summary ?? {}) as {
    copayCents?: number | null;
    deductibleRemainingCents?: number | null;
    coinsurancePercent?: number | null;
    errorCodes?: string[];
    source?: string;
  };
  return (
    <div className="stack">
      {v.coverage?.changedAfterRelease && (
        <Banner tone="warn">Coverage on file changed after this claim was sent.</Banner>
      )}
      <div className="split">
        <div className="card split-main">
          <div className="card-head">
            <h2>Patient</h2>
          </div>
          <div className="card-body">
            <KeyValue
              items={[
                ['Name', v.patient.label],
                [
                  'Date of birth',
                  <RevealField
                    key="dob"
                    claimId={claimId}
                    field="dob"
                    masked={v.patient.dobMasked}
                    label="date of birth"
                  />,
                ],
                ['Sex', v.patient.sex],
              ]}
            />
          </div>
        </div>
        <div className="card split-main">
          <div className="card-head">
            <h2>Coverage</h2>
          </div>
          <div className="card-body">
            {v.coverage ? (
              <KeyValue
                items={[
                  ['Payer', v.coverage.payerName],
                  [
                    'Member ID',
                    <RevealField
                      key="mid"
                      claimId={claimId}
                      field="member_id"
                      masked={v.coverage.memberIdMasked}
                      label="member ID"
                    />,
                  ],
                  ['Group', v.coverage.groupNumber ?? '—'],
                  ['Relationship', v.coverage.relationship],
                  ['Effective', formatDate(v.coverage.effectiveDate)],
                  ['Ends', formatDate(v.coverage.terminationDate)],
                ]}
              />
            ) : (
              <span className="muted">No coverage on this claim.</span>
            )}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Eligibility</h2>
          {e && (
            <span className="muted dense">
              Checked {formatWhen(e.requestedAt)}
              {s.source === 'payer-sim' ? ' · payer simulator' : ''}
            </span>
          )}
        </div>
        <div className="card-body">
          {!e ? (
            <span className="muted">
              Not checked yet. Cleanpost checks coverage before it scrubs a claim.
            </span>
          ) : (
            <KeyValue
              items={[
                [
                  'Status',
                  e.status === 'active'
                    ? 'Active'
                    : e.status === 'inactive'
                      ? 'Inactive'
                      : e.status === 'error'
                        ? `Payer could not confirm${s.errorCodes?.length ? ` (AAA ${s.errorCodes.join(', ')})` : ''}`
                        : 'Unknown',
                ],
                ['Copay', formatMoney(s.copayCents ?? null)],
                ['Deductible remaining', formatMoney(s.deductibleRemainingCents ?? null)],
                [
                  'Coinsurance',
                  s.coinsurancePercent !== null && s.coinsurancePercent !== undefined
                    ? `${s.coinsurancePercent}%`
                    : '—',
                ],
              ]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const CLP_STATUS: Record<string, string> = {
  '1': 'Processed as primary',
  '2': 'Processed as secondary',
  '3': 'Processed as tertiary',
  '4': 'Denied',
  '19': 'Processed as primary, forwarded',
  '22': 'Reversal of an earlier payment',
};

/** C-07 Payments: each 835 payment for this claim, its lines and how the PM posted them. */
async function ClaimPayments({
  claimId,
  ctx,
  pmName,
}: {
  claimId: string;
  ctx: Awaited<ReturnType<typeof requireActiveContext>>;
  pmName: string;
}) {
  const payments = await getClaimPayments(ctx, claimId);
  if (!payments.length)
    return (
      <EmptyState title="No payment received yet" tone="neutral">
        Payments appear here when an 835 for this claim is read from the PM or uploaded.
      </EmptyState>
    );
  return (
    <div className="stack">
      {payments.map((p) => (
        <div key={p.remitClaimId} className="card flush">
          <div className="card-head">
            <h2>
              {p.payerName} · {formatDate(p.paymentDate)} ·{' '}
              {p.method === 'CHK' ? 'Check' : p.method === 'NON' ? 'No payment' : 'EFT'}{' '}
              <span className="code">{p.traceNumber}</span>
            </h2>
            <span className="spacer" />
            <span className="muted dense">
              {CLP_STATUS[p.claimStatusCode] ?? `Status ${p.claimStatusCode}`}
            </span>
            <Link className="btn btn-secondary btn-sm" href={`/remittances/${p.remittanceId}`}>
              Open remittance
            </Link>
          </div>
          <div className="table-wrap">
            <table className="table" aria-label={`Payment ${p.traceNumber}`}>
              <thead>
                <tr>
                  <th>Code</th>
                  <th className="num">Charge</th>
                  <th className="num">Paid</th>
                  <th>Adjustments</th>
                  <th>{pmName} posting</th>
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => {
                  const result = lineResult(
                    l.status,
                    l.differences.map((x) => x.field),
                  );
                  return (
                    <tr key={l.id}>
                      <td className="code">
                        {l.code}
                        {l.modifiers.length ? `-${l.modifiers.join('-')}` : ''}
                      </td>
                      <td className="num">{formatMoney(l.chargeCents)}</td>
                      <td className="num">{formatMoney(l.paidCents)}</td>
                      <td>
                        {l.adjustments.length
                          ? l.adjustments.map((a, i) => (
                              <span
                                key={i}
                                className="row"
                                style={{ gap: 4, display: 'inline-flex', marginRight: 8 }}
                              >
                                <span
                                  className={`codechip${a.group === 'PR' || a.carc === '45' ? '' : ' bad'}`}
                                >
                                  {a.group}-{a.carc}
                                </span>
                                {formatMoney(a.amountCents)}
                              </span>
                            ))
                          : '—'}
                      </td>
                      <td>
                        {p.itemId && (l.status === 'mismatch' || l.status === 'missing') ? (
                          <Link href={`/work?item=${p.itemId}`}>
                            <StatusChip status={result} />
                          </Link>
                        ) : (
                          <StatusChip status={result} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="table-foot">
            <span>
              Charged {formatMoney(p.chargeCents)} · paid {formatMoney(p.paidCents)} · patient responsibility{' '}
              {formatMoney(p.patientRespCents)}
            </span>
            <span className="spacer" />
            <span className="muted">CO amounts cannot be billed to the patient; PR amounts can.</span>
          </div>
        </div>
      ))}
    </div>
  );
}
