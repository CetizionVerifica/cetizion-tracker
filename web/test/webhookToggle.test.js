import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnedOnMessage } from '../src/lib/webhookToggle.js';

/**
 * Switching a held endpoint back on releases its whole backlog in one go, and
 * the route says how many. Before #103 the toast said "Turned on" either way,
 * so an endpoint off for a week handed n8n a burst of calls unannounced.
 *
 * What is worth pinning here is the wording rather than the count: a plural
 * "1 held deliveries released" and an unguarded number() rendering a missing
 * count as an em dash are both the kind of thing that reads as correct until
 * somebody sees it in a toast.
 */

test('nothing held says only that it is on', () => {
  assert.equal(turnedOnMessage(0), 'Turned on');
});

test('one held delivery is singular', () => {
  assert.equal(turnedOnMessage(1), 'Turned on — 1 held delivery released');
});

test('more than one is plural', () => {
  assert.equal(turnedOnMessage(2), 'Turned on — 2 held deliveries released');
  assert.equal(turnedOnMessage(12), 'Turned on — 12 held deliveries released');
});

test('a large count is grouped the way the rest of the app groups numbers', () => {
  // number() uses en-IN, so this is 1,234 rather than 1234.
  assert.equal(turnedOnMessage(1234), 'Turned on — 1,234 held deliveries released');
  assert.equal(turnedOnMessage(100000), 'Turned on — 1,00,000 held deliveries released');
});

test('a missing count is not announced at all', () => {
  // number(null) and number(undefined) are both an em dash, so without the
  // guard these would read "— held deliveries released", which looks like an
  // answer. The count is guarded before number() ever sees it.
  assert.equal(turnedOnMessage(null), 'Turned on');
  assert.equal(turnedOnMessage(undefined), 'Turned on');
  assert.equal(turnedOnMessage(), 'Turned on');
});

test('no message ever carries a dash, undefined or null where a count belongs', () => {
  for (const released of [0, 1, 2, 1234, null, undefined]) {
    const message = turnedOnMessage(released);
    assert.doesNotMatch(message, /—\s+held/, `em dash stood in for a count: ${message}`);
    assert.doesNotMatch(message, /undefined|null|NaN/, `a non-value reached the toast: ${message}`);
  }
});
