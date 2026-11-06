'use client';
/**
 * Preview and local only: the demo date (DEC-18) and buttons to move it forward (admins). The payer
 * simulator keeps the date; Cleanpost and the mock PM follow it.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Clock } from 'lucide-react';
import { setOffset } from '@cleanpost/clock';
import type { DemoHistory } from '@cleanpost/db';
import { Button, useToast } from '@cleanpost/ui';
import { advanceClock } from '@/app/(app)/sim-actions';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

/** The 90-day replay (DEC-19) in a few words, or null when it is not running. */
function replayNote(h: DemoHistory, appNow: string): string | null {
  if (h.state === 'pending') return 'Demo history queued: the worker starts it within a minute.';
  if (h.state === 'running')
    return `Building ${h.days ?? 90} days of demo history: ${day(appNow)}, day ${h.day ?? 0} of ${h.days ?? 90}. Pages fill in as it goes.`;
  if (h.state === 'failed') return 'Demo history stopped before today. Run pnpm demo:reset to start again.';
  return null;
}

export function SimClock({
  now,
  appNow,
  realNow,
  history = {},
}: {
  now: string | null;
  appNow: string;
  realNow: string;
  history?: DemoHistory;
}) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const ahead = now ? Math.round((Date.parse(now) - Date.parse(realNow)) / 86_400_000) : null;
  // More than a minute apart: Cleanpost is not following the simulator (demo time is off).
  const apart = now !== null && Math.abs(Date.parse(now) - Date.parse(appNow)) > 60_000;
  const note = replayNote(history, appNow);
  const busy = history.state === 'pending' || history.state === 'running';
  const go = (days: number) =>
    start(async () => {
      const res = await advanceClock(days);
      if (res.offsetMs !== undefined) setOffset(res.offsetMs);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
      router.refresh();
    });
  return (
    <div
      className="card card-body row"
      role="group"
      aria-label="Demo clock"
      style={{ gap: 12, padding: '8px 12px' }}
    >
      <Clock aria-hidden />
      <span>
        <b>Demo clock</b>{' '}
        <span className="muted">
          {now
            ? `${day(now)}${ahead && ahead > 0 ? ` (${ahead} ${ahead === 1 ? 'day' : 'days'} ahead)` : ''}`
            : 'payer simulator not answering'}
          {apart && !busy ? ` · Cleanpost is on ${day(appNow)}` : ''}
          {' · preview only'}
        </span>
        {note && (
          <span className="dense" role="status" style={{ display: 'block' }}>
            {note}
          </span>
        )}
      </span>
      <span className="spacer" />
      {[1, 7, 14].map((d) => (
        <Button key={d} size="sm" disabled={pending || !now || busy} onClick={() => go(d)}>
          +{d} {d === 1 ? 'day' : 'days'}
        </Button>
      ))}
    </div>
  );
}
