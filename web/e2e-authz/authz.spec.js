/**
 * STATUS (#85): re-pointed at the Mocha Glass screens (Oct 2026). Settings is
 * /settings/<pane> and refuses an admin-only pane with a notice; merging is the
 * duplicates Review dialog and the company's More actions menu; removing a
 * contact is inside Edit contact; row actions are labelled icon buttons.
 *
 * Bootstrap is still not committed. The throwaway database (AUTH_MODE=database)
 * needs the two accounts below and the fixtures the tests name: E2E Alpha
 * Industries + E2E Alpha Industries Ltd (a duplicate pair); E2E Beta Services
 * with the contact E2E Contact Person; PO-E2E-001 on a deal and project owned
 * by the sales account; a USD exchange rate; trip TRV-2026-E2E with vendor bill
 * E2E/1 and the Submitted claim CLM-2026-E2E. The suite has its own testDir and
 * config, so `npm run test:e2e` (testDir ./e2e) does not pick it up.
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
  // The home page is a day, so its heading is today's date.
  await expect(page.getByRole('heading', { name: /\w+day, \d/ })).toBeVisible();
}

/** Open a page and wait for something seeded to appear. */
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
    test('Companies list: merge review and row delete', async ({ page }) => {
      await go(page, '/companies', page.getByRole('link', { name: 'E2E Beta Services', exact: true }));
      // The duplicate pair is seeded, so the panel itself is always present.
      await expect(page.getByText(/may be one client spelt more than once/).first()).toBeVisible();
      const group = page.getByRole('link', { name: 'E2E Alpha Industries', exact: true }).locator('xpath=../..');
      await group.getByRole('button', { name: 'Review' }).click();
      const review = page.getByRole('dialog');
      // Seeing the duplicates is ordinary work; folding them is the admin's.
      await expect(review.getByText('E2E Alpha Industries Ltd').first()).toBeVisible();
      await expectCount(review.getByRole('button', { name: 'Merge', exact: true }), 'Company merge in the duplicates review');
      await page.keyboard.press('Escape');

      const betaRow = page.getByRole('row', { name: /E2E Beta Services/ });
      await expect(betaRow).toBeVisible();
      await expectCount(betaRow.getByRole('button', { name: 'Delete' }), 'Company delete');
    });

    // ---------------------------------------------------------- 2 and 8
    test('Company detail: Merge into… and contact removal', async ({ page }) => {
      await go(page, '/companies', page.getByRole('link', { name: 'E2E Beta Services', exact: true }));
      await page.getByRole('link', { name: 'E2E Beta Services', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'E2E Beta Services' })).toBeVisible();

      await page.getByRole('button', { name: 'More actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Add a contact' })).toBeVisible();
      await expectCount(page.getByRole('menuitem', { name: /^Merge into/ }), 'Company Merge on Company Detail');
      await page.keyboard.press('Escape');

      // The seeded contact proves the People list rendered.
      await page.getByRole('button', { name: 'Edit contact E2E Contact Person' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Edit contact' })).toBeVisible();
      await expectCount(dialog.getByRole('button', { name: 'Remove contact' }), 'Contact removal');
      // Editing a contact stays open to both roles — only removal is the admin's.
      await expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveCount(1);
    });

    // ---------------------------------------------------------- 3, 4 and 5
    test('Settings: exchange-rate Add, Edit and Delete', async ({ page }) => {
      await go(page, '/settings/rates', page.getByRole('heading', { name: 'Exchange rates', level: 1 }));
      const rateRow = page.getByRole('row', { name: /^USD/ }).first();
      await expect(rateRow).toBeVisible();

      await expectCount(page.getByRole('button', { name: 'Add a rate' }), 'Exchange-rate Add');
      await expectCount(rateRow.getByRole('button', { name: /^Edit the USD rate/ }), 'Exchange-rate Edit');
      await expectCount(rateRow.getByRole('button', { name: /^Delete the USD rate/ }), 'Exchange-rate Delete');
    });

    // ---------------------------------------------------------------- 6
    test('Emails & jobs: Run now', async ({ page }) => {
      await page.goto('/settings/emails');
      const runNow = page.getByRole('button', { name: /^Run .* now$/ });
      if (visible) {
        await expect(page.getByRole('heading', { name: 'Scheduled jobs' })).toBeVisible();
        await expect(runNow.first(), 'Run now should be available to an admin').toBeVisible();
      } else {
        // The pane is refused with a reason, not a blank page.
        await expect(page.getByText(/Emails & jobs is only for admins/)).toBeVisible();
        await expect(runNow, 'Run now must not be offered to a sales user').toHaveCount(0);
      }
    });

    // ---------------------------------------------------------------- 9
    test('Purchase orders: row delete', async ({ page }) => {
      await go(page, '/purchase-orders', page.getByRole('row', { name: /PO-E2E-001/ }));
      const poRow = page.getByRole('row', { name: /PO-E2E-001/ });
      await expectCount(poRow.getByRole('button', { name: 'Delete' }), 'Purchase order delete');
    });

    // --------------------------------------------------------------- 10
    test('Payment stages: row delete', async ({ page }) => {
      await page.goto('/payment-stages');
      await page.getByRole('textbox', { name: /^Search/ }).fill('PO-E2E-001');
      const stageRow = page.getByRole('row', { name: /PO-E2E-001/ }).first();
      await expect(stageRow).toBeVisible();
      await expectCount(stageRow.getByRole('button', { name: 'Delete' }), 'Payment stage delete');
    });

    // --------------------------------------------------------- 11 and 12
    test('Import: Settings pane and the old URL', async ({ page }) => {
      await page.goto('/settings/import');
      if (visible) {
        await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toBeVisible();
      } else {
        // Refused with a reason; the import screen itself never draws.
        await expect(page.getByText(/Import is only for admins/)).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Import', level: 1 })).toHaveCount(0);
      }
      // The pre-Settings address still lands in Settings.
      await page.goto('/import');
      await expect(page).toHaveURL(/\/settings\//);
      await expect(page.getByRole('heading', { name: 'Page not found' })).toHaveCount(0);
    });

    // ------------------------------------- expense claim Review / Reimburse
    test('Expense claims: Review is admin-only, the claim itself is visible', async ({ page }) => {
      await go(page, '/expense-claims', page.getByRole('row', { name: /CLM-2026-E2E / }));
      const claimRow = page.getByRole('row', { name: /CLM-2026-E2E / });
      // Seeded as Submitted, so the row reads "Pending approval" for both roles
      // — the button is the only thing that differs.
      await expect(claimRow).toContainText('Pending approval');
      await expectCount(claimRow.getByRole('button', { name: /^Review CLM-2026-E2E,/ }), 'Claim Review');
    });

    // ------------------------------------------- vendor Pay: both roles keep it
    test('Vendor invoices: Pay stays available to both roles', async ({ page }) => {
      await go(page, '/vendor-invoices', page.getByRole('row', { name: /E2E\/1/ }));
      const invoiceRow = page.getByRole('row', { name: /E2E\/1/ });
      await expect(
        invoiceRow.getByRole('button', { name: /^Pay .*E2E\/1/ }),
        'Pay is open to both roles by business decision',
      ).toHaveCount(1);
    });
  });
}

/**
 * Hiding the buttons must not have cost a sales user the job. Entering a claim
 * is ordinary work and has to still work end to end.
 */
test('a sales user can still submit an expense claim', async ({ page }) => {
  await signIn(page, 'sales');
  await go(page, '/expense-claims', page.getByRole('row', { name: /CLM-2026-E2E / }));

  await page.getByRole('button', { name: 'New claim' }).first().click();
  const claimId = `CLM-2026-E2E-${Date.now().toString(36).toUpperCase()}`;
  // Inside the dialog: the rail's Trips link also answers to "Trip".
  const form = page.getByRole('dialog');
  await form.getByLabel(/Claim ID/).fill(claimId);
  await form.getByLabel(/^Trip/).selectOption('TRV-2026-E2E');
  await form.getByLabel(/Amount claimed/).fill('4321');
  await form.getByRole('button', { name: 'Create claim' }).click();

  const row = page.getByRole('row', { name: new RegExp(claimId) });
  await expect(row).toBeVisible();
  // It starts Submitted: the form cannot set approval_status, so a new claim
  // can only ever arrive pending.
  await expect(row).toContainText('Pending approval');
});
