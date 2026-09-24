import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, reportTimeZone, salesReportDocDefinition, salesReportPdf } from '../src/lib/salesReportPdf.js';
import {
  monthRows, paymentStatusRows, summariseOrders, summariseOverdue, summarisePurchaseOrders,
} from '../src/lib/revenueReport.js';
import { contractPipeline, enquirySummary, quotationStatusSummary, serviceRows } from '../src/lib/salesReviewData.js';

// Report data in the exact shapes the report modules return; the revenue,
// enquiry and service parts are built with those modules' own functions.
const group = (extra) => ({
  clients: 0, enquiries: 0, pos: 0, lost: 0, win_rate: null, won_value_inr: 0, repeat_orders: 0,
  pos_without_value: 0, unconverted: [], ...extra,
});

function revenueFrom(orders, pos, period = { from: '2026-01-01', to: '2026-12-31' }, overdue = []) {
  const poTotal = summarisePurchaseOrders(pos);
  return {
    orders: { months: monthRows(orders, period, summariseOrders), total: summariseOrders(orders) },
    invoicing: { months: monthRows(pos, period, summarisePurchaseOrders), total: poTotal },
    payment_status: { rows: paymentStatusRows(pos), total: poTotal },
    overdue_by_client: { rows: overdue, total: summariseOverdue(overdue) },
    years: [2026],
    rates: [{ currency: 'EUR', rate: 110.43 }],
  };
}

const ORDERS = [
  { quotation_no: 'CTZ/QT/2026/070', month: '2026-09', currency: 'INR', quotation_value: 100000, rate: 1, order_value_inr: 100000 },
  { quotation_no: 'CTZ/QT/2026/045', month: '2026-09', currency: 'EUR', quotation_value: 10700, rate: 110.43, order_value_inr: 1181601 },
];
const POS = [
  // 50/50 split: stage 1 invoiced ₹50,000 and ₹30,000 received.
  { po_number: 'PO-1', month: '2026-09', currency: 'INR', rate: 1, payment_status: 'Pending', po_value_inr: 100000, invoiced_inr: 50000, received_inr: 30000, received_invoiced_inr: 30000, due_now_inr: 20000, to_bill_inr: 0 },
  { po_number: 'PO-2', month: '2026-08', currency: 'INR', rate: 1, payment_status: 'Fully Paid', po_value_inr: 40000, invoiced_inr: 40000, received_inr: 40000, received_invoiced_inr: 40000, due_now_inr: 0, to_bill_inr: 0 },
];

const ENQUIRIES = [
  { enquiry_no: 'ENQ-1', client: 'Hetero', enquiry_date: '2026-08-03', month: '2026-08', status: 'Converted', quotation_status: 'Won - PO Received', quotation_value: 100000, currency: 'INR', rate: 1 },
  { enquiry_no: 'ENQ-2', client: 'Harman', enquiry_date: '2026-08-20', month: '2026-08', status: 'Converted', quotation_status: 'Lost', quotation_value: 50000, currency: 'INR', rate: 1 },
  { enquiry_no: 'ENQ-3', client: 'Orion', enquiry_date: '2026-06-01', month: '2026-06', status: 'Contacted', quotation_status: null, quotation_value: null, currency: null, rate: null },
  { enquiry_no: 'ENQ-4', client: 'Midal', enquiry_date: '2026-09-02', month: '2026-09', status: 'Unqualified', quotation_status: null, quotation_value: null, currency: null, rate: null },
];
ENQUIRIES.sort((a, b) => a.enquiry_date.localeCompare(b.enquiry_date));

// The same 5 quotations the sector fixture counts: 2 won, 1 lost, 2 open.
const QUOTE_STATUS = [
  { quotation_no: 'Q-1', month: '2026-05', status: 'Submitted', quotation_value: null, currency: 'INR', rate: 1 },
  { quotation_no: 'Q-2', month: '2026-06', status: 'Under Negotiation', quotation_value: 300000, currency: 'INR', rate: 1 },
  { quotation_no: 'Q-3', month: '2026-08', status: 'Lost', quotation_value: 50000, currency: 'INR', rate: 1 },
  { quotation_no: 'CTZ/QT/2026/045', month: '2026-09', status: 'Won - PO Received', quotation_value: 10700, currency: 'EUR', rate: 110.43 },
  { quotation_no: 'CTZ/QT/2026/070', month: '2026-09', status: 'Won - PO Received', quotation_value: 100000, currency: 'INR', rate: 1 },
];

const QUOTES = [
  { service: 'EcoVadis, ISO 37001', status: 'Won - PO Received', quotation_value: 100000, currency: 'INR', rate: 1 },
  { service: 'ASI Certification', status: 'Won - PO Received', quotation_value: 10700, currency: 'EUR', rate: 110.43 },
  { service: 'PSCI', status: 'Lost', quotation_value: 50000, currency: 'INR', rate: 1 },
  { service: 'Something new', status: 'Submitted', quotation_value: null, currency: 'INR', rate: 1 },
];

const CONTRACT_POS = [
  { po_number: 'PO-1', po_date: '2026-09-01', month: '2026-09', po_value: 100000, currency: 'INR', rate: 1, client: 'Panda Aluminium', service: 'ASI Certification', sector: 'Aluminium', country: 'India' },
  { po_number: 'PO-2', po_date: '2026-09-05', month: '2026-09', po_value: 10700, currency: 'EUR', rate: 110.43, client: 'Midal', service: 'LCA', sector: 'Aluminium', country: 'Bahrain' },
];

const GAPS = {
  quotations: 4, quotations_without_value: 1, won_without_value: 0, won_without_po: 1, quotations_without_sector: 2,
  quotations_without_sales_person: 0, enquiries: 4, enquiries_without_sector: 0, quoted_enquiries_unlinked: 0,
  undated_quotations: 0, undated_enquiries: 0,
};

function fixture(overrides = {}) {
  const period = { from: '2026-04-01', to: '2026-09-14' };
  return {
    period,
    generatedAt: new Date('2026-09-14T10:30:00Z'),
    timeZone: 'Asia/Kolkata',
    // The latest rate on record per currency, for the report's rate strip;
    // every figure below is already converted at its own date's rate.
    rates: { EUR: { rate: 110.43, effective_from: '2026-01-01' } },
    sectors: {
      rows: [
        { sector: 'Pharmaceutical', not_set: false, enquiries: 1, pos: 1, lost: 1, pipeline: 2, customers: 1, pos_without_value: 0, fx_deals: 0, amounts: [{ currency: 'INR', amount: 100000 }], unconverted: [], won_value_inr: 100000, win_rate: 0.5 },
        { sector: 'Not set', not_set: true, enquiries: 0, pos: 1, lost: 0, pipeline: 0, customers: 1, pos_without_value: 0, fx_deals: 1, amounts: [{ currency: 'EUR', amount: 10700 }], unconverted: [], won_value_inr: 1181601, win_rate: 1 },
      ],
      summary: { enquiries: 1, pos: 2, lost: 1, pipeline: 2, fx_deals: 1, win_rate: 2 / 3, sectors: 1, pos_without_sector: 1, amounts: [{ currency: 'INR', amount: 100000 }, { currency: 'EUR', amount: 10700 }], unconverted: [], won_value_inr: 1281601 },
    },
    fx: {
      rows: [{ customer: 'Midal Cables', sector: 'Not set', not_set: true, currency: 'EUR', deals: 1, deals_without_value: 0, amount: 10700, rate: 110.43, amount_inr: 1181601, po_numbers: 'PO-2' }],
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
    revenue: revenueFrom(ORDERS, POS),
    enquiries: enquirySummary(ENQUIRIES, period),
    quotationStatus: quotationStatusSummary(QUOTE_STATUS, period),
    services: serviceRows(QUOTES, [{ service: 'EcoVadis' }, { service: 'PSCI' }], CONTRACT_POS),
    contracts: contractPipeline(CONTRACT_POS),
    gaps: GAPS,
    ...overrides,
  };
}

/** Every piece of text in a pdfmake document definition, charts left out. */
function allText(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => allText(child, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (!['styles', 'layout', 'canvas', 'info', 'svg'].includes(key)) allText(value, out);
    }
  }
  return out;
}
const textOf = (doc) => allText(doc.content).join('\n');

function charts(node, out = []) {
  if (Array.isArray(node)) node.forEach((child) => charts(child, out));
  else if (node && typeof node === 'object') {
    if (typeof node.svg === 'string') out.push(node.svg);
    Object.values(node).forEach((value) => charts(value, out));
  }
  return out;
}

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

test('the review is an A4 portrait report with every section, in order', () => {
  const doc = salesReportDocDefinition(fixture());
  assert.equal(doc.pageSize, 'A4');
  assert.equal(doc.pageOrientation, 'portrait');
  const text = textOf(doc);
  const headings = ['Sales & Enquiry Performance Review', 'AT A GLANCE', 'KEY FINDINGS', 'Enquiry volume', 'Quotation status',
    'Sector-wise performance', 'Service-wise sales', 'Client analysis', 'Revenue and collections', 'What management needs to fix',
    'Appendix', 'A.  FX deals', 'D.  Notes and definitions'];
  let at = -1;
  for (const heading of headings) {
    const next = text.indexOf(heading, at + 1);
    assert.ok(next > at, `"${heading}" missing or out of order`);
    at = next;
  }
  assert.ok(!text.includes('Balance'), 'no Balance figures');
});

test('enquiry counts come from the Enquiries page', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  // 4 enquiries: 2 quotation sent, 1 in progress, 1 declined. Apr–Sep is 6 months, quiet months included.
  assert.ok(text.includes('4 enquiries were logged on the Enquiries page over 6 months, an average of 0.7 a month.'));
  assert.ok(text.includes('2 of 4 enquiries (50%) reached a quotation; 1 was unqualified and 1 is still in progress.'));
  assert.ok(text.includes('Aug 2026 — 2'), 'busiest month');
  // Oldest open enquiry: 1 Jun → 14 Sep = 105 days.
  assert.ok(text.includes('the oldest, Orion (ENQ-3), has been open 105 days'));
});

test('quotation status comes from the Quotations page statuses', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  assert.ok(text.includes('5 quotations were raised in the period: 1 submitted, 1 under negotiation, 0 on hold, 2 won and 1 lost.'));
  assert.ok(text.includes('2 won and 1 lost: a 67% win rate on decided quotations, with ₹12.8 L won.'));
  assert.ok(text.includes('2 quotations are still open, worth ₹3 L, and 1 of them has no value entered, so the real pipeline is larger.'));
  for (const figure of ['Quotation status', 'Submitted', 'Under negotiation', 'On hold', 'Won - PO received', 'Lost',
    // Won ₹1,00,000 + €10,700 × 110.43; all quotations ₹16,31,601; 2 of 5 won.
    '₹12,81,601', '₹16,31,601', '₹3,00,000', '1 with no value', '40%']) {
    assert.ok(text.includes(figure), `missing "${figure}"`);
  }
  assert.ok(!text.includes('Outcome of quoted enquiries'), 'the enquiry outcome table is gone');
});

test('contracts received: count, value and the service/sector/country split', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  assert.ok(text.includes('Contracts (purchase orders) received'));
  assert.ok(text.includes("2 purchase orders were received in the period, by the PO's own date."));
  assert.ok(text.includes('Purchase orders received'));
  // ₹1,00,000 + €10,700 × 110.43 = ₹12,81,601.
  assert.ok(text.includes('₹12,81,601'), 'total contract value in INR');
  assert.ok(text.includes('Aluminium'), 'sector split');
  assert.ok(text.includes('India'), 'country split');
  assert.ok(text.includes('Contract detail'));
  assert.ok(text.includes('PO-1'));
  assert.ok(text.includes('PO-2'));
});

test('figures carry through: sectors, services, clients and revenue', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  for (const figure of [
    // Sector won value in INR: ₹1,00,000 and €10,700 × 110.43.
    '₹1,00,000', '₹11,81,601', '₹12,81,601',
    // Services: the bundled EcoVadis + ISO quotation counts in both lines.
    'EcoVadis', 'ISO certification & management systems', 'ASI / Copper Mark / LME', 'Other services', 'Total (each quotation once)',
    '1 quotation names more than one service',
    // Clients.
    'Clients with repeat orders: ', 'Hetero (2 POs)',
    // POs: ₹1,40,000 value, ₹90,000 invoiced, ₹70,000 received, ₹20,000 due; 64% invoiced, 78% collected.
    '₹1,40,000', '₹90,000', '₹70,000', '₹20,000', '78%', '64%',
    'Overdue', 'To Invoice', 'Pending', 'Up to date', 'Fully Paid',
    '1 EUR = ₹110.43',
  ]) {
    assert.ok(text.includes(figure), `missing "${figure}"`);
  }
  assert.ok(text.includes('14 Sep 2026, 16:00 (Asia/Kolkata)'), 'generated stamp in the viewer time zone');
});

test('the analysis names the priority and the data gaps', () => {
  const text = textOf(salesReportDocDefinition(fixture()));
  assert.ok(text.includes('THE HEADLINE'));
  assert.ok(text.includes('2 of 4 enquiries reached a quotation; 67% of decided quotations were won (2 POs, ₹2 L); 64% of 01 Apr 2026 – 14 Sep 2026 PO value has been invoiced and 78% of invoices collected.'));
  assert.ok(text.includes('Enter a value on every quotation. '));
  assert.ok(text.includes('1 won quotation has no purchase order registered'));
  assert.ok(text.includes('Use consistent service names. '));
  // No value, won without a PO, no sector, and a service matching no line.
  assert.ok(text.includes('4 gaps in the source data limit this report'));

  const billing = fixture({
    revenue: revenueFrom(ORDERS, [{ po_number: 'PO-9', month: '2026-09', currency: 'INR', rate: 1, payment_status: 'To Invoice', po_value_inr: 500000, invoiced_inr: 100000, received_inr: 100000, received_invoiced_inr: 100000, due_now_inr: 0, to_bill_inr: 400000 }]),
  });
  const billingText = textOf(salesReportDocDefinition(billing));
  assert.ok(billingText.includes('Billing is the bigger gap, not collections: only 20% of PO value has been invoiced, and 1 PO has a stage due to be billed now.'));
  assert.ok(billingText.includes('The main gap is billing'));
});

test('every chart is drawn, in the report font', () => {
  const svgs = charts(salesReportDocDefinition(fixture()).content);
  assert.ok(svgs.length >= 8, `expected at least 8 charts, got ${svgs.length}`);
  for (const svg of svgs) {
    assert.ok(svg.startsWith('<svg '));
    assert.ok(!/font-family="(?!Roboto)/.test(svg), 'only Roboto');
  }
  assert.ok(svgs.some((svg) => svg.includes('Quotation sent') && svg.includes('Unqualified')), 'enquiries by month');
  assert.ok(svgs.some((svg) => svg.includes('Under negotiation') && svg.includes('On hold') && svg.includes('Won - PO received')), 'quotations by status');
  assert.ok(svgs.some((svg) => svg.includes('₹12.8 L')), 'won value by sector in lakh');
});

test('problems in the data are called out, not hidden', () => {
  const noRate = fixture({
    quotationStatus: quotationStatusSummary([
      { quotation_no: 'Q-USD', month: '2026-09', status: 'Submitted', quotation_value: 1000, currency: 'USD', rate: null },
    ], { from: '2026-04-01', to: '2026-09-14' }),
    revenue: revenueFrom(ORDERS, POS),
  });
  const missing = textOf(salesReportDocDefinition(noRate));
  assert.ok(missing.includes('No rate covers the dates of the USD amounts in this report'));
  assert.ok(missing.includes('Settings -> Exchange rates'));
  assert.ok(missing.includes('USD: not set'));
  assert.ok(missing.includes('+ $1,000 (no rate)'));

  const undated = fixture();
  undated.revenue = { ...undated.revenue, undated_pos: ['PO-9'] };
  assert.ok(textOf(salesReportDocDefinition(undated)).includes('1 purchase order has no PO date, so it is left out of the revenue figures: PO-9.'));
});

test('revenue follows the same period as the rest of the report, not a separate one', () => {
  const narrowed = { from: '2026-09-01', to: '2026-09-14' };
  const september = fixture({ period: narrowed, revenue: revenueFrom(ORDERS, POS, narrowed) });
  const text = textOf(salesReportDocDefinition(september));
  assert.ok(text.includes('Period: 01 Sep 2026 – 14 Sep 2026'));
  assert.ok(text.includes('Quotations won by month (INR), 01 Sep 2026 – 14 Sep 2026'));
  assert.ok(text.includes('Every section covers 01 Sep 2026 – 14 Sep 2026: enquiries by enquiry date, quotations by quotation date, purchase orders by PO date.'));
  assert.ok(!text.includes('PLEASE NOTE'), 'no more "revenue covers a different period" disclaimer');
});

test('an unfiltered period reads "All time" everywhere, never a second phrase for the same thing', () => {
  const all = fixture({
    period: { from: '', to: '' },
    revenue: revenueFrom(ORDERS, POS, { from: '', to: '' }),
  });
  const text = textOf(salesReportDocDefinition(all));
  assert.ok(text.includes('Period: All time'));
  assert.ok(text.includes('dated in All time'));
  assert.ok(text.includes('Every section covers All time: enquiries by enquiry date'));
  assert.ok(!text.includes('all dates'), 'no separate lowercase phrase for the same unfiltered state');
});

test('an empty period still produces a complete report', async () => {
  const empty = fixture({
    revenue: revenueFrom([], []),
    fx: { rows: [], summary: { deals: 0, amounts: [], amount_inr: 0, missing_rates: [] } },
    enquiries: enquirySummary([], {}),
    quotationStatus: quotationStatusSummary([], {}),
    services: serviceRows([], []),
    contracts: contractPipeline([]),
    gaps: { ...GAPS, quotations: 0, quotations_without_value: 0, won_without_po: 0, quotations_without_sector: 0, enquiries: 0 },
  });
  const text = textOf(salesReportDocDefinition(empty));
  assert.ok(text.includes('No enquiries were logged on the Enquiries page in this period.'));
  assert.ok(text.includes('No FX deals in this period'));
  assert.ok(text.includes('Payment status'));

  const pdf = await salesReportPdf(empty);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('renders a real multi-page PDF', async () => {
  const pdf = await salesReportPdf(fixture());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g) || [];
  assert.ok(pages.length >= 5, `expected at least 5 pages, got ${pages.length}`);
});
