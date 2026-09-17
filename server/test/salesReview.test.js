import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SERVICE, OTHER_SERVICE, serviceLinesFor } from '../src/lib/serviceLines.js';
import { enquirySummary, quotationStatusSummary, serviceRows, summariseEnquiries } from '../src/lib/salesReviewData.js';
import { donut, horizontalBars, niceScale, stackedColumns, wrapLabel } from '../src/lib/pdfCharts.js';
import { clientAnalysis, inrValue, quotationStatusAnalysis, sectorAnalysis } from '../src/lib/salesReviewAnalysis.js';

test('quotation statuses: counts, win rate and the value still open', () => {
  const q = (status, value, extra = {}) => ({ status, month: '2026-09', quotation_value: value, currency: 'INR', rate: 1, ...extra });
  const report = quotationStatusSummary(
    [q('Submitted', 100), q('Under Negotiation', null), q('On Hold', 50), q('Won - PO Received', 1000), q('Won - PO Received', 10, { currency: 'USD', rate: null }), q('Lost', 300)],
    { from: '2026-09-01', to: '2026-09-30' }
  );
  const t = report.total;
  assert.deepEqual(
    [t.quotations, t.submitted, t.negotiating, t.on_hold, t.won, t.lost, t.open, t.open_value_inr, t.open_without_value, t.value_inr],
    [6, 1, 1, 1, 2, 1, 3, 150, 1, 1450]
  );
  assert.equal(t.win_rate, 2 / 3);
  assert.deepEqual(report.rows.map((row) => [row.status, row.quotations, row.value_inr]), [
    ['Submitted', 1, 100], ['Under Negotiation', 1, 0], ['On Hold', 1, 50], ['Won - PO Received', 2, 1000], ['Lost', 1, 300],
  ]);
  assert.deepEqual(report.rows[3].unconverted, [{ currency: 'USD', amount: 10 }]);
  assert.deepEqual(report.months.map((m) => [m.label, m.quotations, m.won]), [['Sep 2026', 6, 2]]);

  const a = quotationStatusAnalysis(report);
  assert.equal(a.lead, '6 quotations were raised in the period: 1 submitted, 1 under negotiation, 1 on hold, 2 won and 1 lost.');
  assert.ok(a.insights.some((i) => i.text === '2 won and 1 lost: a 67% win rate on decided quotations, with ₹1,000 won.'));
  assert.ok(a.insights.some((i) => i.text === '3 quotations are still open, worth ₹150, and 1 of them has no value entered, so the real pipeline is larger.'));
  assert.ok(a.insights.some((i) => i.text.startsWith('1 quotation is on hold.')));
});
import { compactInr, plural } from '../src/lib/reportFormat.js';

test('free-text services map to service lines, bundles to each line', () => {
  assert.deepEqual(serviceLinesFor('Ecovadis & Other Services'), ['EcoVadis']);
  assert.deepEqual(serviceLinesFor('EcoVadis, ISO 37001'), ['EcoVadis', 'ISO certification & management systems']);
  assert.deepEqual(serviceLinesFor('Copper mark Assurance'), ['ASI / Copper Mark / LME']);
  assert.deepEqual(serviceLinesFor('Reasonable Assurance for SR Report'), ['Sustainability reporting & assurance']);
  assert.deepEqual(serviceLinesFor('GHG Verification & SR Assurance Limited Level'), ['Sustainability reporting & assurance', 'Climate & environment (GHG / LCA / CBAM)']);
  assert.deepEqual(serviceLinesFor('PSCI'), ['Social & supply-chain audits']);
  assert.deepEqual(serviceLinesFor('HAZOP Study'), ['HSE / process safety']);
  assert.deepEqual(serviceLinesFor('ESG project'), ['ESG strategy & advisory']);
  assert.deepEqual(serviceLinesFor('Something new'), [OTHER_SERVICE]);
  assert.deepEqual(serviceLinesFor('  '), [NO_SERVICE]);
});

test('service totals count each quotation once', () => {
  const report = serviceRows(
    [
      { service: 'EcoVadis, ISO 37001', status: 'Won - PO Received', quotation_value: 1000, currency: 'INR', rate: 1 },
      { service: 'ISO 27001', status: 'Lost', quotation_value: 500, currency: 'INR', rate: 1 },
      { service: 'LME Certification', status: 'Won - PO Received', quotation_value: 100, currency: 'USD', rate: null },
    ],
    [{ service: 'ISO 9001' }]
  );
  const iso = report.rows.find((row) => row.service.startsWith('ISO'));
  assert.deepEqual([iso.enquiries, iso.quotations, iso.won, iso.lost, iso.win_rate, iso.won_value_inr], [1, 2, 1, 1, 0.5, 1000]);
  assert.deepEqual([report.summary.quotations, report.summary.won, report.summary.won_value_inr, report.summary.bundled], [3, 2, 1000, 1]);
  assert.deepEqual(report.summary.won_unconverted, [{ currency: 'USD', amount: 100 }]);
});

// The outcome of the quotations these enquiries led to belongs to the
// quotation section, so the enquiry figures are only about status here.
test('enquiries split by status', () => {
  const rows = [
    { status: 'Won - Quotation Sent' },
    { status: 'Won - Quotation Sent' },
    { status: 'Won - Quotation Sent' },
    { status: 'Declined' },
    { status: 'In Progress' },
  ];
  const s = summariseEnquiries(rows);
  assert.deepEqual(
    [s.enquiries, s.quoted, s.declined, s.in_progress, s.quote_rate],
    [5, 3, 1, 1, 0.6]
  );
  assert.equal(enquirySummary([], {}).busiest, null);
});

test('chart scales are round and empty charts draw nothing', () => {
  assert.deepEqual(niceScale(23, 4, true), { max: 30, step: 10 });
  assert.deepEqual(niceScale(7, 4, true), { max: 8, step: 2 });
  assert.deepEqual(niceScale(146.9, 4), { max: 150, step: 50 });
  assert.deepEqual(niceScale(0, 4, true), { max: 4, step: 1 });
  assert.equal(stackedColumns({ categories: ['Jan'], series: [{ name: 'x', color: '#000', values: [0] }], width: 300 }), null);
  assert.equal(donut({ slices: [{ label: 'a', value: 0, color: '#000' }] }), null);
  assert.equal(horizontalBars({ items: [], width: 300 }), null);
  assert.deepEqual(wrapLabel('Pharmaceutical & Life Sciences', 60, 8), ['Pharmaceutical', '& Life Sciences']);
  const svg = horizontalBars({ items: [{ label: 'R&D <labs>', value: 5 }], width: 300 }).svg;
  assert.ok(svg.includes('R&amp;D &lt;labs&gt;'), 'text is escaped');
});

test('compact rupees read in lakh and crore', () => {
  assert.equal(compactInr(24140000), '₹2.41 Cr');
  assert.equal(compactInr(7530000), '₹75.3 L');
  assert.equal(compactInr(200000), '₹2 L');
  assert.equal(compactInr(75000), '₹75,000');
  assert.equal(plural(1, 'enquiry', 'enquiries'), '1 enquiry');
});

test('concentration is flagged only when it is real', () => {
  const rates = { INR: 1, EUR: 100 };
  assert.deepEqual(inrValue([{ currency: 'INR', amount: 10 }, { currency: 'EUR', amount: 2 }, { currency: 'USD', amount: 3 }], rates), {
    won_value_inr: 210,
    unconverted: [{ currency: 'USD', amount: 3 }],
  });

  const sector = (name, pos, lost, value) => ({ sector: name, not_set: false, pos, lost, pipeline: 0, win_rate: pos / (pos + lost), won_value_inr: value });
  const rows = [sector('Pharma', 6, 1, 800), sector('Metals', 3, 3, 200)];
  const a = sectorAnalysis({ summary: { pos: 9, pos_without_sector: 0 } }, rows);
  assert.equal(a.insights[0].tag, 'RISK');
  assert.ok(a.insights[0].text.startsWith('Pharma is the largest sector: ₹800 from 6 POs, 80% of won value.'));
  assert.ok(a.insights.some((i) => i.tag === 'OPPORTUNITY' && i.text.includes('Pharma converts best, winning 86%')));

  const client = (name, value) => ({ client: name, won_value_inr: value, lost: 0, pos: 1 });
  const spread = clientAnalysis({
    rows: [client('A', 100), client('B', 100), client('C', 100), client('D', 100), client('E', 100), client('F', 100)],
    summary: { total: { clients: 6, won_value_inr: 600, pos: 6 }, repeat: { clients: 0, won_value_inr: 0 }, single: { clients: 6 } },
  });
  assert.equal(spread.insights[0].tag, 'HEADLINE');
  assert.ok(spread.insights[0].text.includes('33%'));
});
