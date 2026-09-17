import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATES, rateOn } from '../src/lib/salesReport.js';
import { resources } from '../src/lib/resources.js';

/**
 * The dated-rate contract. The lookup itself runs in Postgres, so what is
 * checked here is the SQL these helpers build: that rates come from the
 * exchange_rates table rather than the old single Settings value, and that
 * every report joins on the record's own date.
 */

test('rates are read from the dated table, not the old Settings values', () => {
  assert.ok(RATES.includes('FROM exchange_rates'));
  assert.ok(RATES.includes("WHERE to_currency = 'INR'"));
  assert.ok(RATES.includes('effective_from'));
  // The single fx_rate_<CUR> setting no longer feeds any figure.
  assert.ok(!RATES.includes('settings'), 'settings must not be a rate source');
  assert.ok(!RATES.includes('fx_rate'), 'fx_rate_* must not be a rate source');
  // INR is always 1, from before any record can exist.
  assert.ok(RATES.includes("SELECT 'INR'::text AS currency, 1::numeric AS rate, '0001-01-01'::date"));
});

test('the lookup takes the newest rate on or before the record own date', () => {
  const sql = rateOn('r', 'q.currency', 'q.quotation_date');
  assert.ok(sql.includes('LEFT JOIN LATERAL'), 'a missing rate must leave the row, not drop it');
  assert.ok(sql.includes('WHERE currency = q.currency'));
  assert.ok(sql.includes('AND effective_from <= COALESCE(q.quotation_date, CURRENT_DATE)'));
  assert.ok(sql.includes('ORDER BY effective_from DESC'));
  assert.ok(sql.includes('LIMIT 1'));
  assert.ok(sql.trimEnd().endsWith(') r ON true'));
});

test('each report joins on the date that belongs to its own record', async () => {
  const [sales, revenue, review] = await Promise.all([
    import('node:fs').then(({ readFileSync }) => readFileSync('src/lib/salesReport.js', 'utf8')),
    import('node:fs').then(({ readFileSync }) => readFileSync('src/lib/revenueReport.js', 'utf8')),
    import('node:fs').then(({ readFileSync }) => readFileSync('src/lib/salesReviewData.js', 'utf8')),
  ]);
  const all = sales + revenue + review;

  // Nothing may still join a rate without a date.
  assert.ok(!/JOIN rates \w+ ON/.test(all), 'every rates join must go through rateOn()');

  // A PO converts at its PO date, a quotation at its quotation date.
  assert.ok(revenue.includes("rateOn('r', 'p.currency', 'p.po_date')"));
  assert.ok(revenue.includes("rateOn('qr', 'q.currency', 'q.quotation_date')"));
  // A stage's invoice and payment each convert on their own date, so summing
  // the stages first and converting once at the PO's rate is not enough.
  assert.ok(revenue.includes("rateOn('ir', 's.currency', 'COALESCE(s.invoice_date, p.po_date)')"));
  assert.ok(revenue.includes("rateOn('pr', 's.currency', 'COALESCE(s.payment_received_date, s.invoice_date, p.po_date)')"));
  assert.ok(!/p\.total_invoiced \* r\.rate|p\.total_received \* r\.rate/.test(revenue),
    'invoiced and received must not be converted at the PO date');

  // Every converting query goes through it; the exact number grows as reports
  // are added, so what is pinned is that none of them is dateless.
  assert.ok((all.match(/rateOn\('/g) || []).length >= 12);
});

test('a rate needs a currency, a positive value and a date it takes effect', () => {
  const { schema } = resources['exchange-rates'];
  assert.deepEqual(
    schema.parse({ from_currency: 'USD', rate: '88.25', effective_from: '2026-04-01' }),
    { from_currency: 'USD', to_currency: 'INR', rate: 88.25, effective_from: '2026-04-01', source: 'manual' }
  );
  const rejects = (body) => assert.equal(schema.safeParse(body).success, false, JSON.stringify(body));
  rejects({ from_currency: 'USD', effective_from: '2026-04-01' });                 // no rate
  rejects({ from_currency: 'USD', rate: '88.25' });                                // no date
  rejects({ from_currency: 'USD', rate: '0', effective_from: '2026-04-01' });      // zero
  rejects({ from_currency: 'USD', rate: '-1', effective_from: '2026-04-01' });     // negative
  rejects({ from_currency: 'INR', rate: '1', effective_from: '2026-04-01' });      // INR is not converted
  rejects({ from_currency: 'USD', rate: '88.25', effective_from: '01-04-2026' });  // not YYYY-MM-DD
});

test('realised gain or loss is the movement between invoicing and collection', async () => {
  const { readFileSync } = await import('node:fs');
  const revenue = readFileSync('src/lib/revenueReport.js', 'utf8');
  // Received amount times the difference between the payment and invoice rates.
  assert.ok(revenue.includes('SUM(s.amount_received * (pr.rate - ir.rate))'));
  // Only stages actually paid; an unpaid invoice has not realised anything yet.
  assert.ok(revenue.includes('FILTER (WHERE s.payment_received_date IS NOT NULL)'));
  assert.ok(revenue.includes('fx_gain_loss_inr'));
});

test('due now counts only invoices that have been raised', async () => {
  const { readFileSync } = await import('node:fs');
  const flat = (text) => text.replace(/\s+/g, ' ');
  const views = flat(readFileSync('db/views.sql', 'utf8'));

  // The bug: due_now_amount started the moment the trigger fired, so a stage
  // with no invoice was reported as money someone owed.
  assert.ok(views.includes('CASE WHEN ps.invoice_no IS NOT NULL THEN GREATEST(b.amount - ps.amount_received, 0) ELSE 0 END'),
    'due_now_amount must require an invoice');
  assert.ok(views.includes('CASE WHEN b.due_to_invoice AND ps.invoice_no IS NULL THEN GREATEST(b.amount - ps.amount_received, 0) ELSE 0 END'),
    'what is not billed yet belongs to to_bill_amount');
  // Collections counted only against an invoice.
  assert.ok(views.includes('CASE WHEN ps.invoice_no IS NOT NULL THEN ps.amount_received ELSE 0 END'));

  const revenue = flat(readFileSync('src/lib/revenueReport.js', 'utf8'));
  assert.ok(revenue.includes("collection_rate: ratio(sum(pos, 'received_invoiced_inr'), invoiced)"));
  // Both sides of the ratio convert at the invoice rate, so currency movement
  // between billing and collection cannot read as money collected.
  assert.ok(revenue.includes('SUM(LEAST(s.received_on_invoiced, s.invoiced_amount) * ir.rate)'));
  assert.ok(revenue.includes('to_bill_inr'));
});

test('a PO whose own date has no rate keeps the stage figures that do', async () => {
  const { readFileSync } = await import('node:fs');
  const revenue = readFileSync('src/lib/revenueReport.js', 'utf8');
  // Only PO value depends on the PO-date rate; the rest convert per stage.
  assert.ok(revenue.includes("const poValue = sum(converted, 'po_value_inr');"));
  // What the report publishes must cover every PO, not only priced ones.
  for (const field of ['invoiced_inr', 'received_inr', 'due_now_inr', 'to_bill_inr', 'fx_gain_loss_inr']) {
    assert.ok(revenue.includes(`sum(pos, '${field}')`), `${field} must not be gated on the PO-date rate`);
  }
});

test('the invoiced share compares the same POs on both sides', async () => {
  const { readFileSync } = await import('node:fs');
  const revenue = readFileSync('src/lib/revenueReport.js', 'utf8');
  // A PO with no rate on its own date has no PO value but can still have
  // invoices dated after the rate exists. Dividing those by a PO value that
  // leaves it out reports more than 100% invoiced.
  assert.ok(revenue.includes("const invoicedOfPricedPos = sum(converted, 'invoiced_inr');"));
  assert.ok(revenue.includes('invoiced_rate: ratio(invoicedOfPricedPos, poValue)'));
  assert.ok(!revenue.includes('invoiced_rate: ratio(invoiced, poValue)'));
});
