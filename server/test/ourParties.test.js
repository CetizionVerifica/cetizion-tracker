import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { addressedInText, gstinList, ourParty, panOf, partnersOf } from '../src/lib/mailbox/ourParties.js';
import { checkPo } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { checkInvoice, parseInvoiceVerdict, wrongGstin } from '../src/lib/mailbox/invoiceDetect.js';
import { whoWeAre } from '../src/lib/mailbox/promptRules.js';

/**
 * Our two GSTINs and the partner companies clients also order through
 * (docs/email-po-invoice-prompt-plan.md §1), from the samples it names:
 * Alembic's PO to our UP GSTIN, Aragen's to Delhi, Hindalco's to
 * Innovative CSR Solutions, and our invoice CVPL/2026-27/037 from UP.
 */

const DELHI = '07AAKCC0860B1Z2';
const UP = '09AAKCC0860B1ZY';
const PARTNER = '07AACCI8342L1ZA';
const partners = partnersOf('Innovative CSR Solutions India Pvt. Ltd. | 07AACCI8342L1ZA | Innovative CSR');
const parties = { ourGstins: [DELHI, UP], partners, ourNames: ['Cetizion Verifica Pvt. Ltd.'], internalDomains: ['cetizionverifica.com'] };

describe('who a party is to us', () => {
  test('the settings: our GSTINs with company_gstin first, partners one per line or as JSON', () => {
    assert.equal(panOf(UP), 'AAKCC0860B');
    assert.equal(panOf('not a gstin'), null);
    assert.deepEqual(gstinList(DELHI, `${UP}, ${DELHI}, junk`), [DELHI, UP]);
    assert.deepEqual(gstinList(null, ''), []);
    assert.deepEqual(partners, [{ name: 'Innovative CSR Solutions India Pvt. Ltd.', gstin: PARTNER, aliases: ['Innovative CSR'] }]);
    assert.deepEqual(partnersOf('[{"name":"A Ltd","gstin":"07aaacx1234a1z5","aliases":["A"]}]'), [{ name: 'A Ltd', gstin: '07AAACX1234A1Z5', aliases: ['A'] }]);
    assert.deepEqual(partnersOf('none'), []);
  });

  test('us by any registration of our PAN, a partner by its full GSTIN or its name, anyone else not', () => {
    assert.deepEqual(ourParty({ company_name: 'Cetizion Verifica Pvt Ltd', gstin: UP }, parties), { kind: 'us', gstin: UP, name: 'Cetizion Verifica Pvt Ltd' });
    assert.equal(ourParty({ gstin: '27AAKCC0860B1Z9' }, parties)?.kind, 'us', 'a third state of ours is still us');
    assert.deepEqual(ourParty({ company_name: 'Innovative CSR Solutions India Pvt. Ltd.', gstin: PARTNER }, parties), { kind: 'partner', gstin: PARTNER, name: 'Innovative CSR Solutions India Pvt. Ltd.' });
    assert.equal(ourParty({ company_name: 'INNOVATIVE CSR' }, parties)?.kind, 'partner', 'by another name, with no GSTIN printed');
    assert.equal(ourParty({ company_name: 'Innovative CSR', gstin: '27AACCI8342L1Z9' }, parties), null, "another of the partner's registrations is not the partner");
    assert.equal(ourParty({ company_name: 'Cetizion Verifica', gstin: '27AAACX1234A1Z5' }, parties), null, "a GSTIN that is not ours decides, whatever the name");
    assert.equal(ourParty({ company_name: 'Cetizion Verifica', gstin: '27AAACX1234A1Z5' }, { ...parties, ourGstins: [] })?.kind, 'us', 'with no GSTIN of ours set, the name decides, as before');
    assert.equal(ourParty({ company_name: 'Hindalco Industries Ltd', gstin: '32AAACH1201R1ZW' }, parties), null);
  });

  test('a blank vendor block: our GSTIN or name in the text, else a partner', () => {
    assert.deepEqual(addressedInText(`Vendor GSTIN:  To M/s Cetizion Verifica ... GSTIN ${UP.slice(0, 7)} ${UP.slice(7)}`, parties), { kind: 'us', gstin: UP, name: null });
    assert.deepEqual(addressedInText('Supplier: INNOVATIVE CSR SOLUTIONS', parties), { kind: 'partner', gstin: null, name: 'Innovative CSR Solutions India Pvt. Ltd.' });
    assert.equal(addressedInText('Supplier: Someone Else', parties), null);
  });

  test("the prompt names both GSTINs, the PAN and the partner", () => {
    const line = whoWeAre({ ourNames: ['Cetizion Verifica Pvt. Ltd.'], ourGstins: [DELHI, UP], partners });
    assert.match(line, new RegExp(`GSTIN ${DELHI} or ${UP} \\(one company, registered in more than one state; PAN AAKCC0860B\\)`));
    assert.match(line, /through our partner "Innovative CSR Solutions India Pvt\. Ltd\." \(GSTIN 07AACCI8342L1ZA\): an order addressed to one of them is an order to us/);
    assert.match(whoWeAre({ ourGstin: DELHI }), /GSTIN 07AAKCC0860B1Z2\./, 'one GSTIN reads as before');
  });
});

const po = (over = {}) => parsePoVerdict({
  is_purchase_order: true, document_type: 'purchase_order', confidence: 0.92, po_number: '3700101318', po_date: '2026-05-20', amendment_no: 0,
  buyer: { company_name: 'Alembic Pharmaceuticals Ltd', gstin: '24AABCA1234B1Z5' }, vendor: { company_name: 'Cetizion Verifica Pvt Ltd', gstin: UP },
  currency: 'INR', lines: [{ description: 'EcoVadis assessment', qty: 1, rate: '500,000.000', amount: '500,000.000' }],
  basic_value: '500,000.000', tax_value: '90,000.000', total_value: '590,000.000', payment_terms_text: 'Against delivery', credit_days: 30, ...over,
});
const PO_TEXT = 'PURCHASE ORDER 3700101318 Vendor Cetizion Verifica Basic 500,000.000 IGST 90,000.000 Total 590,000.000';
const poOpts = { emailDate: '2026-05-21T05:00:00Z', sourceText: PO_TEXT, ...parties };

describe('a PO addressed to our UP GSTIN, or to our partner', () => {
  test('to our UP GSTIN while company_gstin is Delhi: ours, with the GSTIN it was addressed to', () => {
    const r = checkPo(po(), { ...poOpts, ourGstin: DELHI });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.po.addressed_gstin, UP);
    assert.equal(r.po.partner_name, null);
  });

  test('to Innovative CSR Solutions (Hindalco): ours, marked as through the partner', () => {
    const r = checkPo(po({ buyer: { company_name: 'Hindalco Industries Limited', gstin: '32AAACH1201R1ZW' }, vendor: { company_name: 'Innovative CSR Solutions India Pvt. Ltd.', gstin: PARTNER } }), poOpts);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.po.partner_name, 'Innovative CSR Solutions India Pvt. Ltd.');
    assert.equal(r.po.addressed_gstin, PARTNER);
  });

  test('before this change only the one GSTIN in company_gstin was us; a PO to anyone else is still not ours', () => {
    assert.equal(checkPo(po(), { ...poOpts, ourGstins: [DELHI], partners: [] }).ok, true, 'our PAN, so ours even with one GSTIN set');
    assert.equal(checkPo(po({ vendor: { company_name: 'Other Consulting', gstin: '07AAACO1111A1Z1' } }), poOpts).reason, 'not_to_us');
    assert.equal(checkPo(po({ buyer: { company_name: 'Cetizion Verifica', gstin: DELHI }, vendor: { company_name: 'A Vendor', gstin: '07AAACV2222A1Z1' } }), poOpts).reason, 'not_to_us', 'a PO we issued');
  });
});

const invoice = (over = {}) => parseInvoiceVerdict({
  document_type: 'tax_invoice', confidence: 0.93, invoice_no: 'CVPL/2026-27/037', invoice_date: '2026-05-22',
  seller: { company_name: 'Cetizion Verifica Pvt. Ltd.', gstin: UP }, buyer: { company_name: 'Alembic Pharmaceuticals Ltd', gstin: '24AABCA1234B1Z5' },
  po_reference: '3700101318', currency: 'INR', taxable_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00', stage_hint: '50% Advance Payment As Per P.O.',
  ...over,
});
const INV_TEXT = 'TAX INVOICE CVPL/2026-27/037 Taxable 2,50,000.00 IGST 45,000.00 Total 2,95,000.00';
const invOpts = { emailDate: '2026-05-22T09:00:00Z', sourceText: INV_TEXT, ...parties, ourGstin: DELHI };

describe('our invoice, from either registration', () => {
  test('raised from UP while company_gstin is Delhi: ours, and it says which GSTIN', () => {
    const r = checkInvoice(invoice(), invOpts);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.invoice.issuing_gstin, UP);
    assert.equal(r.invoice.through_partner, null);
  });

  test("the partner's invoice for a partner PO is accepted as through the partner", () => {
    const r = checkInvoice(invoice({ seller: { company_name: 'Innovative CSR Solutions India Pvt. Ltd.', gstin: PARTNER } }), invOpts);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.invoice.through_partner, 'Innovative CSR Solutions India Pvt. Ltd.');
  });

  test('a bill to us is still not ours', () => {
    assert.equal(checkInvoice(invoice({ seller: { company_name: 'A Vendor', gstin: '07AAACV2222A1Z1' }, buyer: { company_name: 'Cetizion Verifica', gstin: DELHI } }), invOpts).reason, 'not_from_us');
  });

  test('wrong_gstin: raised from another registration than the PO was addressed to; unknown on either side passes', () => {
    const fromUp = checkInvoice(invoice(), invOpts).invoice;
    assert.equal(wrongGstin(fromUp, { addressed_gstin: DELHI }), true);
    assert.equal(wrongGstin(fromUp, { addressed_gstin: UP }), false);
    assert.equal(wrongGstin(fromUp, { addressed_gstin: null }), false, 'a PO typed in by hand names no GSTIN');
    assert.equal(wrongGstin({ ...fromUp, issuing_gstin: null }, { addressed_gstin: DELHI }), false);
  });
});
