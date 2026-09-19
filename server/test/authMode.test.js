import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DATABASE_SESSION_VERSION, databasePayload, sessionSubject, sharedPayload,
} from '../src/auth/session.js';

/**
 * The sign-in mode itself: how it is resolved, and the rule that keeps one
 * mode's cookies out of the other. None of this needs Postgres.
 */

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Import the auth config in a fresh process with this environment, because
 * it is read once at import and a test cannot un-import it.
 *
 * @returns {{ok: true, mode: string} | {ok: false, message: string}}
 */
function loadConfigWith(env) {
  try {
    const out = execFileSync(
      process.execPath,
      ['-e', "import('./src/auth/config.js').then(m => console.log(m.authConfig.mode))"],
      { cwd: SERVER_DIR, env: { ...process.env, NODE_ENV: 'test', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { ok: true, mode: out.trim().split('\n').at(-1) };
  } catch (err) {
    return { ok: false, message: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('AUTH_MODE', () => {
  test('defaults to shared, so deploying without setting it changes nothing', () => {
    assert.deepEqual(loadConfigWith({ AUTH_MODE: '' }), { ok: true, mode: 'shared' });

    // Unset entirely, not merely blank.
    const unset = { ...process.env };
    delete unset.AUTH_MODE;
    assert.equal(loadConfigWith({ AUTH_MODE: undefined }).mode, 'shared');
  });

  test('accepts the two modes it knows', () => {
    assert.equal(loadConfigWith({ AUTH_MODE: 'shared' }).mode, 'shared');
    assert.equal(loadConfigWith({ AUTH_MODE: 'database' }).mode, 'database');
    assert.equal(loadConfigWith({ AUTH_MODE: '  database  ' }).mode, 'database', 'trimmed');
  });

  test('refuses anything else instead of quietly falling back', () => {
    for (const bad of ['Database', 'DATABASE', 'db', 'sharedd', 'none', 'off']) {
      const result = loadConfigWith({ AUTH_MODE: bad });
      assert.equal(result.ok, false, `${bad} should stop the start`);
      assert.match(result.message, /AUTH_MODE must be one of: shared, database/);
      assert.ok(!result.message.includes(bad), 'the bad value is not echoed back');
    }
  });
});

describe('sessionSubject', () => {
  const shared = sharedPayload('admin', Date.now() + 1000);
  const database = databasePayload(7, 1, Date.now() + 1000);

  test('reads a shared cookie only in shared mode', () => {
    assert.deepEqual(sessionSubject(shared, 'shared'), { kind: 'shared', username: 'admin' });
    assert.equal(sessionSubject(shared, 'database'), null, 'a shared cookie is not a way into database mode');
  });

  test('reads a database cookie only in database mode', () => {
    assert.deepEqual(sessionSubject(database, 'database'), { kind: 'database', uid: 7, sv: 1 });
    assert.equal(sessionSubject(database, 'shared'), null, 'a database cookie is not a way into shared mode');
  });

  test('the database payload carries an id and nothing that can go stale', () => {
    assert.deepEqual(Object.keys(database).sort(), ['exp', 'sv', 'uid', 'v']);
    assert.equal(database.v, DATABASE_SESSION_VERSION);
    assert.ok(!('role' in database), 'the role is never signed into the cookie');
    assert.ok(!('active' in database), 'nor whether the account is switched on');
    // sv is not an exception: it is not trusted as a fact, it is a number
    // the row has to agree with. The row is what decides.
    assert.equal(database.sv, 1, 'the counter it was signed at');
  });

  test('a database payload with no usable session version is refused', () => {
    // A v2 cookie from before revocation existed carries no sv. There is no
    // honest default for it — assuming 1 would keep alive exactly the
    // cookies the counter exists to end — so it is refused.
    for (const sv of [undefined, null, 0, -1, 1.5, '1', {}, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(
        sessionSubject({ v: DATABASE_SESSION_VERSION, uid: 7, sv, exp: 1 }, 'database'),
        null,
        JSON.stringify(sv)
      );
    }
  });

  test('a version this build does not know is refused', () => {
    for (const v of [1, 3, 99, '2', null]) {
      assert.equal(sessionSubject({ v, uid: 7, sv: 1, exp: 1 }, 'database'), null, `v=${JSON.stringify(v)}`);
    }
  });

  test('a database payload with no usable id is refused', () => {
    for (const uid of [undefined, null, 0, -1, 1.5, '7', {}, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal(
        sessionSubject({ v: DATABASE_SESSION_VERSION, uid, sv: 1, exp: 1 }, 'database'),
        null,
        JSON.stringify(uid)
      );
    }
  });

  test('rubbish is refused in either mode rather than throwing', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}, { sub: '' }, { sub: 5 }]) {
      assert.equal(sessionSubject(bad, 'shared'), null, `shared ${JSON.stringify(bad)}`);
      assert.equal(sessionSubject(bad, 'database'), null, `database ${JSON.stringify(bad)}`);
    }
  });
});
