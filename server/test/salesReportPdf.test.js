import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, reportTimeZone, salesReportDocDefinition, salesReportPdf } from '../src/lib/salesReportPdf.js';

// Report data in the exact shapes salesReport.js and revenueReport.js return.
const month = (m, extra = {}) => ({
  month: `2026-${String(m).padStart(2, '0')}`,
  label: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} 2026`,
  orders_won: 0, order_intake_inr: 0, average_deal_inr: null, orders_without_value: 0, order_unconverted: [],
  pos: 0, po_value_inr: 0, invoiced_inr: 0, received_inr: 0, due_now_inr: 0, balance_inr: 0,
  not_registered: 0, no_project: 0, pos_unconverted: 0, po_missing_rates: [],
  ...extra,
});
const group = (extra) => ({
  clients: 0, enquiries: 0, pos: 0, lost: 0, win_rate: null, won_value_inr: 0, repeat_orders: 0,
  pos_without_value: 0, unconverted: [], ...extra,
});

function fixture(overrides = {}) {
  const sepTotals = {
    orders_won: 2, order_intake_inr: 1281601, average_deal_inr: 640800.5, pos: 1, po_value_inr: 100000,
    invoiced_inr: 50000, received_inr: 30000, due_now_inr: 20000, balance_inr: 70000, not_registered: 1, no_project: 1,
  };
  return {
    period: { from: '2026-04-01', to: '2026-09-14' },
    year: 2026,
    filters: {},
    generatedAt: new Date('2026-09-14T10:30:00Z'),
    timeZone: 'Asia/Kolkata',
    sectors: {
      rows: [
        { sector: 'Pharmaceutical', not_set: false, enquiries: 1, pos: 1, lost: 1, pipeline: 2, customers: 1, pos_without_value: 0, fx_deals: 0, amounts: [{ currency: 'INR', amount: 100000 }], win_rate: 0.5 },
        { sector: 'Not set', not_set: true, enquiries: 0, pos: 1, lost: 0, pipeline: 0, customers: 1, pos_without_value: 0, fx_deals: 1, amounts: [{ currency: 'EUR', amount: 10700 }], win_rate: 1 },
      ],
      summary: { enquiries: 1, pos: 2, lost: 1, pipeline: 2, fx_deals: 1, win_rate: 2 / 3, sectors: 1, pos_without_sector: 1, amounts: [{ currency: 'INR', amount: 100000 }, { currency: 'EUR', amount: 10700 }] },
    },
    fx: {
      rows: [{ customer: 'Midal Cables', sector: 'Not set', not_set: true, currency: 'EUR', deals: 1, deals_without_value: 0, amount: 10700, rate: 110.43, amount_inr: 1181601, quotation_nos: 'CTZ/QT/2026/045' }],
      summary: { deals: 1, amounts: [{ currency: 'EUR', amount: 10700 }], amount_inr: 1181601, missing_rates: [] },
    },
    customers: {
      rows: [
        { client: 'Hetero', enquiries: 0, pos: 2, lost: 0, pos_to_date: 2, repeat_orders: 1, pos_without_value: 0, won_value_inr: 200000, unconverted: [], client_type: 'Repeat client', win_rate: 1 },
        { client: 'Harman', enquiries: 1, pos: 0, lost: 1, pos_to_date: 0, repeat_orders: 0, pos_without_value: 0, won_value_inr: 0, unconverted: [], client_type: 'Single enquiry client', win_rate: 0 },
      ],
      summary: {
        repeat: group({ clients: 1, pos: 2, win_rate: 1, won_value_inr: 200000, repeat_orders: 1 }),
        single: group({ clients: 1, enquiries: 1, lost: 1, win_rate: 0 }),
        total: group({ clients: 2, enquiries: 1, pos: 2, lost: 1, win_rate: 2 / 3, won_value_inr: 200000, repeat_orders: 1 }),
      },
    },
    revenue: {
      months: Array.from({ length: 12 }, (_, i) => month(i + 1, i === 8 ? sepTotals : {})),
      total: month(1, { ...sepTotals, label: 'Total' }),
      rows: [
        { quotation_no: 'CTZ/QT/2026/070', quotation_date: '2026-09-12', month: '2026-09', client: 'ABC', sector: 'Pharmaceutical', sales_person: 'Ramesh', currency: 'INR', quotation_value: 100000, rate: 1, order_value_inr: 100000, project_id: 'PRJ-2026-009', po_count: 1, po_numbers: 'PO-1', payment_status: 'Pending', po_value_inr: 100000, invoiced_inr: 50000, received_inr: 30000, due_now_inr: 20000, balance_inr: 70000 },
        { quotation_no: 'CTZ/QT/2026/045', quotation_date: '2026-09-02', month: '2026-09', client: 'Midal Cables', sector: 'Not set', sales_person: null, currency: 'EUR', quotation_value: 10700, rate: 110.43, order_value_inr: 1181601, project_id: null, po_count: 0, po_numbers: null, payment_status: null, po_value_inr: null, invoiced_inr: null, received_inr: null, due_now_inr: null, balance_inr: null },
      ],
      years: [2026],
    },
    ...overrides,
  };
}

/** Every piece of text in a pdfmake document definition. */
function allText(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => allText(child, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (!['styles', 'layout', 'canvas', 'info'].includes(key)) allText(value, out);
    }
  }
  return out;
}
const textOf = (doc) => allText(doc.content).join('\n');

test('money uses Indian grouping for rupees and western grouping otherwise', () => {
  assert.equal(money(1281601), '₹12,81,601');
  assert.equal(money(10700, 'EUR'), '€10,700');
  assert.equal(money(-5000), '-₹5,000');
  assert.equal(money(null), '—');
});

test('an unknown time zone falls back to UTC', () => {
  assert.equal(reportTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(reportTimeZone('Not/AZone'), 'UTC');
  assert.equal(reportTimeZone(''), 'UTC');
});

test('the report carries every section with its figures', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  for (const heading of ['Sector-wise POs', 'FX deals', 'Client analysis', 'Repeat clients (1)', 'Single enquiry clients (1)',
    'Client summary', 'Revenue 2026', 'Order intake by month', 'Invoicing & collections by month', 'Orders won in 2026 (2)', 'Notes & definitions']) {
    assert.ok(text.includes(heading), `missing "${heading}"`);
  }
  for (const figure of ['Pharmaceutical', '€10,700', '₹11,81,601', '1 EUR = ₹110.43', 'Midal Cables', 'Hetero', 'Harman',
    '₹12,81,601', '₹6,40,801', '₹70,000', 'Sep 2026', 'Dec 2026', 'CTZ/QT/2026/070', 'No project yet', '67%']) {
    assert.ok(text.includes(figure), `missing "${figure}"`);
  }
  assert.ok(text.includes('14 Sep 2026, 16:00 (Asia/Kolkata)'), 'generated stamp in the viewer time zone');
});

test('problems in the data are called out, not hidden', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  assert.ok(text.includes('1 of 2 won POs have no sector'));
  assert.ok(text.includes('No PO registered yet for 1 of 2 won orders in 2026 (1 without a project, 0 with a project but no PO)'));

  const noRate = fixture();
  noRate.fx.rows[0] = { ...noRate.fx.rows[0], rate: null, amount_inr: null };
  noRate.fx.summary = { ...noRate.fx.summary, amount_inr: 0, missing_rates: ['EUR'] };
  const missing = textOf(salesReportDocDefinition(noRate));
  assert.ok(missing.includes('No exchange rate is set for EUR'));
  assert.ok(missing.includes('Rate not set'));
});

test('filters and an empty year still produce a complete report', async () => {
  const empty = fixture({ filters: { sector: '__none__', sales_person: 'Ramesh' } });
  empty.revenue = { months: Array.from({ length: 12 }, (_, i) => month(i + 1)), total: month(1), rows: [], years: [] };
  empty.fx = { rows: [], summary: { deals: 0, amounts: [], amount_inr: 0, missing_rates: [] } };
  const text = textOf(salesReportDocDefinition(empty));
  assert.ok(text.includes('Sector: Not set · Sales person: Ramesh'));
  assert.ok(text.includes('No FX deals in this period'));
  assert.ok(text.includes('No orders won in 2026 matching the filters'));

  const pdf = await salesReportPdf(empty);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('renders a real multi-page PDF', async () => {
  const pdf = await salesReportPdf(fixture());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g) || [];
  assert.ok(pages.length >= 4, `expected at least 4 pages, got ${pages.length}`);
});
