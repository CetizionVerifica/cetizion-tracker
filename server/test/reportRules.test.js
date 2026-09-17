import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessToday, businessYear } from '../src/lib/businessDate.js';
import { normalizeName } from '../src/lib/names.js';
import {
  PAYMENT_STATUSES, monthLabel, monthRows, paymentStatusRows, summariseOrders, summarisePurchaseOrders,
} from '../src/lib/revenueReport.js';
import { reportPeriod } from '../src/lib/salesReport.js';

// Pure rules behind the reports; none of these needs a database.

/** A purchase order row in the shape revenueReport's query returns. */
const po = (month, extra = {}) => ({
  month, currency: 'INR', rate: 1, payment_status: 'Pending',
  po_value_inr: 1000, invoiced_inr: 500, received_inr: 200, due_now_inr: 300,
  // Everything received here is against an invoice, and nothing is left to bill.
  received_invoiced_inr: 200, to_bill_inr: 0,
  ...extra,
});
/** A won quotation row. */
const order = (month, extra = {}) => ({ month, currency: 'INR', rate: 1, quotation_value: 100, order_value_inr: 100, ...extra });

test('a year 0000 date is refused before it can reach Postgres', () => {
  assert.throws(() => reportPeriod({ from: '0000-01-01' }), (err) => err.status === 422);
  assert.throws(() => reportPeriod({ to: '2026-02-30' }), (err) => err.status === 422);
  assert.deepEqual(reportPeriod({ from: '0001-01-01', to: '2026-12-31' }), { from: '0001-01-01', to: '2026-12-31' });
});

test('months run from the first to the last, zero months included', () => {
  const months = monthRows([po('2026-04'), po('2026-06')], {}, summarisePurchaseOrders);
  assert.deepEqual(months.map((m) => m.label), ['Apr 2026', 'May 2026', 'Jun 2026']);
  assert.equal(months[1].pos, 0);
});

test('a date range lists every month in it, even with no rows', () => {
  assert.equal(monthRows([], { from: '2026-01-01', to: '2026-12-31' }, summariseOrders).length, 12);
  assert.deepEqual(monthRows([], { from: '2026-09-01', to: '2026-09-30' }, summariseOrders).map((m) => m.label), ['Sep 2026']);
});

test('undated rows get their own row instead of emptying the month list', () => {
  const rows = [po('2026-04'), po('2026-05'), po(null), po(null)];
  const months = monthRows(rows, {}, summarisePurchaseOrders);
  assert.deepEqual(months.map((m) => m.label), ['Apr 2026', 'May 2026', 'No date']);
  assert.equal(months.reduce((n, m) => n + m.pos, 0), rows.length, 'rows add up to every PO');
  assert.equal(monthLabel(null), 'No date');
});

test('collection rate is received ÷ invoiced, and invoiced % is invoiced ÷ PO value', () => {
  const s = summarisePurchaseOrders([po('2026-09'), po('2026-09', { po_value_inr: 3000, invoiced_inr: 1500, received_inr: 1500, received_invoiced_inr: 1500, due_now_inr: 0 })]);
  assert.equal(s.po_value_inr, 4000);
  assert.equal(s.invoiced_inr, 2000);
  assert.equal(s.received_inr, 1700);
  assert.equal(s.due_now_inr, 300);
  assert.equal(s.collection_rate, 0.85);
  assert.equal(s.invoiced_rate, 0.5);
});

test('with nothing invoiced there is no collection rate, not 0%', () => {
  const s = summarisePurchaseOrders([po('2026-09', { invoiced_inr: 0, received_inr: 0, due_now_inr: 0 })]);
  assert.equal(s.collection_rate, null);
  assert.equal(s.invoiced_rate, 0);
  assert.equal(summarisePurchaseOrders([]).invoiced_rate, null);
});

test('an FX PO without a rate is left out of the INR figures and flagged', () => {
  const s = summarisePurchaseOrders([po('2026-09'), po('2026-09', { currency: 'EUR', rate: null, po_value_inr: null, invoiced_inr: null, received_inr: null, due_now_inr: null })]);
  assert.equal(s.pos, 2);
  assert.equal(s.po_value_inr, 1000);
  assert.equal(s.pos_unconverted, 1);
  assert.deepEqual(s.missing_rates, ['EUR']);
});

test('payment status lists every status and adds up to the total', () => {
  const pos = [po('2026-09', { payment_status: 'Overdue' }), po('2026-09', { payment_status: 'Fully Paid' }), po('2026-09', { payment_status: 'Fully Paid' })];
  const rows = paymentStatusRows(pos);
  assert.deepEqual(rows.map((r) => r.status), PAYMENT_STATUSES);
  // Overdue, To Invoice, No stages, Pending, Up to date, Fully Paid.
  assert.deepEqual(rows.map((r) => r.pos), [1, 0, 0, 0, 0, 2]);
  assert.equal(rows.reduce((n, r) => n + r.po_value_inr, 0), summarisePurchaseOrders(pos).po_value_inr);

  const withUnknown = paymentStatusRows([...pos, po('2026-09', { payment_status: 'Something new' })]);
  assert.equal(withUnknown.at(-1).status, 'Other', 'an unknown status is still counted');
});

test('order intake averages over the orders that have a value', () => {
  const s = summariseOrders([order('2026-09'), order('2026-09', { quotation_value: 300, order_value_inr: 300 }), order('2026-09', { quotation_value: null, order_value_inr: null })]);
  assert.equal(s.orders_won, 3);
  assert.equal(s.order_intake_inr, 400);
  assert.equal(s.average_deal_inr, 200);
  assert.equal(s.orders_without_value, 1);
});

test('the business year turns at midnight in the business time zone, not UTC', () => {
  const newYearIst = new Date('2026-12-31T19:00:00Z'); // 00:30 on 1 Jan 2027 in India
  assert.equal(businessToday(newYearIst, 'Asia/Kolkata'), '2027-01-01');
  assert.equal(businessToday(newYearIst, 'UTC'), '2026-12-31');
  assert.equal(businessYear(newYearIst, 'Asia/Kolkata'), 2027);
});

test('names compare the way the reports group them', () => {
  assert.equal(normalizeName('  Pharmaceutical  '), normalizeName('pharmaceutical'));
  assert.equal(normalizeName('Hindalco   -  Kuppam'), 'hindalco - kuppam');
  assert.notEqual(normalizeName('Hindalco'), normalizeName('Hindalco - Kuppam'));
});
