/**
 * The rules DSL (docs/06-rules-and-ai.md). Rules are data in the `rules` table and in
 * `rules/seed/*.json`; this module validates them with Zod and evaluates them against a claim.
 * Evaluation is pure and deterministic: the same claim and rule always give the same answer.
 */
import { z } from 'zod';
import { isInGroup } from './groups';

const codes = z.array(z.string().min(1)).min(1);

export const lineCondSchema = z
  .object({
    codeIn: codes.optional(),
    codeNotIn: codes.optional(),
    codeInGroup: z.string().optional(),
    codeNotInGroup: z.string().optional(),
    /** The line has at least one of these modifiers. */
    modifierIn: codes.optional(),
    /** The line has none of these modifiers. */
    modifierNotIn: codes.optional(),
    unitsGt: z.number().int().optional(),
  })
  .strict();
export type LineCond = z.infer<typeof lineCondSchema>;

const fieldCondSchema = z
  .object({
    field: z.enum(['placeOfService', 'priorAuthNumber', 'payerId', 'patient.sex', 'patient.ageYears']),
    eq: z.union([z.string(), z.number()]).optional(),
    in: z.array(z.union([z.string(), z.number()])).optional(),
    exists: z.boolean().optional(),
    gt: z.number().optional(),
    lt: z.number().optional(),
  })
  .strict();

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { anyLine: LineCond }
  | { noLine: LineCond }
  | { allLines: LineCond }
  | z.infer<typeof fieldCondSchema>
  | { diagnosisIn: string[] }
  | { diagnosisPrefixIn: string[] };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({ anyLine: lineCondSchema }).strict(),
    z.object({ noLine: lineCondSchema }).strict(),
    z.object({ allLines: lineCondSchema }).strict(),
    fieldCondSchema,
    z.object({ diagnosisIn: codes }).strict(),
    z.object({ diagnosisPrefixIn: codes }).strict(),
  ]),
);

export const fixSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addModifier'), lineMatch: lineCondSchema, modifier: z.string().min(2).max(2) }),
  z.object({
    op: z.literal('removeModifier'),
    lineMatch: lineCondSchema,
    modifier: z.string().min(2).max(2),
  }),
  z.object({ op: z.literal('removeLine'), lineMatch: lineCondSchema }),
  z.object({
    op: z.literal('setField'),
    field: z.enum(['priorAuthNumber', 'placeOfService']),
    value: z.string().nullable(),
  }),
  z.object({ op: z.literal('reorderDiagnoses') }),
  z.object({ op: z.literal('setPayer') }),
  z.object({ op: z.literal('splitClaim') }),
]);
export type SuggestedFix = z.infer<typeof fixSchema>;

export const actionSchema = z
  .object({
    /** One sentence for the biller. */
    finding: z.string().min(1).max(300),
    /** The claim field the finding points at, e.g. "lines", "priorAuthNumber". */
    field: z.string().optional(),
    suggestedFix: fixSchema.optional(),
    route: z.object({ queue: z.string().optional(), assigneeId: z.uuid().optional() }).optional(),
  })
  .strict();
export type RuleAction = z.infer<typeof actionSchema>;

export const ruleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  scope: z.enum(['global', 'tenant', 'client', 'payer', 'client_payer']),
  clientId: z.uuid().nullable().optional(),
  payerId: z.uuid().nullable().optional(),
  kind: z.enum(['validate', 'transform', 'route']),
  severity: z.enum(['block', 'warn', 'info']),
  weight: z.number().int().min(0).max(100).default(15),
  condition: conditionSchema,
  action: actionSchema,
});
export type RuleDef = z.infer<typeof ruleSchema>;

/** The view of a claim rules see: billing facts and derived patient facts, no identifiers. */
export interface RuleClaim {
  payerId: string | null;
  placeOfService: string | null;
  priorAuthNumber: string | null;
  diagnoses: { sequence: number; icd10: string }[];
  lines: { lineNumber: number; code: string; modifiers: string[]; units: number }[];
  patient: { sex: 'M' | 'F' | 'U'; ageYears: number | null };
}

export function lineMatches(line: RuleClaim['lines'][number], c: LineCond): boolean {
  if (c.codeIn && !c.codeIn.includes(line.code)) return false;
  if (c.codeNotIn && c.codeNotIn.includes(line.code)) return false;
  if (c.codeInGroup && !isInGroup(line.code, c.codeInGroup)) return false;
  if (c.codeNotInGroup && isInGroup(line.code, c.codeNotInGroup)) return false;
  if (c.modifierIn && !c.modifierIn.some((m) => line.modifiers.includes(m))) return false;
  if (c.modifierNotIn && c.modifierNotIn.some((m) => line.modifiers.includes(m))) return false;
  if (c.unitsGt !== undefined && !(line.units > c.unitsGt)) return false;
  return true;
}

function fieldValue(claim: RuleClaim, field: z.infer<typeof fieldCondSchema>['field']) {
  switch (field) {
    case 'placeOfService':
      return claim.placeOfService;
    case 'priorAuthNumber':
      return claim.priorAuthNumber;
    case 'payerId':
      return claim.payerId;
    case 'patient.sex':
      return claim.patient.sex;
    case 'patient.ageYears':
      return claim.patient.ageYears;
  }
}

export interface Evaluation {
  matched: boolean;
  /** Lines that made `anyLine` conditions true, for pointing the biller at them. */
  lineNumbers: number[];
}

export function evaluate(c: Condition, claim: RuleClaim): Evaluation {
  if ('all' in c) {
    const parts = c.all.map((x) => evaluate(x, claim));
    return {
      matched: parts.every((p) => p.matched),
      lineNumbers: [...new Set(parts.flatMap((p) => p.lineNumbers))],
    };
  }
  if ('any' in c) {
    const parts = c.any.map((x) => evaluate(x, claim)).filter((p) => p.matched);
    return { matched: parts.length > 0, lineNumbers: [...new Set(parts.flatMap((p) => p.lineNumbers))] };
  }
  if ('not' in c) return { matched: !evaluate(c.not, claim).matched, lineNumbers: [] };
  if ('anyLine' in c) {
    const hits = claim.lines.filter((l) => lineMatches(l, c.anyLine)).map((l) => l.lineNumber);
    return { matched: hits.length > 0, lineNumbers: hits };
  }
  if ('noLine' in c) return { matched: !claim.lines.some((l) => lineMatches(l, c.noLine)), lineNumbers: [] };
  if ('allLines' in c) {
    return {
      matched: claim.lines.length > 0 && claim.lines.every((l) => lineMatches(l, c.allLines)),
      lineNumbers: [],
    };
  }
  if ('diagnosisIn' in c) {
    return { matched: claim.diagnoses.some((d) => c.diagnosisIn.includes(d.icd10)), lineNumbers: [] };
  }
  if ('diagnosisPrefixIn' in c) {
    return {
      matched: claim.diagnoses.some((d) => c.diagnosisPrefixIn.some((p) => d.icd10.startsWith(p))),
      lineNumbers: [],
    };
  }
  const v = fieldValue(claim, c.field);
  let ok = true;
  if (c.exists !== undefined) ok &&= (v !== null && v !== undefined && v !== '') === c.exists;
  if (c.eq !== undefined) ok &&= v === c.eq;
  if (c.in !== undefined) ok &&= c.in.includes(v as string | number);
  if (c.gt !== undefined) ok &&= typeof v === 'number' && v > c.gt;
  if (c.lt !== undefined) ok &&= typeof v === 'number' && v < c.lt;
  return { matched: ok, lineNumbers: [] };
}

/** Rules that apply to this claim's client and payer, broadest scope first. */
export function applicableRules(
  rules: RuleDef[],
  claim: { clientId: string; payerId: string | null },
): RuleDef[] {
  const order = { global: 0, tenant: 1, payer: 2, client: 3, client_payer: 4 } as const;
  return rules
    .filter((r) => {
      if (r.scope === 'client' && r.clientId !== claim.clientId) return false;
      if (r.scope === 'payer' && r.payerId !== claim.payerId) return false;
      if (r.scope === 'client_payer' && (r.clientId !== claim.clientId || r.payerId !== claim.payerId))
        return false;
      return true;
    })
    .sort((a, b) => order[a.scope] - order[b.scope]);
}
