import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The invoice series (C5).
 *
 * A GST invoice series has to be unbroken and unrepeated, so the number is
 * claimed inside the transaction that writes it rather than previewed by
 * the client and posted back. The test that matters is the concurrent one:
 * two people in the invoice run at the same moment must not be handed the
 * same number.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('raising an invoice', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let app;
  let pool;
  let cookie;
  let stages;

  async function exec(sql, params = []) {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try { return (await client.query(sql, params)).rows; } finally { await client.end(); }
  }

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `invoice_test_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await client.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
    await client.end();

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

    await exec(`INSERT INTO projects (project_id, client_name, primary_service) VALUES ('PRJ-2026-900', 'Hindalco', 'ASI')`);
    await exec(`INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency, payment_terms_days)
                VALUES ('PO-INV-1', 'PRJ-2026-900', '2026-07-24', 1000000, 'INR', 30)`);
    stages = await exec(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, trigger_event)
                VALUES ('PO-INV-1', 1, 'Advance 50%',  0.4, 'On PO Registration'),
                       ('PO-INV-1', 2, 'On delivery',  0.4, 'On Delivery'),
                       ('PO-INV-1', 3, 'Third',        0.1, 'Manual')
                RETURNING id, stage_no`);
  });

  after(async () => {
    await pool.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const raise = (id, body) => request(app).post(`/api/payment-stages/${id}/invoice`).set('Cookie', cookie).send(body);

  test('the number is assigned by the server when none is sent', async () => {
    const res = await raise(stages[0].id, { invoice_date: '2026-09-22' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.invoice_no, 'CVPL/26-27/0001');
    assert.equal(res.body.data.invoice_date.slice(0, 10), '2026-09-22');
  });

  test('two raised at the same moment never get the same number', async () => {
    // The whole reason the number is claimed in the transaction rather
    // than previewed: the invoice run hands the same preview to everyone
    // looking at it.
    const [a, b] = await Promise.all([
      raise(stages[1].id, { invoice_date: '2026-09-22' }),
      raise(stages[2].id, { invoice_date: '2026-09-22' }),
    ]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.notEqual(a.body.data.invoice_no, b.body.data.invoice_no, 'two invoices, two numbers');
    assert.deepEqual(
      [a.body.data.invoice_no, b.body.data.invoice_no].sort(),
      ['CVPL/26-27/0002', 'CVPL/26-27/0003'],
      'and they are the next two in the series, with nothing skipped'
    );
  });

  test('a number typed in by hand is kept, because an invoice may come from elsewhere', async () => {
    const [own] = await exec(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, trigger_event)
                              VALUES ('PO-INV-1', 4, 'Recorded late', 0.0001, 'Manual') RETURNING id`);
    const res = await raise(own.id, { invoice_no: 'LEGACY/2019/7', invoice_date: '2026-09-22' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.invoice_no, 'LEGACY/2019/7');
  });

  test('the year comes from the invoice date, not from today', async () => {
    // An invoice dated 28 March belongs to the year that is ending,
    // whenever somebody gets round to entering it.
    const [late] = await exec(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, trigger_event)
                               VALUES ('PO-INV-1', 5, 'Last year', 0.0001, 'Manual') RETURNING id`);
    const res = await raise(late.id, { invoice_date: '2026-03-28' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.invoice_no, 'CVPL/25-26/0001', 'its own year, and its own counter');
  });

  test('the preview matches what the next raise will take', async () => {
    const preview = await request(app).get('/api/lookups/next-id/invoice').set('Cookie', cookie);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));

    const [next] = await exec(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, trigger_event)
                               VALUES ('PO-INV-1', 6, 'Next', 0.0001, 'Manual') RETURNING id`);
    const res = await raise(next.id, { invoice_date: '2026-09-22' });
    assert.equal(res.body.data.invoice_no, preview.body.data.next, 'what the panel showed is what it took');
  });

  test('a date that is not a date is refused before anything is written', async () => {
    const [spare] = await exec(`INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, trigger_event)
                                VALUES ('PO-INV-1', 7, 'Spare', 0.0001, 'Manual') RETURNING id`);
    const res = await raise(spare.id, { invoice_date: 'last Tuesday' });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    const [row] = await exec('SELECT invoice_no FROM payment_stages WHERE id = $1', [spare.id]);
    assert.equal(row.invoice_no, null, 'and the series did not move');
  });
});
