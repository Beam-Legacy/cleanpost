import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

export default cleanpostVitestConfig('auth', {
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
  },
});
