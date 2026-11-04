/**
 * S-05 / S-06: a company switches a built-in (global) rule off for itself or for one client, kept in
 * `tenants.settings.rulesOff`. Built-in rules are never edited; a company's own rules switch with
 * their `enabled` column. The scrub leaves out rules that are off for the claim's client.
 */
import type { ClaimPayload } from '../claims/build';
import { evaluate, type RuleClaim, type RuleDef } from './dsl';

export interface RuleOff {
  ruleId: string;
  /** null: the whole company. */
  clientId: string | null;
}

export function rulesOff(settings: unknown): RuleOff[] {
  const raw = (settings as { rulesOff?: unknown } | null)?.rulesOff;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) =>
    r && typeof r === 'object' && typeof (r as RuleOff).ruleId === 'string'
      ? [{ ruleId: (r as RuleOff).ruleId, clientId: (r as RuleOff).clientId ?? null }]
      : [],
  );
}

export const isRuleOff = (off: readonly RuleOff[], ruleId: string, clientId: string) =>
  off.some((o) => o.ruleId === ruleId && (o.clientId === null || o.clientId === clientId));

/** The list with this rule switched off (or back on) for the company or one client. */
export function setRuleOff(
  off: readonly RuleOff[],
  ruleId: string,
  clientId: string | null,
  isOff: boolean,
): RuleOff[] {
  const rest = off.filter((o) => !(o.ruleId === ruleId && o.clientId === clientId));
  return isOff ? [...rest, { ruleId, clientId }] : rest;
}

/**
 * S-06 "Test on last 30 days": whether a rule matches a claim as billed. The patient's sex and age
 * are not part of the claim payload (reading them would be a PHI read), so rules on them do not
 * match here; the drawer says so.
 */
export function ruleMatchesPayload(rule: Pick<RuleDef, 'condition'>, payload: ClaimPayload): boolean {
  const claim: RuleClaim = {
    payerId: payload.payerId,
    placeOfService: payload.facility?.placeOfService ?? null,
    priorAuthNumber: payload.priorAuthNumber,
    diagnoses: payload.diagnoses,
    lines: payload.lines.map((l) => ({
      lineNumber: l.lineNumber,
      code: l.code,
      modifiers: l.modifiers,
      units: l.units,
    })),
    patient: { sex: 'U', ageYears: null },
  };
  return evaluate(rule.condition, claim).matched;
}
