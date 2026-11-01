import { defineConfig, devices } from '@playwright/test';

/** End-to-end flows against a seeded database (pnpm db:migrate && pnpm seed). Synthetic data only. */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    // CI runs the production build; locally the dev server is reused if already running.
    command: process.env.CI ? 'pnpm start' : 'pnpm dev',
    url: 'http://localhost:3000/sign-in',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
