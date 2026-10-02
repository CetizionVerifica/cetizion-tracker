import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The Reports section's PDF and CSVs (lib/reportPdf.js, lib/reportCsv.js),
 * built from a report in exactly the shape salesReport() returns — made here
 * with reportDefinitions' own pure section functions, so no database.
 */

const defs = await import('../src/lib/reportDefinitions.js');
const { MAX_PO_ROWS, PDF_SECTION_HEADINGS, pdfEnquiryBuckets, reportDocDefinition, reportPdf } = await import('../src/lib/reportPdf.js');
const csv = await import('../src/lib/reportCsv.js');

const CATEGORIES = { sectors: ['Metal Industry', 'Agriculture', 'Pharmaceutical'], lines: ['EcoVadis', 'ESIA', 'HSE'] };

function makeReport({ period = { from: '2026-09-01', to: '2026-09-30' }, grain = 'day', enquiries = [], pos = [] } = {}) {
  const mapSector = defs.sectorMapper(CATEGORIES.sectors, [{ alias: 'Steel', sector: 'Metal Industry' }]);
  const linesOf = defs.serviceMapper(CATEGORIES.lines, []);
  const labelled = pos.map((po) => ({ ...po, sector: mapSector(po.sector), service: defs.serviceSplit(po, linesOf).shares.map((s) => s.line).join(', ') }));
  const sections = {
    enquiries: defs.enquiriesReceived(enquiries, period, grain),
    outcomes: defs.outcomeSummary(enquiries, period),
    sectors: defs.sectorSection(pos, CATEGORIES.sectors, mapSector),
    services: defs.serviceSection(pos, CATEGORIES.lines, linesOf),
    customers: defs.customerSection(labelled, defs.orderIndex(pos.map((p) => ({ po_number: p.po_number, date: p.date, customer_key: p.customer_key }))), enquiries, period),
    revenue: defs.monthlyRevenue(labelled, [], period),
  };
  return { period, grain, ...sections, notes: [{ key: 'x', text: '3 POs have no sector on its quotation or company.' }], stale_rates: [], narrative: defs.narrate(sections) };
}

const ENQUIRIES = [
  { enquiry_no: 'E1', client: 'Acme', date: '2026-09-02', status: 'Converted', quotation_no: 'Q1', has_po: true, source: 'Website', customer_key: 'c:1' },
  { enquiry_no: 'E2', client: 'Beta', date: '2026-09-03', status: 'Unqualified', quotation_no: null, source: 'Referral', customer_key: 'c:2' },
];
const po = (i, extra = {}) => ({
  po_number: `PO-${String(i).padStart(3, '0')}`, date: '2026-09-10', client: 'Acme', customer: 'Acme', customer_key: 'c:1',
  sector: 'Steel', service: 'EcoVadis', currency: 'INR', po_value: 1000, rate: 1, po_value_inr: 1000, invoiced_inr: 0, received_inr: 0, ...extra,
});

/** Every string anywhere in a pdfmake node tree. */
function texts(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === 'object') {
    for (const key of ['text', 'stack', 'columns', 'ul', 'ol', 'table', 'body']) if (key in node) texts(node[key], out);
  }
  return out;
}
/** The numbered section headings, in document order. */
const headings = (doc) => doc.content.flatMap((node) => {
  const h = node?.stack?.[0];
  return h?.style === 'h1' && Array.isArray(h.text) ? [h.text.map((t) => (typeof t === 'string' ? t : t.text)).join('').trim()] : [];
});
const svgs = (doc) => JSON.stringify(doc.content).match(/"svg":/g)?.length ?? 0;

test('the six questions, in the order the screen asks them', () => {
  const doc = reportDocDefinition(makeReport({ enquiries: ENQUIRIES, pos: [po(1)] }));
  assert.deepEqual(headings(doc), PDF_SECTION_HEADINGS.map((q, i) => `${i + 1}.  ${q}`));
  const all = texts(doc.content).join('\n');
  assert.match(all, /Notes and what to fix/);
  assert.match(all, /3 POs have no sector/);
  // The sentence each section opens with is the server's, as on screen.
  assert.ok(all.includes(makeReport({ enquiries: ENQUIRIES, pos: [po(1)] }).narrative.outcomes));
});

test('an empty period says so in every section, and draws no empty chart', () => {
  const doc = reportDocDefinition(makeReport());
  assert.equal(headings(doc).length, 6);
  assert.equal(texts(doc.content).filter((t) => t === 'Nothing in this period.').length, 6);
  assert.equal(svgs(doc), 0);
});

test('a daily chart longer than a month is drawn by week', () => {
  const period = { from: '2026-04-01', to: '2026-06-30' };
  const enquiries = [{ enquiry_no: 'E1', date: '2026-04-01' }, { enquiry_no: 'E2', date: '2026-04-05' }, { enquiry_no: 'E3', date: '2026-04-06' }];
  const report = makeReport({ period, grain: 'day', enquiries });
  const drawn = pdfEnquiryBuckets(report.enquiries);
  assert.equal(drawn.grain, 'week');
  assert.ok(drawn.regrouped);
  // 1 and 5 April are in the week of 30 March; 6 April starts the next.
  assert.deepEqual(drawn.buckets.slice(0, 2).map((b) => [b.key, b.enquiries]), [['2026-03-30', 2], ['2026-04-06', 1]]);
  assert.equal(drawn.buckets.reduce((n, b) => n + b.enquiries, 0), 3);
  assert.match(texts(reportDocDefinition(report).content).join('\n'), /drawn by week/);

  // A month of days stays daily.
  assert.equal(pdfEnquiryBuckets(makeReport({ enquiries: ENQUIRIES }).enquiries).grain, 'day');
});

test('the PO list goes landscape, stops at its cap, and says where the rest is', () => {
  const pos = Array.from({ length: MAX_PO_ROWS + 5 }, (_, i) => po(i + 1));
  const doc = reportDocDefinition(makeReport({ pos }));
  const landscape = doc.content.find((node) => node?.pageOrientation === 'landscape');
  assert.ok(landscape);
  const table = landscape.stack.find((node) => node.table);
  assert.equal(table.table.body.length, MAX_PO_ROWS + 1); // plus the header row
  assert.match(texts(landscape).join(' '), /and 5 more rows/);
  // And back to portrait for the notes.
  assert.equal(doc.content.at(-1).pageOrientation, 'portrait');
});

test('it renders a real PDF', async () => {
  const buffer = await reportPdf(makeReport({ enquiries: ENQUIRIES, pos: [po(1), po(2, { sector: 'Retail', service: 'HAZOP' })] }), { owner: 'Asha' });
  assert.ok(buffer.length > 5000);
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
});

test('each section CSV comes from the same report', () => {
  const report = makeReport({ enquiries: ENQUIRIES, pos: [po(1), po(2, { date: '2026-09-20', sector: 'Retail', service: 'ESIA + HSE', po_value_inr: 2000, po_value: 2000 })] });
  assert.deepEqual(Object.keys(csv.enquiriesCsvRows(report)[0]), ['Day', 'Label', 'Enquiries', 'Referral', 'Website']);
  assert.deepEqual(csv.outcomesCsvRows(report).map((r) => r.Outcome), ['Converted to PO', 'Lost']);
  assert.deepEqual(csv.sectorCsvRows(report).filter((r) => r.Spelling).map((r) => [r.Sector, r.Spelling]), [['Other', 'Retail']]);
  assert.equal(csv.servicesCsvRows(report).reduce((n, r) => n + r['PO value incl. GST (INR)'], 0), 3000);
  assert.deepEqual(csv.repeatOrdersCsvRows(report).map((r) => [r.PO, r['Earlier POs']]), [['PO-002', 1]]);
  assert.deepEqual(csv.revenueCsvRows(report).at(-1).Month, 'Total');
  assert.equal(csv.revenuePosCsvRows(report).length, 2);
  assert.deepEqual(csv.newCustomersCsvRows(report).map((r) => r.Enquiry), ['E1', 'E2']);
});
