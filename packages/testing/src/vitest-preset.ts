import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Each package writes its test logs to <package>/.test-logs/. Turbo caches that folder as a test
 * output, so a cached run still leaves its logs behind for the PHI scan after `pnpm test`.
 */
export const TEST_LOG_DIRNAME = '.test-logs';

/**
 * Shared Vitest config for every package. Routes @cleanpost/log output to a per-package file so the
 * PHI scanner can check a full test run (M0 acceptance: no synthetic names in logs).
 */
export function cleanpostVitestConfig(packageName: string, overrides: ViteUserConfig = {}) {
  const dir = join(process.cwd(), TEST_LOG_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, `${packageName.replace(/[^a-z0-9-]/gi, '_')}.log`);
  writeFileSync(logFile, ''); // start each run empty
  return defineConfig({
    ...overrides,
    test: {
      include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
      ...overrides.test,
      env: {
        NODE_ENV: 'test',
        LOG_LEVEL: 'debug',
        CLEANPOST_LOG_FILE: logFile,
        ...overrides.test?.env,
      },
    },
  });
}
