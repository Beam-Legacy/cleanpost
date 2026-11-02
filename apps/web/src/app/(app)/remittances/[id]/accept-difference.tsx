'use client';
/** R-06 Accept difference: admins only, with a reason; the claims that balance on their own go on. */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@cleanpost/ui';
import { acceptDifferenceAction } from '../actions';

export function AcceptDifference({ remittanceId }: { remittanceId: string }) {
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  return (
    <form
      className="stack-sm"
      aria-label="Accept the difference"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await acceptDifferenceAction(remittanceId, reason);
          toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
          if (res.ok) router.refresh();
        });
      }}
    >
      <label className="field">
        <span className="label">Why the difference is acceptable (kept in the audit log)</span>
        <textarea
          className="input"
          rows={2}
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div>
        <Button type="submit" variant="danger" size="sm" disabled={pending || reason.trim().length < 5}>
          Accept difference
        </Button>
      </div>
    </form>
  );
}
