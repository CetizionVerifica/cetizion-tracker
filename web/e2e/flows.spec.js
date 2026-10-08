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
const stamp = Date.now().toString(36);

/**
 * Sign in the way the form does: by asking the server which question it
 * will be asked.
 *
 * The deployment decides. `shared` mode wants the username and password
 * from the environment; `database` mode wants an email and that account's
 * password, and the form's first field is labelled differently in each. A
 * test that hard-coded "Username" passed for a year and then failed on
 * every case at once the day local dev moved to per-person sign-in — which
 * is the same brittleness the form itself was written to avoid.
 */
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
  // The home page greets whoever signed in.
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
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
  await expect(page.locator('nav').getByRole('link', { name: /^Deals/ })).toBeVisible();
});

/**
 * The sidebar is grouped by the process (web/CLAUDE.md §3): every group is
 * there in order, a folded group stays folded after a reload, and the app
 * carries no company name.
 */
test('the sidebar groups follow the process and remember being folded', async ({ page }) => {
  await signIn(page);
  const nav = page.locator('nav');
  const groups = nav.getByRole('button', { name: /^(Sell|Deliver|Money|Travel|Insights)$/ });
  await expect(groups).toHaveText(['Sell', 'Deliver', 'Money', 'Travel', 'Insights']);
  await expect(page.getByText('Sales Tracker', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Cetizion Verifica/)).toHaveCount(0);

  await nav.getByRole('button', { name: 'Sell' }).click();
  await expect(nav.getByRole('link', { name: /^Deals/ })).toBeHidden();
  await page.reload();
  await expect(nav.getByRole('button', { name: 'Sell' })).toHaveAttribute('aria-expanded', 'false');
  await nav.getByRole('button', { name: 'Sell' }).click();
  await expect(nav.getByRole('link', { name: /^Deals/ })).toBeVisible();
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
  // The number is deliberately NOT required — left blank the server takes
  // the next in the GST series, which is the only way that series stays
  // unbroken when two people raise at once. The date still guards the form.
  await page.getByLabel(/Invoice date/).fill('');
  await page.getByRole('button', { name: /Raise an invoice/ }).click();
  await expect(page.getByText('Invoice date is needed.')).toBeVisible();
  await page.keyboard.press('Escape');
  // The home page greets whoever signed in.
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toBeVisible();
});

test('a wrong password is refused', async ({ page }) => {
  await page.goto('/');
  // Whichever field this deployment asks for, filled with something real,
  // so what is being refused is the password and not the name.
  const mode = (await (await page.request.get('/api/auth/config')).json()).data.mode;
  const label = mode === 'database' ? 'Email' : 'Username';
  const who = mode === 'database'
    ? (process.env.E2E_EMAIL || env.BOOTSTRAP_ADMIN_EMAIL)
    : (process.env.E2E_USERNAME || env.AUTH_USERNAME || 'admin');
  await page.getByLabel(label, { exact: true }).fill(who);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  // A real alert, announced, not a div with a class on it.
  await expect(page.getByRole('alert')).toContainText(/do not match/);
  await expect(page.getByRole('heading', { name: /^Good (morning|afternoon|evening)/ })).toHaveCount(0);
  // And the password box is cleared rather than left holding a wrong one.
  await expect(page.getByLabel('Password')).toHaveValue('');
});

test('quote a new client, then find the client once under Companies', async ({ page }) => {
  await signIn(page);
  const client = `E2E Client ${stamp}`;
  await page.locator('nav').getByRole('link', { name: /^Deals/ }).click();
  await page.getByRole('button', { name: 'New quotation' }).first().click();
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
  // The company record is one page now, not eight tabs: the people are in
  // the rail and the deal is in the list it shares with orders.
  await expect(page.getByText('People')).toBeVisible();
  await expect(page.getByText('Test Contact').first()).toBeVisible();
  await expect(page.getByText('Deals and orders')).toBeVisible();
  await expect(page.getByText('EcoVadis').first()).toBeVisible();
});

test('import a sales sheet, review the duplicates, commit', async ({ page }) => {
  await signIn(page);
  // Bulk import left the sidebar with the other twenty-odd screens; the
  // palette is how it is reached now.
  await palette(page, 'bulk import');
  await page.getByRole('option', { name: 'Bulk import' }).click();
  // The drop zone reads the sheet as soon as one is chosen — there is no
  // second button. Nothing reaches the live tables until the review is
  // committed at the end of this test, which is what makes that safe.
  await page.locator('input[type=file]').setInputFiles(join(here, 'fixtures', 'sales-sheet.xlsx'));
  await expect(page.getByRole('heading', { name: /Import #\d+/ })).toBeVisible({ timeout: 90_000 });
  // How the batch was planned, in words. Never the model id: it means
  // nothing to whoever is importing, and it changes whenever the importer
  // is retuned. The id itself stays on the batch row for the record.
  await expect(page.getByText(/rows on sheet .* · (AI-assisted|rules only)/)).toBeVisible();
  // The sheet holds clients the seed data already has: duplicates show in yellow.
  await expect(page.locator('tr.tr--dup').first()).toBeVisible();
  await expect(page.getByRole('tab', { name: /1\. Quotations/ })).toBeVisible();
  // A client-and-service match is only a possible duplicate: it can be imported as new.
  await expect(page.getByText(/possible duplicates? (was|were) matched only by client name and service/)).toBeVisible();
  const possible = page.locator('tr', { hasText: 'Not certain' }).first();
  await possible.locator('select').selectOption('create');
  await expect(possible.locator('select')).toHaveValue('create');
  await page.getByRole('tab', { name: /6\. Summary/ }).click();
  await page.getByRole('button', { name: 'Complete and commit' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Complete and commit' }).click();
  await expect(page.locator('.alert', { hasText: 'This batch has been committed' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: /1\. Quotations/ }).click();
  await expect(page.getByText('imported as new').first()).toBeVisible();
});

/**
 * Reports (#22): a chart is a picture, so every one of them has a table
 * twin, and the twin is what a screen reader gets whether or not anyone
 * presses the toggle. This test reads the numbers the way that reader
 * would — off the twin, not off the bars.
 */
test('every report chart has a table twin, and its rows link into the list', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
  // These charts sit under More analysis, below the six questions, folded until opened.
  await page.getByText('More analysis: pipeline, ageing, cash, win rate').click();

  // Before the toggle is touched: the chart is hidden from the tree and the
  // twin is there in text. A band with nothing in it still has a row.
  await expect(page.getByRole('table', { name: /Collections ageing/ })).toBeAttached();
  await expect(page.getByRole('cell', { name: 'Not yet due' })).toBeAttached();

  const ageing = page.locator('[data-slot="card"]').filter({ hasText: 'Collections ageing' });
  await ageing.getByRole('button', { name: 'Open as table' }).click();
  await expect(page.getByRole('button', { name: 'Show the chart' })).toBeVisible();
  // Now the same row is a link, and it lands on the queue filtered to it.
  await page.getByRole('link', { name: '31–60 days' }).click();
  await expect(page).toHaveURL(/\/collections\?bucket=31-60/);
  await expect(page.getByText(/Showing 31–60 days only/)).toBeVisible();
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page).toHaveURL(/\/collections$/);
});

/**
 * Insights (docs/insights-dashboard-plan.md §7): five questions, each with a
 * table twin a screen reader gets without asking, and every row a link into
 * the list that counts the same records. The expected count comes from the
 * API, so the test holds whatever the database has in it.
 */
test('Insights answers five questions, and a bar opens the list it counted', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Insights', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  for (const question of [/past their follow-up date/, /What do clients owe us/, /enquiries need handling/, /about to become POs/, /expect each period/]) {
    await expect(page.getByRole('heading', { name: question })).toBeVisible();
  }
  // The twins are in the tree before anyone presses a toggle.
  await expect(page.getByRole('table', { name: /By days past the date/ })).toBeAttached();
  await expect(page.getByRole('table', { name: /Unpaid invoices by age/ })).toBeAttached();

  const data = (await (await page.request.get('/api/insights')).json()).data;
  const band = data.follow_ups.buckets.find((b) => b.count > 0) ?? data.follow_ups.buckets[0];
  const card = page.locator('[data-slot="card"]').filter({ hasText: 'By days past the date' });
  await card.getByRole('button', { name: 'Open as table' }).click();
  await card.getByRole('link', { name: band.label }).click();
  await expect(page).toHaveURL(new RegExp(`/quotations\\?follow_up=overdue&overdue_days=${band.key.replace('+', '%2B')}`));
  await expect(page.getByText(`${band.count} record${band.count === 1 ? '' : 's'}`, { exact: true })).toBeVisible();
});

/**
 * The project record (C15): the checklist is the page, and the steps
 * another record owns are not ticked by hand.
 */
test('a checklist step that finance owns has no tick box, and says who has it', async ({ page }) => {
  await signIn(page);
  await page.goto('/projects/PRJ-2026-001');
  await expect(page.getByText('The standard eleven, from the template')).toBeVisible();

  // A step a person owns is a real checkbox, and ticking it is the fact.
  const manual = page.getByRole('listitem').filter({ hasText: 'Project manager and delivery team assigned' });
  await expect(manual.getByRole('checkbox')).toBeVisible();

  // A step finance owns is not offered as a checkbox at all — a disabled
  // one would read as "you may not", and the truth is "not yours to do".
  const finance = page.getByRole('listitem').filter({ hasText: 'Finance raises the stage-1 (advance) invoice' });
  await expect(finance.getByRole('checkbox')).toHaveCount(0);
  await expect(finance.getByText('with finance', { exact: true })).toBeVisible();
  // And it reads its state from the payment schedule, not from the stored
  // status — this row is seeded 'Done' and one order is still unbilled.
  await expect(finance.getByText(/With finance · PO-/)).toBeVisible();

  // The one button on the page says what it will do before you press it.
  await expect(page.getByText(/Recording the delivery date closes the delivery step/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Record the delivery date' })).toHaveCount(1);
});

/**
 * The inbox's security boundary, in the browser that enforces it (#105).
 *
 * cleanMail is the DOMPurify pass — the library Zero uses — and it only
 * runs where there is a DOM, so the unit suite in Node cannot see it work:
 * there, it deliberately returns its input and leaves the frame's content
 * policy to do the stopping. This is the test that watches it actually
 * strip something, and it runs the real module rather than a copy of it.
 */
test('a message is cleaned in the browser, and a tracking pixel loses its src', async ({ page }) => {
  await page.goto('/');
  const evil = '<p onclick="steal()">Hello</p>'
    + '<script>alert(1)</script>'
    + '<img src="https://tracker.invalid/open.gif?id=9" width="1" height="1">'
    + '<img src="cid:logo.png">'
    + '<a href="javascript:alert(1)">click</a>'
    + '<iframe src="https://evil.invalid"></iframe>';

  const out = await page.evaluate(async (html) => {
    const { cleanMail, framePolicy } = await import('/src/lib/mailFrame.js');
    return { blocked: cleanMail(html, false), shown: cleanMail(html, true), policy: framePolicy(false) };
  }, evil);

  // Nothing that runs, navigates or posts survives either way.
  for (const body of [out.blocked, out.shown]) {
    expect(body).not.toContain('<script');
    expect(body).not.toContain('onclick');
    expect(body).not.toContain('<iframe');
    expect(body).not.toContain('javascript:');
  }

  // The read receipt: its src is gone, and the policy would refuse the
  // fetch even if it were not. An image that travelled with the message
  // has no network to reach, so it stays.
  expect(out.blocked).not.toContain('tracker.invalid');
  expect(out.blocked).toContain('cid:logo.png');
  expect(out.policy).toContain("img-src data: cid:");
  expect(out.policy).not.toContain('https:');

  // And asking for them puts them back.
  expect(out.shown).toContain('tracker.invalid');
});

/**
 * The settings menu beside the profile, opened.
 *
 * This is a regression test with a cause. The theme picker was added to
 * this menu using DropdownMenuRadioGroup and DropdownMenuRadioItem, and
 * neither was added to the file's import list — so both were undefined and
 * rendering the menu threw, which unmounts the React tree and leaves the
 * body's own background. On the dark theme that is a black screen, and no
 * amount of navigating fixes it, because there is nothing left running to
 * navigate.
 *
 * Nothing caught it. The bundler does not resolve JSX identifiers, tsc is
 * set to checkJs:false so a .jsx file is never checked, there is no linter,
 * and no test had ever opened this menu. That last one is the only gap a
 * test can close, so this closes it: open the menu and read every item.
 *
 * It asserts on the items rather than on a screenshot because the failure
 * was a crash, not a colour — an empty menu and a wrong shade of grey are
 * different bugs, and only one of them is this one.
 */
test('the settings menu opens, with every item on it', async ({ page }) => {
  const crashes = [];
  page.on('pageerror', (err) => crashes.push(String(err)));

  await signIn(page);
  await page.getByRole('button', { name: 'Settings and sign out' }).click();

  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  for (const name of ['Settings', 'Search or do anything', 'Sign out']) {
    await expect(menu.getByRole('menuitem', { name })).toBeVisible();
  }
  // The three theme choices are radios, not plain items, and they are what
  // was undefined.
  for (const name of ['Light', 'Dark', 'Match the system']) {
    await expect(menu.getByRole('menuitemradio', { name })).toBeVisible();
  }

  expect(crashes, 'rendering the menu threw').toEqual([]);
});

/**
 * Dark mode, end to end: light is the default (web/CLAUDE.md §1); choose
 * dark, and the document says so.
 *
 * The class on <html> is the whole mechanism — every token in globals.css
 * hangs off `.dark` being present or absent — so this is the one assertion
 * that cannot pass while the theme is broken.
 */
test('choosing dark mode puts the dark class on the document', async ({ page }) => {
  await signIn(page);
  await expect(page.locator('html')).not.toHaveClass(/dark/);

  await page.getByRole('button', { name: 'Settings and sign out' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();

  await expect(page.locator('html')).toHaveClass(/dark/);
  // And it survives a reload, which is what the pre-paint script in
  // index.html exists for.
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
});

/**
 * Reports (docs/sales-report-rework-plan.md §7): pick "Last month", follow
 * the Lost slice into the enquiries it counted — the same number, by the
 * same rules — and download the period as a PDF. An enquiry lost last month
 * is made first, so the slice is never empty whatever the database holds.
 */
test('a Reports slice opens exactly the records it counted, and the PDF downloads', async ({ page }) => {
  await signIn(page);

  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const day = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-15`;
  // An enquiry leaves New only with a source, and is Unqualified only with a reason.
  const [source] = (await (await page.request.get('/api/lead-sources')).json()).data;
  const made = await page.request.post('/api/enquiries', {
    data: { client_name: `E2E Lost ${stamp}`, enquiry_date: day, status: 'Unqualified', source_id: source.id, unqualified_notes: 'End-to-end test' },
  });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.goto('/reports');
  await page.getByLabel('Period').selectOption('last-month');
  await expect(page.getByRole('heading', { name: '2. What happened to them?' })).toBeVisible();

  const from = new URL(page.url()).searchParams.get('from');
  const to = new URL(page.url()).searchParams.get('to');
  const report = (await (await page.request.get(`/api/reports/sales?from=${from}&to=${to}`)).json()).data;
  const lost = report.outcomes.slices.find((s) => s.key === 'lost').count;
  expect(lost).toBeGreaterThan(0);

  // The table twin's link is the keyboard path to where the bar goes.
  const outcome = page.locator('section', { has: page.getByRole('heading', { name: '2. What happened to them?' }) });
  await outcome.getByRole('button', { name: /Open as table/ }).click();
  await outcome.getByRole('link', { name: 'Lost', exact: true }).click();

  await expect(page).toHaveURL(/\/enquiries\?.*report_outcome=lost/);
  await expect(page.getByText(`The ${lost} record${lost === 1 ? '' : 's'} behind the Reports chart`)).toBeVisible();
  await expect(page.getByText(`E2E Lost ${stamp}`)).toBeVisible();

  await page.goto(`/reports?from=${from}&to=${to}`);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download PDF' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`cetizion-sales-report-${from}-to-${to}.pdf`);
  const pdf = readFileSync(await download.path());
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

  // Read it back: the six questions, in the order the screen asks them.
  const text = await pdfText(pdf);
  const headings = [
    '1. How many enquiries did we receive?', '2. What happened to them?', '3. Which sectors gave us POs?',
    '4. Which services sell best?', '5. New and existing customers', '6. Monthly revenue', 'Notes and what to fix',
  ];
  const at = headings.map((h) => text.lastIndexOf(h));
  expect(at.every((i) => i >= 0), `every heading is in the PDF: ${JSON.stringify(at)}`).toBeTruthy();
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

/** A PDF's text, page after page, with its whitespace collapsed. pdf.js reads it in Node, no browser. */
async function pdfText(buffer) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  return pages.join(' ').replace(/\s+/g, ' ').replace(/(\d)\. +/g, '$1. ');
}

/**
 * The database the API runs on, for the two tests below that start from an
 * email the reader has already judged: without an AI key, no email can be
 * judged here, so the decision is written as the reader would write it.
 */
async function withDatabase(fn) {
  const { createRequire } = await import('node:module');
  const pg = createRequire(join(here, '..', '..', 'server', 'package.json'))('pg');
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL || process.env.DATABASE_URL || env.DATABASE_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** A quotation through the API, with one priced line: what a PO is registered against. */
async function quotationFor(page, client) {
  const { data: q } = await (await page.request.post('/api/quotations', { data: { client_name: client, service_quoted: 'EcoVadis', quotation_date: new Date().toISOString().slice(0, 10) } })).json();
  await page.request.post('/api/quotation-lines', { data: { quotation_id: q.id, description: 'EcoVadis assessment', qty: 1, rate: 250000, gst_rate: 18 } });
  return q;
}

test('a PO from email waiting for review is registered by hand, and the PO says where it came from', async ({ page }) => {
  await signIn(page);
  const client = `E2E PO Client ${stamp}`;
  const q = await quotationFor(page, client);
  await withDatabase(async (db) => {
    const { rows: [box] } = await db.query(`INSERT INTO connected_accounts (username, provider, email) VALUES ('admin', 'test', $1) RETURNING id`, [`po-${stamp}@cetizionverifica.com`]);
    await db.query(
      `INSERT INTO email_po_decisions (account_id, provider_id, from_email, received_at, outcome, review_reason, method, suggested_quotations)
       VALUES ($1, $2, 'buyer@e2e-client.com', now(), 'review', 'several_matches', 'ai', $3)`, [box.id, `po-${stamp}`, [q.quotation_no]]);
  });

  await page.goto('/purchase-orders?tab=review');
  const row = page.locator('table tbody tr', { hasText: 'buyer@e2e-client.com' });
  await expect(row).toContainText('More than one quotation could be it');
  await expect(row).toContainText(q.quotation_no);
  await row.getByRole('button', { name: 'Register against…' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  // No AI key here: the dialog opens empty, and says so.
  await expect(page.getByText('The PO could not be read again')).toBeVisible();
  await page.getByLabel('PO number').fill(`E2E-PO-${stamp}`);
  await page.getByRole('button', { name: 'Register PO and project' }).click();

  await expect(page).toHaveURL(new RegExp(`/purchase-orders/E2E-PO-${stamp}$`));
  await expect(page.getByText('Registered from the client\'s PO emailed')).toBeVisible();
  await page.goto('/purchase-orders?tab=review');
  await expect(page.locator('table tbody tr', { hasText: 'buyer@e2e-client.com' })).toHaveCount(0);
});

test('a PO registered from email carries a banner until somebody marks it checked', async ({ page }) => {
  await signIn(page);
  const q = await quotationFor(page, `E2E Banner Client ${stamp}`);
  const poNumber = `E2E-AUTO-${stamp}`;
  await page.request.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`, { data: { po_number: poNumber } });
  await withDatabase(async (db) => {
    const { rows: [box] } = await db.query(`INSERT INTO connected_accounts (username, provider, email) VALUES ('admin', 'test', $1) RETURNING id`, [`auto-${stamp}@cetizionverifica.com`]);
    await db.query(
      `INSERT INTO email_po_decisions (account_id, provider_id, from_email, received_at, outcome, mode, method, po_number, quotation_no, stages_source)
       VALUES ($1, $2, 'buyer@e2e-banner.com', now(), 'registered', 'live', 'ai', $3, $4, 'po_terms')`, [box.id, `auto-${stamp}`, poNumber, q.quotation_no]);
  });

  await page.goto(`/purchase-orders/${poNumber}`);
  // The banner, and the email-origin note under it once that has loaded, both say it: the first.
  await expect(page.getByText('Registered automatically from the client\'s PO emailed on').first()).toBeVisible();
  await page.getByRole('button', { name: 'Mark checked' }).click();
  await expect(page.getByRole('button', { name: 'Mark checked' })).toHaveCount(0);
  await expect(page.getByText('Registered automatically from the client\'s PO emailed').first()).toBeVisible();

  // And the list finds it as one registered from email.
  await page.goto('/purchase-orders?from_email=1');
  await expect(page.locator('table')).toContainText(poNumber);
});

test('the client portal shows each PO and its invoices with GST, and staff preview the same', async ({ page }) => {
  await signIn(page);
  const client = `E2E Portal Client ${stamp}`;
  const q = await quotationFor(page, client);
  const poNumber = `E2E-PORTAL-${stamp}`;
  const invoiceNo = `E2E-INV-${stamp}`;
  await page.request.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`, { data: { po_number: poNumber } });
  // A contact allowed into the portal, and the PO's first stage invoiced.
  const { companyId, contactId } = await withDatabase(async (db) => {
    const { rows: [po] } = await db.query('SELECT p.company_id FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.po_number = $1', [poNumber]);
    const { rows: [ct] } = await db.query('INSERT INTO contacts (company_id, name, email, portal_access) VALUES ($1, $2, $3, true) RETURNING id', [po.company_id, 'Portal Person', `portal-${stamp}@example.com`]);
    await db.query(`UPDATE payment_stages SET invoice_no = $2, invoice_date = CURRENT_DATE
                     WHERE id = (SELECT id FROM payment_stages WHERE po_number = $1 ORDER BY stage_no LIMIT 1)`, [poNumber, invoiceNo]);
    return { companyId: po.company_id, contactId: ct.id };
  });
  await page.request.patch(`/api/portal-admin/companies/${companyId}`, { data: { portal_enabled: true, portal_sections: ['projects', 'documents', 'invoices', 'certificates', 'contact'] } });
  const { data: invite } = await (await page.request.post(`/api/portal-admin/contacts/${contactId}/invite`)).json();

  // Staff see the client's view from the company page.
  await page.goto(`/companies/${companyId}`);
  await page.getByRole('button', { name: 'Show the client\'s view' }).click();
  await expect(page.getByText(invoiceNo).first()).toBeVisible();
  await expect(page.getByText('Taxable').first()).toBeVisible();

  // The client, from the emailed link: the PO with what is still to bill, then the invoice with its GST.
  const link = new URL(invite.url);
  await page.goto(link.pathname);
  await expect(page.getByRole('heading', { name: client })).toBeVisible();
  await page.getByRole('button', { name: 'Projects & orders' }).click();
  await expect(page.getByText(`PO ${poNumber}`).first()).toBeVisible();
  await expect(page.getByText('Still to bill')).toBeVisible();
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await expect(page.getByText('GST', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(invoiceNo).first()).toBeVisible();

  // #198 phase 2: the client tells us they paid. It is a claim: the invoice says so, the figures do not change.
  await page.getByRole('button', { name: "Tell us you've paid" }).first().click();
  await page.getByLabel('Reference').fill(`UTR-${stamp}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(/finance team will check/)).toBeVisible();
  await expect(page.getByText('Being checked')).toBeVisible();

  // Finance sees it in Collections and matches it by recording the receipt it reports.
  await page.goto('/collections');
  await expect(page.getByText('From the client portal')).toBeVisible();
  await expect(page.getByText(`UTR-${stamp}`)).toBeVisible();
  await page.getByRole('button', { name: 'Match', exact: true }).click();
  await page.getByRole('button', { name: 'Save payment' }).click();
  await expect(page.getByText('No payments reported')).toBeVisible();

  // The client sees it recorded.
  await page.goto('/portal');
  await page.getByRole('button', { name: 'Invoices', exact: true }).click();
  await expect(page.getByText('Payment recorded', { exact: true })).toBeVisible();
});

/**
 * Settings, Client emails: every kind of email that goes to a client, and
 * the admin's hold on them. Holding one kind and then everything changes
 * what the page says; both are released at the end so the flows above are
 * unaffected on a rerun.
 */
test('an admin sees every client email and can hold them', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/client-emails');
  await expect(page.getByRole('heading', { name: 'Client emails' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Kinds of client email' });
  await expect(table.getByText('Overdue payment reminder')).toBeVisible();
  await expect(table.getByText('Reply from the Inbox')).toBeVisible();

  const quotation = table.getByRole('row').filter({ hasText: 'Someone sends a quotation with "email" ticked.' });
  await quotation.getByRole('button', { name: 'Hold' }).click();
  await expect(quotation.getByText('Held', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Hold all client emails' }).click();
  await expect(page.getByText(/Each one is logged below and none reaches a client/)).toBeVisible();
  await expect(page.getByText('Every kind is held while all client emails are held.')).toBeVisible();

  await page.getByRole('button', { name: 'Release client emails' }).click();
  await expect(page.getByRole('button', { name: 'Hold all client emails' })).toBeVisible();
  await quotation.getByRole('button', { name: 'Release' }).click();
  await expect(quotation.getByText('Goes out', { exact: true })).toBeVisible();
});
