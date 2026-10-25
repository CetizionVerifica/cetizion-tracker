import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * One owner written more than once, found and folded into one
 * (lib/owners.js), the way companies are.
 *
 * Needs TEST_DATABASE_URL (CI sets it); skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `owners_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

describe('merging owner spellings', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    ]) {
      const user = await createUser({ name, email: `${key}@example.com`, password: PASSWORD, role }, db);
      people[key] = { user };
    }
    for (const key of ['alice', 'ravi']) {
      const res = await request(app).post('/api/auth/login').send({ email: `${key}@example.com`, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      people[key].cookie = res.headers['set-cookie'];
    }

    const insert = async (table, cols) => {
      const keys = Object.keys(cols);
      await db.query(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(cols));
    };
    await insert('enquiries', { enquiry_no: 'E-1', client_name: 'Acme Ltd', sales_person: 'Madhuri' });
    await insert('enquiries', { enquiry_no: 'E-2', client_name: 'Acme Ltd', sales_person: ' madhuri pogir ' });
    await insert('quotations', { quotation_no: 'Q-1', client_name: 'Acme Ltd', sales_person: 'Madhuri' });
    // Already Ravi's: a spelling clean-up must not take it off him.
    await insert('quotations', { quotation_no: 'Q-2', client_name: 'Acme Ltd', sales_person: 'Madhuri', owner_user_id: people.ravi.user.id });
    await insert('projects', { project_id: 'P-1', client_name: 'Acme Ltd', sales_person: 'Madhuri' });
    await insert('enquiries', { enquiry_no: 'E-3', client_name: 'Acme Ltd', sales_person: 'Suresh Rao' });
    await insert('enquiries', { enquiry_no: 'E-4', client_name: 'Acme Ltd', sales_person: 'Suresh Iyer' });
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
  const row = async (table, key, value) => (await db.query(
    `SELECT sales_person, owner_user_id FROM ${table} WHERE ${key} = $1`, [value])).rows[0];

  test('spellings of one person come back as one group, keeping the account name', async () => {
    const res = await as('alice')('get', '/api/owners/duplicates');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 1, JSON.stringify(res.body.data));
    const [group] = res.body.data;
    assert.equal(group.suggested_keep, 'Madhuri Pogir');
    assert.deepEqual(group.members.map((m) => m.name).sort(), ['Madhuri', 'Madhuri Pogir', 'madhuri pogir']);
    const account = group.members.find((m) => m.name === 'Madhuri Pogir');
    assert.equal(account.sales_user, true);
    assert.equal(account.records, 0);
    assert.equal(group.members.find((m) => m.name === 'Madhuri').records, 4);
    assert.equal(group.certain, false);
    // Two people who share only a first name stay apart.
    assert.ok(!group.members.some((m) => m.name.startsWith('Suresh')));
  });

  test('the Owner pick-list is the sales users on the platform', async () => {
    const admin = await as('alice')('get', '/api/lookups');
    assert.deepEqual(admin.body.data.owners.map((o) => o.name), ['Madhuri Pogir', 'Ravi Kumar']);
    const own = await as('ravi')('get', '/api/lookups');
    assert.deepEqual(own.body.data.owners.map((o) => o.name), ['Ravi Kumar'], 'a sales user is offered only themselves');
  });

  test('a sales user may neither list nor merge', async () => {
    assert.equal((await as('ravi')('get', '/api/owners/duplicates')).status, 403);
    const res = await as('ravi')('post', '/api/owners/merge').send({ from: ['Madhuri'], into: 'Madhuri Pogir' });
    assert.equal(res.status, 403);
    assert.equal((await row('enquiries', 'enquiry_no', 'E-1')).sales_person, 'Madhuri');
  });

  test('merging rewrites every record and fills in the missing owner', async () => {
    const res = await as('alice')('post', '/api/owners/merge').send({ from: ['Madhuri', 'madhuri pogir'], into: 'Madhuri Pogir' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.moved, { enquiries: 2, quotations: 2, projects: 1 });
    assert.equal(res.body.data.owner_assigned, 4);

    const madhuri = people.madhuri.user.id;
    assert.deepEqual(await row('enquiries', 'enquiry_no', 'E-1'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });
    assert.deepEqual(await row('enquiries', 'enquiry_no', 'E-2'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });
    assert.deepEqual(await row('quotations', 'quotation_no', 'Q-1'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });
    assert.deepEqual(await row('quotations', 'quotation_no', 'Q-2'), { sales_person: 'Madhuri Pogir', owner_user_id: people.ravi.user.id });
    assert.deepEqual(await row('projects', 'project_id', 'P-1'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });

    const { rows: history } = await db.query(`SELECT count(*)::int AS n FROM ownership_history WHERE new_owner_user_id = $1`, [madhuri]);
    assert.equal(history[0].n, 4);
    const { rows: [log] } = await db.query(`SELECT entity_type, entity_id, metadata FROM activity_log WHERE action = 'owner.merged'`);
    assert.equal(log.entity_type, 'owner');
    assert.equal(log.entity_id, 'Madhuri Pogir');
    assert.deepEqual(log.metadata.from, ['Madhuri', 'madhuri pogir']);

    const after = await as('alice')('get', '/api/owners/duplicates');
    assert.deepEqual(after.body.data, []);
  });

  test('a merge needs somewhere to go and something to move', async () => {
    for (const body of [{}, { from: [], into: 'Ravi Kumar' }, { from: ['X'], into: ' ' }, { from: ['Ravi Kumar'], into: 'Ravi Kumar' },
      // Only onto a sales user on the platform.
      { from: ['Suresh Rao'], into: 'Suresh Iyer' }, { from: ['Suresh Rao'], into: 'Alice Admin' }]) {
      const res = await as('alice')('post', '/api/owners/merge').send(body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    assert.equal((await row('enquiries', 'enquiry_no', 'E-3')).sales_person, 'Suresh Rao');
  });
});
