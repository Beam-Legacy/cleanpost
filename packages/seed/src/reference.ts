/**
 * Global scrub data from `rules/seed/`: seed rules (validated with the DSL schema) and the synthetic
 * reference subset (code sets, NCCI pairs, MUE limits). Idempotent; runs as the system role in every
 * environment, because rules and reference data are not patient data.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { codeSets, mueLimits, ncciEdits, rules, type Database } from '@cleanpost/db';
import { parseRuleFile, referenceFileSchema, type RuleDef } from '@cleanpost/domain';

export const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'rules', 'seed');
const EFFECTIVE_FROM = '2026-01-01';

export function readSeedRules(dir = RULES_DIR): RuleDef[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'reference.json')
    .sort()
    .flatMap((f) => parseRuleFile(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export async function seedReference(
  db: Database,
  dir = RULES_DIR,
): Promise<{ rules: number; codes: number }> {
  const seedRules = readSeedRules(dir);
  for (const r of seedRules) {
    if (r.scope !== 'global') throw new Error(`seed rule ${r.id} must be global`);
    const values = {
      key: r.id,
      scope: r.scope,
      name: r.name,
      kind: r.kind,
      severity: r.severity,
      weight: r.weight,
      condition: r.condition,
      action: r.action,
      source: 'seed',
    };
    await db
      .insert(rules)
      .values({ ...values, tenantId: null })
      .onConflictDoUpdate({
        target: rules.key,
        targetWhere: sql`${rules.tenantId} is null and ${rules.key} is not null`,
        set: { ...values, version: sql`${rules.version} + 1`, updatedAt: new Date() },
      });
  }

  const ref = referenceFileSchema.parse(JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8')));
  const codeRows = [
    ...ref.icd10.billable.map((code) => ({ type: 'icd10', code })),
    ...ref.icd10.headers.map((code) => ({ type: 'icd10_header', code })),
    ...ref.procedures.map((code) => ({ type: /^\d/.test(code) ? 'cpt_code_only' : 'hcpcs', code })),
  ].map((r) => ({ ...r, effectiveFrom: EFFECTIVE_FROM }));
  await db.insert(codeSets).values(codeRows).onConflictDoNothing();
  for (const e of ref.ncci) {
    const [existing] = await db
      .select({ id: ncciEdits.id })
      .from(ncciEdits)
      .where(and(eq(ncciEdits.column1Code, e.column1), eq(ncciEdits.column2Code, e.column2)));
    if (existing) {
      await db
        .update(ncciEdits)
        .set({ modifierIndicator: e.modifierIndicator })
        .where(eq(ncciEdits.id, existing.id));
    } else {
      await db.insert(ncciEdits).values({
        column1Code: e.column1,
        column2Code: e.column2,
        modifierIndicator: e.modifierIndicator,
        effectiveFrom: EFFECTIVE_FROM,
      });
    }
  }
  for (const [code, maxUnits] of Object.entries(ref.mue)) {
    await db
      .insert(mueLimits)
      .values({ code, maxUnits, effectiveFrom: EFFECTIVE_FROM })
      .onConflictDoUpdate({ target: [mueLimits.code, mueLimits.effectiveFrom], set: { maxUnits } });
  }
  return { rules: seedRules.length, codes: codeRows.length };
}
