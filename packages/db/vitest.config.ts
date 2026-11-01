import { cleanpostVitestConfig } from '@cleanpost/testing/vitest';

export default cleanpostVitestConfig('db', {
  test: {
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
  },
});
