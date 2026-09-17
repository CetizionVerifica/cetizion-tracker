import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Regression tests for POST /api/quotations/:id/convert
 *
 * Tests two paths:
 *   - New project (project_id absent): creates project, links quotation, applies onboarding
 *   - Existing project (project_id present): links quotation only — no new project,
 *     no sequence consumption, no onboarding, existing project data unchanged
 *
 * All tests require a real Postgres database. Set TEST_DATABASE_URL to run them.
 * Without it, every suite is skipped — the same convention used in migrations.test.js.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

// -----------------------------------------------------------------------
// Database helpers
// -----------------------------------------------------------------------

/** Run schema.sql + views.sql against a fresh database. */
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

/** Execute arbitrary SQL against a URL, return rows. */
async function exec(dbUrl, sql, params = []) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const r = await client.query(sql, params);
    return r.rows;
  } finally {
    await client.end();
  }
}

/** Return the first value of the first row. */
async function scalar(dbUrl, sql, params = []) {
  const rows = await exec(dbUrl, sql, params);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

// -----------------------------------------------------------------------
// Seed helpers
// -----------------------------------------------------------------------

async function insertQuotation(dbUrl, {
  id = 1,
  quotationNo = 'CTZ/QT/2026/001',
  clientName = 'Acme Ltd',
  status = 'Won - PO Received',
  projectId = null,
} = {}) {
  await exec(
    dbUrl,
    `INSERT INTO quotations (id, quotation_no, client_name, status, po_received, project_id)
     VALUES ($1, $2, $3, $4, false, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, quotationNo, clientName, status, projectId]
  );
}

async function insertProject(dbUrl, {
  projectId = 'PRJ-2026-001',
  clientName = 'Acme Ltd',
  projectManager = 'Alice',
  remarks = 'Original remarks',
} = {}) {
  await exec(
    dbUrl,
    `INSERT INTO projects (project_id, client_name, project_manager, remarks)
     VALUES ($1, $2, $3, $4)`,
    [projectId, clientName, projectManager, remarks]
  );
}

/** Sign in and return the cookie string. */
async function signIn(app) {
  const res = await request(app).post('/api/auth/login').send({
    username: 'tester',
    password: 'test-password-long-enough',
  });
  assert.equal(res.status, 200, 'sign-in failed');
  return res.headers['set-cookie'];
}

// -----------------------------------------------------------------------
// Suite
// -----------------------------------------------------------------------

describe('POST /api/quotations/:id/convert', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, async () => {
  let dbUrl;
  let app;
  let pool;
  let cookie;

  before(async () => {
    // Create one throwaway database for the whole suite.
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `convert_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    await applySchema(dbUrl);

    // Set env vars before importing the app so config picks them up.
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

  /** Wipe mutable tables between tests (FK order). */
  async function cleanSlate() {
    await exec(dbUrl, 'DELETE FROM onboarding_tasks');
    await exec(dbUrl, 'DELETE FROM quotations');
    await exec(dbUrl, 'DELETE FROM projects');
  }

  // -----------------------------------------------------------------------
  // Test 1 — new project still works
  // -----------------------------------------------------------------------
  test('creates a new project and links the quotation when no project_id is supplied', async () => {
    await cleanSlate();
    await insertQuotation(dbUrl, { id: 1 });

    const res = await request(app)
      .post('/api/quotations/1/convert')
      .set('Cookie', cookie)
      .send({
        project_manager: 'Bob',
        project_manager_email: 'bob@example.com',
        planned_start_date: '2026-01-10',
        planned_delivery_date: '2026-06-30',
        apply_onboarding_template: true,
      });

    assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    const { project, onboarding_steps_added } = res.body.data;

    // A project was created with a correctly-formatted sequence ID.
    assert.match(project.project_id, /^PRJ-\d{4}-\d{3}$/, 'project_id follows the sequence pattern');
    assert.equal(project.client_name, 'Acme Ltd');

    // The quotation is now linked.
    const qtProjectId = await scalar(dbUrl, 'SELECT project_id FROM quotations WHERE id = 1');
    assert.equal(qtProjectId, project.project_id);

    // Onboarding was applied.
    assert.ok(onboarding_steps_added > 0, 'onboarding steps should have been added');
    const obCount = await scalar(
      dbUrl,
      'SELECT COUNT(*)::int FROM onboarding_tasks WHERE project_id = $1',
      [project.project_id]
    );
    assert.equal(obCount, onboarding_steps_added);
  });

  // -----------------------------------------------------------------------
  // Test 2 — existing project: all DB-side invariants verified
  // -----------------------------------------------------------------------
  test('links quotation to existing project without inserting a new project or consuming the sequence', async () => {
    await cleanSlate();

    await insertProject(dbUrl, {
      projectId: 'PRJ-2026-001',
      clientName: 'Acme Ltd',
      projectManager: 'Alice',
      remarks: 'Original remarks',
    });
    // A first quotation already registered to the project.
    await insertQuotation(dbUrl, { id: 1, quotationNo: 'CTZ/QT/2026/001', clientName: 'Acme Ltd', projectId: 'PRJ-2026-001' });
    // The unregistered quotation we will link.
    await insertQuotation(dbUrl, { id: 2, quotationNo: 'CTZ/QT/2026/002', clientName: 'Acme Ltd', projectId: null });

    const projectCountBefore = await scalar(dbUrl, 'SELECT COUNT(*)::int FROM projects');
    const obCountBefore = await scalar(
      dbUrl,
      "SELECT COUNT(*)::int FROM onboarding_tasks WHERE project_id = 'PRJ-2026-001'"
    );
    // Read the highest existing project serial so we can confirm it does not move.
    const maxSerialBefore = await scalar(
      dbUrl,
      "SELECT COALESCE(MAX(CAST(substring(project_id FROM '[0-9]+$') AS int)), 0) FROM projects WHERE project_id LIKE 'PRJ-2026-%'"
    );

    const res = await request(app)
      .post('/api/quotations/2/convert')
      .set('Cookie', cookie)
      .send({ project_id: 'PRJ-2026-001' });

    assert.equal(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.data.project.project_id, 'PRJ-2026-001');
    assert.equal(res.body.data.onboarding_steps_added, 0, 'must not add onboarding to existing project');

    // Project count must not have increased.
    const projectCountAfter = await scalar(dbUrl, 'SELECT COUNT(*)::int FROM projects');
    assert.equal(projectCountAfter, projectCountBefore, 'no new project row inserted');

    // Sequence was not consumed: the highest serial in the table is still the same.
    const maxSerialAfter = await scalar(
      dbUrl,
      "SELECT COALESCE(MAX(CAST(substring(project_id FROM '[0-9]+$') AS int)), 0) FROM projects WHERE project_id LIKE 'PRJ-2026-%'"
    );
    assert.equal(maxSerialAfter, maxSerialBefore, 'project-number sequence was not consumed');

    // Quotation #2 is now linked to PRJ-2026-001.
    const qt2ProjectId = await scalar(dbUrl, 'SELECT project_id FROM quotations WHERE id = 2');
    assert.equal(qt2ProjectId, 'PRJ-2026-001');

    // Existing project data is completely unchanged.
    const proj = (await exec(dbUrl, 'SELECT * FROM projects WHERE project_id = $1', ['PRJ-2026-001']))[0];
    assert.equal(proj.project_manager, 'Alice', 'project_manager must be unchanged');
    assert.equal(proj.remarks, 'Original remarks', 'remarks must be unchanged');

    // Onboarding count is unchanged.
    const obCountAfter = await scalar(
      dbUrl,
      "SELECT COUNT(*)::int FROM onboarding_tasks WHERE project_id = 'PRJ-2026-001'"
    );
    assert.equal(obCountAfter, obCountBefore, 'no onboarding rows added to existing project');
  });

  // -----------------------------------------------------------------------
  // Test 3 — two quotations can coexist under the same project
  // -----------------------------------------------------------------------
  test('allows two won quotations to be linked to the same existing project', async () => {
    await cleanSlate();

    await insertProject(dbUrl, { projectId: 'PRJ-2026-001', clientName: 'Acme Ltd' });
    await insertQuotation(dbUrl, { id: 1, quotationNo: 'CTZ/QT/2026/001', clientName: 'Acme Ltd', projectId: null });
    await insertQuotation(dbUrl, { id: 2, quotationNo: 'CTZ/QT/2026/002', clientName: 'Acme Ltd', projectId: null });

    const r1 = await request(app)
      .post('/api/quotations/1/convert')
      .set('Cookie', cookie)
      .send({ project_id: 'PRJ-2026-001' });
    assert.equal(r1.status, 201, `First link: ${JSON.stringify(r1.body)}`);

    const r2 = await request(app)
      .post('/api/quotations/2/convert')
      .set('Cookie', cookie)
      .send({ project_id: 'PRJ-2026-001' });
    assert.equal(r2.status, 201, `Second link: ${JSON.stringify(r2.body)}`);

    const linked = await exec(
      dbUrl,
      "SELECT quotation_no FROM quotations WHERE project_id = 'PRJ-2026-001' ORDER BY quotation_no"
    );
    assert.equal(linked.length, 2, 'Both quotations must be linked to the project');
    assert.equal(linked[0].quotation_no, 'CTZ/QT/2026/001');
    assert.equal(linked[1].quotation_no, 'CTZ/QT/2026/002');

    // Still exactly one project.
    const projectCount = await scalar(dbUrl, 'SELECT COUNT(*)::int FROM projects');
    assert.equal(projectCount, 1);
  });

  // -----------------------------------------------------------------------
  // Test 4 — already-registered quotation is rejected
  // -----------------------------------------------------------------------
  test('rejects with 422 a quotation that is already linked to a project', async () => {
    await cleanSlate();

    await insertProject(dbUrl, { projectId: 'PRJ-2026-001', clientName: 'Acme Ltd' });
    await insertQuotation(dbUrl, {
      id: 1,
      quotationNo: 'CTZ/QT/2026/001',
      clientName: 'Acme Ltd',
      projectId: 'PRJ-2026-001',
    });

    const res = await request(app)
      .post('/api/quotations/1/convert')
      .set('Cookie', cookie)
      .send({ project_manager: 'Bob' });

    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /already registered/i);
  });

  // -----------------------------------------------------------------------
  // Test 5 — nonexistent project_id is rejected; no side-effects
  // -----------------------------------------------------------------------
  test('rejects with 422 when the supplied project_id does not exist', async () => {
    await cleanSlate();
    await insertQuotation(dbUrl, { id: 1, quotationNo: 'CTZ/QT/2026/001', clientName: 'Acme Ltd' });

    const res = await request(app)
      .post('/api/quotations/1/convert')
      .set('Cookie', cookie)
      .send({ project_id: 'PRJ-2026-999' });

    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /not found/i);

    // No project created, quotation still unlinked.
    const projectCount = await scalar(dbUrl, 'SELECT COUNT(*)::int FROM projects');
    assert.equal(projectCount, 0, 'no project must have been created');
    const qtProjectId = await scalar(dbUrl, 'SELECT project_id FROM quotations WHERE id = 1');
    assert.equal(qtProjectId, null, 'quotation must remain unlinked');
  });

  // -----------------------------------------------------------------------
  // Test 6 — cross-client linkage is rejected by the backend
  // -----------------------------------------------------------------------
  test('rejects attaching Client A quotation to a Client B project', async () => {
    await cleanSlate();

    await insertProject(dbUrl, { projectId: 'PRJ-2026-001', clientName: 'Widgets Corp' });
    await insertQuotation(dbUrl, { id: 1, quotationNo: 'CTZ/QT/2026/001', clientName: 'Acme Ltd' });

    const res = await request(app)
      .post('/api/quotations/1/convert')
      .set('Cookie', cookie)
      .send({ project_id: 'PRJ-2026-001' });

    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /different client/i);

    // Quotation must remain unlinked.
    const qtProjectId = await scalar(dbUrl, 'SELECT project_id FROM quotations WHERE id = 1');
    assert.equal(qtProjectId, null, 'quotation must remain unlinked after cross-client rejection');
  });

  // -----------------------------------------------------------------------
  // Test 7 — onboarding rows are not duplicated for an existing project
  // -----------------------------------------------------------------------
  test('does not add onboarding rows when linking a quotation to a project that already has them', async () => {
    await cleanSlate();

    await insertProject(dbUrl, { projectId: 'PRJ-2026-001', clientName: 'Acme Ltd' });
    await exec(
      dbUrl,
      `INSERT INTO onboarding_tasks (project_id, step_no, stage, step)
       VALUES ('PRJ-2026-001', 1, 'Onboarding', 'Step one'),
              ('PRJ-2026-001', 2, 'Onboarding', 'Step two')`
    );
    await insertQuotation(dbUrl, { id: 1, quotationNo: 'CTZ/QT/2026/001', clientName: 'Acme Ltd' });

    const res = await request(app)
      .post('/api/quotations/1/convert')
      .set('Cookie', cookie)
      .send({ project_id: 'PRJ-2026-001' });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.onboarding_steps_added, 0, 'response must report 0 new steps');

    const obCount = await scalar(
      dbUrl,
      "SELECT COUNT(*)::int FROM onboarding_tasks WHERE project_id = 'PRJ-2026-001'"
    );
    assert.equal(obCount, 2, 'onboarding rows must not be duplicated — still exactly 2');
  });
});
