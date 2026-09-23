import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * A real quotation reporting its own GST split (#23).
 *
 * Nothing from the application is imported at the top of this file: doing
 * that connects the shared pool to whatever DATABASE_URL happens to be set,
 * and this suite builds its own database.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('a real quotation reports its own split', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `qgst_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

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

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    // We are registered in Maharashtra (27).
    await db.query(`UPDATE settings SET value = '27' WHERE key = 'company_state_code'`);
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

  /**
   * A quotation for a client in one state, with two GST rates on it.
   *
   * The company is made by the link trigger from the client name, so the
   * GSTIN goes on afterwards — which is also how it happens in life: the
   * company appears with the first quotation and accounts fill the GSTIN in
   * later.
   */
  async function quotationFor(gstin, name) {
    const { body } = await agent.post('/api/quotations')
      .send({ client_name: name, service_quoted: 'Audit', quotation_date: '2026-09-23' })
      .expect(201);
    if (gstin) {
      const { rowCount } = await db.query('UPDATE companies SET gstin = $2 WHERE id = (SELECT company_id FROM quotations WHERE id = $1)', [body.data.id, gstin]);
      assert.equal(rowCount, 1, 'the fixture must reach the same database the app writes to');
    }
    for (const l of [{ description: 'Audit', rate: 100000, gst_rate: 18 }, { description: 'Reimbursables', rate: 10000, gst_rate: 5 }]) {
      await agent.post('/api/quotation-lines').send({ quotation_id: body.data.id, qty: 1, ...l }).expect(201);
    }
    const { body: full } = await agent.get(`/api/quotations/${encodeURIComponent(body.data.quotation_no)}/full`).expect(200);
    return full.data;
  }

  test('a Maharashtra client is CGST and SGST', async () => {
    // 27 = Maharashtra, the state we are registered in.
    const q = await quotationFor('27AAPFU0939F1ZV', `Maharashtra Metals ${Date.now()}`);
    assert.equal(q.gst.intra, true, JSON.stringify(q.gst));
    assert.equal(q.gst.cgst, 9250);
    assert.equal(q.gst.sgst, 9250);
    assert.equal(q.gst.igst, 0);
    assert.equal(Number(q.tax_total), q.gst.tax_total, 'the split adds up to the figure already stored');
    assert.deepEqual(q.gst.problems, []);
  });

  test('a client in another state is IGST', async () => {
    // 29 = Karnataka.
    const q = await quotationFor('29AAPFU0939F1ZP', `Karnataka Castings ${Date.now()}`);
    assert.equal(q.gst.intra, false, JSON.stringify(q.gst));
    assert.equal(q.gst.igst, 18500);
    assert.equal(q.gst.cgst + q.gst.sgst, 0);
    assert.equal(Number(q.tax_total), q.gst.tax_total);
  });

  test('with no GSTIN, the place of supply typed on the quotation decides it', async () => {
    const q = await quotationFor(null, `No GSTIN Ltd ${Date.now()}`);
    assert.match(q.gst.problems.join(' '), /place of supply/i, 'and it says so while there is neither');

    await db.query(`UPDATE quotations SET place_of_supply_state = '27-Maharashtra' WHERE id = $1`, [q.id]);
    const { body } = await agent.get(`/api/quotations/${encodeURIComponent(q.quotation_no)}/full`).expect(200);
    assert.equal(body.data.gst.intra, true);
    assert.equal(body.data.gst.cgst, 9250);
    assert.deepEqual(body.data.gst.problems, []);
  });
});
