import { describe, expect, it } from 'vitest';
import { remit, type ClaimPayload } from '../src';

const ncci = [
  { column1: '20610', column2: '76942', modifierIndicator: '0' },
  { column1: '97140', column2: '97530', modifierIndicator: '1' },
];

function claim(lines: { code: string; modifiers?: string[] }[]): ClaimPayload {
  return {
    lines: lines.map((l, i) => ({ lineNumber: i + 1, code: l.code, modifiers: l.modifiers ?? [] })),
  } as unknown as ClaimPayload;
}
const denied = (
  lineNumber: number,
  code: string,
  carc: string,
  remarks: string[] = [],
): remit.DeniedLine => ({
  lineNumber,
  code,
  modifiers: [],
  group: 'CO',
  carc,
  amountCents: 13_500,
  remarks,
});

describe('denial advice', () => {
  it('suggests modifier 25 for an office visit denied CO-4 beside a procedure', () => {
    const a = remit.adviseDenial(
      claim([{ code: '99213' }, { code: '20610', modifiers: ['RT'] }]),
      denied(1, '99213', '4', ['N822']),
      ncci,
    );
    expect(a).toMatchObject({ kind: 'coding', correctable: true, primary: 'correct' });
    expect(a.suggestion).toEqual({
      label: 'Add modifier 25 to line 1 (99213)',
      fix: { op: 'addModifier', lineMatch: { codeIn: ['99213'] }, modifier: '25' },
      lineNumbers: [1],
      needsInput: false,
    });
  });

  it('suggests 59 where the NCCI edit allows it, and a write-off where it does not', () => {
    const ok = remit.adviseDenial(
      claim([{ code: '97140' }, { code: '97530' }]),
      denied(2, '97530', '97', ['M15']),
      ncci,
    );
    expect(ok.suggestion?.label).toBe('Add modifier 59 to line 2 (97530)');
    const never = remit.adviseDenial(
      claim([{ code: '20610' }, { code: '76942' }]),
      denied(2, '76942', '97', ['M15']),
      ncci,
    );
    expect(never).toMatchObject({
      kind: 'bundling',
      correctable: false,
      primary: 'write_off',
      suggestion: null,
    });
  });

  it('asks for the authorization number, and sends eligibility and timely filing elsewhere', () => {
    const auth = remit.adviseDenial(claim([{ code: '29881' }]), denied(1, '29881', '197'), ncci);
    expect(auth).toMatchObject({ kind: 'authorization', primary: 'correct' });
    expect(auth.suggestion).toMatchObject({ needsInput: true, label: 'Add the prior authorization number' });
    expect(remit.adviseDenial(claim([{ code: '99213' }]), denied(1, '99213', '27'), ncci)).toMatchObject({
      kind: 'eligibility',
      correctable: false,
      primary: 'check_coverage',
    });
    expect(remit.adviseDenial(claim([{ code: '99213' }]), denied(1, '99213', '29'), ncci)).toMatchObject({
      kind: 'timely_filing',
      primary: 'write_off',
    });
    expect(remit.denialKind('B7')).toBe('provider_enrollment');
    expect(remit.denialKind('999')).toBe('other');
  });
});
