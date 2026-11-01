import { describe, expect, it } from 'vitest';
import { scanForPhi } from '@cleanpost/testing';
import { parseChargeCsv } from '../src';
import { CHARGE_CSV } from './fixtures';

describe('charge CSV', () => {
  it('groups lines into encounters with integer cents', () => {
    const { patients, encounters, errors } = parseChargeCsv(CHARGE_CSV, new Date('2026-10-28T10:00:00Z'));
    expect(errors).toEqual([]);
    expect(patients).toHaveLength(2);
    expect(encounters.map((e) => e.lines.length)).toEqual([2, 1]);
    expect(encounters[0]!.lines[1]).toMatchObject({
      code: '97110',
      modifiers: ['GP'],
      units: 2,
      chargeCents: 121050,
    });
    expect(encounters[1]!.diagnoses.map((d) => d.icd10)).toEqual(['E11.9', 'I10']);
    expect(encounters[1]!.lines[0]!.diagnosisPointers).toEqual([1, 2]);
  });

  it('reports problems by row and column without echoing values', () => {
    const bad = CHARGE_CSV.replace('145.00', 'Nguyen').replace(',1,210.00,', ',0,210.00,');
    const { errors } = parseChargeCsv(bad, new Date());
    expect(errors).toEqual([
      { row: 2, column: 'charge', problem: 'Not a dollar amount' },
      { row: 4, column: 'units', problem: 'Must be a whole number of 1 or more' },
    ]);
    expect(scanForPhi(JSON.stringify(errors))).toEqual([]);
  });

  it('rejects files missing template columns', () => {
    expect(parseChargeCsv('encounter_id,code\nE1,99213', new Date()).errors[0]!.problem).toMatch(
      /Missing columns/,
    );
  });
});
