import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Administrative ownership assignment and history in shared mode (#18 Phase 3).
 *
 * Proves that the legacy shared administrator has full parity with database
 * administrators for assignment, reassignment, unassignment, and history reading
 * across all three core entities: enquiries, quotations, and projects.
 *
 * In shared mode:
 * - changed_by_user_id is NULL.
 * - changed_by_name is 'shared-admin'.
 * - actor_type is 'shared_admin'.
 * - Activity log records actor_type 'shared_admin' and metadata.actor_name.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const ENTITIES = ['enquiries', 'quotations', 'projects'];

describe('ownership assignment in shared mode', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let cookie;
  let salesA;
  let salesB;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `assign_shared_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'shared-admin';
    process.env.AUTH_PASSWORD = 'the-shared-password-in-env';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const signIn = await request(app)
      .post('/api/auth/login')
      .send({ username: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.equal(signIn.status, 200, 'the shared password signs in');
    cookie = signIn.headers['set-cookie'];

    // Seed sales users
    const { rows: [uA] } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ('Sales Alpha', 'alpha@example.com', 'x', 'sales', true) RETURNING id`
    );
    salesA = uA.id;

    const { rows: [uB] } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ('Sales Beta', 'beta@example.com', 'x', 'sales', true) RETURNING id`
    );
    salesB = uB.id;
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  for (const entity of ENTITIES) {
    test(`shared admin can assign, reassign, unassign and read history on ${entity}`, async () => {
      let rowId;
      if (entity === 'enquiries') {
        const { rows } = await db.query(
          `INSERT INTO enquiries (enquiry_no, client_name, owner_user_id)
           VALUES ('CTZ/ENQ/2026/S01', 'Shared Client', null) RETURNING id`
        );
        rowId = rows[0].id;
      } else if (entity === 'quotations') {
        const { rows } = await db.query(
          `INSERT INTO quotations (quotation_no, client_name, quotation_date, status, owner_user_id)
           VALUES ('CTZ/QT/2026/S01', 'Shared Client', '2026-05-01', 'Submitted', null) RETURNING id`
        );
        rowId = rows[0].id;
      } else {
        const { rows } = await db.query(
          `INSERT INTO projects (project_id, client_name, owner_user_id)
           VALUES ('PRJ-2026-S01', 'Shared Client', null) RETURNING id`
        );
        rowId = rows[0].id;
      }

      // 1. Initial assignment
      const assignRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', cookie)
        .send({
          expected_owner_user_id: null,
          new_owner_user_id: salesA,
          reason: `Shared admin initial assign on ${entity}`,
        });
      assert.equal(assignRes.status, 200);
      assert.equal(assignRes.body.data.new_owner_user_id, salesA);
      assert.equal(assignRes.body.data.previous_owner_user_id, null);

      // 2. Reassignment
      const reassignRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', cookie)
        .send({
          expected_owner_user_id: salesA,
          new_owner_user_id: salesB,
          reason: `Shared admin reassign on ${entity}`,
        });
      assert.equal(reassignRes.status, 200);
      assert.equal(reassignRes.body.data.new_owner_user_id, salesB);
      assert.equal(reassignRes.body.data.previous_owner_user_id, salesA);

      // 3. Unassignment
      const unassignRes = await request(app)
        .patch(`/api/${entity}/${rowId}/owner`)
        .set('Cookie', cookie)
        .send({
          expected_owner_user_id: salesB,
          new_owner_user_id: null,
          reason: `Shared admin unassign on ${entity}`,
        });
      assert.equal(unassignRes.status, 200);
      assert.equal(unassignRes.body.data.new_owner_user_id, null);
      assert.equal(unassignRes.body.data.previous_owner_user_id, salesB);

      // 4. Read history
      const historyRes = await request(app)
        .get(`/api/${entity}/${rowId}/ownership-history`)
        .set('Cookie', cookie);
      assert.equal(historyRes.status, 200);

      const entries = historyRes.body.data;
      assert.equal(entries.length, 3);

      // Latest entry (unassignment) attribution
      const latest = entries[0];
      assert.equal(latest.reason, `Shared admin unassign on ${entity}`);
      assert.equal(latest.changed_by.actor_type, 'shared_admin');
      assert.equal(latest.changed_by.id, null);
      assert.equal(latest.changed_by.name, 'shared-admin');
      assert.equal(latest.changed_by.deleted, false);

      // Verify activity_log entries
      const actRows = (await db.query(
        `SELECT actor_type, actor_user_id, action, metadata FROM activity_log
         WHERE entity_type = $1 AND entity_id = $2
         ORDER BY id ASC`,
        [entity, String(rowId)]
      )).rows;
      assert.equal(actRows.length, 3);
      assert.equal(actRows[0].action, 'ownership.assigned');
      assert.equal(actRows[0].actor_type, 'shared_admin');
      assert.equal(actRows[0].actor_user_id, null);
      assert.equal(actRows[0].metadata.actor_name, 'shared-admin');
      assert.equal(actRows[1].action, 'ownership.reassigned');
      assert.equal(actRows[2].action, 'ownership.unassigned');
    });
  }
});
