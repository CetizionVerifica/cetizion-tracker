import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPoPrompt, isPortalSender, parsePoVerdict, poNumbersIn, poPrefilter } from '../src/lib/mailbox/poDetect.js';
import { KINDS, prefilter } from '../src/lib/mailbox/enquiryDetect.js';

/**
 * The purchase-order detector's rules (docs/email-po-plan.md §3.1, §3.2),
 * with no database and no network.
 */

const pdf = (name = 'PO_4500012345.pdf') => ({ name, contentType: 'application/pdf' });
const inbound = (over = {}) => ({
  direction: 'inbound', subject: 'RE: Quotation CTZ/QT/2026/045 - EcoVadis', text: 'Dear Sir, please find attached our purchase order for the above. Regards, Anil',
  from: { email: 'anil@acme-steel.co.in', name: 'Anil' }, attachments: [pdf()], has_attachments: true, ...over,
});
const PORTALS = '*@ansmtp.ariba.com,*@coupahost.com,*@jaggaer.com';

test('PO words with a PDF make a candidate, replies in a thread included', () => {
  assert.deepEqual(poPrefilter(inbound()), { candidate: true, reason: null });
  for (const text of ['We are pleased to place an order for the EcoVadis assessment.', 'Attached is the work order.', 'Please find the LOI attached.', 'Signed contract attached.']) {
    assert.equal(poPrefilter(inbound({ text, subject: 'EcoVadis' })).candidate, true, text);
  }
  for (const name of ['Purchase Order 2026-12.pdf', 'PO_4500012345.pdf', 'WO-HR-0091.pdf']) {
    assert.equal(poPrefilter(inbound({ text: 'Please see attached.', subject: 'Fwd: docs', attachments: [pdf(name)] })).candidate, true, name);
  }
  assert.equal(poPrefilter(inbound({ text: 'Please see attached.', subject: 'Fwd: docs', attachments: [pdf('Report.pdf')] })).candidate, false, 'po inside a word is not PO');
});

test('PO words alone are not a PO; a PO number is enough without a PDF', () => {
  const words = inbound({ text: 'We will send the PO next week once approved.', attachments: [], has_attachments: false });
  assert.equal(poPrefilter(words).candidate, false);
  const numbered = inbound({ text: 'Please treat this mail as our PO. PO No: 4500012345 dated 22.09.2026', attachments: [], has_attachments: false });
  assert.equal(poPrefilter(numbered).candidate, true);
});

test('a remittance advice, a newsletter and our own mail are not', () => {
  assert.equal(poPrefilter(inbound({ subject: 'Payment advice', text: 'Remittance against PO No 4500012345, UTR 1234' })).reason, 'payment advice');
  assert.equal(poPrefilter(inbound({ text: 'Our new contract templates are out. Click to unsubscribe.' })).reason, 'bulk');
  assert.equal(poPrefilter(inbound({ from: { email: 'newsletter@vendor.com' } })).reason, 'bulk');
  assert.equal(poPrefilter(inbound({ direction: 'outbound' })).candidate, false);
  assert.equal(poPrefilter(inbound(), { decided: true }).reason, 'already decided');
});

test('a quotation request with a PDF and no order words is not', () => {
  assert.equal(poPrefilter(inbound({ subject: 'RFQ for ISO 14001', text: 'Please quote for the attached scope.', attachments: [pdf('Scope.pdf')] })).candidate, false);
});

test('a procurement portal is a candidate with no PDF, and despite reading as automated', () => {
  const ariba = inbound({
    from: { email: 'ordersender-prod@ansmtp.ariba.com' }, subject: 'Acme Steel sent a new Purchase Order 4500012345',
    text: 'This is an automated message. Acme Steel has sent you a new purchase order.', attachments: [], has_attachments: false,
  });
  assert.equal(poPrefilter(ariba, { portalSenders: PORTALS }).candidate, true);
  assert.equal(poPrefilter(ariba).reason, 'bulk', 'without the setting it is an automated mail');
  assert.ok(isPortalSender('x@acme.coupahost.com', ['*.coupahost.com']));
  assert.ok(isPortalSender('noreply@coupahost.com', PORTALS));
  assert.ok(!isPortalSender('anil@acme-steel.co.in', PORTALS));
  assert.ok(!isPortalSender('anil@notcoupahost.com.evil.io', PORTALS));
});

test('poNumbersIn reads labelled numbers in the shapes clients print', () => {
  assert.deepEqual(poNumbersIn('PO No: 4500012345 dated 22.09.2026'), ['4500012345']);
  assert.deepEqual(poNumbersIn('P.O. Number – PO/2026/12'), ['PO/2026/12']);
  assert.deepEqual(poNumbersIn('WO No. HR-0091.'), ['HR-0091']);
  assert.deepEqual(poNumbersIn('Purchase Order # 7100-22-0045, Contract No CN/24/118'), ['7100-22-0045', 'CN/24/118']);
  assert.deepEqual(poNumbersIn('Our ref PO-1234 as discussed'), ['PO-1234']);
});

test('poNumbersIn refuses a label with no number after it', () => {
  for (const s of ['PO No: Awaited', 'PO number TBD', 'Order no. verbal', 'in order no later than Friday', 'Contract No: -']) {
    assert.deepEqual(poNumbersIn(s), [], s);
  }
});

test('the enquiry detector leaves POs to the PO reader, only while it is on', () => {
  assert.ok(KINDS.includes('purchase_order'));
  const newThreadPo = inbound({ subject: 'Purchase order for EcoVadis', text: 'Please find attached our purchase order.' });
  const facts = { firstInConversation: true, poReader: true };
  assert.deepEqual(prefilter(newThreadPo, facts), { candidate: null, reason: 'purchase order' });
  assert.equal(prefilter(newThreadPo, { firstInConversation: true }).reason, null, 'off: judged as before');
  assert.equal(prefilter(newThreadPo, { ...facts, notPo: true }).candidate, 'inbound', 'once the PO reader said no');
  const rfq = inbound({ subject: 'Request for quotation: EcoVadis', text: 'We are interested in EcoVadis. Please share your proposal.', attachments: [] });
  assert.equal(prefilter(rfq, facts).candidate, 'inbound', 'an ordinary enquiry is untouched');
});

test('parsePoVerdict: amounts as printed, dates and kinds checked, junk refused', () => {
  const v = parsePoVerdict(JSON.stringify({
    is_purchase_order: true, document_type: 'purchase_order', confidence: 0.93, po_number: ' 4500012345 ', po_date: '2026-09-22',
    buyer: { company_name: 'Acme Steel Ltd', gstin: '27aaacx1234a1zx', contact_email: 'ANIL@acme-steel.co.in' },
    vendor: { company_name: 'Cetizion Verifica Pvt Ltd' },
    currency: 'inr', lines: [{ description: 'EcoVadis', qty: 1, rate: '2,50,000.00', amount: '2,50,000.00' }],
    basic_value: '2,50,000.00', tax_value: '45,000', total_value: '₹ 2,95,000/-', gst_extra: 'yes',
    credit_days: 'thirty', delivery_date: 'end of Nov', amendment_no: null,
  }));
  assert.equal(v.po_number, '4500012345');
  assert.equal(v.buyer.gstin, '27AAACX1234A1ZX');
  assert.equal(v.buyer.contact_email, 'anil@acme-steel.co.in');
  assert.equal(v.currency, 'INR');
  assert.deepEqual([v.basic_value, v.tax_value, v.total_value], [250000, 45000, 295000]);
  assert.equal(v.lines[0].amount, 250000);
  assert.equal(v.gst_extra, false, 'only a real true');
  assert.equal(v.credit_days, null, 'words are not a number of days');
  assert.equal(v.delivery_date, null);
  assert.equal(v.amendment_no, 0);

  for (const junk of ['not json', null, [], 42]) {
    const j = parsePoVerdict(junk);
    assert.equal(j.is_purchase_order, false);
    assert.equal(j.confidence, 0);
  }
  assert.equal(parsePoVerdict({ document_type: 'invoice', confidence: 3 }).document_type, 'other');
  assert.equal(parsePoVerdict({ confidence: 3 }).confidence, 1);
});

test('the prompt sends the PDF text when there is some, and says when the email is the order', () => {
  const base = { emailSubject: 'PO', emailText: 'Attached.', receivedAt: '2026-09-22T10:00:00Z', from: { email: 'a@b.com' } };
  assert.match(buildPoPrompt({ ...base, pdfText: 'PURCHASE ORDER 4500012345' }).user, /Order document text:\nPURCHASE ORDER/);
  assert.match(buildPoPrompt({ ...base, pdfText: null }).user, /document is attached/);
  assert.match(buildPoPrompt({ ...base, pdfText: '' }).user, /email itself is the order/);
  assert.match(buildPoPrompt(base).system, /BUYER is the client/);
});

test('a long PO is read whole: up to 300 lines kept, and over 100,000 characters of its text sent', () => {
  const lines = Array.from({ length: 320 }, (_, i) => ({ description: `Site ${i + 1} audit`, qty: 1, rate: '10,000.00', amount: '10,000.00' }));
  assert.equal(parsePoVerdict({ is_purchase_order: true, confidence: 0.9, lines }).lines.length, 300);
  const text = `PURCHASE ORDER ${'x'.repeat(100_000)} SCHEDULE END`;
  const { user } = buildPoPrompt({ pdfText: text, emailSubject: 'PO', emailText: 'e'.repeat(9000), receivedAt: '2026-10-01', from: { email: 'a@b.com' } });
  assert.match(user, /SCHEDULE END/);
  assert.ok(user.includes('e'.repeat(9000)), 'the email\'s text is not cut at 3,000');
});
