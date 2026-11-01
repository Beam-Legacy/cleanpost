import { describe, expect, it } from 'vitest';
import { formatCents, parseDollarsToCents, sumCents } from '../src/money';

describe('money', () => {
  it('parses dollars to integer cents without floats', () => {
    expect(parseDollarsToCents('145.00')).toBe(14500);
    expect(parseDollarsToCents('145.5')).toBe(14550);
    expect(parseDollarsToCents('$1,284.50')).toBe(128450);
    expect(parseDollarsToCents('0.1')).toBe(10);
    expect(parseDollarsToCents('-12.20')).toBe(-1220);
    expect(parseDollarsToCents('19.99')).toBe(1999); // 19.99 * 100 is 1998.9999 in floating point
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['', 'abc', '1.234', '1,23.00', '12.'])
      expect(parseDollarsToCents(bad), bad).toBeNull();
  });

  it('formats and sums', () => {
    expect(formatCents(128450)).toBe('$1,284.50');
    expect(formatCents(-1220)).toBe('-$12.20');
    expect(sumCents([12112, 2388])).toBe(14500);
    expect(() => formatCents(1.5)).toThrow();
  });
});
