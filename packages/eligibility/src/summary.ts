/**
 * The 271 as Cleanpost stores it (`eligibility_checks.summary`): status, plan dates and cost
 * sharing, never identifiers. Stedi's response shape (docs/15-integrations-reference.md); X12 codes:
 * benefitsInformation 1 Active Coverage, 6 Inactive, B Co-Payment, C Deductible, A Co-Insurance.
 */
import { z } from 'zod';

const benefit = z
  .object({
    code: z.string().optional(),
    benefitAmount: z.string().optional(),
    benefitPercent: z.string().optional(),
    inPlanNetworkIndicatorCode: z.string().optional(),
  })
  .loose();

export const response271Schema = z
  .object({
    benefitsInformation: z.array(benefit).optional(),
    planStatus: z.array(z.object({ statusCode: z.string().optional() }).loose()).optional(),
    planDateInformation: z
      .object({
        planBegin: z.string().optional(),
        planEnd: z.string().optional(),
        plan: z.string().optional(),
      })
      .loose()
      .optional(),
    errors: z.array(z.object({ code: z.string().optional() }).loose()).optional(),
  })
  .loose();

export interface EligibilitySummary {
  status: 'active' | 'inactive' | 'error' | 'unknown';
  planBegin: string | null;
  planEnd: string | null;
  copayCents: number | null;
  deductibleRemainingCents: number | null;
  coinsurancePercent: number | null;
  /** AAA codes, e.g. 75 subscriber not found. */
  errorCodes: string[];
}

const toCents = (s: string | undefined) => {
  if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [d, c = ''] = s.split('.');
  return Number(d) * 100 + Number(c.padEnd(2, '0'));
};
const isoDate = (s: string | undefined) =>
  s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;

export function summarize271(json: unknown): EligibilitySummary {
  const parsed = response271Schema.safeParse(json);
  const empty: EligibilitySummary = {
    status: 'unknown',
    planBegin: null,
    planEnd: null,
    copayCents: null,
    deductibleRemainingCents: null,
    coinsurancePercent: null,
    errorCodes: [],
  };
  if (!parsed.success) return empty;
  const r = parsed.data;
  const errorCodes = (r.errors ?? []).map((e) => e.code ?? '').filter(Boolean);
  if (errorCodes.length) return { ...empty, status: 'error', errorCodes };
  const b = r.benefitsInformation ?? [];
  const codes = new Set([...b.map((x) => x.code), ...(r.planStatus ?? []).map((p) => p.statusCode)]);
  const status = codes.has('1') ? 'active' : codes.has('6') ? 'inactive' : 'unknown';
  const inNetwork = (code: string) =>
    b.find((x) => x.code === code && x.inPlanNetworkIndicatorCode !== 'N') ?? b.find((x) => x.code === code);
  const pct = inNetwork('A')?.benefitPercent;
  const [rangeBegin, rangeEnd] = (r.planDateInformation?.plan ?? '').split('-');
  return {
    status,
    planBegin: isoDate(r.planDateInformation?.planBegin ?? rangeBegin),
    planEnd: isoDate(r.planDateInformation?.planEnd ?? rangeEnd),
    copayCents: toCents(inNetwork('B')?.benefitAmount),
    deductibleRemainingCents: toCents(inNetwork('C')?.benefitAmount),
    coinsurancePercent: pct && /^\d*(\.\d+)?$/.test(pct) ? Math.round(Number(pct) * 100) : null,
    errorCodes: [],
  };
}
