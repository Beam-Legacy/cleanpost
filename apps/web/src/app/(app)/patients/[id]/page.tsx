import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ShieldOff } from 'lucide-react';
import { z } from 'zod';
import { policy } from '@cleanpost/domain';
import { Banner, Button, EmptyState, StatusChip } from '@cleanpost/ui';
import { CoverageDialog, PatientDialog } from '@/components/record-dialogs';
import { CLAIM_STATUS } from '@/lib/claim-display';
import { formatDate, formatMoney, formatWhen } from '@/lib/format';
import { getPatient } from '@/lib/queries/patients';
import { requireActiveContext } from '@/lib/session';
import { RevealField } from '../../claims/[id]/reveal-field';
import { ELIGIBILITY_STATUS } from '@/lib/eligibility-display';
import { CheckEligibilityButton, EligibilityDrawer } from './eligibility';

export const metadata: Metadata = { title: 'Patient' };

const PRIORITY = ['', 'primary', 'secondary', 'tertiary'];

/** P-01 Patient detail: coverage with eligibility, insurance cards and claims (P-03 on ?eligibility=). */
export default async function PatientPage({
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
  const p = await getPatient(ctx, id);
  if (!p) notFound();
  const canCheck = policy.authorize(ctx.actor, 'work.resolve', { clientId: p.clientId }).allowed;
  const canEdit = policy.authorize(ctx.actor, 'claim.edit', { clientId: p.clientId }).allowed;
  const corrected = p.source !== 'pm' || p.coverages.some((c) => c.source !== 'pm');
  const label = `${p.lastName}, ${p.firstName}`;
  const open = sp.eligibility ? p.coverages.find((c) => c.latest?.id === sp.eligibility) : undefined;

  return (
    <>
      <Link className="breadcrumb" href="/claims">
        <ArrowLeft aria-hidden />
        Claims
      </Link>
      <div className="card card-body stack">
        <div className="row-between">
          <div className="stack-sm">
            <h1 className="title-l">
              {label} · {p.ageYears} y
            </h1>
            <div className="muted dense row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span>{p.clientName}</span>
              {p.pmAccount && (
                <span>
                  · {p.pmName === 'the PM' ? 'PM' : p.pmName} account{' '}
                  <span className="code">{p.pmAccount}</span>
                </span>
              )}
              <span className="row" style={{ gap: 4 }}>
                · DOB{' '}
                <RevealField
                  target={{ patientId: p.id }}
                  field="dob"
                  masked={p.dobMasked}
                  label="date of birth"
                />
              </span>
            </div>
          </div>
          {canEdit && <PatientDialog patientId={p.id} trigger={<Button size="sm">Edit details</Button>} />}
        </div>
        {corrected && (
          <Banner tone="warn">
            Corrected in Cleanpost and waiting for {p.pmName} to show it. Claims for this patient do not go
            out until a sync from {p.pmName} matches; the task is in the work queue.
          </Banner>
        )}
        <dl className="dl" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <div>
            <dt>Open balance</dt>
            <dd className="fig">{formatMoney(p.openBalanceCents)}</dd>
          </div>
          <div>
            <dt>Patient responsibility</dt>
            <dd className="fig">{formatMoney(p.patientRespCents)}</dd>
          </div>
          <div>
            <dt>Open claims</dt>
            <dd className="fig">{p.openClaims}</dd>
          </div>
          <div>
            <dt>Last visit</dt>
            <dd className="fig">{formatDate(p.lastVisit)}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Coverage</h2>
        </div>
        <div className="card-body stack">
          {p.coverages.length === 0 ? (
            <EmptyState title="No insurance on file" icon={<ShieldOff />}>
              Add coverage in {p.pmName}; the next sync brings it in.
            </EmptyState>
          ) : (
            p.coverages.map((c) => (
              <div key={c.id} className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                <div className="stack-sm">
                  <b>
                    {c.payerName} · {PRIORITY[c.priority] ?? `priority ${c.priority}`}
                  </b>
                  <span className="muted dense row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    Member{' '}
                    <RevealField
                      target={{ coverageId: c.id }}
                      field="member_id"
                      masked={c.memberIdMasked}
                      label={`member ID for ${c.payerName}`}
                    />
                    {c.terminationDate ? ` · ends ${formatDate(c.terminationDate)}` : ''}
                    {c.latest ? ` · checked ${formatWhen(c.latest.requestedAt)}` : ' · not checked yet'}
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {c.latest && (
                    <Link
                      href={`/patients/${p.id}?eligibility=${c.latest.id}`}
                      scroll={false}
                      aria-label={`${ELIGIBILITY_STATUS[c.latest.status] ?? 'Not confirmed'}: eligibility for ${c.payerName}`}
                    >
                      <StatusChip status={ELIGIBILITY_STATUS[c.latest.status] ?? 'Not confirmed'} />
                    </Link>
                  )}
                  {canCheck && <CheckEligibilityButton coverage={c} patientId={p.id} />}
                  {canEdit && (
                    <CoverageDialog
                      coverage={c}
                      payers={p.payers}
                      pmName={p.pmName}
                      trigger={
                        <Button size="sm" variant="ghost" aria-label={`Edit ${c.payerName} coverage`}>
                          Edit
                        </Button>
                      }
                    />
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Insurance cards</h2>
        </div>
        <div className="card-body">
          {p.cards.length === 0 ? (
            <span className="muted">No cards uploaded.</span>
          ) : (
            <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {p.cards.map((d) => (
                <li key={d.id}>
                  {d.type === 'insurance_card_back' ? 'Back' : 'Front'} · {formatWhen(d.createdAt)} ·{' '}
                  {d.reviewStatus}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card flush">
        <div className="card-head">
          <h2>Claims</h2>
        </div>
        {p.claims.length === 0 ? (
          <div className="card-body muted">No claims yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="Claims for this patient">
              <thead>
                <tr>
                  <th>DOS</th>
                  <th>Payer</th>
                  <th className="num">Charge</th>
                  <th className="num">Paid</th>
                  <th className="num">Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {p.claims.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/claims/${c.id}`}>{formatDate(c.dateOfService)}</Link>
                    </td>
                    <td>{c.payerName ?? '—'}</td>
                    <td className="num">{formatMoney(c.chargeCents)}</td>
                    <td className="num">{c.paidCents ? formatMoney(c.paidCents) : '—'}</td>
                    <td className="num">{formatMoney(c.balanceCents)}</td>
                    <td>{CLAIM_STATUS[c.status] && <StatusChip status={CLAIM_STATUS[c.status]!} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {open?.latest && (
        <EligibilityDrawer
          patientLabel={`${p.lastName}, ${p.firstName.slice(0, 1)}.`}
          patientId={p.id}
          coverage={open}
          check={open.latest}
          others={p.coverages.filter((c) => c.id !== open.id)}
          closeHref={`/patients/${p.id}`}
        />
      )}
    </>
  );
}
