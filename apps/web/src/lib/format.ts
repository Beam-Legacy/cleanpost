import { now as clockNow } from '@cleanpost/clock';
import { formatCents } from '@cleanpost/domain';
/** Formats from docs/10-design-system.md: "Oct 29, 2026", "2:14 pm PT", "94.2%", "$1,284.50". */
const TZ = 'America/Los_Angeles';

export function formatWhen(d: Date | null | undefined, now = clockNow()): string {
  if (!d) return '—';
  const sameDay =
    d.toLocaleDateString('en-US', { timeZone: TZ }) === now.toLocaleDateString('en-US', { timeZone: TZ });
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
    .replace(' AM', ' am')
    .replace(' PM', ' pm');
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: TZ })}, ${time}`;
}

export function formatDuration(start: Date, end: Date | null): string {
  if (!end) return '—';
  const s = (end.getTime() - start.getTime()) / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s / 60)} min`;
}

export const formatCount = (n: number) => n.toLocaleString('en-US');

/** Start and end of the Pacific-time day containing `now` (summary strip "today"). */
export function pacificDay(now = clockNow()): { start: Date; end: Date } {
  const ymd = now.toLocaleDateString('en-CA', { timeZone: TZ });
  for (const offset of ['-07:00', '-08:00']) {
    const start = new Date(`${ymd}T00:00:00${offset}`);
    if (
      start.toLocaleDateString('en-CA', { timeZone: TZ }) === ymd &&
      new Date(start.getTime() - 1).toLocaleDateString('en-CA', { timeZone: TZ }) !== ymd
    ) {
      return { start, end: new Date(start.getTime() + 86_400_000 - 1) };
    }
  }
  const start = new Date(`${ymd}T00:00:00-08:00`);
  return { start, end: new Date(start.getTime() + 86_400_000 - 1) };
}

/** "$1,284.50": cents always shown in detail views (docs/10). */
export function formatMoney(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : formatCents(cents);
}

/** "Oct 27, 2026" for a date of service (a `date`, not an instant). */
export function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
