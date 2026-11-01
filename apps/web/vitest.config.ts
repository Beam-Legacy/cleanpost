import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

// Unit tests only; Playwright specs in e2e/ run with `pnpm test:e2e`.
export default cleanpostVitestConfig('web', { test: { passWithNoTests: true } });
