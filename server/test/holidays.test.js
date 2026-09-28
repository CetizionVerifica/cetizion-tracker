import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * #73 — the holidays list behind Settings → Holidays, and the working days
 * late it feeds on the Action list.
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

describe(
  'holidays and working days late',
  { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' },
  () => {
    let dbUrl;
    let app;
    let pool;
    let cookie;
    let helpers;

    before(async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      const name = `holidays_test_${process.pid}_${Date.now()}`;
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
      helpers = await import('../src/lib/businessDate.ts');
      const res = await request(app).post('/api/auth/login').send({
        username: 'tester',
        password: 'test-password-long-enough',
      });
      assert.equal(res.status, 200, 'sign-in failed');
      cookie = res.headers['set-cookie'];
    });

    after(async () => {
      await pool.end();
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
      await admin.end();
    });

    test('a new database starts with the gazetted holidays for 2026 and 2027', async () => {
      const res = await request(app).get('/api/holidays').set('Cookie', cookie);
      assert.equal(res.status, 200);
      const byDate = new Map(res.body.data.map((row) => [row.holiday_on, row.name]));
      assert.equal(byDate.get('2026-01-26'), 'Republic Day');
      assert.equal(byDate.get('2027-10-29'), 'Diwali');
      assert.equal(res.body.data.filter((row) => row.holiday_on.startsWith('2026')).length, 17);
      // 2027 has 17 holidays on 16 dates: Independence Day and Milad-un-Nabi share 15 August.
      assert.equal(res.body.data.filter((row) => row.holiday_on.startsWith('2027')).length, 16);
      // In date order, which is how Settings lists them.
      const dates = res.body.data.map((row) => row.holiday_on);
      assert.deepEqual(dates, [...dates].sort());
    });

    test('a holiday can be added, is kept, refuses a second on the same date, and can be deleted', async () => {
      const created = await request(app).post('/api/holidays').set('Cookie', cookie)
        .send({ holiday_on: '2026-09-17', name: 'Office closed' });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const { id } = created.body.data;

      const stored = await pool.query('SELECT name FROM holidays WHERE holiday_on = $1', ['2026-09-17']);
      assert.equal(stored.rows[0]?.name, 'Office closed', 'written to the table, so it survives a restart');

      const twice = await request(app).post('/api/holidays').set('Cookie', cookie)
        .send({ holiday_on: '2026-09-17', name: 'Again' });
      assert.equal(twice.status, 409);

      const removed = await request(app).delete(`/api/holidays/${id}`).set('Cookie', cookie);
      assert.ok(removed.status < 300, JSON.stringify(removed.body));
      const gone = await pool.query('SELECT 1 FROM holidays WHERE holiday_on = $1', ['2026-09-17']);
      assert.equal(gone.rowCount, 0);
    });

    test('a holiday needs a date and a name', async () => {
      const res = await request(app).post('/api/holidays').set('Cookie', cookie).send({ name: 'No date' });
      assert.equal(res.status, 422);
    });

    test('the Action list says how many working days an overdue stage is late', async () => {
      const today = helpers.businessToday();
      const dueOn = helpers.addWorkingDays(today, -10, []);
      await pool.query(`
        INSERT INTO projects (project_id, client_name, primary_service)
        VALUES ('PRJ-WD-1', 'Acme Ltd', 'Audit')`);
      await pool.query(`
        INSERT INTO purchase_orders (po_number, project_id, po_value, currency, payment_terms_days, po_date)
        VALUES ('PO-WD-1', 'PRJ-WD-1', 100000, 'INR', 0, '2026-01-02')`);
      // Invoiced with no credit days, so it fell due on its invoice date.
      await pool.query(`
        INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent,
                                    invoice_no, invoice_date, credit_days)
        VALUES ('PO-WD-1', 1, 'Advance', 'On PO Registration', 0.5, 'INV/WD/1', $1, 0)`, [dueOn]);
      // Not invoiced yet: on the list, but not late.
      await pool.query(`
        INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
        VALUES ('PO-WD-1', 2, 'Balance', 'Manual', 0.5)`);

      const holidays = (await pool.query('SELECT holiday_on FROM holidays')).rows.map((row) => row.holiday_on);
      const res = await request(app).get('/api/dashboard/worklist').set('Cookie', cookie);
      assert.equal(res.status, 200);
      const stages = res.body.data.payment_stages.filter((row) => row.po_number === 'PO-WD-1');

      const late = stages.find((row) => row.stage_no === 1);
      assert.equal(late.stage_status, 'Overdue');
      assert.equal(late.working_days_overdue, helpers.workingDaysBetween(dueOn, today, holidays));
      assert.ok(late.working_days_overdue <= late.days_overdue, 'never more than the calendar days');

      const notLate = stages.find((row) => row.stage_no === 2);
      assert.equal(notLate.working_days_overdue, null);
    });
  }
);
