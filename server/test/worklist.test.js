import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Regression test for Issue #6 — GET /api/dashboard/worklist
 *
 * The Action List dialog was missing document_id, document_name, invoice_date,
 * and terms_days because the SELECT column list in dashboard.js was incomplete.
 * This test inserts a real payment stage with an invoice document attached and
 * confirms those four fields are present and correct in the worklist response,
 * preventing a silent regression.
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

async function exec(dbUrl, sql, params = []) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function signIn(app) {
  const res = await request(app).post('/api/auth/login').send({
    username: 'tester',
    password: 'test-password-long-enough',
  });
  assert.equal(res.status, 200, 'sign-in failed');
  return res.headers['set-cookie'];
}

describe(
  'GET /api/dashboard/worklist — Issue #6 regression',
  { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' },
  () => {
    let dbUrl;
    let app;
    let pool;
    let cookie;

    before(async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      const name = `worklist_test_${process.pid}_${Date.now()}`;
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

      const imported = await import('../src/app.js');
      app = imported.default;
      const dbModule = await import('../src/db.js');
      pool = dbModule.pool;
      cookie = await signIn(app);
    });

    after(async () => {
      await pool.end();
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      const name = new URL(dbUrl).pathname.slice(1);
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });

    // -----------------------------------------------------------------------
    // W1 — worklist stage with an invoice document returns Issue #6 fields
    // -----------------------------------------------------------------------
    test(
      'W1: worklist stage with attached invoice document returns document_id, document_name, invoice_date, terms_days',
      async () => {
        // 1. Project
        await exec(dbUrl, `
          INSERT INTO projects (project_id, client_name, primary_service)
          VALUES ('PRJ-2026-001', 'Acme Ltd', 'ESG Reporting')
        `);

        // 2. Purchase order — po_date set so 'On PO Registration' trigger fires;
        //    45 payment-terms days (non-default) makes terms_days easy to assert.
        await exec(dbUrl, `
          INSERT INTO purchase_orders (po_number, project_id, po_value, currency, payment_terms_days, po_date)
          VALUES ('PO-2026-001', 'PRJ-2026-001', 100000, 'INR', 45, '2026-01-10')
        `);

        // 3. Document row — no real Cloudinary upload needed; the view just joins on id.
        const [docRow] = await exec(dbUrl, `
          INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
          VALUES ('test/invoice_001', 'invoice_001.pdf', 'application/pdf', 12345)
          RETURNING id
        `);
        const documentId = docRow.id;

        // 4. Payment stage: invoice raised (invoice_no + invoice_date set), document attached,
        //    only partly paid → stage_status = 'Partially Paid', which IS in the worklist.
        await exec(dbUrl, `
          INSERT INTO payment_stages (
            po_number, stage_no, stage_name, trigger_event,
            stage_percent, invoice_no, invoice_date, document_id, amount_received
          )
          VALUES (
            'PO-2026-001', 1, 'Advance', 'On PO Registration',
            0.5, 'INV/2026/001', '2026-06-15', $1, 10000
          )
        `, [documentId]);

        // --- Fetch worklist ---
        const res = await request(app)
          .get('/api/dashboard/worklist')
          .set('Cookie', cookie);

        assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

        const stages = res.body.data.payment_stages;
        assert.ok(Array.isArray(stages), 'worklist.data.payment_stages must be an array');

        const stage = stages.find((s) => s.po_number === 'PO-2026-001' && s.stage_no === 1);
        assert.ok(stage, 'the seeded stage must appear in the worklist');

        // Issue #6: all four previously-missing fields must be present and correct
        assert.equal(
          stage.document_id,
          documentId,
          `document_id must be ${documentId}, got: ${stage.document_id}`
        );
        assert.equal(
          stage.document_name,
          'invoice_001.pdf',
          `document_name must be 'invoice_001.pdf', got: ${stage.document_name}`
        );
        assert.equal(
          stage.invoice_date,
          '2026-06-15',
          `invoice_date must be '2026-06-15', got: ${stage.invoice_date}`
        );
        assert.equal(
          stage.terms_days,
          45,
          `terms_days must be 45 (from PO payment_terms_days), got: ${stage.terms_days}`
        );
      }
    );
  }
);
