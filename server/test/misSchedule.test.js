import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET ||= 'test-secret-that-is-long-enough-to-pass';
const { REPORT_JOBS, dueToday, instantOf, nextRun, parseCron, wallClock } = await import('../src/lib/misSchedule.js');

/**
 * When the scheduled reports are due (docs/mis-briefing-fix-plan.md §1),
 * worked out in the business time zone without a database.
 */

const IST = 'Asia/Kolkata';

describe('the report schedule', () => {
  test('cron lines of the reports\' form are read; anything else is not', () => {
    assert.deepEqual(parseCron('56 8 * * *'), { minutes: 8 * 60 + 56, weekdays: null });
    assert.deepEqual(parseCron('54 8 * * 1'), { minutes: 8 * 60 + 54, weekdays: [1] });
    assert.equal(parseCron('*/15 * * * *'), null);
  });

  test('the wall clock is the business time zone\'s, not the server\'s', () => {
    // 20:00 UTC on Sunday 4 October is 01:30 on Monday 5 October in India.
    assert.deepEqual(wallClock(new Date('2026-10-04T20:00:00Z'), IST), { date: '2026-10-05', weekday: 1, minutes: 90 });
    assert.equal(instantOf('2026-10-05', 8 * 60 + 56, IST).toISOString(), '2026-10-05T03:26:00.000Z');
  });

  test('the next run is today\'s if it is still ahead, else the next matching day', () => {
    assert.equal(nextRun('56 8 * * *', new Date('2026-10-05T03:00:00Z'), IST).toISOString(), '2026-10-05T03:26:00.000Z');
    assert.equal(nextRun('56 8 * * *', new Date('2026-10-05T03:26:00Z'), IST).toISOString(), '2026-10-06T03:26:00.000Z');
    assert.equal(nextRun('54 8 * * 1', new Date('2026-10-06T00:00:00Z'), IST).toISOString(), '2026-10-12T03:24:00.000Z');
  });

  test('a report is due for the catch-up only once its time has passed by the grace, and only on its days', () => {
    assert.equal(dueToday('daily_briefing', new Date('2026-10-05T03:40:00Z'), { timeZone: IST }), null, '09:10, inside the grace');
    assert.equal(dueToday('daily_briefing', new Date('2026-10-05T03:46:00Z'), { timeZone: IST }), '2026-10-05', '09:16');
    assert.equal(dueToday('daily_briefing', new Date('2026-10-04T04:00:00Z'), { timeZone: IST }), '2026-10-04', 'a Sunday too');
    assert.equal(dueToday('weekly_mis', new Date('2026-10-06T06:00:00Z'), { timeZone: IST }), null, 'the weekly report is Monday\'s');
    assert.equal(dueToday('daily_briefing', new Date('2026-10-04T19:00:00Z'), { timeZone: IST }), null, '00:30 the next day, before the time');
  });

  test('the briefing\'s cron is every day of the week', () => {
    assert.equal(parseCron(REPORT_JOBS.daily_briefing.cron).weekdays, null);
  });
});
