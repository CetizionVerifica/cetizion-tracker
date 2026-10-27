import { test } from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { checkGstin, fyQuarter, gstDate, gstinCheckDigit, normaliseNumber, splitGstAmount, splitInclusive, splitTax } from '../src/lib/accounting/gst.js';
import { parseBooksFile } from '../src/lib/accounting/books.js';
import { tallyVoucherXml } from '../src/lib/accounting/providers.js';

// Accounting integration (#48); none of these needs a database.

test('GSTINs are checked for format, state and check digit', () => {
  const body = '27AAPFU0939F1Z';
  const good = body + gstinCheckDigit(body);
  assert.deepEqual({ ...checkGstin(good), gstin: undefined }, { valid: true, gstin: undefined, state_code: '27', state: 'Maharashtra', pan: 'AAPFU0939F' });
  const wrong = body + (gstinCheckDigit(body) === 'A' ? 'B' : 'A');
  assert.equal(checkGstin(wrong).reason, 'check digit');
  assert.equal(checkGstin('99AAPFU0939F1ZV').reason, 'state code');
  assert.equal(checkGstin('27AAPFU0939F1Z').reason, 'format');
  assert.equal(checkGstin('').valid, false);
});

test('a known published GSTIN passes', () => {
  // Maharashtra sample used in GST portal documentation.
  assert.equal(checkGstin('27AAPFU0939F1ZV').valid, true);
});

test('intra-state supply splits CGST and SGST; inter-state is IGST', () => {
  assert.deepEqual(splitTax(100000, 18, { ourState: '27', theirState: '27' }), { cgst: 9000, sgst: 9000, igst: 0, tax: 18000, intra: true });
  assert.deepEqual(splitTax(100000, 18, { ourState: '27', theirState: '29' }), { cgst: 0, sgst: 0, igst: 18000, tax: 18000, intra: false });
  const odd = splitTax(333.33, 18, { ourState: 7, theirState: '07' });
  assert.equal(Math.round((odd.cgst + odd.sgst) * 100) / 100, odd.tax);
});

test('GST is taken out of an amount that already includes it, never added on top', () => {
  // ₹1,18,000 at 18% is ₹1,00,000 + ₹18,000.
  assert.deepEqual(splitInclusive(118000, [{ rate: 18, amount: 100000 }]), [{ rate: 18, total: 118000, taxable: 100000, gst: 18000 }]);
  // Mixed rates split back into the lines they came from.
  assert.deepEqual(splitInclusive(128500, [{ rate: 5, amount: 10000 }, { rate: 18, amount: 100000 }]).map((p) => [p.rate, p.taxable, p.gst]),
    [[18, 100000, 18000], [5, 10000, 500]]);
  // A share of an invoice (a 30% stage) still adds up to the paisa.
  for (const total of [35550, 0.01, 99999.99, 38550]) {
    const parts = splitInclusive(total, [{ rate: 18, amount: 100000 }, { rate: 5, amount: 10000 }, { rate: 12, amount: 333.33 }]);
    const back = Math.round(parts.reduce((n, p) => n + p.taxable + p.gst, 0) * 100) / 100;
    assert.equal(back, total, `${total} splits and adds back exactly`);
  }
  // No lines: the fallback rate. An export: rate 0, all of it taxable.
  assert.deepEqual(splitInclusive(1180, [], 18), [{ rate: 18, total: 1180, taxable: 1000, gst: 180 }]);
  assert.deepEqual(splitInclusive(5000, [], 0), [{ rate: 0, total: 5000, taxable: 5000, gst: 0 }]);
});

test('a GST amount splits into CGST + SGST or IGST and adds back', () => {
  assert.deepEqual(splitGstAmount(18000, { ourState: '27', theirState: '27' }), { cgst: 9000, sgst: 9000, igst: 0, tax: 18000, intra: true });
  const odd = splitGstAmount(0.03, { ourState: '27', theirState: '27' });
  assert.equal(Math.round((odd.cgst + odd.sgst) * 100) / 100, 0.03);
  assert.deepEqual(splitGstAmount(500, { ourState: '27', theirState: '29' }), { cgst: 0, sgst: 0, igst: 500, tax: 500, intra: false });
});

test('financial-year quarters start in April', () => {
  assert.equal(fyQuarter('2026-04-01').label, 'FY 2026-27 Q1');
  assert.equal(fyQuarter('2026-12-31').label, 'FY 2026-27 Q3');
  assert.equal(fyQuarter('2027-03-31').label, 'FY 2026-27 Q4');
  assert.equal(gstDate('2026-09-05'), '05-Sep-2026');
  assert.equal(normaliseNumber('ctz/inv 2026-021'), normaliseNumber('CTZINV2026021'));
});

test('a Zoho invoice export is read, with its title rows skipped', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Invoices exported from Zoho Books'], [],
    ['Invoice Date', 'Invoice Number', 'Customer Name', 'GST Identification Number (GSTIN)', 'SubTotal', 'Total', 'Due Date', 'Currency Code'],
    ['05/09/2026', 'CTZ/INV/2026/021', 'Midal', '27aapfu0939f1zv', '1,25,000.00', '147500', '2026-10-05', 'INR'],
    ['06/09/2026', '', 'Nobody', '', '10', '10', '', 'INR'],
  ]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
  const { entries, problems } = parseBooksFile(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(entries.length, 1);
  assert.deepEqual(
    { n: entries[0].number, d: entries[0].entry_date, t: entries[0].taxable_amount, total: entries[0].total_amount, g: entries[0].customer_gstin, due: entries[0].due_date },
    { n: 'CTZ/INV/2026/021', d: '2026-09-05', t: 125000, total: 147500, g: '27AAPFU0939F1ZV', due: '2026-10-05' });
  assert.match(problems[0], /no invoice number/);
});

test('a Tally day book sorts itself into invoices and receipts', () => {
  const csv = 'Date,Particulars,Voucher Type,Voucher No,Debit Amount,Credit Amount,Against Invoice\n1-Sep-26,Midal,Sales,S-101,118000,,\n9-Sep-26,Midal,Receipt,R-7,,100000,S-101\n9-Sep-26,Office,Journal,J-1,5,,\n';
  const { entries } = parseBooksFile(Buffer.from(csv));
  assert.deepEqual(entries.map((e) => [e.kind, e.number, e.total_amount, e.reference]), [['invoice', 'S-101', 118000, null], ['payment', 'R-7', 100000, 'S-101']]);
});

test('CSV dates are read day first', () => {
  const { entries } = parseBooksFile(Buffer.from('Invoice Date,Invoice Number,Total\n01/06/2026,A-1,100\n'));
  assert.equal(entries[0].entry_date, '2026-06-01');
});

test('a Tally sales voucher balances', () => {
  const xml = tallyVoucherXml({ customer: { name: 'Midal', gstin: '27AAPFU0939F1ZV' }, reference: 'PO-1 · Advance', description: 'Advance', taxable: 100000, cgst: 9000, sgst: 9000, igst: 0, tax: 18000, intra: true, total: 118000 }, { date: '2026-09-17' });
  const amounts = [...xml.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
  assert.equal(Math.round(amounts.reduce((a, b) => a + b, 0) * 100), 0);
  assert.match(xml, /<DATE>20260917<\/DATE>/);
  assert.match(xml, /Output CGST/);
});
