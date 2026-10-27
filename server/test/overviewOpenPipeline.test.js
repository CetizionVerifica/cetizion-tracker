import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * GET /api/dashboard/overview — open_value_inr
 *
 * The Overview's "Open pipeline" used to be everything quoted minus what was
 * won, so a Lost quotation still counted as open. open_value_inr sums only
 * the quotations still being decided (Draft, Submitted, Under Negotiation,
 * On Hold), in rupees, as value_inr does.
 *
 * Requires a real Postgres database. Set TEST_DATABASE_URL to run.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

async function applySchema(dbUrl) {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dir = dirname(fileURLToPath(import.meta.url));
  const dbDir = join(__dir, '..', 'db');
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}

describe(
  'GET /api/dashboard/overview — open pipeline',
  { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' },
  () => {
    let dbUrl;
    let app;
    let pool;
    let cookie;

    before(async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      const name = `overview_open_test_${process.pid}_${Date.now()}`;
      await admin.query(`CREATE DATABASE ${name}`);
      await admin.end();

      const u = new URL(ADMIN_URL);
      u.pathname = `/${name}`;
      dbUrl = u.toString();
      await applySchema(dbUrl);

      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = dbUrl;
      process.env.AUTH_USERNAME = 'tester';
      process.env.AUTH_PASSWORD = 'test-password-long-enough';
      process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

      app = (await import('../src/app.js')).default;
      pool = (await import('../src/db.js')).pool;
      const res = await request(app).post('/api/auth/login').send({
        username: 'tester',
        password: 'test-password-long-enough',
      });
      assert.equal(res.status, 200, 'sign-in failed');
      cookie = res.headers['set-cookie'];
    });

    after(async () => {
      await pool.end();
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
      await admin.end();
    });

    test('open_value_inr counts only open rupee quotations', async () => {
      const rows = [
        ['QT-OP-1', 'Draft', 100000, 'INR'],
        ['QT-OP-2', 'Submitted', 200000, 'INR'],
        ['QT-OP-3', 'Under Negotiation', 150000, 'INR'],
        ['QT-OP-4', 'On Hold', 50000, 'INR'],
        ['QT-OP-5', 'Lost', 300000, 'INR'],
        ['QT-OP-6', 'Won - PO Received', 200000, 'INR'],
        // Open, but not in rupees: left out, as value_inr leaves it out.
        ['QT-OP-7', 'Submitted', 999, 'USD'],
      ];
      for (const [no, status, value, currency] of rows) {
        await pool.query(
          `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, quotation_value, currency)
           VALUES ($1, 'Open Pipeline Client', '2026-05-01', $2, $3, $4)`,
          [no, status, value, currency],
        );
      }

      const res = await request(app).get('/api/dashboard/overview').set('Cookie', cookie);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { sales } = res.body.data;
      assert.equal(Number(sales.value_inr), 1000000);
      assert.equal(Number(sales.won_value_inr), 200000);
      // 10L quoted, 3L lost, 2L won: 5L still open, not 8L.
      assert.equal(Number(sales.open_value_inr), 500000);
      // The count covers the same statuses, every currency: four rupee + one USD.
      assert.equal(sales.open, 5);
      assert.equal(sales.lost, 1);
      assert.equal(sales.won, 1);
    });
  },
);
