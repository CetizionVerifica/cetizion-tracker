import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWorkingDays } from '../src/lib/businessDate.ts';
import { closedReason, dueInfo, planFollowUps, readSettings, uniqueAddresses } from '../src/lib/followUps.js';

// The rules behind follow-up reminders and escalation; none of these needs a
// database. IDs match docs/follow-up-escalation-test-plan.md §4 and §5.
//
//           Sep 2026                       Oct 2026
// Mo Tu We Th Fr Sa Su            Mo Tu We Th Fr Sa Su
// 28 29 30                                 1  2  3  4
//                                  5  6  7  8  9 10 11
//                                 12 13 14 15 16 17 18

const HOLIDAY = '2026-10-02';
const settings = readSettings({});

const asha = { owner_user_id: 1, owner_email: 'asha@qa.example', owner_name: 'Asha', owner_active: true };
const ben = { owner_user_id: 2, owner_email: 'ben@qa.example', owner_name: 'Ben', owner_active: true };

const enquiry = (x = {}) => ({ entity: 'enquiry', entity_id: 'ENQ-1', status: 'Contacted', next_follow_up_at: '2026-10-05',
  enquiry_date: '2026-09-20', created_at: '2026-09-20T05:00:00Z', ...asha, ...x });
const quotation = (x = {}) => ({ entity: 'quotation', entity_id: 'Q-1', status: 'Submitted', sent_at: '2026-09-28T06:00:00Z',
  accepted_at: null, closed_at: null, ...asha, ...x });
const invoice = (x = {}) => ({ entity: 'payment_stage', entity_id: '7', invoice_no: 'CVPL/26-27/40', stage_status: 'Overdue',
  invoice_due_date: '2026-09-20', days_overdue: 15, on_hold: false, promise_to_pay_date: null, amount: 120000, currency: 'INR', ...asha, ...x });
const cycle = (x = {}) => ({ id: 1, entity: 'enquiry', entity_id: 'ENQ-1', due_on: '2026-10-05', reminded_user_id: 1,
  reminded_at: '2026-10-05T03:45:00Z', respond_by: '2026-10-07', escalated_at: null, last_escalated_on: null, escalation_count: 0, ...x });

/** Due today? With an optional last activity (ISO) and holidays. */
const isDue = (rec, today, { activity = null, holidays = [] } = {}) => {
  if (closedReason(rec, today)) return null;
  return dueInfo(rec, activity ? activity.slice(0, 10) : null, { today, settings, holidays });
};
const plan = (records, open = [], today = '2026-10-05', { activity = {}, holidays = [], raw = {} } = {}) =>
  planFollowUps({ records, open, activity: new Map(Object.entries(activity)), today, settings: raw, holidays });

// ------------------------------------------------------------ §4 due rules

test('U-D01/02: an enquiry is due on its follow-up date, not before', () => {
  assert.equal(isDue(enquiry(), '2026-10-05').due_on, '2026-10-05');
  assert.equal(isDue(enquiry(), '2026-10-02'), null);
});

test('U-D03: a touch logged on the follow-up date, before the run, means it happened', () => {
  // 02:00 UTC is 07:30 in Mumbai on the 5th.
  assert.equal(isDue(enquiry(), '2026-10-05', { activity: '2026-10-05T02:00:00Z' }), null);
});

test('U-D04/05: every open status can be due; Converted and Unqualified never are', () => {
  for (const status of ['New', 'Contacted', 'Qualified', 'Nurture']) assert.ok(isDue(enquiry({ status }), '2026-10-05'), status);
  for (const status of ['Converted', 'Unqualified']) assert.equal(isDue(enquiry({ status }), '2026-10-05'), null, status);
});

test('U-D06/07: an enquiry with no date is due after 3 quiet working days, later with a holiday', () => {
  const e = enquiry({ next_follow_up_at: null, enquiry_date: '2026-09-30', created_at: '2026-09-30T05:00:00Z' });
  assert.equal(isDue(e, '2026-10-05').due_on, '2026-10-05');
  assert.equal(isDue(e, '2026-10-05', { holidays: [HOLIDAY] }), null);
  assert.equal(isDue(e, '2026-10-06', { holidays: [HOLIDAY] }).due_on, '2026-10-06');
});

test('U-D08: activity two working days ago keeps an undated enquiry quiet', () => {
  const e = enquiry({ next_follow_up_at: null, enquiry_date: '2026-09-01', created_at: '2026-09-01T05:00:00Z' });
  assert.equal(isDue(e, '2026-10-05', { activity: '2026-10-01T06:00:00Z' }), null);
});

test('U-Q01/02: a quotation sent and left for 5 working days is due; a holiday pushes it a day', () => {
  assert.equal(isDue(quotation(), '2026-10-05').due_on, '2026-10-05');
  assert.equal(isDue(quotation(), '2026-10-05', { holidays: [HOLIDAY] }), null);
  assert.equal(isDue(quotation(), '2026-10-06', { holidays: [HOLIDAY] }).due_on, '2026-10-06');
});

test('U-Q03: a touch restarts the count', () => {
  const q = quotation({ status: 'Under Negotiation' });
  const activity = '2026-10-01T06:00:00Z';
  assert.equal(isDue(q, '2026-10-07', { activity }), null);
  assert.equal(isDue(q, '2026-10-08', { activity }).due_on, '2026-10-08');
  assert.equal(isDue(q, '2026-10-08', { activity, holidays: [HOLIDAY] }), null);
  assert.equal(isDue(q, '2026-10-09', { activity, holidays: [HOLIDAY] }).due_on, '2026-10-09');
});

test('U-Q04/05: never sent, accepted, closed or decided quotations are never due', () => {
  assert.equal(isDue(quotation({ sent_at: null }), '2026-10-05'), null);
  assert.equal(isDue(quotation({ accepted_at: '2026-09-30T05:00:00Z' }), '2026-10-05'), null);
  assert.equal(isDue(quotation({ closed_at: '2026-09-30T05:00:00Z' }), '2026-10-05'), null);
  for (const status of ['Won - PO Received', 'Lost', 'On Hold', 'Draft']) assert.equal(isDue(quotation({ status }), '2026-10-05'), null, status);
});

test('U-I01/02/03: an overdue invoice is due when nobody has chased it; a recent chase keeps it quiet', () => {
  assert.ok(isDue(invoice(), '2026-10-05'));
  assert.equal(isDue(invoice(), '2026-10-05', { activity: '2026-10-01T06:00:00Z' }), null);
  assert.ok(isDue(invoice({ stage_status: 'Partially Paid', amount: 40000 }), '2026-10-05'));
});

test('U-I04/05: on hold or promised is never due; a promise in the past is', () => {
  assert.equal(isDue(invoice({ on_hold: true }), '2026-10-05'), null);
  assert.equal(isDue(invoice({ promise_to_pay_date: '2026-10-05' }), '2026-10-05'), null);
  assert.equal(isDue(invoice({ promise_to_pay_date: '2026-10-06' }), '2026-10-05'), null);
  assert.ok(isDue(invoice({ promise_to_pay_date: '2026-10-04' }), '2026-10-05'));
});

test('U-I06/07/08: no invoice yet, not overdue long enough, or paid is never due', () => {
  assert.equal(isDue(invoice({ invoice_no: null, stage_status: 'To Invoice' }), '2026-10-05'), null);
  assert.equal(isDue(invoice({ days_overdue: 0 }), '2026-10-05'), null);
  assert.equal(isDue(invoice({ stage_status: 'Paid' }), '2026-10-05'), null);
});

test('U-S01: a blank, non-numeric or negative setting uses its default', () => {
  for (const v of ['', 'abc', '-1', '2.5']) {
    const s = readSettings({ followup_grace_days: v, followup_enquiry_idle_days: v });
    assert.equal(s.followup_grace_days, 2, `grace ${v}`);
    assert.equal(s.followup_enquiry_idle_days, 3, `enquiry idle ${v}`);
  }
  assert.equal(readSettings({ followup_grace_days: '4' }).followup_grace_days, 4);
  assert.equal(readSettings({ followup_grace_days: '0' }).followup_grace_days, 0);
  assert.equal(readSettings({}).followup_enabled, false);
  assert.equal(readSettings({ followup_enabled: 'true' }).followup_enabled, true);
});

test('U-S02: a weekend or a holiday does nothing', () => {
  assert.equal(plan([enquiry()], [], '2026-10-03').skipped_reason, 'not a working day');
  const p = plan([enquiry({ next_follow_up_at: '2026-10-01' })], [], HOLIDAY, { holidays: [HOLIDAY] });
  assert.equal(p.skipped_reason, 'not a working day');
  assert.deepEqual(p.remind, []);
});

// --------------------------------------------------------------- §5 cycle

test('U-C01: due, no open cycle, owner can be emailed: remind', () => {
  const p = plan([enquiry()]);
  assert.equal(p.remind.length, 1);
  assert.equal(p.remind[0].owner_email, 'asha@qa.example');
  assert.deepEqual(p.remind[0].items.map((i) => i.key), ['enquiry:ENQ-1']);
});

test('U-C02/03/04: inside grace nothing happens; the day after respond-by escalates', () => {
  for (const today of ['2026-10-06', '2026-10-07']) {
    const p = plan([enquiry()], [cycle()], today);
    assert.deepEqual([p.remind, p.escalate, p.resolve], [[], [], []], today);
  }
  const p = plan([enquiry()], [cycle()], '2026-10-08');
  assert.deepEqual(p.escalate.map((e) => e.cycle.id), [1]);
});

test('U-C05: a holiday moves respond-by, and the escalation with it', () => {
  const respondBy = addWorkingDays('2026-10-01', settings.followup_grace_days, [HOLIDAY]);
  assert.equal(respondBy, '2026-10-06');
  const c = cycle({ reminded_at: '2026-10-01T03:45:00Z', respond_by: respondBy, due_on: '2026-10-01' });
  const e = enquiry({ next_follow_up_at: '2026-10-01' });
  assert.equal(plan([e], [c], '2026-10-06', { holidays: [HOLIDAY] }).escalate.length, 0);
  assert.equal(plan([e], [c], '2026-10-07', { holidays: [HOLIDAY] }).escalate.length, 1);
});

test('U-C06/08: activity after the reminder resolves the cycle, whoever logged it', () => {
  const p = plan([enquiry()], [cycle()], '2026-10-08', { activity: { 'enquiry:ENQ-1': '2026-10-06T11:00:00Z' } });
  assert.deepEqual(p.resolve, [{ id: 1, key: 'enquiry:ENQ-1', reason: 'activity' }]);
  assert.deepEqual(p.escalate, []);
});

test('U-C07: activity before the reminder does not resolve it', () => {
  const p = plan([enquiry()], [cycle()], '2026-10-06', { activity: { 'enquiry:ENQ-1': '2026-10-05T03:00:00Z' } });
  assert.deepEqual(p.resolve, []);
});

test('U-C09/10: an escalated item is listed again after 5 working days', () => {
  const c = cycle({ escalated_at: '2026-10-08T03:45:00Z', last_escalated_on: '2026-10-08', escalation_count: 1 });
  assert.deepEqual(plan([enquiry()], [c], '2026-10-14').reescalate, []);
  const p = plan([enquiry()], [c], '2026-10-15');
  assert.equal(p.reescalate.length, 1);
  assert.equal(p.reescalate[0].cycle.escalation_count, 1);   // the runner adds one
});

test('U-C11: an escalated item resolves on activity', () => {
  const c = cycle({ escalated_at: '2026-10-08T03:45:00Z', last_escalated_on: '2026-10-08', escalation_count: 1 });
  const p = plan([enquiry()], [c], '2026-10-09', { activity: { 'enquiry:ENQ-1': '2026-10-08T10:00:00Z' } });
  assert.deepEqual(p.resolve.map((r) => r.reason), ['activity']);
});

test('U-C12..15: a closed, paid, held or promised record resolves with that reason', () => {
  assert.equal(plan([enquiry({ status: 'Converted' })], [cycle()]).resolve[0].reason, 'closed');
  const ic = cycle({ entity: 'payment_stage', entity_id: '7' });
  assert.equal(plan([invoice({ stage_status: 'Paid' })], [ic]).resolve[0].reason, 'paid');
  assert.equal(plan([invoice({ on_hold: true })], [ic]).resolve[0].reason, 'on_hold');
  assert.equal(plan([invoice({ promise_to_pay_date: '2026-10-20' })], [ic]).resolve[0].reason, 'promised');
  // Gone from the database altogether.
  assert.equal(plan([], [cycle()]).resolve[0].reason, 'closed');
});

test('U-C16: moving the follow-up date later with no touch resolves as rescheduled', () => {
  const p = plan([enquiry({ next_follow_up_at: '2026-10-12' })], [cycle()], '2026-10-06');
  assert.deepEqual(p.resolve.map((r) => r.reason), ['rescheduled']);
});

test('U-C17: reassigned: the old cycle closes and the new owner is reminded on the same run', () => {
  const p = plan([enquiry({ ...ben })], [cycle()], '2026-10-06');
  assert.deepEqual(p.resolve.map((r) => r.reason), ['reassigned']);
  assert.equal(p.remind.length, 1);
  assert.equal(p.remind[0].owner_email, 'ben@qa.example');
});

test('U-C18/19: no owner, an inactive owner or one without an email goes straight to management', () => {
  for (const owner of [{ owner_user_id: null, owner_email: null, owner_name: null }, { owner_user_id: 9, owner_email: 'ravi@qa.example', owner_name: 'Ravi', owner_active: false }, { owner_email: null }]) {
    const p = plan([enquiry(owner)]);
    assert.deepEqual(p.remind, []);
    assert.deepEqual(p.unowned.map((i) => i.key), ['enquiry:ENQ-1']);
    assert.equal(p.unowned[0].owner_user_id, null);
  }
});

test('U-C20: an unowned cycle is not listed again until the re-escalation interval', () => {
  const c = cycle({ reminded_user_id: null, reminded_at: null, respond_by: null, escalated_at: '2026-10-05T03:45:00Z', last_escalated_on: '2026-10-05', escalation_count: 1 });
  const e = enquiry({ owner_user_id: null, owner_email: null, owner_name: null });
  const next = plan([e], [c], '2026-10-06');
  assert.deepEqual([next.unowned, next.reescalate, next.resolve], [[], [], []]);
  assert.equal(plan([e], [c], '2026-10-12').reescalate.length, 1);
});

test('U-C21: a stale reminder after the feature was off resolves as disabled, not a burst', () => {
  const c = cycle({ reminded_at: '2026-09-01T03:45:00Z', respond_by: '2026-09-03', due_on: '2026-09-01' });
  const p = plan([enquiry()], [c], '2026-10-05');
  assert.deepEqual(p.resolve.map((r) => r.reason), ['disabled']);
  assert.deepEqual(p.escalate, []);
  // Still due, so it starts again with a fresh reminder.
  assert.equal(p.remind.length, 1);
});

test('U-C22: reminders are one per owner', () => {
  const p = plan([enquiry(), quotation(), enquiry({ entity_id: 'ENQ-2', ...ben })]);
  assert.deepEqual(p.remind.map((g) => [g.owner_name, g.items.length]), [['Asha', 2], ['Ben', 1]]);
});

test('U-C23: an item already reminded is not reminded again; it is listed as still waiting', () => {
  const p = plan([enquiry(), quotation()], [cycle()], '2026-10-06');
  assert.deepEqual(p.remind[0].items.map((i) => i.key), ['quotation:Q-1']);
  assert.deepEqual(p.remind[0].waiting.map((i) => i.key), ['enquiry:ENQ-1']);
  assert.equal(p.remind[0].waiting[0].respond_by, '2026-10-07');
});

test('U-C24: the same input gives the same output, whatever its order', () => {
  const records = [enquiry(), quotation(), invoice(), enquiry({ entity_id: 'ENQ-2', ...ben }), quotation({ entity_id: 'Q-2', owner_user_id: null, owner_email: null })];
  const a = plan(records);
  const b = plan([...records].reverse());
  assert.deepEqual(a, b);
  assert.deepEqual(a.remind.map((g) => g.owner_name), ['Asha', 'Ben']);
});

test('management addresses are de-duplicated without regard to case', () => {
  assert.deepEqual(uniqueAddresses(['meera@qa.example', 'md@qa.example', 'Meera@QA.example']), ['meera@qa.example', 'md@qa.example']);
});
