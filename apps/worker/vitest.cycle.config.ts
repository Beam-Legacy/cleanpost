import { randomBytes } from 'node:crypto';
import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

/** `pnpm test:cycle` (docs/12-testing.md): the whole Mode A loop, apart from the unit suites. */
export default cleanpostVitestConfig('cycle', {
  test: {
    include: ['cycle/**/*.test.ts'],
    globalSetup: ['cycle/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
    env: { FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
  },
});
