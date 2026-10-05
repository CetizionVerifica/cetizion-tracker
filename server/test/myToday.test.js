import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  arrange, bucket, invoiceReadySince, lateLabel, paymentDueOn, readSettings,
} from '../src/lib/myToday.js';
import { businessToday } from '../src/lib/businessDate.ts';

/**
 * My Today's rules (docs/my-today-plan.md), pure: rows in, sections out.
 * No database; the route and its ownership are in myTodayApi.test.js.
 */

const rules = { chase_after_days: 7, rechase_days: 7 };

describe('Due today or Late', () => {
  // The plan's worked example: Tuesday 29 September 2026, no holidays.
  const today = '2026-09-29';
  for (const [due, working, calendar, section] of [
    ['2026-09-29', 0, 0, 'due_today'],
    ['2026-09-28', 1, 1, 'due_today'],
    ['2026-09-25', 2, 4, 'due_today'],
    ['2026-09-24', 3, 5, 'late'],
  ]) {
    test(`due ${due}: ${working} working days late, ${section}`, () => {
      assert.deepEqual(bucket(due, today), { section, working_days_late: working, days_late: calendar });
    });
  }

  test('a due date after today is not shown', () => {
    assert.equal(bucket('2026-09-30', today), null);
    assert.equal(bucket(null, today), null);
  });

  test('items 1 or 2 days late carry a label; on time carries none', () => {
    assert.equal(lateLabel(0), null);
    assert.equal(lateLabel(1), '1 day late');
    assert.equal(lateLabel(2), '2 days late');
  });

  test('a weekend inside the grace period is not counted', () => {
    // Friday's work on Monday morning is one working day late, not three.
    assert.equal(bucket('2026-10-02', '2026-10-05').working_days_late, 1);
    assert.equal(bucket('2026-10-02', '2026-10-05').section, 'due_today');
  });

  test('a holiday inside the grace period is not counted', () => {
    // Thursday 1 October, seen on Tuesday 6 October: Mon and Tue are three
    // working days with Friday 2 October, two without it.
    assert.equal(bucket('2026-10-01', '2026-10-06').section, 'late');
    const withHoliday = bucket('2026-10-01', '2026-10-06', ['2026-10-02']);
    assert.equal(withHoliday.section, 'due_today');
    assert.equal(withHoliday.working_days_late, 2);
  });

  test('the grace period is a setting', () => {
    assert.equal(bucket('2026-09-28', '2026-09-29', [], 0).section, 'late');
    assert.equal(bucket('2026-09-24', '2026-09-29', [], 3).section, 'due_today');
  });
});

describe('the payment rule', () => {
  const stage = { invoice_due_date: '2026-09-15', on_hold: false, promise_to_pay_date: null };

  test('not before it is more than 7 days past due', () => {
    assert.equal(paymentDueOn(stage, null, { ...rules, today: '2026-09-22' }), null);
  });

  test('with no chase, due on the first day it is more than 7 days past due', () => {
    // The plan's example: due Tue 15 September, on the list Wed 23 September
    // under Due today, Late from Mon 28 September.
    const due = paymentDueOn(stage, null, { ...rules, today: '2026-09-23' });
    assert.equal(due, '2026-09-23');
    assert.equal(bucket(due, '2026-09-23').section, 'due_today');
    assert.equal(bucket(due, '2026-09-25').section, 'due_today');
    assert.equal(bucket(due, '2026-09-28').section, 'late');
  });

  test('on hold is never shown', () => {
    assert.equal(paymentDueOn({ ...stage, on_hold: true }, null, { ...rules, today: '2026-10-30' }), null);
  });

  test('a promise to pay today or later hides it', () => {
    assert.equal(paymentDueOn({ ...stage, promise_to_pay_date: '2026-09-29' }, null, { ...rules, today: '2026-09-29' }), null);
    assert.equal(paymentDueOn({ ...stage, promise_to_pay_date: '2026-10-10' }, null, { ...rules, today: '2026-09-29' }), null);
  });

  test('a promise that has passed makes it due the day after', () => {
    assert.equal(paymentDueOn({ ...stage, promise_to_pay_date: '2026-09-25' }, null, { ...rules, today: '2026-09-29' }), '2026-09-26');
  });

  test('a chase with a next date is due on that date', () => {
    const chase = { on: '2026-09-24', next_action_on: '2026-10-01' };
    assert.equal(paymentDueOn(stage, chase, { ...rules, today: '2026-09-29' }), '2026-10-01');
    assert.equal(bucket('2026-10-01', '2026-09-29'), null, 'so it is off the list until then');
  });

  test('a chase without a next date comes back after rechase_days', () => {
    assert.equal(paymentDueOn(stage, { on: '2026-09-24', next_action_on: null }, { ...rules, today: '2026-09-29' }), '2026-10-01');
    assert.equal(paymentDueOn(stage, { on: '2026-09-24', next_action_on: null }, { ...rules, rechase_days: 3, today: '2026-09-29' }), '2026-09-27');
  });

  test('a chase logged before it was eligible does not put it straight into Late', () => {
    // Chased on the 10th with no next date: 17th, but it could not be on the
    // list before the 23rd, so it arrives under Due today then.
    assert.equal(paymentDueOn(stage, { on: '2026-09-10', next_action_on: null }, { ...rules, today: '2026-09-23' }), '2026-09-23');
  });

  test('a chase after a broken promise is the newer word', () => {
    const s = { ...stage, promise_to_pay_date: '2026-09-20' };
    assert.equal(paymentDueOn(s, { on: '2026-09-25', next_action_on: '2026-09-30' }, { ...rules, today: '2026-09-29' }), '2026-09-30');
  });

  test('a chase that recorded the promise does not outrank it', () => {
    // Logged on the 18th with a promise for the 25th: once the 25th passes,
    // it is due on the 26th, not a week after the 18th.
    const s = { ...stage, promise_to_pay_date: '2026-09-25' };
    assert.equal(paymentDueOn(s, { on: '2026-09-18', next_action_on: null }, { ...rules, today: '2026-09-29' }), '2026-09-26');
  });

  test('the 7 days are a setting', () => {
    assert.equal(paymentDueOn(stage, null, { ...rules, chase_after_days: 3, today: '2026-09-19' }), '2026-09-19');
  });
});

describe('when an invoice became ready to raise', () => {
  const base = { po_date: '2026-09-01', delivery_date: '2026-09-10', milestone_reached_on: '2026-09-12', created_on: '2026-08-20' };
  test('each trigger reads its own date', () => {
    assert.equal(invoiceReadySince({ ...base, trigger_event: 'On PO Registration' }), '2026-09-01');
    assert.equal(invoiceReadySince({ ...base, trigger_event: 'On Delivery' }), '2026-09-10');
    assert.equal(invoiceReadySince({ ...base, trigger_event: 'On Milestone' }), '2026-09-12');
  });
  test('a manual stage counts from the day it was entered', () => {
    assert.equal(invoiceReadySince({ ...base, trigger_event: 'Manual' }), '2026-08-20');
  });
});

describe('the page', () => {
  const today = '2026-09-29';
  const item = (kind, due_on, amount = null) => ({ kind, due_on, amount, title: `${kind} ${due_on}` });

  test('Late is oldest first; Due today most late first, then the largest amount', () => {
    const page = arrange([
      item('task', '2026-09-23'), item('invoice', '2026-09-21', 10), item('task', '2026-09-29'),
      item('payment', '2026-09-29', 500), item('follow_up', '2026-09-28'), item('task', '2026-10-01'),
    ], { today });
    assert.deepEqual(page.late.map((i) => i.due_on), ['2026-09-21', '2026-09-23']);
    assert.deepEqual(page.due_today.map((i) => i.title), ['follow_up 2026-09-28', 'payment 2026-09-29', 'task 2026-09-29']);
    assert.equal(page.due_today[0].late_label, '1 day late');
    assert.deepEqual(page.counts, { late: 2, due_today: 3 });
  });

  test('more than 30 days late folds into one row, still counted', () => {
    const page = arrange([item('follow_up', '2026-07-01'), item('follow_up', '2026-08-01'), item('task', '2026-09-20')], { today });
    assert.deepEqual(page.late.map((i) => i.due_on), ['2026-09-20']);
    assert.deepEqual(page.older, { count: 2, by_kind: { task: 0, follow_up: 2, invoice: 0, payment: 0 }, oldest_due_on: '2026-07-01' });
    assert.equal(page.counts.late, 3);
    const all = arrange([item('follow_up', '2026-07-01'), item('task', '2026-09-20')], { today, unfold: true });
    assert.equal(all.late.length, 2);
    assert.equal(all.older, null);
  });

  test('an empty day', () => {
    assert.deepEqual(arrange([], { today }), { counts: { late: 0, due_today: 0 }, late: [], due_today: [], older: null });
  });
});

describe('settings', () => {
  test('blank or nonsense falls back to the defaults', () => {
    assert.deepEqual(readSettings({}), { grace_working_days: 2, chase_after_days: 7, rechase_days: 7 });
    assert.deepEqual(readSettings({ my_today_grace_working_days: '1', my_today_chase_after_days: 'x', my_today_rechase_days: '' }),
      { grace_working_days: 1, chase_after_days: 7, rechase_days: 7 });
  });
});

describe('the clock', () => {
  test('at 00:30 India time, today is the India date', () => {
    // 19:00 UTC on the 28th is 00:30 IST on the 29th.
    assert.equal(businessToday(new Date('2026-09-28T19:00:00Z'), 'Asia/Kolkata'), '2026-09-29');
  });
});
