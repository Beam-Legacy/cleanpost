import { describe, expect, it } from 'vitest';
import { reports } from '../src';

const {
  agingBucket,
  daysInAr,
  deltaTone,
  isSlowPayer,
  median,
  METRICS,
  periodFor,
  previousPeriod,
  rate,
  weeksOf,
} = reports;

describe('report metrics', () => {
  it('defines every metric with a formula and a good direction', () => {
    for (const m of Object.values(METRICS)) {
      expect(m.formula.length).toBeGreaterThan(10);
      expect(['up', 'down']).toContain(m.better);
    }
  });

  it('is green only when the change is good for the business', () => {
    expect(deltaTone('collections', 9)).toBe('good');
    expect(deltaTone('denialRate', -0.9)).toBe('good');
    expect(deltaTone('denialRate', 0.4)).toBe('bad');
    expect(deltaTone('daysInAr', null)).toBe('neutral');
  });

  it('computes rates, medians and days in A/R', () => {
    expect(rate(969, 1000)).toBe(96.9);
    expect(rate(1, 0)).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    // RP-07's example: $142,880 ÷ ($535,770 / 90) = 24.0
    expect(daysInAr(14_288_000, 53_577_000)).toBe(24);
    expect(daysInAr(100, 0)).toBeNull();
  });

  it('buckets age by calendar days and flags slow payers over 10% past 90 days', () => {
    expect([0, 30, 31, 60, 61, 90, 91, 120, 121].map(agingBucket)).toEqual([
      '0–30',
      '0–30',
      '31–60',
      '31–60',
      '61–90',
      '61–90',
      '91–120',
      '91–120',
      '120+',
    ]);
    expect(
      isSlowPayer({ '0–30': 41_220, '31–60': 18_900, '61–90': 12_640, '91–120': 6_080, '120+': 4_410 }),
    ).toBe(true);
    expect(
      isSlowPayer({ '0–30': 84_210, '31–60': 21_880, '61–90': 7_940, '91–120': 2_110, '120+': 880 }),
    ).toBe(false);
  });

  it('works out periods, the one before and its weeks', () => {
    expect(periodFor('this_month', '2026-11-03')).toEqual({ from: '2026-11-01', to: '2026-11-03' });
    expect(periodFor('last_month', '2026-11-03')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodFor('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodFor('last_90', '2026-11-03')).toEqual({ from: '2026-08-06', to: '2026-11-03' });
    expect(previousPeriod({ from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
    expect(weeksOf({ from: '2026-10-01', to: '2026-10-14' })).toEqual([
      '2026-09-28',
      '2026-10-05',
      '2026-10-12',
    ]);
  });
  it('writes CSV safely: quotes, formulas and comment lines', () => {
    expect(reports.csvCell('Lakeside, Family')).toBe('"Lakeside, Family"');
    expect(reports.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(reports.csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(reports.csvCell('-5')).toBe("'-5");
    expect(reports.csvCell(-5)).toBe('-5');
    expect(reports.csvCell(null)).toBe('');
    const csv = reports.toCsv(['Client', 'Claims'], [['A', 3]], reports.definitionComments(['firstPass']));
    expect(csv.split('\r\n')[0]).toMatch(/^# First-pass acceptance: Claims whose first 277CA/);
    expect(csv.endsWith('Client,Claims\r\nA,3\r\n')).toBe(true);
  });
});
