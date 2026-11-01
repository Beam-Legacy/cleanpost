import { randomBytes } from 'node:crypto';
import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

export default cleanpostVitestConfig('worker', {
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { FIELD_ENCRYPTION_KEY: randomBytes(32).toString('base64') },
  },
});
