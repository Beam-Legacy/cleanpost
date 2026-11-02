import { describe, expect, it } from 'vitest';
import { applyFix, checkEdit, diffPayload, isOneClickFix, type ClaimPayload } from '../src';

const payload = (): ClaimPayload => ({
  frequencyCode: '1',
  patientId: 'pat-1',
  coverageId: 'cov-1',
  payerId: 'payer-uhc',
  payerName: 'UnitedHealthcare',
  billing: { npi: '1487726595', taxonomy: null },
  rendering: { providerId: 'prov-1', npi: '1932204415', taxonomy: null },
  referringNpi: null,
  facility: { locationId: 'loc-1', placeOfService: '11', npi: null },
  dateOfService: '2026-10-27',
  priorAuthNumber: null,
  diagnoses: [
    { sequence: 1, icd10: 'E11.9' },
    { sequence: 2, icd10: 'L82.1' },
  ],
  lines: [
    {
      lineNumber: 1,
      chargeLineId: 'cl-1',
      code: '99213',
      modifiers: [],
      units: 1,
      chargeCents: 14_500,
      dxPointers: [1],
      ndc: null,
      dateOfService: '2026-10-27',
    },
    {
      lineNumber: 2,
      chargeLineId: 'cl-2',
      code: '11102',
      modifiers: [],
      units: 1,
      chargeCents: 16_700,
      dxPointers: [2],
      ndc: null,
      dateOfService: '2026-10-27',
    },
  ],
  totalChargeCents: 31_200,
});

describe('applyFix', () => {
  it('adds modifier 25 to the visit line only', () => {
    const res = applyFix(payload(), {
      op: 'addModifier',
      lineMatch: { codeInGroup: 'em_office', modifierNotIn: ['25', '57'] },
      modifier: '25',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.lines.map((l) => l.modifiers)).toEqual([['25'], []]);
    expect(res.value.changes).toEqual([
      {
        fieldPath: 'lines[0].modifiers',
        before: [],
        after: ['25'],
        chargeLineId: 'cl-1',
        label: 'Line 1 modifier 25 added',
      },
    ]);
  });

  it('stays within the lines the finding named', () => {
    const res = applyFix(payload(), { op: 'addModifier', lineMatch: {}, modifier: '59' }, [2]);
    expect(res.ok && res.value.payload.lines.map((l) => l.modifiers)).toEqual([[], ['59']]);
  });

  it('removes a line, renumbers and recomputes the total', () => {
    const res = applyFix(payload(), { op: 'removeLine', lineMatch: { codeIn: ['11102'] } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.payload.lines).toHaveLength(1);
    expect(res.value.payload.totalChargeCents).toBe(14_500);
    expect(res.value.changes.map((c) => c.label)).toEqual(['Line 2 (11102) removed']);
  });

  it('refuses to remove the last line', () => {
    expect(applyFix(payload(), { op: 'removeLine', lineMatch: {} })).toEqual({
      ok: false,
      error: 'would_empty_claim',
    });
  });

  it('sends choices that need a person to the editor', () => {
    expect(applyFix(payload(), { op: 'setPayer' })).toEqual({ ok: false, error: 'needs_editor' });
    expect(isOneClickFix({ op: 'reorderDiagnoses' })).toBe(false);
    expect(isOneClickFix({ op: 'addModifier', lineMatch: {}, modifier: '25' })).toBe(true);
  });

  it('reports a fix that changes nothing', () => {
    const p = payload();
    p.lines[0]!.modifiers = ['25'];
    expect(applyFix(p, { op: 'addModifier', lineMatch: { codeIn: ['99213'] }, modifier: '25' })).toEqual({
      ok: false,
      error: 'no_change',
    });
  });
});

describe('diffPayload', () => {
  it('lists one change per field', () => {
    const before = payload();
    const after = payload();
    after.lines[1]!.units = 2;
    after.lines[1]!.dxPointers = [1, 2];
    after.priorAuthNumber = 'PA123';
    expect(diffPayload(before, after).map((c) => c.fieldPath)).toEqual([
      'lines[1].units',
      'lines[1].dxPointers',
      'priorAuthNumber',
    ]);
  });
});

describe('checkEdit', () => {
  it('accepts code, modifier, units, pointer and diagnosis edits', () => {
    const after = payload();
    after.lines[0]!.modifiers = ['25'];
    after.diagnoses = [
      { sequence: 7, icd10: 'E11.65' },
      { sequence: 9, icd10: 'L82.1' },
    ];
    const res = checkEdit(payload(), after);
    expect(res.ok && res.value.diagnoses.map((d) => d.sequence)).toEqual([1, 2]);
  });

  it('refuses changes to the patient, payer or charge amounts', () => {
    const a = payload();
    a.payerId = 'payer-aetna';
    expect(checkEdit(payload(), a)).toEqual({ ok: false, error: 'locked_field_changed' });
    const b = payload();
    b.lines[0]!.chargeCents = 1;
    expect(checkEdit(payload(), b)).toEqual({ ok: false, error: 'locked_field_changed' });
  });

  it('refuses invalid values and new lines', () => {
    const a = payload();
    a.lines[0]!.dxPointers = [3];
    expect(checkEdit(payload(), a)).toEqual({ ok: false, error: 'invalid_value' });
    const b = payload();
    b.lines.push({ ...b.lines[0]!, chargeLineId: 'new' });
    expect(checkEdit(payload(), b)).toEqual({ ok: false, error: 'line_added' });
  });
});
