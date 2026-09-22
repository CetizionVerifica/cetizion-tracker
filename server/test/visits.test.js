import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekday, visitDays } from '../src/lib/visits.js';

// Visit scheduling (#42): days are counted in business time, not UTC.

test('a visit covers each local day it touches', () => {
  assert.deepEqual(visitDays('2026-10-05T09:00:00+05:30', '2026-10-07T18:00:00+05:30'), ['2026-10-05', '2026-10-06', '2026-10-07']);
  // 01:00 IST on the 6th is still the 5th in UTC; the local day counts.
  assert.deepEqual(visitDays('2026-10-06T01:00:00+05:30', '2026-10-06T02:00:00+05:30'), ['2026-10-06']);
});

test('weekdays are ISO, Monday first', () => {
  assert.equal(isoWeekday('2026-10-05'), 1);
  assert.equal(isoWeekday('2026-10-11'), 7);
});
