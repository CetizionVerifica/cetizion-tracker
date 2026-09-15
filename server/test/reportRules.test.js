import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessToday, businessYear } from '../src/lib/businessDate.js';
import { normalizeName } from '../src/lib/names.js';
import { monthLabel, revenueMonths } from '../src/lib/revenueReport.js';
import { reportPeriod } from '../src/lib/salesReport.js';

// Pure rules behind the reports; none of these needs a database.

/** A revenue row in the shape revenueReport's query returns. */
const order = (month, extra = {}) => ({
  month, quotation_value: 100, currency: 'INR', rate: 1, order_value_inr: 100, project_id: 'PRJ-1',
  po_count: 1, po_rate_missing: false, po_missing_currencies: [],
  po_value_inr: 100, invoiced_inr: 50, received_inr: 20, due_now_inr: 30,
  ...extra,
});

test('a year 0000 date is refused before it can reach Postgres', () => {
  assert.throws(() => reportPeriod({ from: '0000-01-01' }), (err) => err.status === 422);
  assert.throws(() => reportPeriod({ to: '2026-02-30' }), (err) => err.status === 422);
  assert.deepEqual(reportPeriod({ from: '0001-01-01', to: '2026-12-31' }), { from: '0001-01-01', to: '2026-12-31' });
});

test('revenue months run from the first to the last month, zero months included', () => {
  const months = revenueMonths([order('2026-04'), order('2026-06')]);
  assert.deepEqual(months.map((m) => m.label), ['Apr 2026', 'May 2026', 'Jun 2026']);
  assert.equal(months[1].orders_won, 0);
});

test('undated orders get their own row instead of emptying the month list', () => {
  // With no date range an undated order sorts last, after the dated ones.
  const rows = [order('2026-04'), order('2026-05'), order(null), order(null, { project_id: null, po_count: 0 })];
  const months = revenueMonths(rows);
  assert.deepEqual(months.map((m) => m.label), ['Apr 2026', 'May 2026', 'No date']);
  assert.equal(months.at(-1).orders_won, 2);
  assert.equal(months.at(-1).no_project, 1);
  assert.equal(months.reduce((n, m) => n + m.orders_won, 0), rows.length, 'rows add up to every order');
  assert.equal(monthLabel(null), 'No date');

  const onlyUndated = revenueMonths([order(null)]);
  assert.deepEqual(onlyUndated.map((m) => m.label), ['No date']);
});

test('a date range lists every month in it, even with no orders', () => {
  assert.equal(revenueMonths([], { from: '2026-01-01', to: '2026-12-31' }).length, 12);
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
