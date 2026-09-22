import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * What an acceptance link may and may not leave behind (#53).
 *
 * Two findings from the review of batch 4, both at the request level:
 * the token was written into the email log in clear, where any signed-in
 * user could read it back and accept the quotation as the client; and the
 * link's address was taken from the caller's own Origin header when the
 * public_app_url setting was blank, which is how a token gets emailed to
 * somebody else's domain.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('the acceptance link', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `accept_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    process.env.CORS_ORIGIN = 'https://tracker.cetizionverifica.com';

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  /** A quotation worth sending. */
  async function quotation() {
    const { body } = await agent.post('/api/quotations')
      .send({ client_name: `Acceptance test ${Date.now()}${Math.random()}`, service_quoted: 'Audit', quotation_date: '2026-09-22', quotation_value: 100000 })
      .expect(201);
    return body.data;
  }

  const tokenOf = (url) => url.split('/accept/')[1];

  test('the token reaches the client but never the email log', async () => {
    const q = await quotation();
    const { body } = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/acceptance-link`)
      .send({ email: true, to: 'client@example.com', message: 'Please review.' })
      .expect(201);

    const token = tokenOf(body.data.url);
    assert.ok(token && token.length >= 40, 'the caller is given the real link, once');

    const { rows } = await db.query(`SELECT body_text, body_html FROM email_log WHERE template = 'quotation_acceptance' ORDER BY id DESC LIMIT 1`);
    assert.equal(rows.length, 1, 'the email is still composed and logged');
    assert.ok(!rows[0].body_text.includes(token), 'the stored text body must not carry the token');
    assert.ok(!rows[0].body_html.includes(token), 'the stored HTML body must not carry the token');
    assert.match(rows[0].body_text, /\[redacted\]/, 'and it is plainly marked, not silently dropped');
  });

  test('the address in the link is the tracker’s, not the caller’s Origin', async () => {
    const q = await quotation();
    const { body } = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/acceptance-link`)
      .set('Origin', 'https://evil.example')
      .set('Host', 'evil.example')
      .send({ email: false })
      .expect(201);

    assert.ok(!body.data.url.includes('evil.example'), 'a header the caller chose can never appear in a client link');
    assert.ok(body.data.url.startsWith('https://tracker.cetizionverifica.com/accept/'), body.data.url);
  });

  test('the public_app_url setting wins when it is set', async () => {
    await db.query(`INSERT INTO settings (key, value) VALUES ('public_app_url', 'https://portal.cetizionverifica.com/')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const q = await quotation();
    const { body } = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/acceptance-link`)
      .set('Origin', 'https://evil.example')
      .send({ email: false })
      .expect(201);
    assert.ok(body.data.url.startsWith('https://portal.cetizionverifica.com/accept/'), body.data.url);
    await db.query(`UPDATE settings SET value = '' WHERE key = 'public_app_url'`);
  });

  test('a link still opens and shows the quotation, and the token still works', async () => {
    const q = await quotation();
    const { body } = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/acceptance-link`)
      .send({ email: false }).expect(201);
    const token = tokenOf(body.data.url);
    const seen = await request(app).get(`/api/public/accept/${token}`).expect(200);
    assert.equal(seen.body.data.quotation.quotation_no, q.quotation_no);
  });
});
