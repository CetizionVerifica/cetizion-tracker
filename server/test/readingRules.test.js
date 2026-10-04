import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { RULES, TOTALS_RULES, parseTaxBreakup, taxFromBreakup, wordsToAmount } from '../src/lib/mailbox/promptRules.js';
import { parseAmount } from '../src/lib/mailbox/pdfQuotation.js';
import { buildPoPrompt, parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkPo } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { buildInvoicePrompt, checkInvoice, parseInvoiceVerdict } from '../src/lib/mailbox/invoiceDetect.js';

/**
 * The shared reading rules (docs/email-po-invoice-prompt-plan.md §2), from
 * the samples: Aragen's 03.08.2026 and garbled words line, Hindalco's
 * 08-AUG-2026, Alembic's three decimals, Dasami's "Indian Rupee24,63,840.00"
 * with CGST and SGST printed and the IGST row blank.
 */

describe('dates, amounts, tax rows and amounts in words', () => {
  test('the rules name the formats the samples print', () => {
    for (const d of ['25-03-2026', '08-AUG-2026', '22-May-26', 'two-digit year is 20YY']) assert.ok(RULES.dates.includes(d), d);
    for (const a of ['"500,000.000" is five lakh', '"Indian Rupee24,63,840.00" gives "24,63,840.00"']) assert.ok(RULES.amounts.includes(a), a);
  });

  test('an amount with its label glued on, or three decimals, is read as the number', () => {
    assert.equal(parseAmount('Indian Rupee24,63,840.00'), 2463840);
    assert.equal(parseAmount('500,000.000'), 500000);
    assert.equal(parseAmount('Total: 5,90,000'), 590000);
    assert.equal(parseAmount('Rs. 1,47,500/-'), 147500);
    assert.equal(parseAmount('N/A'), null);
  });

  test('Indian words to a number: crore, lakh, thousand, hundred, paise', () => {
    assert.equal(wordsToAmount('Rupees Two Lakh Ninety Five Thousand Only'), 295000);
    assert.equal(wordsToAmount('Indian Rupee Twenty Four Lakh Sixty Three Thousand Eight Hundred Forty Only'), 2463840);
    assert.equal(wordsToAmount('INR Five Lakh Ninety Thousand and Fifty Paise Only'), 590000.5);
    assert.equal(wordsToAmount('One Crore Two Lakh'), 10200000);
    assert.equal(wordsToAmount('Twenty-Five Thousand'), 25000);
    assert.equal(wordsToAmount('rupees ninety five thousand three hundred and twenty five'), 95325);
  });

  test("a words line that cannot be read is ignored, never a failure (Aragen's \"… Thousand Paise\")", () => {
    assert.equal(wordsToAmount('Rupees Two Lakh Ninety Five Thousand Paise'), null);
    assert.equal(wordsToAmount('As per the attached annexure'), null);
    assert.equal(wordsToAmount(null), null);
  });

  test('the GST rows: each as printed or null, a blank row never 0, added in code', () => {
    const b = parseTaxBreakup({ igst: '', cgst: '1,87,920.00', sgst: '1,87,920.00' }, parseAmount);
    assert.deepEqual(b, { igst: null, cgst: 187920, sgst: 187920 });
    assert.equal(taxFromBreakup(b), 375840);
    assert.equal(taxFromBreakup({ igst: null, cgst: null, sgst: null }), null);
  });

  test('the PO and invoice prompts ask for both, in the shared words', () => {
    const base = { emailSubject: 'PO', emailText: 'Attached.', receivedAt: '2026-08-04T10:00:00Z', sentAt: '2026-08-04T10:00:00Z', from: { email: 'a@b.com' }, pdfText: 'x' };
    for (const { system } of [buildPoPrompt(base), buildInvoicePrompt(base)]) {
      for (const rule of TOTALS_RULES) assert.ok(system.includes(rule), rule.slice(0, 30));
      assert.match(system, /"tax_breakup": \{"igst"/);
      assert.match(system, /"total_in_words": string\|null/);
    }
  });
});

// Dasami's work order: five services, CGST and SGST, the IGST row blank, the total glued to its label.
const DASAMI_TEXT = 'WORK ORDER DL26SW060-1132 Taxable 20,88,000.00 CGST 9% 1,87,920.00 SGST 9% 1,87,920.00 IGST Grand Total Indian Rupee24,63,840.00 Rupees Twenty Four Lakh Sixty Three Thousand Eight Hundred Forty Only';
const dasami = (over = {}) => parsePoVerdict({
  is_purchase_order: true, document_type: 'work_order', confidence: 0.9, po_number: 'DL26SW060-1132', po_date: '2026-08-03', amendment_no: 0,
  buyer: { company_name: 'Dasami Lab Pvt Ltd' }, vendor: { company_name: 'Cetizion Verifica Pvt Ltd' }, currency: 'INR',
  lines: [], basic_value: '20,88,000.00', tax_value: null, total_value: 'Indian Rupee24,63,840.00',
  tax_breakup: { igst: null, cgst: '1,87,920.00', sgst: '1,87,920.00' }, total_in_words: 'Rupees Twenty Four Lakh Sixty Three Thousand Eight Hundred Forty Only',
  payment_terms_text: '50% Advance Against PI & 50% Against work Completion', ...over,
});
const poOpts = { emailDate: '2026-08-04T05:00:00Z', sourceText: DASAMI_TEXT, ourNames: ['Cetizion Verifica Pvt Ltd'] };

describe('the PO checks use them', () => {
  test('CGST and SGST printed, IGST blank: the tax is their sum, and the total and its words agree', () => {
    const r = checkPo(dasami(), poOpts);
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual([r.po.basic_value, r.po.tax_value, r.po.total_value], [2088000, 375840, 2463840]);
  });

  test('a tax figure the rows do not add up to, or words that say another total, are refused', () => {
    assert.equal(checkPo(dasami({ tax_value: '3,00,000.00' }), { ...poOpts, sourceText: `${DASAMI_TEXT} 3,00,000.00` }).reason, 'totals_do_not_add_up');
    assert.equal(checkPo(dasami({ total_in_words: 'Rupees Twenty Lakh Only' }), poOpts).reason, 'totals_do_not_add_up');
    assert.equal(checkPo(dasami({ total_in_words: 'Rupees Twenty Four Lakh Sixty Three Thousand Paise' }), poOpts).ok, true, 'an unreadable words line is let be');
  });

  test('a tax row the PDF does not print is a made-up figure', () => {
    assert.equal(checkPo(dasami({ tax_breakup: { igst: null, cgst: '1,87,920.00', sgst: '1,87,921.00' }, total_in_words: null }), poOpts).reason, 'amounts_not_in_pdf');
  });
});

// Our invoice CVPL/2026-27/037 to Alembic: IGST, amount in words printed.
const INV_TEXT = 'TAX INVOICE CVPL/2026-27/037 Buyer\'s Order No. 3700101318 Taxable 2,50,000.00 IGST 18% 45,000.00 Total 2,95,000.00 Rupees Two Lakh Ninety Five Thousand Only';
const invoice = (over = {}) => parseInvoiceVerdict({
  document_type: 'tax_invoice', confidence: 0.93, invoice_no: 'CVPL/2026-27/037', invoice_date: '2026-05-22',
  seller: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, buyer: { company_name: 'Alembic Pharmaceuticals Ltd' }, po_reference: '3700101318', currency: 'INR',
  taxable_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00', tax_breakup: { igst: '45,000.00', cgst: null, sgst: null },
  total_in_words: 'Rupees Two Lakh Ninety Five Thousand Only', ...over,
});
const invOpts = { emailDate: '2026-05-22T09:00:00Z', sourceText: INV_TEXT, ourNames: ['Cetizion Verifica Pvt. Ltd.'] };

describe('the invoice checks use them', () => {
  test('IGST and the words agree with the total', () => {
    const r = checkInvoice(invoice(), invOpts);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.invoice.tax_value, 45000);
  });

  test('only CGST and SGST printed: the tax is their sum', () => {
    const text = 'TAX INVOICE CVPL/2026-27/038 Taxable 2,50,000.00 CGST 22,500.00 SGST 22,500.00 Total 2,95,000.00';
    const r = checkInvoice(invoice({ invoice_no: 'CVPL/2026-27/038', tax_value: null, tax_breakup: { igst: null, cgst: '22,500.00', sgst: '22,500.00' }, total_in_words: null }), { ...invOpts, sourceText: text });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.invoice.tax_value, 45000);
  });

  test('words that say another amount send it to review', () => {
    assert.equal(checkInvoice(invoice({ total_in_words: 'Rupees Two Lakh Fifty Thousand Only' }), invOpts).ok, true, 'the value before tax, in words, agrees too');
    assert.equal(checkInvoice(invoice({ total_in_words: 'Rupees Three Lakh Only' }), invOpts).reason, 'totals_do_not_add_up');
  });
});
