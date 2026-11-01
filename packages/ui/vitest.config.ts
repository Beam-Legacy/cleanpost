import react from '@vitejs/plugin-react';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

/** Component tests run in a real browser so axe can check color contrast in both themes. */
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
});
