import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

export default cleanpostVitestConfig('reports', {
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
