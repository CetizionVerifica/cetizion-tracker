import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWorkingDays, isWorkingDay, workingDaysBetween } from '../src/lib/businessDate.ts';

// Working days (#73). Pure: the holiday list is an argument, so none of
// these needs a database. January 2026 is the real case — Republic Day,
// 26 January, is a Monday.
const REPUBLIC_DAY = '2026-01-26';
const HOLIDAYS = [REPUBLIC_DAY, '2026-12-25'];

test('Saturday, Sunday and a holiday are not working days; a weekday is', () => {
  assert.equal(isWorkingDay('2026-01-24', HOLIDAYS), false, 'Saturday');
  assert.equal(isWorkingDay('2026-01-25', HOLIDAYS), false, 'Sunday');
  assert.equal(isWorkingDay(REPUBLIC_DAY, HOLIDAYS), false, 'Republic Day');
  assert.equal(isWorkingDay('2026-01-27', HOLIDAYS), true, 'the Tuesday after');
});

test('with no holidays loaded, only weekends are off', () => {
  assert.equal(isWorkingDay(REPUBLIC_DAY), true);
  assert.equal(isWorkingDay(REPUBLIC_DAY, []), true);
  assert.equal(isWorkingDay('2026-01-24', []), false);
  assert.equal(addWorkingDays('2026-01-23', 3), '2026-01-28');
});

test('addWorkingDays skips a holiday that falls on a Monday', () => {
  // Friday 23 January + 3: Tue, Wed, Thu — Monday is Republic Day.
  assert.equal(addWorkingDays('2026-01-23', 3, HOLIDAYS), '2026-01-29');
  // The same Friday with no holiday: Mon, Tue, Wed.
  assert.equal(addWorkingDays('2026-01-23', 3, []), '2026-01-28');
  // From a Saturday, the first working day is Monday — or Tuesday here.
  assert.equal(addWorkingDays('2026-01-24', 1, HOLIDAYS), '2026-01-27');
});

test('addWorkingDays: zero is the same day, and a negative count goes back', () => {
  assert.equal(addWorkingDays('2026-01-24', 0, HOLIDAYS), '2026-01-24');
  assert.equal(addWorkingDays('2026-01-27', -1, HOLIDAYS), '2026-01-23');
});

test('workingDaysBetween over a week containing one holiday', () => {
  // Sat 24 → Fri 30 January: Sat, Sun and Republic Day are off; four left.
  assert.equal(workingDaysBetween('2026-01-23', '2026-01-30', HOLIDAYS), 4);
  assert.equal(workingDaysBetween('2026-01-23', '2026-01-30', []), 5);
  // Due Friday, paid Monday: one working day late.
  assert.equal(workingDaysBetween('2026-01-30', '2026-02-02', HOLIDAYS), 1);
});

test('workingDaysBetween is 0 when the end is not later', () => {
  assert.equal(workingDaysBetween('2026-01-27', '2026-01-27', HOLIDAYS), 0);
  assert.equal(workingDaysBetween('2026-01-30', '2026-01-23', HOLIDAYS), 0);
});

test('across the year boundary', () => {
  // Thu 31 Dec 2026 + 2: Fri 1 Jan 2027, then Monday 4 Jan.
  assert.equal(addWorkingDays('2026-12-31', 2, HOLIDAYS), '2027-01-04');
  // Christmas (a Friday) is off; 28–31 Dec, 1 Jan and 4 Jan are not.
  assert.equal(workingDaysBetween('2026-12-24', '2027-01-04', HOLIDAYS), 6);
});

test('the two agree: n working days on, then counted back, is n', () => {
  for (const start of ['2026-01-22', '2026-01-23', '2026-01-24', '2026-12-24']) {
    for (let n = 0; n <= 12; n += 1) {
      assert.equal(workingDaysBetween(start, addWorkingDays(start, n, HOLIDAYS), HOLIDAYS), n, `${start} + ${n}`);
    }
  }
});

test('the holiday list may be a Set or any iterable', () => {
  assert.equal(isWorkingDay(REPUBLIC_DAY, new Set(HOLIDAYS)), false);
  assert.equal(isWorkingDay(REPUBLIC_DAY, HOLIDAYS.values()), false);
});

/**
 * A date column only has to look like YYYY-MM-DD to be stored, and
 * Postgres accepts any year, so an invoice typed as 0202 for 2020 is a
 * real row somebody can save. Counting it honestly means 476,000 loop
 * iterations on the route that renders the landing screen.
 */
test('a span no real invoice could have is refused rather than walked', () => {
  const started = Date.now();
  assert.equal(workingDaysBetween('0202-01-15', '2026-09-25'), 0, 'a mistyped year is a typo, not a calculation');
  assert.ok(Date.now() - started < 20, 'and it must not spend a fifth of a second finding that out');
});

test('a long but plausible overdue span is still counted', () => {
  // Five years late is extraordinary, and somebody would still want the number.
  assert.ok(workingDaysBetween('2021-09-25', '2026-09-25') > 1200);
});

test('an unparseable date counts nothing rather than throwing', () => {
  assert.equal(workingDaysBetween('not-a-date', '2026-09-25'), 0);
  assert.equal(workingDaysBetween('2026-09-25', 'not-a-date'), 0);
});
