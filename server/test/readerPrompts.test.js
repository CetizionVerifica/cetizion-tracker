import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt } from '../src/lib/mailbox/enquiryDetect.js';
import { buildPoPrompt } from '../src/lib/mailbox/poDetect.js';
import { buildInvoicePrompt } from '../src/lib/mailbox/invoiceDetect.js';
import { extractionPrompt } from '../src/lib/mailbox/pdfQuotation.js';
import { READING_RULES, serviceRule, whoWeAre } from '../src/lib/mailbox/promptRules.js';

/**
 * What the email readers ask the AI (promptRules.js): every reader is told
 * who we are and how Indian documents are read, and the ones that create a
 * service-bearing record are given the catalogue to spell services from.
 */

const services = ['Ecovadis Assessment (consulting)', 'ISO audits', 'CBAM verification'];
const us = { ourNames: ['Cetizion Verifica Private Limited'], ourGstin: '27AAACC1234F1Z5' };

const prompts = {
  enquiry: buildPrompt({ direction: 'inbound', subject: 'Quote', text: 'Please quote', from: { email: 'a@acme.in' } }, { services, ...us }).system,
  po: buildPoPrompt({ pdfText: 'PO', emailSubject: 'PO', emailText: '', receivedAt: '2026-10-01', from: { email: 'a@acme.in' }, services, ...us }).system,
  invoice: buildInvoicePrompt({ pdfText: 'INVOICE', emailSubject: 'Invoice', emailText: '', sentAt: '2026-10-01', ...us }).system,
  quotation: extractionPrompt({ pdfText: 'QUOTATION', emailSubject: 'Quotation', emailText: '', sentAt: '2026-10-01', services, ourNames: us.ourNames }).system,
};

test('every reader is told who we are, so our letterhead is never the client', () => {
  for (const [name, system] of Object.entries(prompts)) {
    assert.match(system, /Cetizion Verifica Private Limited/, name);
    assert.match(system, /never the client's/, name);
  }
  for (const name of ['enquiry', 'po', 'invoice']) assert.match(prompts[name], /GSTIN 27AAACC1234F1Z5/, name);
  assert.doesNotMatch(whoWeAre(), /GSTIN \d/);
});

test('the document readers read Indian dates day first and copy amounts as printed', () => {
  for (const name of ['po', 'invoice', 'quotation']) {
    for (const rule of READING_RULES) assert.ok(prompts[name].includes(rule), `${name}: ${rule.slice(0, 30)}`);
    assert.match(prompts[name], /3 October 2026, never 10 March/, name);
    assert.match(prompts[name], /confidence: .*does not lower confidence/, name);
  }
});

test('services are spelt from the catalogue wherever a record carries one', () => {
  for (const name of ['enquiry', 'po', 'quotation']) {
    for (const s of services) assert.ok(prompts[name].includes(`"${s}"`), `${name}: ${s}`);
  }
  // No catalogue: the enquiry falls back on the report's service lines.
  const bare = buildPrompt({ direction: 'inbound', subject: '', text: '', from: { email: 'a@b.in' } }).system;
  assert.match(bare, /"EcoVadis"/);
  assert.equal(serviceRule([]), "service: the service in the document's own words, else null.");
});

test('the PO prompt asks for what registration needs in one reading', () => {
  assert.match(prompts.po, /payment terms copied word for word, every percentage and milestone/);
  assert.match(prompts.po, /Never a GST, tax, subtotal, round-off or grand-total row/);
  assert.match(prompts.po, /"Net 45" give 45/);
  assert.match(prompts.po, /BUYER is the client/);
});

test('the quotation prompt keeps the revision out of the number', () => {
  assert.match(prompts.quotation, /"CTZ\/QT\/2026\/014 Rev 1" gives "CTZ\/QT\/2026\/014" and revision 1/);
});

test('the enquiry prompt describes every kind it may answer with', () => {
  for (const kind of ['new_enquiry', 'quotation_sent', 'purchase_order', 'reply_or_followup', 'billing', 'vendor_or_sales_pitch', 'marketing', 'job_application', 'spam', 'other']) {
    assert.match(prompts.enquiry, new RegExp(`(- |\\. )${kind}:`), kind);
  }
  assert.match(prompts.enquiry, /plain number without commas/);
});
