import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('KPI authorization and conversion origin rules', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let admin;
  let salesA;
  let salesB;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `kpi_auth_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'shared-admin-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const signIn = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  };


  async function setUp() {
    await db.query('DELETE FROM sales_targets');
    await db.query('DELETE FROM activity_log');
    await db.query('DELETE FROM ownership_history');
    await db.query('DELETE FROM payment_stages');
    await db.query('DELETE FROM purchase_orders');
    await db.query('DELETE FROM quotations');
    await db.query('DELETE FROM enquiries');
    await db.query('DELETE FROM projects');
    await db.query('DELETE FROM companies');
    await db.query('DELETE FROM users');

    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const s1 = await mk({ name: 'Sam Sales', email: 'sam@example.com', role: 'sales' });
    const s2 = await mk({ name: 'Bea Sales', email: 'bea@example.com', role: 'sales' });

    admin = { user: a, cookie: await signIn(a.email) };
    salesA = { user: s1, cookie: await signIn(s1.email) };
    salesB = { user: s2, cookie: await signIn(s2.email) };
  }

  test('unauthenticated requests receive 401 on all KPI endpoints', async () => {
    await setUp();

    assert.equal((await request(app).get('/api/kpis/me')).status, 401);
    assert.equal((await request(app).get('/api/kpis/team')).status, 401);
    assert.equal((await request(app).get(`/api/kpis/users/${salesA.user.id}`)).status, 401);
    assert.equal((await request(app).get('/api/kpis/targets')).status, 401);
    assert.equal(
      (await request(app).put(`/api/kpis/users/${salesA.user.id}/targets/won_quotations_count`).send({})).status,
      401
    );
  });

  test('sales users can read own /me and own /users/:id, but cannot read another sales rep or team', async () => {
    await setUp();

    // Sales A reads own /me -> 200
    const resMe = await request(app).get('/api/kpis/me?year=2026').set('Cookie', salesA.cookie);
    assert.equal(resMe.status, 200);
    assert.equal(resMe.body.data.salesperson.id, salesA.user.id);

    // Sales A reads own /users/:id -> 200
    const resOwn = await request(app)
      .get(`/api/kpis/users/${salesA.user.id}?year=2026`)
      .set('Cookie', salesA.cookie);
    assert.equal(resOwn.status, 200);
    assert.equal(resOwn.body.data.salesperson.id, salesA.user.id);

    // Sales A attempts to read Sales B -> 403 Forbidden
    const resOther = await request(app)
      .get(`/api/kpis/users/${salesB.user.id}?year=2026`)
      .set('Cookie', salesA.cookie);
    assert.equal(resOther.status, 403);

    // Sales A attempts to read /team -> 403 Forbidden
    const resTeam = await request(app).get('/api/kpis/team?year=2026').set('Cookie', salesA.cookie);
    assert.equal(resTeam.status, 403);
  });

  test('database admin can read individual salesperson KPIs and team-wide report', async () => {
    await setUp();

    const resIndiv = await request(app)
      .get(`/api/kpis/users/${salesA.user.id}?year=2026`)
      .set('Cookie', admin.cookie);
    assert.equal(resIndiv.status, 200);
    assert.equal(resIndiv.body.data.salesperson.id, salesA.user.id);

    const resTeam = await request(app).get('/api/kpis/team?year=2026').set('Cookie', admin.cookie);
    assert.equal(resTeam.status, 200);
    assert(Array.isArray(resTeam.body.data.salespeople));
  });

  test('direct project creation captures origin when created by sales rep; unassigned when created by admin', async () => {
    await setUp();

    // 1. Sales A creates project via POST /api/projects
    const resSales = await request(app)
      .post('/api/projects')
      .set('Cookie', salesA.cookie)
      .send({
        client_name: 'Acme Direct',
        project_manager: 'PM Sam',
        currency: 'INR',
      });
    assert.equal(resSales.status, 201, JSON.stringify(resSales.body));
    const salesPrjId = resSales.body.data.project_id;

    const { rows: [p1] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM projects WHERE project_id = $1',
      [salesPrjId]
    );
    assert.equal(p1.owner_user_id, salesA.user.id);
    assert.equal(p1.originating_user_id, salesA.user.id);
    assert.equal(p1.originating_user_snapshot_id, salesA.user.id);
    assert.equal(p1.originating_user_name, 'Sam Sales');

    // 2. Admin creates project via POST /api/projects
    const resAdmin = await request(app)
      .post('/api/projects')
      .set('Cookie', admin.cookie)
      .send({
        client_name: 'Admin Direct Corp',
        project_manager: 'PM Alice',
        currency: 'INR',
      });
    assert.equal(resAdmin.status, 201, JSON.stringify(resAdmin.body));
    const adminPrjId = resAdmin.body.data.project_id;

    const { rows: [p2] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM projects WHERE project_id = $1',
      [adminPrjId]
    );
    assert.equal(p2.owner_user_id, null, 'admin-created project remains unassigned');
    assert.equal(p2.originating_user_id, null, 'admin-created project remains unattributed');
    assert.equal(p2.originating_user_snapshot_id, null);
  });

  test('conversion of quotation to new project preserves origin; linking to existing project keeps individual origins', async () => {
    await setUp();

    // 1. Sales A creates a quotation
    const { rows: [q1] } = await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-CONV-01', 'Conversion Corp', '2026-04-01', 200000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
      RETURNING id
    `, [salesA.user.id]);

    // 2. Convert to a BRAND NEW project via workflow convert endpoint
    const resConvertNew = await request(app)
      .post(`/api/quotations/${q1.id}/convert`)
      .set('Cookie', salesA.cookie)
      .send({
        project_manager: 'PM Mike',
        planned_start_date: '2026-04-10',
      });
    assert.equal(resConvertNew.status, 201, JSON.stringify(resConvertNew.body));
    const newProjectId = resConvertNew.body.data.project.project_id;

    // Check newly created project: inherited originating_user_id from quotation
    const { rows: [pNew] } = await db.query(
      'SELECT originating_user_id, originating_user_snapshot_id FROM projects WHERE project_id = $1',
      [newProjectId]
    );
    assert.equal(pNew.originating_user_id, salesA.user.id);
    assert.equal(pNew.originating_user_snapshot_id, salesA.user.id);

    // 3. Create an existing project originated by Sales B
    await db.query(`
      INSERT INTO projects (project_id, client_name, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('PRJ-EXISTING-B', 'Existing Client', $1, $1, $1, 'Bea Sales')
    `, [salesB.user.id]);

    // Quotation created by Sales A for the same client
    const { rows: [q2] } = await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-CONV-02', 'Existing Client', '2026-04-05', 150000, 'INR', 'Won - PO Received', $1, $1, $1, 'Sam Sales')
      RETURNING id
    `, [salesA.user.id]);

    // Convert QT-CONV-02 by linking to existing project PRJ-EXISTING-B (Admin performs linking)
    const resLinkExisting = await request(app)
      .post(`/api/quotations/${q2.id}/convert`)
      .set('Cookie', admin.cookie)
      .send({
        project_id: 'PRJ-EXISTING-B',
      });
    assert.equal(resLinkExisting.status, 201, JSON.stringify(resLinkExisting.body));

    // Verify existing project's origin was NOT modified or overwritten!
    const { rows: [pExisting] } = await db.query(
      'SELECT originating_user_id, originating_user_snapshot_id FROM projects WHERE project_id = $1',
      ['PRJ-EXISTING-B']
    );
    assert.equal(pExisting.originating_user_id, salesB.user.id);

    // Verify quotation still has Sales A's origin
    const { rows: [qLinked] } = await db.query(
      'SELECT project_id, originating_user_id FROM quotations WHERE quotation_no = $1',
      ['QT-CONV-02']
    );
    assert.equal(qLinked.project_id, 'PRJ-EXISTING-B');
    assert.equal(qLinked.originating_user_id, salesA.user.id);
  });

  test('ordinary CRUD patch cannot overwrite originating fields', async () => {
    await setUp();

    // Create quotation
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name)
      VALUES ('QT-IMMUTABLE', 'Immut Corp', '2026-05-01', 100000, 'INR', 'Submitted', $1, $1, $1, 'Sam Sales')
    `, [salesA.user.id]);

    const { rows: [initial] } = await db.query('SELECT id FROM quotations WHERE quotation_no = $1', ['QT-IMMUTABLE']);

    // Attempt to PATCH originating fields
    const resPatch = await request(app)
      .patch(`/api/quotations/${initial.id}`)
      .set('Cookie', salesA.cookie)
      .send({
        originating_user_id: salesB.user.id,
        originating_user_snapshot_id: salesB.user.id,
        originating_user_name: 'Hacked',
        remarks: 'Updated remarks',
      });
    assert.equal(resPatch.status, 200);

    // Origin fields remain untouched
    const { rows: [afterPatch] } = await db.query(
      'SELECT originating_user_id, originating_user_snapshot_id, originating_user_name, remarks FROM quotations WHERE id = $1',
      [initial.id]
    );
    assert.equal(afterPatch.originating_user_id, salesA.user.id);
    assert.equal(afterPatch.originating_user_snapshot_id, salesA.user.id);
    assert.equal(afterPatch.originating_user_name, 'Sam Sales');
    assert.equal(afterPatch.remarks, 'Updated remarks');
  });

  test('enquiry-to-quotation conversion preserves verified origin and ownership rules, and does not fabricate origin for unattributed enquiries', async () => {
    await setUp();

    // 1. Sales A creates an enquiry
    const resEnq = await request(app)
      .post('/api/enquiries')
      .set('Cookie', salesA.cookie)
      .send({
        enquiry_no: 'CTZ/ENQ/2026/001',
        client_name: 'Origin Client Corp',
        service: 'Design Verification',
        status: 'In Progress',
        // #24: an enquiry leaves New only with a source, and is converted
        // only with a value. Business fields, not ownership ones.
        source: 'Referral',
        estimated_value: 120000,
      });
    assert.equal(resEnq.status, 201, JSON.stringify(resEnq.body));
    const enqId = resEnq.body.data.id;

    // Verify enquiry origin
    const { rows: [enqDb] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM enquiries WHERE id = $1',
      [enqId]
    );
    assert.equal(enqDb.owner_user_id, salesA.user.id);
    assert.equal(enqDb.originating_user_id, salesA.user.id);
    assert.equal(enqDb.originating_user_snapshot_id, salesA.user.id);
    assert.equal(enqDb.originating_user_name, 'Sam Sales');

    // Sales A marks enquiry Won -> triggers quoteWonEnquiry
    const resWon = await request(app)
      .patch(`/api/enquiries/${enqId}`)
      .set('Cookie', salesA.cookie)
      .send({
        status: 'Won - Quotation Sent',
      });
    assert.equal(resWon.status, 200, JSON.stringify(resWon.body));
    const quoteNo = resWon.body.data.quotation_no;
    assert.ok(quoteNo, 'quotation was created and linked');

    // Verify created quotation has inherited ownership and preserved origin
    const { rows: [qDb] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM quotations WHERE quotation_no = $1',
      [quoteNo]
    );
    assert.equal(qDb.owner_user_id, salesA.user.id, 'ownership inherited from enquiry');
    assert.equal(qDb.originating_user_id, salesA.user.id, 'origin preserved from enquiry');
    assert.equal(qDb.originating_user_snapshot_id, salesA.user.id);
    assert.equal(qDb.originating_user_name, 'Sam Sales');

    // 2. Enquiry originated by Sales A but reassigned to Sales B.
    //
    // 'Contacted', not 'In Progress': #24 renamed the open statuses and
    // migration 042 narrowed the CHECK to the new vocabulary, mapping
    // 'In Progress' to exactly this value. The two fixtures above go through
    // the API, whose schema still accepts the old word and aliases it
    // (LEGACY_ENQUIRY_STATUS); this one writes to the table directly, so it
    // has to use what the table accepts. Same enquiry, same open state.
    const { rows: [reassignedEnq] } = await db.query(`
      INSERT INTO enquiries (enquiry_no, client_name, service, status, owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name, source, estimated_value)
      VALUES ('CTZ/ENQ/2026/002', 'Reassigned Client', 'Consulting', 'Contacted', $1, $2, $2, 'Sam Sales', 'Referral', 75000)
      RETURNING id
    `, [salesB.user.id, salesA.user.id]);

    // Sales B wins the enquiry
    const resWonB = await request(app)
      .patch(`/api/enquiries/${reassignedEnq.id}`)
      .set('Cookie', salesB.cookie)
      .send({
        status: 'Won - Quotation Sent',
      });
    assert.equal(resWonB.status, 200);
    const quoteNoB = resWonB.body.data.quotation_no;

    const { rows: [qDbB] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM quotations WHERE quotation_no = $1',
      [quoteNoB]
    );
    // Current owner is Sales B (current assignee)
    assert.equal(qDbB.owner_user_id, salesB.user.id);
    // Origin remains Sales A (who originated the enquiry)
    assert.equal(qDbB.originating_user_id, salesA.user.id);
    assert.equal(qDbB.originating_user_snapshot_id, salesA.user.id);
    assert.equal(qDbB.originating_user_name, 'Sam Sales');

    // 3. Unattributed enquiry created by Admin
    const resAdminEnq = await request(app)
      .post('/api/enquiries')
      .set('Cookie', admin.cookie)
      .send({
        enquiry_no: 'CTZ/ENQ/2026/003',
        client_name: 'Unattributed Client',
        service: 'Testing',
        status: 'In Progress',
        source: 'Outreach',
        estimated_value: 90000,
      });
    assert.equal(resAdminEnq.status, 201);
    const adminEnqId = resAdminEnq.body.data.id;

    // Admin converts to Won
    const resWonAdmin = await request(app)
      .patch(`/api/enquiries/${adminEnqId}`)
      .set('Cookie', admin.cookie)
      .send({
        status: 'Won - Quotation Sent',
      });
    assert.equal(resWonAdmin.status, 200);
    const quoteNoAdmin = resWonAdmin.body.data.quotation_no;

    const { rows: [qDbAdmin] } = await db.query(
      'SELECT owner_user_id, originating_user_id, originating_user_snapshot_id, originating_user_name FROM quotations WHERE quotation_no = $1',
      [quoteNoAdmin]
    );
    // Neither owner nor origin is fabricated
    assert.equal(qDbAdmin.owner_user_id, null);
    assert.equal(qDbAdmin.originating_user_id, null);
    assert.equal(qDbAdmin.originating_user_snapshot_id, null);
    assert.equal(qDbAdmin.originating_user_name, null);
  });
});
