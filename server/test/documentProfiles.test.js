import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { fitsPattern, pickProfile, profileNote } from '../src/lib/mailbox/documentProfiles.js';
import { buildInvoicePrompt } from '../src/lib/mailbox/invoiceDetect.js';

/** Client document notes (docs/email-po-invoice-prompt-plan.md §6): which one, what it says, the PO-number shape. */

const alembic = { id: 1, company_id: 11, company_name: 'Alembic Pharmaceuticals Ltd', company_gstin: '24AABCA1234B1ZN', sender_domains: ['alembic.co.in'], po_number_pattern: '^37\\d{8}$', hint: 'SAP: three decimals.', label_aliases: '"YOUR REF" for our quotation' };
const dasami = { id: 2, company_id: 22, company_name: 'Dasami Lab Pvt Ltd', company_gstin: null, sender_domains: [], po_number_pattern: '^DL\\d{2}SW', hint: 'Work orders.', label_aliases: null };

describe('client document notes', () => {
  test('picked by the sender\'s domain, then the thread\'s client, then the client\'s GSTIN in the document', () => {
    assert.equal(pickProfile([alembic, dasami], { senderEmail: 'buyer@purchase.alembic.co.in' })?.id, 1, 'a subdomain counts');
    assert.equal(pickProfile([alembic, dasami], { senderEmail: 'x@gmail.com', companyId: 22 })?.id, 2);
    assert.equal(pickProfile([alembic, dasami], { senderEmail: 'x@gmail.com', text: 'Buyer GSTIN 24AABCA 1234B1ZN' })?.id, 1);
    assert.equal(pickProfile([alembic, dasami], { senderEmail: 'x@gmail.com', text: 'nothing' }), null);
    assert.equal(pickProfile(undefined, { senderEmail: 'buyer@alembic.co.in' }), null);
  });

  test('the note for the prompt, and the PO-number shape', () => {
    assert.equal(profileNote(alembic), 'Notes on documents from Alembic Pharmaceuticals Ltd: SAP: three decimals. The labels it prints: "YOUR REF" for our quotation.');
    assert.equal(profileNote({ ...dasami, hint: null }), null);
    assert.equal(fitsPattern(alembic, '3700101318'), true);
    assert.equal(fitsPattern(alembic, '4500012345'), false);
    assert.equal(fitsPattern(dasami, 'dl26sw060-1132'), true, 'case does not matter');
    assert.equal(fitsPattern({ po_number_pattern: '([' }, 'anything'), true, 'a broken pattern holds nothing back');
    assert.equal(fitsPattern(null, 'anything'), true);
  });

  test('the invoice prompt carries the note when there is one', () => {
    const base = { emailSubject: 'Invoice', emailText: 'Attached.', sentAt: '2026-05-22T09:00:00Z', pdfText: 'x' };
    assert.match(buildInvoicePrompt({ ...base, clientNotes: profileNote(alembic) }).system, /Notes on documents from Alembic/);
    assert.doesNotMatch(buildInvoicePrompt(base).system, /Notes on documents from/);
  });
});
