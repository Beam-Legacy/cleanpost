import { describe, expect, it } from 'vitest';
import { records } from '../src';

const {
  changedFields,
  coverageEditSchema,
  coverageTask,
  dobProblem,
  fieldList,
  memberIdProblem,
  patientEditSchema,
} = records;

describe('coverage and patient corrections (P-02, P-06)', () => {
  it('checks member IDs by payer where the format is known', () => {
    expect(memberIdProblem('1EG4-TE5-MK73', 'Medicare (Noridian JF)')).toBeNull();
    expect(memberIdProblem('1EG4TE5MK73', 'Medicare (Noridian JF)')).toBeNull();
    expect(memberIdProblem('W123456789', 'Medicare (Noridian JF)')).toMatch(/MBI/);
    expect(memberIdProblem('W123456789', 'Aetna')).toBeNull();
    expect(memberIdProblem('W1 2345', 'Aetna')).toMatch(/letters, digits or dashes/);
  });

  it('refuses an end date before the start date and an impossible date of birth', () => {
    const base = { payerId: '01a00000-0000-7000-8000-0000000000a5', relationship: 'self', priority: 1 };
    expect(
      coverageEditSchema.safeParse({ ...base, effectiveDate: '2026-01-01', terminationDate: '2025-12-31' })
        .success,
    ).toBe(false);
    expect(coverageEditSchema.parse({ ...base, memberId: ' W1234 ' })).toMatchObject({
      memberId: 'W1234',
      checkEligibility: true,
    });
    expect(dobProblem('2027-01-01', '2026-11-06')).toMatch(/future/);
    expect(dobProblem('1900-01-01', '2026-11-06')).toMatch(/120/);
    expect(dobProblem('1984-03-07', '2026-11-06')).toBeNull();
    expect(
      patientEditSchema.safeParse({ firstName: 'A', lastName: 'B', dob: '1984-03-07', sex: 'F', phone: '12' })
        .success,
    ).toBe(false);
  });

  it('lists the fields that changed, treating blanks and nulls alike', () => {
    const before: Record<string, unknown> = {
      payerId: 'a',
      groupNumber: null,
      terminationDate: null,
      address: { line1: 'x', line2: null },
    };
    expect(
      changedFields(
        before,
        { payerId: 'b', groupNumber: '', terminationDate: '2026-12-31', address: { line1: 'x' } },
        ['payerId', 'groupNumber', 'terminationDate', 'address'],
      ),
    ).toEqual(['payerId', 'terminationDate']);
    expect(fieldList(['payerId', 'memberId', 'terminationDate'])).toBe('payer, member ID and end date');
  });

  it('describes the PM task without the corrected values or the patient', () => {
    const t = coverageTask({ payer: 'Aetna', fields: ['memberId'], pmName: 'Tebra' });
    expect(t.title).toBe('Update Aetna coverage in Tebra');
    expect(t.instructions[0]).toBe("In Tebra, open this patient's Aetna insurance and change the member ID.");
  });
});
