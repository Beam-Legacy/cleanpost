import 'server-only';
/**
 * S-05 / S-06 rules: every data rule the scrubber applies to this company (built-in and its own),
 * in plain words generated from the rule JSON, with the last 30 days' hits and overrides, where it
 * is switched off, and its history. Also the built-in code checks that fired. Counts and codes only.
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { now as clockNow } from '@cleanpost/clock';
import { auditEvents, clients, payers, rules, tenants, users, withTenant } from '@cleanpost/db';
import {
  RULE_KIND_LABEL,
  capitalize,
  conditionSchema,
  describeCondition,
  describeOutcome,
  rulesOff,
  type RuleDef,
} from '@cleanpost/domain';
import { getDb } from '../server';
import type { ActiveContext } from '../session';

export interface RuleRow {
  id: string;
  /** What findings carry: the seed key, or the row id. */
  ruleKey: string;
  name: string;
  kind: string;
  kindLabel: string;
  scopeLabel: string;
  /** seed (built in) | user (your company) | promoted (from corrections) */
  source: string;
  builtIn: boolean;
  /** On for the company: enabled and not switched off company-wide. */
  on: boolean;
  /** Clients it is switched off for (built-in rules). */
  offFor: { id: string; name: string }[];
  version: number;
  hits: number;
  /** Share of hits a person released without applying the rule, 0..100. */
  overridden: number | null;
  when: string;
  then: string[];
  history: { at: Date; who: string; what: string }[];
}

export interface BuiltInCheck {
  ruleId: string;
  hits: number;
}

const HISTORY_VERB: Record<string, string> = {
  'rule.turned_off': 'Turned off',
  'rule.turned_on': 'Turned back on',
  'rule.tested': 'Tested on the last 30 days',
};

export async function listRules(ctx: ActiveContext): Promise<{ rules: RuleRow[]; checks: BuiltInCheck[] }> {
  const since = new Date(clockNow().getTime() - 30 * 86_400_000);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const rows = await tx
      .select()
      .from(rules)
      .where(or(isNull(rules.tenantId), eq(rules.tenantId, ctx.tenantId)))
      .orderBy(rules.name);
    const [t] = await tx
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId));
    const off = rulesOff(t?.settings);
    const clientList = await tx.select({ id: clients.id, name: clients.name }).from(clients);
    const clientName = new Map(clientList.map((c) => [c.id, c.name]));
    const payerIds = [...new Set(rows.map((r) => r.payerId).filter((x): x is string => Boolean(x)))];
    const payerList = payerIds.length
      ? await tx.select({ id: payers.id, name: payers.name }).from(payers).where(inArray(payers.id, payerIds))
      : [];
    const payerName = new Map(payerList.map((p) => [p.id, p.name]));

    // Hits: claims whose scrub in the last 30 days found the rule. Overridden: of those, the version
    // with the finding was approved by a person and released as it was.
    const stats = await tx.execute<{ rule_id: string; hits: number; overridden: number }>(sql`
      with f as (
        select distinct cv.claim_id, sr.claim_version_id, x->>'ruleId' as rule_id
        from scrub_results sr
        join claim_versions cv on cv.id = sr.claim_version_id
        cross join lateral jsonb_array_elements(coalesce(sr.findings->'items', '[]'::jsonb)) x
        where sr.created_at >= ${since})
      select rule_id, count(distinct claim_id)::int as hits,
        count(distinct claim_id) filter (where exists (
          select 1 from claim_events e where e.claim_version_id = f.claim_version_id
            and e.type = 'approved' and e.actor like 'user:%'))::int as overridden
      from f group by rule_id`);
    const statBy = new Map(stats.rows.map((s) => [s.rule_id, s]));

    const ids = rows.map((r) => r.id);
    const events = ids.length
      ? await tx
          .select({
            entityId: auditEvents.entityId,
            at: auditEvents.at,
            actor: auditEvents.actor,
            action: auditEvents.action,
            clientId: auditEvents.clientId,
            name: users.name,
          })
          .from(auditEvents)
          .leftJoin(users, sql`${auditEvents.actor} = 'user:' || ${users.id}::text`)
          .where(and(eq(auditEvents.entityType, 'rule'), inArray(auditEvents.entityId, ids)))
          .orderBy(desc(auditEvents.at))
          .limit(500)
      : [];

    const out: RuleRow[] = rows.map((r) => {
      const ruleKey = r.key ?? r.id;
      const builtIn = r.tenantId === null;
      const s = statBy.get(ruleKey);
      const parsed = conditionSchema.safeParse(r.condition);
      const action = r.action as RuleDef['action'];
      const scopeLabel =
        r.scope === 'client_payer'
          ? `${payerName.get(r.payerId ?? '') ?? 'A payer'} · ${clientName.get(r.clientId ?? '') ?? 'a client'}`
          : r.scope === 'payer'
            ? (payerName.get(r.payerId ?? '') ?? 'One payer')
            : r.scope === 'client'
              ? (clientName.get(r.clientId ?? '') ?? 'One client')
              : 'All payers and clients';
      return {
        id: r.id,
        ruleKey,
        name: r.name,
        kind: r.kind,
        kindLabel: RULE_KIND_LABEL[r.kind as RuleDef['kind']] ?? r.kind,
        scopeLabel,
        source: r.source,
        builtIn,
        on: r.enabled && !off.some((o) => o.ruleId === ruleKey && o.clientId === null),
        offFor: off
          .filter((o) => o.ruleId === ruleKey && o.clientId)
          .map((o) => ({ id: o.clientId!, name: clientName.get(o.clientId!) ?? 'Client' })),
        version: r.version,
        hits: s?.hits ?? 0,
        overridden: s && s.hits ? Math.round((s.overridden / s.hits) * 100) : null,
        when: parsed.success
          ? capitalize(describeCondition(parsed.data, { payerName: (id) => payerName.get(id) }))
          : 'This rule no longer reads correctly, so the scrubber skips it.',
        then: describeOutcome({
          kind: r.kind as RuleDef['kind'],
          severity: r.severity as RuleDef['severity'],
          weight: r.weight,
          action,
        }),
        history: events
          .filter((e) => e.entityId === r.id)
          .map((e) => ({
            at: e.at,
            who: e.name ?? (e.actor.startsWith('automation:') ? 'Automation' : 'Cleanpost'),
            what: `${HISTORY_VERB[e.action] ?? e.action}${e.clientId ? ` for ${clientName.get(e.clientId) ?? 'a client'}` : e.action === 'rule.tested' ? '' : ' for the company'}`,
          })),
      };
    });
    const keys = new Set(out.map((r) => r.ruleKey));
    const checks = stats.rows
      .filter((s) => !keys.has(s.rule_id) && !s.rule_id.startsWith('ai'))
      .map((s) => ({ ruleId: s.rule_id, hits: s.hits }))
      .sort((a, b) => b.hits - a.hits);
    return { rules: out, checks };
  });
}
