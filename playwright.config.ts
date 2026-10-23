import { defineConfig, devices } from '@playwright/test';
import { WEB_ORIGIN } from './tests/e2e/support/stack.ts';

// End-to-end tests: tests/e2e/global-setup.ts starts a throwaway Postgres, the game server and a
// preview of the web app, and stops them after the run (also when tests fail).
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  // One shared stack and one game server: run the scenarios one after another.
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: WEB_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
