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


/**
 * The sign-in path must cost the same however it fails (#18 Phase 1C).
 *
 * The review found the hole: verifyPasswordOrDummy only reached for the
 * dummy when the stored value was absent, so a row holding a *malformed*
 * hash returned false without doing any scrypt at all. That is a timing
 * signal about a particular account, which is the thing this helper exists
 * to remove.
 *
 * The assertions below are deliberately coarse and relative: one real
 * scrypt is measured on this machine first, and every other path has to
 * cost a meaningful fraction of it. The gap being measured is between
 * ~0 ms and a full derivation, so nothing here depends on a tight timing.
 */
describe('verifyPasswordOrDummy — every refusal costs the same', () => {
  // Non-empty strings that all look like stored credentials and none of
  // which parseHash can use. Before the fix, each returned false for free.
  const UNUSABLE = {
    'null (no account)': null,
    'undefined': undefined,
    'empty string': '',
    'not a hash at all': 'not-a-hash',
    'too few fields': 'scrypt$v1$16384$8$5$onlysixfields',
    'too many fields': 'scrypt$v1$16384$8$5$c2FsdA$aGFzaA$extra',
    'another algorithm': 'bcrypt$v1$16384$8$5$c2FsdA$aGFzaA',
    'a version we do not know': 'scrypt$v9$16384$8$5$c2FsdA$aGFzaA',
    'N that is not a number': 'scrypt$v1$abc$8$5$c2FsdA$aGFzaA',
    'the wrong parameters': 'scrypt$v1$16384$8$1$c2FsdA$aGFzaA',
    'no salt': 'scrypt$v1$16384$8$5$$aGFzaA',
    'a truncated key': 'scrypt$v1$16384$8$5$c2FsdHNhbHQ$aGFzaA',
    'a malformed base64 body': 'scrypt$v1$16384$8$5$!!!!$!!!!',
  };

  const ms = async (fn) => {
    const started = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  test('every unusable stored hash still answers false', async () => {
    for (const [label, bad] of Object.entries(UNUSABLE)) {
      assert.equal(await verifyPasswordOrDummy(PASSWORD, bad), false, label);
    }
  });

  test('and pays for a real scrypt on the way to saying it', async () => {
    // Warm the memoised dummy, so the first case measured below is not the
    // one that also has to create it.
    await dummyPasswordHash();

    const good = await hashPassword(PASSWORD);
    // What one genuine verification costs here, right now. Everything else
    // is judged against this rather than against a number written down.
    const real = Math.min(
      await ms(() => verifyPassword('a-wrong-password-of-length', good)),
      await ms(() => verifyPassword('a-wrong-password-of-length', good))
    );
    assert.ok(real > 1, `a real scrypt should be measurable, got ${real.toFixed(2)}ms`);

    // A quarter of one derivation. The path being caught returns in
    // microseconds, so this is a chasm, not a hair.
    const floor = real / 4;

    for (const [label, bad] of Object.entries(UNUSABLE)) {
      const took = await ms(() => verifyPasswordOrDummy(PASSWORD, bad));
      assert.ok(
        took > floor,
        `${label}: ${took.toFixed(2)}ms — under ${floor.toFixed(2)}ms means no scrypt was done, ` +
          'which is exactly the signal this helper exists to remove'
      );
    }
  });

  test('a usable hash is still checked against itself, not the dummy', async () => {
    // The fix must not have turned real verification into dummy work.
    const good = await hashPassword(PASSWORD);

    assert.equal(await verifyPasswordOrDummy(PASSWORD, good), true);
    assert.equal(await verifyPasswordOrDummy('the-wrong-password-here', good), false);
  });

  test('the dummy is reused rather than made again for each refusal', async () => {
    // Each fresh module instance starts with no dummy, so the first refusal
    // through it has to build one; the ones after must not.
    const fresh = await import('../src/lib/passwords.js?case=reuse');

    const first = await ms(() => fresh.verifyPasswordOrDummy(PASSWORD, 'not-a-hash'));
    const second = await ms(() => fresh.verifyPasswordOrDummy(PASSWORD, 'not-a-hash'));

    // Building the dummy is a hash of its own, so the first call does two
    // derivations and the rest do one. Generous margin: the point is only
    // that it is not rebuilt every time.
    assert.ok(second < first, `first ${first.toFixed(2)}ms, second ${second.toFixed(2)}ms`);
    assert.equal(await fresh.dummyPasswordHash(), await fresh.dummyPasswordHash());
  });
});
