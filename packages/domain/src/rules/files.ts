/**
 * Seed rule files (`rules/seed/*.json`) and the synthetic reference subset, validated before use.
 * Reading the files is the caller's job (the seed CLI, tests); this module only parses.
 */
import { z } from 'zod';
import { ruleSchema, type RuleDef } from './dsl';

const ruleFileSchema = z.object({ $comment: z.string().optional(), rules: z.array(ruleSchema) });

export function parseRuleFile(json: unknown): RuleDef[] {
  const parsed = ruleFileSchema.parse(json);
  const ids = parsed.rules.map((r) => r.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate rule id ${dup}`);
  return parsed.rules;
}

export const referenceFileSchema = z.object({
  $comment: z.string().optional(),
  icd10: z.object({ billable: z.array(z.string()), headers: z.array(z.string()) }),
  procedures: z.array(z.string().regex(/^(\d{4}[0-9A-Z]|[A-V]\d{4})$/)),
  ncci: z.array(
    z.object({ column1: z.string(), column2: z.string(), modifierIndicator: z.enum(['0', '1', '9']) }),
  ),
  mue: z.record(z.string(), z.number().int().positive()),
});
export type ReferenceFile = z.infer<typeof referenceFileSchema>;
