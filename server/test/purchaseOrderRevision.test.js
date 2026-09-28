import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * A revised or cancelled purchase order, saved through the API the PO forms
 * use. The fields only take a PO out of the sales figures, so the thing to
 * prove here is that they save, are checked, and never get in the way of an
 * ordinary edit.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('revised and cancelled purchase orders', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let dbName;
  let agent;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `po_revision_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
    await db.query(`INSERT INTO projects (project_id, client_name) VALUES ('P-1', 'Acme'), ('P-2', 'Beta')`);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    const { default: app } = await import('../src/app.js');
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

  const create = (body) => agent.post('/api/purchase-orders').send({ project_id: 'P-1', po_value: 100, ...body });

  test('a new PO is not cancelled and replaces nothing unless told', async () => {
    const { body } = await create({ po_number: 'PO-441', po_date: '2026-04-10' }).expect(201);
    assert.deepEqual([body.data.cancelled, body.data.replaces_po_number, body.data.replaced_by_po_number], [false, null, null]);
  });

  test('a revision names the PO it replaces, and both sides show it', async () => {
    const { body } = await create({ po_number: 'PO-441-R1', po_date: '2026-05-10', replaces_po_number: 'PO-441', cancelled: 'false' }).expect(201);
    assert.equal(body.data.replaces_po_number, 'PO-441');
    const { body: old } = await agent.get('/api/purchase-orders/PO-441').expect(200);
    assert.equal(old.data.replaced_by_po_number, 'PO-441-R1');
  });

  test('a bad link is a field error, not a crash', async () => {
    const field = async (body) => (await create(body).expect(422)).body.error.fields.replaces_po_number;
    assert.match(await field({ po_number: 'PO-A', replaces_po_number: 'PO-441' }), /already replaced by another revision/);
    assert.match(await field({ po_number: 'PO-B', project_id: 'P-2', replaces_po_number: 'PO-441-R1' }), /is on project P-1/);
    assert.match(await field({ po_number: 'PO-C', replaces_po_number: 'PO-C' }), /cannot replace itself/);
  });

  test('cancelling is a tick, and an unrelated edit leaves it alone', async () => {
    await create({ po_number: 'PO-X' }).expect(201);
    const { body: cancelled } = await agent.patch('/api/purchase-orders/PO-X').send({ cancelled: 'true' }).expect(200);
    assert.equal(cancelled.data.cancelled, true);
    // An edit that does not send the field (a delivery date, a remark) must not un-cancel it.
    const { body: edited } = await agent.patch('/api/purchase-orders/PO-X').send({ remarks: 'Client withdrew' }).expect(200);
    assert.equal(edited.data.cancelled, true);
    // And it can be undone.
    const { body: restored } = await agent.patch('/api/purchase-orders/PO-X').send({ cancelled: 'false' }).expect(200);
    assert.equal(restored.data.cancelled, false);
  });
});
