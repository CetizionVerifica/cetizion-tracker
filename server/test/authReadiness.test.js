import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

import { AuthReadinessError, assertAuthReady } from '../src/auth/readiness.js';
import { createUser } from '../src/lib/users.js';

/**
 * The guard that stops AUTH_MODE=database serving a tracker nobody could
 * sign in to (#18 Phase 1B-A).
 *
 * Every call passes its own `db` and `mode`, so nothing here depends on the
 * environment and nothing writes to the real DATABASE_URL.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const quiet = () => {};

describe('assertAuthReady', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `readiness_suite_${process.pid}_${Date.now()}`;
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
  const check = (mode) => assertAuthReady({ db, mode, log: quiet });

  const refuses = async (label) => {
    await assert.rejects(check('database'), (err) => {
      assert.ok(err instanceof AuthReadinessError, `${label}: ${err.constructor.name}`);
      assert.match(err.message, /no active admin/);
      // It must say which way out exists, not merely that it stopped.
      assert.match(err.message, /BOOTSTRAP_ADMIN_/);
      assert.match(err.message, /AUTH_MODE=shared/);
      return true;
    }, label);
  };

  // ------------------------------------------------------------ shared mode

  test('shared mode does not care whether the users table has anybody in it', async () => {
    await clean();

    assert.deepEqual(await check('shared'), { mode: 'shared', checked: false });
  });

  test('shared mode is unbothered even with only switched-off accounts', async () => {
    await clean();
    await createUser({ name: 'Retired', active: false, role: 'admin' }, db);

    assert.deepEqual(await check('shared'), { mode: 'shared', checked: false });
  });

  // ---------------------------------------------------------- database mode

  test('database mode refuses to start with no users at all', async () => {
    await clean();

    await refuses('empty table');
  });

  test('database mode refuses to start with only an inactive admin', async () => {
    await clean();
    await createUser({ name: 'Retired', active: false, role: 'admin' }, db);

    // An admin who cannot sign in cannot let anybody else in either.
    await refuses('inactive admin only');
  });

  test('database mode refuses to start with only active sales users', async () => {
    await clean();
    await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    await createUser({ name: 'Sue', email: 'sue@example.com', password: PASSWORD, role: 'sales' }, db);

    // They can sign in; nobody can administer, so nobody can ever make one.
    await refuses('sales only');
  });

  test('database mode starts once there is one active admin', async () => {
    await clean();
    const alice = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' },
      db
    );

    assert.deepEqual(await check('database'), { mode: 'database', checked: true, adminId: alice.id });
  });

  test('an active admin among sales users is enough', async () => {
    await clean();
    await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    const alice = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' },
      db
    );
    await createUser({ name: 'Retired', active: false, role: 'admin' }, db);

    assert.equal((await check('database')).adminId, alice.id);
  });

  test('switching the only admin off closes the door again', async () => {
    await clean();
    const alice = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' },
      db
    );
    assert.equal((await check('database')).checked, true);

    await db.query('UPDATE users SET active = false WHERE id = $1', [alice.id]);

    await refuses('the last admin was switched off');
  });

  test('demoting the only admin closes the door too', async () => {
    await clean();
    const alice = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' },
      db
    );

    await db.query(`UPDATE users SET role = 'sales' WHERE id = $1`, [alice.id]);

    await refuses('the last admin was demoted');
  });

  // ------------------------------------------------------- a broken database

  test('a users table that cannot be read is refused, not assumed empty', async () => {
    const broken = {
      query: () => Promise.reject(Object.assign(new Error('relation "users" does not exist'), { code: '42P01' })),
    };

    await assert.rejects(
      assertAuthReady({ db: broken, mode: 'database', log: quiet }),
      (err) => {
        assert.ok(err instanceof AuthReadinessError);
        assert.match(err.message, /could not be read/);
        return true;
      }
    );
  });

  test('a broken database still does not stop shared mode', async () => {
    const broken = { query: () => Promise.reject(new Error('down')) };

    assert.deepEqual(
      await assertAuthReady({ db: broken, mode: 'shared', log: quiet }),
      { mode: 'shared', checked: false }
    );
  });
});
