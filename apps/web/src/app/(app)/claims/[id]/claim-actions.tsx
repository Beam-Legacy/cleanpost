'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button, useToast } from '@cleanpost/ui';
import { undo } from '../../work/actions';
import { approveAndReleaseClaim } from './actions';

/** C-02 header actions by status. Release waits 10 seconds so Undo can stop it (DEC-13). */
export function ClaimActions({
  claimId,
  canRelease,
  canEdit,
  inReview,
}: {
  claimId: string;
  canRelease: boolean;
  canEdit: boolean;
  inReview: boolean;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  if (!canRelease && !canEdit) return null;
  return (
    <div className="row">
      {canRelease && (
        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await approveAndReleaseClaim(claimId);
              const u = res.undo;
              toast({
                message: res.message,
                ...(res.ok ? {} : { tone: 'bad' as const }),
                ...(u
                  ? {
                      onUndo: () =>
                        void undo(u).then((r) => {
                          toast({ message: r.message, ...(r.ok ? {} : { tone: 'bad' as const }) });
                          router.refresh();
                        }),
                    }
                  : {}),
              });
            })
          }
        >
          {inReview ? 'Approve and release' : 'Release'}
        </Button>
      )}
      {canEdit && (
        <Button asChild>
          <Link href={`/claims/${claimId}?edit=1`}>Edit</Link>
        </Button>
      )}
    </div>
  );
}
