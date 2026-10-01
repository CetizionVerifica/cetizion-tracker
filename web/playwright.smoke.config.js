import { defineConfig, devices } from '@playwright/test';

/**
 * Route smoke test: every screen, signed in as an admin, checked for a
 * crash, an uncaught error, a console error or an API 5xx.
 *
 * Starts nothing. It points at an API the caller has already started, and
 * that API serves the built front end from web/dist, so the page and /api
 * are one origin and the database it reads is the one the caller chose:
 *
 *   npm run build                                   (repo root)
 *   PORT=4100 DATABASE_URL=postgres://localhost:5432/cetizion_tracker_qa \
 *     node server/src/index.js
 *   npm run test:smoke                              (in web/)
 *
 * /test-app does all of this against a throwaway database.
 */
const authFile = 'test-results/.smoke-auth.json';

export default defineConfig({
  testDir: './e2e-smoke',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/smoke-results.json' }]],
  use: {
    baseURL: process.env.SMOKE_BASE_URL || 'http://localhost:4100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.js/ },
    {
      name: 'smoke',
      testMatch: /routes\.spec\.js/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: authFile },
    },
  ],
});
