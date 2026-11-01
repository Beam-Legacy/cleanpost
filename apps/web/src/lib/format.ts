/** Formats from docs/10-design-system.md: "Oct 29, 2026", "2:14 pm PT", "94.2%", "$1,284.50". */
const TZ = 'America/Los_Angeles';

export function formatWhen(d: Date | null | undefined, now = new Date()): string {
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
