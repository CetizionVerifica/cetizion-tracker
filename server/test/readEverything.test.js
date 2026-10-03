import assert from 'node:assert/strict';
import test from 'node:test';
import { prefilter } from '../src/lib/mailbox/enquiryDetect.js';
import { poPrefilter } from '../src/lib/mailbox/poDetect.js';
import { invoicePrefilter } from '../src/lib/mailbox/invoiceDetect.js';
import { classify, forReaders } from '../src/lib/mailbox/rules.js';

/**
 * Reading everything (email_read_everything, 073): the free rules screen
 * nothing out, the AI decides. What stays: the duplicate guards, the
 * direction each reader reads, a PDF for an invoice, a proforma answered
 * by the rules, and the admin's "Never sync" list.
 */

const reply = { direction: 'inbound', subject: 'RE: our audit', text: 'Thanks, noted.', from: { email: 'ravi@acme.in' } };
const newsletter = { direction: 'inbound', subject: 'This week', text: 'Unsubscribe from this list', from: { email: 'news@acme.in' } };
const ourNote = { direction: 'outbound', subject: 'Fwd: minutes', text: 'See below.', external: [{ email: 'ravi@acme.in' }] };

test('the enquiry reader judges replies, bulk mail and our own notes when reading everything', () => {
  assert.equal(prefilter(reply, { firstInConversation: false }).candidate, null);
  assert.equal(prefilter(reply, { firstInConversation: false, readAll: true }).candidate, 'inbound');
  assert.equal(prefilter(newsletter, { firstInConversation: true }).candidate, null);
  assert.equal(prefilter(newsletter, { firstInConversation: true, readAll: true }).candidate, 'inbound');
  assert.equal(prefilter(ourNote, {}).candidate, null);
  assert.equal(prefilter(ourNote, { readAll: true }).candidate, 'quotation');
});

test('what is already handled, and a PO the PO reader has not decided, still stay out', () => {
  assert.deepEqual(prefilter(reply, { handled: true, readAll: true }), { candidate: null, reason: 'already handled' });
  const po = { ...reply, subject: 'Purchase order 4500012345', has_attachments: true, attachments: [{ name: 'PO_4500012345.pdf', contentType: 'application/pdf' }] };
  assert.equal(prefilter(po, { poReader: true, readAll: true }).reason, 'purchase order');
  assert.equal(prefilter(po, { poReader: true, notPo: true, readAll: true }).candidate, 'inbound');
});

test('the PO reader reads every inbound email, never ours or one decided', () => {
  const words = { ...reply, text: 'We will send the PO next week.' };
  assert.equal(poPrefilter(words, {}).candidate, false);
  assert.equal(poPrefilter(words, { readAll: true }).candidate, true);
  assert.equal(poPrefilter(newsletter, { readAll: true }).candidate, true);
  assert.equal(poPrefilter({ ...words, direction: 'outbound' }, { readAll: true }).candidate, false);
  assert.equal(poPrefilter(words, { decided: true, readAll: true }).candidate, false);
});

test('the invoice reader reads everything we send with a PDF; a proforma is still the rules\' to answer', () => {
  const pdf = [{ name: 'scan.pdf', contentType: 'application/pdf' }];
  const toColleague = { direction: 'outbound', subject: 'Fwd: documents', text: 'Attached.', external: [], attachments: pdf };
  assert.equal(invoicePrefilter(toColleague, {}).reason, 'no client');
  assert.equal(invoicePrefilter(toColleague, { readAll: true }).candidate, true);
  assert.equal(invoicePrefilter({ ...toColleague, attachments: [] }, { readAll: true }).reason, 'no PDF');
  assert.equal(invoicePrefilter({ ...toColleague, subject: 'Proforma invoice', external: [{ email: 'a@acme.in' }] }, { readAll: true }).reason, 'proforma');
  assert.equal(invoicePrefilter({ ...toColleague, direction: 'inbound' }, { readAll: true }).reason, 'inbound');
});

test('the readers get staff-only and robot mail, never the "Never sync" list', () => {
  const opts = { accountEmail: 'sales@cetizionverifica.com', internalDomains: ['cetizionverifica.com'], blocklist: ['newsletter.example'] };
  const colleague = classify({ from: { email: 'priya@cetizionverifica.com' }, to: [{ email: 'sales@cetizionverifica.com' }] }, opts);
  const robot = classify({ from: { email: 'no-reply@portal.example' }, to: [{ email: 'sales@cetizionverifica.com' }] }, opts);
  const listed = classify({ from: { email: 'no-reply@newsletter.example' }, to: [{ email: 'sales@cetizionverifica.com' }] }, opts);
  assert.equal(colleague.skip, 'internal only');
  assert.equal(robot.skip, 'blocked sender');
  assert.equal(listed.skip, 'blocked sender');

  assert.equal(forReaders(colleague, false), null);
  assert.equal(forReaders(robot, false), null);
  assert.equal(forReaders(colleague, true).skip, null);
  assert.deepEqual(forReaders(robot, true).external.map((p) => p.email), ['no-reply@portal.example']);
  assert.equal(forReaders(listed, true), null, 'an address on the list stays out, robot or not');
  // Stored for an Inbox with the verdict kept as `filtered`: the same answer.
  assert.equal(forReaders({ ...robot, skip: null, filtered: 'blocked sender' }, true).filtered, null);
  const kept = classify({ from: { email: 'ravi@acme.in' }, to: [{ email: 'sales@cetizionverifica.com' }] }, opts);
  assert.equal(forReaders(kept, false), kept);
});
