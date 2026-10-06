import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { aiConfig, chatJSON, readsPdf } from '../src/lib/ai.js';
import { gstinValid } from '../src/lib/mailbox/ourParties.js';
import { ratePercent, taxAgreesWithRate } from '../src/lib/mailbox/promptRules.js';
import { checkPo, stagesFor } from '../src/lib/mailbox/pdfPurchaseOrder.js';
import { INVOICE_SCHEMA, checkInvoice, parseInvoiceVerdict } from '../src/lib/mailbox/invoiceDetect.js';
import { PO_SCHEMA, parsePoVerdict } from '../src/lib/mailbox/poDetect.js';
import { disagreeNote, fieldsDiffer } from '../src/lib/mailbox/readAttachment.js';

/**
 * The pure parts of docs/email-auto-entry-plan.md: the GSTIN check
 * character, the arithmetic and rate checks, the stages a PO takes from
 * its quotation, two readings compared, the strict answer shapes and the
 * request chatJSON sends. The readers end to end are in emailInvoices and
 * emailPurchaseOrders.
 */

const UP = '09AAKCC0860B1ZY';
const DELHI = '07AAKCC0860B1Z2';

describe('a GSTIN that can exist (§3.7)', () => {
  test('the four sample documents\' GSTINs check out; one character off does not', () => {
    for (const g of [UP, DELHI, '24AAICA5591M1Z9', '36AABCG3208J1ZT']) assert.equal(gstinValid(g), true, g);
    assert.equal(gstinValid('09AAKCC0860B1ZX'), false, 'the check character');
    assert.equal(gstinValid('09AAKCC0860B1ZV'), false);
    assert.equal(gstinValid('24AAICA5591M1Z8'), false);
    assert.equal(gstinValid('24AAICA5951M1Z9'), false, 'two digits swapped');
  });

  test('spacing and case do not matter; a wrong shape is refused', () => {
    assert.equal(gstinValid('09 aakcc 0860 b1zy'), true);
    assert.equal(gstinValid('09AAKCC0860B1Y'), false, 'fourteen characters');
    assert.equal(gstinValid('09AAKCC0860B1XY'), false, 'no Z in the 14th place');
    assert.equal(gstinValid(''), false);
    assert.equal(gstinValid(null), false);
  });
});

describe('the arithmetic of an image PDF (§3.7)', () => {
  test('taxable × rate = tax to the rupee', () => {
    assert.equal(taxAgreesWithRate(500000, 90000, 18), true);
    assert.equal(taxAgreesWithRate(250000, 45000, 18), true);
    assert.equal(taxAgreesWithRate(240000, 43200, 18), true, 'Aragen 074');
    assert.equal(taxAgreesWithRate(240000, 43200.9, 18), true, 'within a rupee');
    assert.equal(taxAgreesWithRate(250000, 54000, 18), false, 'a misread digit');
    assert.equal(taxAgreesWithRate(250000, 45000, null), true, 'no single rate printed: nothing to check');
  });

  test('a rate as the model gives it', () => {
    assert.equal(ratePercent('18%'), 18);
    assert.equal(ratePercent(18), 18);
    assert.equal(ratePercent('IGST @ 18 %'), 18);
    assert.equal(ratePercent('0'), null);
    assert.equal(ratePercent(118), null);
    assert.equal(ratePercent(null), null);
  });

  const invoice = (over = {}) => parseInvoiceVerdict({
    document_type: 'tax_invoice', confidence: 0.95, revised_or_cancelled: false, invoice_no: 'CVPL/2026-27/037', invoice_date: '2026-05-22',
    seller: { company_name: 'Cetizion Verifica Pvt. Ltd.', gstin: UP }, buyer: { company_name: 'Alembic Pharmaceuticals Limited', gstin: '24AAICA5591M1Z9' },
    po_reference: '3700101318', po_date: '2026-05-20', currency: 'INR', taxable_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00',
    tax_breakup: { igst: '45,000.00', cgst: null, sgst: null }, tax_rate_percent: 18, total_in_words: 'Rupees Two Lakh Ninety Five Thousand Only', stage_hint: '50% Advance Payment',
    ...over,
  });
  const opts = { emailDate: '2026-05-23T06:00:00Z', ourGstins: [DELHI, UP], sourceText: null };

  test('Alembic 037 read off its image: recorded on its own arithmetic', () => {
    const r = checkInvoice(invoice(), opts);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.invoice.issuing_gstin, UP);
  });

  test('a misread GSTIN, or a tax that is not the rate of the value, goes to review', () => {
    assert.equal(checkInvoice(invoice({ buyer: { company_name: 'Alembic', gstin: '24AAICA5591M1Z8' } }), opts).reason, 'bad_gstin');
    assert.equal(checkInvoice(invoice({ seller: { company_name: 'Cetizion Verifica', gstin: '09AAKCC0860B1ZX' } }), opts).reason, 'bad_gstin', 'our PAN, its last character misread');
    assert.equal(checkInvoice(invoice({ tax_rate_percent: 12 }), opts).reason, 'totals_do_not_add_up');
  });

  const po = (over = {}) => parsePoVerdict({
    is_purchase_order: true, document_type: 'purchase_order', confidence: 0.95, po_number: '9010018889', po_date: '2026-08-03', amendment_no: 0,
    buyer: { company_name: 'Aragen Life Sciences Limited', gstin: '36AABCG3208J1ZT' }, vendor: { company_name: 'Cetizion Verifica Pvt. Ltd.', gstin: DELHI, vendor_code: null },
    currency: 'INR', lines: [{ description: 'EcoVadis', qty: 1, rate: '2,50,000.00', amount: '2,50,000.00' }],
    basic_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00', gst_extra: false, tax_breakup: { igst: '45,000.00' }, tax_rate_percent: 18,
    payment_terms_text: 'Invoice Date, 45 days', credit_days: 45, validity_end: '2027-07-30',
    ...over,
  });

  test('a PO: a misread buyer GSTIN goes to review before it can find or make the wrong company', () => {
    const o = { emailDate: '2026-08-05T06:00:00Z', ourGstins: [DELHI, UP], sourceText: null };
    assert.equal(checkPo(po(), o).ok, true);
    assert.equal(checkPo(po(), o).po.validity_end, '2027-07-30');
    assert.equal(checkPo(po({ buyer: { company_name: 'Aragen', gstin: '36AABCG3208J1ZU' } }), o).reason, 'bad_gstin');
    assert.equal(checkPo(po({ tax_rate_percent: 5 }), o).reason, 'totals_do_not_add_up');
    assert.equal(checkPo(po({ vendor: { company_name: 'Cetizion Verifica', gstin: DELHI, vendor_code: '0011305984' } }), o).po.client_vendor_code, '0011305984');
  });
});

describe('stages when the PO names only a trigger (§3.6)', () => {
  const quotation = '50% advance against PO, 50% on submission of the final report';

  test('"Against delivery" or nothing: the quotation\'s split', () => {
    for (const terms of ['Against delivery', 'Invoice Date, 45 days', null]) {
      const s = stagesFor(terms, quotation);
      assert.equal(s.source, 'quotation_terms', String(terms));
      assert.deepEqual(s.stages.map((x) => x.percent), [50, 50]);
      assert.equal(s.stages[0].trigger_event, 'On PO Registration');
    }
  });

  test('a PO with its own split keeps it; a quotation without one changes nothing', () => {
    assert.deepEqual(stagesFor('30% advance, 70% on completion', quotation).stages.map((x) => x.percent), [30, 70]);
    assert.equal(stagesFor('30% advance, 70% on completion', quotation).source, 'po_terms');
    assert.equal(stagesFor('Against delivery', 'Payment within 30 days').source, 'po_terms', 'all on delivery, as before');
    assert.equal(stagesFor(null, null).source, 'template');
    assert.equal(stagesFor('GST 18% extra', quotation).source, 'quotation_terms', 'a tax percentage is not a split');
  });
});

describe('two readings of one image PDF (§3.7)', () => {
  test('numbers as letters and digits, amounts to the rupee', () => {
    const a = { invoice_no: 'CVPL/2026-27/037', invoice_date: '2026-05-22', po_reference: '3700101318', total_value: 295000 };
    assert.deepEqual(fieldsDiffer(a, { ...a, invoice_no: 'CVPL 2026-27 037', total_value: 295000.4 }, Object.keys(a)), []);
    assert.deepEqual(fieldsDiffer(a, { ...a, total_value: 259000, po_reference: '3700101381' }, Object.keys(a)), ['po_reference', 'total_value']);
    assert.deepEqual(fieldsDiffer({ po_reference: null }, { po_reference: null }, ['po_reference']), []);
    assert.deepEqual(fieldsDiffer({ po_reference: null }, { po_reference: '3700101318' }, ['po_reference']), ['po_reference']);
  });

  test('the review note names the fields, never their values', () => {
    assert.equal(disagreeNote(['invoice_no', 'total_value']), 'The PDF is an image, so it was read twice; the readings differ on the invoice number, the total.');
  });
});

describe('the answer\'s shape (§3.5)', () => {
  const strict = (schema, path = '') => {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: every key required`);
      assert.equal(schema.additionalProperties, false, `${path}: nothing extra`);
      for (const [k, v] of Object.entries(schema.properties)) strict(v, `${path}.${k}`);
    }
    if (schema.type === 'array') strict(schema.items, `${path}[]`);
  };

  test('every object in the PO and invoice schemas is strict', () => {
    strict(PO_SCHEMA.schema, 'po');
    strict(INVOICE_SCHEMA.schema, 'invoice');
    assert.ok(PO_SCHEMA.schema.properties.vendor.properties.vendor_code);
    assert.ok(INVOICE_SCHEMA.schema.properties.tax_rate_percent);
  });

  test('the parsers keep the new fields, and junk stays junk', () => {
    assert.equal(parsePoVerdict({ is_purchase_order: true, vendor: { vendor_code: ' 0011305984 ' }, validity_end: '2027-07-30' }).vendor.vendor_code, '0011305984');
    assert.equal(parsePoVerdict({ validity_end: '30.07.2027' }).validity_end, null);
    assert.equal(parsePoVerdict('not json').validity_end, null);
    assert.equal(parseInvoiceVerdict(null).tax_rate_percent, null);
  });
});

describe('the request (§3.1, §3.5, §4)', () => {
  const sent = async (opts) => {
    const real = globalThis.fetch;
    let body;
    globalThis.fetch = async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ model: 'anthropic/claude-opus-5.5', choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) }; };
    try {
      const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, provider: null, model: null };
      const answer = await chatJSON('system', 'user', { ...opts, usage });
      return { body, answer, usage };
    } finally {
      globalThis.fetch = real;
    }
  };

  test('the reader with its fallbacks, zero retention always; the model that answered is recorded', async () => {
    const { body, answer, usage } = await sent({});
    assert.equal(body.model, aiConfig.model);
    if (aiConfig.fallbacks.some((m) => m !== aiConfig.model)) assert.deepEqual(body.models, [...new Set([aiConfig.model, ...aiConfig.fallbacks])]);
    assert.deepEqual(body.provider, { data_collection: 'deny', zdr: true });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(answer, { ok: true });
    assert.equal(usage.model, 'anthropic/claude-opus-5.5');
  });

  test('a schema makes it strict; a named model goes alone', async () => {
    const { body } = await sent({ schema: INVOICE_SCHEMA, model: 'anthropic/claude-sonnet-5.5' });
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.name, 'invoice_reading');
    assert.equal(body.model, 'anthropic/claude-sonnet-5.5');
    assert.equal(body.models, undefined, 'the second reader is never swapped for another model');
    assert.deepEqual(body.provider, { data_collection: 'deny', zdr: true });
  });

  test('which models are sent the PDF itself', () => {
    const was = process.env.OPENROUTER_READS_PDF;
    delete process.env.OPENROUTER_READS_PDF;
    try {
      assert.equal(readsPdf('anthropic/claude-fable-5.1'), true);
      assert.equal(readsPdf('openai/gpt-6.1-sol'), true);
      assert.equal(readsPdf('deepseek/deepseek-v4.1-flash'), false, 'text only: the text layer, and OCR for a scan');
      process.env.OPENROUTER_READS_PDF = '0';
      assert.equal(readsPdf('anthropic/claude-fable-5.1'), false, 'the override');
    } finally {
      if (was === undefined) delete process.env.OPENROUTER_READS_PDF; else process.env.OPENROUTER_READS_PDF = was;
    }
  });
});

describe('triage (§3.8)', async () => {
  const { buildTriagePrompt, notFor, parseTriage, TRIAGE_BAR } = await import('../src/lib/mailbox/triage.js');

  test('each reader skips only what triage surely says is not its own', () => {
    const sure = (label) => ({ label, confidence: 0.95 });
    assert.equal(notFor('po', sure('enquiry')), true);
    assert.equal(notFor('po', sure('client_po')), false);
    assert.equal(notFor('po', sure('po_change')), false, 'an amendment is the PO reader\'s');
    assert.equal(notFor('invoice', sure('quotation_sent')), true);
    assert.equal(notFor('invoice', sure('our_invoice')), false);
    assert.equal(notFor('enquiry', sure('other')), true, 'a newsletter');
    assert.equal(notFor('enquiry', sure('payment_advice')), true);
    assert.equal(notFor('enquiry', sure('client_po')), false, 'an RFQ the PO reader turned down still gets read');
    assert.equal(notFor('po', { label: 'other', confidence: TRIAGE_BAR - 0.01 }), false, 'unsure skips nothing');
    assert.equal(notFor('po', null), false, 'no triage skips nothing');
  });

  test('a malformed answer skips nothing', () => {
    assert.deepEqual(parseTriage({ label: 'client_po', confidence: 0.9 }), { label: 'client_po', confidence: 0.9 });
    assert.deepEqual(parseTriage({ label: 'invoice', confidence: 0.99 }), { label: 'other', confidence: 0 });
    assert.deepEqual(parseTriage('nonsense'), { label: 'other', confidence: 0 });
    assert.equal(notFor('enquiry', parseTriage(null)), false);
  });

  test('it sees the subject, the new text and the attachments\' names, not the attachments', () => {
    const { user } = buildTriagePrompt({ direction: 'outbound', subject: 'Invoice CVPL/2026-27/037', text: 'Please find attached.', from: { email: 'a@cetizionverifica.com' }, to: [{ email: 'ap@client.in' }], attachments: ['Alembic_037.pdf'] });
    assert.match(user, /sent by us/);
    assert.match(user, /Attachments: Alembic_037\.pdf/);
  });
});
