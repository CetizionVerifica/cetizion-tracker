import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * #76 — GET /api/dashboard/payables and /api/export/payables.csv: what
 * Cetizion owes travel vendors, aged.
 *
 * Requires a real Postgres database. Set TEST_DATABASE_URL to run.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

async function applySchema(dbUrl) {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
  } finally {
    await client.end();
  }
}

describe('payables ageing', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let app;
  let pool;
  let cookie;
  let body;

  const get = async (path) => {
    const res = await request(app).get(path).set('Cookie', cookie);
    assert.equal(res.status, 200, `${path}: ${res.text}`);
    return res;
  };
  const row = (id) => body.rows.find((r) => r.vendor_invoice_id === id);

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `payables_test_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    await applySchema(dbUrl);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_USERNAME = 'tester';
    process.env.AUTH_PASSWORD = 'test-password-long-enough';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    app = (await import('../src/app.js')).default;
    pool = (await import('../src/db.js')).pool;
    const signIn = await request(app).post('/api/auth/login')
      .send({ username: 'tester', password: 'test-password-long-enough' });
    assert.equal(signIn.status, 200, 'sign-in failed');
    cookie = signIn.headers['set-cookie'];

    await pool.query(`
      INSERT INTO travel_logs (travel_id, employee_name, arranged_by, destination, travel_start_date, travel_end_date)
      VALUES ('TRV-PAY-1', 'Ravi', 'Yatra Travels', 'Renukoot', CURRENT_DATE - 110, CURRENT_DATE - 105)`);
    // Dates are relative to today: pay-by is the month-end after the
    // invoice date, so a bill dated 100 days ago is overdue whatever today
    // is, and one dated today is not yet due.
    await pool.query(`
      INSERT INTO travel_vendor_invoices
        (vendor_invoice_id, travel_id, vendor_invoice_no, invoice_date, invoice_amount, amount_paid)
      VALUES
        ('VI-UNPAID',  'TRV-PAY-1', 'YT/1', CURRENT_DATE - 100, 1000, 0),
        ('VI-PART',    'TRV-PAY-1', 'YT/2', CURRENT_DATE,       5000, 2000),
        ('VI-PAID',    'TRV-PAY-1', 'YT/3', CURRENT_DATE - 40,  800,  800),
        ('VI-NOAMT',   'TRV-PAY-1', 'YT/4', CURRENT_DATE - 20,  NULL, 0),
        ('VI-NODATE',  'TRV-PAY-1', 'YT/5', NULL,               700,  0),
        ('VI-AWAITED', 'TRV-PAY-1', NULL,   NULL,               NULL, 0)`);

    body = (await get('/api/dashboard/payables')).body.data;
  });

  after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  test('an invoice with no payment shows its full amount outstanding, aged', () => {
    const unpaid = row('VI-UNPAID');
    assert.equal(unpaid.outstanding, 1000);
    assert.equal(unpaid.payment_status, 'Overdue');
    assert.ok(unpaid.days_overdue > 30, `days_overdue ${unpaid.days_overdue}`);
    assert.notEqual(unpaid.bucket, 'not due');
  });

  test('a partly paid invoice shows the remainder, and is not yet due', () => {
    const part = row('VI-PART');
    assert.equal(part.outstanding, 3000);
    assert.equal(part.bucket, 'not due');
  });

  test('a fully paid invoice, and one not yet billed, do not appear', () => {
    assert.equal(row('VI-PAID'), undefined);
    assert.equal(row('VI-AWAITED'), undefined);
  });

  test('an invoice with no amount is listed under "amount missing", never as zero', () => {
    const missing = row('VI-NOAMT');
    assert.equal(missing.bucket, 'amount missing');
    assert.equal(missing.outstanding, null);
    const bucket = body.buckets.find((b) => b.bucket === 'amount missing');
    assert.equal(bucket.invoices, 1);
    assert.equal(bucket.outstanding, null, 'a count, not a sum');
    assert.equal(body.amount_missing, 1);
  });

  test('an invoice with no date is owed but cannot be aged', () => {
    const undated = row('VI-NODATE');
    assert.equal(undated.bucket, 'date missing');
    assert.equal(undated.outstanding, 700);
  });

  test('bucket boundaries: exactly 30 and exactly 31 days land in the right buckets', async () => {
    const cases = [[-3, 'not due'], [0, 'not due'], [1, '0-30'], [30, '0-30'], [31, '31-60'],
      [60, '31-60'], [61, '61-90'], [90, '61-90'], [91, '90+']];
    const { rows } = await pool.query(
      'SELECT d, payables_bucket(d) AS bucket FROM unnest($1::int[]) AS d',
      [cases.map(([days]) => days)]
    );
    assert.deepEqual(rows.map((r) => [r.d, r.bucket]), cases);
  });

  test('totals per bucket add up to the overall outstanding total', () => {
    assert.deepEqual(body.buckets.map((b) => b.bucket),
      ['not due', '0-30', '31-60', '61-90', '90+', 'date missing', 'amount missing']);
    const sum = body.buckets.reduce((total, b) => total + (b.outstanding ?? 0), 0);
    assert.equal(sum, body.total_outstanding);
    assert.equal(body.total_outstanding, 1000 + 3000 + 700);
    for (const b of body.buckets.filter((one) => one.outstanding !== null)) {
      const rows = body.rows.filter((r) => r.bucket === b.bucket);
      assert.equal(b.invoices, rows.length, b.bucket);
      assert.equal(b.outstanding, rows.reduce((total, r) => total + r.outstanding, 0), b.bucket);
    }
  });

  test('the figures match the Vendor invoices page for the same invoices', async () => {
    const list = (await get('/api/vendor-invoices?limit=500')).body.data;
    for (const payable of body.rows) {
      const same = list.find((r) => r.vendor_invoice_id === payable.vendor_invoice_id);
      assert.ok(same, payable.vendor_invoice_id);
      for (const field of ['invoice_amount', 'amount_paid', 'pay_by', 'payment_status', 'days_overdue', 'travel_vendor']) {
        assert.equal(payable[field], same[field], `${payable.vendor_invoice_id}.${field}`);
      }
    }
  });

  test('rows come longest overdue first', () => {
    assert.equal(body.rows[0].vendor_invoice_id, 'VI-UNPAID');
    const days = body.rows.map((r) => r.days_overdue);
    assert.deepEqual(days, [...days].sort((a, b) => b - a));
  });

  test('the CSV contains what the page shows, in the same order', async () => {
    const res = await get('/api/export/payables.csv');
    assert.match(res.headers['content-type'], /text\/csv/);
    assert.match(res.headers['content-disposition'], /cetizion-payables-/);
    const [header, ...lines] = res.text.trim().split('\n');
    const columns = header.split(',');
    for (const column of ['vendor_invoice_id', 'outstanding', 'pay_by', 'days_overdue', 'bucket']) {
      assert.ok(columns.includes(column), column);
    }
    const idAt = columns.indexOf('vendor_invoice_id');
    assert.deepEqual(lines.map((line) => line.split(',')[idAt]), body.rows.map((r) => r.vendor_invoice_id));
  });
});
