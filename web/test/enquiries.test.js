import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoutes } from 'react-router';
import {
  CONVERTED, ENQUIRY_STATUSES, MOVE_LABELS, enquiryEvents, enquiryFields, enquiryMove, enquiryNote, enquiryReceived,
  enquirySectors, enquirySource, enquiryStatuses, enquiryTitle, enquiryTone, enquiryVerdict, followUpMissed,
  questionnaireLine, unqualifiedBecause,
} from '../src/lib/enquiries.js';
import { recordPath } from '../src/lib/journey.js';

/**
 * An enquiry as its list and its page describe it (web/src/lib/enquiries.js):
 * the one form both edit with, and the page's sentence and button
 * (docs/specs/sales-journey §4 E). The clients are made up.
 */

const LOOKUPS = {
  clients: ['Kestrel Polymers'],
  sectors: ['Chemicals'],
  services: ['ISO 9001 certification'],
  sales_people: ['Asha Rao'],
  lead_sources: [{ id: 3, name: 'Referral' }],
  lost_reasons: [{ id: 5, name: 'No budget' }],
  quotations: [{ quotation_no: 'Q-201', client_name: 'Kestrel Polymers', status: 'Draft' }],
  enums: { enquiry: ENQUIRY_STATUSES, currency: ['INR', 'USD'] },
};

const TODAY = '2026-10-25';

/** A new enquiry from a made-up client, nobody in touch yet. */
const fresh = {
  id: 9, enquiry_no: 'CTZ/ENQ/2026/031', enquiry_date: '2026-10-20', created_at: '2026-10-20T06:30:00Z',
  client_name: 'Kestrel Polymers', service: 'ISO 9001 certification', services_interested: null,
  status: 'New', sales_person: 'Asha Rao', source_id: 3, source: null,
  estimated_value: null, currency: 'INR', quotation_no: null, next_follow_up_at: null,
  first_responded_at: null, last_contacted_at: null, converted_at: null,
};

test('the form keeps every field the list had, in order', () => {
  assert.deepEqual(enquiryFields(LOOKUPS, null).map((f) => f.name), [
    'enquiry_no', 'enquiry_date', 'client_name', 'source', 'sector', 'country',
    'contact_person', 'contact_email', 'contact_phone', 'source_id', 'service', 'services_interested',
    'estimated_value', 'currency', 'sales_person', 'sales_person_email', 'status', 'next_follow_up_at',
    'expected_decision_date', 'unqualified_reason_id', 'unqualified_notes', 'quotation_no', 'notes',
  ]);
  const fields = Object.fromEntries(enquiryFields(LOOKUPS, null).map((f) => [f.name, f]));
  assert.equal(fields.enquiry_no.auto, 'enquiry', 'the server assigns the number');
  assert.deepEqual(fields.status.options, ENQUIRY_STATUSES);
  assert.deepEqual(fields.source_id.options, [{ value: '3', label: 'Referral' }]);
  assert.deepEqual(fields.quotation_no.options, [{ value: 'Q-201', label: 'Q-201 — Kestrel Polymers (Draft)' }]);
});

test('a linked quotation the lookups no longer offer is still the current choice', () => {
  const options = enquiryFields(LOOKUPS, { quotation_no: 'Q-150' }).find((f) => f.name === 'quotation_no').options;
  assert.deepEqual(options.map((o) => o.value), ['Q-150', 'Q-201']);
  const listed = enquiryFields(LOOKUPS, { quotation_no: 'Q-201' }).find((f) => f.name === 'quotation_no').options;
  assert.deepEqual(listed.map((o) => o.value), ['Q-201'], 'not offered twice');
});

test('statuses and sectors fall back while the lookups load', () => {
  assert.deepEqual(enquiryStatuses({}), ENQUIRY_STATUSES);
  assert.deepEqual(enquiryStatuses(LOOKUPS), ENQUIRY_STATUSES);
  assert.deepEqual(enquirySectors({ sectors: [] }), ['Agriculture', 'Metal Industry', 'Pharmaceutical', 'Other']);
  assert.deepEqual(enquirySectors(LOOKUPS), ['Chemicals']);
  assert.equal(enquiryFields({}, null).length, 23, 'the form draws before the lookups arrive');
});

test('the title is the client and what they asked for, or the client alone', () => {
  assert.equal(enquiryTitle(fresh), 'Kestrel Polymers · ISO 9001 certification');
  assert.equal(enquiryTitle({ ...fresh, service: null, services_interested: 'Training' }), 'Kestrel Polymers · Training');
  assert.equal(enquiryTitle({ ...fresh, service: null }), 'Kestrel Polymers');
});

test('received is the enquiry date as typed, else the day it was entered', () => {
  assert.equal(enquiryReceived(fresh), '20 Oct 2026');
  assert.equal(enquiryReceived({ ...fresh, enquiry_date: null }), '20 Oct 2026');
  assert.equal(enquiryReceived({ enquiry_date: null, created_at: null }), null);
});

test('the source is the one picked, else the one typed', () => {
  assert.equal(enquirySource(fresh, LOOKUPS), 'Referral');
  assert.equal(enquirySource({ ...fresh, source_id: null, source: 'Trade fair' }, LOOKUPS), 'Trade fair');
  assert.equal(enquirySource({ ...fresh, source_id: null }, LOOKUPS), null);
});

test('one move by state: a quotation wins, a qualified enquiry converts, the rest log a call', () => {
  assert.equal(enquiryMove({ ...fresh, status: 'Qualified', quotation_no: 'Q-201' }), 'open_quotation');
  assert.equal(enquiryMove({ ...fresh, status: CONVERTED, quotation_no: 'Q-201' }), 'open_quotation');
  assert.equal(enquiryMove({ ...fresh, status: 'Qualified' }), 'convert');
  assert.equal(enquiryMove({ ...fresh, status: CONVERTED, quotation_no: 'Q-201' }, { quotationOpens: false }), 'log_call',
    'someone else\'s quotation does not open, so the enquiry\'s own move is offered');
  for (const status of ['New', 'Contacted', 'Nurture', 'Unqualified', CONVERTED]) {
    assert.equal(enquiryMove({ ...fresh, status }), 'log_call', status);
  }
  assert.deepEqual(MOVE_LABELS, { open_quotation: 'Open the quotation', convert: 'Convert to quotation', log_call: 'Log a call' });
});

test('the small print follows the button', () => {
  assert.match(enquiryNote('convert'), /status set to "Converted"/);
  assert.match(enquiryNote('log_call'), /^Logging a call/);
  assert.match(enquiryNote('open_quotation'), /on the quotation/);
});

test('the sentence says what a new enquiry waits on, and who', () => {
  assert.equal(enquiryVerdict(fresh, LOOKUPS, TODAY), 'Received on 20 Oct 2026 and not answered yet: Asha Rao to make the first contact.');
  assert.equal(
    enquiryVerdict({ ...fresh, sales_person: null }, LOOKUPS, TODAY),
    'Received on 20 Oct 2026 and not answered yet, and nobody owns it yet.'
  );
  assert.equal(
    enquiryVerdict({ ...fresh, status: 'Contacted', first_responded_at: '2026-10-21T06:30:00Z' }, LOOKUPS, TODAY),
    'In touch since 21 Oct 2026. Qualify it once the services and what it is worth are known.'
  );
});

test('a qualified enquiry names what it is worth, and never ₹0', () => {
  const qualified = { ...fresh, status: 'Qualified', estimated_value: 450000 };
  assert.equal(enquiryVerdict(qualified, LOOKUPS, TODAY), 'Qualified: ISO 9001 certification, worth ₹4,50,000. Converting it starts the quotation.');
  assert.equal(
    enquiryVerdict({ ...qualified, estimated_value: null, service: null }, LOOKUPS, TODAY),
    'Qualified, with no estimate yet. Converting it starts the quotation.'
  );
  assert.match(enquiryVerdict({ ...qualified, currency: 'USD', estimated_value: 12000 }, LOOKUPS, TODAY), /worth \$12,000/);
});

test('an open enquiry says when its follow-up is, or that it was missed', () => {
  const nurture = { ...fresh, status: 'Nurture' };
  assert.equal(
    enquiryVerdict({ ...nurture, next_follow_up_at: '2026-11-02' }, LOOKUPS, TODAY),
    'Parked for later, to come back to when the client is ready. Next follow-up on 02 Nov 2026.'
  );
  assert.match(enquiryVerdict({ ...nurture, next_follow_up_at: TODAY }, LOOKUPS, TODAY), /The follow-up is due today\.$/);
  assert.match(enquiryVerdict({ ...nurture, next_follow_up_at: '2026-10-22' }, LOOKUPS, TODAY), /The follow-up due on 22 Oct 2026 was missed\.$/);

  assert.equal(followUpMissed({ ...nurture, next_follow_up_at: '2026-10-24' }, TODAY), true);
  assert.equal(followUpMissed({ ...nurture, next_follow_up_at: TODAY }, TODAY), false, 'today can still be made');
  assert.equal(followUpMissed({ ...nurture, next_follow_up_at: null }, TODAY), false);
  assert.equal(followUpMissed({ ...nurture, status: 'Unqualified', next_follow_up_at: '2026-10-01' }, TODAY), false, 'a closed enquiry owes no follow-up');
  assert.doesNotMatch(enquiryVerdict({ ...fresh, status: 'Unqualified', next_follow_up_at: '2026-10-01' }, LOOKUPS, TODAY), /follow-up/);
});

test('a dropped, a converted and a quoted enquiry each say where they ended', () => {
  const dropped = { ...fresh, status: 'Unqualified', unqualified_reason_id: 5, unqualified_notes: 'Back next year' };
  assert.equal(unqualifiedBecause(dropped, LOOKUPS), 'No budget — Back next year');
  assert.equal(unqualifiedBecause({ ...dropped, unqualified_reason_id: null }, LOOKUPS), 'Back next year');
  assert.equal(unqualifiedBecause({ ...dropped, unqualified_reason_id: null, unqualified_notes: null }, LOOKUPS), null);
  assert.equal(
    enquiryVerdict(dropped, LOOKUPS, TODAY),
    'Dropped as unqualified: No budget — Back next year. If the client comes back, set the status again with Edit.'
  );
  assert.equal(
    enquiryVerdict({ ...fresh, status: CONVERTED }, LOOKUPS, TODAY),
    'Marked converted, but no quotation is linked to it. Link the quotation with Edit.'
  );
  assert.equal(
    enquiryVerdict({ ...fresh, status: CONVERTED, quotation_no: 'Q-201', converted_at: '2026-10-23T06:30:00Z' }, LOOKUPS, TODAY),
    'Quoted as Q-201 on 23 Oct 2026. The quotation carries the sale from here.'
  );
  assert.equal(
    enquiryVerdict({ ...fresh, status: CONVERTED, quotation_no: 'Q-201' }, LOOKUPS, TODAY, { quotationOpens: false }),
    'Quoted as Q-201. The quotation carries the sale from here. Someone else owns the quotation, so it opens for them.'
  );
});

test('the status chip is word and tone: converted settled, unqualified late, the rest information', () => {
  assert.equal(enquiryTone(CONVERTED), 'settled');
  assert.equal(enquiryTone('Unqualified'), 'late');
  for (const status of ['New', 'Contacted', 'Qualified', 'Nurture']) assert.equal(enquiryTone(status), 'info', status);
});

test('the rail lists what has happened, and leaves out what has not', () => {
  assert.deepEqual(enquiryEvents(fresh, LOOKUPS), [{ what: 'Received', when: '20 Oct 2026', detail: 'Via Referral' }]);
  const moved = {
    ...fresh, status: CONVERTED, quotation_no: 'Q-201',
    first_responded_at: '2026-10-21T06:30:00Z', last_contacted_at: '2026-10-22T06:30:00Z', converted_at: '2026-10-23T06:30:00Z',
  };
  assert.deepEqual(enquiryEvents(moved, LOOKUPS).map((e) => [e.what, e.when]), [
    ['Received', '20 Oct 2026'], ['First reply', '21 Oct 2026'], ['Last in touch', '22 Oct 2026'], ['Converted', '23 Oct 2026'],
  ]);
  assert.equal(enquiryEvents(moved, LOOKUPS)[3].detail, 'Quoted as Q-201');
  assert.deepEqual(enquiryEvents(null, LOOKUPS), []);
});

test('the questionnaire line follows its status', () => {
  assert.equal(questionnaireLine(null).button, 'Send the questionnaire');
  assert.match(questionnaireLine('submitted').text, /^The client has answered/);
  for (const status of ['not_started', 'in_progress', 'reopened']) assert.match(questionnaireLine(status).text, /^Sent, and waiting on the client/, status);
  assert.equal(questionnaireLine('in_progress').button, 'Open the questionnaire');
});

test('a link to an enquiry reaches its page with the number whole, slashes and spaces included', () => {
  const routes = [{ path: '/enquiries' }, { path: '/enquiries/:key' }];
  for (const no of ['CTZ/ENQ/2026/031', 'ENQ 77/A', '4530056073']) {
    const match = matchRoutes(routes, recordPath('enquiry', no));
    assert.equal(match?.at(-1).route.path, '/enquiries/:key', no);
    assert.equal(match.at(-1).params.key, no);
  }
});
