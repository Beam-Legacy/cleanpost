/** The NCCI pairs the payers edit with: the same synthetic subset Cleanpost scrubs against. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { NcciPair } from './adjudicate';

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'rules',
  'seed',
  'reference.json',
);

const schema = z.object({
  ncci: z.array(z.object({ column1: z.string(), column2: z.string(), modifierIndicator: z.string() })),
});

export function loadNcci(file = FILE): NcciPair[] {
  return schema.parse(JSON.parse(readFileSync(file, 'utf8'))).ncci;
}
