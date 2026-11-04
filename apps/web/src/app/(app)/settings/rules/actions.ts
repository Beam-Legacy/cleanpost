'use server';
/**
 * S-05 / S-06: switch a rule off or back on (a built-in rule for the company or one client; a
 * company rule by its enabled flag, as a new version), and test a rule on the last 30 days. Admins
 * only; audited. Changes apply to claims scrubbed from now on (the rules version moves).
 */
import { revalidatePath } from 'next/cache';
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { now as clockNow } from '@cleanpost/clock';
import { claims, claimVersions, recordAudit, rules, tenants, withAudit, withTenant } from '@cleanpost/db';
import {
  conditionSchema,
  policy,
  ruleMatchesPayload,
  rulesOff,
  setRuleOff,
  type ClaimPayload,
} from '@cleanpost/domain';
import { getDb } from '@/lib/server';
import { requireActiveContext, type ActiveContext } from '@/lib/session';

export interface RuleActionResult {
  ok: boolean;
  message: string;
}

async function admin(): Promise<ActiveContext> {
  const ctx = await requireActiveContext();
  policy.assertAllowed(ctx.actor, 'rules.manage');
  return ctx;
}

const Input = z.object({ ruleId: z.uuid(), clientId: z.uuid().nullable(), on: z.boolean() });

/** On or off for the company (clientId null) or, for a built-in rule, one client. */
export async function switchRule(input: z.infer<typeof Input>): Promise<RuleActionResult> {
  const ctx = await admin();
  const { ruleId, clientId, on } = Input.parse(input);
  const res = await withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [r] = await tx
      .select()
      .from(rules)
      .where(and(eq(rules.id, ruleId), or(isNull(rules.tenantId), eq(rules.tenantId, ctx.tenantId))));
    if (!r) return { ok: false, message: 'That rule is not available here.' };
    if (r.tenantId === null) {
      const [t] = await tx
        .select({ settings: tenants.settings })
        .from(tenants)
        .where(eq(tenants.id, ctx.tenantId))
        .for('update');
      const next = setRuleOff(rulesOff(t?.settings), r.key ?? r.id, clientId, !on);
      await tx
        .update(tenants)
        .set({ settings: { ...((t?.settings ?? {}) as object), rulesOff: next } })
        .where(eq(tenants.id, ctx.tenantId));
    } else {
      if (clientId) return { ok: false, message: 'Your own rules switch for the whole company.' };
      if (r.enabled === on) return { ok: true, message: 'Nothing to change.' };
      await tx
        .update(rules)
        .set({ enabled: on, version: r.version + 1 })
        .where(eq(rules.id, r.id));
    }
    await recordAudit(tx, {
      actor: `user:${ctx.user.id}`,
      action: on ? 'rule.turned_on' : 'rule.turned_off',
      entityType: 'rule',
      entityId: r.id,
      clientId,
      metadata: { scope: clientId ? 'client' : 'company', builtIn: r.tenantId === null },
    });
    return {
      ok: true,
      message: `${on ? 'Turned back on' : 'Turned off'}${clientId ? ' for that client' : ''}. Applies to claims scrubbed from now on.`,
    };
  });
  revalidatePath('/settings/rules');
  return res;
}

export interface RuleTestResult {
  ok: boolean;
  message: string;
  matched?: number;
  checked?: number;
  samples?: string[];
}

/**
 * S-06 Test on last 30 days: the rule's condition against the current version of every claim built
 * in the last 30 days. Reading claim content is a PHI read, so the run is audited (counts only).
 */
export async function testRule(ruleId: string): Promise<RuleTestResult> {
  const ctx = await admin();
  const id = z.uuid().parse(ruleId);
  const since = new Date(clockNow().getTime() - 30 * 86_400_000);
  return withTenant(getDb(), { tenantId: ctx.tenantId, userId: ctx.user.id }, async (tx) => {
    const [r] = await tx
      .select()
      .from(rules)
      .where(and(eq(rules.id, id), or(isNull(rules.tenantId), eq(rules.tenantId, ctx.tenantId))));
    const cond = r ? conditionSchema.safeParse(r.condition) : null;
    if (!r || !cond?.success) return { ok: false, message: 'That rule cannot be tested.' };
    const scope = policy.clientFilter(ctx.actor);
    const result = await withAudit(
      tx,
      (res: { matched: number; checked: number }) => ({
        actor: `user:${ctx.user.id}`,
        action: 'rule.tested',
        entityType: 'rule',
        entityId: r.id,
        metadata: { days: 30, checked: res.checked, matched: res.matched },
      }),
      async () => {
        const rows = await tx
          .select({ claimId: claims.id, clientId: claims.clientId, payload: claimVersions.payload })
          .from(claims)
          .innerJoin(claimVersions, eq(claimVersions.id, claims.currentVersionId))
          .where(
            and(
              gte(claimVersions.createdAt, since),
              sql`${claims.status} <> 'voided'`,
              scope === 'all'
                ? undefined
                : inArray(
                    claims.clientId,
                    scope.length ? [...scope] : ['00000000-0000-0000-0000-000000000000'],
                  ),
            ),
          );
        const fits = (c: { clientId: string; payload: unknown }) =>
          (r.scope !== 'client' && r.scope !== 'client_payer') || r.clientId === c.clientId;
        const hits = rows.filter(
          (c) =>
            fits(c) &&
            (r.scope !== 'payer' && r.scope !== 'client_payer'
              ? true
              : (c.payload as ClaimPayload).payerId === r.payerId) &&
            ruleMatchesPayload({ condition: cond.data }, c.payload as ClaimPayload),
        );
        return {
          matched: hits.length,
          checked: rows.length,
          samples: hits.slice(0, 10).map((h) => h.claimId),
        };
      },
    );
    return {
      ok: true,
      message: `On the last 30 days this rule would have matched ${result.matched} of ${result.checked} claims.`,
      ...result,
    };
  });
}
