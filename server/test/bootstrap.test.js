import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

import {
  BootstrapConfigError, CONFLICT, bootstrapAdmin, readBootstrapConfig,
} from '../src/auth/bootstrap.js';
import { verifyPassword } from '../src/lib/passwords.js';
import { createUser, findActiveAdmin } from '../src/lib/users.js';

/**
 * The first admin (#18 Phase 1A).
 *
 * The configuration half needs nothing but the module; the rest runs
 * against a throwaway database. Set TEST_DATABASE_URL to run that half.
 *
 * Every call passes its own `env` and `db`, so nothing here depends on the
 * machine it runs on, and nothing writes to the real DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

const FULL = {
  BOOTSTRAP_ADMIN_NAME: 'Shivam',
  BOOTSTRAP_ADMIN_EMAIL: 'shivam@example.com',
  BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
};

const quiet = () => {};

// ---------------------------------------------------------------- config

describe('readBootstrapConfig', () => {
  test('no variables at all means there is nothing to do', () => {
    assert.equal(readBootstrapConfig({}), null);
    // Blank counts as unset: a variable declared in .env and left empty.
    assert.equal(
      readBootstrapConfig({ BOOTSTRAP_ADMIN_NAME: '', BOOTSTRAP_ADMIN_EMAIL: '  ', BOOTSTRAP_ADMIN_PASSWORD: '' }),
      null
    );
  });

  test('all three gives the admin to create, trimmed', () => {
    const wanted = readBootstrapConfig({
      ...FULL,
      BOOTSTRAP_ADMIN_NAME: '  Shivam   Balyan ',
      BOOTSTRAP_ADMIN_EMAIL: '  Shivam@Example.com  ',
    });

    assert.deepEqual(wanted, {
      name: 'Shivam Balyan',
      email: 'Shivam@Example.com',
      password: PASSWORD,
    });
  });

  test('a half-set configuration stops, naming the variables but not their contents', () => {
    for (const missing of Object.keys(FULL)) {
      const env = { ...FULL };
      delete env[missing];

      assert.throws(
        () => readBootstrapConfig(env),
        (err) => {
          assert.ok(err instanceof BootstrapConfigError);
          assert.match(err.message, new RegExp(missing));
          assert.ok(!err.message.includes(PASSWORD), 'the password is never in the message');
          return true;
        },
        `missing ${missing}`
      );
    }
  });

  test('one variable on its own stops too', () => {
    assert.throws(
      () => readBootstrapConfig({ BOOTSTRAP_ADMIN_EMAIL: 'shivam@example.com' }),
      BootstrapConfigError
    );
  });

  test('an email that is not an address stops', () => {
    for (const email of ['shivam', 'shivam@', '@example.com', 'shivam@example', 'a b@example.com']) {
      assert.throws(
        () => readBootstrapConfig({ ...FULL, BOOTSTRAP_ADMIN_EMAIL: email }),
        BootstrapConfigError,
        email
      );
    }
  });

  test('a password that cannot be used stops, without quoting it', () => {
    // Deliberately not a word the message itself could contain.
    const tooShort = 'Qz7Kw';

    assert.throws(
      () => readBootstrapConfig({ ...FULL, BOOTSTRAP_ADMIN_PASSWORD: tooShort }),
      (err) => {
        assert.ok(err instanceof BootstrapConfigError);
        assert.match(err.message, /BOOTSTRAP_ADMIN_PASSWORD/);
        assert.ok(!err.message.includes(tooShort), 'the password is never in the message');
        return true;
      }
    );
  });
});

// -------------------------------------------------------------- the run

describe('bootstrapAdmin', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `bootstrap_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
  });

  after(async () => {
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const clean = () => db.query('DELETE FROM users');
  const run = (env) => bootstrapAdmin({ db, env, log: quiet, warn: quiet });
  /** The same call keeping the warning, to prove one is actually emitted. */
  const runLoud = (env, warn) => bootstrapAdmin({ db, env, log: quiet, warn });
  const users = async () => (await db.query('SELECT * FROM users ORDER BY id')).rows;

  test('the first run creates exactly one active admin', async () => {
    await clean();

    const result = await run(FULL);

    assert.equal(result.status, 'created');
    const rows = await users();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, 'Shivam');
    assert.equal(rows[0].email, 'shivam@example.com');
    assert.equal(rows[0].role, 'admin');
    assert.equal(rows[0].active, true);
    assert.equal(rows[0].last_login_at, null, 'nobody has signed in as it');
  });

  test('the password is stored hashed, and the plain one is nowhere in the row', async () => {
    await clean();
    await run(FULL);

    const [user] = await users();
    assert.notEqual(user.password_hash, PASSWORD);
    assert.match(user.password_hash, /^scrypt\$v1\$/);
    assert.equal(await verifyPassword(PASSWORD, user.password_hash), true);

    const { rows } = await db.query('SELECT users::text AS row FROM users');
    assert.ok(!rows[0].row.includes(PASSWORD), 'the plaintext is not anywhere in the row');
  });

  test('running it again changes nothing at all', async () => {
    await clean();
    await run(FULL);
    const [first] = await users();

    const second = await run(FULL);
    const third = await run(FULL);

    assert.equal(second.status, 'exists');
    assert.equal(third.status, 'exists');
    const rows = await users();
    assert.equal(rows.length, 1, 'still one user');
    assert.deepEqual(rows[0], first, 'the row is untouched, hash and all');
  });

  test('it finds the account however the email is cased next time', async () => {
    await clean();
    await run(FULL);

    const result = await run({ ...FULL, BOOTSTRAP_ADMIN_EMAIL: 'SHIVAM@EXAMPLE.COM' });

    assert.equal(result.status, 'exists');
    assert.equal((await users()).length, 1);
  });

  test('the configured admin is left exactly as it is, password included', async () => {
    await clean();
    const theirs = 'the-password-they-chose-later';
    const existing = await createUser(
      { name: 'Shivam Balyan', email: 'shivam@example.com', password: theirs, role: 'admin' },
      db
    );

    const result = await run({ ...FULL, BOOTSTRAP_ADMIN_NAME: 'Someone Else' });

    assert.equal(result.status, 'exists');
    const [after] = await users();
    assert.deepEqual(after, existing, 'not one column moved — not even updated_at');
    assert.equal(await verifyPassword(theirs, after.password_hash), true, 'password not reset');
    assert.equal(after.name, 'Shivam Balyan', 'name not overwritten');
  });

  test('with nothing configured it does nothing and creates nobody', async () => {
    await clean();

    const result = await run({});

    assert.equal(result.status, 'skipped');
    assert.equal((await users()).length, 0);
  });

  test('a half-set configuration throws and writes nothing', async () => {
    await clean();

    await assert.rejects(
      run({ BOOTSTRAP_ADMIN_EMAIL: 'shivam@example.com', BOOTSTRAP_ADMIN_NAME: 'Shivam' }),
      BootstrapConfigError
    );

    assert.equal((await users()).length, 0, 'a bad configuration leaves the table alone');
  });

  // ------------------------------------------------- only ever the first

  test('a changed BOOTSTRAP_ADMIN_EMAIL cannot appoint a second admin', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);

    const result = await run({
      BOOTSTRAP_ADMIN_NAME: 'Bob',
      BOOTSTRAP_ADMIN_EMAIL: 'bob@example.com',
      BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    });

    assert.equal(result.status, 'exists');
    const rows = await users();
    assert.equal(rows.length, 1, 'Bob was not created');
    assert.equal(rows[0].email, 'alice@example.com', 'and Alice was not touched');
  });

  test('an active admin anywhere is enough, whatever the variable says', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);

    // Three restarts, three different addresses in the environment.
    for (const email of ['bob@example.com', 'carol@example.com', 'dave@example.com']) {
      const result = await run({ ...FULL, BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_NAME: 'Someone' });
      assert.equal(result.status, 'exists', email);
    }

    assert.equal((await users()).length, 1, 'still exactly one account');
  });

  test('an inactive admin is not an admin, so the seat is still empty', async () => {
    await clean();
    await createUser({ name: 'Retired', active: false, role: 'admin' }, db);

    const result = await run(FULL);

    assert.equal(result.status, 'created', 'an admin who cannot sign in administers nothing');
    assert.equal((await users()).length, 2);
    assert.equal((await findActiveAdmin(db)).email, 'shivam@example.com');
  });

  // ------------------------------------ the address is taken by somebody

  // ------------------------------------ the address is taken by somebody
  //
  // Neither of these is fatal. The configuration was readable; the database
  // simply is not in a state bootstrapping may resolve on its own. It warns,
  // writes nothing, and lets the caller carry on starting — sign-in does not
  // depend on this table yet.

  test('it will not reactivate an inactive account holding that address', async () => {
    await clean();
    const inactive = await createUser({ name: 'Bob', active: false, role: 'admin' }, db);
    await db.query(`UPDATE users SET email = 'bob@example.com' WHERE id = $1`, [inactive.id]);
    const before = (await users())[0];

    const warnings = [];
    const result = await runLoud(
      { ...FULL, BOOTSTRAP_ADMIN_EMAIL: 'bob@example.com', BOOTSTRAP_ADMIN_NAME: 'Bob' },
      (line) => warnings.push(line)
    );

    assert.deepEqual(result, { status: 'conflict', reason: CONFLICT.inactive, id: inactive.id });

    const rows = await users();
    assert.equal(rows.length, 1, 'nobody was created');
    assert.deepEqual(rows[0], before, 'not one column moved');
    assert.equal(rows[0].active, false, 'still inactive');
    assert.equal(rows[0].password_hash, null, 'still no password');
    assert.equal(rows[0].role, 'admin', 'role untouched');
    assert.equal(await findActiveAdmin(db), null, 'and it did not become an admin who can sign in');

    assert.equal(warnings.length, 1, 'it says so, loudly');
    assert.match(warnings[0], /not active/);
    assert.match(warnings[0], /AUTH_USERNAME \/ AUTH_PASSWORD/, 'and says sign-in is unaffected');
    assert.ok(!warnings[0].includes(PASSWORD), 'no secret in the warning');
    assert.ok(!/scrypt/.test(warnings[0]), 'no hash in the warning');
  });

  test('it will not promote an active sales user holding that address', async () => {
    await clean();
    const theirs = 'the-password-bob-already-has';
    const bob = await createUser(
      { name: 'Bob', email: 'bob@example.com', password: theirs, role: 'sales' },
      db
    );

    const warnings = [];
    const result = await runLoud(
      { ...FULL, BOOTSTRAP_ADMIN_EMAIL: 'bob@example.com', BOOTSTRAP_ADMIN_NAME: 'Bob' },
      (line) => warnings.push(line)
    );

    assert.deepEqual(result, { status: 'conflict', reason: CONFLICT.nonAdmin, id: bob.id });

    const rows = await users();
    assert.equal(rows.length, 1, 'no duplicate was created');
    assert.deepEqual(rows[0], bob, 'Bob is untouched — role, name, password and all');
    assert.equal(rows[0].role, 'sales', 'not promoted');
    assert.equal(await verifyPassword(theirs, rows[0].password_hash), true, 'password not reset');
    assert.equal(await findActiveAdmin(db), null, 'the tracker still has no admin');

    assert.equal(warnings.length, 1, 'it says so, loudly');
    assert.match(warnings[0], /not an admin/);
    assert.ok(!warnings[0].includes(theirs), 'no secret in the warning');
  });

  test('a conflict is not an exception, so startup carries on', async () => {
    await clean();
    await createUser({ name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'sales' }, db);

    // The shape start.js relies on: it must return, not throw.
    const result = await assert.doesNotReject(() =>
      run({ ...FULL, BOOTSTRAP_ADMIN_EMAIL: 'bob@example.com' })
    ).then(() => run({ ...FULL, BOOTSTRAP_ADMIN_EMAIL: 'bob@example.com' }));

    assert.equal(result.status, 'conflict');
    assert.equal((await users()).length, 1, 'and repeating it still writes nothing');
  });

  test('the seat stays open, so fixing the variable still works afterwards', async () => {
    await clean();
    await createUser({ name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'sales' }, db);

    const conflicted = await run({ ...FULL, BOOTSTRAP_ADMIN_EMAIL: 'bob@example.com' });
    assert.equal(conflicted.status, 'conflict');

    // Someone points the variable somewhere free; the next restart works.
    const fixed = await run(FULL);

    assert.equal(fixed.status, 'created');
    assert.equal((await findActiveAdmin(db)).email, 'shivam@example.com');
    assert.equal((await users()).length, 2, 'Bob is still there, still sales');
    assert.equal((await users()).find((u) => u.email === 'bob@example.com').role, 'sales');
  });

  // -------------------------------------------------------- concurrency

  /** n real connections, so they contend in Postgres rather than in one event loop. */
  async function racing(n, envFor) {
    const clients = await Promise.all(
      Array.from({ length: n }, async () => {
        const c = new pg.Client({ connectionString: dbUrl });
        await c.connect();
        return c;
      })
    );
    try {
      return await Promise.allSettled(
        clients.map((c, i) => bootstrapAdmin({ db: c, env: envFor(i), log: quiet }))
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }

  test('two starting at once on the same address leave exactly one admin', async () => {
    await clean();

    const results = await racing(2, () => FULL);

    assert.equal((await users()).length, 1, 'one row, whoever got there first');
    assert.deepEqual(
      results.map((r) => r.value?.status).sort(),
      ['created', 'exists']
    );
  });

  test('containers racing with DIFFERENT addresses still leave exactly one admin', async () => {
    await clean();
    const emails = ['one@example.com', 'two@example.com', 'three@example.com', 'four@example.com'];

    // The case no unique index can catch: four different addresses, so only
    // the lock stops four administrators being created at once.
    const results = await racing(emails.length, (i) => ({
      ...FULL,
      BOOTSTRAP_ADMIN_NAME: `Admin ${i}`,
      BOOTSTRAP_ADMIN_EMAIL: emails[i],
    }));

    const admins = (await users()).filter((u) => u.role === 'admin' && u.active);
    assert.equal(admins.length, 1, 'exactly one active admin');
    assert.equal((await users()).length, 1, 'and nobody else was created either');

    const statuses = results.map((r) => r.value?.status);
    assert.equal(statuses.filter((s) => s === 'created').length, 1, 'exactly one run created it');
    assert.equal(statuses.filter((s) => s === 'exists').length, emails.length - 1, 'the rest stood down');
  });
});
