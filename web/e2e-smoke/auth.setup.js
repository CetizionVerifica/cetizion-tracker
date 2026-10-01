import { test as setup, expect } from '@playwright/test';

/**
 * Sign in once and keep the session for every route check. Asks the server
 * which sign-in it wants, the same way the form and e2e/flows.spec.js do.
 */
setup('sign in', async ({ page }) => {
  const mode = (await (await page.request.get('/api/auth/config')).json()).data.mode;
  const [label, who, password] = mode === 'database'
    ? ['Email', process.env.E2E_EMAIL, process.env.E2E_PASSWORD]
    : ['Username', process.env.E2E_USERNAME || 'admin', process.env.E2E_PASSWORD || 'cetizion-dev'];
  expect(who, `no account to sign in with in ${mode} mode: set E2E_EMAIL and E2E_PASSWORD`).toBeTruthy();

  await page.goto('/');
  await page.getByLabel(label, { exact: true }).fill(who);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /\w+day, \d/ })).toBeVisible();

  await page.context().storageState({ path: 'test-results/.smoke-auth.json' });
});
