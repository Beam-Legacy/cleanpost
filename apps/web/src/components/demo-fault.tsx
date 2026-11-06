'use client';
/**
 * Preview and local only (docs/18 demo script): break the mock PM's login behind this connection, or
 * fix it, so the connection fails (or recovers) in front of the audience. Admins only.
 */
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Button, useToast } from '@cleanpost/ui';
import { simulateLoginProblem } from '@/app/(app)/sim-actions';

export function DemoFaultControls({ connectionId, failed }: { connectionId: string; failed: boolean }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const run = (expired: boolean) =>
    start(async () => {
      const res = await simulateLoginProblem(connectionId, expired);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      // The sync takes a few seconds; show its result when it is in.
      setTimeout(() => router.refresh(), 6000);
    });
  return (
    <span className="row" style={{ gap: 8 }}>
      <Button size="sm" variant={failed ? 'ghost' : 'secondary'} disabled={pending} onClick={() => run(true)}>
        Expire the login (demo)
      </Button>
      <Button size="sm" variant={failed ? 'primary' : 'ghost'} disabled={pending} onClick={() => run(false)}>
        Fix the login (demo)
      </Button>
    </span>
  );
}
