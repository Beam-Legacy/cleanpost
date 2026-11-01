import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Where every test process writes its logs; `pnpm test` scans this folder for PHI afterwards. */
export const TEST_LOG_DIR = join(repoRoot, '.local', 'test-logs');

/**
 * Shared Vitest config for every package. Routes @cleanpost/log output to a per-package file so the
 * PHI scanner can check a full test run (M0 acceptance: no synthetic names in logs).
 */
export function cleanpostVitestConfig(packageName: string, overrides: ViteUserConfig = {}) {
  mkdirSync(TEST_LOG_DIR, { recursive: true });
  const logFile = join(TEST_LOG_DIR, `${packageName.replace(/[^a-z0-9-]/gi, '_')}.log`);
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
