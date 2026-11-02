/**
 * The de-identified claim view (docs/06-rules-and-ai.md, Redaction): no names, addresses, phone
 * numbers, member IDs or dates of birth; age in years only; dates of service kept. The view is
 * built from an allowlist of fields, so nothing reaches a prompt by accident. assertNoIdentifiers
 * is a second check on the final text.
 */
import type { Finding, ScrubInput } from '@cleanpost/domain';

export interface DeidentifiedClaim {
  patient: { ageYears: number | null; sex: 'M' | 'F' | 'U' };
  payer: string | null;
  placeOfService: string | null;
  dateOfService: string;
  priorAuthOnFile: boolean;
  /** ICD-10 codes in pointer order (1-based position = pointer). */
  diagnoses: string[];
  lines: {
    line: number;
    code: string;
    modifiers: string[];
    units: number;
    chargeCents: number;
    pointers: number[];
  }[];
  /** What the deterministic checks already found, so the model does not repeat them. */
  findingsSoFar: { ruleId: string; severity: string; field: string; message: string }[];
}

export function deidentifyClaim(input: ScrubInput, findings: Finding[]): DeidentifiedClaim {
  const c = input.claim;
  return {
    patient: { ageYears: input.patient.ageYears, sex: input.patient.sex },
    payer: c.payerName,
    placeOfService: c.facility?.placeOfService ?? null,
    dateOfService: c.dateOfService,
    priorAuthOnFile: Boolean(c.priorAuthNumber),
    diagnoses: [...c.diagnoses].sort((a, b) => a.sequence - b.sequence).map((d) => d.icd10),
    lines: c.lines.map((l) => ({
      line: l.lineNumber,
      code: l.code,
      modifiers: l.modifiers,
      units: l.units,
      chargeCents: l.chargeCents,
      pointers: l.dxPointers,
    })),
    findingsSoFar: findings.map((f) => ({
      ruleId: f.ruleId,
      severity: f.severity,
      field: f.field,
      message: f.message,
    })),
  };
}

export class RedactionError extends Error {
  readonly code = 'REDACTION_FAILED';
  constructor(readonly kind: string) {
    super(`Refusing to send text that looks like it holds an identifier (${kind})`);
    this.name = 'RedactionError';
  }
}

const IDENTIFIER_PATTERNS: [string, RegExp][] = [
  ['ssn', /\b\d{3}-\d{2}-\d{4}\b/],
  ['phone', /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/],
  ['email', /[\w.+-]+@[\w-]+\.[\w.]+/],
  // Member IDs mix letters and digits (synthetic ones are XQ + 8 digits).
  ['member_id', /\b[A-Z]{1,3}\d{7,12}\b/],
  // Any full date before 2020 is a date of birth, not a date of service.
  ['date_of_birth', /\b(19\d{2}|200\d|201\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/],
];

/** Throws if the text contains anything shaped like a direct identifier. */
export function assertNoIdentifiers(text: string): void {
  for (const [kind, re] of IDENTIFIER_PATTERNS) {
    if (re.test(text)) throw new RedactionError(kind);
  }
}

export function containsIdentifier(text: string): boolean {
  return IDENTIFIER_PATTERNS.some(([, re]) => re.test(text));
}
