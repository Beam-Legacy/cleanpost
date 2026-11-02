import { describe, expect, it } from 'vitest';
import { claimStatus } from '../src';

const result = (over: Partial<claimStatus.ClaimStatusResult>): claimStatus.ClaimStatusResult => ({
  category: 'P1',
  code: '20',
  entityCode: '41',
  effectiveDate: '2026-10-12',
  payerClaimNumber: 'MD26-8810442',
  patientAccountNumber: 'CPD-26-002210',
  submittedCents: 41_000,
  paidCents: 0,
  paidDate: null,
  checkNumber: null,
  checkIssueDate: null,
  ...over,
});
const ctx = {
  payerName: 'Moda Health',
  pmName: 'Tebra',
  paymentArrived: false,
  patientControlNumber: 'CPD-26-002210',
};

describe('claim status advice (C-15)', () => {
  it('sorts every category into a kind', () => {
    const kinds = Object.fromEntries(
      ['A1', 'A2', 'A3', 'A4', 'A7', 'D0', 'P1', 'P3', 'P4', 'R4', 'F1', 'F2', 'F4', 'E1'].map((c) => [
        c,
        claimStatus.statusKind(c),
      ]),
    );
    expect(kinds).toEqual({
      A1: 'received',
      A2: 'received',
      A3: 'rejected',
      A4: 'not_found',
      A7: 'rejected',
      D0: 'not_found',
      P1: 'pending',
      P3: 'needs_info',
      P4: 'needs_info',
      R4: 'needs_info',
      F1: 'paid',
      F2: 'denied',
      F4: 'no_payment',
      E1: 'error',
    });
    expect(claimStatus.payerHasClaim('pending')).toBe(true);
    expect(claimStatus.payerHasClaim('not_found')).toBe(false);
  });

  it('turns a records pend into a task to send the visit note', () => {
    const a = claimStatus.adviseStatus(result({ category: 'P3', code: '21' }), ctx);
    expect(a.headline).toBe('Pended: waiting for medical records.');
    expect(a.suggestion).toBe(
      'Ask the practice for the visit note and send it to Moda Health as a claim attachment.',
    );
    expect(a.task?.operation).toBe('requestRecords');
    expect(a.task?.instructions.join(' ')).toContain('quoting payer claim number MD26-8810442');
  });

  it('says a paid claim’s payment has not arrived until the 835 is in', () => {
    const paid = result({
      category: 'F1',
      code: '65',
      paidCents: 31_200,
      paidDate: '2026-10-20',
      checkNumber: 'EFT77',
    });
    expect(claimStatus.adviseStatus(paid, ctx).headline).toBe(
      'Paid on Oct 20; the payment has not arrived yet.',
    );
    expect(claimStatus.adviseStatus(paid, ctx).explanation).toContain('$312.00 (check or EFT EFT77)');
    expect(claimStatus.adviseStatus(paid, { ...ctx, paymentArrived: true }).headline).toBe('Paid on Oct 20.');
  });

  it('asks for a resubmission when the payer has no record or returned it', () => {
    expect(claimStatus.adviseStatus(result({ category: 'A4', code: '35' }), ctx).task?.operation).toBe(
      'resubmitClaim',
    );
    const returned = claimStatus.adviseStatus(result({ category: 'A3', code: '21' }), ctx);
    expect(returned.explanation).toBe(
      'Returned as unprocessable: missing or invalid information. Nothing will be paid on it as sent.',
    );
    expect(claimStatus.adviseStatus(result({}), ctx).task).toBeNull();
  });

  it('explains codes it does not know without guessing', () => {
    expect(claimStatus.categoryLabel('R7')).toBe('Payer asks for more information');
    expect(claimStatus.statusCodeLabel('999')).toBe('Status 999 (see the payer’s portal)');
  });
});
