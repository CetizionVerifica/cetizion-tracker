import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { financialYear } from '../src/lib/sequences.js';

/**
 * The Indian financial year, which the invoice series is numbered by.
 *
 * In its own file, and not alongside the invoice route tests, because
 * importing sequences.js pulls in db.js, and db.js builds its pool from
 * DATABASE_URL at import time. In a file that also creates a throwaway
 * database, that import happens before the `before()` hook has pointed
 * DATABASE_URL at it — so every request in the file silently runs against
 * the developer's own database instead. This file makes no queries, so it
 * can import freely.
 */
describe('the financial year', () => {
  test('starts in April and is written as the two years it spans', () => {
    assert.equal(financialYear('2026-04-01'), '26-27', 'the first day of the year');
    assert.equal(financialYear('2026-03-31'), '25-26', 'the last day of the one before');
    assert.equal(financialYear('2026-09-22'), '26-27');
    assert.equal(financialYear('2027-01-15'), '26-27', 'January still belongs to the year that began in April');
    assert.equal(financialYear('2000-04-01'), '00-01', 'and the turn of a century still reads as two digits');
  });
});
