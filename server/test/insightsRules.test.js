import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGEING_BUCKETS, ageingBucketOf, followUpBandOf, parseDayRange } from '../src/lib/ageing.js';
import { compareRisk, enquiryRisk, readRiskSettings } from '../src/lib/enquiryRisk.js';
import { periodOf, rollUp } from '../src/lib/periods.js';
import { insightsScope, readOptions, windowMonths } from '../src/lib/insights.js';

// The rules behind Insights (docs/insights-dashboard-plan.md §7); none of
// these needs a database.
//
//           Sep 2026                       Oct 2026
// Mo Tu We Th Fr Sa Su            Mo Tu We Th Fr Sa Su
// 21 22 23 24 25 26 27                     1  2  3  4
// 28 29 30                         5  6  7  8  9 10 11
//                                 12 13 14 15 16 17 18

const TODAY = '2026-10-06'; // a Tuesday
const HOLIDAY = '2026-10-02';
const settings = readRiskSettings({});

const enquiry = (x = {}) => ({
  entity: 'enquiry', entity_id: 'ENQ-1', number: 'ENQ-1', status: 'New', enquiry_date: '2026-10-05', created_at: '2026-10-05T05:00:00Z',
  next_follow_up_at: null, next_task_due: null, first_responded_at: null, expected_decision_date: null, quotation_no: null, ...x,
});
const risk = (rec, x = {}) => enquiryRisk(rec, { today: TODAY, settings, holidays: [HOLIDAY], ...x });
const reasons = (r) => (r ? r.reasons.map((x) => x.reason) : []);

/* ------------------------------------------------------------ enquiry risk */

test('IR-01: a new enquiry waits one working day for a reply before it is at risk', () => {
  assert.equal(risk(enquiry({ enquiry_date: '2026-10-05' })), null, 'came in yesterday: one working day, not more');
  const r = risk(enquiry({ enquiry_date: '2026-10-01' }));
  // Thu 1 -> Tue 6 is Mon 5 and Tue 6 (Fri 2 is a holiday, then a weekend): two working days.
  assert.deepEqual(reasons(r), ['no_reply']);
  assert.equal(r.days_late, 1);
});

test('IR-02: weekends and holidays do not count towards the reply window', () => {
  // Fri 2 Oct is a holiday, so an enquiry on Thursday has waited only Mon and Tue.
  assert.equal(risk(enquiry({ enquiry_date: '2026-10-01' }), { holidays: [HOLIDAY], settings: readRiskSettings({ enquiry_reply_days: '2' }) }), null);
  // Without the holiday, Fri, Mon and Tue are three working days.
  assert.deepEqual(reasons(risk(enquiry({ enquiry_date: '2026-10-01' }), { holidays: [], settings: readRiskSettings({ enquiry_reply_days: '2' }) })), ['no_reply']);
});

test('IR-03: a reply recorded on the enquiry or found in the activity clears no_reply', () => {
  assert.equal(risk(enquiry({ enquiry_date: '2026-09-28', first_responded_at: '2026-09-28T09:00:00Z' }), { lastActivityOn: '2026-10-05' }), null);
  assert.equal(risk(enquiry({ enquiry_date: '2026-09-28' }), { firstOutboundOn: '2026-09-29', lastActivityOn: '2026-10-05' }), null);
});

test('IR-04: a follow-up date that has come with nothing logged since is missed', () => {
  const rec = enquiry({ status: 'Contacted', enquiry_date: '2026-09-21', first_responded_at: '2026-09-21T09:00:00Z', next_follow_up_at: '2026-10-01' });
  const r = risk(rec, { lastActivityOn: '2026-09-30' });
  assert.deepEqual(reasons(r), ['follow_up_missed']);
  assert.equal(r.days_late, 2, 'Mon 5 and Tue 6');
  assert.equal(risk(rec, { lastActivityOn: '2026-10-01' }), null, 'logged on the day: not missed');
  assert.equal(risk({ ...rec, next_follow_up_at: '2026-10-09' }, { lastActivityOn: '2026-10-05' }), null, 'a date still ahead: planned');
});

test('IR-05: an open task due on the enquiry counts as its follow-up date', () => {
  const rec = enquiry({ status: 'Qualified', first_responded_at: '2026-09-21T09:00:00Z', enquiry_date: '2026-09-21', next_task_due: '2026-10-05' });
  assert.deepEqual(reasons(risk(rec, { lastActivityOn: '2026-10-01' })), ['follow_up_missed']);
});

test('IR-06: a decision within the warning window with no quotation is at risk, and comes first', () => {
  const near = enquiry({ status: 'Qualified', first_responded_at: '2026-10-05T09:00:00Z', expected_decision_date: '2026-10-09' });
  const r = risk(near, { lastActivityOn: '2026-10-05' });
  assert.deepEqual(reasons(r), ['decision_near']);
  assert.equal(r.reasons[0].days_left, 3);
  assert.equal(risk({ ...near, quotation_no: 'Q-1' }, { lastActivityOn: '2026-10-05' }), null, 'already quoted');
  assert.equal(risk({ ...near, expected_decision_date: '2026-10-30' }, { lastActivityOn: '2026-10-05' }), null, 'decision far off');
  const passed = risk({ ...near, expected_decision_date: '2026-10-01' }, { lastActivityOn: '2026-10-05' });
  assert.equal(passed.reasons[0].days_left, -2, 'a decision date gone by is still at risk, and late');
  assert.equal(passed.days_late, 2);
});

test('IR-07: gone quiet is for an answered enquiry; a never-answered one is no_reply only', () => {
  const answered = enquiry({ status: 'Contacted', enquiry_date: '2026-09-21', created_at: '2026-09-21T05:00:00Z', first_responded_at: '2026-09-21T09:00:00Z' });
  // Last touched Fri 25 Sep; three working days later is Wed 30 Sep.
  assert.deepEqual(reasons(risk(answered, { lastActivityOn: '2026-09-25' })), ['idle']);
  assert.deepEqual(reasons(risk(enquiry({ enquiry_date: '2026-09-21', created_at: '2026-09-21T05:00:00Z' }))), ['no_reply']);
});

test('IR-08: a closed enquiry is never at risk', () => {
  for (const status of ['Converted', 'Unqualified']) assert.equal(risk(enquiry({ status, enquiry_date: '2026-09-01' })), null);
});

test('IR-09: severity puts decisions first, then days late times value', () => {
  const item = (number, x) => ({ number, decision_near: false, days_late: 1, value_inr: 0, reasons: [], ...x });
  const decision = (number, left) => item(number, { decision_near: true, reasons: [{ reason: 'decision_near', days_left: left }] });
  const list = [
    item('small-late', { days_late: 10, value_inr: 10_000 }),
    decision('decide-later', 4),
    item('big-late', { days_late: 3, value_inr: 1_000_000 }),
    decision('decide-soon', 1),
    item('no-value', { days_late: 20, value_inr: null }),
  ].sort(compareRisk);
  assert.deepEqual(list.map((i) => i.number), ['decide-soon', 'decide-later', 'big-late', 'small-late', 'no-value']);
});

test('IR-10: risk settings fall back to their defaults', () => {
  assert.equal(readRiskSettings({ enquiry_reply_days: 'abc', enquiry_decision_warn_days: '-1' }).enquiry_reply_days, 1);
  assert.equal(readRiskSettings({ enquiry_decision_warn_days: '-1' }).enquiry_decision_warn_days, 5);
  assert.equal(readRiskSettings({ enquiry_reply_days: '0' }).enquiry_reply_days, 0);
});

/* ---------------------------------------------------------------- periods */

test('PR-01: months roll into Indian financial quarters across the April boundary', () => {
  assert.equal(periodOf('2027-03', 'quarter').label, 'Q4 FY26-27');
  assert.equal(periodOf('2027-04', 'quarter').label, 'Q1 FY27-28');
  assert.equal(periodOf('2027-03', 'fy').key, 'FY26-27');
  assert.equal(periodOf('2027-04', 'fy').key, 'FY27-28');
  assert.equal(periodOf('2026-10', 'month').label, 'Oct 26');
});

test('PR-02: rollUp sums each field into its period and keeps the date range', () => {
  const months = ['2027-02', '2027-03', '2027-04', '2027-05'].map((month, i) => ({ month, received: i + 1, pipeline: 10 }));
  const q = rollUp(months, 'quarter', ['received', 'pipeline']);
  assert.deepEqual(q.map((p) => [p.label, p.received, p.pipeline, p.from, p.to]), [
    ['Q4 FY26-27', 3, 20, '2027-02-01', '2027-03-31'],
    ['Q1 FY27-28', 7, 20, '2027-04-01', '2027-05-31'],
  ]);
  assert.equal(rollUp(months, 'fy', ['received']).length, 2);
  assert.equal(rollUp(months, 'month', ['received']).length, 4);
});

test('PR-03: the window is stretched so the last period is whole', () => {
  assert.equal(windowMonths('2026-10', 6, 'month'), 6);
  assert.equal(windowMonths('2026-10', 3, 'quarter'), 3, 'Oct to Dec is Q3 exactly');
  assert.equal(windowMonths('2026-11', 3, 'quarter'), 5, 'Nov, Dec, then Jan to Mar');
  assert.equal(windowMonths('2026-10', 3, 'fy'), 6, 'to the end of March');
});

/* --------------------------------------------------------------- buckets */

test('BK-01: ageing bands break at 30/31, 60/61 and 90/91 days, and not-yet-due is its own', () => {
  assert.deepEqual([-5, 0, 1, 30, 31, 60, 61, 90, 91].map(ageingBucketOf),
    ['not-due', 'not-due', '1-30', '1-30', '31-60', '31-60', '61-90', '61-90', '90+']);
  assert.equal(AGEING_BUCKETS.length, 5);
});

test('BK-02: follow-up bands and the ?overdue_days= ranges agree', () => {
  assert.deepEqual([0, 3, 4, 7, 8, 14, 15, 99].map(followUpBandOf), ['0-3', '0-3', '4-7', '4-7', '8-14', '8-14', '15+', '15+']);
  assert.deepEqual(parseDayRange('8-14'), { lo: 8, hi: 14 });
  assert.deepEqual(parseDayRange('15+'), { lo: 15, hi: Infinity });
  assert.equal(parseDayRange('14-8'), null);
  assert.equal(parseDayRange('x'), null);
});

/* -------------------------------------------------------- scope, options */

test('SC-01: owner= narrows an admin, and is ignored for a sales user', () => {
  const admin = { id: 1, role: 'admin' };
  const sales = { id: 2, role: 'sales', mode: 'database' };
  const scoped = (u, owner) => insightsScope(u, owner);
  assert.equal(scoped(admin).unrestricted, true);
  assert.deepEqual(scoped(admin, '7'), { unrestricted: false, ownerId: 7 });
  assert.equal(scoped(admin, 'abc').unrestricted, true);
  const own = scoped(sales, '7');
  assert.equal(own.unrestricted, false);
  assert.equal(own.ownerId, 2);
});

test('SC-02: options are checked and defaulted', () => {
  assert.deepEqual(readOptions({}), { granularity: 'month', horizon: 6, basis: 'cash' });
  assert.deepEqual(readOptions({ granularity: 'quarter', horizon: '12', basis: 'order' }), { granularity: 'quarter', horizon: 12, basis: 'order' });
  assert.deepEqual(readOptions({ granularity: 'week', horizon: '5', basis: 'x' }), { granularity: 'month', horizon: 6, basis: 'cash' });
});
