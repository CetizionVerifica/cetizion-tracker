import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Journey board in a real browser (docs/specs/sales-journey §4 B):
 * Pipeline opens on it with three columns, a card opens the step drawer
 * and gives focus back when it closes, and Open full page reaches the
 * record whose rail shows the same step. Runs against the dev database and
 * creates nothing, so it reads whatever sales are already there.
 */
const here = dirname(fileURLToPath(import.meta.url));
const env = (() => {
  try { return Object.fromEntries(readFileSync(join(here, '..', '..', 'server', '.env'), 'utf8').split('\n').filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => l.split('=').map((s) => s.trim()))); }
  catch { return {}; }
})();

/** Sign in the way the form does, as e2e/flows.spec.js explains. */
async function signIn(page) {
  const mode = (await (await page.request.get('/api/auth/config')).json()).data.mode;
  const [label, who, password] = mode === 'database'
    ? ['Email',
      process.env.E2E_EMAIL || env.BOOTSTRAP_ADMIN_EMAIL,
      process.env.E2E_PASSWORD || env.BOOTSTRAP_ADMIN_PASSWORD]
    : ['Username',
      process.env.E2E_USERNAME || env.AUTH_USERNAME || 'admin',
      process.env.E2E_PASSWORD || process.env.AUTH_PASSWORD || env.AUTH_PASSWORD || 'cetizion-dev'];

  expect(who, `no account to sign in with in ${mode} mode — set E2E_EMAIL and E2E_PASSWORD`).toBeTruthy();

  await page.goto('/');
  await page.getByLabel(label, { exact: true }).fill(who);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
}

test('Pipeline opens on the journey, a card opens its steps, and Open full page reaches the same step', async ({ page }) => {
  await signIn(page);
  await page.locator('nav').getByRole('link', { name: /^Pipeline/ }).click();

  // Journey is the default view, with the funnel above three columns.
  await expect(page.getByRole('tab', { name: 'Journey' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Funnel' })).toBeVisible();
  for (const step of ['Enquiry', 'Quotation', 'PO']) {
    await expect(page.getByRole('heading', { name: step, exact: true })).toBeVisible();
  }

  // A quotation if there is one, since every database has those; any sale otherwise.
  await expect(page.getByLabel('Loading the board')).toHaveCount(0);
  const cards = page.locator('[data-journey-card]');
  test.skip(await cards.count() === 0, 'no open sales in this database to open');
  const quoted = page.getByRole('region', { name: 'Quotation', exact: true }).locator('[data-journey-card]');
  const card = (await quoted.count()) ? quoted.first() : cards.first();

  // The drawer opens on the step the sale is on, and the arrow keys walk the steps.
  await card.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  const opened = drawer.getByRole('button', { pressed: true });
  await expect(opened).toBeFocused();
  const step = (await opened.textContent()).match(/Enquiry|Quotation|PO/)[0];
  await page.keyboard.press(step === 'Enquiry' ? 'ArrowDown' : 'ArrowUp');
  await expect(drawer.getByRole('button', { pressed: true })).not.toContainText(step);

  // Esc closes it and gives focus back to the card that opened it.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(card).toBeFocused();

  // Open full page from the step the sale is on: its page's rail is at the same step.
  await card.click();
  await expect(page.getByRole('dialog').getByRole('button', { pressed: true })).toContainText(step);
  await page.getByRole('dialog').getByRole('link', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(/\/(enquiries|quotations|purchase-orders)\//);
  await expect(page.getByRole('list', { name: 'Progress' }).locator('[aria-current="step"]')).toContainText(step);
});

test('the quotation stage board is one switch away, and Back returns to the journey', async ({ page }) => {
  await signIn(page);
  await page.goto('/pipeline');
  await page.getByRole('tab', { name: 'Quotation stages' }).click();
  await expect(page).toHaveURL(/view=stages/);
  await expect(page.getByText('Open, gross')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Journey' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Funnel' })).toBeVisible();
});

test('a funnel figure filters the board to its sales, and its chip takes it off', async ({ page }) => {
  await signIn(page);
  await page.goto('/pipeline');
  const funnel = page.getByRole('region', { name: 'Funnel' });
  await funnel.getByRole('button', { name: /^Quoted/ }).click();
  await expect(page).toHaveURL(/cohort=quoted/);
  await expect(funnel.getByText('Showing: quoted in the last 90 days')).toBeVisible();
  await funnel.getByRole('button', { name: 'Show every sale again' }).click();
  await expect(page).not.toHaveURL(/cohort=/);
});
