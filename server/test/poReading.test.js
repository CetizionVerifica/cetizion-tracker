import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { buildPoPrompt, parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkPo } from '../src/lib/mailbox/pdfPurchaseOrder.js';

/**
 * The PO prompt and checks (docs/email-po-invoice-prompt-plan.md §3), from
 * the samples: Alembic's "YOUR REF", Hindalco's "Our Contact", Dasami's own
 * quotation number, Aragen's line printed on two rows and its nine pages of
 * T&C, and revision wording.
 */

const prompt = buildPoPrompt({ emailSubject: 'PO', emailText: 'Attached.', receivedAt: '2026-08-04T10:00:00Z', from: { email: 'a@b.com' }, pdfText: 'x' }).system;

describe('what the PO prompt asks', () => {
  test('whose reference is whose: ours from "Your Ref", the client\'s own number in client_reference', () => {
    assert.match(prompt, /"Your Ref", "Your quotation", "Your offer" mean ours; "Our Ref", "Our Contact", "Buyer", "Budget" and a bare "Reference" are the client's own/);
    assert.match(prompt, /YOUR REF: QTN-04\/2026/);
    assert.match(prompt, /client_reference: .*DL26SWR60-1317.*Never put the client's number in our_quotation_ref/);
    assert.match(prompt, /"Our Contact" on the client's order is the client's own person/);
  });

  test('a line on two rows is one line; the terms only from the order\'s own block; charges at actuals to remarks; revision wording', () => {
    assert.match(prompt, /A line printed on two rows .* is one line\. The lines add up to the basic value\./);
    assert.match(prompt, /Never from general terms and conditions or goods boilerplate \(COA, batch, marine policy/);
    assert.match(prompt, /remarks: clauses about charges outside the order value \("travel and stay extra at actuals"\)/);
    assert.match(prompt, /revision_marks: any amendment, revision or supersession wording/);
    assert.match(prompt, /the vendor block as printed, its name and GSTIN/);
  });

  test('the new fields are read in their fixed shape', () => {
    const v = parsePoVerdict({ is_purchase_order: true, client_reference: ' DL26SWR60-1317 ', revision_marks: 'null', remarks: 'Travel extra at actuals' });
    assert.deepEqual([v.client_reference, v.revision_marks, v.remarks], ['DL26SWR60-1317', null, 'Travel extra at actuals']);
    const empty = parsePoVerdict('not json');
    assert.deepEqual([empty.client_reference, empty.revision_marks, empty.remarks], [null, null, null]);
  });
});

// Aragen's PO: one service, printed as a description row and a code row with the same ₹2,50,000.
const ARAGEN_TEXT = 'PURCHASE ORDER 9010018889 03.08.2026 1 EcoVadis Assessment 1 2,50,000.00 SAC 998311 1 2,50,000.00 Basic 2,50,000.00 IGST 45,000.00 Total 2,95,000.00 Payment Terms: Invoice Date, 45 days';
const aragen = (over = {}) => parsePoVerdict({
  is_purchase_order: true, document_type: 'purchase_order', confidence: 0.9, po_number: '9010018889', po_date: '2026-08-03', amendment_no: 0,
  buyer: { company_name: 'Aragen Life Sciences Ltd' }, vendor: { company_name: 'Cetizion Verifica Pvt Ltd' }, currency: 'INR',
  lines: [{ description: 'EcoVadis Assessment', qty: 1, rate: '2,50,000.00', amount: '2,50,000.00' }, { description: 'SAC 998311', qty: 1, rate: '2,50,000.00', amount: '2,50,000.00' }],
  basic_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00', payment_terms_text: 'Invoice Date, 45 days', credit_days: 45, ...over,
});
const opts = { emailDate: '2026-08-04T05:00:00Z', sourceText: ARAGEN_TEXT, ourNames: ['Cetizion Verifica Pvt Ltd'] };

describe('what the PO checks do with it', () => {
  test('a line read as two rows, adding up to twice the value, is taken as one line', () => {
    const r = checkPo(aragen(), opts);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.po.linesOk, true);
    assert.deepEqual(r.po.lines.map((l) => [l.description, l.amount]), [['EcoVadis Assessment SAC 998311', 250000]]);
    assert.ok(r.flags.includes('two_row_lines_merged'));
    assert.equal(r.po.credit_days, 45);
  });

  test('two real lines of the same amount that add up are kept as two', () => {
    const text = `${ARAGEN_TEXT} Site A 2,50,000.00 Site B 2,50,000.00 Basic 5,00,000.00 IGST 90,000.00 Total 5,90,000.00`;
    const r = checkPo(aragen({ lines: [{ description: 'Site A', qty: 1, amount: '2,50,000.00' }, { description: 'Site B', qty: 1, amount: '2,50,000.00' }], basic_value: '5,00,000.00', tax_value: '90,000.00', total_value: '5,90,000.00' }), { ...opts, sourceText: text });
    assert.equal(r.po.lines.length, 2);
    assert.ok(!r.flags.includes('two_row_lines_merged'));
  });

  test('revision wording printed on the order sends it to review as an amendment, even with amendment_no 0', () => {
    for (const marks of ['Amendment No. 1', 'Rev 2', 'Revised PO', 'Supersedes PO 9010018800']) assert.equal(checkPo(aragen({ revision_marks: marks }), opts).reason, 'amendment', marks);
    assert.equal(checkPo(aragen({ revision_marks: 'Original' }), opts).ok, true);
  });
});
