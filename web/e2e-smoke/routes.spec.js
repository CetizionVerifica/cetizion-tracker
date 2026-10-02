import { test, expect } from '@playwright/test';

/**
 * Every screen opens without breaking.
 *
 * The app has no error boundary, so a render error leaves #root empty: the
 * black screen the settings menu once produced (#153). Nothing else in the
 * suite visits every route, so nothing else would notice. Each route here
 * fails on any of:
 *
 *   - an uncaught exception in the page
 *   - a console error
 *   - an /api response of 500 or above, or an /api request that never answered
 *   - an empty #root, the "Page not found" screen, or a bounce to sign-in
 *
 * Detail pages are reached by following the first matching link on their
 * list, so they test whatever the seeded data holds without hard-coding ids.
 * Keep ROUTES in step with web/src/App.jsx.
 */

const ROUTES = [
  '/', '/worklist', '/data-quality', '/tasks', '/follow-ups', '/companies', '/deliverables',
  '/schedule', '/enquiries', '/quotations', '/pipeline', '/renewals',
  '/sales-report', '/projects', '/purchase-orders', '/payment-stages',
  '/collections', '/cashflow', '/reports', '/insights', '/profitability', '/accounting',
  '/notifications', '/inbox', '/money/invoice-run', '/travel',
  '/vendor-invoices', '/payables', '/expense-claims', '/travel-dashboard',
  '/settings/company', '/settings/holidays', '/settings/rates', '/settings/assumptions',
  '/settings/templates', '/settings/users', '/settings/sign-in', '/settings/tokens',
  '/settings/mailboxes', '/settings/webhooks', '/settings/import', '/settings/emails',
];

// A personal account exists only in database sign-in mode; in shared mode
// /api/auth/account answers 404 on purpose (server/src/auth/account.js).
const ACCOUNT_ROUTES = ['/account/profile', '/account/notifications', '/account/ways-in', '/account/devices'];

const DETAILS = [
  { list: '/companies', href: /^\/companies\/[^/?#]+$/ },
  { list: '/quotations', href: /^\/quotations\/[^/?#]+$/ },
  { list: '/projects', href: /^\/projects\/[^/?#]+$/ },
  { list: '/purchase-orders', href: /^\/purchase-orders\/[^/?#]+$/ },
  { list: '/travel', href: /^\/travel\/[^/?#]+$/ },
];

// Noise that says nothing about the app.
const IGNORED_CONSOLE = [
  /ResizeObserver loop/,
  /Download the React DevTools/,
  /favicon\.ico/,
];

function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // "Failed to load resource" names no URL; the location does.
    const where = msg.location()?.url;
    if (!IGNORED_CONSOLE.some((re) => re.test(text))) problems.push(`console.error: ${text}${where ? ` (${where})` : ''}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/') && res.status() >= 500) {
      problems.push(`HTTP ${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
    }
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('/api/')) {
      problems.push(`request failed: ${req.method()} ${new URL(req.url()).pathname} (${req.failure()?.errorText})`);
    }
  });
  return problems;
}

async function open(page, path) {
  await page.goto(path);
  // Wait for data to load; a page that keeps polling must not hang the run.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
}

async function expectHealthy(page, path, problems) {
  await expect(page.locator('#root'), `${path}: #root is empty (render crash)`).not.toBeEmpty();
  await expect(page.getByRole('heading', { name: 'Sign in' }), `${path}: bounced to sign-in`).toHaveCount(0);
  await expect(page.getByText('That page does not exist'), `${path}: rendered Not Found`).toHaveCount(0);
  expect(problems, `${path}: problems while loading`).toEqual([]);
}

for (const path of ROUTES) {
  test(`opens ${path}`, async ({ page }) => {
    const problems = watch(page);
    await open(page, path);
    await expectHealthy(page, path, problems);
  });
}

for (const path of ACCOUNT_ROUTES) {
  test(`opens ${path}`, async ({ page }) => {
    const mode = (await (await page.request.get('/api/auth/config')).json()).data.mode;
    test.skip(mode !== 'database', 'no personal account in shared sign-in mode');
    const problems = watch(page);
    await open(page, path);
    await expectHealthy(page, path, problems);
  });
}

for (const { list, href } of DETAILS) {
  test(`opens a detail page from ${list}`, async ({ page }) => {
    await open(page, list);
    let target = (await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
      .find((h) => h && href.test(h));
    // Most lists open a record by clicking its row (onRowClick), not a link.
    if (!target) {
      const row = page.locator('tbody tr').first();
      test.skip(!(await row.count()), `${list} has no rows; the seeded data may have none`);
      await row.click();
      await page.waitForURL((url) => href.test(url.pathname), { timeout: 10_000 }).catch(() => {});
      target = new URL(page.url()).pathname;
      expect(target, `clicking the first row on ${list} did not open a detail page`).toMatch(href);
    }

    // Load the detail page fresh, so its own errors are the only ones counted.
    const problems = watch(page);
    await open(page, target);
    await expectHealthy(page, target, problems);
  });
}
