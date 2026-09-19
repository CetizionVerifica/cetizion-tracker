import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

import { authReadinessReport, formatReadinessReport } from '../src/auth/check.js';
import { createUser } from '../src/lib/users.js';

/**
 * The read-only readiness check an operator runs before a cutover
 * (#18 Phase 1B-C1).
 *
 * Every call passes its own `db`, so nothing here touches the real
 * DATABASE_URL and nothing depends on the machine it runs on.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

const of = (report, key) => report.checks.find((c) => c.key === key);

describe('the readiness check', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `authcheck_suite_${process.pid}_${Date.now()}`;
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
  const report = () => authReadinessReport({ db });

  // ------------------------------------------------------------- ready

  test('an active admin with real credentials is ready', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);

    const result = await report();

    assert.equal(result.ready, true, JSON.stringify(result.checks, null, 2));
    assert.equal(result.activeAdmins, 1);
    // Every check that gates the verdict passes. The second-admin line is
    // advisory and warns here, which is the point of it being advisory.
    for (const c of result.checks.filter((c) => !c.advisory)) {
      assert.equal(c.ok, true, `${c.key}: ${c.detail}`);
    }
    assert.match(formatReadinessReport(result), /READY FOR AUTH_MODE=database/);
  });

  test('one admin is ready, and still told that a second is wanted', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);

    const result = await report();
    const second = result.checks.find((c) => c.key === 'second-admin');

    assert.ok(second, 'the check is there');
    assert.equal(second.advisory, true, 'advisory, so it cannot block a cutover');
    assert.equal(second.ok, false, 'and with one admin it has something to say');
    assert.equal(result.ready, true, 'a recommendation is not a requirement');

    const text = formatReadinessReport(result);
    assert.match(text, /WARN/, 'shown as a warning, not a failure');
    assert.match(text, /READY FOR AUTH_MODE=database/);
    assert.match(text, /A WARN does not stop a cutover/);
  });

  test('a second admin settles it', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    await createUser({ name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'admin' }, db);

    const result = await report();

    assert.equal(result.checks.find((c) => c.key === 'second-admin').ok, true);
    assert.equal(result.ready, true);
    assert.doesNotMatch(formatReadinessReport(result), /WARN/);
  });

  test('the table line counts active and inactive, and names nobody', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    await createUser({ name: 'Ramesh', active: false }, db);

    const result = await report();
    const table = result.checks.find((c) => c.key === 'table');

    assert.match(table.detail, /2 rows/);
    assert.match(table.detail, /1 active/);
    assert.match(table.detail, /1 inactive/);
    // Counts only. The whole report still carries no address.
    assert.doesNotMatch(formatReadinessReport(result), /alice@example\.com|Ramesh/);
  });

  test('sales users alongside an admin are fine', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);

    const result = await report();

    assert.equal(result.ready, true);
    assert.equal(result.activeAdmins, 1);
  });

  test('attribution-only names do not spoil it', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    await createUser({ name: 'Ramesh', active: false }, db);
    await createUser({ name: 'Suresh', active: false }, db);

    const result = await report();

    // They have no email and no password, and that is correct for them:
    // only accounts that may sign in need something to sign in with.
    assert.equal(result.ready, true, JSON.stringify(result.checks));
    assert.equal(of(result, 'credentials').ok, true);
    assert.equal(of(result, 'unique-emails').ok, true, 'several nulls are not a collision');
  });

  // --------------------------------------------------------- not ready

  test('an empty users table is not ready', async () => {
    await clean();

    const result = await report();

    assert.equal(result.ready, false);
    assert.equal(result.activeAdmins, 0);
    assert.equal(of(result, 'admins').ok, false);
    assert.match(of(result, 'admins').detail, /none/);
    assert.match(formatReadinessReport(result), /NOT READY FOR AUTH_MODE=database/);
  });

  test('an inactive admin is not an admin', async () => {
    await clean();
    await createUser({ name: 'Retired', active: false, role: 'admin' }, db);

    const result = await report();

    assert.equal(result.ready, false);
    assert.equal(of(result, 'admins').ok, false);
  });

  test('sales users only is not ready', async () => {
    await clean();
    await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    await createUser({ name: 'Sue', email: 'sue@example.com', password: PASSWORD, role: 'sales' }, db);

    const result = await report();

    assert.equal(result.ready, false, 'they can sign in; nobody can administer');
    assert.equal(of(result, 'admins').ok, false);
    assert.equal(of(result, 'credentials').ok, true, 'their own credentials are fine, which is not the problem');
  });

  test('a database that will not answer is not ready, and says only that', async () => {
    const broken = { query: () => Promise.reject(new Error('connection refused')) };

    const result = await authReadinessReport({ db: broken });

    assert.equal(result.ready, false);
    assert.equal(of(result, 'database').ok, false);
    assert.equal(result.checks.length, 1, 'nothing after it could mean anything');
  });

  test('a missing users table is reported as such, not as a crash', async () => {
    const missing = {
      query: (sql) =>
        /FROM users/.test(sql)
          ? Promise.reject(Object.assign(new Error('relation "users" does not exist'), { code: '42P01' }))
          : Promise.resolve({ rows: [{}] }),
    };

    const result = await authReadinessReport({ db: missing });

    assert.equal(result.ready, false);
    assert.equal(of(result, 'database').ok, true);
    assert.equal(of(result, 'table').ok, false);
    assert.match(of(result, 'table').detail, /does not exist/);
  });

  test('an address nobody could type is caught', async () => {
    await clean();
    const alice = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db
    );
    // Past the application, straight into the column, the way a botched
    // import or a hand-written UPDATE would.
    await db.query(`UPDATE users SET email = 'not-an-address' WHERE id = $1`, [alice.id]);

    const result = await report();

    assert.equal(result.ready, false);
    assert.equal(of(result, 'email-shape').ok, false);
    assert.equal(of(result, 'admins').ok, true, 'they are still an admin, just an unreachable one');
  });

  // ---------------------------------------------------- output safety

  test('the report never carries a secret', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);

    const result = await report();
    const text = `${formatReadinessReport(result)}\n${JSON.stringify(result)}`;

    assert.ok(!text.includes(PASSWORD), 'no password');
    assert.ok(!/scrypt|password_hash/.test(text), 'no hash, and no hint of one');
    // Addresses are not secrets, but a terminal or a CI log is a worse place
    // to keep them than Settings -> Users, so they stay out of this.
    assert.ok(!text.includes('alice@example.com'), 'no email addresses');
    assert.ok(!text.includes('sam@example.com'), 'no email addresses');
    assert.ok(!/SESSION_SECRET|AUTH_PASSWORD|BOOTSTRAP_ADMIN_PASSWORD/.test(text), 'no secret variable names');
  });

  test('it reads and never writes', async () => {
    await clean();
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    const before = (await db.query('SELECT * FROM users ORDER BY id')).rows;

    await report();
    await report();

    const after = (await db.query('SELECT * FROM users ORDER BY id')).rows;
    assert.deepEqual(after, before, 'not one column moved — not even updated_at');
  });

  test('the formatted report lines up and states a verdict either way', async () => {
    await clean();
    const notReady = formatReadinessReport(await report());
    await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    const ready = formatReadinessReport(await report());

    for (const text of [ready, notReady]) {
      assert.match(text, /^Database authentication readiness$/m);
      assert.match(text, /(PASS|FAIL)/);
    }
    assert.match(ready, /^READY FOR AUTH_MODE=database$/m);
    assert.match(notReady, /^NOT READY FOR AUTH_MODE=database/m);
  });
});
