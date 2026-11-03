'use client';
/**
 * Preview and local only: the demo date (DEC-18) and buttons to move it forward (admins). The payer
 * simulator keeps the date; Cleanpost and the mock PM follow it.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Clock } from 'lucide-react';
import { setOffset } from '@cleanpost/clock';
import { Button, useToast } from '@cleanpost/ui';
import { advanceClock } from '@/app/(app)/sim-actions';

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

export function SimClock({ now, appNow, realNow }: { now: string | null; appNow: string; realNow: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const ahead = now ? Math.round((Date.parse(now) - Date.parse(realNow)) / 86_400_000) : null;
  // More than a minute apart: Cleanpost is not following the simulator (demo time is off).
  const apart = now !== null && Math.abs(Date.parse(now) - Date.parse(appNow)) > 60_000;
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
            ? `${day(now)}${ahead ? ` (${ahead} ${ahead === 1 ? 'day' : 'days'} ahead)` : ''}`
            : 'payer simulator not answering'}
          {apart ? ` · Cleanpost is on ${day(appNow)}` : ''}
          {' · preview only'}
        </span>
      </span>
      <span className="spacer" />
      {[1, 7, 14].map((d) => (
        <Button key={d} size="sm" disabled={pending || !now} onClick={() => go(d)}>
          +{d} {d === 1 ? 'day' : 'days'}
        </Button>
      ))}
    </div>
  );
}
