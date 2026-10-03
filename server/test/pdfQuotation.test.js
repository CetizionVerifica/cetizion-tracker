import assert from 'node:assert/strict';
import test from 'node:test';
import { amountInText, checkExtraction, linesAddUp, near, parseAmount, parseRevision, rankPdfs } from '../src/lib/mailbox/pdfQuotation.js';

/**
 * The checks a quotation read from a PDF must pass before it is created
 * (docs/email-enquiries-plan.md §3.9.3, §3.9.5). No database, no network.
 */

const good = (over = {}) => ({
  quotation_no_printed: 'CV/Q/2025/045', revision: 0, quotation_date: '2026-09-28', valid_until: '2026-10-28',
  client: { company_name: 'Acme Steel Ltd', contact_name: 'Ravi Kumar' }, currency: 'INR',
  lines: [{ description: 'EcoVadis assessment', qty: 1, rate: '2,50,000.00', gst_rate: 18, service: 'EcoVadis' }],
  subtotal: '2,50,000.00', tax_total: '45,000.00', total: '2,95,000.00', confidence: 0.92, ...over,
});
const opts = { emailDate: '2026-10-01T09:00:00Z', sourceText: 'QUOTATION ... Total 2,95,000.00', ourNames: ['Cetizion Verifica Pvt. Ltd.'] };

test('parseAmount reads Indian and Western grouping, currency marks and /-', () => {
  assert.equal(parseAmount('2,50,000.00'), 250000);
  assert.equal(parseAmount('₹ 2,95,000/-'), 295000);
  assert.equal(parseAmount('Rs. 1,200'), 1200);
  assert.equal(parseAmount('INR 45000'), 45000);
  assert.equal(parseAmount('250,000.50'), 250000.5);
  assert.equal(parseAmount(1200), 1200);
  assert.equal(parseAmount('two lakh'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

test('near: within a rupee, or half a percent of a large amount', () => {
  assert.ok(near(100, 100.9));
  assert.ok(!near(100, 102));
  assert.ok(near(1_000_000, 1_004_000));
  assert.ok(!near(1_000_000, 1_006_000));
});

test('linesAddUp: lines to subtotal, subtotal and tax to total', () => {
  const lines = [{ qty: 2, rate: 1000, discount_percent: 10, gst_rate: 18 }, { qty: 1, rate: 200, discount_percent: 0, gst_rate: 18 }];
  assert.ok(linesAddUp(lines, { subtotal: 2000, tax_total: 360, total: 2360 }));
  assert.ok(!linesAddUp(lines, { subtotal: 2500, tax_total: 360, total: 2860 }), 'lines that do not reach the subtotal');
  assert.ok(!linesAddUp(lines, { subtotal: 2000, tax_total: 360, total: 3000 }), 'a total that is not subtotal plus tax');
  assert.ok(linesAddUp(lines, { subtotal: 2000, tax_total: null, total: 2360 }), 'no tax printed: the lines\' GST makes it up');
  assert.ok(!linesAddUp([], { subtotal: 0, tax_total: 0, total: 0 }));
});

test('a good extraction passes, with its lines and the printed totals', () => {
  const r = checkExtraction(good(), opts);
  assert.equal(r.ok, true);
  assert.equal(r.linesOk, true);
  assert.equal(r.extraction.lines[0].rate, 250000);
  assert.deepEqual(r.printed, { printed_subtotal: 250000, printed_tax_total: 45000, printed_total: 295000 });
});

test('lines that do not add up are dropped, the printed totals stay', () => {
  const r = checkExtraction(good({ lines: [{ description: 'Audit', qty: 1, rate: '2,00,000' }] }), opts);
  assert.equal(r.ok, true);
  assert.equal(r.linesOk, false);
  assert.deepEqual(r.extraction.lines, []);
  assert.equal(r.extraction.total, 295000);
});

test('a bad number in one line means no lines are used', () => {
  assert.equal(checkExtraction(good({ lines: [{ description: 'Audit', qty: 0, rate: '2,50,000' }] }), opts).linesOk, false);
  assert.equal(checkExtraction(good({ lines: [{ description: 'Audit', qty: 1, rate: '2,50,000', discount_percent: 150 }] }), opts).linesOk, false);
  assert.equal(checkExtraction(good({ lines: [{ description: 'Audit', qty: 1, rate: 'lots' }] }), opts).linesOk, false);
});

test('the client is never us', () => {
  assert.deepEqual(checkExtraction(good({ client: { company_name: 'Cetizion Verifica Pvt Ltd' } }), opts), { ok: false, reason: 'no_client' });
  assert.deepEqual(checkExtraction(good({ client: {} }), opts), { ok: false, reason: 'no_client' });
});

test('low confidence, no total, or a total the PDF does not print: not created', () => {
  assert.equal(checkExtraction(good({ confidence: 0.5 }), opts).reason, 'low_confidence');
  assert.equal(checkExtraction(good({ total: null, tax_total: null, subtotal: null, lines: [] }), opts).reason, 'no_total');
  assert.equal(checkExtraction(good({ total: '3,95,000.00', tax_total: '1,45,000.00' }), opts).reason, 'total_not_in_pdf');
  assert.equal(checkExtraction('not json', opts).reason, 'low_confidence');
});

test('dates: on or before the email and no more than 60 days earlier, else the email date', () => {
  assert.equal(checkExtraction(good(), opts).extraction.quotation_date, '2026-09-28');
  const future = checkExtraction(good({ quotation_date: '2026-11-01' }), opts).extraction;
  assert.equal(future.quotation_date, '2026-10-01');
  assert.equal(future.valid_until, null);
  assert.equal(checkExtraction(good({ quotation_date: '2026-01-01' }), opts).extraction.quotation_date, '2026-10-01');
  assert.equal(checkExtraction(good({ valid_until: '2026-09-01' }), opts).extraction.valid_until, null, 'validity before the date');
});

test('revision and amounts in the text', () => {
  assert.equal(parseRevision('Rev 1'), 1);
  assert.equal(parseRevision('R2'), 2);
  assert.equal(parseRevision(null), 0);
  assert.ok(amountInText(295000, 'Total: 2,95,000.00'));
  assert.ok(!amountInText(395000, 'Total: 2,95,000.00'));
});

test('the quotation PDF ranks above a brochure, by name, then first page, then size', () => {
  const files = [
    { name: 'Company profile.pdf', size: 5_000_000, firstPage: 'About us' },
    { name: 'Document.pdf', size: 100, firstPage: 'QUOTATION for EcoVadis' },
    { name: 'Cetizion_Quotation_Acme.pdf', size: 50, firstPage: '' },
  ];
  assert.deepEqual(rankPdfs(files).map((f) => f.name), ['Cetizion_Quotation_Acme.pdf', 'Document.pdf', 'Company profile.pdf']);
});

test('the email date is taken in IST: a quotation dated 2 October and emailed at 01:30 IST keeps its date', () => {
  const r = checkExtraction(good({ quotation_date: '2026-10-02', valid_until: '2026-11-01' }), { ...opts, emailDate: '2026-10-01T20:00:00Z' });
  assert.equal(r.extraction.quotation_date, '2026-10-02');
  assert.equal(r.extraction.valid_until, '2026-11-01');
});

test('pdfText reads 40 pages of a long PDF, where it used to stop at 10', async () => {
  const { pdfText } = await import('../src/lib/mailbox/pdfQuotation.js');
  const { default: pdfmake } = await import('../src/lib/pdf.js');
  const content = Array.from({ length: 45 }, (_, i) => ({ text: `Page ${i + 1} of the schedule`, pageBreak: i ? 'before' : undefined }));
  const pages = await pdfText(await pdfmake.createPdf({ content }).getBuffer());
  assert.equal(pages.length, 40);
  assert.match(pages[39], /Page 40 of the schedule/);
});
