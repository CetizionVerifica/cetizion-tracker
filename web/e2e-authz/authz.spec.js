/**
 * STATUS (#85, after the rebase onto main): NOT RUNNABLE AS COMMITTED.
 *
 * These tests were written against the pre-shadcn UI and have not been
 * re-pointed at the redesign. Two separate things are stale:
 *
 *   Selectors. Settings is now /settings/<pane> inside SettingsArea, not one
 *   /settings page of `.card__title` cards; "+ Rate" is "Add a rate"; /emails
 *   redirects to /settings/emails; the row crosses are icon Buttons with
 *   aria-labels; and company merge is a Review dialog, not a per-pair button.
 *
 *   Bootstrap. The two helper scripts named in playwright.authz.config.js
 *   (scratch/e2e-seed.mjs, scratch/e2e-api.mjs) were never committed, so there
 *   is nothing to start the throwaway API this config expects.
 *
 * Kept rather than deleted: what each test asserts is still exactly right, and
 * re-pointing them is less work than deciding the cases again. They are in
 * their own testDir with their own config, so `npm run test:e2e` (testDir
 * ./e2e) does not pick them up and CI is unaffected.
 *
 * The server-side equivalents of these rules are covered and passing in
 * server/test/expenseClaimAuthorization.test.js, authorization.test.js and
 * mcpProtectedFields.test.js. This suite is the courtesy layer on top.
 */

import { test, expect } from '@playwright/test';

/**
 * Every admin-only control Hayyan listed in #85, in a real browser, as a real
 * sales user and a real admin (#85).
 *
 * Two rules shape every test here.
 *
 * First: a control that is missing because the page never loaded is not a
 * pass, it is a test that proves nothing. So each check reaches the page,
 * asserts a piece of seeded content is on screen, and only then asks whether
 * the control is there. A hidden button and a blank page look identical to
 * `toHaveCount(0)`; the content assertion is what tells them apart.
 *
 * Second: every control is checked from both sides. "Sales cannot see it" on
 * its own is equally satisfied by a button nobody can see, which would be a
 * broken app rather than a secure one. The admin half is what proves the
 * control still exists.
 *
 * The database is seeded fresh for each run, so the fixtures below are exact
 * rather than "whatever happens to be in there".
 */

const PASSWORD = 'e2e-test-password-long-enough';
const ACCOUNTS = {
  admin: { email: 'e2e-admin@example.test', name: 'E2E Admin' },
  sales: { email: 'e2e-sales@example.test', name: 'E2E Sales' },
};

async function signIn(page, role) {
  const who = ACCOUNTS[role];
  await page.goto('/');
  // Database mode labels the field Email; shared mode says Username. Asserting
  // the label is also asserting the API is in the mode this suite needs.
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

/** Open a page from the sidebar and wait for something seeded to appear. */
async function go(page, path, anchor) {
  await page.goto(path);
  await expect(anchor).toBeVisible();
}

for (const role of ['sales', 'admin']) {
  const visible = role === 'admin';
  const expectCount = (locator, label) =>
    visible
      ? expect(locator, `${label} should be available to an admin`).toHaveCount(1)
      : expect(locator, `${label} must not be offered to a sales user`).toHaveCount(0);

  test.describe(`as a ${role} user`, () => {
    test.beforeEach(async ({ page }) => { await signIn(page, role); });

    // ---------------------------------------------------------- 1 and 7
    test('Companies list: Merge banner and row delete', async ({ page }) => {
      await go(page, '/companies', page.getByRole('cell', { name: 'E2E Beta Services' }));
      // The duplicate pair is seeded, so the banner itself is always present.
      await expect(page.getByText('look like one client spelt twice')).toBeVisible();

      await expectCount(
        page.getByRole('button', { name: /^Merge into E2E Alpha Industries$/ }),
        'Company Merge on the Companies list',
      );
      const betaRow = page.getByRole('row', { name: /E2E Beta Services/ });
      await expect(betaRow).toBeVisible();
      await expectCount(betaRow.getByRole('button', { name: '✕' }), 'Company delete');
    });

    // ---------------------------------------------------------- 2 and 8
    test('Company detail: Merge into… and contact delete', async ({ page }) => {
      await go(page, '/companies', page.getByRole('cell', { name: 'E2E Beta Services' }));
      await page.getByRole('cell', { name: 'E2E Beta Services' }).click();
      await expect(page.getByRole('heading', { name: 'E2E Beta Services' })).toBeVisible();

      await expectCount(
        page.getByRole('button', { name: 'Merge into…' }),
        'Company Merge on Company Detail',
      );

      // Contacts is the default tab; the seeded contact proves it rendered.
      const contactRow = page.getByRole('row', { name: /E2E Contact Person/ });
      await expect(contactRow).toBeVisible();
      await expectCount(contactRow.getByRole('button', { name: '✕' }), 'Contact delete');
      // Editing a contact stays open to both roles — only removal is the admin's.
      await expect(contactRow.getByRole('button', { name: 'Edit' })).toHaveCount(1);
    });

    // ---------------------------------------------------------- 3, 4 and 5
    test('Settings: exchange-rate Add, Edit and Delete', async ({ page }) => {
      await go(page, '/settings', page.locator('.card__title', { hasText: 'Exchange rates' }));
      const rateRow = page.getByRole('row', { name: /USD/ }).first();
      await expect(rateRow).toBeVisible();

      await expectCount(page.getByRole('button', { name: '+ Rate' }), 'Exchange-rate Add');
      await expectCount(rateRow.getByRole('button', { name: 'Edit' }), 'Exchange-rate Edit');
      await expectCount(rateRow.getByRole('button', { name: 'Delete' }), 'Exchange-rate Delete');
    });

    // ---------------------------------------------------------------- 6
    test('Emails: Run now', async ({ page }) => {
      await go(page, '/emails', page.locator('.card__title', { hasText: 'Scheduled jobs' }));
      // The job registry is readable by both roles, so rows exist either way.
      await expect(page.getByRole('row').nth(1)).toBeVisible();
      const runNow = page.getByRole('button', { name: 'Run now' });
      visible
        ? await expect(runNow.first(), 'Run now should be available to an admin').toBeVisible()
        : await expect(runNow, 'Run now must not be offered to a sales user').toHaveCount(0);
    });

    // ---------------------------------------------------------------- 9
    test('Purchase orders: row delete', async ({ page }) => {
      await go(page, '/purchase-orders', page.getByRole('cell', { name: 'PO-E2E-001' }));
      const poRow = page.getByRole('row', { name: /PO-E2E-001/ });
      await expectCount(poRow.getByRole('button', { name: '✕' }), 'Purchase order delete');
    });

    // --------------------------------------------------------------- 10
    test('Payment stages: row delete', async ({ page }) => {
      await go(page, '/payment-stages', page.getByRole('cell', { name: 'PO-E2E-001' }).first());
      const stageRow = page.getByRole('row', { name: /PO-E2E-001/ }).first();
      await expectCount(stageRow.getByRole('button', { name: '✕' }), 'Payment stage delete');
    });

    // --------------------------------------------------------- 11 and 12
    test('Import: sidebar link and direct URL', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      // The sidebar rendered — Settings is in the same Admin group and is open
      // to both roles, so its presence proves the group is on screen.
      await expect(page.locator('nav').getByRole('link', { name: 'Settings' })).toBeVisible();
      await expectCount(
        page.locator('nav').getByRole('link', { name: 'Bulk import' }),
        'Import navigation',
      );

      await page.goto('/import');
      if (visible) {
        await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
      } else {
        // AdminOnly renders the same 404 a bad URL gets.
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      }
    });

    // ------------------------------------- expense claim Review / Reimburse
    test('Expense claims: Review is admin-only, the claim itself is visible', async ({ page }) => {
      await go(page, '/expense-claims', page.getByRole('cell', { name: 'CLM-2026-E2E' }));
      const claimRow = page.getByRole('row', { name: /CLM-2026-E2E/ });
      // Seeded as Submitted, so the row reads "Pending approval" for both roles
      // — the button is the only thing that differs.
      await expect(claimRow).toContainText('Pending approval');
      await expectCount(claimRow.getByRole('button', { name: 'Review' }), 'Claim Review');
    });

    // ----------------------------------------- vendor Pay: no longer sales'
    //
    // #85 left this open to every signed-in role, and #214 closed it: paying
    // an agency is the travel desk's and an administrator's, so a sales user
    // gets no Pay button and a 403 from the route behind it. The bill itself
    // stays readable — this is about the payment, not the invoice.
    test('Vendor invoices: Pay is not a sales user\'s', async ({ page }) => {
      await go(page, '/vendor-invoices', page.getByText('TRV-2026-E2E').first());
      const invoiceRow = page.getByRole('row', { name: /TRV-2026-E2E/ });
      await expect(invoiceRow, 'the bill is still readable by both roles').toBeVisible();
      await expectCount(invoiceRow.getByRole('button', { name: 'Pay' }), 'Vendor Pay');
    });

    // ------------------------- vendor payment history and the correction
    //
    // The ledger is left out of the invoice's reply for a sales user, so
    // there is no history to draw and no proof to open (#214).
    test('Vendor invoice: the payment history and the correction are not a sales user\'s', async ({ page }) => {
      await go(page, '/vendor-invoices', page.getByText('TRV-2026-E2E').first());
      await page.getByText('TRV-2026-E2E').first().click();
      await expect(page.getByRole('heading', { name: /TRV-2026-E2E/ })).toBeVisible();

      await expectCount(page.getByText('Payments to the agency'), 'Vendor payment history');
      // Not expectCount: the button needs a payment to correct, and whether
      // the fixture has one is not what this test is about. What is certain
      // either way is that a sales user never gets it.
      if (!visible) {
        await expect(
          page.getByRole('button', { name: 'Correct a payment' }),
          'Correct a payment must not be offered to a sales user',
        ).toHaveCount(0);
      }
    });
  });
}

/**
 * Hiding the buttons must not have cost a sales user the job. Entering a claim
 * is ordinary work and has to still work end to end.
 */
test('a sales user can still submit an expense claim', async ({ page }) => {
  await signIn(page, 'sales');
  await go(page, '/expense-claims', page.getByRole('cell', { name: 'CLM-2026-E2E' }));

  await page.getByRole('button', { name: '+ Claim' }).first().click();
  const claimId = `CLM-2026-E2E-NEW`;
  await page.getByLabel(/Claim ID/).fill(claimId);
  await page.getByLabel(/^Trip/).selectOption('TRV-2026-E2E');
  await page.getByLabel(/Amount claimed/).fill('4321');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('cell', { name: claimId })).toBeVisible();
  // It starts Submitted: the form cannot set approval_status, so a new claim
  // can only ever arrive pending.
  await expect(page.getByRole('row', { name: new RegExp(claimId) })).toContainText('Pending approval');
});
