import { defineConfig, devices } from '@playwright/test';
import { STATIC_ORIGIN } from './support/static-site.ts';

// Static (GitHub Pages) end-to-end tests, ADR-0017: global-setup.ts builds `vite build --mode
// static` into a temporary directory and serves it under a sub-path with a plain file server. No
// game server and no Postgres; kept apart from ../../playwright.config.ts so neither suite starts
// the other's stack. Run with `pnpm test:e2e:static`.
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // A whole L1 match with the bot's cosmetic pacing (no test hook for it in the static bundle).
  timeout: 360_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: '../../test-results/e2e-static',
  use: {
    baseURL: STATIC_ORIGIN,
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium-static', use: { ...devices['Desktop Chrome'] } }],
});
