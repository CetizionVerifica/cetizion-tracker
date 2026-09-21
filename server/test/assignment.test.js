import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Administrative ownership assignment, reassignment and handover history (#18 Phase 3).
 *
 * Full security, concurrency, and regression verification suite.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const ENTITIES = ['enquiries', 'quotations', 'projects'];

describe('ownership assignment and handover history', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let updateUser;
  let admin;
  let salesA;
  let salesB;
  let salesC;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `assign_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    // Install failure simulation triggers for atomicity tests
    await db.query(`
      CREATE OR REPLACE FUNCTION fail_history_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.reason = 'SIMULATE_HISTORY_FAIL' THEN
          RAISE EXCEPTION 'Simulated history insertion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_fail_history_insert ON ownership_history;
      CREATE TRIGGER trg_fail_history_insert
      BEFORE INSERT ON ownership_history
      FOR EACH ROW EXECUTE FUNCTION fail_history_insert();

      CREATE OR REPLACE FUNCTION fail_activity_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata->>'reason' = 'SIMULATE_ACTIVITY_FAIL' THEN
          RAISE EXCEPTION 'Simulated activity insertion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_fail_activity_insert ON activity_log;
      CREATE TRIGGER trg_fail_activity_insert
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION fail_activity_insert();
    `);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser, updateUser } = await import('../src/lib/users.js'));
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
    for (const t of [
      'ownership_history',
      'activity_log',
      'payment_stages',
      'po_services',
      'purchase_orders',
      ...ENTITIES,
      'documents',
      'users',
    ]) {
      await db.query(`DELETE FROM ${t}`);
    }
    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const sA = await mk({ name: 'Sam Sales', email: 'sam@example.com', role: 'sales' });
    const sB = await mk({ name: 'Bea Sales', email: 'bea@example.com', role: 'sales' });
    const sC = await mk({ name: 'Charlie Sales', email: 'charlie@example.com', role: 'sales' });

    admin = { user: a, cookie: await signIn(a.email) };
    salesA = { user: sA, cookie: await signIn(sA.email) };
    salesB = { user: sB, cookie: await signIn(sB.email) };
    salesC = { user: sC, cookie: await signIn(sC.email) };
  }

  // ---------------------------------------------------------------------------
  // 1. Independent Entity Authorization & Lifecycle Verification
  // ---------------------------------------------------------------------------
  for (const entity of ENTITIES) {
    test(`entity independent authorization and validation: ${entity}`, async () => {
      await setUp();

      let rowId;
      let naturalKey;
      if (entity === 'enquiries') {
        const { rows } = await db.query(
          `INSERT INTO enquiries (enquiry_no, client_name, owner_user_id)
           VALUES ('CTZ/ENQ/2026/101', 'Client Enq', null) RETURNING id, enquiry_no`
        );
        rowId = rows[0].id;
        naturalKey = rows[0].enquiry_no;
      } else if (entity === 'quotations') {
        const { rows } = await db.query(
          `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
           VALUES ('CTZ/QT/2026/101', 'Client Quot', '2026-05-01', 'Submitted', null) RETURNING id, quotation_no`
        );
        rowId = rows[0].id;
        naturalKey = rows[0].quotation_no;
      } else {
        const { rows } = await db.query(
          `INSERT INTO projects (project_id, client_name, owner_user_id)
           VALUES ('PRJ-2026-101', 'Client Prj', null) RETURNING id, project_id`
        );
        rowId = rows[0].id;
        naturalKey = rows[0].project_id;
      }

      // Unauthenticated -> 401
      const unauthPatch = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .send({ expected_owner_user_id: null, new_owner_user_id: salesA.user.id, reason: 'Init' });
      assert.equal(unauthPatch.status, 401);

      const unauthHist = await request(app).get(`/api/${entity}/${rowId}/ownership-history`);
      assert.equal(unauthHist.status, 401);

      // Sales user -> 403
      const salesPatch = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', salesA.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: salesA.user.id, reason: 'Init' });
      assert.equal(salesPatch.status, 403);

      const salesHist = await request(app)
        .get(`/api/${entity}/${rowId}/ownership-history`)
        .set('Cookie', salesA.cookie);
      assert.equal(salesHist.status, 403);

      // Unknown record -> 404
      const unknownPatch = await request(app)
        .patch(`/api/${entity}/999999/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: salesA.user.id, reason: 'Init' });
      assert.equal(unknownPatch.status, 404);

      const unknownHist = await request(app)
        .get(`/api/${entity}/999999/ownership-history`)
        .set('Cookie', admin.cookie);
      assert.equal(unknownHist.status, 404);

      // Invalid target (nonexistent, inactive, attribution-only, admin) -> 422
      const badTargetRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: 888888, reason: 'Bad' });
      assert.equal(badTargetRes.status, 422);

      const adminTargetRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: admin.user.id, reason: 'Bad' });
      assert.equal(adminTargetRes.status, 422);

      const inactiveUser = await createUser(
        { name: 'Inactive Target', email: `inactive_${entity}@example.com`, password: PASSWORD, role: 'sales', active: false },
        db
      );
      const inactiveTargetRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: inactiveUser.id, reason: 'Inactive' });
      assert.equal(inactiveTargetRes.status, 422);

      const attrOnlyUser = await createUser({ name: `Historical Attr ${entity}`, active: false }, db);
      const attrTargetRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: attrOnlyUser.id, reason: 'Attribution-only' });
      assert.equal(attrTargetRes.status, 422);

      // Admin initial assignment by integer ID -> 200
      const assignRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: null, new_owner_user_id: salesA.user.id, reason: 'Assign by int ID' });
      assert.equal(assignRes.status, 200);
      assert.equal(assignRes.body.data.new_owner_user_id, salesA.user.id);
      assert.equal(assignRes.body.data.previous_owner_user_id, null);

      // Access verification: Sales A sees it, Sales B does not
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesA.cookie)).status, 200);
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesB.cookie)).status, 404);

      // Deactivate salesA to verify an existing inactive owner can be reassigned away
      await updateUser(salesA.user.id, { active: false }, db);

      // Admin reassignment by natural business key away from inactive owner -> 200
      const reassignRes = await request(app)
        .patch(`/api/${entity}/${encodeURIComponent(naturalKey)}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: salesA.user.id, new_owner_user_id: salesB.user.id, reason: 'Reassign natural away from inactive' });
      assert.equal(reassignRes.status, 200);
      assert.equal(reassignRes.body.data.new_owner_user_id, salesB.user.id);
      assert.equal(reassignRes.body.data.previous_owner_user_id, salesA.user.id);

      // Access inverted:
      // Deactivated Sales A has session revoked -> 401
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesA.cookie)).status, 401);
      // Active non-owner Sales C -> 404
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesC.cookie)).status, 404);
      // New owner Sales B -> 200
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesB.cookie)).status, 200);

      // Admin unassignment -> 200
      const unassignRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', admin.cookie)
        .send({ expected_owner_user_id: salesB.user.id, new_owner_user_id: null, reason: 'Unassign to pool' });
      assert.equal(unassignRes.status, 200);
      assert.equal(unassignRes.body.data.new_owner_user_id, null);
      assert.equal(unassignRes.body.data.previous_owner_user_id, salesB.user.id);

      // Unassigned record: Active Sales B and Sales C receive 404, Admin receives 200
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesB.cookie)).status, 404);
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', salesC.cookie)).status, 404);
      assert.equal((await request(app).get(`/api/${entity}/${rowId}`).set('Cookie', admin.cookie)).status, 200);

      // History query -> 200 with 3 entries
      const histRes = await request(app)
        .get(`/api/${entity}/${encodeURIComponent(naturalKey)}/ownership-history`)
        .set('Cookie', admin.cookie);
      assert.equal(histRes.status, 200);
      assert.equal(histRes.body.data.length, 3);

      // Generic CRUD cannot change owner_user_id
      const crudPatch = await request(app)
        .patch(`/api/${entity}/${rowId}`)
        .set('Cookie', admin.cookie)
        .send({ client_name: 'Updated Name', owner_user_id: salesC.user.id });
      assert.equal(crudPatch.status, 200);

      const checkDb = (await db.query(`SELECT owner_user_id FROM "${entity}" WHERE id = $1`, [rowId])).rows[0];
      assert.equal(checkDb.owner_user_id, null, 'Generic CRUD cannot mutate owner_user_id');
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Real Database Concurrency: Competing Reassignments
  // ---------------------------------------------------------------------------
  test('concurrency: real database competing reassignment race', async () => {
    await setUp();

    // Create quotation owned by Sales A
    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/201', 'Race Client', '2026-05-01', 'Submitted', $1) RETURNING id`,
      [salesA.user.id]
    );

    // Create two separate admin accounts
    const a1 = await createUser({ name: 'Admin One', email: 'admin1@example.com', password: PASSWORD, role: 'admin' }, db);
    const a2 = await createUser({ name: 'Admin Two', email: 'admin2@example.com', password: PASSWORD, role: 'admin' }, db);
    const c1 = await signIn(a1.email);
    const c2 = await signIn(a2.email);

    // Fire two competing requests simultaneously using Promise.all
    const [res1, res2] = await Promise.all([
      request(app)
        .patch(`/api/quotations/${q.id}/owner`)
        .set('Cookie', c1)
        .send({
          expected_owner_user_id: salesA.user.id,
          new_owner_user_id: salesB.user.id,
          reason: 'Admin 1 assigns Sales B',
        })
        .timeout(5000),
      request(app)
        .patch(`/api/quotations/${q.id}/owner`)
        .set('Cookie', c2)
        .send({
          expected_owner_user_id: salesA.user.id,
          new_owner_user_id: salesC.user.id,
          reason: 'Admin 2 assigns Sales C',
        })
        .timeout(5000),
    ]);

    const statuses = [res1.status, res2.status].sort();
    assert.deepEqual(statuses, [200, 409], 'Exactly one competitor must succeed and the other must get 409 Conflict');

    const winner = res1.status === 200 ? res1.body.data : res2.body.data;
    const expectedOwner = winner.new_owner_user_id;
    assert.ok(expectedOwner === salesB.user.id || expectedOwner === salesC.user.id);

    // Verify DB state matches the winner
    const qFinal = (await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [q.id])).rows[0];
    assert.equal(qFinal.owner_user_id, expectedOwner);

    // Exactly one history row created
    const hist = (await db.query('SELECT * FROM ownership_history WHERE entity_id = $1', [q.id])).rows;
    assert.equal(hist.length, 1);
    assert.equal(hist[0].new_owner_user_id, expectedOwner);

    // Exactly one activity row created
    const act = (await db.query(
      `SELECT * FROM activity_log WHERE entity_type = 'quotations' AND entity_id = $1`,
      [String(q.id)]
    )).rows;
    assert.equal(act.length, 1);
    assert.equal(act[0].action, 'ownership.reassigned');
  });

  // ---------------------------------------------------------------------------
  // 3. Concurrent Target-User Deactivation Ordering
  // ---------------------------------------------------------------------------
  test('concurrency: target-user deactivation ordering and state consistency', async () => {
    await setUp();

    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/301', 'Deact Client', '2026-05-01', 'Submitted', null) RETURNING id`
    );

    // Case A: Deactivation commits first -> assignment transaction must fail with 422
    const deactClient = await pool.connect();
    await deactClient.query('BEGIN');
    await deactClient.query('UPDATE users SET active = false WHERE id = $1', [salesB.user.id]);

    const blockedAssign = request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: null,
        new_owner_user_id: salesB.user.id,
        reason: 'Assignment to user being deactivated',
      })
      .timeout(5000);

    // Delay briefly to allow blockedAssign to await row lock on salesB
    await new Promise((r) => setTimeout(r, 60));

    await deactClient.query('COMMIT');
    deactClient.release();

    const assignRes = await blockedAssign;
    assert.equal(assignRes.status, 422);
    assert.match(assignRes.body.error.message, /inactive/i);

    // Case B: Assignment commits first -> deactivation commits afterwards
    // Target user (salesC) is active. Assign quotation to salesC.
    const assignC = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: null,
        new_owner_user_id: salesC.user.id,
        reason: 'Assignment before deactivation',
      });
    assert.equal(assignC.status, 200);

    // Sales C is deactivated afterwards
    await updateUser(salesC.user.id, { active: false }, db);

    // Record remains validly owned by inactive historical user
    const qCheck = (await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [q.id])).rows[0];
    assert.equal(qCheck.owner_user_id, salesC.user.id);

    // Admin can reassign away from the now-inactive user
    const reassignAway = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: salesC.user.id,
        new_owner_user_id: salesA.user.id,
        reason: 'Reassign away from inactive user',
      });
    assert.equal(reassignAway.status, 200);
    assert.equal(reassignAway.body.data.new_owner_user_id, salesA.user.id);
  });

  // ---------------------------------------------------------------------------
  // 4. Transaction Rollback Verification
  // ---------------------------------------------------------------------------
  test('atomicity: failure of ownership_history insertion rolls back record update', async () => {
    await setUp();

    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/401', 'Rollback Client 1', '2026-05-01', 'Submitted', null) RETURNING id`
    );

    // Trigger SIMULATE_HISTORY_FAIL via reason
    const failRes = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: null,
        new_owner_user_id: salesA.user.id,
        reason: 'SIMULATE_HISTORY_FAIL',
      });
    assert.equal(failRes.status, 500);

    // Record owner must be unchanged (NULL)
    const qCheck = (await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [q.id])).rows[0];
    assert.equal(qCheck.owner_user_id, null, 'Record update must be rolled back');

    // Zero history entries
    const hist = (await db.query('SELECT count(*)::int AS n FROM ownership_history WHERE entity_id = $1', [q.id])).rows[0];
    assert.equal(hist.n, 0);

    // Zero activity events
    const act = (await db.query('SELECT count(*)::int AS n FROM activity_log WHERE entity_id = $1', [String(q.id)])).rows[0];
    assert.equal(act.n, 0);
  });

  test('atomicity: failure of activity_log insertion rolls back record and history updates', async () => {
    await setUp();

    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/402', 'Rollback Client 2', '2026-05-01', 'Submitted', null) RETURNING id`
    );

    // Trigger SIMULATE_ACTIVITY_FAIL via reason
    const failRes = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: null,
        new_owner_user_id: salesA.user.id,
        reason: 'SIMULATE_ACTIVITY_FAIL',
      });
    assert.equal(failRes.status, 500);

    // Record owner must be unchanged (NULL)
    const qCheck = (await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [q.id])).rows[0];
    assert.equal(qCheck.owner_user_id, null, 'Record update must be rolled back');

    // Zero history entries
    const hist = (await db.query('SELECT count(*)::int AS n FROM ownership_history WHERE entity_id = $1', [q.id])).rows[0];
    assert.equal(hist.n, 0, 'History entry must be rolled back');

    // Zero activity events
    const act = (await db.query('SELECT count(*)::int AS n FROM activity_log WHERE entity_id = $1', [String(q.id)])).rows[0];
    assert.equal(act.n, 0);
  });

  // ---------------------------------------------------------------------------
  // 5. Expected-Owner Validation and No-Op Ordering
  // ---------------------------------------------------------------------------
  test('expected-owner validation strictly precedes no-op evaluation', async () => {
    await setUp();

    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/501', 'NoOp Client', '2026-05-01', 'Submitted', $1) RETURNING id`,
      [salesA.user.id]
    );

    // Case 1: Proposing current owner (salesA) with wrong expected owner (salesB) -> MUST RETURN 409 CONFLICT!
    const staleExpectedRes = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: salesB.user.id,
        new_owner_user_id: salesA.user.id,
        reason: 'Propose current with stale expected',
      });
    assert.equal(staleExpectedRes.status, 409);
    assert.match(staleExpectedRes.body.error.message, /Ownership conflict/i);

    // Case 2: Proposing current owner (salesA) with matching expected owner (salesA) -> 200 no-op
    const noOpRes = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: salesA.user.id,
        new_owner_user_id: salesA.user.id,
        reason: 'Propose current with correct expected',
      });
    assert.equal(noOpRes.status, 200);
    assert.equal(noOpRes.body.data.no_op, true);
    assert.equal(noOpRes.body.data.ownership_history_id, null);

    // Zero history and zero activity generated
    const hist = (await db.query('SELECT count(*)::int AS n FROM ownership_history WHERE entity_id = $1', [q.id])).rows[0];
    assert.equal(hist.n, 0);

    const act = (await db.query('SELECT count(*)::int AS n FROM activity_log WHERE entity_id = $1', [String(q.id)])).rows[0];
    assert.equal(act.n, 0);
  });

  // ---------------------------------------------------------------------------
  // 6. Historical Attribution Preservation & Deletion Safety
  // ---------------------------------------------------------------------------
  test('historical attribution survives user deletion and user deactivation', async () => {
    await setUp();

    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/601', 'Attribution History Corp', '2026-05-01', 'Submitted', null) RETURNING id`
    );

    // 1. Initial assignment to Sales A
    await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({ expected_owner_user_id: null, new_owner_user_id: salesA.user.id, reason: 'Stage 1 handover' });

    // 2. Reassignment to Sales B
    await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({ expected_owner_user_id: salesA.user.id, new_owner_user_id: salesB.user.id, reason: 'Stage 2 handover' });

    // 3. Delete Sales A from users
    const deletedId = salesA.user.id;
    await db.query('DELETE FROM users WHERE id = $1', [deletedId]);

    // 4. Deactivate Sales B
    await updateUser(salesB.user.id, { active: false }, db);

    // 5. Query history
    const histRes = await request(app)
      .get(`/api/quotations/${q.id}/ownership-history`)
      .set('Cookie', admin.cookie);
    assert.equal(histRes.status, 200);

    const entries = histRes.body.data;
    assert.equal(entries.length, 2);

    // Stage 2: prev is deleted Sales A, new is inactive Sales B
    const s2 = entries[0];
    assert.equal(s2.reason, 'Stage 2 handover');
    assert.equal(s2.previous_owner.id, deletedId);
    assert.equal(s2.previous_owner.name, 'Sam Sales');
    assert.equal(s2.previous_owner.deleted, true);

    assert.equal(s2.new_owner.id, salesB.user.id);
    assert.equal(s2.new_owner.name, 'Bea Sales');
    assert.equal(s2.new_owner.active, false);
    assert.equal(s2.new_owner.deleted, false);

    // Stage 1: prev is null, new is deleted Sales A
    const s1 = entries[1];
    assert.equal(s1.previous_owner, null);
    assert.equal(s1.new_owner.id, deletedId);
    assert.equal(s1.new_owner.name, 'Sam Sales');
    assert.equal(s1.new_owner.deleted, true);

    // Verify changed_by actor attribution
    assert.equal(s1.changed_by.id, admin.user.id);
    assert.equal(s1.changed_by.name, 'Alice Admin');
    assert.equal(s1.changed_by.actor_type, 'user');
    assert.equal(s1.changed_by.deleted, false);
  });

  // ---------------------------------------------------------------------------
  // 7. Visibility Shifts Across Lookups, Composites, Documents, and Children
  // ---------------------------------------------------------------------------
  test('visibility shifts across lists, details, composites, lookups, documents, and parent-derived POs', async () => {
    await setUp();

    // Create host company
    const { rows: [company] } = await db.query(
      `INSERT INTO companies (name) VALUES ('Composite Corp') RETURNING id`
    );

    // Create quotation owned by Sales A
    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, company_id, quotation_date, quotation_value, status, owner_user_id)
       VALUES ('CTZ/QT/2026/701', 'Composite Corp', $1, '2026-05-01', 50000, 'Submitted', $2) RETURNING id, quotation_no`,
      [company.id, salesA.user.id]
    );

    // Host project (unassigned) and PO fulfilling quotation
    await db.query(
      `INSERT INTO projects (project_id, client_name, company_id, owner_user_id)
       VALUES ('PRJ-PO-HOST-701', 'Composite Corp', $1, null)`,
      [company.id]
    );
    const { rows: [po] } = await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency)
       VALUES ('PO-701', 'PRJ-PO-HOST-701', 'CTZ/QT/2026/701', '2026-05-01', 50000, 'INR') RETURNING id, po_number`
    );

    // Host payment stage under PO
    const { rows: [stage] } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent)
       VALUES ('PO-701', 1, 'Advance Stage', 0.5) RETURNING id`
    );

    // Create attached document for quotation
    const { rows: [doc] } = await db.query(
      `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
       VALUES ('key-doc-701', 'quote.pdf', 'application/pdf', 100) RETURNING id`
    );
    await db.query('UPDATE quotations SET document_id = $1 WHERE id = $2', [doc.id, q.id]);

    // Initial state: Sales A has access, Sales B does not
    assert.equal((await request(app).get(`/api/quotations/${q.id}`).set('Cookie', salesA.cookie)).status, 200);
    assert.equal((await request(app).get(`/api/quotations/${q.id}`).set('Cookie', salesB.cookie)).status, 404);

    assert.equal((await request(app).get(`/api/purchase-orders/${po.id}`).set('Cookie', salesA.cookie)).status, 200);
    assert.equal((await request(app).get(`/api/purchase-orders/${po.id}`).set('Cookie', salesB.cookie)).status, 404);

    assert.equal((await request(app).get(`/api/payment-stages/${stage.id}`).set('Cookie', salesA.cookie)).status, 200);
    assert.equal((await request(app).get(`/api/payment-stages/${stage.id}`).set('Cookie', salesB.cookie)).status, 404);

    // Ordinary mutation authorization: Sales A can mutate, Sales B receives 404
    assert.equal(
      (await request(app).patch(`/api/quotations/${q.id}`).set('Cookie', salesA.cookie).send({ remarks: 'Sales A edit' })).status,
      200
    );
    assert.equal(
      (await request(app).patch(`/api/quotations/${q.id}`).set('Cookie', salesB.cookie).send({ remarks: 'Sales B unauthorized edit' })).status,
      404
    );

    // Document read authorization: 404 is refusal; non-404 means authorized through assertDocumentReadable
    assert.notEqual((await request(app).get(`/api/documents/${doc.id}`).set('Cookie', salesA.cookie)).status, 404);
    assert.equal((await request(app).get(`/api/documents/${doc.id}`).set('Cookie', salesB.cookie)).status, 404);

    // Company full composite embeds quotation for Sales A, excludes for Sales B
    const compA = (await request(app).get(`/api/companies/${company.id}/full`).set('Cookie', salesA.cookie)).body.data;
    assert.ok(compA.quotations.some((x) => x.id === q.id));

    const compB = (await request(app).get(`/api/companies/${company.id}/full`).set('Cookie', salesB.cookie)).body.data;
    assert.ok(!compB.quotations.some((x) => x.id === q.id));

    // Lookups offer quotation for Sales A, not for Sales B
    const lookupsA = (await request(app).get('/api/lookups').set('Cookie', salesA.cookie)).body.data;
    assert.ok(lookupsA.quotations.some((x) => x.quotation_no === q.quotation_no));

    const lookupsB = (await request(app).get('/api/lookups').set('Cookie', salesB.cookie)).body.data;
    assert.ok(!lookupsB.quotations.some((x) => x.quotation_no === q.quotation_no));

    // REASSIGN QUOTATION FROM SALES A TO SALES B
    const reassignRes = await request(app)
      .patch(`/api/quotations/${q.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: salesA.user.id,
        new_owner_user_id: salesB.user.id,
        reason: 'Full visibility transfer test',
      });
    assert.equal(reassignRes.status, 200);

    // Visibility inverted:
    // Sales A receives 404, Sales B receives 200
    assert.equal((await request(app).get(`/api/quotations/${q.id}`).set('Cookie', salesA.cookie)).status, 404);
    assert.equal((await request(app).get(`/api/quotations/${q.id}`).set('Cookie', salesB.cookie)).status, 200);

    // Derived PO inverted
    assert.equal((await request(app).get(`/api/purchase-orders/${po.id}`).set('Cookie', salesA.cookie)).status, 404);
    assert.equal((await request(app).get(`/api/purchase-orders/${po.id}`).set('Cookie', salesB.cookie)).status, 200);

    // Derived Payment Stage inverted
    assert.equal((await request(app).get(`/api/payment-stages/${stage.id}`).set('Cookie', salesA.cookie)).status, 404);
    assert.equal((await request(app).get(`/api/payment-stages/${stage.id}`).set('Cookie', salesB.cookie)).status, 200);

    // Ordinary mutation authorization inverted: Sales A receives 404, Sales B succeeds with 200
    assert.equal(
      (await request(app).patch(`/api/quotations/${q.id}`).set('Cookie', salesA.cookie).send({ remarks: 'Sales A forbidden edit' })).status,
      404
    );
    assert.equal(
      (await request(app).patch(`/api/quotations/${q.id}`).set('Cookie', salesB.cookie).send({ remarks: 'Sales B successful edit' })).status,
      200
    );

    // Derived Document inverted
    assert.equal((await request(app).get(`/api/documents/${doc.id}`).set('Cookie', salesA.cookie)).status, 404);
    assert.notEqual((await request(app).get(`/api/documents/${doc.id}`).set('Cookie', salesB.cookie)).status, 404);

    // Composite endpoint inverted
    const compAAfter = (await request(app).get(`/api/companies/${company.id}/full`).set('Cookie', salesA.cookie)).body.data;
    assert.ok(!compAAfter.quotations.some((x) => x.id === q.id));

    const compBAfter = (await request(app).get(`/api/companies/${company.id}/full`).set('Cookie', salesB.cookie)).body.data;
    assert.ok(compBAfter.quotations.some((x) => x.id === q.id));

    // Lookups inverted
    const lookupsAAfter = (await request(app).get('/api/lookups').set('Cookie', salesA.cookie)).body.data;
    assert.ok(!lookupsAAfter.quotations.some((x) => x.quotation_no === q.quotation_no));

    const lookupsBAfter = (await request(app).get('/api/lookups').set('Cookie', salesB.cookie)).body.data;
    assert.ok(lookupsBAfter.quotations.some((x) => x.quotation_no === q.quotation_no));
  });

  // ---------------------------------------------------------------------------
  // 8. Strict No-Cascade Guarantee Across Linked Records
  // ---------------------------------------------------------------------------
  test('no-cascade guarantee: linked pipeline records retain distinct owners', async () => {
    await setUp();

    // Create Enquiry owned by Sales A
    const { rows: [enq] } = await db.query(
      `INSERT INTO enquiries (enquiry_no, client_name, owner_user_id)
       VALUES ('CTZ/ENQ/2026/801', 'Multi-Owner Client', $1) RETURNING id`,
      [salesA.user.id]
    );

    // Linked Quotation owned by Sales B
    const { rows: [quot] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
       VALUES ('CTZ/QT/2026/801', 'Multi-Owner Client', '2026-05-01', 'Won - PO Received', $1) RETURNING id`,
      [salesB.user.id]
    );

    // Linked Project owned by Sales C
    const { rows: [prj] } = await db.query(
      `INSERT INTO projects (project_id, client_name, owner_user_id)
       VALUES ('PRJ-2026-801', 'Multi-Owner Client', $1) RETURNING id`,
      [salesC.user.id]
    );

    // Link quotation to project
    await db.query('UPDATE quotations SET project_id = $1 WHERE id = $2', ['PRJ-2026-801', quot.id]);
    // Link enquiry to quotation
    await db.query('UPDATE enquiries SET quotation_no = $1 WHERE id = $2', ['CTZ/QT/2026/801', enq.id]);

    // Reassign Quotation from Sales B to Sales A
    const reassignQuot = await request(app)
      .patch(`/api/quotations/${quot.id}/owner`)
      .set('Cookie', admin.cookie)
      .send({
        expected_owner_user_id: salesB.user.id,
        new_owner_user_id: salesA.user.id,
        reason: 'Reassign only the quotation',
      });
    assert.equal(reassignQuot.status, 200);

    // Verify Quotation owner is now Sales A
    const quotCheck = (await db.query('SELECT owner_user_id FROM quotations WHERE id = $1', [quot.id])).rows[0];
    assert.equal(quotCheck.owner_user_id, salesA.user.id);

    // Verify Enquiry owner is STILL Sales A (unchanged)
    const enqCheck = (await db.query('SELECT owner_user_id FROM enquiries WHERE id = $1', [enq.id])).rows[0];
    assert.equal(enqCheck.owner_user_id, salesA.user.id);

    // Verify Project owner is STILL Sales C (unchanged)
    const prjCheck = (await db.query('SELECT owner_user_id FROM projects WHERE id = $1', [prj.id])).rows[0];
    assert.equal(prjCheck.owner_user_id, salesC.user.id);
  });
});
