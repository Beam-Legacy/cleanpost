/**
 * Scrub pipeline steps 1-7 (docs/06-rules-and-ai.md). Each is pure: claim facts in, findings out.
 * Step 8 (AI review) runs in packages/claims and may only add `warn` findings.
 */
import type { ClaimPayload } from '../claims/build';
import { isValidNpi } from '../identifiers/npi';
import {
  applicableRules,
  evaluate,
  lineMatches,
  type RuleClaim,
  type RuleDef,
  type SuggestedFix,
} from '../rules/dsl';
import { KNOWN_MODIFIERS, KNOWN_POS, NCCI_BYPASS_MODIFIERS } from '../rules/groups';

export type ScrubStep =
  'structural' | 'eligibility' | 'codes' | 'ncci' | 'payer' | 'client' | 'history' | 'ai';
export type Severity = 'block' | 'warn' | 'info';

export interface Finding {
  ruleId: string;
  step: ScrubStep;
  severity: Severity;
  /** Where the problem is: "lines[2].modifiers", "payer", "priorAuthNumber". */
  field: string;
  /** One sentence for the biller. No patient identifiers. */
  message: string;
  lineNumbers?: number[];
  suggestedFix?: SuggestedFix;
  /** Points taken off the confidence score for a warn (rule weight, default 15). */
  weight?: number;
  /** For AI findings: what the model pointed at (codes, fields), never free patient text. */
  evidence?: string[];
}

export interface ScrubInput {
  clientId: string;
  claim: ClaimPayload;
  patient: { sex: 'M' | 'F' | 'U'; ageYears: number | null };
  coverage: {
    id: string;
    payerId: string | null;
    payerName: string;
    effectiveDate: string | null;
    terminationDate: string | null;
    memberIdPresent: boolean;
    relationship: string;
    subscriberPresent: boolean;
  } | null;
  /** The latest eligibility check for the coverage (M2 `eligibility.check`), if any. */
  eligibility: {
    status: 'active' | 'inactive' | 'error' | 'unknown';
    checkedAt: Date;
    /** When the payer reports the patient is covered by a different plan. */
    otherPayerName?: string | null;
    /** AAA reject reasons from the 271 when the check failed. */
    errorCodes?: string[];
  } | null;
  reference: {
    /** Known ICD-10-CM codes and whether each is billable (not a header). Null when not loaded. */
    icd10: Map<string, { billable: boolean }> | null;
    /** Known CPT/HCPCS codes. Null when not loaded. */
    procedures: Set<string> | null;
  };
  ncci: { column1: string; column2: string; modifierIndicator: string }[];
  /** Medically unlikely edits: maximum units per code per day. */
  mue: Record<string, number>;
  rules: RuleDef[];
  history: { duplicates: { encounterId: string; codes: string[] }[] };
  /** YYYY-MM-DD, for future-date checks. */
  today: string;
}

const ICD10_RE = /^[A-TV-Z]\d[0-9A-Z](\.[0-9A-Z]{1,4})?$/;
const PROCEDURE_RE = /^(\d{4}[0-9A-Z]|[A-V]\d{4})$/;

const block = (
  step: ScrubStep,
  ruleId: string,
  field: string,
  message: string,
  extra: Partial<Finding> = {},
): Finding => ({
  ruleId,
  step,
  severity: 'block',
  field,
  message,
  ...extra,
});

export function structural(input: ScrubInput): Finding[] {
  const c = input.claim;
  const out: Finding[] = [];
  const s = (ruleId: string, field: string, message: string, extra?: Partial<Finding>) =>
    out.push(block('structural', `structural.${ruleId}`, field, message, extra));

  if (!c.billing.npi) s('billing_npi_missing', 'billing.npi', 'The practice has no billing NPI on file.');
  else if (!isValidNpi(c.billing.npi))
    s('billing_npi_invalid', 'billing.npi', 'The billing NPI fails its check digit.');
  if (!c.rendering)
    s('rendering_missing', 'rendering', 'No rendering provider matches the NPI on the charge.');
  else if (!isValidNpi(c.rendering.npi))
    s('rendering_npi_invalid', 'rendering', 'The rendering NPI fails its check digit.');
  if (!input.coverage) {
    s('coverage_missing', 'coverage', 'No insurance in effect on the date of service.');
  } else {
    if (!c.payerId)
      s('payer_unmapped', 'payer', `The PM's payer "${input.coverage.payerName}" is not mapped to a payer.`);
    if (!input.coverage.memberIdPresent) s('member_id_missing', 'coverage', 'The coverage has no member ID.');
    if (input.coverage.relationship !== 'self' && !input.coverage.subscriberPresent) {
      s('subscriber_missing', 'coverage', 'The patient is a dependent but the subscriber is missing.');
    }
  }
  if (c.diagnoses.length === 0) s('diagnosis_missing', 'diagnoses', 'The claim has no diagnosis.');
  if (c.diagnoses.length > 12)
    s('diagnosis_too_many', 'diagnoses', 'A professional claim holds at most 12 diagnoses.');
  if (!c.facility || !KNOWN_POS.has(c.facility.placeOfService)) {
    s('pos_invalid', 'placeOfService', 'The place of service is missing or not a valid code.');
  }
  if (c.dateOfService > input.today)
    s('dos_future', 'dateOfService', 'The date of service is in the future.');
  if (c.lines.length === 0) s('lines_missing', 'lines', 'The claim has no service lines.');
  for (const l of c.lines) {
    const at = `lines[${l.lineNumber}]`;
    if (l.units <= 0)
      s('units_invalid', `${at}.units`, `Line ${l.lineNumber} has no units.`, {
        lineNumbers: [l.lineNumber],
      });
    if (l.chargeCents <= 0)
      s('charge_invalid', `${at}.chargeCents`, `Line ${l.lineNumber} has no charge.`, {
        lineNumbers: [l.lineNumber],
      });
    if (l.dxPointers.length === 0 || l.dxPointers.length > 4) {
      s('pointer_count', `${at}.dxPointers`, `Line ${l.lineNumber} needs one to four diagnosis pointers.`, {
        lineNumbers: [l.lineNumber],
      });
    }
    for (const p of l.dxPointers) {
      if (p < 1 || p > c.diagnoses.length) {
        s(
          'pointer_invalid',
          `${at}.dxPointers`,
          `Line ${l.lineNumber} points to diagnosis ${p}, which is not on the claim.`,
          {
            lineNumbers: [l.lineNumber],
          },
        );
      }
    }
  }
  return out;
}

/** 271 AAA codes that mean the payer has no such member, not that it could not answer. */
const MEMBER_NOT_FOUND = new Set(['72', '75']);

export function eligibility(input: ScrubInput): Finding[] {
  const cov = input.coverage;
  if (!cov) return []; // structural already blocks
  const dos = input.claim.dateOfService;
  if (cov.terminationDate && cov.terminationDate < dos) {
    return [
      block(
        'eligibility',
        'eligibility.terminated',
        'coverage',
        'The coverage ended before the date of service.',
      ),
    ];
  }
  const e = input.eligibility;
  if (!e) {
    return [
      {
        ruleId: 'eligibility.not_checked',
        step: 'eligibility',
        severity: 'info',
        field: 'coverage',
        message: 'Coverage has not been checked with the payer yet.',
      },
    ];
  }
  if (e.otherPayerName) {
    return [
      block(
        'eligibility',
        'eligibility.payer_mismatch',
        'payer',
        `The payer reports other coverage (${e.otherPayerName}); the claim's payer may be wrong.`,
        {
          suggestedFix: { op: 'setPayer' },
        },
      ),
    ];
  }
  if (e.status === 'inactive') {
    return [
      block(
        'eligibility',
        'eligibility.inactive',
        'coverage',
        'The payer reports the coverage inactive on the date of service.',
      ),
    ];
  }
  // The payer says it has no such member (AAA 72 invalid member ID, 75 subscriber not found): the
  // claim would be rejected at the front end (277CA A7:33), so it does not go out as is.
  if (e.status === 'error' && e.errorCodes?.some((c) => MEMBER_NOT_FOUND.has(c))) {
    return [
      block(
        'eligibility',
        'eligibility.member_not_found',
        'coverage',
        'The payer does not recognize this member. Check the payer and the member ID in the PM.',
      ),
    ];
  }
  if (e.status === 'error' || e.status === 'unknown') {
    return [
      {
        ruleId: 'eligibility.unconfirmed',
        step: 'eligibility',
        severity: 'warn',
        field: 'coverage',
        message: 'The payer could not confirm coverage.',
        weight: 15,
      },
    ];
  }
  return [];
}

export function codes(input: ScrubInput): Finding[] {
  const out: Finding[] = [];
  for (const d of input.claim.diagnoses) {
    const known = input.reference.icd10?.get(d.icd10);
    if (!ICD10_RE.test(d.icd10)) {
      out.push(
        block(
          'codes',
          'codes.icd10_format',
          'diagnoses',
          `Diagnosis ${d.icd10} is not a valid ICD-10-CM code.`,
        ),
      );
    } else if (known && !known.billable) {
      out.push(
        block(
          'codes',
          'codes.icd10_header',
          'diagnoses',
          `Diagnosis ${d.icd10} is a category, not a billable code; add the remaining characters.`,
        ),
      );
    } else if (input.reference.icd10 && !known) {
      out.push({
        ruleId: 'codes.icd10_unknown',
        step: 'codes',
        severity: 'warn',
        field: 'diagnoses',
        message: `Diagnosis ${d.icd10} is not in Cleanpost's code set.`,
        weight: 10,
      });
    }
  }
  for (const l of input.claim.lines) {
    const at = `lines[${l.lineNumber}]`;
    if (!PROCEDURE_RE.test(l.code)) {
      out.push(
        block(
          'codes',
          'codes.procedure_format',
          `${at}.code`,
          `Line ${l.lineNumber}: ${l.code} is not a valid procedure code.`,
          { lineNumbers: [l.lineNumber] },
        ),
      );
    } else if (input.reference.procedures && !input.reference.procedures.has(l.code)) {
      out.push({
        ruleId: 'codes.procedure_unknown',
        step: 'codes',
        severity: 'warn',
        field: `${at}.code`,
        message: `Line ${l.lineNumber}: ${l.code} is not in Cleanpost's code set.`,
        lineNumbers: [l.lineNumber],
        weight: 10,
      });
    }
    if (l.modifiers.length > 4) {
      out.push(
        block(
          'codes',
          'codes.modifier_count',
          `${at}.modifiers`,
          `Line ${l.lineNumber} has more than four modifiers.`,
          { lineNumbers: [l.lineNumber] },
        ),
      );
    }
    for (const m of l.modifiers) {
      if (!KNOWN_MODIFIERS.has(m)) {
        out.push(
          block(
            'codes',
            'codes.modifier_invalid',
            `${at}.modifiers`,
            `Line ${l.lineNumber}: modifier ${m} is not valid.`,
            {
              lineNumbers: [l.lineNumber],
              suggestedFix: { op: 'removeModifier', lineMatch: { codeIn: [l.code] }, modifier: m },
            },
          ),
        );
      }
    }
  }
  return out;
}

export function ncci(input: ScrubInput): Finding[] {
  const out: Finding[] = [];
  const lines = input.claim.lines;
  for (const a of lines) {
    for (const b of lines) {
      if (a === b) continue;
      const edit = input.ncci.find((e) => e.column1 === a.code && e.column2 === b.code);
      if (!edit || edit.modifierIndicator === '9') continue;
      const bypassed = b.modifiers.some((m) => NCCI_BYPASS_MODIFIERS.includes(m));
      if (edit.modifierIndicator === '0' || !bypassed) {
        out.push(
          block(
            'ncci',
            `ncci.ptp.${a.code}.${b.code}`,
            `lines[${b.lineNumber}].code`,
            edit.modifierIndicator === '0'
              ? `${b.code} cannot be billed with ${a.code} on the same day (NCCI).`
              : `${b.code} is bundled into ${a.code} (NCCI) unless a modifier shows it was a separate service.`,
            {
              lineNumbers: [a.lineNumber, b.lineNumber],
              suggestedFix: { op: 'removeLine', lineMatch: { codeIn: [b.code] } },
            },
          ),
        );
      }
    }
  }
  const unitsByCode = new Map<string, number>();
  for (const l of lines) unitsByCode.set(l.code, (unitsByCode.get(l.code) ?? 0) + l.units);
  for (const [code, units] of unitsByCode) {
    const max = input.mue[code];
    if (max !== undefined && units > max) {
      out.push(
        block(
          'ncci',
          `ncci.mue.${code}`,
          'lines',
          `${code} is billed for ${units} units; the most allowed per day is ${max}.`,
          {
            lineNumbers: lines.filter((l) => l.code === code).map((l) => l.lineNumber),
          },
        ),
      );
    }
  }
  return out;
}

function ruleClaim(input: ScrubInput): RuleClaim {
  const c = input.claim;
  return {
    payerId: c.payerId,
    placeOfService: c.facility?.placeOfService ?? null,
    priorAuthNumber: c.priorAuthNumber,
    diagnoses: c.diagnoses,
    lines: c.lines.map((l) => ({
      lineNumber: l.lineNumber,
      code: l.code,
      modifiers: l.modifiers,
      units: l.units,
    })),
    patient: input.patient,
  };
}

export interface RuleOutcome {
  findings: Finding[];
  routes: { ruleId: string; queue?: string; assigneeId?: string }[];
}

/** Steps 5 and 6: data rules. Global, tenant and payer rules report as `payer`; client rules as `client`. */
export function rules(input: ScrubInput): RuleOutcome {
  const claim = ruleClaim(input);
  const out: RuleOutcome = { findings: [], routes: [] };
  for (const r of applicableRules(input.rules, { clientId: input.clientId, payerId: input.claim.payerId })) {
    const ev = evaluate(r.condition, claim);
    if (!ev.matched) continue;
    if (r.kind === 'route') {
      out.routes.push({ ruleId: r.id, ...r.action.route });
      continue;
    }
    const fixLines =
      r.action.suggestedFix && 'lineMatch' in r.action.suggestedFix
        ? claim.lines
            .filter((l) =>
              lineMatches(
                l,
                (r.action.suggestedFix as { lineMatch: Parameters<typeof lineMatches>[1] }).lineMatch,
              ),
            )
            .map((l) => l.lineNumber)
        : [];
    out.findings.push({
      ruleId: r.id,
      step: r.scope === 'client' || r.scope === 'client_payer' ? 'client' : 'payer',
      // Transforms are suggestions until auto-transforms are switched on for the client.
      severity: r.kind === 'transform' ? 'info' : r.severity,
      field: r.action.field ?? 'lines',
      message: r.action.finding,
      lineNumbers: fixLines.length ? fixLines : ev.lineNumbers,
      ...(r.action.suggestedFix ? { suggestedFix: r.action.suggestedFix } : {}),
      weight: r.weight,
    });
  }
  return out;
}

export function history(input: ScrubInput): Finding[] {
  return input.history.duplicates.map((d) =>
    block(
      'history',
      'history.duplicate',
      'claim',
      `Looks like a duplicate of another claim for the same patient and date of service (${d.codes.join(', ')}).`,
    ),
  );
}

export type ScrubOutput = RuleOutcome;

/** Steps 1-7 in order. */
export function runScrubSteps(input: ScrubInput): ScrubOutput {
  const r = rules(input);
  return {
    findings: [
      ...structural(input),
      ...eligibility(input),
      ...codes(input),
      ...ncci(input),
      ...r.findings,
      ...history(input),
    ],
    routes: r.routes,
  };
}
