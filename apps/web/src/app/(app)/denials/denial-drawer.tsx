'use client';
/**
 * D-02 Denial detail, from a D-01 row: everything needed to decide on one denial without opening
 * the claim. The denied lines with their codes explained and the suggested fix (rules, labelled
 * Suggested), at risk, the corrected-claim deadline, similar denials from this payer, and the
 * history; then Build correction, Write off (D-03), Reassign or Open claim.
 */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Drawer, StatusChip, Timeline } from '@cleanpost/ui';
import { DenialPanel } from '@/app/(app)/work/denial-panel';
import { AssignDialog } from '@/app/(app)/work/bulk';
import { actorLabel, CLAIM_STATUS, describeEvent } from '@/lib/claim-display';
import { formatDate, formatMoney, formatWhen } from '@/lib/format';
import type { DenialDrawer as Data } from '@/lib/queries/denials';

export function DenialDrawer({
  data,
  closeHref,
  can,
}: {
  data: Data;
  closeHref: string;
  can: { correct: boolean; overLimit: boolean; assign: boolean };
}) {
  const router = useRouter();
  const [assigning, setAssigning] = useState(false);
  const d = data.detail;
  const c = d.claim!;
  const denial = d.denial;
  const atRisk = denial?.deniedCents ?? Number(d.item.amountCents ?? 0);
  const status = CLAIM_STATUS[c.status];
  const code = denial?.advice[0]
    ? `${denial.advice[0].group}-${denial.advice[0].carc}`
    : `CO-${d.item.reasonCode}`;

  return (
    <Drawer
      open
      wide
      onOpenChange={(o) => !o && router.push(closeHref, { scroll: false })}
      title={[c.patient ?? 'Claim', c.payerName, formatMoney(atRisk)].filter(Boolean).join(' · ')}
      description={[d.clientName, c.pcn, c.dateOfService ? `DOS ${formatDate(c.dateOfService)}` : null]
        .filter(Boolean)
        .join(' · ')}
      footer={
        <>
          {can.assign && (
            <Button onClick={() => setAssigning(true)}>{d.item.assigneeId ? 'Reassign' : 'Assign'}</Button>
          )}
          <span className="spacer" />
          <Link className="btn btn-secondary" href={`/claims/${c.id}`}>
            Open claim
          </Link>
        </>
      }
    >
      <div className="stack">
        {status && (
          <div className="row" style={{ gap: 6 }}>
            <StatusChip status={status} />
          </div>
        )}
        {denial ? (
          <DenialPanel
            itemId={d.item.id}
            claimId={c.id}
            denial={denial}
            canCorrect={can.correct}
            canOverLimit={can.overLimit}
            label={[c.patient, c.payerName, c.pcn].filter(Boolean).join(' · ')}
          />
        ) : (
          <p style={{ margin: 0 }}>{d.item.summary}</p>
        )}

        <dl className="kv dense">
          <dt>At risk</dt>
          <dd className="num">{formatMoney(atRisk)}</dd>
          {data.deadline && (
            <>
              <dt>Corrected claim by</dt>
              <dd>
                {formatDate(data.deadline.date)}{' '}
                <span className="muted">
                  ({data.deadline.filingDays} days from the denial, this payer’s filing limit for the client)
                </span>
              </dd>
            </>
          )}
          <dt>Assigned to</dt>
          <dd>{data.assigneeName ?? 'No one yet'}</dd>
        </dl>

        <section className="stack-sm" aria-label="Similar denials">
          <span className="overline">Similar denials</span>
          <span className="dense">
            {data.similar.total === 0
              ? `The first ${code} from ${c.payerName ?? 'this payer'} for this client.`
              : `${data.similar.total} other ${code} ${data.similar.total === 1 ? 'denial' : 'denials'} from ${c.payerName ?? 'this payer'} for this client: ${data.similar.corrected} corrected, ${data.similar.writtenOff} written off, ${data.similar.open} open.`}
          </span>
        </section>

        <section className="stack-sm" aria-label="History">
          <span className="overline">History</span>
          {data.source && (
            <span className="muted dense">
              Denied in {data.source.payerName} payment{' '}
              <span className="code">{data.source.traceNumber}</span> · {formatDate(data.source.paymentDate)}{' '}
              · {data.source.kind === 'file' ? 'from an uploaded 835' : `read from ${data.pmName}`}
            </span>
          )}
          <Timeline
            label="Claim history"
            events={[...data.history].reverse().map((e) => {
              const x = describeEvent({ ...e, actorName: null }, data.pmName);
              return {
                title: x.title,
                meta: `${actorLabel(e.actor, null)} · ${formatWhen(e.occurredAt)}`,
                ...(x.tone ? { tone: x.tone } : {}),
              };
            })}
          />
        </section>
      </div>
      {assigning && (
        <AssignDialog
          open
          onOpenChange={setAssigning}
          itemIds={[d.item.id]}
          onDone={() => router.refresh()}
        />
      )}
    </Drawer>
  );
}
