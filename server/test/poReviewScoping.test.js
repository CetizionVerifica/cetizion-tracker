import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The PO review queue is scoped (docs/email-po-plan.md §3.7, §8 Authz): an
 * admin sees every item, a salesperson only those whose suggested quotation
 * is theirs, and cannot act on the others.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('the PO review queue is scoped', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool;
  const cookie = {};
  const item = {};

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `poreview_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const { createUser } = await import('../src/lib/users.js');

    const users = {};
    for (const [key, role] of [['alice', 'admin'], ['sam', 'sales'], ['bea', 'sales']]) {
      users[key] = await createUser({ name: key, email: `${key}@example.com`, role, password: PASSWORD }, db);
      const res = await request(app).post('/api/auth/login').send({ email: `${key}@example.com`, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      cookie[key] = res.headers['set-cookie'];
    }
    const { rows: [box] } = await db.query(`INSERT INTO connected_accounts (username, provider, email) VALUES ('alice','test','sales@cetizionverifica.com') RETURNING id`);
    for (const [key, owner] of [['sam', users.sam.id], ['bea', users.bea.id], ['nobody', null]]) {
      const { rows: [q] } = await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, owner_user_id) VALUES ($1, $2, '2026-09-01', $3) RETURNING quotation_no`,
        [`CTZ/QT/2026/9${key.length}${key.charCodeAt(0)}`, `Client of ${key}`, owner]);
      const { rows: [d] } = await db.query(
        `INSERT INTO email_po_decisions (account_id, provider_id, outcome, review_reason, method, suggested_quotations)
         VALUES ($1, $2, 'review', 'several_matches', 'ai', $3) RETURNING id`, [box.id, `m-${key}`, [q.quotation_no]]);
      item[key] = d.id;
    }
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const list = async (who) => (await request(app).get('/api/purchase-orders/review').set('Cookie', cookie[who]).expect(200)).body.data.map((r) => r.id).sort();

  test('an admin sees every item; a salesperson only theirs', async () => {
    assert.deepEqual(await list('alice'), [item.sam, item.bea, item.nobody].sort());
    assert.deepEqual(await list('sam'), [item.sam]);
    assert.deepEqual(await list('bea'), [item.bea]);
  });

  test('a salesperson cannot read again or dismiss somebody else\'s item', async () => {
    await request(app).post(`/api/purchase-orders/review/${item.bea}/dismiss`).set('Cookie', cookie.sam).expect(404);
    await request(app).post(`/api/purchase-orders/review/${item.bea}/register`).set('Cookie', cookie.sam).expect(404);
    await request(app).post(`/api/purchase-orders/review/${item.nobody}/dismiss`).set('Cookie', cookie.sam).expect(404);
    await request(app).post(`/api/purchase-orders/review/${item.sam}/dismiss`).set('Cookie', cookie.sam).expect(200);
    assert.deepEqual(await list('sam'), []);
  });
});
