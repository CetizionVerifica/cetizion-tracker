import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  eventHighlight, firstResponseTat, median, monthToDate, pendingRow, periodFor, previousWeekOf, topActions, yesterdayOf,
} from '../src/lib/misReports.js';

/**
 * The MIS reports' rules that need no database (docs/mis-reports-plan.md §8):
 * the periods, the ranking of actions, the first-response TAT rule and the
 * record-based highlights.
 */

describe('report periods', () => {
  test('the daily briefing covers yesterday, as one day', () => {
    assert.deepEqual(yesterdayOf('2026-10-05'), { from: '2026-10-04', to: '2026-10-04' });
    // Across a month end, and across a year end.
    assert.deepEqual(yesterdayOf('2026-10-01'), { from: '2026-09-30', to: '2026-09-30' });
    assert.deepEqual(periodFor('daily_briefing', '2027-01-01'), { from: '2026-12-31', to: '2026-12-31' });
  });

  test('the weekly MIS covers the previous Monday to Sunday, whichever day it runs', () => {
    // Monday 5 October 2026 → 28 September to 4 October, the routine's window.
    assert.deepEqual(previousWeekOf('2026-10-05'), { from: '2026-09-28', to: '2026-10-04' });
    // Run late, on a Wednesday: still the last whole week.
    assert.deepEqual(previousWeekOf('2026-10-07'), { from: '2026-09-28', to: '2026-10-04' });
    // A Sunday belongs to the week that is ending: the previous whole week is the one before.
    assert.deepEqual(previousWeekOf('2026-10-04'), { from: '2026-09-21', to: '2026-09-27' });
    assert.deepEqual(periodFor('weekly_mis', '2026-10-05'), previousWeekOf('2026-10-05'));
  });

  test('month to date runs from the first of the month', () => {
    assert.deepEqual(monthToDate('2026-10-04'), { from: '2026-10-01', to: '2026-10-04' });
  });

  test('an unknown kind is refused', () => {
    assert.throws(() => periodFor('monthly', '2026-10-05'), /Unknown report kind/);
  });
});

describe('pending rows and the top actions', () => {
  const row = (over) => pendingRow({ kind: 'to_invoice', key: over.key || over.client, reference: 'x', next_action: 'do', link: '/', ...over }, 7);

  test('a row is Overdue once it has waited past the threshold', () => {
    assert.equal(row({ client: 'A', days: 7 }).overdue, false);
    assert.equal(row({ client: 'A', days: 8 }).overdue, true);
    assert.equal(row({ client: 'A', days: -3 }).days, 0, 'not yet due is zero days, never negative');
  });

  test('the top actions rank by days × value, at most one per client, five at most', () => {
    const rows = [
      row({ client: 'Big & old', days: 30, amount_inr: 500000 }),
      row({ client: 'Big & old', key: 'second', days: 29, amount_inr: 400000 }),
      row({ client: 'Young & huge', days: 2, amount_inr: 9_000_000 }),
      row({ client: 'Old & small', days: 60, amount_inr: 1000 }),
      row({ client: 'No value', days: 90 }),
      row({ client: 'E', days: 5, amount_inr: 10 }),
      row({ client: 'F', days: 4, amount_inr: 10 }),
      row({ client: 'G', days: 3, amount_inr: 10 }),
    ];
    const top = topActions(rows);
    assert.equal(top.length, 5);
    assert.deepEqual(top.slice(0, 2).map((r) => r.client), ['Young & huge', 'Big & old']);
    assert.equal(top.filter((r) => r.client === 'Big & old').length, 1, 'one action per client');
    assert.ok(top.some((r) => r.client === 'No value'), 'a row with no value still ranks by its age');
    // Case does not make two clients of one.
    const dup = topActions([row({ client: 'acme', days: 3, amount_inr: 10 }), row({ client: 'ACME', key: 'b', days: 2, amount_inr: 10 })]);
    assert.equal(dup.length, 1);
  });
});

describe('the first-response TAT rule', () => {
  test('an inbox conversation measures from its first inbound message to the first response', () => {
    const h = firstResponseTat({ conversation_first_inbound_at: '2026-09-28T04:00:00Z', conversation_first_response_at: '2026-09-28T06:30:00Z', enquiry_date: '2026-09-28', first_responded_at: '2026-09-30T00:00:00Z' });
    assert.equal(h, 2.5);
  });

  test('otherwise from the enquiry date (IST midnight) to first_responded_at', () => {
    // 10:00 IST on the enquiry date is 10 hours.
    assert.equal(firstResponseTat({ enquiry_date: '2026-09-28', first_responded_at: '2026-09-28T04:30:00Z' }), 10);
  });

  test('an enquiry made from our own quotation or PO email has no TAT', () => {
    assert.equal(firstResponseTat({ from_our_email: true, enquiry_date: '2026-09-28', first_responded_at: '2026-09-28T04:30:00Z' }), null);
  });

  test('no response, or a response before the enquiry, is no TAT', () => {
    assert.equal(firstResponseTat({ enquiry_date: '2026-09-28', first_responded_at: null }), null);
    assert.equal(firstResponseTat({ enquiry_date: '2026-09-28', first_responded_at: '2026-09-20T00:00:00Z' }), null);
  });

  test('median ignores blanks and averages an even middle', () => {
    assert.equal(median([3, null, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), null);
  });
});

describe('record-based highlights', () => {
  test('each reader event becomes one plain sentence with a link into the tracker', () => {
    const h = eventHighlight({ kind: 'enquiry', number: 'CTZ/ENQ/2026/001', client: 'Acme Steel', detail: 'EcoVadis', thread_id: 9 });
    assert.match(h.summary, /New enquiry CTZ\/ENQ\/2026\/001 from Acme Steel for EcoVadis/);
    assert.equal(h.thread_id, 9);
    assert.equal(h.link, '/enquiries?q=CTZ%2FENQ%2F2026%2F001');
    assert.equal(h.source, 'records');
    assert.match(eventHighlight({ kind: 'purchase_order', number: '4500123', client: 'Beta', detail: 'INR 100000' }).summary, /PO 4500123 from Beta \(INR 100000\) registered/);
  });
});
