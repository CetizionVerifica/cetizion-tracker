import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RULES_BAR, buildPrompt, companyNameFromEmail, isUs, looksLikeQuotation, parseVerdict, prefilter, ruleScore, rulesVerdict,
} from '../src/lib/mailbox/enquiryDetect.js';

/**
 * The enquiry detector's rules (docs/email-enquiries-plan.md §3.2, §3.3,
 * §3.8), with no database and no network.
 */

const inbound = (over = {}) => ({ direction: 'inbound', subject: 'Request for quotation: EcoVadis assessment', text: 'Dear team, we are interested in EcoVadis certification for our plant. Please share your proposal and fee.', from: { email: 'ravi@acme-steel.co.in', name: 'Ravi Kumar' }, external: [{ email: 'ravi@acme-steel.co.in' }], ...over });
const first = { firstInConversation: true };

test('a genuine RFQ is a candidate', () => {
  assert.deepEqual(prefilter(inbound(), first), { candidate: 'inbound', reason: null });
});

test('a reply in a known thread is not', () => {
  assert.equal(prefilter(inbound(), { firstInConversation: false }).candidate, null);
  assert.equal(prefilter(inbound({ subject: 'RE: Request for quotation' }), first).reason, 'reply');
});

test('a subject naming one of our records is not', () => {
  for (const subject of ['About CTZ/QT/2026/014', 'CTZ/ENQ/2026/003 follow-up', 'PO-12345 query']) {
    assert.equal(prefilter(inbound({ subject }), first).reason, 'names a record', subject);
  }
});

test('a newsletter is not, by its footer or its sender', () => {
  assert.equal(prefilter(inbound({ text: 'Our ESG pricing guide. Click to unsubscribe.' }), first).reason, 'bulk');
  assert.equal(prefilter(inbound({ from: { email: 'newsletter@esgtoday.com' } }), first).reason, 'bulk');
});

test('an invoice email or a CV is not, unless it also asks for work', () => {
  assert.equal(prefilter(inbound({ subject: 'Invoice 4411 attached', text: 'Please find the remittance advice.' }), first).reason, 'billing or hr');
  assert.equal(prefilter(inbound({ subject: 'Application for internship', text: 'Please find my CV attached.' }), first).reason, 'billing or hr');
  // "Invoice" in passing does not hide an enquiry.
  assert.equal(prefilter(inbound({ subject: 'Quote needed', text: 'We need a quotation for an ISO audit; invoice to our Pune office.' }), first).candidate, 'inbound');
});

test('an outbound quotation needs a number, or an attachment with quotation words', () => {
  const out = (over) => ({ direction: 'outbound', subject: 'Our quotation for EcoVadis', text: 'Please find attached our quotation.', external: [{ email: 'ravi@acme.in' }], has_attachments: true, ...over });
  assert.equal(prefilter(out({}), {}).candidate, 'quotation');
  assert.equal(prefilter(out({ has_attachments: false }), {}).candidate, null, 'words alone are a covering note');
  assert.equal(prefilter(out({ has_attachments: false, subject: 'CTZ/QT/2026/014' }), {}).candidate, 'quotation');
  assert.equal(prefilter(out({ subject: 'FW: their quotation' }), {}).reason, 'forward');
  assert.equal(prefilter(out({ external: Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@x.com` })) }), {}).reason, 'too many recipients');
  assert.equal(prefilter(out({}), { toVendor: true }).reason, 'to a vendor');
  assert.equal(prefilter(out({}), { handled: true }).reason, 'already handled');
  assert.equal(looksLikeQuotation({ subject: 'Hello', text: 'see CTZ/QT/2025/101 attached' }), true);
});

test('ruleScore: enquiry words with a service clear the bar; a plain note does not', () => {
  assert.ok(ruleScore('Request for quotation: EcoVadis assessment', 'Please share your proposal and fee.') >= RULES_BAR);
  assert.ok(ruleScore('Hello', 'Thanks for the meeting yesterday.') < RULES_BAR);
  assert.ok(ruleScore('Quotation for audit', 'Please find attached the invoice') < ruleScore('Quotation for audit', 'Please share'), 'billing words count against');
  assert.equal(ruleScore('', ''), 0);
});

test('rulesVerdict creates only above the bar, with fields from the sender', () => {
  const v = rulesVerdict(inbound());
  assert.equal(v.kind, 'new_enquiry');
  assert.equal(v.method, 'rules');
  assert.equal(v.company_name, 'Acme Steel');
  assert.equal(v.contact_name, 'Ravi Kumar');
  assert.equal(v.service, 'EcoVadis');
  assert.equal(rulesVerdict(inbound({ subject: 'Hello', text: 'Lunch on Friday?' })).kind, 'other');
});

test('parseVerdict: bad JSON is nothing', () => {
  for (const raw of ['not json', null, [], 42]) {
    const v = parseVerdict(raw);
    assert.equal(v.kind, 'other');
    assert.equal(v.confidence, 0);
  }
});

test('parseVerdict: confidence is clamped, an unknown kind is other', () => {
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: 7 }).confidence, 1);
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: -1 }).confidence, 0);
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: 'high' }).confidence, 0);
  assert.equal(parseVerdict({ kind: 'please_create', confidence: 1 }).kind, 'other');
});

test('parseVerdict: our own company or a free-mail domain is no company', () => {
  const ctx = { ourNames: ['Cetizion Verifica Pvt. Ltd.'], internalDomains: ['cetizionverifica.com'] };
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: 0.9, company_name: 'Cetizion Verifica Pvt Ltd' }, ctx).company_name, null);
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: 0.9, company_name: 'gmail.com' }, ctx).company_name, null);
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: 0.9, company_name: '  Acme   Steel ' }, ctx).company_name, 'Acme Steel');
  assert.equal(parseVerdict({ kind: 'new_enquiry', confidence: 0.9, company_name: 'null' }, ctx).company_name, null);
  assert.equal(isUs('Cetizion', ctx), true);
});

test('parseVerdict keeps an amount only when it is a positive number and a known currency', () => {
  const v = parseVerdict({ kind: 'quotation_sent', confidence: 0.9, quoted_amount: '250000', currency: 'inr' });
  assert.equal(v.quoted_amount, 250000);
  assert.equal(v.currency, 'INR');
  assert.equal(parseVerdict({ kind: 'quotation_sent', quoted_amount: -5, currency: 'XXX' }).quoted_amount, null);
});

test('companyNameFromEmail', () => {
  assert.equal(companyNameFromEmail('ravi@acme-steel.co.in'), 'Acme Steel');
  assert.equal(companyNameFromEmail('a@mail.hindalco.com'), 'Hindalco');
  assert.equal(companyNameFromEmail('a@tata_chemicals.in'), 'Tata Chemicals');
  assert.equal(companyNameFromEmail('a@jsw-steel.in'), 'JSW Steel');
  assert.equal(companyNameFromEmail('a@hpcl.co.in'), 'HPCL');
  assert.equal(companyNameFromEmail('someone@gmail.com'), null);
  assert.equal(companyNameFromEmail('not an address'), null);
});

test('the prompt carries the new text and no deal values', () => {
  const { system, user } = buildPrompt(inbound(), { companyKnown: true, openDeals: 2 });
  assert.match(system, /new_enquiry/);
  assert.match(user, /interested in EcoVadis/);
  assert.match(user, /open deals with them: 2/);
  assert.doesNotMatch(user, /₹|INR \d/);
});

test('free-mail domains never become a company, however the address is spelt', async () => {
  const { companyNameFromEmail } = await import('../src/lib/mailbox/enquiryDetect.js');
  for (const email of ['a@yahoo.in', 'b@ymail.com', 'c@outlook.in', 'd@googlemail.com', 'e@hotmail.co.uk', 'f@me.com', 'g@rediff.com', 'h@live.in']) {
    assert.equal(companyNameFromEmail(email), null, email);
  }
  assert.equal(companyNameFromEmail('ravi@acme-steel.co.in'), 'Acme Steel');
});
