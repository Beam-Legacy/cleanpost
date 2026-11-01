/**
 * Charge CSV import (template in docs/15-integrations-reference.md). One row per charge line;
 * rows sharing an encounter_id form one encounter. Errors name the row and column, never the value.
 */
import { parseDollarsToCents } from '@cleanpost/domain';
import type { ExtEncounter, ExtPatient } from '../contract';
import { extEncounterSchema, extPatientSchema } from '../schemas';
import { parseCsv } from './csv';

export const CHARGE_CSV_COLUMNS = [
  'encounter_id',
  'patient_id',
  'patient_last',
  'patient_first',
  'dob',
  'sex',
  'payer_name',
  'member_id',
  'group_number',
  'relationship',
  'dos',
  'rendering_npi',
  'location_id',
  'pos',
  'dx1',
  'dx2',
  'dx3',
  'dx4',
  'line_id',
  'code',
  'mod1',
  'mod2',
  'mod3',
  'mod4',
  'units',
  'charge',
  'dx_pointers',
] as const;

export interface ChargeCsvError {
  row: number;
  column?: string;
  problem: string;
}

export interface ChargeCsvResult {
  patients: ExtPatient[];
  encounters: ExtEncounter[];
  errors: ChargeCsvError[];
}

export function parseChargeCsv(text: string, receivedAt: Date): ChargeCsvResult {
  const errors: ChargeCsvError[] = [];
  const [header, ...rows] = parseCsv(text);
  if (!header) return { patients: [], encounters: [], errors: [{ row: 1, problem: 'The file is empty' }] };
  const missing = CHARGE_CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length)
    return {
      patients: [],
      encounters: [],
      errors: [{ row: 1, problem: `Missing columns: ${missing.join(', ')}` }],
    };
  const col = (r: string[], name: (typeof CHARGE_CSV_COLUMNS)[number]) =>
    (r[header.indexOf(name)] ?? '').trim();
  const updatedAt = receivedAt.toISOString();
  const patients = new Map<string, ExtPatient>();
  const encounters = new Map<string, ExtEncounter>();

  rows.forEach((r, i) => {
    const rowNo = i + 2;
    const charge = parseDollarsToCents(col(r, 'charge'));
    if (charge === null) return errors.push({ row: rowNo, column: 'charge', problem: 'Not a dollar amount' });
    const units = Number(col(r, 'units') || '1');
    if (!Number.isInteger(units) || units < 1)
      return errors.push({ row: rowNo, column: 'units', problem: 'Must be a whole number of 1 or more' });
    const pointers = col(r, 'dx_pointers')
      .split(/[\s:;|]+/)
      .filter(Boolean)
      .map(Number);
    const sex = (col(r, 'sex') || 'U').toUpperCase();
    const patientId = col(r, 'patient_id');
    if (!patients.has(patientId)) {
      const relationship = (col(r, 'relationship') || 'self').toLowerCase();
      patients.set(patientId, {
        externalId: patientId,
        firstName: col(r, 'patient_first'),
        lastName: col(r, 'patient_last'),
        dob: col(r, 'dob'),
        sex: (['M', 'F', 'U'].includes(sex) ? sex : 'U') as ExtPatient['sex'],
        coverages: col(r, 'payer_name')
          ? [
              {
                externalId: `${patientId}:1`,
                payerName: col(r, 'payer_name'),
                priority: 1,
                memberId: col(r, 'member_id'),
                groupNumber: col(r, 'group_number') || undefined,
                relationship: (['self', 'spouse', 'child', 'other'].includes(relationship)
                  ? relationship
                  : 'other') as 'self',
              },
            ]
          : [],
        updatedAt,
      });
    }
    const encounterId = col(r, 'encounter_id');
    let enc = encounters.get(encounterId);
    if (!enc) {
      enc = {
        externalId: encounterId,
        patientExternalId: patientId,
        dateOfService: col(r, 'dos'),
        renderingProviderNpi: col(r, 'rendering_npi'),
        locationExternalId: col(r, 'location_id'),
        placeOfService: col(r, 'pos'),
        diagnoses: (['dx1', 'dx2', 'dx3', 'dx4'] as const)
          .map((c, n) => ({ sequence: n + 1, icd10: col(r, c) }))
          .filter((d) => d.icd10),
        lines: [],
        status: 'ready',
        updatedAt,
      };
      encounters.set(encounterId, enc);
    }
    enc.lines.push({
      externalId: col(r, 'line_id') || String(enc.lines.length + 1),
      code: col(r, 'code'),
      modifiers: (['mod1', 'mod2', 'mod3', 'mod4'] as const).map((c) => col(r, c)).filter(Boolean),
      units,
      chargeCents: charge,
      diagnosisPointers: pointers,
    });
  });

  const validPatients: ExtPatient[] = [];
  for (const p of patients.values()) {
    const res = extPatientSchema.safeParse(p);
    if (res.success) validPatients.push(p);
    else
      errors.push({
        row: 0,
        column: String(res.error.issues[0]?.path.join('.') ?? ''),
        problem: 'Patient fields are incomplete or malformed',
      });
  }
  const validEncounters: ExtEncounter[] = [];
  for (const e of encounters.values()) {
    const res = extEncounterSchema.safeParse(e);
    if (res.success) validEncounters.push(e);
    else
      errors.push({
        row: 0,
        column: String(res.error.issues[0]?.path.join('.') ?? ''),
        problem: 'Encounter fields are incomplete or malformed',
      });
  }
  return { patients: validPatients, encounters: validEncounters, errors };
}
