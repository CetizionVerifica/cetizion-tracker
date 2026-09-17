import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Integration tests for Issue #9 — reference-number year derivation and immutability.
 *
 * Covers:
 *   T1  — historical quotation, blank number → year from quotation_date
 *   T2  — current-year quotation, blank number → year from quotation_date
 *   T3  — explicit historical reference number preserved exactly
 *   T4  — duplicate explicit number → 409, no silent replacement
 *   T5  — historical enquiry, blank number → year from enquiry_date
 *   T6  — new project from /convert, planned_start_date drives year (Q3)
 *   T6b — project with no start date → current business year
 *   T6c — /convert Path A (existing project) untouched by this fix
 *   T7  — PATCH with different reference number → 422
 *   T7b — PATCH with null reference number → 422
 *   T7c — PATCH with blank string (→ null after preprocessing) → 422
 *   T7d — PATCH echoing same value → 200, no-op
 *   T9  — import number ahead of series; next auto fills correctly, no collision
 *   T10 — year isolation: 2025 series does not corrupt 2026 series
 *
 * All tests require a real Postgres database. Set TEST_DATABASE_URL to run them.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function scalar(dbUrl, sql, params = []) {
  const rows = await exec(dbUrl, sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

async function signIn(app) {
  const res = await request(app).post('/api/auth/login').send({
    username: 'tester',
    password: 'test-password-long-enough',
  });
  assert.equal(res.status, 200, 'sign-in failed');
  return res.headers['set-cookie'];
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(
  'Issue #9 — reference number year derivation and immutability',
  { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' },
  async () => {
    let dbUrl;
    let app;
    let pool;
    let cookie;

    before(async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      const name = `seq_suite_${process.pid}_${Date.now()}`;
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

    async function cleanQuotations() {
      await exec(dbUrl, 'DELETE FROM enquiries');
      await exec(dbUrl, 'DELETE FROM quotations');
    }

    async function cleanProjects() {
      await exec(dbUrl, 'DELETE FROM onboarding_tasks');
      await exec(dbUrl, 'DELETE FROM quotations');
      await exec(dbUrl, 'DELETE FROM projects');
    }

    // -----------------------------------------------------------------------
    // T1 — historical quotation, blank number, 2025 date
    // -----------------------------------------------------------------------
    test('T1: blank quotation_no with 2025 date generates CTZ/QT/2025/... reference', async () => {
      await cleanQuotations();
      const res = await request(app)
        .post('/api/quotations')
        .set('Cookie', cookie)
        .send({ client_name: 'Acme Ltd', quotation_date: '2025-11-15' });
      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      const no = res.body.data.quotation_no;
      assert.match(no, /^CTZ\/QT\/2025\/\d+$/, `Expected 2025 series, got: ${no}`);
    });

    // -----------------------------------------------------------------------
    // T2 — current-year quotation, blank number
    // -----------------------------------------------------------------------
    test('T2: blank quotation_no with current-year date generates correct series', async () => {
      await cleanQuotations();
      const currentYear = new Date().getFullYear().toString();
      const res = await request(app)
        .post('/api/quotations')
        .set('Cookie', cookie)
        .send({ client_name: 'Acme Ltd', quotation_date: `${currentYear}-09-16` });
      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      const no = res.body.data.quotation_no;
      assert.match(
        no,
        new RegExp(`^CTZ\\/QT\\/${currentYear}\\/\\d+$`),
        `Expected ${currentYear} series, got: ${no}`
      );
    });

    // -----------------------------------------------------------------------
    // T3 — explicit historical number stored exactly
    // -----------------------------------------------------------------------
    test('T3: explicit quotation_no CTZ/QT/2025/041 is stored exactly as supplied', async () => {
      await cleanQuotations();
      const res = await request(app)
        .post('/api/quotations')
        .set('Cookie', cookie)
        .send({ client_name: 'Acme Ltd', quotation_date: '2025-11-15', quotation_no: 'CTZ/QT/2025/041' });
      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.quotation_no, 'CTZ/QT/2025/041', 'explicit number must be stored exactly');
    });

    // -----------------------------------------------------------------------
    // T4 — duplicate explicit number → 409, original record untouched
    // -----------------------------------------------------------------------
    test('T4: duplicate explicit quotation_no returns 409, does not replace existing record', async () => {
      await cleanQuotations();
      await exec(dbUrl, `INSERT INTO quotations (quotation_no, client_name) VALUES ('CTZ/QT/2025/041', 'Acme Ltd')`);

      const res = await request(app)
        .post('/api/quotations')
        .set('Cookie', cookie)
        .send({ client_name: 'Beta Corp', quotation_date: '2025-12-01', quotation_no: 'CTZ/QT/2025/041' });

      assert.equal(res.status, 409, `Expected 409, got ${res.status}: ${JSON.stringify(res.body)}`);
      const clientName = await scalar(dbUrl, `SELECT client_name FROM quotations WHERE quotation_no = 'CTZ/QT/2025/041'`);
      assert.equal(clientName, 'Acme Ltd', 'original record must not have been replaced');
      const count = await scalar(dbUrl, `SELECT COUNT(*)::int FROM quotations WHERE quotation_no = 'CTZ/QT/2025/041'`);
      assert.equal(count, 1, 'there must still be exactly one record with that number');
    });

    // -----------------------------------------------------------------------
    // T5 — historical enquiry, blank number, 2025 date
    // -----------------------------------------------------------------------
    test('T5: blank enquiry_no with 2025 date generates CTZ/ENQ/2025/... reference', async () => {
      await cleanQuotations();
      const res = await request(app)
        .post('/api/enquiries')
        .set('Cookie', cookie)
        .send({ client_name: 'Acme Ltd', enquiry_date: '2025-06-01' });
      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      const no = res.body.data.enquiry_no;
      assert.match(no, /^CTZ\/ENQ\/2025\/\d+$/, `Expected 2025 series, got: ${no}`);
    });

    // -----------------------------------------------------------------------
    // T5b — Won enquiry with 2025 date creates CTZ/QT/2025/... quotation
    // -----------------------------------------------------------------------
    test('T5b: enquiry with enquiry_date=2025-06-17 transitioned to Won creates CTZ/QT/2025/... quotation', async () => {
      await cleanQuotations();
      // 1. Create historical enquiry
      const createRes = await request(app)
        .post('/api/enquiries')
        .set('Cookie', cookie)
        .send({ client_name: 'Acme Ltd', enquiry_date: '2025-06-17', status: 'In Progress' });
      assert.equal(createRes.status, 201, `Expected 201, got ${createRes.status}: ${JSON.stringify(createRes.body)}`);
      const enquiryId = createRes.body.data.id;
      const enquiryNo = createRes.body.data.enquiry_no;
      assert.match(enquiryNo, /^CTZ\/ENQ\/2025\/\d+$/);

      // 2. Transition to Won - Quotation Sent
      const wonRes = await request(app)
        .patch(`/api/enquiries/${enquiryId}`)
        .set('Cookie', cookie)
        .send({ status: 'Won - Quotation Sent' });
      assert.equal(wonRes.status, 200, `Expected 200, got ${wonRes.status}: ${JSON.stringify(wonRes.body)}`);

      // 3. Verify enquiry response and linked quotation_no
      const quotationNo = wonRes.body.data.quotation_no;
      assert.ok(quotationNo, 'quotation_no must be linked on the enquiry');
      assert.match(quotationNo, /^CTZ\/QT\/2025\/\d+$/, `Expected 2025 quotation series, got: ${quotationNo}`);

      // 4. Verify the created quotation row in the database
      const [quote] = await exec(dbUrl, 'SELECT quotation_no, quotation_date FROM quotations WHERE quotation_no = $1', [quotationNo]);
      assert.ok(quote, 'quotation row must exist in the database');
      assert.equal(quote.quotation_date, '2025-06-17', 'quotation_date must inherit the 2025-06-17 enquiry_date');
      assert.equal(quote.quotation_no, quotationNo, 'quotation_no must match the enquiry linked quotation_no');
    });

    // -----------------------------------------------------------------------
    // T6 — /convert Path B: planned_start_date 2025 drives project ID year
    // -----------------------------------------------------------------------
    test('T6: /convert with planned_start_date=2025-05-10 creates PRJ-2025-... project', async () => {
      await cleanProjects();
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name, status, po_received) VALUES (101,'CTZ/QT/2025/001','Acme Ltd','Won - PO Received',false)`);

      const res = await request(app)
        .post('/api/quotations/101/convert')
        .set('Cookie', cookie)
        .send({ planned_start_date: '2025-05-10', apply_onboarding_template: false });

      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      const projectId = res.body.data.project.project_id;
      assert.match(projectId, /^PRJ-2025-\d{3}$/, `Expected PRJ-2025-NNN, got: ${projectId}`);
    });

    // -----------------------------------------------------------------------
    // T6b — /convert Path B: no start date → current business year
    // -----------------------------------------------------------------------
    test('T6b: /convert without planned_start_date uses current business year for project ID', async () => {
      await cleanProjects();
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name, status, po_received) VALUES (102,'CTZ/QT/2026/001','Acme Ltd','Won - PO Received',false)`);

      const res = await request(app)
        .post('/api/quotations/102/convert')
        .set('Cookie', cookie)
        .send({ apply_onboarding_template: false });

      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      const projectId = res.body.data.project.project_id;
      assert.match(projectId, /^PRJ-\d{4}-\d{3}$/, `project_id must follow the sequence pattern: ${projectId}`);
    });

    // -----------------------------------------------------------------------
    // T6c — /convert Path A (existing project) is completely unaffected
    // -----------------------------------------------------------------------
    test('T6c: /convert Path A (existing project) does not create new project or consume sequence', async () => {
      await cleanProjects();
      await exec(dbUrl, `INSERT INTO projects (project_id, client_name) VALUES ('PRJ-2026-001','Acme Ltd')`);
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name, status, po_received) VALUES (103,'CTZ/QT/2026/002','Acme Ltd','Won - PO Received',false)`);
      const projectCountBefore = await scalar(dbUrl, `SELECT COUNT(*)::int FROM projects`);

      const res = await request(app)
        .post('/api/quotations/103/convert')
        .set('Cookie', cookie)
        .send({ project_id: 'PRJ-2026-001' });

      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.project.project_id, 'PRJ-2026-001', 'must return the existing project');
      assert.equal(res.body.data.onboarding_steps_added, 0, 'must not add onboarding to existing project');
      const projectCountAfter = await scalar(dbUrl, `SELECT COUNT(*)::int FROM projects`);
      assert.equal(projectCountAfter, projectCountBefore, 'no new project row must have been inserted');
      const qt2ProjectId = await scalar(dbUrl, `SELECT project_id FROM quotations WHERE quotation_no = 'CTZ/QT/2026/002'`);
      assert.equal(qt2ProjectId, 'PRJ-2026-001', 'quotation must be linked to the existing project');
    });

    // -----------------------------------------------------------------------
    // T7 — PATCH different value → 422
    // -----------------------------------------------------------------------
    test('T7: PATCH quotation_no to a different value returns 422 and preserves original', async () => {
      await cleanQuotations();
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name) VALUES (99,'CTZ/QT/2025/041','Acme Ltd')`);

      const res = await request(app)
        .patch('/api/quotations/99')
        .set('Cookie', cookie)
        .send({ quotation_no: 'CTZ/QT/2025/042' });

      assert.equal(res.status, 422, `Expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.error?.fields?.quotation_no, 'must include a field-level error on quotation_no');
      const no = await scalar(dbUrl, `SELECT quotation_no FROM quotations WHERE id = 99`);
      assert.equal(no, 'CTZ/QT/2025/041', 'original reference number must be unchanged');
    });

    // -----------------------------------------------------------------------
    // T7b — PATCH null → 422
    // -----------------------------------------------------------------------
    test('T7b: PATCH quotation_no = null returns 422, not silent success', async () => {
      await cleanQuotations();
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name) VALUES (99,'CTZ/QT/2025/041','Acme Ltd')`);

      const res = await request(app)
        .patch('/api/quotations/99')
        .set('Cookie', cookie)
        .send({ quotation_no: null });

      assert.equal(res.status, 422, `Expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
      const no = await scalar(dbUrl, `SELECT quotation_no FROM quotations WHERE id = 99`);
      assert.equal(no, 'CTZ/QT/2025/041', 'original reference number must be unchanged after null PATCH');
    });

    // -----------------------------------------------------------------------
    // T7c — PATCH blank string (→ null via blankToNull) → 422
    // -----------------------------------------------------------------------
    test('T7c: PATCH quotation_no = "" (blank) returns 422, not silent success', async () => {
      await cleanQuotations();
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name) VALUES (99,'CTZ/QT/2025/041','Acme Ltd')`);

      const res = await request(app)
        .patch('/api/quotations/99')
        .set('Cookie', cookie)
        .send({ quotation_no: '' });

      assert.equal(res.status, 422, `Expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
      const no = await scalar(dbUrl, `SELECT quotation_no FROM quotations WHERE id = 99`);
      assert.equal(no, 'CTZ/QT/2025/041', 'original reference number must be unchanged after blank PATCH');
    });

    // -----------------------------------------------------------------------
    // T7d — PATCH echoing same value → 200, no-op
    // -----------------------------------------------------------------------
    test('T7d: PATCH quotation_no = same value is a no-op and returns 200', async () => {
      await cleanQuotations();
      await exec(dbUrl, `INSERT INTO quotations (id, quotation_no, client_name) VALUES (99,'CTZ/QT/2025/041','Acme Ltd')`);

      const res = await request(app)
        .patch('/api/quotations/99')
        .set('Cookie', cookie)
        .send({ quotation_no: 'CTZ/QT/2025/041', remarks: 'updated remarks' });

      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.quotation_no, 'CTZ/QT/2025/041', 'reference number must remain the same');
      assert.equal(res.body.data.remarks, 'updated remarks', 'other fields must still be updated');
    });

    // -----------------------------------------------------------------------
    // T9 — sequence safety: import ahead of counter, next auto is correct
    // -----------------------------------------------------------------------
    test('T9: after importing CTZ/QT/2025/050, next auto-generate is CTZ/QT/2025/051', async () => {
      await cleanQuotations();
      // Import 040 and 050 (simulating historical migration, gap intentional).
      await exec(dbUrl, `INSERT INTO quotations (quotation_no, client_name) VALUES ('CTZ/QT/2025/040','Acme Ltd')`);
      await exec(dbUrl, `INSERT INTO quotations (quotation_no, client_name) VALUES ('CTZ/QT/2025/050','Beta Corp')`);

      // Auto-generate the next 2025 quotation.
      const res = await request(app)
        .post('/api/quotations')
        .set('Cookie', cookie)
        .send({ client_name: 'Gamma Inc', quotation_date: '2025-12-01' });

      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.quotation_no, 'CTZ/QT/2025/051', `Expected CTZ/QT/2025/051, got: ${res.body.data.quotation_no}`);
    });

    // -----------------------------------------------------------------------
    // T10 — year isolation: 2025 records do not corrupt 2026 sequence
    // -----------------------------------------------------------------------
    test('T10: 2025 records with large numbers do not corrupt the 2026 series', async () => {
      await cleanQuotations();
      // Seed 2025 with a large number.
      await exec(dbUrl, `INSERT INTO quotations (quotation_no, client_name) VALUES ('CTZ/QT/2025/099','Acme Ltd')`);
      // Seed 2026 at 003.
      await exec(dbUrl, `INSERT INTO quotations (quotation_no, client_name) VALUES ('CTZ/QT/2026/003','Beta Corp')`);

      // Auto-generate a 2026 quotation.
      const res = await request(app)
        .post('/api/quotations')
        .set('Cookie', cookie)
        .send({ client_name: 'Gamma Inc', quotation_date: '2026-09-16' });

      assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
      const no = res.body.data.quotation_no;
      // Must be 004 in 2026 — not influenced by the 099 in 2025.
      assert.equal(no, 'CTZ/QT/2026/004', `2026 sequence must be independent of 2025: got ${no}`);
    });
  }
);
