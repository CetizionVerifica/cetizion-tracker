import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * Two findings from the review of batch 5 (#61) that only show against a
 * real database: a PATCH to a path that is not a number created a visit
 * and fired a webhook for it, and GSTR-1 reported a mixed-rate invoice at
 * the weighted average of its rates.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('visits, and the GST sheet', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `batch5_suite_${process.pid}_${Date.now()}`;
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

  test('a PATCH to a visit that is not a number is not found, and creates nothing', async () => {
    const before = Number((await db.query('SELECT COUNT(*)::int AS n FROM visits')).rows[0].n);
    for (const bad of ['abc', 'undefined', 'NaN', '1.5', '-3', '0']) {
      const res = await agent.patch(`/api/visits/${bad}`).send({ status: 'confirmed' });
      assert.equal(res.status, 404, `PATCH /api/visits/${bad} should be a 404, got ${res.status}`);
    }
    const after = Number((await db.query('SELECT COUNT(*)::int AS n FROM visits')).rows[0].n);
    assert.equal(after, before, 'nothing was created, so no visit.scheduled was fired either');
    const { rows: events } = await db.query(`SELECT 1 FROM webhook_events WHERE event = 'visit.scheduled'`);
    assert.equal(events.length, 0);
  });

  test('a GET and a DELETE on the same path answer the same way', async () => {
    await agent.get('/api/visits/abc').expect(404);
    await agent.delete('/api/visits/abc').expect(404);
  });

  test('GSTR-1 gives each GST rate its own line, sharing the invoice', async () => {
    const gstin = '27AAPFU0939F1ZV';
    const { rows: [company] } = await db.query(`INSERT INTO companies (name, gstin) VALUES ('Mixed Rate Metals', $1) RETURNING id`, [gstin]);

    const { body: q } = await agent.post('/api/quotations')
      .send({ client_name: 'Mixed Rate Metals', service_quoted: 'Audit', quotation_date: '2026-09-22', place_of_supply_state: '27-Maharashtra' })
      .expect(201);
    for (const line of [{ description: 'Audit', rate: 100000, gst_rate: 18 }, { description: 'Reimbursables', rate: 10000, gst_rate: 5 }]) {
      await agent.post('/api/quotation-lines').send({ quotation_id: q.data.id, qty: 1, ...line }).expect(201);
    }
    const poNumber = `GST-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.data.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-22', po_value: 128500, project: { client_name: 'Mixed Rate Metals', company_id: company.id } })
      .expect(201);

    // An invoiced stage for half the PO. The amount is never stored — the
    // view works it out from the stage's share — so the test reads it back
    // rather than asserting a number of its own.
    await db.query(
      `UPDATE payment_stages SET invoice_no = 'INV-MIX-1', invoice_date = '2026-09-22'
        WHERE po_number = $1 AND id = (SELECT MIN(id) FROM payment_stages WHERE po_number = $1)`, [poNumber]);
    await db.query('UPDATE projects SET company_id = $2 WHERE project_id = (SELECT project_id FROM purchase_orders WHERE po_number = $1)', [poNumber, company.id]);
    const { rows: [stage] } = await db.query(`SELECT stage_amount FROM v_payment_stages WHERE invoice_no = 'INV-MIX-1'`);
    assert.ok(Number(stage.stage_amount) > 0, 'the fixture has an invoice worth reporting');

    const csv = await agent.get('/api/accounting/reports/gstr1-b2b.csv?from=2026-09-01&to=2026-09-30').expect(200);
    const lines = csv.text.trim().split('\n').slice(1).filter((l) => l.includes('INV-MIX-1'));
    assert.equal(lines.length, 2, `one line per rate, got:\n${csv.text}`);

    const rates = lines.map((l) => l.split(',').slice(-3, -2)[0]).sort();
    assert.deepEqual(rates, ['18', '5'].sort(), 'the rates are the quotation’s own, not an average of them');
    const taxable = lines.map((l) => Number(l.split(',').slice(-2, -1)[0])).reduce((a, b) => a + b, 0);
    assert.equal(Math.round(taxable * 100) / 100, Number(stage.stage_amount), 'and together they are the invoice, to the paisa');
    // The average of 18 and 5 weighted by those lines is 16.82, which is
    // what this used to report and what the GST tool rejects.
    assert.ok(!lines.some((l) => /,16\.82,/.test(l)), 'no line carries a rate that does not exist');
  });
});
