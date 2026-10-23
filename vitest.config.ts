import { configDefaults, defineConfig } from 'vitest/config';

// `unit` needs nothing external. `integration` uses TEST_DATABASE_URL if set, otherwise the
// global setup starts an ephemeral embedded PostgreSQL; each test file creates and drops its
// own database on that server.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{packages,apps}/*/test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, '**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['{packages,apps}/*/test/**/*.int.test.ts'],
          globalSetup: ['packages/database/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
