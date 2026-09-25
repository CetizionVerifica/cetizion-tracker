import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import XLSX from 'xlsx';

/**
 * Bulk import of a sheet laid out the way the management MIS workbook is
 * (#45), through the real routes on a real database: upload, read the
 * stages, change one reading, commit, and check what was written.
 *
 * The workbook is built here; no client file is used. The AI is off, so
 * nothing leaves the machine and the plan is the rules' alone.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

const book = (sheets) => {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa, formats] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    for (const [ref, z] of Object.entries(formats || {})) ws[ref].z = z;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

// A summary tab first, then the register the import should read.
const MIS = () => book([
  ['Dashboard', [['CETIZION – Sales MIS'], ['Deal Stage', '# Deals', 'PO Value (₹ L)'], ['4. Won – PO Received', 2, 9.1]]],
  ['Deal Register', [
    ['Deal Register – one row per deal'],
    ['Deal ID', 'Client', 'Client Contact', 'Service / Proposal', 'Sales Person', 'Deal Stage', 'Status Detail', 'Currency',
      'Proposal Date', 'Quoted Value', 'PO / WO No.', 'PO Date / Received', 'PO Value', 'PO (INR eq.)', 'Remarks / Source'],
    ['CV-001', 'Suite Aster', 'Asha', 'ASI Surveillance Audit', 'Priya', '4. Won – PO Received', 'PO received', 'USD',
      '25-Aug-2026', null, '4501234567 (dtd 22.09.2026)', null, 8111, 713768, 'PO by email'],
    ['CV-002', 'Suite Birch', 'Kiran', 'UL 2799 readiness', 'Priya', '4. Won – PO Received', 'PO received – 50% advance invoiced', 'INR',
      'On/before 16-Sep-2026', null, '5000123456', '22-Sep-2026', 196000, 196000, null],
    ['CV-003', 'Suite Cedar', 'Neha', 'EcoVadis Consultancy', 'Priya', '3. Negotiation / PO Awaited', 'Won – confirmed by email (PO awaited)', 'INR',
      '23-Sep-2026', 2000000, null, null, null, 0, null],
    ['CV-004', 'Suite Dahlia', 'Lena', 'GHG verification', 'Arjun', '5. Lost', 'Lost on price', 'CAD',
      '01-Sep-2026', 6900, null, null, null, 0, null],
    ['CV-005', 'Suite Prospect', 'Ravi', 'LCA', 'Arjun', '1. Lead / Enquiry', 'Intro call', 'INR', null, null, null, null, null, 0, null],
    ['CV-006', 'Suite Recurring', 'Meena', 'Assurance', 'Arjun', 'Recurring engagement', null, 'INR', '10-Sep-2026', 450000, null, null, null, 0, null],
  ], { M3: '"USD "#,##0', M4: '"₹ "#,##0', J5: '"₹ "#,##0', J6: '"CAD "#,##0', J8: '"₹ "#,##0' }],
]);

describe('bulk import of any reasonable sales sheet', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `import_any_sheet_${process.pid}_${Date.now()}`;
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
    // Set, not deleted: dotenv would fill a deleted key in again from .env.
    process.env.OPENROUTER_API_KEY = '';

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

  let batchId;

  test('the register tab is read, not the summary before it, and every stage wording is shown', async () => {
    const res = await agent.post('/api/import/batches').attach('file', MIS(), 'mis.xlsx').expect(201);
    const batch = res.body.data;
    batchId = batch.id;
    assert.equal(batch.sheet_name, 'Deal Register');
    assert.equal(batch.ai_model, 'no AI key: rules only');
    assert.equal(batch.mapping.mapping.po_number, 'PO / WO No.');
    assert.equal(Object.values(batch.mapping.mapping).includes('PO (INR eq.)'), false);

    const readings = Object.fromEntries(batch.summary.stage_values.map((v) => [v.value, v.reading]));
    assert.deepEqual(readings, {
      '4. Won – PO Received': 'Won - PO Received',
      '3. Negotiation / PO Awaited': 'Under Negotiation',
      '5. Lost': 'Lost',
      '1. Lead / Enquiry': 'lead',
      'Recurring engagement': 'unknown',
    });
    const reasons = Object.fromEntries(batch.summary.skipped_rows.map((s) => [s.client, s.reason]));
    assert.deepEqual(reasons, {
      'Suite Prospect': 'early lead, no proposal yet — add it as an enquiry',
      'Suite Recurring': 'unrecognised deal stage',
    });

    const q = Object.fromEntries(batch.items.filter((i) => i.step === 'quotation').map((i) => [i.payload.client_name, i]));
    assert.deepEqual([q['Suite Aster'].payload.currency, q['Suite Aster'].payload.quotation_value], ['USD', 8111]);
    assert.equal(q['Suite Birch'].payload.quotation_date, '2026-09-16');
    // A currency the tracker does not keep is an error to fix, never silently rupees.
    assert.ok(q['Suite Dahlia'].flags.some((f) => f.level === 'error' && /currency/.test(f.message)));
    assert.match(q['Suite Cedar'].payload.remarks, /Status: Won – confirmed by email/);

    const po = Object.fromEntries(batch.items.filter((i) => i.step === 'purchase_order').map((i) => [i.payload.po_number, i]));
    assert.deepEqual(Object.keys(po).sort(), ['4501234567', '5000123456']);
    assert.equal(po['4501234567'].payload.po_date, '2026-09-22');
    assert.equal(po['4501234567'].payload.currency, 'USD');
    assert.match(po['4501234567'].assumptions.join(' '), /taken from the note on the PO number/);
    assert.equal(po['5000123456'].payload.po_date, '2026-09-22');
  });

  test('a stage wording read differently by the reviewer brings its row in', async () => {
    const res = await agent.post(`/api/import/batches/${batchId}/replan`)
      .send({ rules: { stage_map: { 'recurring engagement': 'Under Negotiation' } } })
      .expect(200);
    const batch = res.body.data;
    const recurring = batch.items.find((i) => i.step === 'quotation' && i.payload.client_name === 'Suite Recurring');
    assert.equal(recurring.payload.status, 'Under Negotiation');
    assert.ok(recurring.flags.some((f) => f.code === 'stage_read_as' && /your reading/.test(f.message)));
    assert.equal(batch.summary.stage_values.find((v) => v.value === 'Recurring engagement').by, 'admin');
    assert.deepEqual(batch.summary.skipped_rows.map((s) => s.client), ['Suite Prospect']);
  });

  test('the commit writes what the review showed', async () => {
    let batch = (await agent.get(`/api/import/batches/${batchId}`).expect(200)).body.data;
    // The CAD quotation is in error: the reviewer unticks it, as the review asks.
    const cad = batch.items.find((i) => i.step === 'quotation' && i.payload.client_name === 'Suite Dahlia');
    await agent.patch(`/api/import/items/${cad.id}`).send({ included: false }).expect(200);
    batch = (await agent.post(`/api/import/batches/${batchId}/commit`).expect(200)).body.data;
    assert.equal(batch.status, 'committed');

    const { rows: quotes } = await db.query(`SELECT client_name, status, currency, quotation_value::float AS value, quotation_date::text AS date FROM quotations ORDER BY client_name`);
    assert.deepEqual(quotes.map((q) => [q.client_name, q.status, q.currency]), [
      ['Suite Aster', 'Won - PO Received', 'USD'],
      ['Suite Birch', 'Won - PO Received', 'INR'],
      ['Suite Cedar', 'Under Negotiation', 'INR'],
      ['Suite Recurring', 'Under Negotiation', 'INR'],
    ]);
    const { rows: pos } = await db.query(`SELECT po_number, po_date::text AS po_date, po_value::float AS value, currency FROM purchase_orders ORDER BY po_number`);
    assert.deepEqual(pos, [
      { po_number: '4501234567', po_date: '2026-09-22', value: 8111, currency: 'USD' },
      { po_number: '5000123456', po_date: '2026-09-22', value: 196000, currency: 'INR' },
    ]);
  });

  test('a project status report is refused with a reason, not turned into invented deals', async () => {
    const report = book([['Current Projects', [
      ['Target Projects for 2026', null, null, 25, 'Completed Projects for 2026', 7],
      ['S.No', 'Project ID', 'Client Name', 'Scope of Work', 'Progress', 'Project Manager', 'Target date', 'Status', 'Remarks', 'User ID', 'Password'],
      [1, 'CV2026-001', 'Suite Sai', 'Ecovadis', '100%', 'Raj', '31-Mar-26', 'Completed', null, 'sai-portal', 'secret-pw'],
    ]]]);
    const res = await agent.post('/api/import/batches').attach('file', report, 'projects.xlsx').expect(422);
    assert.match(res.body.error?.message || res.body.message || JSON.stringify(res.body), /does not look like a sales sheet/);
    assert.equal(JSON.stringify(res.body).includes('secret-pw'), false);
    const { rows } = await db.query(`SELECT status, error FROM import_batches WHERE filename = 'projects.xlsx'`);
    assert.equal(rows[0].status, 'failed');
    assert.doesNotMatch(rows[0].error, /Password|User ID/);
  });
});
