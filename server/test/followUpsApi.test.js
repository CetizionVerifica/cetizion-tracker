import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * /api/follow-ups: who sees which cycles (docs/follow-up-escalation-test-plan.md §9, A-01..A-09).
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('follow-ups API', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  const ids = {};
  const cookies = {};

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `followups_api_${process.pid}_${Date.now()}`;
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

    for (const [key, name, email, role] of [['asha', 'Asha', 'asha@qa.example', 'sales'], ['ben', 'Ben', 'ben@qa.example', 'sales'], ['meera', 'Meera', 'meera@qa.example', 'admin']]) {
      ids[key] = (await createUser({ name, email, role, password: PASSWORD }, db)).id;
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      cookies[key] = res.headers['set-cookie'];
    }

    await db.query(`INSERT INTO quotations (quotation_no, client_name, status, sent_at, owner_user_id) VALUES
      ('Q-A', 'Hetero', 'Submitted', '2026-09-01', $1), ('Q-B', 'Midal', 'Submitted', '2026-09-01', $2), ('Q-N', 'Nobody', 'Submitted', '2026-09-01', NULL)`, [ids.asha, ids.ben]);
    await db.query(`INSERT INTO enquiries (enquiry_no, client_name, status, owner_user_id) VALUES ('ENQ-A', 'Hetero', 'Contacted', $1)`, [ids.asha]);
    // Asha: one waiting quotation, one escalated enquiry, one resolved yesterday.
    // Ben: one waiting quotation. Nobody: one escalated quotation.
    await db.query(
      `INSERT INTO follow_up_cycles (entity, entity_id, due_on, reminded_user_id, owner_name, reminded_at, respond_by, escalated_at, last_escalated_on, escalation_count, resolved_at, resolved_reason) VALUES
        ('quotation', 'Q-A', '2026-09-28', $1, 'Asha', now() - interval '1 hour', '2026-10-07', NULL, NULL, 0, NULL, NULL),
        ('enquiry', 'ENQ-A', '2026-09-28', $1, 'Asha', now() - interval '5 days', '2026-09-30', now() - interval '1 day', CURRENT_DATE, 1, NULL, NULL),
        ('enquiry', 'ENQ-A', '2026-09-20', $1, 'Asha', now() - interval '20 days', '2026-09-22', NULL, NULL, 0, now() - interval '1 day', 'activity'),
        ('quotation', 'Q-B', '2026-09-28', $2, 'Ben', now() - interval '1 hour', '2026-10-07', NULL, NULL, 0, NULL, NULL),
        ('quotation', 'Q-N', '2026-09-28', NULL, NULL, NULL, NULL, now() - interval '1 day', CURRENT_DATE, 1, NULL, NULL)`,
      [ids.asha, ids.ben]
    );
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const get = (who, path) => request(app).get(path).set('Cookie', cookies[who]);
  const numbers = (res) => res.body.data.map((r) => r.number).sort();

  test('A-02: a sales user sees only cycles on records they own', async () => {
    const res = await get('asha', '/api/follow-ups?status=open');
    assert.equal(res.status, 200);
    assert.deepEqual(numbers(res), ['ENQ-A', 'Q-A']);
  });

  test('A-03: an admin sees every cycle, unowned ones too', async () => {
    const res = await get('meera', '/api/follow-ups?status=open');
    assert.deepEqual(numbers(res), ['ENQ-A', 'Q-A', 'Q-B', 'Q-N']);
    const q = res.body.data.find((r) => r.number === 'Q-A');
    assert.equal(q.owner, 'Asha');
    assert.equal(q.client, 'Hetero');
    assert.equal(q.link, '/quotations/Q-A');
    assert.equal(typeof q.idle_days, 'number');
  });

  test('A-04: the summary is for admins', async () => {
    assert.equal((await get('asha', '/api/follow-ups/summary')).status, 403);
    const res = await get('meera', '/api/follow-ups/summary');
    assert.equal(res.status, 200);
    const asha = res.body.data.find((r) => r.owner === 'Asha');
    assert.deepEqual([asha.reminded, asha.escalated, asha.resolved_by_activity, asha.open], [3, 1, 1, 2]);
    assert.ok(res.body.data.some((r) => r.owner === 'No owner'));
  });

  test('A-05: the banner endpoint refuses a record the caller cannot reach', async () => {
    assert.equal((await get('asha', '/api/follow-ups/record?entity=quotation&id=Q-B')).status, 404);
    const mine = await get('asha', '/api/follow-ups/record?entity=quotation&id=Q-A');
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.status, 'waiting');
    assert.equal(mine.body.data.respond_by, '2026-10-07');
  });

  test('A-06: not signed in is 401 everywhere', async () => {
    for (const path of ['/api/follow-ups', '/api/follow-ups/record?entity=quotation&id=Q-A', '/api/follow-ups/summary']) {
      assert.equal((await request(app).get(path)).status, 401, path);
    }
  });

  test('A-07: status, entity and owner filters', async () => {
    assert.deepEqual(numbers(await get('meera', '/api/follow-ups?status=waiting')), ['Q-A', 'Q-B']);
    assert.deepEqual(numbers(await get('meera', '/api/follow-ups?status=escalated')), ['ENQ-A', 'Q-N']);
    const resolved = await get('meera', '/api/follow-ups?status=resolved');
    assert.deepEqual(resolved.body.data.map((r) => [r.number, r.status, r.resolved_reason]), [['ENQ-A', 'resolved', 'activity']]);
    assert.deepEqual(numbers(await get('meera', '/api/follow-ups?status=open&entity=quotation')), ['Q-A', 'Q-B', 'Q-N']);
    assert.deepEqual(numbers(await get('meera', `/api/follow-ups?status=open&owner=${ids.ben}`)), ['Q-B']);
    assert.deepEqual(numbers(await get('meera', '/api/follow-ups?status=open&owner=none')), ['Q-N']);
    // A sales user's owner filter cannot widen their view.
    assert.deepEqual(numbers(await get('asha', `/api/follow-ups?status=open&owner=${ids.ben}`)), ['ENQ-A', 'Q-A']);
  });

  test('the record endpoint returns the next planned task', async () => {
    await db.query(`INSERT INTO tasks (entity, entity_id, title, due_at) VALUES ('quotation', 'Q-B', 'Call back', '2026-10-15')`);
    const res = await get('ben', '/api/follow-ups/record?entity=quotation&id=Q-B');
    assert.deepEqual(res.body.next_task, { due_at: '2026-10-15', title: 'Call back' });
    const none = await get('asha', '/api/follow-ups/record?entity=enquiry&id=ENQ-A');
    assert.equal(none.body.next_task, null);
  });

  test('A-08: a touch since the reminder hides the banner before the job runs', async () => {
    await db.query(`INSERT INTO communications (channel, outcome, entity, entity_id, started_at) VALUES ('call', 'connected', 'quotation', 'Q-A', now())`);
    const res = await get('asha', '/api/follow-ups/record?entity=quotation&id=Q-A');
    assert.equal(res.body.data, null);
    assert.equal(res.body.acted, true);
  });

  test('A-09: an unknown entity, a missing id or a bad status is 422', async () => {
    assert.equal((await get('asha', '/api/follow-ups/record?entity=company&id=1')).status, 422);
    assert.equal((await get('asha', '/api/follow-ups/record?entity=quotation')).status, 422);
    assert.equal((await get('asha', '/api/follow-ups?status=whatever')).status, 422);
    assert.equal((await get('asha', '/api/follow-ups?entity=company')).status, 422);
    // An admin's owner filter that is not a user id is the caller's mistake, not a 500.
    assert.equal((await get('meera', '/api/follow-ups?owner=abc')).status, 422);
  });
});
