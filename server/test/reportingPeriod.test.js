import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  calendarYearRange, financialYearOf, financialYearRange, monthRange, monthsIn,
  previousPeriod, quarterRange, resolvePeriod,
} from '../src/lib/reportingPeriod.js';

/**
 * The period a report covers (#18 §5, §7).
 *
 * In its own file and making no queries, for the reason financialYear.test.js
 * gives: importing anything that reaches db.js builds a pool from
 * DATABASE_URL at import time, and in a file that also creates a throwaway
 * database that happens before the `before()` hook has pointed it anywhere.
 * reportingPeriod.js touches only config and the clock, so it imports freely.
 *
 * The rule under test throughout: ranges are half-open, `[from, to)`. The
 * boundary cases are the whole point — 31 March and 1 April decide which
 * financial year a deal was won in, and getting that wrong moves revenue
 * between years in a report somebody files with an accountant.
 */

describe('the reporting period', () => {
  // ------------------------------------------------------- financial year

  test('the financial year starts in April, and is named by the year it starts', () => {
    assert.equal(financialYearOf('2026-04-01'), 2026, 'the first day of the year');
    assert.equal(financialYearOf('2027-03-31'), 2026, 'and the last day of the same one');
    assert.equal(financialYearOf('2026-03-31'), 2025, 'the day before belongs to the one before');
    assert.equal(financialYearOf('2027-01-15'), 2026, 'January still belongs to the year that began in April');
  });

  test('a financial year runs April to April, half-open', () => {
    assert.deepEqual(financialYearRange(2026), { from: '2026-04-01', to: '2027-04-01' });
  });

  test('the boundary belongs to exactly one year, never both and never neither', () => {
    const thisYear = financialYearRange(2026);
    const nextYear = financialYearRange(2027);
    assert.equal(thisYear.to, nextYear.from, 'no gap and no overlap between consecutive years');

    const inRange = (d, r) => d >= r.from && d < r.to;
    assert.ok(inRange('2027-03-31', thisYear), '31 March is the old year');
    assert.ok(!inRange('2027-03-31', nextYear));
    assert.ok(inRange('2027-04-01', nextYear), '1 April is the new one');
    assert.ok(!inRange('2027-04-01', thisYear));
  });

  // ------------------------------------------------ months and quarters

  test('a month is the first of one to the first of the next, December included', () => {
    assert.deepEqual(monthRange(2026, 3), { from: '2026-03-01', to: '2026-04-01' });
    assert.deepEqual(monthRange(2026, 12), { from: '2026-12-01', to: '2027-01-01' },
      'December rolls the year, which is where an off-by-one lives');
  });

  test('quarters are the financial ones: Q1 is April to June', () => {
    assert.deepEqual(quarterRange(2026, 1), { from: '2026-04-01', to: '2026-07-01' });
    assert.deepEqual(quarterRange(2026, 2), { from: '2026-07-01', to: '2026-10-01' });
    assert.deepEqual(quarterRange(2026, 3), { from: '2026-10-01', to: '2027-01-01' });
    assert.deepEqual(quarterRange(2026, 4), { from: '2027-01-01', to: '2027-04-01' },
      'Q4 is January to March of the following calendar year');
  });

  test('the four quarters tile the financial year exactly', () => {
    const year = financialYearRange(2026);
    const quarters = [1, 2, 3, 4].map((q) => quarterRange(2026, q));
    assert.equal(quarters[0].from, year.from);
    assert.equal(quarters[3].to, year.to);
    for (let i = 1; i < 4; i += 1) {
      assert.equal(quarters[i - 1].to, quarters[i].from, `Q${i} meets Q${i + 1} with no gap`);
    }
  });

  test('a calendar year is still available, and is not the financial one', () => {
    assert.deepEqual(calendarYearRange(2026), { from: '2026-01-01', to: '2027-01-01' });
    assert.notDeepEqual(calendarYearRange(2026), financialYearRange(2026));
  });

  // ------------------------------------------------------------ resolving

  test('the default is the financial year containing the anchor', () => {
    const p = resolvePeriod({ anchor: '2026-05-20' });
    assert.equal(p.type, 'fy');
    assert.equal(p.from, '2026-04-01');
    assert.equal(p.to, '2027-04-01');
    assert.equal(p.label, 'FY26-27', 'the same way the invoice series is numbered');
  });

  test('a March date resolves to the year that is ending, not the one starting', () => {
    const p = resolvePeriod({ anchor: '2026-03-20' });
    assert.equal(p.from, '2025-04-01');
    assert.equal(p.label, 'FY25-26');
  });

  test('each preset resolves around the anchor', () => {
    assert.deepEqual(
      { ...resolvePeriod({ preset: 'month', anchor: '2026-05-20' }) },
      { from: '2026-05-01', to: '2026-06-01', type: 'month', label: '2026-05', time_zone: 'Asia/Kolkata' }
    );
    const q = resolvePeriod({ preset: 'quarter', anchor: '2026-05-20' });
    assert.deepEqual([q.from, q.to, q.label], ['2026-04-01', '2026-07-01', 'Q1 FY26-27'],
      'May is in the first financial quarter');
    const cal = resolvePeriod({ preset: 'calendar-year', anchor: '2026-05-20' });
    assert.deepEqual([cal.from, cal.to], ['2026-01-01', '2027-01-01']);
  });

  test('an explicit range wins, and is reported as custom', () => {
    const p = resolvePeriod({ from: '2026-02-03', to: '2026-02-17' });
    assert.deepEqual([p.from, p.to, p.type], ['2026-02-03', '2026-02-17', 'custom']);
  });

  test('a range that ends before it starts is refused, not silently swapped', () => {
    assert.throws(() => resolvePeriod({ from: '2026-05-01', to: '2026-04-01' }), /after from/,
      'swapping them would report confident figures for a period nobody asked about');
    assert.throws(() => resolvePeriod({ from: '2026-05-01', to: '2026-05-01' }), /after from/,
      'an empty range is a mistake upstream, not a period');
  });

  test('half a range, a bad date and an unknown preset are all refused', () => {
    assert.throws(() => resolvePeriod({ from: '2026-05-01' }), /both be dates/);
    assert.throws(() => resolvePeriod({ from: '01-05-2026', to: '2026-06-01' }), /both be dates/);
    assert.throws(() => resolvePeriod({ preset: 'fortnight' }), /period must be one of/);
    assert.throws(() => resolvePeriod({ preset: 'quarter', quarter: 5 }), /quarter must be/);
  });

  // ---------------------------------------------------------- comparison

  test('a named month compares against the month before, not 31 days back', () => {
    assert.deepEqual(
      previousPeriod({ ...monthRange(2026, 5), type: 'month' }),
      { from: '2026-04-01', to: '2026-05-01' },
      'stepping back by length would give 31 March to 1 May, which is neither month'
    );
    assert.deepEqual(
      previousPeriod({ ...monthRange(2026, 1), type: 'month' }),
      { from: '2025-12-01', to: '2026-01-01' },
      'and January steps back across the year'
    );
  });

  test('a quarter compares against the quarter before, across the year end', () => {
    assert.deepEqual(previousPeriod({ ...quarterRange(2026, 2), type: 'quarter' }), quarterRange(2026, 1));
    assert.deepEqual(previousPeriod({ ...quarterRange(2026, 1), type: 'quarter' }), quarterRange(2025, 4),
      'Q1 steps back to the previous financial year\'s Q4');
  });

  test('a financial year compares against the financial year before', () => {
    assert.deepEqual(
      previousPeriod({ ...financialYearRange(2026), type: 'fy' }),
      { from: '2025-04-01', to: '2026-04-01' }
    );
    assert.deepEqual(
      previousPeriod({ ...calendarYearRange(2026), type: 'calendar-year' }),
      { from: '2025-01-01', to: '2026-01-01' }
    );
  });

  test('a custom range steps back by its own length, having no unit to step', () => {
    const fortnight = { from: '2026-05-01', to: '2026-05-15', type: 'custom' };
    assert.deepEqual(previousPeriod(fortnight), { from: '2026-04-17', to: '2026-05-01' });
    const days = (r) => (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86400000;
    assert.equal(days(previousPeriod(fortnight)), days(fortnight), 'like compared with like');
  });

  // ------------------------------------------------------------- months in

  test('a financial year contains its twelve months, April first', () => {
    const months = monthsIn(financialYearRange(2026));
    assert.equal(months.length, 12);
    assert.equal(months[0].from, '2026-04-01');
    assert.equal(months[11].from, '2027-03-01');
  });

  test('a range starting mid-month does not claim that whole month', () => {
    const months = monthsIn({ from: '2026-05-10', to: '2026-08-01' });
    assert.deepEqual(months.map((m) => m.from), ['2026-06-01', '2026-07-01'],
      'a part-month target would otherwise be counted in full');
  });

  test('a range inside one month contains no whole month', () => {
    assert.deepEqual(monthsIn({ from: '2026-05-02', to: '2026-05-20' }), []);
  });
});
