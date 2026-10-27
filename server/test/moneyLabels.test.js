import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * "Received" means two different sums in this app, so every label says which:
 *   - cash only: payments.amount (the MIS briefing and weekly MIS billing);
 *   - incl. TDS: payment_stages.amount_received = SUM(amount + tds_amount)
 *     (the sales report's revenue section, POs, the dashboard).
 * And text that explains a figure names only columns that exist.
 */
const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('the weekly MIS labels its cash-only received as cash', () => {
  assert.match(src('lib/emailTemplates.js'), /'Invoiced \/ cash received this week'/);
  assert.match(src('lib/misPdf.js'), /header: 'Cash received \(₹\)'/);
  assert.doesNotMatch(src('lib/misPdf.js'), /header: 'Received \(₹\)'/);
});

test("the sales report's received, which includes TDS, says so", () => {
  const pdf = src('lib/reportPdf.js');
  assert.doesNotMatch(pdf, /header: 'Received', value: \(r\) => inr\(r\.received_inr\)/);
  assert.equal(pdf.match(/header: 'Received \(incl\. TDS\)'/g)?.length, 2);
});

test('the statement explains its own columns, which have no Received', () => {
  const portal = src('lib/portal.js');
  assert.doesNotMatch(portal, /received is paid plus TDS/);
  assert.match(portal, /outstanding is the total less what was paid and the TDS deducted/);
});

test('the revenue basis says GST only where the PO carries it', () => {
  assert.match(src('lib/reportPdf.js'), /including GST where the PO carries it \(export POs are zero-rated\)/);
});
