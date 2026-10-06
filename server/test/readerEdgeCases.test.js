import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { addressedInText, ourParty, partnersOf } from '../src/lib/mailbox/ourParties.js';
import { wordsToAmount } from '../src/lib/mailbox/promptRules.js';
import { parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkPo, stagesFromTerms } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { checkInvoice, parseInvoiceVerdict, splitFor, wrongGstin } from '../src/lib/mailbox/invoiceDetect.js';
import { fitsPattern, pickProfile } from '../src/lib/mailbox/documentProfiles.js';
import { changedFrom, heldForReview } from '../src/lib/mailbox/autoPurchaseOrder.js';

/**
 * The PO and invoice readers (docs/email-po-invoice-prompt-plan.md) at their
 * edges: originals marked revision 0, words written every way an Indian
 * document writes them, GSTINs typed with spaces, messy settings.
 */

const DELHI = '07AAKCC0860B1Z2';
const UP = '09AAKCC0860B1ZY';
const parties = { ourGstins: [DELHI, UP], partners: partnersOf('Innovative CSR Solutions India Pvt. Ltd. | 07AACCI8342L1ZA'), ourNames: ['Cetizion Verifica Pvt Ltd'], internalDomains: ['cetizionverifica.com'] };
const TEXT = 'PURCHASE ORDER 4500012345 Basic 2,50,000.00 IGST 45,000.00 Total 2,95,000.00';
const po = (over = {}) => parsePoVerdict({
  is_purchase_order: true, document_type: 'purchase_order', confidence: 0.9, po_number: '4500012345', po_date: '2026-09-22', amendment_no: 0,
  buyer: { company_name: 'Acme Ltd' }, vendor: { company_name: 'Cetizion Verifica Pvt Ltd' }, currency: 'INR',
  lines: [{ description: 'EcoVadis', qty: 1, amount: '2,50,000.00' }], basic_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00', ...over,
});
const poOpts = { emailDate: '2026-09-23T05:00:00Z', sourceText: TEXT, ...parties };

describe('revision wording', () => {
  test('revision 0 is the original, not an amendment', () => {
    for (const marks of ['Rev 0', 'Rev. 00', 'Revision No. 0', 'Revision: 00', 'R0', 'Original', 'Revision history: none',
      'Amendment No. 0', 'Amendment No.: 00', 'AMENDMENT NO - 0', 'Amendment No: 0 Amendment Date: 23.09.2026']) {
      assert.equal(checkPo(po({ revision_marks: marks }), poOpts).ok, true, marks);
    }
  });

  test('a later revision or amendment is', () => {
    for (const marks of ['Rev 1', 'Rev. 01', 'Revision No. 2', 'Revision: 3', 'R2', 'Revised PO', 'Amendment No. 1', 'Amendment No.: 01', 'Amendment 10', 'Amendment', 'AMENDED', 'Supersedes PO 4500012300', 'In lieu of PO 4500012300']) {
      assert.equal(checkPo(po({ revision_marks: marks }), poOpts).reason, 'amendment', marks);
    }
  });
});

describe('amounts in words, every way they are written', () => {
  test('paise before or after their figure, plural scales, hundreds', () => {
    assert.equal(wordsToAmount('Rupees Ninety Thousand Nine Hundred Ninety Nine and Ninety Nine Paise Only'), 90999.99);
    assert.equal(wordsToAmount('Rupees Twenty Five Thousand and Paise Fifty Only'), 25000.5);
    assert.equal(wordsToAmount('Paise Fifty Only'), 0.5);
    assert.equal(wordsToAmount('Two Thousands Five Hundreds'), 2500);
    assert.equal(wordsToAmount('Rupees One Crore Twenty Lakh Fifty Thousand Only'), 12050000);
    assert.equal(wordsToAmount('INR Two Lakhs Ninety-Five Thousand Rupees Only'), 295000);
  });

  test('anything it cannot be sure of is left alone', () => {
    for (const w of ['Rupees Ninety Five Thousand Paise', 'Paise Thousand', 'Rupees Two Hundred Paise Fifty Thousand', 'USD Ten Thousand Only', '', 'Rupees Only']) {
      assert.equal(wordsToAmount(w), null, w);
    }
    assert.equal(checkPo(po({ total_in_words: 'USD Ten Thousand Only' }), poOpts).ok, true, 'a line it cannot read never refuses a PO');
  });
});

describe('who is who, with messy input', () => {
  test('a GSTIN typed in lower case, with spaces and dashes, is still ours', () => {
    assert.equal(ourParty({ gstin: ' 09-aakcc 0860b1zy ' }, parties)?.kind, 'us');
    assert.equal(ourParty(null, parties), null);
    assert.equal(ourParty({}, parties), null);
    assert.equal(wrongGstin({ issuing_gstin: '09aakcc0860b1zy' }, { addressed_gstin: UP }), false, 'compared as GSTINs, not as text');
  });

  test('partner settings with blank lines, stray bars and empty aliases', () => {
    assert.deepEqual(partnersOf('\n  | 07AAA \n Partner X |  | alias1, ,alias2 \n'), [{ name: 'Partner X', gstin: null, aliases: ['alias1', 'alias2'] }]);
    assert.deepEqual(partnersOf('[not json'), []);
  });

  test('a blank vendor block with only the partner\'s GSTIN in the text is the partner', () => {
    assert.deepEqual(addressedInText('Supplier GSTIN 07AACCI 8342L1ZA', parties), { kind: 'partner', gstin: '07AACCI8342L1ZA', name: 'Innovative CSR Solutions India Pvt. Ltd.' });
    const r = checkPo(po({ vendor: {} }), { ...poOpts, sourceText: `${TEXT} Supplier GSTIN 07AACCI8342L1ZA` });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.po.partner_name, 'Innovative CSR Solutions India Pvt. Ltd.');
  });

  test('our invoice to the partner itself is ours', () => {
    const inv = parseInvoiceVerdict({
      document_type: 'tax_invoice', confidence: 0.9, invoice_no: 'CVPL/2026-27/050', invoice_date: '2026-09-30',
      seller: { company_name: 'Cetizion Verifica Pvt Ltd', gstin: DELHI }, buyer: { company_name: 'Innovative CSR Solutions India Pvt. Ltd.', gstin: '07AACCI8342L1ZA' },
      taxable_value: '1,00,000.00', tax_value: '18,000.00', total_value: '1,18,000.00',
    });
    assert.equal(checkInvoice(inv, { emailDate: '2026-10-01T05:00:00Z', sourceText: 'CVPL/2026-27/050 1,00,000.00 18,000.00 1,18,000.00', ...parties }).ok, true);
  });
});

describe('split, patterns, profiles and the rollout list, at their edges', () => {
  const stage = { id: 1, stage_no: 1, stage_name: 'On delivery (100%)', stage_percent: 1, stage_amount: 300000, invoice_no: null, on_hold: false };

  test('a share with decimals, or written with a space before the %', () => {
    const s = splitFor([stage], { total_value: 99990, stage_hint: '33.33% advance' });
    assert.deepEqual([s.percent, s.stage_name], [33.33, 'Advance (33.33%)']);
    assert.equal(splitFor([stage], { total_value: 150000, stage_hint: 'Advance 50 %' })?.percent, 50);
    assert.equal(splitFor([{ ...stage, on_hold: true }], { total_value: 150000, stage_hint: '50% advance' }), null, 'a stage on hold is not split');
  });

  test('a PO number with spaces around it still fits its pattern; a profile with no domains is fine', () => {
    assert.equal(fitsPattern({ po_number_pattern: '^37\\d{8}$' }, ' 3700101318 '), true);
    assert.equal(pickProfile([{ id: 1, company_id: 5, sender_domains: null, company_gstin: null }], { senderEmail: 'a@b.com', companyId: 5 })?.id, 1);
  });

  test('a client turned back on matches however its name is spelt', () => {
    const settings = { reviewOnly: true, autoClients: ['Bluepeak Textiles Pvt. Ltd.'] };
    assert.equal(heldForReview(settings, 'Bluepeak Textiles Private Limited'), false);
    assert.equal(heldForReview(settings, 'Another Client Ltd'), true);
    assert.equal(heldForReview(settings, null), true, 'no name: held');
    assert.equal(heldForReview({ reviewOnly: false, autoClients: [] }, 'Anyone'), false);
  });

  test('payment terms joined with "&", "and" or new lines', () => {
    for (const t of ['50% advance & 50% on delivery', '50% advance and 50% on delivery', '50% advance\n50% on completion of the report']) {
      assert.deepEqual(stagesFromTerms(t).stages?.map((s) => s.percent), [50, 50], t);
    }
  });
});

describe('a PO read again', () => {
  const registered = (qLines) => ({ query: async () => ({ rows: [{ po_value: 105000, currency: 'INR', values: [105000], lines_from_po: false, q_lines: qLines }] }) });
  test("with only its basic value is grossed up at the quotation's GST rate, as it was registered", async () => {
    const po = { basic_value: 100000, total_value: null, lines: [], linesOk: false };
    assert.equal(await changedFrom(registered([{ amount: 100000, gst_rate: 5 }]), 'PO-5', po), null, 'the same 5% PO again');
    assert.match(await changedFrom(registered([{ amount: 100000, gst_rate: 5 }]), 'PO-5', { ...po, basic_value: 120000 }), /This email: INR 1,26,000/);
    assert.equal(await changedFrom(registered(null), 'PO-5', { ...po, basic_value: 88983.05 }), null, 'no quotation lines: 18%');
  });
});
