import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStage, readsAsItself, stageKey } from '../src/import/stages.js';
import { mapStage } from '../src/import/rules.js';

/**
 * Deal stages as sales sheets actually write them (#45). The September 2026
 * sheet lost 79 of 168 rows because "PO received – 50% advance invoiced"
 * does not contain the word "won". These are synthetic copies of the
 * wordings seen in the company's sheets, not the client file itself.
 */

const reads = (raw) => {
  const r = classifyStage(raw);
  return r.kind === 'quote' ? r.stage : r.kind;
};

test('the old four words still read the same way', () => {
  assert.equal(reads('Won'), 'Won - PO Received');
  assert.equal(reads('Lost'), 'Lost');
  assert.equal(reads('On Hold'), 'On Hold');
  assert.equal(reads('Under negotiation'), 'Under Negotiation');
  assert.equal(reads('Pending'), 'Under Negotiation');
  assert.equal(mapStage('Closed Won (100%)'), 'Won - PO Received');
});

test('an order, work started or money moving reads as won', () => {
  for (const s of ['PO received', 'PO received – 50% advance invoiced', 'PO received – 75% invoice in preparation',
    'Execution – balance 50% to invoice', 'Work Order received', 'Advance paid – tax invoice requested',
    'Won – confirmed by email (PO awaited)', 'Won bid – PO awaited', '4. Won – PO Received', 'Closed Won (100%)']) {
    assert.equal(reads(s), 'Won - PO Received', s);
  }
});

test('every way of saying not won reads as lost, even when it mentions a PO', () => {
  for (const s of ['Lost', 'Closed Lost (0%)', '5. Lost', "Won't proceed", 'Not selected', 'Lost – PO received by competitor',
    'Dropped', 'Client declined', 'Went with a competitor']) {
    assert.equal(reads(s), 'Lost', s);
  }
});

test('a proposal with the client is submitted; one being reworked is a negotiation', () => {
  for (const s of ['Proposal sent', 'Proposal sent – call scheduled', 'Proposal Submitted (50%)', '2. Proposal Sent',
    'Quotation shared', 'Proposal sent (revised scope)']) {
    assert.equal(reads(s), 'Submitted', s);
  }
  // The bare word "proposal" comes first but must not decide.
  for (const s of ['Proposal being revised', 'Proposal revision requested', 'Proposal – internal review',
    'Terms agreed – PO awaited', 'Final offer sent', 'Negotiation (75%)', '3. Negotiation / PO Awaited', 'Selected – revised proposal sent']) {
    assert.equal(reads(s), 'Under Negotiation', s);
  }
});

test('an early lead is recognised as a lead, not a quotation', () => {
  for (const s of ['Lead – intro sent', 'New enquiry', 'Qualification', 'NDA under review', 'Prospecting (10%)',
    'Qualified (25%)', '1. Lead / Enquiry', 'Meeting scheduled', 'Opportunity']) {
    assert.equal(reads(s), 'lead', s);
  }
});

test('blank and unreadable wordings are told apart, never guessed', () => {
  assert.equal(reads(''), 'blank');
  assert.equal(reads(null), 'blank');
  assert.equal(reads('   '), 'blank');
  assert.equal(reads('Xyzzy'), 'unknown');
});

test("an admin's own reading of a wording decides over the vocabulary", () => {
  const map = { [stageKey('Execution – recurring')]: 'On Hold', [stageKey('Xyzzy')]: 'skip', [stageKey('Proposal sent')]: 'lead' };
  assert.deepEqual(classifyStage('Execution – recurring', map), { stage: 'On Hold', kind: 'quote', by: 'admin' });
  assert.deepEqual(classifyStage('xyzzy', map), { stage: null, kind: 'skip', by: 'admin' });
  assert.deepEqual(classifyStage('PROPOSAL  SENT', map), { stage: null, kind: 'lead', by: 'admin' });
  // A reading that is not a choice is ignored.
  assert.equal(classifyStage('Won', { won: 'Maybe' }).by, 'rule');
});

test('the key ignores case, dashes, punctuation and spacing', () => {
  assert.equal(stageKey('PO received – 50% advance'), stageKey('po-received  -  50% ADVANCE'));
  assert.equal(stageKey('Won’t proceed'), "won't proceed");
});

test('a wording that says exactly what it was read as needs no note', () => {
  assert.equal(readsAsItself('Won', 'Won - PO Received'), true);
  assert.equal(readsAsItself('Lost', 'Lost'), true);
  assert.equal(readsAsItself('PO received', 'Won - PO Received'), false);
});
