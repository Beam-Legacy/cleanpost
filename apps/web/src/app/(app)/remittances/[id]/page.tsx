import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CircleCheck, CircleX, Clock, TriangleAlert } from 'lucide-react';
import { z } from 'zod';
import { policy } from '@cleanpost/domain';
import { StatusChip } from '@cleanpost/ui';
import { formatDate, formatMoney } from '@/lib/format';
import { getRemittance, type RemitLineView } from '@/lib/queries/remittances';
import { CARC_LABEL, lineResult, PLB_LABEL } from '@/lib/remit-display';
import { requireActiveContext } from '@/lib/session';
import { AcceptDifference } from './accept-difference';

export const metadata: Metadata = { title: 'Remittance' };

const Id = z.uuid();
const DENIAL = new Set(['4', '18', '27', '29', '31', '97', '197']);

const adjText = (a: { group: string; carc: string; amountCents: number }) => `${a.group}-${a.carc}`;

function SaysCell({ l }: { l: RemitLineView }) {
  const denied = l.adjustments.filter((a) => a.group !== 'PR' && DENIAL.has(a.carc));
  const pr = l.adjustments.filter((a) => a.group === 'PR');
  return (
    <div className="two-line">
      <span>
        {denied.length ? (
          <>
            Denied {formatMoney(denied.reduce((s, a) => s + a.amountCents, 0))}{' '}
            {denied.map((a) => (
              <span key={adjText(a)} className="codechip bad">
                {adjText(a)}
              </span>
            ))}
          </>
        ) : (
          <>
            Paid {formatMoney(l.paidCents)}
            {pr.length > 0 &&
              l.paidCents === 0 &&
              ' · patient owes ' + formatMoney(pr.reduce((s, a) => s + a.amountCents, 0))}
          </>
        )}
      </span>
      <span className="sub">
        {denied.length
          ? (CARC_LABEL[denied[0]!.carc] ?? 'denied')
          : l.adjustments.map((a) => `${adjText(a)} ${formatMoney(a.amountCents)}`).join(' · ') ||
            'No adjustments'}
      </span>
    </div>
  );
}

function PostedCell({ l, pmName }: { l: RemitLineView; pmName: string }) {
  if (!l.posted)
    return (
      <div className="two-line">
        <span className={l.status === 'missing' ? 'diff-old' : 'muted'}>Nothing posted</span>
        <span className="sub">
          {l.status === 'missing' ? `Still open in ${pmName}` : 'Waiting for the next sync'}
        </span>
      </div>
    );
  const bad = l.status === 'mismatch';
  return (
    <div className="two-line">
      <span className={bad ? 'diff-old' : undefined}>Paid {formatMoney(l.posted.paidCents)}</span>
      <span className="sub">
        {l.posted.adjustments.map((a) => `${a.code} ${formatMoney(a.amountCents)}`).join(' · ') ||
          'No adjustments'}
      </span>
    </div>
  );
}

/** R-04 Remittance detail (Modes A and C): the 835 checks and each line against the PM posting. */
export default async function RemittancePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requireActiveContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!Id.safeParse(id).success) notFound();
  const d = await getRemittance(ctx, id);
  if (!d) notFound();
  policy.assertAllowed(ctx.actor, 'remittance.view', { clientId: d.clientId });
  const canAccept = policy.authorize(ctx.actor, 'remittance.accept_difference', {
    clientId: d.clientId,
  }).allowed;

  const diffFirst = sp.order !== 'file';
  const rank = (l: RemitLineView) =>
    l.status === 'mismatch' || l.status === 'missing'
      ? 0
      : l.status === 'unmapped'
        ? 1
        : l.status === 'verified'
          ? 3
          : 2;
  const lines = diffFirst ? [...d.lines].sort((a, b) => rank(a) - rank(b)) : d.lines;
  const itemFor = (claimId: string | null) =>
    d.items.find((i) => i.claimId === claimId && i.type === 'posting_exception');
  const toResolve = d.items.length;
  const verified = d.status === 'reconciled';
  const waiting = d.status === 'verifying' || d.status === 'matched';
  const method = d.method === 'CHK' ? 'Check' : d.method === 'NON' ? 'No payment' : 'EFT';
  const legend = [...new Set(d.lines.flatMap((l) => l.adjustments.map((a) => a.carc)))].filter(
    (c) => CARC_LABEL[c],
  );

  return (
    <>
      <Link className="breadcrumb" href="/remittances">
        <ArrowLeft aria-hidden />
        Remittances
      </Link>
      <div className="card card-body stack">
        <div className="row">
          {verified ? (
            <StatusChip status="Verified" />
          ) : toResolve ? (
            <span className="chip chip-warn">
              <TriangleAlert aria-hidden />
              {toResolve} {toResolve === 1 ? 'thing' : 'things'} to resolve
            </span>
          ) : (
            <StatusChip status="Waiting for PM" />
          )}
          <span className="mode">
            Mode {d.mode} · {d.pmName} posts, Cleanpost checks
          </span>
        </div>
        <h1 className="title-l">
          {d.payerName} · {method} {d.traceNumber} · {formatMoney(d.amountCents)} ·{' '}
          {formatDate(d.paymentDate)}
        </h1>
        <div className="grid-2">
          <div className={`balance${d.balanced ? '' : ' bad'}`}>
            {d.balanced ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}
            <b>{d.balanced ? '835 balances' : '835 does not balance'}</b>
            <span>
              Payment {formatMoney(d.amountCents)} = claims paid {formatMoney(d.claimsPaidCents)}
              {d.providerAdjustments.map((p) => (
                <span key={p.reasonCode}>
                  {' '}
                  {p.amountCents < 0 ? '+' : '−'} {PLB_LABEL[p.reasonCode] ?? p.reasonCode}{' '}
                  {formatMoney(Math.abs(p.amountCents))}
                </span>
              ))}
            </span>
          </div>
          <div className={`balance${verified ? '' : waiting ? '' : ' bad'}`}>
            {verified ? (
              <CircleCheck aria-hidden />
            ) : waiting ? (
              <Clock aria-hidden />
            ) : (
              <CircleX aria-hidden />
            )}
            <b>
              {verified
                ? `${d.pmName} posting matches`
                : waiting
                  ? `Waiting for ${d.pmName} to post`
                  : `${d.pmName} posting does not match`}
            </b>
            <span>
              {d.counts.differences} of {d.counts.lines}{' '}
              {d.counts.lines === 1 ? 'line differs' : 'lines differ'} · {d.counts.verified}{' '}
              {d.counts.verified === 1 ? 'matches' : 'match'}
              {d.counts.unmatched ? ` · ${d.counts.unmatched} unmatched` : ''}
              {d.counts.pending ? ` · ${d.counts.pending} waiting` : ''}
            </span>
          </div>
        </div>
        <dl className="dl">
          <div>
            <dt>Claims</dt>
            <dd className="fig">{d.counts.claims}</dd>
          </div>
          <div>
            <dt>Lines</dt>
            <dd className="fig">{d.counts.lines}</dd>
          </div>
          <div>
            <dt>Lines matching</dt>
            <dd className="fig" style={{ color: 'var(--success)' }}>
              {d.counts.verified}
            </dd>
          </div>
          <div>
            <dt>Differences</dt>
            <dd className="fig" style={{ color: d.counts.differences ? 'var(--danger)' : undefined }}>
              {d.counts.differences}
            </dd>
          </div>
          <div>
            <dt>Unmatched</dt>
            <dd className="fig" style={{ color: d.counts.unmatched ? 'var(--warning)' : undefined }}>
              {d.counts.unmatched}
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>
              {d.source === 'file' ? '835 uploaded' : d.source === 'pm' ? `Read from ${d.pmName}` : 'Stedi'}
            </dd>
          </div>
        </dl>
      </div>

      {d.status === 'out_of_balance' && (
        <div className="card card-body stack" style={{ borderColor: 'var(--danger)' }}>
          <h2>835 does not balance</h2>
          <p className="muted dense">
            Nothing from this payment is matched or checked until the payer sends a corrected 835 or an admin
            accepts the difference. Accepting goes on with the claims that balance on their own and sets the
            rest aside.
          </p>
          <dl className="dl">
            <div>
              <dt>Payment (BPR)</dt>
              <dd className="fig">{formatMoney(d.amountCents)}</dd>
            </div>
            <div>
              <dt>Claims paid</dt>
              <dd className="fig">{formatMoney(d.claimsPaidCents)}</dd>
            </div>
            <div>
              <dt>Provider adjustments</dt>
              <dd className="fig">
                {formatMoney(d.providerAdjustments.reduce((s, p) => s + p.amountCents, 0))}
              </dd>
            </div>
            <div>
              <dt>Difference</dt>
              <dd
                className="fig"
                style={{ color: d.remittanceDifferenceCents ? 'var(--danger)' : undefined }}
              >
                {formatMoney(d.remittanceDifferenceCents)}
              </dd>
            </div>
          </dl>
          {d.claimChecks.some((c) => c.differenceCents !== 0) && (
            <table className="table" aria-label="Claims that do not balance">
              <thead>
                <tr>
                  <th>Control number</th>
                  <th className="num">Charge</th>
                  <th className="num">Paid</th>
                  <th className="num">Adjustments</th>
                  <th className="num">Off by</th>
                </tr>
              </thead>
              <tbody>
                {d.claimChecks
                  .filter((c) => c.differenceCents !== 0)
                  .map((c) => (
                    <tr key={c.id} className="row-bad">
                      <td className="code">{c.patientControlNumber}</td>
                      <td className="num">{formatMoney(c.chargeCents)}</td>
                      <td className="num">{formatMoney(c.paidCents)}</td>
                      <td className="num">{formatMoney(c.adjustedCents)}</td>
                      <td className="num">{formatMoney(c.differenceCents)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {canAccept ? (
            <AcceptDifference remittanceId={d.id} />
          ) : (
            <p className="muted dense">An admin can accept the difference with a reason.</p>
          )}
        </div>
      )}

      {d.unmatched.map((u) => (
        <div key={u.id} className="card card-body" style={{ borderColor: 'var(--warning)' }}>
          <div className="stack-sm">
            <b>
              Unmatched: control number <span className="code">{u.patientControlNumber}</span> is not a
              Cleanpost claim
            </b>
            <span className="muted dense">
              Paid {formatMoney(u.paidCents)}. Likely billed before this client went live on Cleanpost; it is
              in the work queue to link or set aside.
            </span>
          </div>
        </div>
      ))}

      <div className="card flush">
        <div className="card-head">
          <h2>835 compared with what {d.pmName} posted</h2>
          <span className="spacer" />
          <Link className="btn btn-ghost btn-sm" href={`/remittances/${id}${diffFirst ? '?order=file' : ''}`}>
            {diffFirst ? 'Show in file order' : 'Show differences first'}
          </Link>
        </div>
        <div className="table-wrap">
          <table className="table" aria-label="Lines">
            <thead>
              <tr>
                <th>Claim and line</th>
                <th>Code</th>
                <th>835 says</th>
                <th>{d.pmName} posted</th>
                <th>Result</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {lines
                .filter((l) => l.claimId)
                .map((l) => {
                  const result = lineResult(
                    l.status,
                    l.differences.map((x) => x.field),
                  );
                  const bad = l.status === 'mismatch' || l.status === 'missing';
                  const item = bad ? itemFor(l.claimId) : undefined;
                  return (
                    <tr key={l.id} className={bad ? 'row-bad' : undefined}>
                      <td>
                        <div className="two-line">
                          <Link href={`/claims/${l.claimId}`}>
                            <b>{l.patient ?? 'Claim'}</b>
                          </Link>
                          <span className="sub code">
                            {l.patientControlNumber} · line {l.lineNumber}
                          </span>
                        </div>
                      </td>
                      <td className="code">
                        {l.code}
                        {l.modifiers.length ? `-${l.modifiers.join('-')}` : ''}
                      </td>
                      <td>
                        <SaysCell l={l} />
                      </td>
                      <td>
                        <PostedCell l={l} pmName={d.pmName} />
                        {l.differences.length > 0 && (
                          <ul className="sub dense" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                            {l.differences.map((x) => (
                              <li key={x.field}>
                                {x.field}: 835 {x.expected}, {d.pmName} {x.actual}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        <StatusChip status={result} />
                      </td>
                      <td>
                        {item && (
                          <Link className="btn btn-secondary btn-sm" href={`/work?item=${item.id}`}>
                            Open item
                          </Link>
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
            {d.counts.lines} {d.counts.lines === 1 ? 'line' : 'lines'}
          </span>
          <span className="spacer" />
          <span>
            {legend.map((c, i) => (
              <span key={c}>
                {i > 0 && ' · '}
                <span className={`codechip${DENIAL.has(c) ? ' bad' : ''}`}>{c}</span> {CARC_LABEL[c]}
              </span>
            ))}
          </span>
        </div>
      </div>
    </>
  );
}
