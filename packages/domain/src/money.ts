/**
 * Money is integer cents (CLAUDE.md rule 5). These parse and format without floating point.
 */
export type Cents = number;

const DOLLARS_RE = /^(-)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/** "145", "145.5", "$1,284.50", "-12.20" -> cents. Returns null for anything else. */
export function parseDollarsToCents(input: string): Cents | null {
  const m = DOLLARS_RE.exec(input.trim());
  if (!m) return null;
  const whole = Number(m[2]!.replace(/,/g, ''));
  const frac = Number((m[3] ?? '0').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents)) return null;
  return m[1] ? -cents : cents;
}

/** cents -> "$1,284.50" (docs/10-design-system.md). */
export function formatCents(cents: Cents): string {
  if (!Number.isInteger(cents)) throw new Error('cents must be an integer');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export const sumCents = (values: Cents[]): Cents => values.reduce((a, b) => a + b, 0);
