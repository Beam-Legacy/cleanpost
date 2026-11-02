import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

export default cleanpostVitestConfig('payer_sim', {
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
