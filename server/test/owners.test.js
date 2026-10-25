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
      // A colleague whose name contains Ravi's: two people, never a merge.
      ['ravir', 'Ravi Kumar Reddy', 'sales'],
      // Two accounts with one name, and one switched off.
      ['twin1', 'Twin Name', 'sales'],
      ['twin2', 'Twin Name', 'sales'],
      ['old', 'Old Seller', 'sales'],
    ]) {
      const user = await createUser({ name, email: `${key}@example.com`, password: PASSWORD, role }, db);
      people[key] = { user };
    }
    await db.query('UPDATE users SET active = false WHERE id = $1', [people.old.user.id]);
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
    // Its Owner email names Ravi; the merge says it is Madhuri's.
    await insert('quotations', { quotation_no: 'Q-1', client_name: 'Acme Ltd', sales_person: 'Madhuri', sales_person_email: 'ravi@example.com' });
    // Already Ravi's: a spelling clean-up must not take it off him.
    await insert('quotations', { quotation_no: 'Q-2', client_name: 'Acme Ltd', sales_person: 'Madhuri', owner_user_id: people.ravi.user.id });
    await insert('projects', { project_id: 'P-1', client_name: 'Acme Ltd', sales_person: 'Madhuri' });
    await insert('enquiries', { enquiry_no: 'E-3', client_name: 'Acme Ltd', sales_person: 'Suresh Rao' });
    await insert('enquiries', { enquiry_no: 'E-4', client_name: 'Acme Ltd', sales_person: 'Suresh Iyer' });
    // Nobody's account, written two ways.
    await insert('enquiries', { enquiry_no: 'E-5', client_name: 'Acme Ltd', sales_person: 'zed lowe' });
    await insert('enquiries', { enquiry_no: 'E-6', client_name: 'Acme Ltd', sales_person: 'Zed  Lowe' });
    // Two colleagues, each under their own account name.
    await insert('enquiries', { enquiry_no: 'E-7', client_name: 'Acme Ltd', sales_person: 'Ravi Kumar' });
    await insert('enquiries', { enquiry_no: 'E-8', client_name: 'Acme Ltd', sales_person: 'Ravi Kumar Reddy' });
    // A renewal copies its engagement's owner; a sales token reads by its person.
    await insert('engagements', { client_name: 'Acme Ltd', service_name: 'Audit', next_due_on: '2027-01-01', owner: 'Madhuri' });
    await insert('api_tokens', { name: 'Madhuri assistant', token_hash: 'h1', token_prefix: 'p1', role: 'sales', person: 'madhuri ' });
    await insert('api_tokens', { name: 'Old token', token_hash: 'h2', token_prefix: 'p2', role: 'sales', person: 'Madhuri', revoked_at: '2026-01-01' });
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
    assert.equal(res.body.data.length, 2, JSON.stringify(res.body.data));
    const [zed, group] = res.body.data;

    // Same name written differently comes first; with no account in it there is nothing to suggest keeping.
    assert.deepEqual(zed.members.map((m) => m.name).sort(), ['Zed  Lowe', 'zed lowe']);
    assert.equal(zed.certain, true);
    assert.equal(zed.confidence, 'same name, written differently');
    assert.equal(zed.suggested_keep, null);

    assert.equal(group.suggested_keep, 'Madhuri Pogir');
    assert.deepEqual(group.members.map((m) => m.name).sort(), ['Madhuri', 'Madhuri Pogir', 'madhuri pogir']);
    const account = group.members.find((m) => m.name === 'Madhuri Pogir');
    assert.equal(account.sales_user, true);
    assert.equal(account.records, 0);
    assert.equal(group.members.find((m) => m.name === 'Madhuri').records, 4);
    assert.equal(group.certain, false);
    // Two people who share only a first name stay apart, and so do two
    // colleagues each under their own account name.
    assert.ok(!res.body.data.some((g) => g.members.some((m) => m.name.startsWith('Suresh') || m.name.startsWith('Ravi'))));
  });

  test('an outside name becomes an owner only as one sales user\'s account name', async () => {
    const { ownerNameFor } = await import('../src/lib/owners.js');
    assert.equal(await ownerNameFor(pool, 'RAVI@example.com'), 'Ravi Kumar');
    assert.equal(await ownerNameFor(pool, ' madhuri   pogir '), 'Madhuri Pogir');
    for (const nobody of ['Madhuri', 'Twin Name', 'Old Seller', 'alice@example.com', '', null]) {
      assert.equal(await ownerNameFor(pool, nobody), null, String(nobody));
    }
  });

  test('the Owner pick-list is the sales users on the platform', async () => {
    const admin = await as('alice')('get', '/api/lookups');
    // Active sales users only: not the admin, not the one switched off.
    assert.deepEqual(admin.body.data.owners.map((o) => o.name), ['Madhuri Pogir', 'Ravi Kumar', 'Ravi Kumar Reddy', 'Twin Name', 'Twin Name']);
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
    assert.deepEqual(res.body.data.moved, { enquiries: 2, quotations: 2, projects: 1, engagements: 1 });
    assert.equal(res.body.data.owner_assigned, 4);
    assert.equal(res.body.data.tokens_moved, 1);

    const madhuri = people.madhuri.user.id;
    assert.deepEqual(await row('enquiries', 'enquiry_no', 'E-1'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });
    assert.deepEqual(await row('enquiries', 'enquiry_no', 'E-2'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });
    assert.deepEqual(await row('quotations', 'quotation_no', 'Q-1'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri }, 'not whoever its Owner email names');
    assert.deepEqual(await row('quotations', 'quotation_no', 'Q-2'), { sales_person: 'Madhuri Pogir', owner_user_id: people.ravi.user.id });
    assert.deepEqual(await row('projects', 'project_id', 'P-1'), { sales_person: 'Madhuri Pogir', owner_user_id: madhuri });

    const { rows: history } = await db.query(`SELECT count(*)::int AS n FROM ownership_history WHERE new_owner_user_id = $1`, [madhuri]);
    assert.equal(history[0].n, 4);
    const { rows: [log] } = await db.query(`SELECT entity_type, entity_id, metadata FROM activity_log WHERE action = 'owner.merged'`);
    assert.equal(log.entity_type, 'owner');
    assert.equal(log.entity_id, 'Madhuri Pogir');
    assert.deepEqual(log.metadata.from, ['Madhuri', 'madhuri pogir']);

    const { rows: engagements } = await db.query('SELECT owner FROM engagements');
    assert.deepEqual(engagements, [{ owner: 'Madhuri Pogir' }]);
    const { rows: tokens } = await db.query('SELECT name, person FROM api_tokens ORDER BY name');
    assert.deepEqual(tokens, [{ name: 'Madhuri assistant', person: 'Madhuri Pogir' }, { name: 'Old token', person: 'Madhuri' }]);

    const after = await as('alice')('get', '/api/owners/duplicates');
    assert.deepEqual(after.body.data.map((g) => g.suggested_keep), [null], 'only the Zed group is left');
  });

  test('a merge needs somewhere to go and something to move', async () => {
    for (const body of [{}, { from: [], into: 'Ravi Kumar' }, { from: ['X'], into: ' ' }, { from: ['Ravi Kumar'], into: 'Ravi Kumar' },
      // Only onto a sales user on the platform.
      { from: ['Suresh Rao'], into: 'Suresh Iyer' }, { from: ['Suresh Rao'], into: 'Alice Admin' },
      // Switched off, or two accounts with the name.
      { from: ['Suresh Rao'], into: 'Old Seller' }, { from: ['Suresh Rao'], into: 'Twin Name' },
      // Another sales user's own name, however it is written.
      { from: ['Suresh Rao', 'ravi  kumar reddy'], into: 'Ravi Kumar' }]) {
      const res = await as('alice')('post', '/api/owners/merge').send(body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
    assert.equal((await row('enquiries', 'enquiry_no', 'E-3')).sales_person, 'Suresh Rao');
    assert.equal((await row('enquiries', 'enquiry_no', 'E-8')).sales_person, 'Ravi Kumar Reddy');
  });
});
