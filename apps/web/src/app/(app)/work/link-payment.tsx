'use client';
/**
 * W-17 Unmatched payment: the claims it could be (same client, same total charge; codes compared),
 * Link on one, or set it aside as billed before go-live or not this client's.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { formatDate, formatMoney } from '@/lib/format';
import type { WorkDetail } from '@/lib/queries/work';
import { linkUnmatchedPayment, setAsideUnmatchedPayment } from './actions';

export function LinkPayment({
  itemId,
  candidates,
}: {
  itemId: string;
  candidates: NonNullable<WorkDetail['linkCandidates']>;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const res = await fn();
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      if (res.ok) router.refresh();
    });
  return (
    <div className="stack-sm">
      <span className="overline">Claims it could be</span>
      {candidates.length === 0 ? (
        <span className="muted dense">No claim of this client has the same total charge.</span>
      ) : (
        <ul
          className="stack-sm"
          style={{ listStyle: 'none', padding: 0, margin: 0 }}
          aria-label="Candidate claims"
        >
          {candidates.map((c) => (
            <li key={c.claimId} className="row" style={{ gap: 8 }}>
              <span className="two-line" style={{ flex: 1 }}>
                <b>
                  {c.patient ?? 'Claim'} · {formatDate(c.dateOfService)}
                </b>
                <span className="sub">
                  <span className="code">{c.patientControlNumber ?? 'no control number'}</span> ·{' '}
                  {formatMoney(c.totalChargeCents)} · {c.codesMatch ? 'codes match' : 'codes differ'}
                </span>
              </span>
              <Button
                size="sm"
                variant={c.codesMatch ? 'primary' : 'secondary'}
                disabled={pending}
                onClick={() => run(() => linkUnmatchedPayment(itemId, c.claimId))}
              >
                Link
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ gap: 8 }}>
        <Button
          size="sm"
          disabled={pending}
          onClick={() => run(() => setAsideUnmatchedPayment(itemId, 'Before go-live'))}
        >
          Mark as before go-live
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => setAsideUnmatchedPayment(itemId, 'Not ours'))}
        >
          Not this client’s
        </Button>
      </div>
    </div>
  );
}
