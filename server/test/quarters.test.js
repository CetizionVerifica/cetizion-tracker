import test from 'node:test';
import assert from 'node:assert/strict';
import { financialQuarter, recentQuarters } from '../src/lib/quarters.js';

/**
 * Quarter arithmetic, with no database anywhere near it (#22).
 *
 * The first version of this walked backwards by taking `(q - 1) - back` and
 * feeding the remainder straight into a month number, which produced month
 * 13 two quarters back from Q2 and silently rolled into the next year. The
 * cases below are the ones that caught it.
 */
test('April opens a financial year, March closes the one before', () => {
  assert.equal(financialQuarter('2026-04-01').label, 'Q1 FY26-27');
  assert.equal(financialQuarter('2026-03-31').label, 'Q4 FY25-26');
  assert.equal(financialQuarter('2026-01-15').fy, '25-26');
  assert.equal(financialQuarter('2026-12-31').fy, '26-27');
});

test('each quarter starts on the first of its first month', () => {
  assert.equal(financialQuarter('2026-05-20').starts_on, '2026-04-01');
  assert.equal(financialQuarter('2026-09-23').starts_on, '2026-07-01');
  assert.equal(financialQuarter('2027-02-02').starts_on, '2027-01-01');
});

test('walking back crosses a year boundary without inventing a thirteenth month', () => {
  assert.deepEqual(recentQuarters('2026-09-23', 6).map((q) => q.label), [
    'Q1 FY25-26', 'Q2 FY25-26', 'Q3 FY25-26', 'Q4 FY25-26', 'Q1 FY26-27', 'Q2 FY26-27',
  ]);
  // Q4 runs January to March, so its first month is 1 of the next calendar
  // year — counting three months per quarter from April gives 13, and a
  // "2025-13-01" reaches Postgres as a date cast and takes the request down.
  assert.equal(financialQuarter('2026-02-10').starts_on, '2026-01-01');
  for (const q of recentQuarters('2026-09-23', 20)) {
    assert.match(q.starts_on, /^\d{4}-(01|04|07|10)-01$/);
  }
});

test('the window always ends on the quarter asked for, however long it is', () => {
  for (const count of [1, 2, 3, 4, 5, 9, 17]) {
    const window = recentQuarters('2026-02-14', count);
    assert.equal(window.length, count);
    assert.equal(window.at(-1).label, 'Q4 FY25-26');
    assert.deepEqual([...new Set(window.map((q) => q.key))].length, count, 'no quarter appears twice');
  }
});
