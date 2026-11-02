/**
 * M3 acceptance: every golden 835 parses and balances (docs/07-remittance-posting.md cases), and
 * one that does not balance is caught. Files: packages/testing/golden/835 (synthetic).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { remit } from '@cleanpost/domain';
import { parse835, toCents, X12Error } from '../src';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testing', 'golden', '835');
const read = (name: string) => parse835(readFileSync(join(DIR, name), 'utf8'));

describe('amounts', () => {
  it('converts decimal text to integer cents without floats', () => {
    expect(toCents('145')).toBe(14_500);
    expect(toCents('145.5')).toBe(14_550);
    expect(toCents('-2.15')).toBe(-215);
    expect(toCents('0.07')).toBe(7);
    expect(toCents('')).toBe(0);
    expect(() => toCents('1,000.00')).toThrow(X12Error);
  });
});

describe('golden 835s', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.edi') && f !== 'out-of-balance.edi');

  it.each(files)('%s parses and balances', (name) => {
    const r = read(name);
    expect(r.payment.traceNumber).not.toBe('');
    expect(r.payment.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.claims.length).toBeGreaterThan(0);
    expect(remit.balance835(r)).toEqual({ balanced: true, claims: [], remittanceDifferenceCents: 0 });
  });

  it('paid in full: payment, payer, line with allowed amount and line control number', () => {
    const r = read('paid-in-full.edi');
    expect(r.payment).toEqual({
      method: 'ACH',
      amountCents: 12_000,
      paymentDate: '2026-11-01',
      traceNumber: '1EFT0001',
    });
    expect(r.payer).toEqual({ name: 'AETNA SIM', id: 'SIMAETNA' });
    expect(r.payee.npi).toBe('1487726595');
    const [c] = r.claims;
    expect(c).toMatchObject({
      patientControlNumber: 'LFM-E10001',
      statusCode: '1',
      chargeCents: 14_500,
      paidCents: 12_000,
    });
    expect(c!.lines[0]).toMatchObject({
      code: '99213',
      allowedCents: 12_000,
      lineControlNumber: 'LFM-E10001-1',
      serviceDate: '2026-10-27',
      adjustments: [{ group: 'CO', carc: '45', amountCents: 2500 }],
    });
  });

  it('partial with deductible: patient responsibility, modifiers and remark codes', () => {
    const [c] = read('partial-deductible.edi').claims;
    expect(c!.patientRespCents).toBe(5000);
    expect(c!.lines[0]!.modifiers).toEqual(['25']);
    expect(c!.lines[0]!.adjustments.map((a) => `${a.group}-${a.carc}`)).toEqual(['PR-1', 'CO-45']);
    expect(c!.lines[0]!.remarks).toEqual(['N130']);
  });

  it('denied with CO-197: status 4, nothing paid, no payment', () => {
    const r = read('denied-co197.edi');
    expect(r.payment.method).toBe('NON');
    expect(r.claims[0]).toMatchObject({ statusCode: '4', paidCents: 0 });
    expect(r.claims[0]!.remarks).toEqual(['N4']);
  });

  it('several claims on one check', () => {
    const r = read('multiple-claims.edi');
    expect(r.payment.method).toBe('CHK');
    expect(r.claims.map((c) => c.patientControlNumber)).toEqual(['CAS-E10004', 'CAS-E10005', 'CAS-E10006']);
  });

  it('reversal and correction: CLP02 22 with negative amounts, then the corrected claim (frequency 7)', () => {
    const [rev, cor] = read('reversal-correction.edi').claims;
    expect(rev).toMatchObject({ statusCode: '22', chargeCents: -14_500, paidCents: -12_000 });
    expect(cor).toMatchObject({ statusCode: '1', paidCents: 13_000, frequencyCode: '7' });
  });

  it('secondary crossover: processed as primary and forwarded (19) to another payer', () => {
    const [c] = read('secondary-crossover.edi').claims;
    expect(c).toMatchObject({ statusCode: '19', crossoverPayerName: 'OREGON HEALTH PLAN' });
  });

  it('PLB interest (negative) and recoupment (positive) reconcile to the payment', () => {
    const r = read('plb-interest-recoupment.edi');
    expect(r.providerAdjustments).toEqual([
      { reasonCode: 'L6', reference: null, amountCents: -215 },
      { reasonCode: 'WO', reference: '2026290001111', amountCents: 4000 },
    ]);
  });

  it('finds an 835 that does not balance, per claim and per remittance', () => {
    expect(remit.balance835(read('out-of-balance.edi'))).toEqual({
      balanced: false,
      claims: [{ patientControlNumber: 'LFM-E10011', differenceCents: 500 }],
      remittanceDifferenceCents: -500,
    });
  });

  it('refuses something that is not an 835', () => {
    expect(() => parse835('hello')).toThrow(X12Error);
  });
});
