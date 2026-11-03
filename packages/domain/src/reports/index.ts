/**
 * Reports (RP-01 to RP-07, docs/09-ui-screens.md): metric definitions, periods, aging buckets and
 * the small calculations every report shares. Pure functions; the queries live with the screens.
 * The same definitions are shown in the app (RP-07), the PDF appendix (F-01) and CSV headers.
 */

export type MetricKey =
  | 'collections'
  | 'charges'
  | 'adjustments'
  | 'firstPass'
  | 'cleanClaim'
  | 'denialRate'
  | 'daysInAr'
  | 'chargeToSubmission'
  | 'remitToPosted'
  | 'releasedWithoutReview'
  | 'linesWithoutTouch';

export interface MetricDefinition {
  label: string;
  /** One sentence in plain words. */
  meaning: string;
  formula: string;
  includes: string;
  excludes: string;
  /** Which direction is good for the business (deltas are green only that way). */
  better: 'up' | 'down';
  unit: 'cents' | 'percent' | 'days';
}

export const METRICS: Record<MetricKey, MetricDefinition> = {
  collections: {
    label: 'Collections',
    meaning: 'What payers paid in the period.',
    formula: 'Sum of claim payments on 835s with a payment date in the period',
    includes: 'Insurance payments, including corrected claims',
    excludes: 'Patient payments and payments set aside as not ours',
    better: 'up',
    unit: 'cents',
  },
  charges: {
    label: 'Charges',
    meaning: 'What was billed for visits in the period.',
    formula: 'Sum of claim charges for dates of service in the period',
    includes: 'Every claim built, sent or not',
    excludes: 'Voided claims',
    better: 'up',
    unit: 'cents',
  },
  adjustments: {
    label: 'Adjustments',
    meaning: 'What payers took off the charges as contractual or denied.',
    formula: 'Sum of CO and OA adjustments on 835s paid in the period',
    includes: 'Contractual adjustments and denials',
    excludes: 'Patient responsibility (PR)',
    better: 'down',
    unit: 'cents',
  },
  firstPass: {
    label: 'First-pass acceptance',
    meaning: 'Share of claims the payer accepted the first time they were sent.',
    formula: 'Claims whose first 277CA was an acceptance ÷ claims with a 277CA in the period',
    includes: 'First submissions only',
    excludes: 'Corrected claims and resubmissions',
    better: 'up',
    unit: 'percent',
  },
  cleanClaim: {
    label: 'Clean claim rate',
    meaning: 'Share of claims accepted and paid without any correction.',
    formula:
      'Claims paid on the first version with no rejection or denial ÷ claims adjudicated in the period',
    includes: 'Claims with a payment decision in the period',
    excludes: 'Claims still waiting on the payer',
    better: 'up',
    unit: 'percent',
  },
  denialRate: {
    label: 'Denial rate',
    meaning: 'Share of adjudicated service lines the payer denied.',
    formula: 'Denied lines ÷ lines on 835s paid in the period',
    includes: 'Whole-line denials',
    excludes: 'Partial reductions and patient responsibility',
    better: 'down',
    unit: 'percent',
  },
  daysInAr: {
    label: 'Days in A/R',
    meaning: 'How many days of charges are waiting to be collected. Lower is better.',
    formula: 'Open insurance A/R ÷ average daily charges (last 90 days)',
    includes: 'Insurance balances on sent claims',
    excludes: 'Patient balances, voided and pre-go-live claims',
    better: 'down',
    unit: 'days',
  },
  chargeToSubmission: {
    label: 'Charge to submission',
    meaning: 'How long a visit takes to become a claim on its way to the payer.',
    formula: 'Median days from date of service to release',
    includes: 'Claims released in the period',
    excludes: 'Corrected claims',
    better: 'down',
    unit: 'days',
  },
  remitToPosted: {
    label: 'Remit to posted',
    meaning: 'How long a payment takes from arriving to being verified as posted.',
    formula: 'Median days from an 835 arriving to all its lines verified',
    includes: '835s that finished verification in the period',
    excludes: '835s still waiting on the PM',
    better: 'down',
    unit: 'days',
  },
  releasedWithoutReview: {
    label: 'Released without review',
    meaning: 'Share of claims released automatically, above the client’s confidence threshold.',
    formula: 'Claims released by automation ÷ all claims released in the period',
    includes: 'First releases',
    excludes: 'Corrected claims',
    better: 'up',
    unit: 'percent',
  },
  linesWithoutTouch: {
    label: 'ERA lines verified without touch',
    meaning: 'Share of payment lines that matched the PM’s posting with no one involved.',
    formula: 'Lines verified with no open item ever ÷ all lines on 835s in the period',
    includes: 'Lines on matched claims',
    excludes: 'Unmatched payments',
    better: 'up',
    unit: 'percent',
  },
};

export type Tone = 'good' | 'bad' | 'neutral';

/** Green only when the direction is good for the business (RP-01 rule). */
export function deltaTone(metric: MetricKey, delta: number | null): Tone {
  if (delta === null || delta === 0) return 'neutral';
  const up = delta > 0;
  return up === (METRICS[metric].better === 'up') ? 'good' : 'bad';
}

/** A ratio as a percent with one decimal, or null when there is nothing to divide. */
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Days in A/R: open insurance A/R over average daily charges for the last 90 days. */
export function daysInAr(openArCents: number, charges90DaysCents: number): number | null {
  if (charges90DaysCents <= 0) return null;
  return Math.round((openArCents / (charges90DaysCents / 90)) * 10) / 10;
}

export const AGING_BUCKETS = ['0–30', '31–60', '61–90', '91–120', '120+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Calendar days since first accepted submission (RP-03 rule), into its bucket. */
export function agingBucket(days: number): AgingBucket {
  if (days <= 30) return '0–30';
  if (days <= 60) return '31–60';
  if (days <= 90) return '61–90';
  if (days <= 120) return '91–120';
  return '120+';
}

/** A payer with more than 10% of its balance over 90 days is slow (RP-03). */
export function isSlowPayer(byBucket: Record<AgingBucket, number>): boolean {
  const total = AGING_BUCKETS.reduce((s, b) => s + byBucket[b], 0);
  const over90 = byBucket['91–120'] + byBucket['120+'];
  return total > 0 && over90 / total > 0.1;
}

// ---------- periods ----------

export type PeriodPreset = 'this_month' | 'last_month' | 'last_90' | 'last_30';

export interface Period {
  /** Inclusive, YYYY-MM-DD (Pacific calendar days). */
  from: string;
  /** Inclusive. */
  to: string;
}

const day = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The preset's days, given today's Pacific date. */
export function periodFor(preset: PeriodPreset, today: string): Period {
  const [y, m] = today.split('-').map(Number) as [number, number];
  if (preset === 'this_month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'last_month') {
    const first = Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1);
    const last = Date.UTC(y, m - 1, 0);
    return { from: ymdOf(first), to: ymdOf(last) };
  }
  const n = preset === 'last_90' ? 90 : 30;
  return { from: ymdOf(day(today) - (n - 1) * 86_400_000), to: today };
}

export const periodDays = (p: Period) => Math.round((day(p.to) - day(p.from)) / 86_400_000) + 1;

/** The period of equal length just before (RP-01 comparison). */
export function previousPeriod(p: Period): Period {
  const n = periodDays(p);
  return { from: ymdOf(day(p.from) - n * 86_400_000), to: ymdOf(day(p.from) - 86_400_000) };
}

/** Monday-start weeks covering the period, for weekly charts. */
export function weeksOf(p: Period): string[] {
  const start = day(p.from);
  const dow = (new Date(start).getUTCDay() + 6) % 7;
  const out: string[] = [];
  for (let t = start - dow * 86_400_000; t <= day(p.to); t += 7 * 86_400_000) out.push(ymdOf(t));
  return out;
}

// ---------- CSV (RP-06) ----------

export type CsvCell = string | number | null;

/**
 * One CSV cell: quoted when it holds a comma, quote or line break; text that a spreadsheet would
 * run as a formula (=, +, -, @ at the start) is prefixed with an apostrophe. Numbers stay numbers.
 */
export function csvCell(v: CsvCell): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** A CSV file: `#` comment lines (the metric definitions, as RP-07 shows them), header, rows. */
export function toCsv(header: string[], rows: CsvCell[][], comments: string[] = []): string {
  const lines = [
    ...comments.map((c) => `# ${c.replaceAll(/[\r\n]+/g, ' ')}`),
    header.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** The definition comment lines for the metrics a CSV carries. */
export const definitionComments = (keys: MetricKey[]) =>
  keys.map(
    (k) =>
      `${METRICS[k].label}: ${METRICS[k].formula}. Includes ${METRICS[k].includes.toLowerCase()}; excludes ${METRICS[k].excludes.toLowerCase()}.`,
  );
