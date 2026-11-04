/**
 * The onboarding baseline (CL-02, RP-02, F-01): the practice's figures before Cleanpost, typed by an
 * admin from the practice's own reports, so results can be shown against where the practice started.
 * Totals and rates only, no patient data.
 */
import { z } from 'zod';
import { deltaTone, type MetricKey, type Tone } from '../reports';

export const baselineInputSchema = z.object({
  /** Collections in a typical month before Cleanpost, cents. */
  collectionsCents: z.number().int().min(0).max(1_000_000_000_00).nullable(),
  /** Percent, 0..100. */
  firstPass: z.number().min(0).max(100).nullable(),
  denialRate: z.number().min(0).max(100).nullable(),
  daysInAr: z.number().min(0).max(365).nullable(),
  /** Where the figures came from, e.g. "Practice's PM reports, Jan to Jun 2026". */
  source: z.string().trim().max(200).nullable(),
});
export type BaselineInput = z.infer<typeof baselineInputSchema>;

export interface ClientBaseline extends BaselineInput {
  recordedAt: string;
  /** user:<id> */
  recordedBy: string;
}

export function readBaseline(raw: unknown): ClientBaseline | null {
  const parsed = baselineInputSchema
    .extend({ recordedAt: z.string(), recordedBy: z.string() })
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A KPI against the baseline: collections as a change ("+11% vs baseline month"), rates and days as
 * the baseline value, toned good or bad by the metric's better direction. null without a baseline.
 */
export function vsBaseline(
  metric: Extract<MetricKey, 'collections' | 'firstPass' | 'denialRate' | 'daysInAr'>,
  value: number | null,
  baseline: ClientBaseline | null,
): { text: string; tone: Tone } | null {
  if (!baseline) return null;
  const base =
    metric === 'collections'
      ? baseline.collectionsCents
      : metric === 'firstPass'
        ? baseline.firstPass
        : metric === 'denialRate'
          ? baseline.denialRate
          : baseline.daysInAr;
  if (base === null) return null;
  if (value === null) return { text: `Baseline ${fmt(metric, base)}`, tone: 'neutral' };
  if (metric === 'collections') {
    if (base === 0) return { text: 'Baseline month $0', tone: 'neutral' };
    const change = Math.round(((value - base) / base) * 100);
    return {
      text: `${change > 0 ? '+' : ''}${change}% vs baseline month`,
      tone: deltaTone('collections', change),
    };
  }
  return { text: `Baseline ${fmt(metric, base)}`, tone: deltaTone(metric, value - base) };
}

function fmt(metric: string, v: number): string {
  if (metric === 'collections') return `$${Math.round(v / 100).toLocaleString('en-US')}`;
  if (metric === 'daysInAr') return String(Math.round(v));
  return `${v.toFixed(1)}%`;
}
