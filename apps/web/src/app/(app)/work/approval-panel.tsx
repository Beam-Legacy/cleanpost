'use client';
/**
 * W-01 panel for a write-off approval (D-03 "Request approval"): a biller asked to write off more
 * than the tenant's limit. An admin approves (the write-off is done now, as the admin, with the
 * biller recorded) or declines with a note the biller sees.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { formatMoney, formatWhen } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { decideWriteOffAction } from './actions';

export function ApprovalPanel({
  itemId,
  request: r,
  balanceCents,
  canDecide,
  onDone,
}: {
  itemId: string;
  request: NonNullable<WorkDetail['writeOffRequest']>;
  balanceCents: number | null;
  canDecide: boolean;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const decide = (decision: 'approve' | 'decline') =>
    start(async () => {
      const res = await decideWriteOffAction(itemId, decision, note);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) {
        router.refresh();
        onDone();
      }
    });
  return (
    <div className="stack-sm">
      <span className="overline">Write-off requested</span>
      <dl className="kv dense">
        <dt>Amount</dt>
        <dd className="num">{formatMoney(r.amountCents)}</dd>
        {balanceCents !== null && (
          <>
            <dt>Open balance</dt>
            <dd className="num">{formatMoney(balanceCents)}</dd>
          </>
        )}
        <dt>Reason</dt>
        <dd>{r.reason}</dd>
        <dt>{r.pmName === 'the PM' ? 'PM' : r.pmName} code</dt>
        <dd className="code">{r.pmCode}</dd>
        <dt>Asked by</dt>
        <dd>
          {r.requestedByName ?? 'A biller'}, {formatWhen(r.createdAt)}
        </dd>
        {r.note && (
          <>
            <dt>Note</dt>
            <dd>{r.note}</dd>
          </>
        )}
      </dl>
      {r.status !== 'pending' ? (
        <div className="muted dense">
          {r.status === 'approved'
            ? 'Approved and written off.'
            : r.status === 'declined'
              ? `Declined${r.decisionNote ? `: ${r.decisionNote}` : '.'}`
              : 'No longer needed: the denial was answered another way.'}
        </div>
      ) : canDecide ? (
        <>
          <label className="field">
            <span className="label">Note to the biller (optional)</span>
            <textarea
              className="input"
              rows={2}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <Button variant="danger" size="sm" disabled={pending} onClick={() => decide('approve')}>
              Approve and write off {formatMoney(r.amountCents)}
            </Button>
            <Button size="sm" disabled={pending} onClick={() => decide('decline')}>
              Decline
            </Button>
          </div>
          <div className="muted dense">
            Over the approval limit of {formatMoney(r.limitCents)}. Approving writes it off in {r.pmName} (a
            task for a person there) and cannot be undone from Cleanpost.
          </div>
        </>
      ) : (
        <div className="muted dense">An admin decides this request.</div>
      )}
    </div>
  );
}
