/**
 * Report display helpers shared by server pages and client components (RP-01 to RP-07): the
 * period presets, period labels and the delta wording ("+9% vs September", "−0.9 pts").
 */
import { reports } from '@cleanpost/domain';

export const PERIOD_OPTIONS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
] as const;

export type PeriodValue = (typeof PERIOD_OPTIONS)[number]['value'];

export function resolvePeriod(param: string | undefined, today: string) {
  const preset = (PERIOD_OPTIONS.find((o) => o.value === param)?.value ?? 'last_30') as PeriodValue;
  const period = reports.periodFor(preset, today);
  return { preset, period, label: periodLabel(period) };
}

const md = (ymd: string, year = false) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });

export function periodLabel(p: reports.Period): string {
  return `${md(p.from)} – ${md(p.to, true)}`;
}

/** The change against the period before, worded for a KPI tile; null when either side is missing. */
export function deltaFor(
  metric: reports.MetricKey,
  now: number | null,
  before: number | null,
  previous: reports.Period,
): { text: string; tone: reports.Tone } | null {
  if (now === null || before === null) return null;
  const unit = reports.METRICS[metric].unit;
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±');
  const vs = `vs ${md(previous.from)} – ${md(previous.to)}`;
  if (unit === 'cents') {
    if (before === 0) return null;
    const pct = Math.round(((now - before) / before) * 100);
    return { text: `${sign(pct)}${Math.abs(pct)}% ${vs}`, tone: reports.deltaTone(metric, pct) };
  }
  const diff = Math.round((now - before) * 10) / 10;
  const word = unit === 'percent' ? 'pts' : 'days';
  return { text: `${sign(diff)}${Math.abs(diff)} ${word} ${vs}`, tone: reports.deltaTone(metric, diff) };
}

export type Unit = 'percent' | 'count' | 'cents' | 'days';

/** A report figure as shown in tiles, charts and the PDF. */
export function formatValue(v: number | null, unit: Unit): string {
  if (v === null) return '—';
  if (unit === 'percent') return `${v.toFixed(1)}%`;
  if (unit === 'cents')
    return (v / 100).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    });
  if (unit === 'days') return `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })} days`;
  return v.toLocaleString('en-US');
}
