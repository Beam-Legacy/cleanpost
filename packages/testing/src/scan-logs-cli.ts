#!/usr/bin/env tsx
/**
 * Scans every log file written during a test run for synthetic PHI and exits non-zero on a hit.
 * Run after the test suite: `pnpm test` calls it through the root script.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanForPhi } from './phi-scan';
import { TEST_LOG_DIR } from './vitest-preset';

const files = existsSync(TEST_LOG_DIR) ? readdirSync(TEST_LOG_DIR).filter((f) => f.endsWith('.log')) : [];
let total = 0;
for (const file of files) {
  const findings = scanForPhi(readFileSync(join(TEST_LOG_DIR, file), 'utf8'));
  for (const f of findings) {
    process.stderr.write(`${file}:${f.line} ${f.kind} "${f.match}"\n`);
  }
  total += findings.length;
}
process.stdout.write(`PHI log scan: ${files.length} log files, ${total} findings\n`);
process.exit(total === 0 ? 0 : 1);
