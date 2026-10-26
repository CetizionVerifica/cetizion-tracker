import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * A quotation reaches the client, or is recorded as accepted by them, only
 * once it is ready for them: a discount above the limit approved, and every
 * line priced. Sending it and creating an acceptance link always checked
 * that; recording a client's acceptance by hand did not, so a discount
 * still waiting for approval, or one an admin had rejected, could be
 * recorded as accepted. All three now share one rule.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('a quotation is ready for the client before it goes to them', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let agent; let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `ready_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();
    const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`;

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    process.env.CLOUDINARY_CLOUD_NAME = '';
    await db.query(`INSERT INTO settings (key, value) VALUES ('public_app_url', 'https://tracker.example.com')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const { default: app } = await import('../src/app.js');
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await owner.end();
  });

  /** A quotation with one line at `discount` percent off. */
  async function quotation(discount, rate = 100000) {
    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: `Ready client ${Date.now()}-${Math.random()}`, service_quoted: 'Audit', quotation_date: '2026-10-01' }).expect(201);
    await agent.post('/api/quotation-lines').send({ quotation_id: q.data.id, description: 'Audit', qty: 1, rate, gst_rate: 18, discount_percent: discount }).expect(201);
    return q.data.quotation_no;
  }
  const at = (no, path) => `/api/quotations/${encodeURIComponent(no)}${path}`;
  const accept = (no) => agent.post(at(no, '/accept')).send({ accepted_by_name: 'Priya (client)' });
  const send = (no) => agent.post(at(no, '/send')).send({});
  const link = (no) => agent.post(at(no, '/acceptance-link')).send({});
  const state = async (no) => (await db.query('SELECT approval_status, accepted_at, status FROM quotations WHERE quotation_no = $1', [no])).rows[0];

  test('a discount waiting for approval cannot be recorded as accepted, sent, or linked', async () => {
    const no = await quotation(15);
    assert.equal((await state(no)).approval_status, 'pending', '15% is above the 10% limit');

    for (const [what, call] of [['accept', accept], ['send', send], ['link', link]]) {
      const res = await call(no);
      assert.equal(res.status, 422, `${what}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.message, /awaiting approval/, what);
    }
    const s = await state(no);
    assert.equal(s.accepted_at, null, 'nothing was recorded');
    assert.notEqual(s.status, 'Under Negotiation');
  });

  test('a rejected discount cannot be recorded as accepted either', async () => {
    const no = await quotation(15);
    await agent.post(at(no, '/approval/decide')).send({ decision: 'rejected', note: 'Too deep' }).expect(200);
    const res = await accept(no);
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /rejected/);
    assert.equal((await state(no)).accepted_at, null);
  });

  test('once the discount is approved, the acceptance is recorded', async () => {
    const no = await quotation(15);
    await agent.post(at(no, '/approval/decide')).send({ decision: 'approved' }).expect(200);
    const res = await accept(no);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.accepted_by_name, 'Priya (client)');
    assert.ok((await state(no)).accepted_at);
  });

  test('a discount within the limit needs no approval', async () => {
    const no = await quotation(5);
    assert.equal((await accept(no)).status, 200);
  });

  test('a closed, an empty, or an already-accepted quotation is not recorded as accepted by hand', async () => {
    const lost = await quotation(0);
    await db.query(`UPDATE quotations SET status = 'Lost' WHERE quotation_no = $1`, [lost]);
    const a = await accept(lost);
    assert.equal(a.status, 422);
    assert.match(a.body.error.message, /already lost/);

    const { body: empty } = await agent.post('/api/quotations')
      .send({ client_name: `Empty client ${Date.now()}`, service_quoted: 'Audit', quotation_date: '2026-10-01' }).expect(201);
    const b = await accept(empty.data.quotation_no);
    assert.equal(b.status, 422);
    assert.match(b.body.error.message, /lines or a value/);

    const twice = await quotation(0);
    assert.equal((await accept(twice)).status, 200);
    const c = await accept(twice);
    assert.equal(c.status, 409, 'not overwritten by a second recording');
  });

  test('a client\'s link made before the discount was raised cannot be accepted after it', async () => {
    const no = await quotation(5);
    const made = await link(no);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const token = new URL(made.body.data.url).pathname.split('/').pop();
    // The discount goes past the limit without a new revision.
    await db.query(`UPDATE quotation_lines SET discount_percent = 15 WHERE quotation_id = (SELECT id FROM quotations WHERE quotation_no = $1)`, [no]);
    assert.equal((await state(no)).approval_status, 'pending');

    const res = await agent.post(`/api/public/accept/${token}/accept`).send({ name: 'Priya (client)', agree: true });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error.message, /being updated/, 'the client is told plainly, without internal detail');
    assert.doesNotMatch(res.body.error.message, /discount|approval/i);
    assert.equal((await state(no)).accepted_at, null);
  });

  test('a line that still needs a price holds the acceptance too', async () => {
    const no = await quotation(0);
    await db.query(`UPDATE quotation_lines SET price_needed = true, rate = 0 WHERE quotation_id = (SELECT id FROM quotations WHERE quotation_no = $1)`, [no]);
    const res = await accept(no);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(res.body.error.message, /needs a price/);
  });
});
