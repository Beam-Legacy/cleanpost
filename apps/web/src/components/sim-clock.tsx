'use client';
/** Preview only: the payer simulator's date and buttons to move it forward (admins). */
import { useTransition } from 'react';
import { Clock } from 'lucide-react';
import { Button, useToast } from '@cleanpost/ui';
import { advanceClock } from '@/app/(app)/sim-actions';

export function SimClock({ now, realNow }: { now: string | null; realNow: string }) {
  const [pending, start] = useTransition();
  const toast = useToast();
  const ahead = now ? Math.round((Date.parse(now) - Date.parse(realNow)) / 86_400_000) : null;
  const go = (days: number) =>
    start(async () => {
      const res = await advanceClock(days);
      toast({ message: res.message, ...(res.ok ? {} : { tone: 'bad' as const }) });
    });
  return (
    <div
      className="card card-body row"
      role="group"
      aria-label="Payer simulator"
      style={{ gap: 12, padding: '8px 12px' }}
    >
      <Clock aria-hidden />
      <span>
        <b>Payer simulator</b>{' '}
        <span className="muted">
          {now
            ? `simulated date ${new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}${ahead ? ` (${ahead} ${ahead === 1 ? 'day' : 'days'} ahead)` : ''}`
            : 'not answering'}
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
