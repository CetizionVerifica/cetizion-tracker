import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessToday, businessYear } from '../src/lib/businessDate.ts';
import { normalizeName } from '../src/lib/names.ts';
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

// ---------------------------------------------------------------------
// The Reports section's definitions (lib/reportDefinitions.js)
// ---------------------------------------------------------------------

const defs = await import('../src/lib/reportDefinitions.js');

test('the default grain follows the period length', () => {
  assert.equal(defs.defaultGrain({ from: '2026-10-01', to: '2026-10-31' }), 'day');
  assert.equal(defs.defaultGrain({ from: '2026-10-01', to: '2026-11-01' }), 'week');
  assert.equal(defs.defaultGrain({ from: '2026-04-01', to: '2026-09-30' }), 'week');
  assert.equal(defs.defaultGrain({ from: '2026-04-01', to: '2027-03-31' }), 'month');
  assert.equal(defs.defaultGrain({}), 'month');
  assert.equal(defs.reportGrain({ grain: 'week' }, { from: '2026-10-01', to: '2026-10-02' }), 'week');
  assert.equal(defs.reportGrain({ grain: 'fortnight' }, { from: '2026-10-01', to: '2026-10-02' }), 'day');
});

test('weeks start on Monday, across a year end too', () => {
  assert.equal(defs.weekStart('2026-10-06'), '2026-10-05'); // a Tuesday
  assert.equal(defs.weekStart('2026-10-05'), '2026-10-05'); // the Monday itself
  assert.equal(defs.weekStart('2026-10-11'), '2026-10-05'); // the Sunday
  assert.equal(defs.weekStart('2027-01-01'), '2026-12-28'); // a Friday in the next year
  assert.equal(defs.bucketLabel('2026-10-05', 'week'), 'w/c 5 Oct');
  assert.equal(defs.bucketLabel('2026-10-06', 'day'), '6 Oct');
  assert.equal(defs.bucketLabel('2026-10', 'month'), 'Oct 2026');
});

test('periodRows fills empty buckets and keeps undated rows apart', () => {
  const count = (list) => ({ n: list.length });
  const rows = [{ date: '2026-10-01' }, { date: '2026-10-03' }, { date: null }];
  const days = defs.periodRows(rows, { from: '2026-10-01', to: '2026-10-04' }, 'day', count);
  assert.deepEqual(days.map((d) => [d.key, d.n]), [['2026-10-01', 1], ['2026-10-02', 0], ['2026-10-03', 1], ['2026-10-04', 0], [null, 1]]);

  // A period starting midweek still opens with that week's Monday bucket.
  const weeks = defs.periodRows(rows, { from: '2026-10-01', to: '2026-10-14' }, 'week', count);
  assert.deepEqual(weeks.map((w) => w.key), ['2026-09-28', '2026-10-05', '2026-10-12', null]);
  assert.equal(weeks[0].n, 2);

  const yearEnd = defs.periodRows([], { from: '2026-12-25', to: '2027-01-06' }, 'week', count);
  assert.deepEqual(yearEnd.map((w) => w.key), ['2026-12-21', '2026-12-28', '2027-01-04']);
});

test('too many buckets falls back to a coarser grain', () => {
  assert.equal(defs.fitGrain('2026-04-01', '2027-03-31', 'day'), 'day'); // a FY by day still fits
  assert.equal(defs.fitGrain('2020-01-01', '2026-12-31', 'day'), 'week');
  assert.equal(defs.fitGrain('2000-01-01', '2026-12-31', 'day'), 'month');
});

test('percentages add up to 100 after rounding', () => {
  assert.deepEqual(defs.percentages([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(defs.percentages([31, 80, 20, 11]).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(defs.percentages([0, 0]), [null, null]);
  for (const counts of [[7, 3, 2, 1], [1, 2, 3, 4, 5, 6], [99, 1, 1]]) {
    assert.equal(defs.percentages(counts).reduce((a, b) => a + b, 0), 100);
  }
});

test('enquiry outcome: first match wins, and only an unquoted enquiry is ever lost', () => {
  const outcome = (row) => defs.enquiryOutcome({ status: 'New', quotation_no: null, ...row });
  // Unqualified, but a PO came in on its quotation anyway: converted, and flagged.
  assert.deepEqual(outcome({ status: 'Unqualified', quotation_no: 'Q-1', has_po: true }),
    { outcome: 'converted', stage: null, notes: ['unqualified_with_quotation'] });
  // Closed with no quotation: lost.
  assert.equal(outcome({ status: 'Unqualified' }).outcome, 'lost');
  // Open with no quotation: pipeline, not yet quoted.
  assert.deepEqual(outcome({ status: 'Contacted' }), { outcome: 'pipeline', stage: 'not_quoted', notes: [] });
  // A lost or expired quotation is quoted–not–won, never lost — even when the enquiry says Unqualified.
  assert.equal(outcome({ status: 'Converted', quotation_no: 'Q-1', quotation_lost: true }).outcome, 'quoted_not_won');
  assert.equal(outcome({ status: 'Converted', quotation_no: 'Q-1', quotation_expired: true }).outcome, 'quoted_not_won');
  assert.equal(outcome({ status: 'Unqualified', quotation_no: 'Q-1', quotation_lost: true }).outcome, 'quoted_not_won');
  // An open quotation: pipeline, quoted.
  assert.deepEqual(outcome({ status: 'Converted', quotation_no: 'Q-1', quotation_status: 'Submitted' }),
    { outcome: 'pipeline', stage: 'quoted', notes: [] });
  // Marked won with no PO yet: still pipeline, and flagged.
  assert.deepEqual(outcome({ status: 'Converted', quotation_no: 'Q-1', quotation_status: 'Won - PO Received' }).notes, ['won_without_po']);
  // Converted with nothing linked: not quoted, flagged.
  assert.deepEqual(outcome({ status: 'Converted' }).notes, ['converted_without_quotation']);
});

test('the outcome summary: four slices that add up, pipeline split, reasons', () => {
  const rows = [
    { enquiry_no: 'E1', date: '2026-09-02', status: 'Converted', quotation_no: 'Q1', has_po: true },
    { enquiry_no: 'E2', date: '2026-09-03', status: 'Unqualified', quotation_no: null },
    { enquiry_no: 'E3', date: '2026-10-01', status: 'New', quotation_no: null },
    { enquiry_no: 'E4', date: '2026-10-02', status: 'Converted', quotation_no: 'Q4', quotation_status: 'Lost', quotation_lost: true, lost_reason: 'Price' },
    { enquiry_no: 'E5', date: '2026-10-02', status: 'Converted', quotation_no: 'Q5', quotation_status: 'Submitted', quotation_expired: true },
    { enquiry_no: 'E6', date: '2026-10-03', status: 'Converted', quotation_no: 'Q6', quotation_status: 'Submitted' },
  ];
  const summary = defs.outcomeSummary(rows, { from: '2026-09-01', to: '2026-10-31' });
  assert.deepEqual(summary.slices.map((s) => [s.key, s.count]), [['converted', 1], ['pipeline', 2], ['quoted_not_won', 2], ['lost', 1]]);
  assert.equal(summary.slices.reduce((n, s) => n + s.pct, 0), 100);
  assert.deepEqual(summary.pipeline, { not_quoted: 1, quoted: 1 });
  assert.deepEqual(summary.quoted_not_won_reasons, [{ reason: 'Expired without a decision', count: 1 }, { reason: 'Price', count: 1 }]);
  assert.deepEqual(summary.months.map((m) => [m.key, m.enquiries, m.converted.count]), [['2026-09', 2, 1], ['2026-10', 4, 0]]);
});

test('enquiries received split by source, most first, "Not set" last', () => {
  const rows = [
    { date: '2026-10-01', source: 'Website' }, { date: '2026-10-01', source: null },
    { date: '2026-10-02', source: 'Referral' }, { date: '2026-10-02', source: 'Referral', dated_by_creation: true },
  ];
  const report = defs.enquiriesReceived(rows, { from: '2026-10-01', to: '2026-10-03' }, 'day');
  assert.deepEqual(report.sources.map((s) => s.name), ['Referral', 'Website', 'Not set']);
  assert.deepEqual(report.buckets.map((b) => b.enquiries), [2, 2, 0]);
  assert.deepEqual(report.buckets[1].by_source, { Referral: 2, Website: 0, 'Not set': 0 });
  assert.equal(report.dated_by_creation, 1);
  assert.equal(report.busiest.key, '2026-10-01');
});

test('monthly revenue: PO value by PO date, billing by its own dates, unconverted named', () => {
  const pos = [
    { po_number: 'A', date: '2026-09-10', currency: 'INR', po_value: 1000, rate: 1, po_value_inr: 1000 },
    { po_number: 'B', date: '2026-10-05', currency: 'USD', po_value: 10, rate: null, po_value_inr: null },
    { po_number: 'C', date: '2026-10-06', currency: 'INR', po_value: null, rate: 1, po_value_inr: null },
  ];
  const billing = [
    { kind: 'invoiced', date: '2026-10-01', amount_inr: 500 },
    { kind: 'received', date: '2026-10-20', amount_inr: 200 },
    { kind: 'received', date: '2026-10-21', amount_inr: null },
  ];
  const revenue = defs.monthlyRevenue(pos, billing, { from: '2026-09-01', to: '2026-10-31' });
  assert.deepEqual(revenue.months.map((m) => [m.key, m.pos, m.po_value_inr, m.invoiced_inr, m.received_inr]),
    [['2026-09', 1, 1000, 0, 0], ['2026-10', 2, 0, 500, 200]]);
  assert.deepEqual(revenue.total.unconverted, [{ currency: 'USD', amount: 10 }]);
  assert.equal(revenue.total.without_value, 1);
  assert.equal(revenue.total.billing_unconverted, 1);
  assert.deepEqual(revenue.months[1].detail.map((d) => d.po_number), ['B', 'C']);
});

test('an admin can narrow a report to one owner; a sales user cannot widen theirs', () => {
  const admin = { unrestricted: true, ownerId: null };
  const sales = { unrestricted: false, ownerId: 7 };
  assert.deepEqual(defs.reportScope(admin, { owner: '3' }), { unrestricted: false, ownerId: 3 });
  assert.equal(defs.reportScope(admin, { owner: 'x' }), admin);
  assert.equal(defs.reportScope(admin, {}), admin);
  assert.equal(defs.reportScope(sales, { owner: '3' }), sales);
});

test('a sector maps to its category by name or alias, ignoring case and spacing', () => {
  const map = defs.sectorMapper(['Metal Industry', 'Agriculture', 'Pharmaceutical'], [
    { alias: 'Steel', sector: 'Metal Industry' },
    { alias: 'pharma', sector: 'pharmaceutical' },
    // Points at a sector the list no longer names: Other, not a category of its own.
    { alias: 'Textiles', sector: 'Textile Industry' },
  ]);
  assert.equal(map('  metal   industry '), 'Metal Industry');
  assert.equal(map('STEEL'), 'Metal Industry');
  assert.equal(map('Pharma '), 'Pharmaceutical');
  assert.equal(map('Textiles'), 'Other');
  assert.equal(map('Retail'), 'Other');
  assert.equal(map('  '), 'Not set');
  assert.equal(map(null), 'Not set');
});

test('the sector section lists every category, then Other with its spellings, and adds up', () => {
  const map = defs.sectorMapper(['Metal Industry', 'Agriculture'], [{ alias: 'steel', sector: 'Metal Industry' }]);
  const section = defs.sectorSection([
    { sector: 'Steel', po_value_inr: 100 }, { sector: 'Metal Industry', po_value_inr: 50 },
    { sector: 'Retail', po_value_inr: 10 }, { sector: 'retail ', po_value_inr: 5 }, { sector: null, po_value_inr: 1 },
  ], ['Metal Industry', 'Agriculture'], map);
  assert.deepEqual(section.rows.map((r) => [r.sector, r.pos, r.value_inr]),
    [['Metal Industry', 2, 150], ['Agriculture', 0, 0], ['Other', 2, 15], ['Not set', 1, 1]]);
  assert.deepEqual(section.rows[2].raw, [{ name: 'Retail', pos: 2, value_inr: 15 }]);
  assert.equal(section.total.value_inr, section.rows.reduce((n, r) => n + r.value_inr, 0));
  assert.equal(section.not_set, 1);
});

test('category lists: a JSON list of distinct names, never Other', () => {
  assert.deepEqual(defs.parseCategoryList('[" Metal  Industry ", "Agriculture"]'), ['Metal Industry', 'Agriculture']);
  for (const bad of ['Metal, Agri', '[]', '["A", "a"]', '["Other"]', '[1]', '{"a":1}']) {
    assert.throws(() => defs.parseCategoryList(bad), (err) => err.status === 422, bad);
  }
  assert.deepEqual(defs.readCategoryList('not json', ['X']), ['X']);
});

test('a service maps to its catalogue line when assigned, else by keyword; unknown lines are Other', () => {
  const linesOf = defs.serviceMapper(['EcoVadis', 'ESIA', 'HSE', 'ESG'], [
    { name: 'Plant safety review', report_line: 'HSE' },
    { name: 'Retired thing', report_line: 'Something removed' },
  ]);
  assert.deepEqual(linesOf('plant safety  review'), ['HSE']);
  assert.deepEqual(linesOf('Retired thing'), ['Other']);
  assert.deepEqual(linesOf('EcoVadis and ESIA'), ['EcoVadis', 'ESIA']);
  // ISO is a keyword line, but not one this list names.
  assert.deepEqual(linesOf('ISO 9001'), ['Other']);
  assert.deepEqual(linesOf('EcoVadis, ISO 9001'), ['EcoVadis']);
  assert.deepEqual(linesOf(''), ['Other']);
});

test('a PO splits by po_services first, then quotation lines, then keywords — equally across a bundle', () => {
  const linesOf = defs.serviceMapper(['EcoVadis', 'ESIA', 'HSE'], []);
  const byLine = (split) => Object.fromEntries(split.shares.map((s) => [s.line, s.value_inr]));

  const fromPo = defs.serviceSplit({
    po_value_inr: 1000,
    services: [{ service: 'EcoVadis', value: 750 }, { service: 'HAZOP', value: 250 }],
    lines: [{ text: 'ESIA', value: 1 }], service: 'ESIA',
  }, linesOf);
  assert.equal(fromPo.source, 'po_services');
  assert.deepEqual(byLine(fromPo), { EcoVadis: 750, HSE: 250 });

  const fromLines = defs.serviceSplit({ po_value_inr: 900, services: [], lines: [{ text: 'ESIA', value: 200 }, { text: 'EcoVadis', value: 100 }] }, linesOf);
  assert.equal(fromLines.source, 'quotation_lines');
  assert.deepEqual(byLine(fromLines), { ESIA: 600, EcoVadis: 300 });

  const fromText = defs.serviceSplit({ po_value_inr: 1000, services: [], lines: [], service: 'EcoVadis + ESIA' }, linesOf);
  assert.equal(fromText.source, 'keywords');
  assert.deepEqual(byLine(fromText), { EcoVadis: 500, ESIA: 500 });

  // No value on a PO: still allocated, with no rupees.
  assert.deepEqual(byLine(defs.serviceSplit({ po_value_inr: null, service: 'HSE audit' }, linesOf)), { HSE: null });
});

test('the service section counts a bundle in each line but splits its value, so values add up', () => {
  const linesOf = defs.serviceMapper(['EcoVadis', 'ESIA', 'HSE'], []);
  const section = defs.serviceSection([
    { po_value_inr: 1000, service: 'EcoVadis + ESIA' },
    { po_value_inr: 300, service: 'ESIA' },
    { po_value_inr: 50, service: 'Something new' },
  ], ['EcoVadis', 'ESIA', 'HSE'], linesOf);
  assert.deepEqual(section.rows.map((r) => [r.line, r.pos, r.value_inr]),
    [['ESIA', 2, 800], ['EcoVadis', 1, 500], ['HSE', 0, 0], ['Other', 1, 50]]);
  assert.equal(section.rows.reduce((n, r) => n + r.value_inr, 0), section.total.value_inr);
  assert.deepEqual(section.sources, { po_services: 0, quotation_lines: 0, keywords: 3 });
  assert.equal(section.bundled, 1);
});

test('customers: new by first-ever PO, repeat by any later one, enquiries judged on their own date', () => {
  const index = defs.orderIndex([
    { po_number: 'B2', date: '2026-09-20', customer_key: 'c:2' },
    { po_number: 'B0', date: '2025-01-01', customer_key: 'c:2' },
    { po_number: 'A1', date: '2026-09-05', customer_key: 'c:1' },
    { po_number: 'A2', date: '2026-09-25', customer_key: 'c:1' },
  ]);
  const pos = [
    { po_number: 'A1', date: '2026-09-05', customer_key: 'c:1', customer: 'Acme', po_value_inr: 100 },
    { po_number: 'A2', date: '2026-09-25', customer_key: 'c:1', customer: 'Acme', po_value_inr: 50 },
    { po_number: 'B2', date: '2026-09-20', customer_key: 'c:2', customer: 'Beta', po_value_inr: 50, keyed_by_name: true },
  ];
  const enquiries = [
    { enquiry_no: 'E1', date: '2026-09-01', customer_key: 'c:1', status: 'New' }, // before Acme's first PO: new
    { enquiry_no: 'E2', date: '2026-09-10', customer_key: 'c:1', status: 'New' }, // after it: existing
    { enquiry_no: 'E3', date: '2026-09-02', customer_key: 'c:2', status: 'New' }, // Beta ordered in 2025
    { enquiry_no: 'E4', date: '2026-09-03', customer_key: 'n:zeta', status: 'Unqualified' }, // never ordered
  ];
  const section = defs.customerSection(pos, index, enquiries, { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(section.tiles, {
    customers: 2, new_customers: 1, existing_customers: 1, first_orders: 1, repeat_orders: 2,
    first_order_value_inr: 100, repeat_value_inr: 100, repeat_share_pct: 50,
    enquiries_from_new: 2, enquiries_from_existing: 2,
  });
  assert.deepEqual(section.new_customers.map((c) => [c.customer, c.first_po_date, c.pos, c.value_inr]), [['Acme', '2026-09-05', 2, 150]]);
  assert.deepEqual(section.repeat_orders.map((r) => [r.po_number, r.previous_orders]), [['A2', 1], ['B2', 1]]);
  assert.deepEqual(section.new_customer_enquiries.map((e) => [e.enquiry_no, e.outcome]), [['E1', 'pipeline'], ['E4', 'lost']]);
  assert.equal(section.keyed_by_name, 1);
});
