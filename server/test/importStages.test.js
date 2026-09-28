import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyStage, readsAsItself, stageKey, needsReading } from '../src/import/stages.js';
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
    '4. Won – PO Received', 'Closed Won (100%)', 'Payment follow-up', 'Mandate received', 'LOI received, kick-off done',
    'WIP - data collection ongoing', 'Assurance statement issued']) {
    assert.equal(reads(s), 'Won - PO Received', s);
  }
});

test('the way people type it: misspellings and abbreviations read like the words', () => {
  assert.equal(reads('po recieved'), 'Won - PO Received');
  assert.equal(reads('PO recd - advance pending'), 'Won - PO Received');
  assert.equal(reads('WO rcvd (partial advance)'), 'Won - PO Received');
  assert.equal(reads('Negotation'), 'Under Negotiation');
  assert.equal(reads('UNDER NEGO'), 'Under Negotiation');
  assert.equal(reads('Nego.'), 'Under Negotiation');
});

test('every way of saying not won reads as lost, even when it mentions a PO or the word won', () => {
  for (const s of ['Lost', 'Closed Lost (0%)', '5. Lost', "Won't proceed", 'Not selected', 'Closed - Not Won', 'Quotation not accepted', 'Lost – PO received by competitor',
    'Dropped', 'Client declined', 'Went with a competitor', 'Won by competitor', 'Order placed on lower bidder',
    'Competitor got the order', 'Not L1 - lost', 'Unsuccessful', 'Loss - price issue', 'Client opted for another consultant']) {
    assert.equal(reads(s), 'Lost', s);
  }
});

test('an order not yet in is a negotiation, however much else is agreed — as the company files it', () => {
  // The company's register files every one of these as "3. Negotiation / PO Awaited".
  for (const s of ['Won – confirmed by email (PO awaited)', 'Won bid – PO awaited', 'Execution – PO awaited', 'Terms agreed – PO awaited',
    'PO not received yet', 'Verbally confirmed, PO awaited', 'Approved by client, PO not received yet',
    'Decision in our favour, PO to be released', 'Commitment received, PO in process', 'L1, awaiting LOA',
    'Vendor registration in progress for PO']) {
    assert.equal(reads(s), 'Under Negotiation', s);
  }
});

test('a proposal with the client is submitted; one being reworked is a negotiation', () => {
  for (const s of ['Proposal sent', 'Proposal sent – call scheduled', 'Proposal Submitted (50%)', '2. Proposal Sent',
    'Quotation shared', 'Proposal sent (revised scope)', 'Sent - awaiting feedback', 'Techno-commercial offer sent',
    'Offer sent, followed up twice', 'Awaiting feedback on proposal', 'Proposal presented, decision pending',
    // The company's register files this one under Proposal Sent.
    'Proposal – internal review']) {
    assert.equal(reads(s), 'Submitted', s);
  }
  // The bare word "proposal" comes first but must not decide.
  for (const s of ['Proposal being revised', 'Proposal revision requested', 'Final offer sent', 'BAFO submitted', 'Negotiation (75%)',
    '3. Negotiation / PO Awaited', 'Selected – revised proposal sent', 'Payment terms under discussion', 'Client asked for discount',
    'Client asked for lower fee - reworking proposal', 'Stage 5: Contracting', 'Contract under legal review']) {
    assert.equal(reads(s), 'Under Negotiation', s);
  }
});

test('a paused deal is on hold', () => {
  for (const s of ['On Hold', 'on-hold', 'Deferred to next FY', 'Client asked to reconnect after Diwali', 'Not cancelled, only postponed']) {
    assert.equal(reads(s), 'On Hold', s);
  }
});

test('an early lead is recognised as a lead, not a quotation — including a proposal not yet sent', () => {
  for (const s of ['Lead – intro sent', 'New enquiry', 'Qualification', 'NDA under review', 'Prospecting (10%)',
    'Qualified (25%)', '1. Lead / Enquiry', 'Meeting scheduled', 'Opportunity', 'Vendor onboarding', 'RFQ received',
    'RFQ recieved - to prepare proposal', 'Proposal to be sent', 'Proposal under preparation', 'Preparing quotation',
    'Proposal not yet sent', 'Scoping site visit done, proposal yet to be sent', 'Requirement gathering']) {
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

test("the AI's reading fills only what no rule understood, and is marked as the AI's", () => {
  const ai = { [stageKey('Xyzzy')]: 'On Hold', [stageKey('Proposal sent')]: 'Lost', [stageKey('Plugh')]: 'lead', [stageKey('Frob')]: null };
  assert.deepEqual(classifyStage('xyzzy', null, ai), { stage: 'On Hold', kind: 'quote', by: 'ai' });
  assert.deepEqual(classifyStage('Plugh', null, ai), { stage: null, kind: 'lead', by: 'ai' });
  // A rule decides over the model; the admin decides over both.
  assert.deepEqual(classifyStage('Proposal sent', null, ai), { stage: 'Submitted', kind: 'quote', by: 'rule' });
  assert.equal(classifyStage('Xyzzy', { [stageKey('Xyzzy')]: 'Lost' }, ai).by, 'admin');
  // A wording the model could not read either, or a reading that is not a choice, stays not understood.
  assert.equal(classifyStage('Frob', null, ai).kind, 'unknown');
  assert.equal(classifyStage('Quux', null, { quux: 'Maybe' }).kind, 'unknown');
});

test('the AI is asked about what the rules are unsure of, never about a company convention', () => {
  for (const s of ['Xyzzy', 'Negotiation paused by client', 'Quotation sent, not accepted yet']) assert.equal(needsReading(s), true, s);
  for (const s of ['Won', 'Proposal sent', 'Lost', 'PO awaited', 'Proposal – internal review', '', null]) assert.equal(needsReading(s), false, String(s));
  // A contested wording takes the model's reading; without one, the rule's stands.
  const ai = { [stageKey('Negotiation paused by client')]: 'On Hold' };
  assert.deepEqual(classifyStage('Negotiation paused by client', null, ai), { stage: 'On Hold', kind: 'quote', by: 'ai' });
  assert.equal(classifyStage('Negotiation paused by client').by, 'rule');
});
