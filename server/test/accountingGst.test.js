import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * GST in the accounting module (#48) against the rest of the tracker.
 *
 * A PO's value, and so every stage amount, is a total INCLUDING GST: it is
 * the quotation's total, grossed up at the quotation's own rates (views.sql,
 * po_gst_split). The accounting module used to read the stage amount as the
 * taxable value and add GST on top, so a ₹1,18,000 invoice became ₹1,39,240
 * on the Zoho/Tally draft and in GSTR-1, and every correct invoice in the
 * books showed as "amount differs". These cases pin the split instead:
 * taxable + GST = the stage amount, to the paisa, at the quotation's rates.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const GSTIN = '27AAPFU0939F1ZV'; // a published sample GSTIN, Maharashtra

describe('GST in accounting', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let cookie;
  const today = new Date().toISOString().slice(0, 10);
  const stage = {};

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `accgst_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const u = new URL(ADMIN_URL); u.pathname = `/${name}`; dbUrl = u.toString();

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
    process.env.AUTH_USERNAME = 'tester';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.CLOUDINARY_CLOUD_NAME = '';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const res = await request(app).post('/api/auth/login').send({ username: 'tester', password: 'a-good-long-test-password' });
    cookie = res.headers['set-cookie'];

    // We are in Maharashtra too, so an Indian sale here is intra-state.
    await db.query(`INSERT INTO settings (key, value) VALUES ('company_state_code', '27')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const { rows: [co] } = await db.query(`INSERT INTO companies (name, gstin) VALUES ('Acme Industries', $1) RETURNING id`, [GSTIN]);

    // One PO per case: its quotation's lines, its value as registration sets it (the quotation total).
    const cases = [
      { key: 'single', currency: 'INR', lines: [[100000, 18]], value: 118000 },
      { key: 'mixed', currency: 'INR', lines: [[100000, 18], [10000, 5]], value: 128500 },
      { key: 'export', currency: 'USD', lines: [[10000, 0]], value: 10000 },
      // A PO that names no quotation: its project's won quotation decides, as on the portal.
      { key: 'fallback', currency: 'INR', lines: [[100000, 5]], value: 105000, poNamesQuotation: false },
      // A quotation with no lines: the default rate, flagged as an estimate.
      { key: 'estimated', currency: 'INR', lines: [], value: 11800 },
    ];
    for (const [i, c] of cases.entries()) {
      const n = i + 1;
      await db.query(`INSERT INTO projects (project_id, client_name, company_id) VALUES ($1, 'Acme Industries', $2)`, [`PRJ-${n}`, co.id]);
      const { rows: [q] } = await db.query(
        `INSERT INTO quotations (quotation_no, client_name, company_id, quotation_date, status, currency, project_id)
         VALUES ($1, 'Acme Industries', $2, $3, 'Won - PO Received', $4, $5) RETURNING id`, [`QT-${n}`, co.id, today, c.currency, `PRJ-${n}`]);
      for (const [rate, gst] of c.lines) {
        await db.query(`INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate) VALUES ($1, 'Service', 1, $2, $3)`, [q.id, rate, gst]);
      }
      await db.query(
        `INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency)
         VALUES ($1, $2, $3, $4, $5, $6)`, [`PO-${n}`, `PRJ-${n}`, c.poNamesQuotation === false ? null : `QT-${n}`, today, c.value, c.currency]);
      const { rows: [s] } = await db.query(
        `INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date)
         VALUES ($1, 1, 'Full', 1, $2, $3) RETURNING id`, [`PO-${n}`, `INV-${n}`, today]);
      stage[c.key] = s.id;
    }
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const draft = async (id) => (await request(app).get(`/api/accounting/stages/${id}/draft`).set('Cookie', cookie)).body.data;
  const sum = (...xs) => Math.round(xs.reduce((a, b) => a + Number(b), 0) * 100) / 100;

  test('the invoice draft takes GST out of the stage amount instead of adding it', async () => {
    const d = await draft(stage.single);
    assert.equal(d.total, 118000, 'the invoice total is the stage amount');
    assert.equal(d.taxable, 100000);
    assert.equal(d.tax, 18000);
    assert.equal(d.gst_rate, 18);
    assert.deepEqual([d.cgst, d.sgst, d.igst, d.intra], [9000, 9000, 0, true]);
  });

  test('a mixed-rate draft still adds up to the stage amount exactly', async () => {
    const d = await draft(stage.mixed);
    assert.equal(d.total, 128500);
    assert.equal(sum(d.taxable, d.tax), 128500, 'taxable + GST = total, to the paisa');
    assert.equal(sum(d.cgst, d.sgst, d.igst), d.tax);
    assert.equal(d.gst_rate, null, 'no average rate: 16.82% is not a rate an invoice may carry');
    assert.deepEqual(d.parts.map((p) => [p.rate, p.taxable, p.gst]), [[18, 100000, 18000], [5, 10000, 500]]);
  });

  test('a PO naming no quotation takes its project\'s won quotation, as the portal does', async () => {
    const d = await draft(stage.fallback);
    assert.deepEqual([d.taxable, d.tax, d.gst_rate], [100000, 5000, 5]);
  });

  test('with no quotation lines the default rate is used, and the draft says so', async () => {
    const d = await draft(stage.estimated);
    assert.deepEqual([d.taxable, d.tax, d.gst_rate], [10000, 1800, 18]);
    assert.ok(d.problems.some((p) => /no lines/.test(p)), JSON.stringify(d.problems));
  });

  test('the draft, GSTR-1 and the client portal agree to the paisa', async () => {
    for (const [key, po] of [['single', 'PO-1'], ['mixed', 'PO-2'], ['fallback', 'PO-4'], ['estimated', 'PO-5']]) {
      const d = await draft(stage[key]);
      const { rows: [portal] } = await db.query('SELECT taxable, gst FROM po_gst_split($1, $2)', [po, d.total]);
      assert.deepEqual([Number(portal.taxable), Number(portal.gst)], [d.taxable, d.tax], `${key}: portal and draft`);
    }
  });

  test('an export draft carries no GST', async () => {
    const d = await draft(stage.export);
    assert.equal(d.total, 10000);
    assert.equal(d.taxable, 10000);
    assert.equal(d.tax, 0);
  });

  test('the Tally voucher built from a draft balances', async () => {
    const { tallyVoucherXml } = await import('../src/lib/accounting/providers.js');
    const d = await draft(stage.single);
    const xml = tallyVoucherXml(d, { date: today });
    const amounts = [...xml.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    assert.equal(Math.round(amounts.reduce((a, b) => a + b, 0) * 100), 0, 'debits and credits net to zero');
  });

  test('GSTR-1 reports the taxable value and the invoice value the client was billed', async () => {
    const res = await request(app).get(`/api/accounting/reports/gstr1-b2b.csv?from=${today}&to=${today}`).set('Cookie', cookie);
    assert.equal(res.status, 200);
    const rows = res.text.replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
    const of = (inv) => rows.filter((r) => r[2] === inv).map((r) => ({ value: Number(r[4]), rate: Number(r[10]), taxable: Number(r[11]) }));

    assert.deepEqual(of('INV-1'), [{ value: 118000, rate: 18, taxable: 100000 }]);
    // Two lines, one per rate, sharing the one invoice value.
    assert.deepEqual(of('INV-2'), [{ value: 128500, rate: 18, taxable: 100000 }, { value: 128500, rate: 5, taxable: 10000 }]);
    assert.equal(of('INV-3').length, 0, 'an export is not a B2B line');
    assert.deepEqual(of('INV-4'), [{ value: 105000, rate: 5, taxable: 100000 }], 'the project\'s quotation sets the rate');
  });

  test('the GST summary agrees with the CSV', async () => {
    const res = await request(app).get(`/api/accounting/reports/summary?from=${today}&to=${today}`).set('Cookie', cookie);
    const b2b = res.body.data.gst.b2b;
    assert.deepEqual(b2b, { invoices: 4, taxable: 320000, value: 363300 });
  });

  test('reconcile matches a correct invoice in the books, whichever amounts the books give', async () => {
    await db.query(`DELETE FROM reconciliation_items; DELETE FROM books_entries`);
    await db.query(
      `INSERT INTO books_entries (source, kind, books_id, number, entry_date, taxable_amount, tax_amount, total_amount, currency) VALUES
         ('file', 'invoice', 'b1', 'INV-1', $1, 100000, 18000, 118000, 'INR'),
         ('file', 'invoice', 'b2', 'INV-2', $1, NULL, NULL, 128500, 'INR'),
         ('file', 'invoice', 'b3', 'INV-3', $1, 10000, 0, NULL, 'USD')`, [today]);
    const res = await request(app).post('/api/accounting/reconcile').set('Cookie', cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows } = await db.query(
      `SELECT s.invoice_no, r.status, r.differences FROM reconciliation_items r JOIN payment_stages s ON s.id = r.stage_id
        WHERE r.kind = 'invoice' AND s.invoice_no IN ('INV-1', 'INV-2', 'INV-3') ORDER BY s.invoice_no`);
    assert.deepEqual(rows.map((r) => [r.invoice_no, r.status]), [['INV-1', 'matched'], ['INV-2', 'matched'], ['INV-3', 'matched']],
      JSON.stringify(rows));
  });

  test('reconcile still catches an amount that really differs', async () => {
    await db.query(`DELETE FROM reconciliation_items; DELETE FROM books_entries`);
    await db.query(
      `INSERT INTO books_entries (source, kind, books_id, number, entry_date, taxable_amount, tax_amount, total_amount) VALUES
         ('file', 'invoice', 'b1', 'INV-1', $1, 90000, 16200, 106200),
         ('file', 'invoice', 'b2', 'INV-2', $1, 95000, NULL, NULL)`, [today]);
    await request(app).post('/api/accounting/reconcile').set('Cookie', cookie).expect(200);
    const { rows } = await db.query(
      `SELECT s.invoice_no, r.status, r.differences FROM reconciliation_items r JOIN payment_stages s ON s.id = r.stage_id
        WHERE r.kind = 'invoice' AND s.invoice_no IN ('INV-1', 'INV-2') ORDER BY s.invoice_no`);
    assert.deepEqual(rows.map((r) => r.status), ['amount_differs', 'amount_differs']);
    const [one] = rows[0].differences;
    assert.deepEqual([one.tracker, one.books], [118000, 106200], 'compared total with total');
  });

  test('reconcile catches GST charged at the wrong rate when the books give taxable and tax but no total', async () => {
    await db.query(`DELETE FROM reconciliation_items; DELETE FROM books_entries`);
    // The right taxable value, but 5% GST on an 18% invoice.
    await db.query(
      `INSERT INTO books_entries (source, kind, books_id, number, entry_date, taxable_amount, tax_amount, total_amount)
       VALUES ('file', 'invoice', 'b1', 'INV-1', $1, 100000, 5000, NULL)`, [today]);
    await request(app).post('/api/accounting/reconcile').set('Cookie', cookie).expect(200);
    const { rows: [r] } = await db.query(
      `SELECT r.status, r.differences FROM reconciliation_items r JOIN payment_stages s ON s.id = r.stage_id WHERE s.invoice_no = 'INV-1'`);
    assert.equal(r.status, 'amount_differs');
    assert.deepEqual([r.differences[0].tracker, r.differences[0].books], [118000, 105000]);
  });
});
