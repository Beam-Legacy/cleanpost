'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { KeyRound, Pause, Play, RefreshCw } from 'lucide-react';
import { ConfirmDialog, useToast } from '@cleanpost/ui';
import { runNow, setSyncPaused, type SyncControlResult } from '@/app/(app)/integrations/[id]/actions';

/** I-02 header actions. While a run is queued or running, the page refreshes every few seconds. */
export function SyncControls({
  connectionId,
  status,
  running,
}: {
  connectionId: string;
  status: string;
  running: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [confirmPause, setConfirmPause] = useState(false);
  const [watchUntil, setWatchUntil] = useState(0);

  useEffect(() => {
    if (!running && watchUntil === 0) return;
    const timer = setInterval(() => {
      if (!running && Date.now() > watchUntil) {
        setWatchUntil(0);
        return;
      }
      router.refresh();
    }, 3_000);
    return () => clearInterval(timer);
  }, [running, watchUntil, router]);

  // The actions revalidate this page, so the new status arrives with their response.
  const act = (fn: () => Promise<SyncControlResult>, after?: (r: SyncControlResult) => void) =>
    start(async () => {
      const r = await fn();
      toast(r.ok ? { message: r.message } : { message: r.message, tone: 'bad' });
      after?.(r);
    });

  const paused = status === 'paused';
  const setup = status === 'setup';
  return (
    <div className="actions">
      {paused ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending}
          onClick={() => act(() => setSyncPaused(connectionId, false))}
        >
          <Play aria-hidden />
          Resume syncing
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={pending || setup}
          onClick={() => setConfirmPause(true)}
        >
          <Pause aria-hidden />
          Pause syncing
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        disabled
        title="Saving new credentials arrives with onboarding (O-04)"
      >
        <KeyRound aria-hidden />
        Reconnect
      </button>
      <button
        type="button"
        className="btn btn-primary"
        disabled={pending || paused || setup}
        onClick={() =>
          act(
            () => runNow(connectionId),
            (r) => r.ok && setWatchUntil(Date.now() + 90_000),
          )
        }
      >
        <RefreshCw aria-hidden />
        {pending ? 'Working…' : 'Run now'}
      </button>
      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title="Pause syncing?"
        description="Cleanpost stops reading from the PM for this practice until you resume. Nothing it has already read changes."
        confirmLabel="Pause syncing"
        onConfirm={() => act(() => setSyncPaused(connectionId, true))}
      />
    </div>
  );
}
