import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * A record an admin enters for a salesperson belongs to that salesperson.
 *
 * The bug this pins down: an admin created an enquiry with "Madhuri Pogir"
 * as its Owner, the admin's list showed it, and Madhuri's did not — the
 * save left owner_user_id null, and an unowned record is admin-only.
 *
 * Covers the save path (lib/salespersonOwner.js) and migration 096, which
 * applies the same rules to the records saved before the fix. Needs
 * TEST_DATABASE_URL (CI sets it); skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '096_owner_from_salesperson.sql'), 'utf8');
const NAME = `salesperson_owner_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

describe('the salesperson an admin names owns the record', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  let app; let pool; let db;
  const people = {};

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const { createUser } = await import('../src/lib/users.js');

    for (const [key, name, role] of [
      ['alice', 'Alice Admin', 'admin'],
      ['madhuri', 'Madhuri Pogir', 'sales'],
      ['ravi', 'Ravi Kumar', 'sales'],
      ['ravi2', 'Ravi Kumar', 'sales'],
      ['old', 'Old Leaver', 'sales'],
    ]) {
      const user = await createUser({ name, email: `${key}@example.com`, password: PASSWORD, role }, db);
      people[key] = { user };
    }
    for (const key of ['alice', 'madhuri', 'ravi']) {
      const res = await request(app).post('/api/auth/login').send({ email: `${key}@example.com`, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      people[key].cookie = res.headers['set-cookie'];
    }
    await db.query('UPDATE users SET active = false WHERE id = $1', [people.old.user.id]);
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const as = (who) => (method, path) => request(app)[method](path).set('Cookie', people[who].cookie);
  const ownerOf = async (table, id) => (await db.query(`SELECT owner_user_id FROM ${table} WHERE id = $1`, [id])).rows[0].owner_user_id;

  test('an enquiry an admin enters for Madhuri is on Madhuri\'s list', async () => {
    const res = await as('alice')('post', '/api/enquiries')
      .send({ client_name: 'Acme Ltd', enquiry_date: '2026-10-01', sales_person: ' madhuri   pogir ' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.owner_user_id, people.madhuri.user.id);

    const mine = await as('madhuri')('get', '/api/enquiries');
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.some((e) => e.id === res.body.data.id), 'Madhuri sees the enquiry');

    const detail = await as('madhuri')('get', `/api/enquiries/${res.body.data.id}`);
    assert.equal(detail.status, 200);

    const { rows: history } = await db.query(
      `SELECT new_owner_user_id, actor_type FROM ownership_history WHERE entity_type = 'enquiries' AND entity_id = $1`,
      [res.body.data.id]);
    assert.deepEqual(history, [{ new_owner_user_id: people.madhuri.user.id, actor_type: 'user' }]);
  });

  test('the salesperson email decides when it is given', async () => {
    const res = await as('alice')('post', '/api/quotations')
      .send({ client_name: 'Beta Metals', quotation_date: '2026-10-01', sales_person: 'Ravi Kumar', sales_person_email: 'MADHURI@example.com' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await ownerOf('quotations', res.body.data.id), people.madhuri.user.id);
  });

  test('a project an admin registers for Madhuri is hers', async () => {
    const res = await as('alice')('post', '/api/projects')
      .send({ client_name: 'Gamma Works', currency: 'INR', sales_person: 'Madhuri Pogir' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await ownerOf('projects', res.body.data.id), people.madhuri.user.id);
  });

  test('no exact, single, active sales user means no owner', async () => {
    for (const salesPerson of ['Ravi Kumar', 'Old Leaver', 'Alice Admin', 'Madhuri', null]) {
      const res = await as('alice')('post', '/api/enquiries')
        .send({ client_name: 'Delta Co', enquiry_date: '2026-10-01', sales_person: salesPerson });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(await ownerOf('enquiries', res.body.data.id), null, `${salesPerson} owns nothing`);
    }
  });

  test('an admin changing the salesperson moves the owner; a sales user cannot', async () => {
    const made = await as('alice')('post', '/api/enquiries')
      .send({ client_name: 'Echo Ltd', enquiry_date: '2026-10-01', sales_person: 'Madhuri Pogir' });
    const id = made.body.data.id;
    assert.equal(await ownerOf('enquiries', id), people.madhuri.user.id);

    const handOff = await as('madhuri')('patch', `/api/enquiries/${id}`).send({ sales_person_email: 'ravi@example.com' });
    assert.equal(handOff.status, 200, JSON.stringify(handOff.body));
    assert.equal(await ownerOf('enquiries', id), people.madhuri.user.id, 'a sales user does not hand a record away');

    const moved = await as('alice')('patch', `/api/enquiries/${id}`).send({ sales_person_email: 'ravi@example.com' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(await ownerOf('enquiries', id), people.ravi.user.id);

    const untouched = await as('alice')('patch', `/api/enquiries/${id}`).send({ remarks: 'called back' });
    assert.equal(untouched.status, 200);
    const nobody = await as('alice')('patch', `/api/enquiries/${id}`).send({ sales_person: 'Someone New', sales_person_email: null });
    assert.equal(nobody.status, 200);
    assert.equal(await ownerOf('enquiries', id), people.ravi.user.id, 'a name that matches nobody never unassigns');
  });

  test('an admin is offered every active sales user as an owner', async () => {
    // Names no record carries, so only the users table can offer them.
    await db.query(`INSERT INTO users (name, email, password_hash, role, active) VALUES
      ('Nina New', 'nina@example.com', 'x', 'sales', true),
      ('Gone Away', 'gone@example.com', 'x', 'sales', false),
      ('Hari HR', 'hari@example.com', 'x', 'hr', true)`);
    const res = await as('alice')('get', '/api/lookups');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.sales_people.includes('Nina New'));
    assert.ok(!res.body.data.sales_people.includes('Gone Away'));
    assert.ok(!res.body.data.sales_people.includes('Hari HR'));

    const own = await as('madhuri')('get', '/api/lookups');
    assert.ok(!own.body.data.sales_people.includes('Nina New'), 'a sales user is not offered colleagues');
  });

  test('migration 096 gives earlier admin-entered records to their salesperson', async () => {
    const insert = async (table, cols) => {
      const keys = Object.keys(cols);
      const { rows: [r] } = await db.query(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(cols));
      return r.id;
    };
    const byName = await insert('enquiries', { enquiry_no: 'E-OLD-1', client_name: 'Old Co', sales_person: 'MADHURI POGIR' });
    const byEmail = await insert('quotations', { quotation_no: 'Q-OLD-1', client_name: 'Old Co', sales_person_email: 'madhuri@example.com' });
    const project = await insert('projects', { project_id: 'P-OLD-1', client_name: 'Old Co', sales_person: 'Madhuri Pogir' });
    const ambiguous = await insert('enquiries', { enquiry_no: 'E-OLD-2', client_name: 'Old Co', sales_person: 'Ravi Kumar' });
    const owned = await insert('quotations', { quotation_no: 'Q-OLD-2', client_name: 'Old Co', sales_person: 'Madhuri Pogir', owner_user_id: people.ravi.user.id });
    const unassigned = await insert('projects', { project_id: 'P-OLD-2', client_name: 'Old Co', sales_person: 'Madhuri Pogir' });
    await db.query(
      `INSERT INTO ownership_history (entity_type, entity_id, previous_owner_user_id, actor_type, reason)
       VALUES ('projects', $1, $2, 'user', 'taken off on purpose')`, [unassigned, people.madhuri.user.id]);

    await db.query(MIGRATION);
    await db.query(MIGRATION); // safe to re-run

    assert.equal(await ownerOf('enquiries', byName), people.madhuri.user.id);
    assert.equal(await ownerOf('quotations', byEmail), people.madhuri.user.id);
    assert.equal(await ownerOf('projects', project), people.madhuri.user.id);
    assert.equal(await ownerOf('enquiries', ambiguous), null, 'two Ravi Kumars: left for a person');
    assert.equal(await ownerOf('quotations', owned), people.ravi.user.id, 'an owner is never overwritten');
    assert.equal(await ownerOf('projects', unassigned), null, 'a deliberate unassignment stands');

    const { rows } = await db.query(
      `SELECT entity_type, new_owner_user_id, actor_type FROM ownership_history
        WHERE reason LIKE '%(096)' ORDER BY entity_type`);
    assert.deepEqual(rows, [
      { entity_type: 'enquiries', new_owner_user_id: people.madhuri.user.id, actor_type: 'system' },
      { entity_type: 'projects', new_owner_user_id: people.madhuri.user.id, actor_type: 'system' },
      { entity_type: 'quotations', new_owner_user_id: people.madhuri.user.id, actor_type: 'system' },
    ]);
  });
});
