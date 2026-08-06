import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { constantTimeEqual, signSession, verifySession } from '../src/auth/session.js';

const SECRET = 'a-secret-that-is-at-least-thirty-two-chars';
const HOUR_MS = 60 * 60 * 1000;

const tokenFor = (overrides = {}, secret = SECRET) =>
  signSession({ sub: 'admin', exp: Date.now() + HOUR_MS, ...overrides }, secret);

describe('signSession / verifySession', () => {
  test('returns the payload for a token it just signed', () => {
    const expiry = Date.now() + HOUR_MS;

    const payload = verifySession(tokenFor({ exp: expiry }), SECRET);

    assert.deepEqual(payload, { sub: 'admin', exp: expiry });
  });

  test('rejects a token signed with a different secret', () => {
    const token = tokenFor({}, 'a-completely-different-secret-value-here');

    assert.equal(verifySession(token, SECRET), null);
  });

  test('rejects a token whose payload was edited', () => {
    const [, mac] = tokenFor().split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'intruder', exp: Date.now() + HOUR_MS }))
      .toString('base64url');

    assert.equal(verifySession(`${forged}.${mac}`, SECRET), null);
  });

  test('rejects a token that has expired', () => {
    const token = tokenFor({ exp: Date.now() - 1 });

    assert.equal(verifySession(token, SECRET), null);
  });

  test('rejects a payload with no expiry at all', () => {
    const token = signSession({ sub: 'admin' }, SECRET);

    assert.equal(verifySession(token, SECRET), null);
  });

  test('rejects malformed input instead of throwing', () => {
    for (const bad of [undefined, null, '', 'nodot', 'too.many.dots', '.', 'a.b', 42, {}]) {
      assert.equal(verifySession(bad, SECRET), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('constantTimeEqual', () => {
  test('is true only for identical strings', () => {
    assert.equal(constantTimeEqual('correct-horse', 'correct-horse'), true);
    assert.equal(constantTimeEqual('correct-horse', 'correct-horsE'), false);
  });

  test('compares values of different lengths without throwing', () => {
    assert.equal(constantTimeEqual('short', 'considerably-longer-value'), false);
    assert.equal(constantTimeEqual('', 'x'), false);
  });
});
