/**
 * S-06: a rule in plain words, generated from the same JSON the evaluator runs (docs/06), so the
 * description cannot drift from what the scrubber does. Codes only, never CPT descriptions (rule 11).
 */
import type { Condition, LineCond, RuleDef, SuggestedFix } from './dsl';
import { CODE_GROUPS } from './groups';

export const CODE_GROUP_LABEL: Record<string, string> = {
  em_new: 'new-patient visit codes',
  em_established: 'established-patient visit codes',
  em_office: 'office visit codes',
  em_preventive: 'preventive visit codes',
  minor_procedures: 'minor procedure codes',
  lateral_procedures: 'procedures done on one side of the body',
  vaccine_admin: 'vaccine administration codes',
  prior_auth_common: 'codes payers usually authorize in advance',
};

/** "office visit codes (99202–99205, 99211–99215)": the label and the codes it holds. */
export function describeGroup(group: string): string {
  const codes = CODE_GROUPS[group];
  const label = CODE_GROUP_LABEL[group] ?? group.replaceAll('_', ' ');
  return codes ? `${label} (${compactCodes(codes)})` : label;
}

/** 99202, 99203, 99204 → "99202–99204"; keeps lists short. */
export function compactCodes(codes: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < codes.length) {
    let j = i;
    while (
      j + 1 < codes.length &&
      /^\d+$/.test(codes[j]!) &&
      /^\d+$/.test(codes[j + 1]!) &&
      Number(codes[j + 1]) === Number(codes[j]) + 1
    )
      j++;
    out.push(j > i ? `${codes[i]}–${codes[j]}` : codes[i]!);
    i = j + 1;
  }
  return out.join(', ');
}

const list = (xs: readonly string[], joiner = 'or') =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${joiner} ${xs.at(-1)}`;

export function describeLine(c: LineCond): string {
  const parts: string[] = [];
  if (c.codeIn) parts.push(`code ${list(c.codeIn)}`);
  if (c.codeInGroup) parts.push(`one of the ${describeGroup(c.codeInGroup)}`);
  if (c.codeNotIn) parts.push(`a code other than ${list(c.codeNotIn)}`);
  if (c.codeNotInGroup) parts.push(`a code outside the ${describeGroup(c.codeNotInGroup)}`);
  const what = parts.length ? parts.join(', ') : 'any code';
  const mods: string[] = [];
  if (c.modifierIn) mods.push(`with modifier ${list(c.modifierIn)}`);
  if (c.modifierNotIn) mods.push(`without modifier ${list(c.modifierNotIn)}`);
  if (c.unitsGt !== undefined) mods.push(`for more than ${c.unitsGt} ${c.unitsGt === 1 ? 'unit' : 'units'}`);
  return [what, ...mods].join(' ');
}

const FIELD: Record<string, string> = {
  placeOfService: 'the place of service',
  priorAuthNumber: 'the prior authorization number',
  payerId: 'the payer',
  'patient.sex': 'the patient’s sex',
  'patient.ageYears': 'the patient’s age',
};

export interface DescribeContext {
  payerName?: (id: string) => string | undefined;
}

export function describeCondition(c: Condition, ctx: DescribeContext = {}): string {
  if ('all' in c) return c.all.map((x) => describeCondition(x, ctx)).join(', and ');
  if ('any' in c) return `either ${c.any.map((x) => describeCondition(x, ctx)).join(', or ')}`;
  if ('not' in c) return `it is not the case that ${describeCondition(c.not, ctx)}`;
  if ('anyLine' in c) return `a line has ${describeLine(c.anyLine)}`;
  if ('noLine' in c) return `no line has ${describeLine(c.noLine)}`;
  if ('allLines' in c) return `every line has ${describeLine(c.allLines)}`;
  if ('diagnosisIn' in c) return `a diagnosis is ${list(c.diagnosisIn)}`;
  if ('diagnosisPrefixIn' in c) return `a diagnosis starts with ${list(c.diagnosisPrefixIn)}`;
  const f = FIELD[c.field] ?? c.field;
  const val = (v: string | number) =>
    c.field === 'payerId' && typeof v === 'string' ? (ctx.payerName?.(v) ?? 'a payer') : String(v);
  if (c.exists === false) return `${f} is missing`;
  if (c.exists === true) return `${f} is filled in`;
  if (c.eq !== undefined) return `${f} is ${val(c.eq)}`;
  if (c.in) return `${f} is ${list(c.in.map(val))}`;
  if (c.gt !== undefined && c.lt !== undefined) return `${f} is between ${c.gt} and ${c.lt}`;
  if (c.gt !== undefined) return `${f} is over ${c.gt}`;
  if (c.lt !== undefined) return `${f} is under ${c.lt}`;
  return f;
}

export function describeFix(fix: SuggestedFix): string {
  switch (fix.op) {
    case 'addModifier':
      return `add modifier ${fix.modifier} to the line with ${describeLine(fix.lineMatch)}`;
    case 'removeModifier':
      return `remove modifier ${fix.modifier} from the line with ${describeLine(fix.lineMatch)}`;
    case 'removeLine':
      return `remove the line with ${describeLine(fix.lineMatch)}`;
    case 'setField':
      return fix.value === null
        ? `fill in ${FIELD[fix.field] ?? fix.field}`
        : `set ${FIELD[fix.field] ?? fix.field} to ${fix.value}`;
    case 'reorderDiagnoses':
      return 'put the diagnoses in the right order';
    case 'setPayer':
      return 'bill the right payer';
    case 'splitClaim':
      return 'split the claim';
  }
}

export const RULE_KIND_LABEL: Record<RuleDef['kind'], string> = {
  validate: 'Check',
  transform: 'Fix',
  route: 'Route',
};

/** The rule's "Then": what it does to a claim that matches. */
export function describeOutcome(r: Pick<RuleDef, 'kind' | 'severity' | 'weight' | 'action'>): string[] {
  const out: string[] = [];
  const said = `"${r.action.finding}"`;
  if (r.kind === 'transform')
    out.push(`Suggest a fix the biller confirms (automatic fixes are not switched on): ${said}`);
  else if (r.severity === 'block') out.push(`Stop the claim for a fix: ${said}`);
  else if (r.severity === 'warn') out.push(`Flag a warning: ${said}`);
  else out.push(`Note it: ${said}`);
  if (r.action.suggestedFix) out.push(`Suggest the fix: ${describeFix(r.action.suggestedFix)}.`);
  if (r.kind !== 'transform' && r.severity === 'warn') out.push(`Lower confidence by ${r.weight}.`);
  if (r.kind === 'transform' || r.severity === 'info') out.push('Lower confidence by 2.');
  if (r.severity === 'block' && r.kind !== 'transform')
    out.push('A blocked claim always waits for a person.');
  return out;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
