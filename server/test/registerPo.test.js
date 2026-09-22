import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Registering a PO from a quotation (#26), at the request level.
 *
 * The one the review caught: a PO value includes GST and a quotation line
 * does not, so scaling the lines by the PO against the quotation total left
 * every service line short by exactly the tax, while the form told users the
 * lines add up to the PO. These assert the arithmetic on a real database.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('registering a purchase order from a quotation', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `register_suite_${process.pid}_${Date.now()}`;
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

  /** A quotation with priced lines, ready to register. */
  async function quotationWith(lines) {
    const created = await agent.post('/api/quotations')
      .send({ client_name: `Register test ${Date.now()}${Math.random()}`, service_quoted: 'Audit', quotation_date: '2026-09-21' })
      .expect(201);
    const { id, quotation_no: quotationNo } = created.body.data;
    for (const l of lines) {
      await agent.post('/api/quotation-lines')
        .send({ quotation_id: id, description: l.description, qty: 1, rate: l.rate, gst_rate: l.gst_rate })
        .expect(201);
    }
    const { body } = await agent.get(`/api/quotations/${encodeURIComponent(quotationNo)}`).expect(200);
    return body.data;
  }

  const sum = (rows) => Math.round(rows.reduce((n, r) => n + Number(r.service_value), 0) * 100) / 100;

  test('the service lines add up to the PO value, not to the PO less the GST', async () => {
    const q = await quotationWith([
      { description: 'EcoVadis', rate: 100000, gst_rate: 18 },
      { description: 'ISO 14001', rate: 50000, gst_rate: 18 },
    ]);
    // 150,000 of work, 27,000 of GST, and the client sends a PO for the lot.
    assert.equal(Number(q.total), 177000);

    const poNumber = `REG-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: 177000, project: { client_name: q.client_name } })
      .expect(201);

    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    assert.equal(sum(body.data.services), 177000, 'the lines are what the PO is for, GST included');
  });

  test('a negotiated PO scales every line down, and still adds up', async () => {
    const q = await quotationWith([
      { description: 'EcoVadis', rate: 100000, gst_rate: 18 },
      { description: 'ISO 14001', rate: 50000, gst_rate: 18 },
    ]);
    const poNumber = `REG-CUT-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: 141600, project: { client_name: q.client_name } })
      .expect(201);

    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    assert.equal(sum(body.data.services), 141600);
    // 80% of the PO, so 80% of each line: the proportions survive.
    const byName = Object.fromEntries(body.data.services.map((s) => [s.service, Number(s.service_value)]));
    assert.equal(byName.EcoVadis, 94400);
    assert.equal(byName['ISO 14001'], 47200);
  });

  test('lines at different GST rates each keep their own, and the total is exact', async () => {
    const q = await quotationWith([
      { description: 'Audit', rate: 100000, gst_rate: 18 },
      { description: 'Reimbursables', rate: 10000, gst_rate: 5 },
    ]);
    const poValue = Math.round(Number(q.total) * 100) / 100;
    const poNumber = `REG-MIX-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: poValue, project: { client_name: q.client_name } })
      .expect(201);

    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    assert.equal(sum(body.data.services), poValue, 'a rounding paisa never leaves a gap');
    const byName = Object.fromEntries(body.data.services.map((s) => [s.service, Number(s.service_value)]));
    assert.equal(byName.Audit, 118000, '100,000 at 18%');
    assert.equal(byName.Reimbursables, 10500, '10,000 at 5%, not at 18%');
  });
});
