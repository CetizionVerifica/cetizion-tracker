import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKOFF_MINUTES, sign, stripPersonal, verify } from '../src/lib/webhooks.js';

// Outgoing webhooks (#49); none of these needs a database.

test('a signature verifies with the right secret, fresh timestamp and exact body only', () => {
  const now = Date.UTC(2026, 8, 17, 10, 0, 0);
  const t = Math.floor(now / 1000);
  const body = '{"event":"quotation.won"}';
  const header = `t=${t},v1=${sign('whsec_1', t, body)}`;
  assert.equal(verify('whsec_1', header, body, { now }), true);
  assert.equal(verify('whsec_2', header, body, { now }), false);
  assert.equal(verify('whsec_1', header, `${body} `, { now }), false);
  assert.equal(verify('whsec_1', header, body, { now: now + 10 * 60 * 1000 }), false);
  assert.equal(verify('whsec_1', 'nonsense', body, { now }), false);
});

test('personal data is removed at every depth unless allowed', () => {
  const out = stripPersonal({ quotation_no: 'Q1', contact_person: 'Asha', sales_person: 'Ravi', lines: [{ contact_email: 'a@b.c', amount: 5 }] });
  assert.deepEqual(out, { quotation_no: 'Q1', lines: [{ amount: 5 }] });
});

test('retries back off and stop within a day', () => {
  const total = BACKOFF_MINUTES.reduce((a, b) => a + b, 0);
  assert.ok(total <= 24 * 60, `${total} minutes`);
  assert.deepEqual([...BACKOFF_MINUTES].sort((a, b) => a - b), BACKOFF_MINUTES);
});
