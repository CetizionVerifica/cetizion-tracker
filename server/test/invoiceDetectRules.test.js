import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInvoice, invoicePrefilter, normaliseInvoiceNo, parseInvoiceVerdict, pickStage, rankInvoicePdfs } from '../src/lib/mailbox/invoiceDetect.js';

/**
 * The invoice reader's rules (docs/email-po-plan.md §3.10), with no
 * database and no network.
 */

const pdf = (name = 'Invoice CVPL-26-27-0042.pdf') => ({ name, contentType: 'application/pdf' });
const sent = (over = {}) => ({
  direction: 'outbound', subject: 'Invoice for PO 4500012345', text: 'Dear Sir, please find attached our tax invoice for the advance.',
  external: [{ email: 'accounts@acme-steel.co.in' }], attachments: [pdf()], ...over,
});

test('our invoice with a PDF is a candidate; inbound, bulk, a forward or no PDF is not', () => {
  assert.deepEqual(invoicePrefilter(sent()), { candidate: true, reason: null });
  assert.equal(invoicePrefilter(sent({ direction: 'inbound' })).candidate, false, 'a bill we receive is a vendor\'s');
  assert.equal(invoicePrefilter(sent({ attachments: [] })).reason, 'no PDF');
  assert.equal(invoicePrefilter(sent({ subject: 'Fwd: Invoice' })).reason, 'forward');
  assert.equal(invoicePrefilter(sent({ external: [] })).reason, 'no client');
  assert.equal(invoicePrefilter(sent({ external: Array.from({ length: 6 }, (_, i) => ({ email: `a${i}@x.com` })) })).reason, 'too many recipients');
  assert.equal(invoicePrefilter(sent({ subject: 'Report', text: 'Please find the final report.', attachments: [pdf('Report.pdf')] })).reason, 'no invoice words');
  assert.equal(invoicePrefilter(sent(), { decided: true }).reason, 'already decided');
});

test('a proforma is answered by the rules; a credit note goes on to be read', () => {
  assert.equal(invoicePrefilter(sent({ subject: 'Proforma invoice for advance' })).reason, 'proforma');
  assert.equal(invoicePrefilter(sent({ subject: 'PI No 12 for advance', text: 'Please find the PI attached.', attachments: [pdf('PI.pdf')] })).reason, 'proforma');
  assert.equal(invoicePrefilter(sent({ subject: 'Tax invoice against proforma 12' })).candidate, true, 'a tax invoice that mentions its proforma is still one');
  assert.equal(invoicePrefilter(sent({ subject: 'Credit note', text: 'Credit note attached.', attachments: [pdf('CN.pdf')] })).candidate, true);
});

test('the invoice is read first, then the largest', () => {
  const ranked = rankInvoicePdfs([{ name: 'Report.pdf', size: 900, firstPage: 'Final report' }, { name: 'scan.pdf', size: 100, firstPage: 'TAX INVOICE Invoice No CVPL/26-27/0042' }, { name: 'INV-42.pdf', size: 50, firstPage: '' }]);
  assert.deepEqual(ranked.map((f) => f.name), ['INV-42.pdf', 'scan.pdf', 'Report.pdf']);
});

const read = (over = {}) => parseInvoiceVerdict({
  document_type: 'tax_invoice', confidence: 0.93, invoice_no: 'CVPL/26-27/0042', invoice_date: '2026-09-30',
  seller: { company_name: 'Cetizion Verifica Pvt. Ltd.', gstin: '27AAJCC9999K1Z2' }, buyer: { company_name: 'Acme Steel Ltd', gstin: '27AAACX1234A1Z5' },
  po_reference: '4500012345', currency: 'INR', taxable_value: '1,25,000.00', tax_value: '22,500.00', total_value: '1,47,500.00', stage_hint: '50% advance',
  ...over,
});
const TEXT = 'TAX INVOICE CVPL/26-27/0042 Cetizion Verifica Taxable 1,25,000.00 IGST 22,500.00 Total 1,47,500.00';
const opts = { emailDate: '2026-10-01T05:00:00Z', sourceText: TEXT, ourNames: ['Cetizion Verifica Pvt. Ltd.'], ourGstin: '27AAJCC9999K1Z2' };

test('a good tax invoice passes, with its number as printed', () => {
  const r = checkInvoice(read(), opts);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.invoice.invoice_no, 'CVPL/26-27/0042');
  assert.equal(r.invoice.total_value, 147500);
  assert.equal(r.invoice.invoice_no_norm, 'cvpl/2627/0042');
  assert.equal(normaliseInvoiceNo('cvpl / 26-27 / 0042'), 'cvpl/2627/0042');
});

test('what is never recorded automatically', () => {
  assert.equal(checkInvoice(read({ document_type: 'proforma' }), opts).reason, 'not_invoice');
  assert.equal(checkInvoice(read({ document_type: 'other' }), opts).reason, 'not_invoice');
  assert.equal(checkInvoice(read({ document_type: 'credit_note' }), opts).reason, 'credit_note');
  assert.equal(checkInvoice(read({ revised_or_cancelled: true }), opts).reason, 'revised');
  assert.equal(checkInvoice(read({ confidence: 0.8 }), opts).reason, 'low_confidence');
  // A vendor's bill we forwarded: the seller is not us, or the buyer is.
  assert.equal(checkInvoice(read({ seller: { company_name: 'Print Shop', gstin: '27AAAPP1111P1Z1' } }), opts).reason, 'not_from_us');
  assert.equal(checkInvoice(read({ buyer: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, seller: { company_name: 'Cetizion Verifica Pvt. Ltd.' } }), { ...opts, ourGstin: null }).reason, 'not_from_us');
});

test('the figures are checked', () => {
  assert.equal(checkInvoice(read({ invoice_no: null }), opts).reason, 'no_invoice_no');
  assert.equal(checkInvoice(read({ invoice_date: '2026-10-05' }), opts).reason, 'bad_date', 'dated after it was sent');
  assert.equal(checkInvoice(read({ currency: 'JPY' }), opts).reason, 'bad_currency');
  assert.equal(checkInvoice(read({ tax_value: '20,000.00' }), { ...opts, sourceText: `${TEXT} 20,000.00` }).reason, 'totals_do_not_add_up');
  assert.equal(checkInvoice(read({ taxable_value: null, tax_value: null, total_value: '2,47,500.00' }), opts).reason, 'amounts_not_in_pdf');
  assert.equal(checkInvoice(read({ taxable_value: null, tax_value: null, total_value: '2,47,500.00' }), { ...opts, sourceText: null }).ok, true, 'a scan: taken as read');
});

test('parseInvoiceVerdict refuses junk', () => {
  for (const junk of ['nope', null, [], 7]) assert.deepEqual([parseInvoiceVerdict(junk).document_type, parseInvoiceVerdict(junk).confidence], ['other', 0]);
  assert.equal(parseInvoiceVerdict({ document_type: 'receipt' }).document_type, 'other');
});

const stage = (no, amount, over = {}) => ({ id: no * 10, stage_no: no, stage_name: `Stage ${no}`, trigger_event: no === 1 ? 'On PO Registration' : 'On Delivery', milestone_name: null, stage_amount: amount, invoice_no: null, on_hold: false, ...over });

test('pickStage: the amount must be a stage; equal stages go in order, or by the hint', () => {
  const fiftyFifty = [stage(1, 147500), stage(2, 147500)];
  assert.equal(pickStage(fiftyFifty, 147500).stage.stage_no, 1, 'the lowest open stage');
  assert.equal(pickStage(fiftyFifty, 147500, 'Balance 50%').stage.stage_no, 2, 'the hint names the last');
  assert.equal(pickStage([stage(1, 147500, { invoice_no: 'X' }), stage(2, 147500)], 147500).stage.stage_no, 2, 'an invoiced stage is not open');
  assert.equal(pickStage([stage(1, 147500, { on_hold: true }), stage(2, 147500)], 147500).stage.stage_no, 2, 'nor is one on hold');
  assert.equal(pickStage(fiftyFifty, 147501).stage.stage_no, 1, 'a rupee of rounding');
  assert.equal(pickStage(fiftyFifty, 118000).reason, 'amount_not_a_stage', '40% of a 50/50 PO');
  assert.equal(pickStage(fiftyFifty, 295000).reason, 'amount_not_a_stage', 'two stages in one invoice');
  assert.equal(pickStage([], 147500).reason, 'po_without_stages');
  const milestones = [stage(1, 88500), stage(2, 118000, { trigger_event: 'On Milestone', milestone_name: 'Draft report' }), stage(3, 88500)];
  assert.equal(pickStage(milestones, 88500, 'Final').stage.stage_no, 3);
  assert.equal(pickStage(milestones, 118000, 'On draft report').stage.stage_no, 2);
});
