import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_SERVICE, OTHER_SERVICE, serviceLinesFor } from '../src/lib/serviceLines.js';
import { donut, horizontalBars, niceScale, stackedColumns, wrapLabel } from '../src/lib/pdfCharts.js';
import { compactInr, plural } from '../src/lib/reportFormat.js';
import { reportTimeZone } from '../src/lib/pdfBlocks.js';

// The helpers the Reports section's PDF and service split are built on.

test('free-text services map to service lines, bundles to each line', () => {
  assert.deepEqual(serviceLinesFor('Ecovadis & Other Services'), ['EcoVadis']);
  assert.deepEqual(serviceLinesFor('EcoVadis, ISO 37001'), ['EcoVadis', 'ISO certification']);
  assert.deepEqual(serviceLinesFor('ISO9001'), ['ISO certification']);
  assert.deepEqual(serviceLinesFor('ISO14001 certification'), ['ISO certification']);
  assert.deepEqual(serviceLinesFor('isolation study'), [OTHER_SERVICE]);
  assert.deepEqual(serviceLinesFor('Copper mark Assurance'), ['ASI / Copper Mark / LME']);
  assert.deepEqual(serviceLinesFor('Reasonable Assurance for SR Report'), ['Sustainability']);
  assert.deepEqual(serviceLinesFor('GHG Verification & SR Assurance Limited Level'), ['Climate Change', 'Sustainability']);
  assert.deepEqual(serviceLinesFor('PSCI'), ['Social & supply-chain audits']);
  assert.deepEqual(serviceLinesFor('HAZOP Study'), ['HSE']);
  assert.deepEqual(serviceLinesFor('ESG project'), ['ESG']);
  // ESIA is its own line, and not a social audit for saying "social".
  assert.deepEqual(serviceLinesFor('ESIA for a greenfield plant'), ['ESIA']);
  assert.deepEqual(serviceLinesFor('Environmental and Social Impact Assessment'), ['ESIA']);
  assert.deepEqual(serviceLinesFor('Environmental & Social Impact Assessment'), ['ESIA']);
  assert.deepEqual(serviceLinesFor('Social audit'), ['Social & supply-chain audits']);
  assert.deepEqual(serviceLinesFor('Something new'), [OTHER_SERVICE]);
  assert.deepEqual(serviceLinesFor('  '), [NO_SERVICE]);
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

test('the PDF stamps its time in the viewer\'s zone, if Intl knows it', () => {
  assert.equal(reportTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(reportTimeZone('Not/AZone'), 'UTC');
  assert.equal(reportTimeZone(''), 'UTC');
});
