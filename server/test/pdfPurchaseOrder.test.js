import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPo, grossUp, rankPoPdfs, stagesFromTerms } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { parsePoVerdict } from '../src/lib/mailbox/poDetect.js';

/**
 * The checks a client's PO must pass before it is registered, and the
 * stages its terms give (docs/email-po-plan.md §3.2, §3.4). No database,
 * no network.
 */

const PDF_TEXT = `PURCHASE ORDER
Acme Steel Ltd, GSTIN 27AAACX1234A1ZX
To: Cetizion Verifica Pvt. Ltd., GSTIN 27AAJCC9999K1ZK
PO No: 4500012345   Date: 22.09.2026   Ref: your offer CTZ/QT/2026/045
1  EcoVadis assessment   1   2,50,000.00   2,50,000.00
Basic 2,50,000.00   IGST 18% 45,000.00   Total 2,95,000.00
Payment: 50% advance, balance on submission of report. 30 days credit.`;

const read = (over = {}) => parsePoVerdict({
  is_purchase_order: true, document_type: 'purchase_order', confidence: 0.92, po_number: '4500012345', po_date: '2026-09-22', amendment_no: 0,
  buyer: { company_name: 'Acme Steel Ltd', gstin: '27AAACX1234A1ZX' }, vendor: { company_name: 'Cetizion Verifica Pvt. Ltd.', gstin: '27AAJCC9999K1ZK' },
  our_quotation_ref: 'CTZ/QT/2026/045', currency: 'INR',
  lines: [{ description: 'EcoVadis assessment', qty: 1, rate: '2,50,000.00', amount: '2,50,000.00' }],
  basic_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00', gst_extra: false,
  payment_terms_text: '50% advance, balance on submission of report', credit_days: 30, ...over,
});
const opts = { emailDate: '2026-09-23T05:00:00Z', sourceText: PDF_TEXT, ourNames: ['Cetizion Verifica Pvt. Ltd.'], ourGstin: '27AAJCC9999K1ZK' };

test('a good PO passes, with its number as printed and compared normalised', () => {
  const r = checkPo(read(), opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.po.po_number, '4500012345');
  assert.equal(r.po.po_number_norm, '4500012345');
  assert.equal(r.po.total_value, 295000);
  assert.equal(r.po.linesOk, true);
  assert.deepEqual(r.flags, []);
  assert.equal(checkPo(read({ po_number: 'PO/2026/12' }), { ...opts, sourceText: `${PDF_TEXT} PO/2026/12` }).po.po_number_norm, 'po202612');
});

test('a document that is not an order is not_po; below the bar is low_confidence', () => {
  assert.equal(checkPo(read({ is_purchase_order: false, document_type: 'other' }), opts).reason, 'not_po');
  assert.equal(checkPo(read({ confidence: 0.84 }), opts).reason, 'low_confidence');
  assert.equal(checkPo(read({ confidence: 0.84 }), { ...opts, minConfidence: 0.8 }).ok, true);
});

test('amendments and cancellations always go to review, with what was read', () => {
  const a = checkPo(read({ document_type: 'amendment' }), opts);
  assert.deepEqual([a.ok, a.reason, a.po.po_number], [false, 'amendment', '4500012345']);
  assert.equal(checkPo(read({ amendment_no: 1 }), opts).reason, 'amendment');
  assert.equal(checkPo(read({ is_purchase_order: false, document_type: 'cancellation' }), opts).reason, 'cancellation');
});

test('a vendor that is not us, or a buyer that is us, is not_to_us', () => {
  assert.equal(checkPo(read({ vendor: { company_name: 'Bureau Veritas India', gstin: '27AABCB1111A1ZQ' } }), opts).reason, 'not_to_us');
  assert.equal(checkPo(read({ vendor: { company_name: 'Cetizion Verifica', gstin: '29ZZZZZ0000Z1ZM' } }), opts).reason, 'not_to_us', 'the GSTIN decides when both are known');
  // A PO we issued to a vendor reads the other way round.
  assert.equal(checkPo(read({ buyer: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, vendor: { company_name: 'Print Shop' } }), opts).reason, 'not_to_us');
  // The vendor left blank by the model: the PDF naming us is enough.
  assert.equal(checkPo(read({ vendor: {} }), opts).ok, true);
  assert.equal(checkPo(read({ vendor: {} }), { ...opts, sourceText: PDF_TEXT.replace(/Cetizion Verifica Pvt\. Ltd\., GSTIN 27AAJCC9999K1ZK/, 'Someone Else') }).reason, 'not_to_us');
});

test('a missing or promised PO number is no_po_number', () => {
  for (const po_number of [null, 'Awaited', 'TBD', 'Verbal', '12']) {
    assert.equal(checkPo(read({ po_number }), opts).reason, 'no_po_number', String(po_number));
  }
});

test('amounts the PDF does not print are refused', () => {
  assert.equal(checkPo(read({ basic_value: null, tax_value: null, total_value: '3,95,000.00' }), opts).reason, 'amounts_not_in_pdf');
  assert.equal(checkPo(read({ tax_value: '54,000.00', total_value: '3,04,000.00' }), opts).reason, 'amounts_not_in_pdf');
  // A scan read by OCR has no text to check against: taken as read.
  assert.equal(checkPo(read({ total_value: '3,95,000.00', tax_value: '1,45,000.00' }), { ...opts, sourceText: null }).ok, true);
});

test('basic and tax must make the total; lines that do not add up are dropped, not trusted', () => {
  assert.equal(checkPo(read({ tax_value: '40,000.00' }), { ...opts, sourceText: `${PDF_TEXT} 40,000.00` }).reason, 'totals_do_not_add_up');
  const r = checkPo(read({ lines: [{ description: 'EcoVadis', qty: 1, amount: '2,00,000.00' }] }), { ...opts, sourceText: `${PDF_TEXT} 2,00,000.00` });
  assert.equal(r.ok, true);
  assert.equal(r.po.linesOk, false);
  assert.deepEqual(r.po.lines, []);
  assert.ok(r.flags.includes('lines_not_used'));
});

test('a future or year-old PO date is replaced by the email date, and flagged', () => {
  for (const po_date of ['2026-09-30', '2025-09-01', null]) {
    const r = checkPo(read({ po_date }), opts);
    assert.equal(r.po.po_date, '2026-09-23', String(po_date));
    assert.ok(r.flags.includes('po_date_from_email'));
  }
  assert.equal(checkPo(read({ po_date: '2026-09-23' }), opts).po.po_date, '2026-09-23', 'the same day is fine');
});

test('the currency must be the tracker\'s; none printed stays unknown, for the quotation to settle', () => {
  assert.equal(checkPo(read({ currency: 'JPY' }), opts).reason, 'bad_currency');
  assert.equal(checkPo(read({ currency: null }), opts).po.currency, null);
  assert.equal(checkPo(read({ currency: 'USD' }), opts).po.currency, 'USD');
});

test('"GST extra" with only a basic value passes, with no total; no value at all does not', () => {
  const text = 'PURCHASE ORDER To Cetizion Verifica Pvt. Ltd. PO No 4500012345 Basic 2,50,000.00 GST extra as applicable';
  const r = checkPo(read({ tax_value: null, total_value: null, gst_extra: true }), { ...opts, sourceText: text });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.po.total_value, null);
  assert.equal(r.po.basic_value, 250000);
  assert.equal(checkPo(read({ basic_value: null, tax_value: null, total_value: null }), opts).reason, 'no_value');
});

test('credit days default to 30, and say so', () => {
  const r = checkPo(read({ credit_days: null }), opts);
  assert.equal(r.po.credit_days, 30);
  assert.ok(r.flags.includes('credit_days_default'));
});

test('grossUp adds GST at the quotation lines\' own rates, else 18%', () => {
  assert.equal(grossUp(250000), 295000);
  assert.equal(grossUp(110000, [{ amount: 100000, gst_rate: 18 }, { amount: 10000, gst_rate: 5 }]), 128500);
  assert.equal(grossUp(55000, [{ amount: 100000, gst_rate: 18 }, { amount: 10000, gst_rate: 5 }]), 64250, 'a partial PO at the same mix');
});

test('stagesFromTerms reads the common shapes, and leaves the rest to the template', () => {
  const pct = (r) => (r.stages || []).map((s) => [s.trigger_event, s.percent, s.milestone_name ?? null]);
  assert.deepEqual(pct(stagesFromTerms('50% advance, balance on report')), [['On PO Registration', 50, null], ['On Delivery', 50, null]]);
  assert.deepEqual(pct(stagesFromTerms('100% after completion')), [['On Delivery', 100, null]]);
  assert.deepEqual(pct(stagesFromTerms('Payment on submission of final report')), [['On Delivery', 100, null]]);
  assert.deepEqual(pct(stagesFromTerms('30% advance, 40% on draft, 30% on final')),
    [['On PO Registration', 30, null], ['On Milestone', 40, 'Draft'], ['On Delivery', 30, null]]);
  assert.deepEqual(pct(stagesFromTerms('40% on stage 1 audit; 60% on certification')), [['On Milestone', 40, 'Stage 1 audit'], ['On Delivery', 60, null]]);
  assert.deepEqual(pct(stagesFromTerms('100% advance along with PO')), [['On PO Registration', 100, null]]);
  for (const unclear of ['advance 18% GST extra', 'As per our standard terms', 'Within 30 days of invoice', '', null, '30% advance, 30% on draft', '10% TDS will be deducted']) {
    assert.deepEqual(stagesFromTerms(unclear), { source: 'template' }, String(unclear));
  }
  assert.equal(stagesFromTerms('50% advance, balance on report').source, 'po_terms');
  // The stages always add up to 100, as registration requires.
  for (const t of ['50% advance, balance on report', '30% advance, 40% on draft, 30% on final', '25% advance']) {
    assert.equal(stagesFromTerms(t).stages.reduce((n, s) => n + s.percent, 0), 100, t);
  }
});

test('rankPoPdfs puts the order first and the terms annexure last', () => {
  const ranked = rankPoPdfs([
    { name: 'General Terms and Conditions.pdf', size: 900_000, firstPage: 'GENERAL TERMS AND CONDITIONS OF PURCHASE' },
    { name: 'scan001.pdf', size: 200_000, firstPage: 'PURCHASE ORDER No 4500012345' },
    { name: 'Company profile.pdf', size: 5_000_000, firstPage: 'About Acme Steel' },
    { name: 'PO_4500012345.pdf', size: 150_000, firstPage: '' },
  ]);
  assert.deepEqual(ranked.map((f) => f.name), ['PO_4500012345.pdf', 'scan001.pdf', 'Company profile.pdf', 'General Terms and Conditions.pdf']);
});
