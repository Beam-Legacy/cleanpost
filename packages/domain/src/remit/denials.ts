/**
 * Denial triage (docs/06 "Denials", D-01, D-02, W-16): each denied line gets a category, a plain
 * explanation and, where the fix is mechanical, a suggested correction the person can apply. The
 * rules here decide; an LLM may later word the explanation but never sets a code (CLAUDE.md rule 9).
 * Codes only, no procedure descriptions (rule 11).
 */
import type { ClaimPayload } from '../claims/build';
import { CODE_GROUPS, NCCI_BYPASS_MODIFIERS } from '../rules/groups';
import type { SuggestedFix } from '../rules/dsl';

export type DenialKind =
  | 'eligibility'
  | 'authorization'
  | 'coding'
  | 'bundling'
  | 'missing_info'
  | 'timely_filing'
  | 'duplicate'
  | 'cob'
  | 'provider_enrollment'
  | 'other';

export const DENIAL_KIND_LABEL: Record<DenialKind, string> = {
  eligibility: 'Eligibility',
  authorization: 'Authorization',
  coding: 'Coding',
  bundling: 'Bundling',
  missing_info: 'Missing information',
  timely_filing: 'Timely filing',
  duplicate: 'Duplicate',
  cob: 'Coordination of benefits',
  provider_enrollment: 'Provider enrollment',
  other: 'Other',
};

const KIND_BY_CARC: Record<string, DenialKind> = {
  '26': 'eligibility',
  '27': 'eligibility',
  '31': 'eligibility',
  '33': 'eligibility',
  '177': 'eligibility',
  '200': 'eligibility',
  '15': 'authorization',
  '62': 'authorization',
  '197': 'authorization',
  '198': 'authorization',
  '243': 'authorization',
  '4': 'coding',
  '5': 'coding',
  '6': 'coding',
  '7': 'coding',
  '8': 'coding',
  '9': 'coding',
  '11': 'coding',
  '146': 'coding',
  '181': 'coding',
  '182': 'coding',
  '97': 'bundling',
  '231': 'bundling',
  '234': 'bundling',
  '236': 'bundling',
  '16': 'missing_info',
  '125': 'missing_info',
  '227': 'missing_info',
  '252': 'missing_info',
  '29': 'timely_filing',
  '18': 'duplicate',
  '22': 'cob',
  '23': 'cob',
  '109': 'cob',
  B7: 'provider_enrollment',
  B9: 'provider_enrollment',
  '170': 'provider_enrollment',
  '171': 'provider_enrollment',
  '172': 'provider_enrollment',
  '185': 'provider_enrollment',
  '206': 'provider_enrollment',
  '207': 'provider_enrollment',
  '208': 'provider_enrollment',
};

export const denialKind = (carc: string): DenialKind => KIND_BY_CARC[carc] ?? 'other';

/** Kinds a corrected claim (frequency 7) can fix; the others are written off, rebilled or appealed. */
const CORRECTABLE = new Set<DenialKind>(['coding', 'bundling', 'missing_info', 'authorization']);

export interface DeniedLine {
  lineNumber: number;
  code: string;
  modifiers: string[];
  group: string;
  carc: string;
  amountCents: number;
  remarks: string[];
}

export interface DenialSuggestion {
  /** One line for the person, e.g. "Add modifier 25 to line 1 (99213)". */
  label: string;
  fix: SuggestedFix;
  lineNumbers: number[];
  /** The fix needs a value only the person has (an authorization number): open the editor. */
  needsInput: boolean;
}

export interface DenialAdvice {
  kind: DenialKind;
  /** A corrected claim can fix it. */
  correctable: boolean;
  /** What to do first: build a correction, check coverage, or write off (or appeal, later). */
  primary: 'correct' | 'check_coverage' | 'write_off';
  explanation: string;
  suggestion: DenialSuggestion | null;
}

const inGroup = (group: string, code: string) => CODE_GROUPS[group]?.includes(code) ?? false;

/** The NCCI pairs the advice reads (the same reference data the scrub uses). */
export type NcciPairs = readonly { column1: string; column2: string; modifierIndicator: string }[];

/**
 * Advice for one denied line of a claim. Deterministic: the same denial gives the same advice, so a
 * person can trust the suggestion and the audit trail can name the rule.
 */
export function adviseDenial(claim: ClaimPayload, line: DeniedLine, ncci: NcciPairs): DenialAdvice {
  const kind = denialKind(line.carc);
  const code = `${line.group}-${line.carc}`;
  const others = claim.lines.filter((l) => l.lineNumber !== line.lineNumber);
  const base = { kind, correctable: CORRECTABLE.has(kind) };

  // An office visit with a procedure or preventive visit the same day: modifier 25.
  if (line.carc === '4' && inGroup('em_office', line.code) && !line.modifiers.includes('25')) {
    const withProcedure = others.some(
      (o) => inGroup('minor_procedures', o.code) || inGroup('em_preventive', o.code),
    );
    if (withProcedure)
      return {
        ...base,
        primary: 'correct',
        explanation: `The payer denied ${line.code} (${code}): an office visit billed with a procedure or preventive visit on the same day needs modifier 25 to show it was a separate service. If the notes support a separate visit, correct the claim; if not, write it off.`,
        suggestion: {
          label: `Add modifier 25 to line ${line.lineNumber} (${line.code})`,
          fix: { op: 'addModifier', lineMatch: { codeIn: [line.code] }, modifier: '25' },
          lineNumbers: [line.lineNumber],
          needsInput: false,
        },
      };
  }

  // Bundled into another line (NCCI): modifier 59 where the edit allows it, else not separately payable.
  if (line.carc === '97' || line.remarks.includes('M15')) {
    const edit = ncci.find((e) => e.column2 === line.code && others.some((o) => o.code === e.column1));
    const bypassed = line.modifiers.some((m) => NCCI_BYPASS_MODIFIERS.includes(m));
    if (edit && edit.modifierIndicator === '1' && !bypassed)
      return {
        ...base,
        primary: 'correct',
        explanation: `The payer paid ${line.code} as part of ${edit.column1} (${code}). If it was a separate service (a different site or session), modifier 59 shows that; otherwise the bundling is correct and the line should be written off.`,
        suggestion: {
          label: `Add modifier 59 to line ${line.lineNumber} (${line.code})`,
          fix: { op: 'addModifier', lineMatch: { codeIn: [line.code] }, modifier: '59' },
          lineNumbers: [line.lineNumber],
          needsInput: false,
        },
      };
    if (edit)
      return {
        ...base,
        correctable: false,
        primary: 'write_off',
        explanation: `${line.code} is never paid separately with ${edit.column1} (${code}; the NCCI edit allows no modifier). Write it off; do not bill the patient for a contractual denial.`,
        suggestion: null,
      };
  }

  switch (kind) {
    case 'authorization':
      return {
        ...base,
        primary: 'correct',
        explanation: `The payer has no prior authorization on file for ${line.code} (${code}). If one was obtained, add its number and send a corrected claim; if not, ask the payer about a retro authorization before writing it off.`,
        suggestion: {
          label: 'Add the prior authorization number',
          fix: { op: 'setField', field: 'priorAuthNumber', value: null },
          lineNumbers: [line.lineNumber],
          needsInput: true,
        },
      };
    case 'eligibility':
      return {
        ...base,
        primary: 'check_coverage',
        explanation: `The payer says the patient was not covered on the date of service (${code}). Check eligibility again: if the patient has other insurance, bill that payer; if not, the balance may be the patient's.`,
        suggestion: null,
      };
    case 'timely_filing':
      return {
        ...base,
        primary: 'write_off',
        explanation: `The claim reached the payer after its filing limit (${code}). Unless there is proof it was filed on time (an earlier acceptance report), write it off; it cannot be billed to the patient.`,
        suggestion: null,
      };
    case 'duplicate':
      return {
        ...base,
        primary: 'write_off',
        explanation: `The payer says it already processed these services (${code}). Check that the first claim was paid; if it was, close this one.`,
        suggestion: null,
      };
    case 'coding':
    case 'missing_info':
      return {
        ...base,
        primary: 'correct',
        explanation: `The payer could not pay ${line.code} as billed (${code}). Open the claim, fix the code, modifier or missing field the payer names, and send a corrected claim.`,
        suggestion: null,
      };
    default:
      return {
        ...base,
        primary: base.correctable ? 'correct' : 'write_off',
        explanation: `The payer denied ${line.code} (${code}). Read the remark codes on the payment; correct and resend, appeal, or write it off.`,
        suggestion: null,
      };
  }
}
