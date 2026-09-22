import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The critical flows, in a real browser (#36): sign in, quote a client,
 * see the client once under Companies, import a sheet and commit it.
 * Runs against the dev database; every record it creates carries a
 * unique stamp so re-runs never collide.
 */
const here = dirname(fileURLToPath(import.meta.url));
const env = (() => {
  try { return Object.fromEntries(readFileSync(join(here, '..', '..', 'server', '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split('=').map((s) => s.trim()))); }
  catch { return {}; }
})();
const PASSWORD = process.env.E2E_PASSWORD || process.env.AUTH_PASSWORD || env.AUTH_PASSWORD || 'cetizion-dev';
const USER = process.env.E2E_USERNAME || env.AUTH_USERNAME || 'admin';
const stamp = Date.now().toString(36);

async function signIn(page) {
  await page.goto('/');
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/**
 * Everything the sidebar no longer lists is reached this way, so the
 * palette is now on the critical path rather than a convenience.
 */
async function palette(page, type) {
  await page.keyboard.press('Meta+k');
  await expect(page.getByPlaceholder('Search or do anything')).toBeVisible();
  await page.keyboard.type(type);
}

test('sign in and see the dashboard', async ({ page }) => {
  await signIn(page);
  // Six record types, not thirty screens.
  await expect(page.locator('nav').getByRole('link', { name: /^Deals/ })).toBeVisible();
});

test('the palette finds a record by half its client name', async ({ page }) => {
  await signIn(page);
  await palette(page, 'hind');
  // The search is server-side and debounced, so wait for the group rather
  // than the keystroke.
  await expect(page.getByText(/Deals matching/)).toBeVisible({ timeout: 10_000 });
  await page.getByRole('option', { name: /CTZ\/QT\// }).first().click();
  await expect(page).toHaveURL(/\/quotations\/CTZ%2FQT%2F/);
});

test('the palette offers the verb, not the screen that owns it', async ({ page }) => {
  await signIn(page);
  await palette(page, 'raise an invoice');
  await page.getByRole('option', { name: /Raise an invoice/ }).click();
  // Choosing the verb asks which record, then turns into its form — all
  // without leaving the page underneath.
  await expect(page.getByPlaceholder('Which stage?')).toBeVisible();
  await page.getByRole('option').first().click();
  await expect(page.getByLabel(/Invoice number/)).toBeVisible();
  await page.getByRole('button', { name: /Raise an invoice/ }).click();
  await expect(page.getByText('Invoice number is needed.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('a wrong password is refused', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Username').fill(USER);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.alert')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
});

test('quote a new client, then find the client once under Companies', async ({ page }) => {
  await signIn(page);
  const client = `E2E Client ${stamp}`;
  await page.locator('nav').getByRole('link', { name: /^Deals/ }).click();
  await page.getByRole('button', { name: '+ Quotation' }).click();
  await page.getByLabel(/^Client\*/).fill(client);
  await page.getByLabel('Service quoted').fill('EcoVadis');
  await page.getByLabel('Contact person').fill('Test Contact');
  await page.getByLabel('Quotation value').fill('250000');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.locator('.toast', { hasText: 'Created CTZ/QT/' })).toBeVisible();
  await expect(page.locator('table')).toContainText(client);

  await page.locator('nav').getByRole('link', { name: /Companies/ }).click();
  await page.getByPlaceholder(/Search company/).fill(client);
  await expect(page.locator('table tbody tr')).toHaveCount(1);
  await page.locator('table tbody tr td').nth(1).click();
  await expect(page.getByRole('heading', { name: client })).toBeVisible();
  // Tabs are a tablist now, not plain buttons: the role is the assertion.
  await expect(page.getByRole('tab', { name: /Contacts \(1\)/ })).toBeVisible();
});

test('import a sales sheet, review the duplicates, commit', async ({ page }) => {
  await signIn(page);
  // Bulk import left the sidebar with the other twenty-odd screens; the
  // palette is how it is reached now.
  await palette(page, 'bulk import');
  await page.getByRole('option', { name: 'Bulk import' }).click();
  await page.locator('input[type=file]').setInputFiles(join(here, 'fixtures', 'sales-sheet.xlsx'));
  await page.getByRole('button', { name: 'Upload and analyse' }).click();
  await expect(page.getByRole('heading', { name: /Import #\d+/ })).toBeVisible({ timeout: 90_000 });
  // How the batch was planned, in words. Never the model id: it means
  // nothing to whoever is importing, and it changes whenever the importer
  // is retuned. The id itself stays on the batch row for the record.
  await expect(page.getByText(/rows on sheet .* · (AI-assisted|rules only)/)).toBeVisible();
  // The sheet holds clients the seed data already has: duplicates show in yellow.
  await expect(page.locator('tr.tr--dup').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Quotations/ })).toBeVisible();
  // A client-and-service match is only a possible duplicate: it can be imported as new.
  await expect(page.getByText(/possible duplicates? (was|were) matched only by client name and service/)).toBeVisible();
  const possible = page.locator('tr', { hasText: 'Not certain' }).first();
  await possible.locator('select').selectOption('create');
  await expect(possible.locator('select')).toHaveValue('create');
  await page.getByRole('button', { name: /6\. Summary/ }).click();
  await page.getByRole('button', { name: 'Complete and commit' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Complete and commit' }).click();
  await expect(page.locator('.alert', { hasText: 'This batch has been committed' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /1\. Quotations/ }).click();
  await expect(page.getByText('imported as new').first()).toBeVisible();
});
