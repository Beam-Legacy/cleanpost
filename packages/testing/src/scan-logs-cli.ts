#!/usr/bin/env tsx
/**
 * Scans every log file written during a test run for synthetic PHI and exits non-zero on a hit.
 * Run after the test suite: `pnpm test` calls it through the root script.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanForPhi } from './phi-scan';
import { REPO_ROOT, TEST_LOG_DIRNAME } from './vitest-preset';

const files: string[] = [];
for (const group of ['apps', 'packages']) {
  const groupDir = join(REPO_ROOT, group);
  if (!existsSync(groupDir)) continue;
  for (const pkg of readdirSync(groupDir)) {
    const dir = join(groupDir, pkg, TEST_LOG_DIRNAME);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith('.log')) files.push(join(dir, f));
  }
}
let total = 0;
for (const file of files) {
  const findings = scanForPhi(readFileSync(file, 'utf8'));
  for (const f of findings) {
    process.stderr.write(`${relative(REPO_ROOT, file)}:${f.line} ${f.kind} "${f.match}"\n`);
  }
  total += findings.length;
}
process.stdout.write(`PHI log scan: ${files.length} log files, ${total} findings\n`);
process.exit(total === 0 ? 0 : 1);
