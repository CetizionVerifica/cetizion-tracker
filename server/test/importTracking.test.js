import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, newText } from '../src/import/rules.js';
import { heuristicMapping } from '../src/import/fields.js';

/**
 * Bulk import keeps a deal's history: the sheet's remarks and follow-up
 * comments go to the deal's timeline, the last follow-up is its last
 * contact, the next follow-up a reminder; and the same sheet uploaded again
 * a week later updates the deals it wrote, adding only what is new.
 */

const HEADERS = ['S.No', 'Client Name', 'Deal Stage', 'Proposal Name', 'Proposal Sent Date', 'Quoted Price', 'Sales Person',
  'Last Follow up', 'Next Follow up', 'Follow up Comments', 'Remarks'];
const mapping = heuristicMapping(HEADERS);
const row = (n, values) => ({ __row: n + 1, ...Object.fromEntries(HEADERS.map((h, i) => [h, values[i] ?? null])) });
const empty = () => ({ quotations: [], purchase_orders: [], projects: [], services: [], stages: [], next_quotation_no: 1, next_project_no: 1, year: 2026, today: '2026-09-25' });
const quote = (plan, client) => plan.items.find((i) => i.step === 'quotation' && i.payload.client_name === client);

test('the follow-up columns are recognised: last and next follow-up dates, and the comments', () => {
  assert.equal(mapping.last_follow_up, 'Last Follow up');
  assert.equal(mapping.next_follow_up, 'Next Follow up');
  assert.equal(mapping.follow_up, 'Follow up Comments');
  assert.equal(mapping.remarks, 'Remarks');
});

test('only what the tracker has not heard is new: unchanged text is nothing, appended text is the addition', () => {
  assert.equal(newText('Reminder sent', 'Reminder sent'), null);
  assert.equal(newText('Reminder sent | 25-Sep: asked for revision', 'Reminder sent'), '25-Sep: asked for revision');
  assert.equal(newText('Client asked for a call', 'Reminder sent'), 'Client asked for a call');
  assert.equal(newText('Reminder sent', null, ['follow-up: reminder sent']), null);
  assert.equal(newText(null, 'x'), null);
});

test("a new deal's remarks and follow-ups become timeline notes, its next follow-up a reminder for the salesperson", () => {
  const plan = buildPlan({ rows: [
    row(1, [1, 'Demo Alpha', 'Proposal sent', 'GHG inventory', '01-Sep-2026', 450000, 'Rohan', '20-Sep-2026', '02-Oct-2026', 'Reminder sent', 'Client wants a call']),
    row(2, [2, 'Demo Beta', 'Lost', 'LCA', '01-Aug-2026', 300000, 'Rohan', null, '05-Oct-2026', null, 'Went with a competitor']),
    row(3, [3, 'Demo Gamma', 'Negotiation', 'EcoVadis', '01-Aug-2026', 200000, 'Asha', null, '10-Apr-2026', 'Awaiting revised scope', null]),
  ], mapping, live: empty() });

  const alpha = quote(plan, 'Demo Alpha');
  assert.deepEqual(alpha.payload.tracking.notes, ['Remarks: Client wants a call', 'Follow-up: Reminder sent']);
  assert.equal(alpha.payload.tracking.last_contacted, '2026-09-20');
  assert.equal(alpha.payload.tracking.next_step, 'Reminder sent');
  assert.deepEqual(alpha.payload.tracking.follow_up, { due: '2026-10-02', title: 'Follow up Demo Alpha – GHG inventory', description: 'Reminder sent', assignee: 'Rohan' });
  assert.ok(alpha.flags.some((f) => f.code === 'follow_up' && /2026-10-02 for Rohan/.test(f.message)));
  assert.ok(alpha.flags.some((f) => f.code === 'timeline' && /2 notes/.test(f.message)));

  // A lost deal gets no reminder; a follow-up date already past is said, not set.
  assert.equal(quote(plan, 'Demo Beta').payload.tracking.follow_up, null);
  const gamma = quote(plan, 'Demo Gamma');
  assert.equal(gamma.payload.tracking.follow_up, null);
  assert.ok(gamma.flags.some((f) => f.code === 'follow_up_past'));
});

test('the same sheet a week later updates the deal it wrote, with only the new remark and the moved reminder', () => {
  const live = {
    ...empty(),
    today: '2026-10-01',
    quotations: [{ id: 7, quotation_no: 'CTZ/QT/2026/001', client_name: 'Demo Alpha', service_quoted: 'GHG inventory', quotation_date: '2026-09-01',
      status: 'Submitted', project_id: null, quotation_value: '450000.00', contact_person: null, sales_person: 'Rohan', currency: 'INR',
      remarks: 'Reminder sent | Client wants a call | Imported from S.No 1', next_step: 'Reminder sent', last_contacted_at: '2026-09-20' }],
    trail: { 'CTZ/QT/2026/001': { remarks: 'Client wants a call', follow_up: 'Reminder sent', legacy: 'Reminder sent | Client wants a call | Imported from S.No 1', remarks_field: 'Reminder sent | Client wants a call | Imported from S.No 1',
      // What last week's sheet said, which is what the route now keeps.
      was: { status: 'Submitted', quotation_value: 450000, currency: 'INR', quotation_date: '2026-09-01', contact_person: null, sales_person: 'Rohan', service_quoted: 'GHG inventory' } } },
    follow_up_tasks: { 'CTZ/QT/2026/001': { id: 3, due_at: '2026-10-02' } },
    sheet_notes: { 'CTZ/QT/2026/001': ['Remarks: Client wants a call', 'Follow-up: Reminder sent'] },
  };
  const plan = buildPlan({ rows: [
    row(1, [1, 'Demo Alpha', 'Negotiation', 'GHG inventory', '01-Sep-2026', 420000, 'Rohan', '27-Sep-2026', '06-Oct-2026',
      'Reminder sent | 27-Sep: asked for 5% discount', 'Client wants a call']),
  ], mapping, live });

  const q = quote(plan, 'Demo Alpha');
  assert.equal(q.existing_ref, 'CTZ/QT/2026/001');
  assert.ok(q.flags.some((f) => f.code === 'duplicate' && /from an earlier upload/.test(f.message)));
  // Recognised for certain, so the sheet's changes are applied by default.
  assert.equal(q.action, 'update');
  const changed = q.flags.find((f) => f.code === 'sheet_changes');
  assert.deepEqual(changed.changes.map((c) => c.field), ['status', 'quotation_value']);
  assert.deepEqual(q.payload.tracking.notes, ['Follow-up: 27-Sep: asked for 5% discount']);
  assert.equal(q.payload.tracking.last_contacted, '2026-09-27');
  assert.equal(q.payload.tracking.follow_up.due, '2026-10-06');
  assert.ok(q.flags.some((f) => f.code === 'follow_up' && /moves from 2026-10-02 to 2026-10-06/.test(f.message)));

  // Switched off, the deal keeps its values and the review says what the sheet changed.
  const kept = quote(buildPlan({ rows: [row(1, [1, 'Demo Alpha', 'Negotiation', 'GHG inventory', '01-Sep-2026', 420000, 'Rohan'])], mapping, live, rules: { update_from_sheet: false } }), 'Demo Alpha');
  assert.equal(kept.action, 'skip');
  assert.ok(kept.flags.some((f) => f.code === 'status_differs' && /stage Submitted → Under Negotiation/.test(f.message)));
});

test('a sheet never moves a won deal back, and an unchanged row changes nothing', () => {
  const won = { ...empty(), trail: { 'CTZ/QT/2026/002': {} }, quotations: [{ id: 8, quotation_no: 'CTZ/QT/2026/002', client_name: 'Demo Delta', service_quoted: 'BRSR',
    quotation_date: '2026-08-01', status: 'Won - PO Received', project_id: null, quotation_value: '100000', contact_person: null, sales_person: 'Asha', currency: 'INR' }] };
  const q = quote(buildPlan({ rows: [row(1, [1, 'Demo Delta', 'Proposal sent', 'BRSR', '01-Aug-2026', 100000, 'Asha'])], mapping, live: won }), 'Demo Delta');
  assert.equal(q.action, 'skip');
  assert.ok(q.flags.some((f) => f.code === 'status_differs' && /Kept as won/.test(f.message)));

  const same = { ...won, quotations: [{ ...won.quotations[0], status: 'Submitted' }] };
  const unchanged = quote(buildPlan({ rows: [row(1, [1, 'Demo Delta', 'Proposal sent', 'BRSR', '01-Aug-2026', 100000, 'Asha'])], mapping, live: same }), 'Demo Delta');
  assert.equal(unchanged.action, 'skip');
  assert.equal(unchanged.flags.some((f) => f.code === 'sheet_changes' || f.code === 'status_differs'), false);
});

test('an ISO proposal is left out however it is written, and a word starting ISO- is not one (#23)', () => {
  const plan = buildPlan({ rows: [
    row(1, [1, 'Iso One', 'Proposal sent', 'ISO9001 certification', '01-Sep-2026', 100000, 'Rohan']),
    row(2, [2, 'Iso Two', 'Proposal sent', 'iso 14001', '01-Sep-2026', 100000, 'Rohan']),
    row(3, [3, 'Not Iso', 'Proposal sent', 'Isokinetic sampling', '01-Sep-2026', 100000, 'Rohan']),
  ], mapping, live: empty() });
  assert.deepEqual(plan.skipped.map((s) => [s.client, s.reason]), [['Iso One', 'ISO proposal'], ['Iso Two', 'ISO proposal']]);
  assert.ok(quote(plan, 'Not Iso'));
});

/**
 * The bug this pair of tests exists for: comparing the sheet against the
 * tracker alone cannot tell "the sheet moved" from "somebody corrected the
 * tracker", and it always read the second as the first.
 */
test('a re-upload leaves alone what somebody changed in the tracker since', () => {
  const live = {
    ...empty(),
    today: '2026-10-01',
    // Sales corrected the value and advanced the stage on Wednesday.
    quotations: [{ id: 7, quotation_no: 'CTZ/QT/2026/001', client_name: 'Demo Alpha', service_quoted: 'GHG inventory', quotation_date: '2026-09-01',
      status: 'Under Negotiation', project_id: null, quotation_value: '500000.00', contact_person: null, sales_person: 'Rohan', currency: 'INR',
      remarks: null, next_step: null, last_contacted_at: null }],
    trail: { 'CTZ/QT/2026/001': {
      // The sheet still says what it said last week.
      was: { status: 'Submitted', quotation_value: 450000, currency: 'INR', quotation_date: '2026-09-01', contact_person: null, sales_person: 'Rohan', service_quoted: 'GHG inventory' },
    } },
  };
  const plan = buildPlan({ rows: [
    row(1, [1, 'Demo Alpha', 'Proposal submitted', 'GHG inventory', '01-Sep-2026', 450000, 'Rohan', '', '', '', '']),
  ], mapping, live });

  const q = quote(plan, 'Demo Alpha');
  assert.equal(q.existing_ref, 'CTZ/QT/2026/001');
  assert.notEqual(q.action, 'update', 'an unchanged sheet has nothing to apply');
  assert.equal(q.payload.__update_fields, undefined, 'and nothing for the commit to write');
  const ahead = q.flags.find((f) => f.code === 'tracker_ahead');
  assert.ok(ahead, 'it says the tracker moved rather than silently putting it back');
  assert.deepEqual(ahead.changes.map((c) => c.field).sort(), ['quotation_value', 'status']);
});

test('when both moved, the person wins and is told', () => {
  const live = {
    ...empty(),
    today: '2026-10-01',
    quotations: [{ id: 7, quotation_no: 'CTZ/QT/2026/001', client_name: 'Demo Alpha', service_quoted: 'GHG inventory', quotation_date: '2026-09-01',
      status: 'Submitted', project_id: null, quotation_value: '500000.00', contact_person: null, sales_person: 'Rohan', currency: 'INR',
      remarks: null, next_step: null, last_contacted_at: null }],
    trail: { 'CTZ/QT/2026/001': {
      was: { status: 'Submitted', quotation_value: 450000, currency: 'INR', quotation_date: '2026-09-01', contact_person: null, sales_person: 'Rohan', service_quoted: 'GHG inventory' },
    } },
  };
  // The sheet moved the value too, to a third number.
  const plan = buildPlan({ rows: [
    row(1, [1, 'Demo Alpha', 'Negotiation', 'GHG inventory', '01-Sep-2026', 470000, 'Rohan', '', '', '', '']),
  ], mapping, live });

  const q = quote(plan, 'Demo Alpha');
  const both = q.flags.find((f) => f.code === 'both_changed');
  assert.ok(both, 'a disagreement between a person and a spreadsheet is worth a warning');
  assert.deepEqual(both.changes.map((c) => c.field), ['quotation_value']);
  // The stage only moved on the sheet, so that one is still the sheet's.
  assert.deepEqual(q.payload.__update_fields, ['status']);
  assert.ok(!q.payload.__update_fields.includes('quotation_value'), "the person's number is not overwritten");
});

test('a row with no service matches the deal it already made, instead of making another', () => {
  const live = {
    ...empty(),
    today: '2026-10-01',
    quotations: [{ id: 9, quotation_no: 'CTZ/QT/2026/009', client_name: 'Demo Beta', service_quoted: null, quotation_date: '2026-09-05',
      status: 'Submitted', project_id: null, quotation_value: '250000.00', contact_person: null, sales_person: 'Rohan', currency: 'INR',
      remarks: null, next_step: null, last_contacted_at: null }],
  };
  const plan = buildPlan({ rows: [
    row(1, [1, 'Demo Beta', 'Proposal submitted', '', '05-Sep-2026', 250000, 'Rohan', '', '', '', '']),
  ], mapping, live });

  const q = quote(plan, 'Demo Beta');
  assert.equal(q.existing_ref, 'CTZ/QT/2026/009', 'the weekly sheet must not create a second copy every upload');
  assert.notEqual(q.action, 'create');
  // Client and date is a weaker claim than client and service, so it may
  // point at a duplicate but never quietly rewrite one.
  assert.ok(q.flags.some((f) => f.code === 'duplicate'));
  assert.equal(q.payload.__update_fields, undefined);
});
