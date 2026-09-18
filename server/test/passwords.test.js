import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  MIN_PASSWORD_LENGTH,
  dummyPasswordHash,
  hashPassword,
  passwordProblem,
  verifyPassword,
  verifyPasswordOrDummy,
} from '../src/lib/passwords.js';

/**
 * Password hashing. Nothing here touches Postgres, so this suite runs
 * without a database.
 */

const PASSWORD = 'a-good-long-test-password';

describe('hashPassword', () => {
  test('produces a value carrying the algorithm, version and cost', async () => {
    const encoded = await hashPassword(PASSWORD);

    const parts = encoded.split('$');
    assert.equal(parts.length, 7, encoded);
    const [algorithm, version, N, r, p, salt, hash] = parts;
    assert.equal(algorithm, 'scrypt');
    assert.equal(version, 'v1');
    // The exact cost v1 is pinned to, p included: parseHash believes a
    // stored parameter only when it is the one this version uses.
    assert.equal(Number(N), 16384, 'N');
    assert.equal(Number(r), 8, 'r');
    assert.equal(Number(p), 5, 'p');
    assert.ok(Buffer.from(salt, 'base64url').length >= 16, 'at least 16 bytes of salt');
    assert.ok(Buffer.from(hash, 'base64url').length >= 32, 'at least a 32-byte key');
  });

  test('does not carry the password anywhere in the value', async () => {
    const encoded = await hashPassword(PASSWORD);

    assert.ok(!encoded.includes(PASSWORD));
    // Not hidden in an encoding either.
    for (const encoding of ['base64url', 'base64', 'hex']) {
      assert.ok(!encoded.includes(Buffer.from(PASSWORD).toString(encoding)), encoding);
    }
  });

  test('salts each hash, so the same password never stores the same value', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    assert.notEqual(first, second);
    // Both still check out — different stored value, same password.
    assert.equal(await verifyPassword(PASSWORD, first), true);
    assert.equal(await verifyPassword(PASSWORD, second), true);
  });

  test('refuses a password that may not be used, without quoting it', async () => {
    const tooShort = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);

    await assert.rejects(hashPassword(tooShort), (err) => {
      assert.match(err.message, new RegExp(`${MIN_PASSWORD_LENGTH} characters`));
      assert.ok(!err.message.includes(tooShort), 'the password is not in the error');
      return true;
    });
    await assert.rejects(hashPassword(''), /blank/);
    await assert.rejects(hashPassword('   '), /blank/);
    await assert.rejects(hashPassword(undefined), /must be text/);
    await assert.rejects(hashPassword(12345678901234), /must be text/);
  });
});

describe('passwordProblem', () => {
  test('passes a usable password and names the fault otherwise', () => {
    assert.equal(passwordProblem(PASSWORD), null);
    assert.equal(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH)), null);
    assert.match(passwordProblem('x'.repeat(MIN_PASSWORD_LENGTH - 1)), /shorter/);
    assert.match(passwordProblem(''), /blank/);
    assert.match(passwordProblem(null), /must be text/);
  });
});

describe('verifyPassword', () => {
  test('accepts the right password and refuses a wrong one', async () => {
    const encoded = await hashPassword(PASSWORD);

    assert.equal(await verifyPassword(PASSWORD, encoded), true);
    assert.equal(await verifyPassword(`${PASSWORD}x`, encoded), false);
    assert.equal(await verifyPassword(PASSWORD.toUpperCase(), encoded), false);
    assert.equal(await verifyPassword('', encoded), false);
  });

  test('refuses a value that is not a hash, instead of throwing', async () => {
    for (const bad of [
      undefined, null, '', 42, {}, [],
      'not-a-hash',
      'scrypt$v1$16384$8$5$onlysixfields',
      'scrypt$v1$16384$8$5$c2FsdA$aGFzaA$extra',
      'bcrypt$v1$16384$8$5$c2FsdA$aGFzaA',       // another algorithm
      'scrypt$v9$16384$8$5$c2FsdA$aGFzaA',       // a version from the future
      'scrypt$v1$abc$8$5$c2FsdA$aGFzaA',         // N is not a number
      'scrypt$v1$0$8$5$c2FsdA$aGFzaA',           // N is not positive
      'scrypt$v1$16384$8$5$$aGFzaA',             // no salt
      'scrypt$v1$16384$8$5$c2FsdA$',             // no key
      'scrypt$v1$99999999$8$5$c2FsdA$aGFzaA',    // asks for far too much memory
    ]) {
      assert.equal(await verifyPassword(PASSWORD, bad), false, JSON.stringify(bad));
    }
  });

  test('refuses a hash whose stored key was altered', async () => {
    const encoded = await hashPassword(PASSWORD);
    const parts = encoded.split('$');

    const key = Buffer.from(parts[6], 'base64url');
    key[0] ^= 0xff;
    parts[6] = key.toString('base64url');

    assert.equal(await verifyPassword(PASSWORD, parts.join('$')), false);
  });

  test('refuses a hash whose salt was altered', async () => {
    const parts = (await hashPassword(PASSWORD)).split('$');

    const salt = Buffer.from(parts[5], 'base64url');
    salt[0] ^= 0xff;
    parts[5] = salt.toString('base64url');

    assert.equal(await verifyPassword(PASSWORD, parts.join('$')), false);
  });

  test('refuses a hash whose cost was edited under it', async () => {
    const parts = (await hashPassword(PASSWORD)).split('$');
    parts[2] = String(Number(parts[2]) * 2);

    assert.equal(await verifyPassword(PASSWORD, parts.join('$')), false);
  });

  test('refuses a hash whose p was edited under it, up or down', async () => {
    const encoded = await hashPassword(PASSWORD);
    assert.equal(encoded.split('$')[4], '5', 'the fixture really is a p=5 hash');
    // Sanity: untouched, this same value verifies.
    assert.equal(await verifyPassword(PASSWORD, encoded), true);

    // Lowering p is the attack — it would make every guess five times
    // cheaper — but any value other than the version's is refused.
    for (const forged of ['1', '2', '4', '6', '10']) {
      const parts = encoded.split('$');
      parts[4] = forged;
      assert.equal(await verifyPassword(PASSWORD, parts.join('$')), false, `p=${forged}`);
    }
  });

  test('refuses a hash whose r was edited under it', async () => {
    const parts = (await hashPassword(PASSWORD)).split('$');
    parts[3] = String(Number(parts[3]) * 2);

    assert.equal(await verifyPassword(PASSWORD, parts.join('$')), false);
  });

  test('a key of the wrong length can never compare equal', async () => {
    const parts = (await hashPassword(PASSWORD)).split('$');
    parts[6] = Buffer.from(parts[6], 'base64url').subarray(0, 16).toString('base64url');

    // timingSafeEqual throws on different lengths; verifyPassword must not.
    assert.equal(await verifyPassword(PASSWORD, parts.join('$')), false);
  });
});

describe('verifyPasswordOrDummy', () => {
  test('behaves like verifyPassword when there is a stored hash', async () => {
    const encoded = await hashPassword(PASSWORD);

    assert.equal(await verifyPasswordOrDummy(PASSWORD, encoded), true);
    assert.equal(await verifyPasswordOrDummy('wrong-password-entirely', encoded), false);
  });

  test('still answers false, having done the work, when there is none', async () => {
    for (const missing of [null, undefined, '']) {
      assert.equal(await verifyPasswordOrDummy(PASSWORD, missing), false, String(missing));
    }
  });

  test('the dummy is a real hash, made once and reused', async () => {
    const [first, second] = [await dummyPasswordHash(), await dummyPasswordHash()];

    assert.equal(first, second, 'the same value every time');
    // A real v1 hash at the real cost — p included. The dummy is only
    // worth having if checking it costs what checking a real one costs.
    assert.match(first, /^scrypt\$v1\$16384\$8\$5\$/);
    // It is a hash of something nobody knows, so nothing verifies against it.
    assert.equal(await verifyPassword(PASSWORD, first), false);
  });

  test('the dummy is one this module can still read back', async () => {
    // If the dummy ever stopped parsing, verifyPasswordOrDummy would bail
    // out of derive() early and the timing it exists to hide would come
    // back. Round-tripping the encoded value proves the work is really done.
    const encoded = await dummyPasswordHash();

    assert.equal(await verifyPassword('anything-at-all-here', encoded), false);
    assert.equal(await verifyPasswordOrDummy('anything-at-all-here', null), false);

    const parts = encoded.split('$');
    assert.equal(parts.length, 7);
    assert.deepEqual(parts.slice(0, 5), ['scrypt', 'v1', '16384', '8', '5']);
    assert.equal(Buffer.from(parts[6], 'base64url').length, 32);
  });
});
