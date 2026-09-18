import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

import { createUser, findUserByEmail, normalizeEmail } from '../src/lib/users.js';
import { verifyPassword } from '../src/lib/passwords.js';

/**
 * The users table (#18) and the small data layer over it.
 *
 * The rules that matter are in the schema, not in the code that writes to
 * it, so most of these go straight to SQL: whatever writes to this table
 * later — an admin screen, an importer, someone at a psql prompt — meets
 * the same constraints.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 * Without it the suite is skipped, as in migrations.test.js.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

/** Run schema.sql + views.sql against a fresh database. */
async function applySchema(dbUrl) {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}

describe('users', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `users_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    await applySchema(dbUrl);
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
  });

  after(async () => {
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const clean = () => db.query('DELETE FROM users');

  /** Insert straight past the data layer, to test the table itself. */
  const insert = (columns, values) =>
    db.query(
      `INSERT INTO users (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      values
    );

  const login = (email, extra = {}) => ({
    name: 'A Person',
    email,
    password_hash: 'scrypt$v1$16384$8$5$c2FsdHNhbHQ$a2V5a2V5',
    role: 'sales',
    active: true,
    ...extra,
  });

  const insertRow = (row) => insert(Object.keys(row), Object.values(row));

  // -------------------------------------------------------------- the table

  test('the table is there, with the columns the app expects', async () => {
    const { rows } = await db.query(
      `SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' ORDER BY column_name`
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    assert.deepEqual(Object.keys(byName).sort(), [
      'active', 'created_at', 'email', 'id', 'last_login_at',
      'name', 'password_hash', 'role', 'updated_at',
    ]);
    assert.equal(byName.name.is_nullable, 'NO');
    assert.equal(byName.role.is_nullable, 'NO');
    assert.equal(byName.active.is_nullable, 'NO');
    // The two that a historical, attribution-only row leaves empty.
    assert.equal(byName.email.is_nullable, 'YES');
    assert.equal(byName.password_hash.is_nullable, 'YES');
  });

  // --------------------------------------------------------------- the role

  test('accepts admin and sales', async () => {
    await clean();

    await insertRow(login('admin@example.com', { role: 'admin' }));
    await insertRow(login('sales@example.com', { role: 'sales' }));

    const { rows } = await db.query('SELECT role FROM users ORDER BY role');
    assert.deepEqual(rows.map((r) => r.role), ['admin', 'sales']);
  });

  test('refuses any other role', async () => {
    await clean();

    for (const role of ['finance', 'Admin', 'ADMIN', 'superuser', '']) {
      await assert.rejects(
        insertRow(login('someone@example.com', { role })),
        (err) => err.code === '23514',
        `role ${JSON.stringify(role)} should be refused`
      );
    }
  });

  test('defaults a new row to the role with the least access', async () => {
    await clean();

    await insert(
      ['name', 'email', 'password_hash'],
      ['A Person', 'defaulted@example.com', 'scrypt$v1$16384$8$5$c2FsdA$a2V5']
    );

    assert.equal(await scalar('SELECT role FROM users'), 'sales');
  });

  // ------------------------------------------------ active / login invariant

  test('an active user can be created with an email and a password hash', async () => {
    await clean();

    const { rows } = await insertRow(login('active@example.com'));
    assert.ok(rows[0].id);
  });

  test('an inactive historical user needs neither', async () => {
    await clean();

    await insert(['name', 'active'], ['Ramesh', false]);

    const { rows } = await db.query('SELECT name, email, password_hash, active FROM users');
    assert.deepEqual(rows, [{ name: 'Ramesh', email: null, password_hash: null, active: false }]);
  });

  test('an active user with no email is refused', async () => {
    await clean();

    await assert.rejects(
      insert(['name', 'password_hash', 'active'], ['A Person', 'scrypt$v1$16384$8$5$c2FsdA$a2V5', true]),
      (err) => err.code === '23514' && /users_active_needs_login/.test(err.constraint ?? '')
    );
  });

  test('an active user with no password hash is refused', async () => {
    await clean();

    await assert.rejects(
      insert(['name', 'email', 'active'], ['A Person', 'nohash@example.com', true]),
      (err) => err.code === '23514' && /users_active_needs_login/.test(err.constraint ?? '')
    );
  });

  test('active is the default, so a bare insert cannot slip past the invariant', async () => {
    await clean();

    await assert.rejects(
      insert(['name'], ['A Person']),
      (err) => err.code === '23514' && /users_active_needs_login/.test(err.constraint ?? '')
    );
  });

  test('a blank name, email or hash is not a value', async () => {
    await clean();

    await assert.rejects(insertRow(login('blank-name@example.com', { name: '   ' })), (err) => err.code === '23514');
    await assert.rejects(insertRow(login('   ')), (err) => err.code === '23514');
    await assert.rejects(
      insertRow(login('blank-hash@example.com', { password_hash: '  ' })),
      (err) => err.code === '23514'
    );
  });

  // ------------------------------------------------------- email uniqueness

  test('the same address cannot be taken twice', async () => {
    await clean();
    await insertRow(login('taken@example.com'));

    await assert.rejects(insertRow(login('taken@example.com')), (err) => err.code === '23505');
  });

  test('the same address in different case is the same address', async () => {
    await clean();
    await insertRow(login('a@example.com'));

    for (const variant of ['A@Example.com', 'A@EXAMPLE.COM', 'a@Example.Com']) {
      await assert.rejects(insertRow(login(variant)), (err) => err.code === '23505', variant);
    }
  });

  test('any number of historical users may have no email at all', async () => {
    await clean();

    await insert(['name', 'active'], ['Ramesh', false]);
    await insert(['name', 'active'], ['Suresh', false]);
    await insert(['name', 'active'], ['Ramesh', false]); // same name, still fine

    assert.equal(await scalar('SELECT count(*)::int FROM users'), 3);
  });

  // ------------------------------------------------------------- updated_at

  test('updated_at follows an edit, the way every other table does', async () => {
    await clean();
    const { rows } = await insertRow(login('touch@example.com'));
    const before = await scalar('SELECT updated_at FROM users WHERE id = $1', [rows[0].id]);

    await db.query(`UPDATE users SET name = 'Renamed' WHERE id = $1`, [rows[0].id]);

    const after = await scalar('SELECT updated_at FROM users WHERE id = $1', [rows[0].id]);
    assert.ok(after > before, 'updated_at moved');
  });

  // -------------------------------------------------------- the data layer

  test('createUser hashes the password and never stores it as given', async () => {
    await clean();

    const user = await createUser({ name: 'Shivam', email: 'shivam@example.com', password: PASSWORD, role: 'admin' }, db);

    assert.equal(user.role, 'admin');
    assert.equal(user.active, true);
    assert.notEqual(user.password_hash, PASSWORD);
    assert.equal(await verifyPassword(PASSWORD, user.password_hash), true);

    // Not anywhere in the row, under any encoding.
    const stored = await scalar('SELECT users::text FROM users');
    assert.ok(!stored.includes(PASSWORD));
  });

  test('createUser makes an attribution-only user with no email or password', async () => {
    await clean();

    const user = await createUser({ name: '  Ramesh   Kumar ', active: false }, db);

    assert.equal(user.name, 'Ramesh Kumar', 'stray spaces collapsed');
    assert.equal(user.email, null);
    assert.equal(user.password_hash, null);
    assert.equal(user.active, false);
  });

  test('createUser refuses what the table would refuse, before reaching it', async () => {
    await clean();

    await assert.rejects(createUser({ name: '   ' }, db), /needs a name/);
    await assert.rejects(createUser({ name: 'X', role: 'finance' }, db), /Role must be one of/);
    await assert.rejects(createUser({ name: 'X', email: 'x@example.com' }, db), /needs both/);
    await assert.rejects(createUser({ name: 'X', password: PASSWORD }, db), /needs both/);
    assert.equal(await scalar('SELECT count(*)::int FROM users'), 0, 'nothing was written');
  });

  test('findUserByEmail matches however the address was typed', async () => {
    await clean();
    await createUser({ name: 'Shivam', email: 'Shivam@Example.com', password: PASSWORD }, db);

    for (const typed of ['Shivam@Example.com', 'shivam@example.com', 'SHIVAM@EXAMPLE.COM', '  shivam@example.com  ']) {
      const found = await findUserByEmail(typed, db);
      assert.equal(found?.email, 'Shivam@Example.com', `${typed} should find the row, keeping its own casing`);
    }
  });

  test('findUserByEmail answers null rather than guessing', async () => {
    await clean();

    for (const nothing of ['nobody@example.com', '', '   ', null, undefined, 42]) {
      assert.equal(await findUserByEmail(nothing, db), null, JSON.stringify(nothing));
    }
  });

  test('normalizeEmail trims and treats blank as absent', () => {
    assert.equal(normalizeEmail('  a@example.com '), 'a@example.com');
    assert.equal(normalizeEmail('A@Example.com'), 'A@Example.com', 'casing is the reader’s');
    for (const blank of ['', '   ', null, undefined, {}]) assert.equal(normalizeEmail(blank), null);
  });

  async function scalar(sql, params = []) {
    const { rows } = await db.query(sql, params);
    return rows[0] ? Object.values(rows[0])[0] : undefined;
  }
});
