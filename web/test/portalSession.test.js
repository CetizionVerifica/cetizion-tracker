import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionStatus, SESSION_TONE } from '../src/lib/portalSession.js';

/**
 * A portal session lasts eight hours and nothing extends or sweeps it, so most
 * rows in the table are ones that quietly ran out with no `revoked_at` to show
 * for it. That is what makes `!revoked_at` the tempting wrong answer, and why
 * the cases below are mostly about the two marks disagreeing.
 *
 * `now` is passed in rather than mocked, which is the whole reason the status
 * is a function here and not an expression in a table cell.
 */

const HOUR = 3600_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const at = (ms) => new Date(ms).toISOString();

test('a revoked session is revoked even with hours left on it', () => {
  // Arrange: withdrawn an hour in, so there are seven hours still on the clock.
  const session = { revoked_at: at(NOW - HOUR), expires_at: at(NOW + 7 * HOUR) };

  // Act / Assert
  assert.equal(sessionStatus(session, NOW), 'revoked');
});

test('a revoked session that had already run out is still reported as revoked', () => {
  // Turning the portal off stamps every row where revoked_at was null, expiry
  // not considered, so both marks on one row is ordinary rather than odd. The
  // deliberate act is the more recent fact and the one worth showing.
  const session = { revoked_at: at(NOW - HOUR), expires_at: at(NOW - 5 * HOUR) };

  assert.equal(sessionStatus(session, NOW), 'revoked');
});

test('an unrevoked session past its expiry is expired', () => {
  // The common row, and the one !revoked_at would have called active.
  const session = { revoked_at: null, expires_at: at(NOW - 1) };

  assert.equal(sessionStatus(session, NOW), 'expired');
});

test('an unrevoked session with time left is active', () => {
  const session = { revoked_at: null, expires_at: at(NOW + 1) };

  assert.equal(sessionStatus(session, NOW), 'active');
});

test('an expiry exactly at now is expired, as the server has it', () => {
  // requirePortal admits on expires_at > now(), so the instant itself is
  // already refused there. Off by one here and the page would say somebody is
  // signed in through a session the portal has stopped accepting.
  const session = { revoked_at: null, expires_at: at(NOW) };

  assert.equal(sessionStatus(session, NOW), 'expired');
});

test('an expiry that cannot be read is never called active, and never throws', () => {
  // expires_at is NOT NULL in the table, so these mean a payload that lost it.
  // Nothing here may be reported as somebody currently signed in.
  for (const expires_at of [null, undefined, '', 'not a date', {}, NaN]) {
    const status = sessionStatus({ revoked_at: null, expires_at }, NOW);
    assert.equal(status, 'expired', `expires_at ${JSON.stringify(expires_at)} -> ${status}`);
  }
});

test('a missing session row is not active either', () => {
  // The route sends an array and the page maps it, so this is defence rather
  // than a case anybody has seen — it must not be the one that throws in a cell.
  for (const session of [null, undefined, {}]) {
    assert.equal(sessionStatus(session, NOW), 'expired');
  }
});

test('revocation is read as a mark, not as a date worth parsing', () => {
  // The column is a timestamp, but all the status asks is whether anything is
  // in it. An unparseable one still means somebody ended the session.
  assert.equal(sessionStatus({ revoked_at: 'whenever', expires_at: at(NOW + HOUR) }, NOW), 'revoked');
});

test('now defaults to the clock, so a long-past session needs no argument', () => {
  assert.equal(sessionStatus({ revoked_at: null, expires_at: '2020-01-01T00:00:00Z' }), 'expired');
  assert.equal(sessionStatus({ revoked_at: null, expires_at: '2100-01-01T00:00:00Z' }), 'active');
});

test('every status it can return has a tone, and only one of them reads as live', () => {
  // A status with no tone falls through Badge to neutral, which would draw a
  // revoked session the same as an expired one.
  const statuses = [
    sessionStatus({ revoked_at: at(NOW), expires_at: at(NOW) }, NOW),
    sessionStatus({ revoked_at: null, expires_at: at(NOW - 1) }, NOW),
    sessionStatus({ revoked_at: null, expires_at: at(NOW + 1) }, NOW),
  ];
  assert.deepEqual(statuses, ['revoked', 'expired', 'active']);
  for (const status of statuses) assert.ok(SESSION_TONE[status], `no tone for ${status}`);
  assert.equal(Object.keys(SESSION_TONE).filter((s) => SESSION_TONE[s] === 'success').length, 1);
});
