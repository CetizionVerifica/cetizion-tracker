import { defineConfig, devices } from '@playwright/test';

/**
 * Issue #85 authorisation E2E — test-only, isolated (#85).
 *
 * Separate from playwright.config.js on purpose. That one starts the dev API
 * against the development database and signs in with the shared-mode
 * Username field; this one starts nothing, and points at an API the caller
 * has already started against a throwaway database in AUTH_MODE=database.
 *
 * The API serves the built front end from web/dist, so the browser, the page
 * and /api are all one origin on one port. There is no Vite proxy in play,
 * which is what makes "which database is this talking to?" answerable.
 *
 *   node scratch/e2e-seed.mjs        create + seed the throwaway database
 *   node scratch/e2e-api.mjs         serve it on 4100
 *   npx playwright test --config playwright.authz.config.js
 */
export default defineConfig({
  testDir: './e2e-authz',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_AUTHZ_BASE_URL || 'http://localhost:4100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The installed Google Chrome, not a downloaded build: this machine's
  // Playwright cache is a couple of revisions behind the package, and a
  // verification run is not a reason to pull binaries down.
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  // No webServer: this config must never start the development API.
});
