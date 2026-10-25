import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { journeyClause } from '../src/lib/journey/queries.js';
import {
  COHORTS, DEFAULT_SETTINGS, STUCK_KINDS, bigStates, compareCards, dayOf, daysBefore, flagOf, funnel, journeyBoard,
  journeyDetail, journeyState, nextAction, smallSteps, stepAndExit, stepFacts, summariseSteps, toCard, visibleOnBoard,
} from '../src/lib/journey/steps.js';

/**
 * The sales journey's rules (server/src/lib/journey/CLAUDE.md §3, and the
 * scope predicate of §6), with no database: every row here is made up, and
 * today is pinned, so each rule of the truth table can be read off a test.
 * Boundaries are tried on both sides — the limit itself is still on time,
 * one day over is not. Nothing here runs a query.
 */

const TODAY = '2026-10-25';
const ago = (n) => daysBefore(TODAY, n);
const S = DEFAULT_SETTINGS;

// A sale at each step, plain enough that one override says what a test is about.
const enquiry = (over = {}) => ({
  journey_key: 'e-1', anchor: 'enquiry', client_name: 'Example Textiles', sales_person: 'Asha Rao', service: 'ISO 9001',
  enquiry_id: 1, enquiry_no: 'CTZ/ENQ/2026/901', enquiry_date: ago(2), enquiry_created_at: ago(2), enquiry_status: 'New',
  enquiry_estimated_value: 450000, enquiry_currency: 'INR', enquiry_value_inr: 450000, enquiry_source: 'Referral',
  po_count: 0, po_numbers: [], started_on: ago(2), ...over,
});
const quotation = (over = {}) => ({
  journey_key: 'q-1', anchor: 'quotation', client_name: 'Sample Forgings', sales_person: 'Asha Rao', service: 'ISO 14001',
  quotation_id: 1, quotation_no: 'Q-TEST-1', quotation_date: ago(3), quotation_created_at: ago(3), quotation_status: 'Submitted',
  stage_type: 'open', line_count: 2, quotation_value: 590000, quotation_currency: 'INR', quotation_value_inr: 590000,
  price_needed_count: 0, approval_status: 'not_needed', sent_at: `${ago(2)}T06:00:00Z`, accepted_at: null,
  po_count: 0, po_numbers: [], started_on: ago(3), ...over,
});
const po = (over = {}) => quotation({
  quotation_status: 'Won - PO Received', stage_type: 'won', accepted_at: `${ago(20)}T06:00:00Z`,
  po_count: 1, po_numbers: ['PO-TEST-1'], first_po_number: 'PO-TEST-1', first_po_date: ago(4), first_po_created_at: `${ago(4)}T06:00:00Z`,
  po_value_total: 590000, po_currency: 'INR', po_value_inr: 590000, pos_without_stages: 0, stage_count: 2,
  billable_stages: 1, invoiced_total: 0, received_total: 0, stages_to_invoice: 1, overdue_stages: 0, overdue_amount: 0,
  fully_paid: false, last_paid_on: null, next_stage_due: null, project_id: 'PRJ-TEST-1', ...over,
});

const state = (row, settings = S) => journeyState(row, settings, TODAY);
const flag = (row, settings = S) => state(row, settings).flag;
const small = (key, row) => smallSteps(key, row).steps.map((s) => `${s.label}:${s.state}`);

describe('§3.1 step and exit', () => {
  test('each step without an exit', () => {
    assert.deepEqual(stepAndExit(enquiry()), { step: 'enquiry', exit: null });
    assert.deepEqual(stepAndExit(quotation()), { step: 'quotation', exit: null });
    assert.deepEqual(stepAndExit(po()), { step: 'po', exit: null });
  });

  test('each exit: unqualified at Enquiry, lost at Quotation by stage or by status, paid at PO', () => {
    assert.deepEqual(stepAndExit(enquiry({ enquiry_status: 'Unqualified' })), { step: 'enquiry', exit: 'unqualified' });
    assert.deepEqual(stepAndExit(quotation({ stage_type: 'lost' })), { step: 'quotation', exit: 'lost' }, 'the Expired stage is a loss');
    assert.deepEqual(stepAndExit(quotation({ quotation_status: 'Lost', stage_type: null })), { step: 'quotation', exit: 'lost' });
    assert.deepEqual(stepAndExit(po({ fully_paid: true })), { step: 'po', exit: 'paid' });
  });

  test('a PO beats a lost quotation: money ordered is the fact that matters', () => {
    assert.deepEqual(stepAndExit(po({ quotation_status: 'Lost', stage_type: 'lost' })), { step: 'po', exit: null });
  });

  test('a quotation is on Quotation whatever its enquiry says', () => {
    assert.deepEqual(stepAndExit(quotation({ enquiry_id: 9, enquiry_status: 'Unqualified' })), { step: 'quotation', exit: null });
  });
});

describe('§3.2 the three big steps', () => {
  const states = (row) => bigStates(row, stepAndExit(row));

  test('done before, current at, future after', () => {
    assert.deepEqual(states(enquiry()), ['current', 'future', 'future']);
    assert.deepEqual(states(quotation({ enquiry_id: 1 })), ['done', 'current', 'future']);
    assert.deepEqual(states(po({ enquiry_id: 1 })), ['done', 'done', 'current']);
  });

  test('a step passed with no record behind it is skipped, never done', () => {
    assert.deepEqual(states(quotation()), ['skipped', 'current', 'future']);
    assert.deepEqual(states(po({ quotation_id: null, quotation_no: null })), ['skipped', 'skipped', 'current']);
  });

  test('an exit takes the place of current; a paid sale is done throughout', () => {
    assert.deepEqual(states(enquiry({ enquiry_status: 'Unqualified' })), ['exit', 'future', 'future']);
    assert.deepEqual(states(quotation({ enquiry_id: 1, stage_type: 'lost' })), ['done', 'exit', 'future']);
    assert.deepEqual(states(po({ enquiry_id: 1, fully_paid: true })), ['done', 'done', 'done']);
  });

  test('the card carries the same states as progress', () => {
    assert.deepEqual(state(quotation()).progress, ['skipped', 'current', 'future']);
  });
});

describe('§3.3 small steps', () => {
  test('Enquiry: New always, Contacted by a response, a contact or the status, Qualified by the status', () => {
    assert.deepEqual(small('enquiry', enquiry()), ['New:current', 'Contacted:future', 'Qualified:future']);
    assert.equal(smallSteps('enquiry', enquiry()).label, 'New');
    for (const over of [{ enquiry_first_responded_at: `${ago(1)}T09:00:00Z` }, { enquiry_last_contacted_at: `${ago(1)}T09:00:00Z` },
      { enquiry_status: 'Contacted' }, { enquiry_status: 'Nurture' }]) {
      assert.deepEqual(small('enquiry', enquiry(over)), ['New:done', 'Contacted:current', 'Qualified:future'], JSON.stringify(over));
    }
    for (const status of ['Qualified', 'Converted']) {
      assert.deepEqual(small('enquiry', enquiry({ enquiry_status: status })), ['New:done', 'Contacted:done', 'Qualified:current'], status);
    }
  });

  test('Contacted carries the day of the first response', () => {
    const steps = smallSteps('enquiry', enquiry({ enquiry_first_responded_at: `${ago(1)}T09:00:00Z` })).steps;
    assert.equal(steps[1].date, ago(1));
  });

  test('Quotation: nothing reached reads Draft, and every small step is still to come', () => {
    const draft = quotation({ quotation_status: 'Draft', line_count: 0, quotation_value: 0, sent_at: null });
    assert.equal(smallSteps('quotation', draft).label, 'Draft');
    assert.deepEqual(small('quotation', draft), ['Priced:future', 'Sent:future', 'Negotiating:future', 'Accepted:future', 'Won:future']);
    assert.equal(state(draft).small_step, 'Draft');
  });

  test('Quotation: Priced by its lines or its value', () => {
    const draft = { quotation_status: 'Draft', sent_at: null };
    assert.equal(smallSteps('quotation', quotation({ ...draft, line_count: 1, quotation_value: null })).label, 'Priced');
    assert.equal(smallSteps('quotation', quotation({ ...draft, line_count: 0, quotation_value: 1 })).label, 'Priced');
  });

  test('Quotation: Sent by its send date, or by any status past Draft, with the date when known', () => {
    const sent = smallSteps('quotation', quotation());
    assert.equal(sent.label, 'Sent');
    assert.equal(sent.steps[1].date, ago(2));
    assert.equal(smallSteps('quotation', quotation({ sent_at: null, quotation_status: 'Submitted' })).label, 'Sent');
    assert.equal(smallSteps('quotation', quotation({ quotation_status: 'Draft' })).label, 'Sent', 'sent_at alone is enough');
  });

  test('Quotation: Negotiating, Accepted (which implies Negotiating) and Won (which implies both)', () => {
    assert.equal(smallSteps('quotation', quotation({ quotation_status: 'Under Negotiation' })).label, 'Negotiating');
    const accepted = smallSteps('quotation', quotation({ accepted_at: `${ago(1)}T10:00:00Z` }));
    assert.deepEqual(accepted.steps.map((s) => s.state), ['done', 'done', 'done', 'current', 'future']);
    assert.equal(accepted.steps[3].date, ago(1));
    assert.equal(smallSteps('quotation', quotation({ quotation_status: 'Won - PO Received' })).label, 'Won');
    assert.equal(smallSteps('quotation', quotation({ stage_type: 'won' })).label, 'Won');
  });

  test('an unreached small step before the one it is at is skipped, not done', () => {
    // Sent by status, but never priced: a quotation imported without a value.
    assert.deepEqual(small('quotation', quotation({ line_count: 0, quotation_value: null, sent_at: null, quotation_status: 'Under Negotiation' })),
      ['Priced:skipped', 'Sent:done', 'Negotiating:current', 'Accepted:future', 'Won:future']);
    // Invoiced on one PO while another has no stages yet.
    assert.deepEqual(small('po', po({ pos_without_stages: 1, invoiced_total: 100 })),
      ['Registered:done', 'Split set:skipped', 'Billable:done', 'Invoiced:current', 'Paid:future']);
  });

  test('PO: Registered with its date, then Split set, Billable, Invoiced, Paid', () => {
    const registered = smallSteps('po', po({ pos_without_stages: 1, billable_stages: 0 }));
    assert.equal(registered.label, 'Registered');
    assert.equal(registered.steps[0].date, ago(4));
    assert.equal(smallSteps('po', po({ billable_stages: 0 })).label, 'Split set');
    assert.equal(smallSteps('po', po({ billable_stages: 1 })).label, 'Billable');
    assert.equal(smallSteps('po', po({ billable_stages: 0, invoiced_total: 10 })).label, 'Invoiced', 'an invoice makes it billable too');
    assert.equal(smallSteps('po', po({ invoiced_total: 590000, fully_paid: true, last_paid_on: ago(1) })).label, 'Paid');
    assert.equal(smallSteps('po', po({ invoiced_total: 590000, fully_paid: true, last_paid_on: ago(1) })).steps[4].date, ago(1));
  });
});

describe('§3.4 days in step', () => {
  test('since the record entered the step, in whole days', () => {
    assert.deepEqual([state(enquiry()).step_since, state(enquiry()).days_in_step], [ago(2), 2]);
    assert.deepEqual([state(quotation()).step_since, state(quotation()).days_in_step], [ago(3), 3]);
    assert.deepEqual([state(po()).step_since, state(po()).days_in_step], [ago(4), 4]);
  });

  test('a PO with no date counts from when it was registered', () => {
    const s = state(po({ first_po_date: null, first_po_created_at: `${ago(6)}T08:00:00Z` }));
    assert.deepEqual([s.step_since, s.days_in_step], [ago(6), 6]);
  });

  test('never negative: a PO dated next week has been here for no days', () => {
    assert.equal(state(po({ first_po_date: '2026-11-02' })).days_in_step, 0);
  });

  test('a timestamp is read as the business day it fell on', () => {
    // 20:00 UTC on the 24th is 01:30 on the 25th in Mumbai.
    assert.equal(dayOf('2026-10-24T20:00:00Z'), '2026-10-25');
    assert.equal(dayOf(new Date('2026-10-24T20:00:00Z')), '2026-10-25');
    assert.equal(state(enquiry({ enquiry_created_at: new Date('2026-10-24T20:00:00Z') })).days_in_step, 0);
    assert.equal(dayOf(null), null);
    assert.equal(dayOf('2026-10-01'), '2026-10-01');
  });
});

describe('§3.5 the flag', () => {
  test('Enquiry: on time at the limit, slow a day over, stuck a day over twice it', () => {
    const at = (d) => flag(enquiry({ enquiry_created_at: ago(d) }));
    assert.equal(at(7), null);
    assert.deepEqual(at(8), { kind: 'slow', label: '8 days', tone: 'waiting' });
    assert.equal(at(14).kind, 'slow');
    assert.deepEqual(at(15), { kind: 'stuck', label: 'Stuck 15 days', tone: 'late' });
  });

  test('Quotation: the same at 21 and 42 days', () => {
    const at = (d) => flag(quotation({ quotation_created_at: ago(d) }));
    assert.equal(at(21), null);
    assert.deepEqual(at(22), { kind: 'slow', label: '22 days', tone: 'waiting' });
    assert.equal(at(42).kind, 'slow');
    assert.deepEqual(at(43), { kind: 'stuck', label: 'Stuck 43 days', tone: 'late' });
  });

  test('PO: the same at 30 and 60 days, but only until the first invoice', () => {
    const at = (d, over = {}) => flag(po({ first_po_date: ago(d), ...over }));
    assert.equal(at(30), null);
    assert.deepEqual(at(31), { kind: 'slow', label: '31 days', tone: 'waiting' });
    assert.equal(at(60).kind, 'slow');
    assert.deepEqual(at(61), { kind: 'stuck', label: 'Stuck 61 days', tone: 'late' });
    assert.equal(at(200, { invoiced_total: 1 }), null, 'invoiced: the PO clock has stopped');
  });

  test('Unsent: a quotation not yet sent, after unsent_days', () => {
    const draft = (d) => quotation({ quotation_status: 'Draft', sent_at: null, quotation_created_at: ago(d) });
    assert.equal(flag(draft(5)), null);
    assert.deepEqual(flag(draft(6)), { kind: 'unsent', label: 'Unsent 6 days', tone: 'waiting' });
    assert.equal(flag(quotation({ quotation_created_at: ago(6) })), null, 'a sent one is not nudged');
  });

  test('Overdue: the amount owed, as the web writes money; across currencies, the stages', () => {
    assert.deepEqual(flag(po({ overdue_stages: 1, overdue_amount: 300000 })), { kind: 'overdue', label: '₹3,00,000 overdue', tone: 'late' });
    assert.equal(flag(po({ overdue_stages: 1, overdue_amount: 1200, po_currency: 'EUR' })).label, '€1,200 overdue');
    assert.equal(flag(po({ overdue_stages: 2, overdue_amount: 5000, po_currency: null })).label, '2 stages overdue');
  });

  test('Approval and price: the quotation is waiting on us', () => {
    assert.deepEqual(flag(quotation({ approval_status: 'pending' })), { kind: 'approval', label: 'Discount needs approval', tone: 'waiting' });
    assert.deepEqual(flag(quotation({ price_needed_count: 1 })), { kind: 'price', label: '1 line needs a price', tone: 'waiting' });
    assert.equal(flag(quotation({ price_needed_count: 3 })).label, '3 lines need a price');
    assert.equal(flag(quotation({ price_needed_count: 3, quotation_status: 'Won - PO Received' })), null, 'not once it is won');
  });

  test('Nurturing: an enquiry being kept warm, unless it has been waiting too long', () => {
    assert.deepEqual(flag(enquiry({ enquiry_status: 'Nurture' })), { kind: 'nurture', label: 'Nurturing', tone: 'info' });
    assert.equal(flag(enquiry({ enquiry_status: 'Nurture', enquiry_created_at: ago(8) })).kind, 'slow');
  });

  test('first match wins, in the order of the table', () => {
    assert.equal(flag(po({ overdue_stages: 1, overdue_amount: 10, first_po_date: ago(100) })).kind, 'overdue', 'overdue before stuck');
    assert.equal(flag(quotation({ approval_status: 'pending', price_needed_count: 2 })).kind, 'approval', 'approval before price');
    assert.equal(flag(quotation({ price_needed_count: 2, quotation_status: 'Draft', sent_at: null, quotation_created_at: ago(9) })).kind, 'price', 'price before unsent');
    assert.equal(flag(quotation({ quotation_status: 'Draft', sent_at: null, quotation_created_at: ago(50) })).kind, 'unsent', 'unsent before stuck');
    assert.equal(flag(quotation({ approval_status: 'pending', quotation_created_at: ago(50) })).kind, 'approval', 'approval before stuck');
  });

  test('a sale that stopped carries no flag', () => {
    assert.equal(flag(quotation({ stage_type: 'lost', quotation_created_at: ago(100), approval_status: 'pending' })), null);
    assert.equal(flag(enquiry({ enquiry_status: 'Unqualified', enquiry_created_at: ago(100) })), null);
    assert.equal(flag(po({ fully_paid: true, first_po_date: ago(100), overdue_stages: 1 })), null);
  });

  test('the thresholds are the ones passed in', () => {
    assert.equal(flag(enquiry({ enquiry_created_at: ago(3) }), { ...S, enquiry_days: 2 }).kind, 'slow');
    assert.equal(flag(enquiry({ enquiry_created_at: ago(5) }), { ...S, enquiry_days: 2 }).kind, 'stuck');
  });

  test('one day is one day', () => {
    assert.equal(flag(enquiry({ enquiry_created_at: ago(1) }), { ...S, enquiry_days: 0 }).label, 'Stuck 1 day');
  });

  test('flagOf leaves a sale whose days are unknown alone, except to say it is being nurtured', () => {
    assert.equal(flagOf(enquiry(), { step: 'enquiry', exit: null, days: null }, S), null);
    assert.equal(flagOf(enquiry({ enquiry_status: 'Nurture' }), { step: 'enquiry', exit: null, days: null }, S).kind, 'nurture');
  });
});

describe('§3.6 next action', () => {
  const next = (row) => state(row).next?.verb ?? null;

  test('Enquiry: contact a new one, convert a qualified one, otherwise log a call', () => {
    assert.deepEqual(state(enquiry()).next, { verb: 'contact', label: 'Contact them' });
    assert.equal(next(enquiry({ enquiry_last_contacted_at: `${ago(1)}T09:00:00Z` })), 'follow_up', 'still marked New, but already called');
    assert.equal(next(enquiry({ enquiry_status: 'Contacted' })), 'follow_up');
    assert.equal(next(enquiry({ enquiry_status: 'Nurture' })), 'follow_up');
    assert.deepEqual(state(enquiry({ enquiry_status: 'Qualified' })).next, { verb: 'convert', label: 'Convert to quotation' });
    assert.equal(next(enquiry({ enquiry_status: 'Converted' })), 'convert');
    assert.deepEqual(state(enquiry({ enquiry_status: 'Contacted' })).next, { verb: 'follow_up', label: 'Log a call' });
  });

  test('Quotation: approve, price, send, register the PO, or follow up, in that order', () => {
    assert.deepEqual(state(quotation({ approval_status: 'pending', price_needed_count: 1 })).next, { verb: 'approve', label: 'Review the discount' });
    assert.deepEqual(state(quotation({ price_needed_count: 1, quotation_status: 'Draft', sent_at: null })).next, { verb: 'price', label: 'Price the lines' });
    assert.deepEqual(state(quotation({ quotation_status: 'Draft', sent_at: null })).next, { verb: 'send', label: 'Send to the client' });
    assert.deepEqual(state(quotation({ accepted_at: `${ago(1)}T09:00:00Z` })).next, { verb: 'register_po', label: 'Register the PO' });
    assert.equal(next(quotation({ quotation_status: 'Won - PO Received' })), 'register_po');
    assert.deepEqual(state(quotation()).next, { verb: 'follow_up', label: 'Follow up' });
    assert.equal(next(quotation({ quotation_status: 'Under Negotiation' })), 'follow_up');
  });

  test('PO: set the split, chase, raise the invoice, or open the order, in that order', () => {
    assert.deepEqual(state(po({ pos_without_stages: 1, overdue_stages: 1 })).next, { verb: 'set_split', label: 'Set the payment split' });
    assert.deepEqual(state(po({ overdue_stages: 1, stages_to_invoice: 1 })).next, { verb: 'chase', label: 'Chase payment' });
    assert.deepEqual(state(po({ stages_to_invoice: 1 })).next, { verb: 'raise_invoice', label: 'Raise the invoice' });
    assert.deepEqual(state(po({ stages_to_invoice: 0 })).next, { verb: 'open', label: 'Open the order' });
  });

  test('a sale that stopped has nothing next', () => {
    assert.equal(nextAction(enquiry({ enquiry_status: 'Unqualified' }), { step: 'enquiry', exit: 'unqualified' }), null);
    assert.equal(next(quotation({ stage_type: 'lost' })), null);
    assert.equal(next(po({ fully_paid: true })), null);
  });
});

describe('§3.7 the funnel', () => {
  const rows = [
    enquiry({ journey_key: 'e-before', started_on: '2026-07-26' }),
    enquiry({ journey_key: 'e-first-day', started_on: '2026-07-27' }),
    enquiry({ journey_key: 'e-unqualified', started_on: '2026-08-01', enquiry_status: 'Unqualified' }),
    quotation({ journey_key: 'q-open', started_on: '2026-08-02' }),
    quotation({ journey_key: 'q-lost', started_on: '2026-08-03', stage_type: 'lost' }),
    quotation({ journey_key: 'q-won', started_on: '2026-08-04', quotation_status: 'Won - PO Received', stage_type: 'won' }),
    po({ journey_key: 'q-po', started_on: '2026-09-01' }),
    po({ journey_key: 'p-only', started_on: TODAY, quotation_id: null, quotation_no: null, quotation_status: null, stage_type: null }),
    enquiry({ journey_key: 'e-after', started_on: '2026-10-26' }),
  ];

  test('the cohort is the sales started in the period, both ends included, stopped ones counted', () => {
    assert.deepEqual(funnel(rows, '2026-07-27', TODAY), { started: 7, quoted: 4, won: 3, with_po: 2 });
  });

  test('a sale that began at a PO counts as won and with a PO, though nothing was quoted', () => {
    assert.deepEqual(funnel(rows, TODAY, TODAY), { started: 1, quoted: 0, won: 1, with_po: 1 });
  });

  test('an empty period is all zeros', () => {
    assert.deepEqual(funnel(rows, '2025-01-01', '2025-01-31'), { started: 0, quoted: 0, won: 0, with_po: 0 });
    assert.deepEqual(Object.keys(funnel([], '2025-01-01', '2025-01-31')), COHORTS);
  });
});

describe('§3.8 who is on the board', () => {
  const visible = (row, options) => visibleOnBoard(row, state(row), S, TODAY, options);
  const period = { from: '2026-07-27', to: TODAY };

  test('open sales show; lost and unqualified ones do not', () => {
    assert.equal(visible(enquiry()), true);
    assert.equal(visible(quotation({ stage_type: 'lost' })), false);
    assert.equal(visible(enquiry({ enquiry_status: 'Unqualified' })), false);
  });

  test('a paid sale stays for paid_visible_days after its last payment', () => {
    assert.equal(visible(po({ fully_paid: true, last_paid_on: ago(30) })), true);
    assert.equal(visible(po({ fully_paid: true, last_paid_on: ago(31) })), false);
    assert.equal(visible(po({ fully_paid: true, last_paid_on: null })), false, 'no payment date: nothing to count from');
  });

  test('Show closed shows them all', () => {
    for (const row of [quotation({ stage_type: 'lost' }), enquiry({ enquiry_status: 'Unqualified' }), po({ fully_paid: true, last_paid_on: ago(300) })]) {
      assert.equal(visible(row, { closed: true }), true);
    }
  });

  test('a cohort shows exactly its members, stopped ones included, whatever the default would say', () => {
    assert.equal(visible(quotation({ stage_type: 'lost', started_on: ago(10) }), { cohort: 'quoted', period }), true);
    assert.equal(visible(enquiry({ started_on: ago(10) }), { cohort: 'quoted', period }), false, 'not quoted');
    assert.equal(visible(quotation({ started_on: '2026-07-01' }), { cohort: 'quoted', period }), false, 'started before the period');
    assert.equal(visible(po({ fully_paid: true, last_paid_on: ago(300), started_on: ago(10) }), { cohort: 'with_po', period }), true);
  });
});

describe('the board', () => {
  const rows = [
    enquiry({ journey_key: 'e-slow', enquiry_created_at: ago(9) }),
    enquiry({ journey_key: 'e-fresh' }),
    enquiry({ journey_key: 'e-nurture', enquiry_status: 'Nurture', enquiry_created_at: ago(1) }),
    quotation({ journey_key: 'q-stuck', quotation_created_at: ago(50) }),
    quotation({ journey_key: 'q-price', price_needed_count: 1 }),
    quotation({ journey_key: 'q-unsent', quotation_status: 'Draft', sent_at: null, quotation_created_at: ago(8) }),
    quotation({ journey_key: 'q-norate', quotation_currency: 'AED', quotation_value_inr: null }),
    quotation({ journey_key: 'q-lost', stage_type: 'lost' }),
    po({ journey_key: 'q-overdue', overdue_stages: 1, overdue_amount: 1000, first_po_date: ago(10) }),
    po({ journey_key: 'q-paid', fully_paid: true, last_paid_on: ago(2), first_po_date: ago(12) }),
  ];
  const board = (options = {}) => journeyBoard(rows, S, TODAY, { period: { from: ago(90), to: TODAY }, ...options });

  test('the shape of the answer', () => {
    const b = board();
    assert.deepEqual(Object.keys(b), ['period', 'funnel', 'steps', 'cards', 'settings']);
    assert.deepEqual(b.period, { from: '2026-07-27', to: TODAY });
    assert.deepEqual(b.settings, { enquiry_days: 7, quotation_days: 21, unsent_days: 5, po_days: 30, paid_visible_days: 30 });
    assert.deepEqual(b.steps.map((s) => s.key), ['enquiry', 'quotation', 'po']);
  });

  test('cards by step, then the flags that need someone first, then the longest waiting', () => {
    assert.deepEqual(board().cards.map((c) => c.key),
      ['e-slow', 'e-nurture', 'e-fresh', 'q-stuck', 'q-unsent', 'q-price', 'q-norate', 'q-overdue', 'q-paid']);
    assert.ok(compareCards({ step: 'po', key: 'a', days_in_step: 1 }, { step: 'enquiry', key: 'b', days_in_step: 9 }) > 0);
  });

  test('Stuck only keeps the flags about time and money, not a missing price or nurturing', () => {
    assert.deepEqual(STUCK_KINDS, ['stuck', 'slow', 'overdue', 'unsent']);
    assert.deepEqual(board({ stuck: true }).cards.map((c) => c.key), ['e-slow', 'q-stuck', 'q-unsent', 'q-overdue']);
  });

  test('column figures are counted from the cards returned', () => {
    const steps = board().steps;
    assert.deepEqual(steps[0], { key: 'enquiry', label: 'Enquiry', count: 3, value_inr: 1350000, without_rate: 0, median_days: 2 });
    assert.equal(steps[1].count, 4, 'the lost quotation is not on the board');
    assert.equal(steps[1].without_rate, 1, 'the AED quotation has no rate for its date');
    assert.equal(steps[1].value_inr, 590000 * 3);
    assert.equal(board({ stuck: true }).steps[0].count, 1, 'filtering narrows the figures with the cards');
  });

  test('a median of an even count is the mean of the middle two, in whole days', () => {
    assert.equal(summariseSteps([{ step: 'po', days_in_step: 10 }, { step: 'po', days_in_step: 13 }])[2].median_days, 12);
    assert.equal(summariseSteps([])[0].median_days, null);
  });

  test('the funnel is counted before the board\'s switches, so a figure opens as many cards', () => {
    const b = board({ cohort: 'quoted' });
    assert.equal(b.cards.length, b.funnel.quoted);
    assert.ok(b.cards.some((c) => c.key === 'q-lost'), 'the lost quotation is in the cohort');
    assert.deepEqual(board({ stuck: true }).funnel, board().funnel);
  });

  test('Show closed adds the stopped sales', () => {
    assert.equal(board({ closed: true }).cards.length, rows.length);
  });
});

describe('§6 the scope predicate', () => {
  test('nothing for an admin, and no parameter pushed', () => {
    const params = [];
    assert.equal(journeyClause({ unrestricted: true, ownerId: null }, params), '');
    assert.deepEqual(params, []);
  });

  test('anyone else: the three owner routes, on one parameter that is never in the text', () => {
    const params = ['before'];
    assert.equal(journeyClause({ unrestricted: false, ownerId: 42 }, params),
      '(j.enquiry_owner_id = $2 OR j.quotation_owner_id = $2 OR $2 = ANY(j.project_owner_ids))');
    assert.deepEqual(params, ['before', 42]);
    assert.equal(journeyClause({ unrestricted: false, ownerId: 7 }, [], { alias: 'x' }),
      '(x.enquiry_owner_id = $1 OR x.quotation_owner_id = $1 OR $1 = ANY(x.project_owner_ids))');
  });
});

describe('the card and the full journey', () => {
  test('a card carries the current step\'s value and the records behind the sale', () => {
    const row = po({ enquiry_id: 1, enquiry_no: 'CTZ/ENQ/2026/901', po_value_total: 700000, po_value_inr: 700000 });
    const card = toCard(row, state(row));
    assert.deepEqual([card.value, card.currency, card.value_inr], [700000, 'INR', 700000]);
    assert.deepEqual(card.records, { enquiry_no: 'CTZ/ENQ/2026/901', quotation_no: 'Q-TEST-1', po_number: 'PO-TEST-1', project_id: 'PRJ-TEST-1' });
    const e = toCard(enquiry(), state(enquiry()));
    assert.deepEqual([e.value, e.currency, e.value_inr, e.started_on], [450000, 'INR', 450000, ago(2)]);
    const q = toCard(quotation(), state(quotation()));
    assert.deepEqual([q.value, q.currency, q.key, q.client_name, q.service, q.sales_person], [590000, 'INR', 'q-1', 'Sample Forgings', 'ISO 14001', 'Asha Rao']);
  });

  test('every step with a record has its small steps and facts; one without says nothing', () => {
    const detail = journeyDetail(quotation(), S, TODAY);
    assert.deepEqual(detail.steps.map((s) => [s.key, s.label, s.state]), [['enquiry', 'Enquiry', 'skipped'], ['quotation', 'Quotation', 'current'], ['po', 'PO', 'future']]);
    assert.deepEqual(detail.steps[0], { key: 'enquiry', label: 'Enquiry', state: 'skipped', record: null, since: null, small: [], facts: [] });
    assert.deepEqual(detail.steps[1].record, { kind: 'quotation', no: 'Q-TEST-1', date: ago(3) });
    assert.equal(detail.steps[1].since, ago(3));
    assert.equal(detail.steps[1].small.length, 5);
    assert.equal(detail.key, 'q-1', 'the card is there too');
  });

  test('a done step keeps its small steps, so the drawer can open it', () => {
    const detail = journeyDetail(po({ enquiry_id: 1, enquiry_status: 'Converted', enquiry_created_at: ago(30) }), S, TODAY);
    assert.deepEqual(detail.steps.map((s) => s.small.length), [3, 5, 5]);
    assert.equal(detail.steps[0].since, ago(30));
  });

  test('Enquiry facts', () => {
    assert.deepEqual(stepFacts('enquiry', enquiry()), [
      { label: 'Received', value: ago(2), kind: 'date' },
      { label: 'Source', value: 'Referral', kind: 'text' },
      { label: 'Owner', value: 'Asha Rao', kind: 'text' },
      { label: 'Estimate', value: 450000, kind: 'money', currency: 'INR' },
      { label: 'Status', value: 'New', kind: 'text' },
    ]);
    const unqualified = stepFacts('enquiry', enquiry({ enquiry_status: 'Unqualified', enquiry_unqualified_reason: 'No budget this year' }));
    assert.deepEqual(unqualified.at(-1), { label: 'Unqualified because', value: 'No budget this year', kind: 'text' });
  });

  test('Quotation facts: what the client said while open, why it was lost once lost', () => {
    const labels = (row) => stepFacts('quotation', row).map((f) => f.label);
    assert.deepEqual(labels(quotation()), ['Quotation no.', 'Date', 'Value', 'Sent', 'Client said', 'Expected close']);
    assert.deepEqual(stepFacts('quotation', quotation())[4], { label: 'Client said', value: 'No answer yet', kind: 'text' });
    assert.deepEqual(stepFacts('quotation', quotation({ accepted_at: `${ago(1)}T09:00:00Z` }))[4], { label: 'Accepted on', value: ago(1), kind: 'date' });
    assert.deepEqual(labels(quotation({ stage_type: 'lost', lost_reason: 'Price' })), ['Quotation no.', 'Date', 'Value', 'Sent', 'Lost because']);
    assert.deepEqual(stepFacts('quotation', quotation())[3], { label: 'Sent', value: ago(2), kind: 'date' });
  });

  test('PO facts: the first PO and how many more, and the overdue sum in place of the next due date', () => {
    const facts = stepFacts('po', po({ po_count: 3, invoiced_total: 100, received_total: 50, next_stage_due: ago(-5) }));
    assert.deepEqual(facts.map((f) => [f.label, f.value]), [
      ['PO no.', 'PO-TEST-1 +2 more'], ['Registered', ago(4)], ['Value', 590000], ['Invoiced', 100], ['Received', 50], ['Next stage due', '2026-10-30'],
    ]);
    assert.deepEqual(stepFacts('po', po({ overdue_stages: 1, overdue_amount: 25000 })).at(-1), { label: 'Overdue', value: 25000, kind: 'money', currency: 'INR' });
    assert.equal(stepFacts('po', po())[0].value, 'PO-TEST-1');
    assert.deepEqual(journeyDetail(po({ po_count: 2 }), S, TODAY).steps[2].record, { kind: 'po', no: 'PO-TEST-1', date: ago(4), count: 2 });
  });

  test('POs in several currencies show no made-up sum', () => {
    const facts = stepFacts('po', po({ po_count: 2, po_currency: null, po_value_total: null }));
    assert.deepEqual(facts[2], { label: 'Value', value: 'In several currencies', kind: 'text' });
  });

  test('never more than six facts a step', () => {
    for (const [key, row] of [['enquiry', enquiry({ enquiry_status: 'Unqualified', enquiry_unqualified_reason: 'Timing' })],
      ['quotation', quotation({ accepted_at: `${ago(1)}T09:00:00Z`, stage_type: 'lost', lost_reason: 'Price' })],
      ['po', po({ overdue_stages: 1, overdue_amount: 1, po_count: 4 })]]) {
      assert.ok(stepFacts(key, row).length <= 6, key);
    }
  });
});
