import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * #74 — GET /api/dashboard/data-quality.
 *
 * Every check is seeded one incomplete record at a time and must move by
 * exactly one while every other check stays put; complete records count
 * nowhere; fixing a record takes it off; and each count equals the total the
 * list behind its link reports, which is the promise the page makes.
 *
 * The database tests need a real Postgres. Set TEST_DATABASE_URL to run.
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
  'GET /api/dashboard/data-quality',
  { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' },
  () => {
    let dbUrl;
    let app;
    let pool;
    let cookie;

    const exec = (sql, params = []) => pool.query(sql, params);

    async function counts() {
      const res = await request(app).get('/api/dashboard/data-quality').set('Cookie', cookie);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return Object.fromEntries(res.body.data.checks.map((check) => [check.key, check.count]));
    }

    /** Seed, then assert `key` moved by `delta` and nothing else moved. */
    async function expectChange(key, delta, seed) {
      const before = await counts();
      await seed();
      const after = await counts();
      for (const name of Object.keys(before)) {
        assert.equal(after[name], before[name] + (name === key ? delta : 0), `${name} after seeding for ${key}`);
      }
    }

    before(async () => {
      const admin = new pg.Client({ connectionString: ADMIN_URL });
      await admin.connect();
      const name = `data_quality_test_${process.pid}_${Date.now()}`;
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

    test('every check is listed, and complete records appear in no count', async () => {
      const [company] = (await exec(`INSERT INTO companies (name) VALUES ('Complete Co') RETURNING id`)).rows;
      await exec(`INSERT INTO contacts (company_id, name) VALUES ($1, 'Meera')`, [company.id]);
      await exec(`
        INSERT INTO projects (project_id, client_name, primary_service, sales_person)
        VALUES ('PRJ-DQ-1', 'Complete Co', 'ESG Reporting', 'Asha')`);
      await exec(`
        INSERT INTO quotations (quotation_no, client_name, quotation_value, sales_person, sector)
        VALUES ('QT-DQ-1', 'Complete Co', 100000, 'Asha', 'Energy')`);
      await exec(`
        INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_value, currency, po_date)
        VALUES ('PO-DQ-1', 'PRJ-DQ-1', 'QT-DQ-1', 100000, 'INR', '2026-01-10')`);
      const [doc] = (await exec(`
        INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
        VALUES ('test/inv_dq_1', 'inv_dq_1.pdf', 'application/pdf', 100) RETURNING id`)).rows;
      await exec(`
        INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent,
                                    invoice_no, invoice_date, document_id)
        VALUES ('PO-DQ-1', 1, 'Advance', 'On PO Registration', 0.3, 'INV/DQ/1', '2026-02-01', $1)`, [doc.id]);
      // Not invoiced yet, so a missing document is expected, not a gap.
      await exec(`
        INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
        VALUES ('PO-DQ-1', 3, 'Final', 'On Delivery', 0.4)`);
      await exec(`
        INSERT INTO travel_logs (travel_id, po_number, employee_name)
        VALUES ('TR-DQ-1', 'PO-DQ-1', 'Ravi')`);
      await exec(`
        INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_invoice_no, invoice_date, invoice_amount)
        VALUES ('VI-DQ-1', 'TR-DQ-1', 'AGT/1', '2026-02-05', 5000)`);

      const res = await request(app).get('/api/dashboard/data-quality').set('Cookie', cookie);
      assert.equal(res.status, 200);
      const checks = res.body.data.checks;
      assert.deepEqual(checks.map((check) => check.key), [
        'quotations_without_value',
        'quotations_without_sales_person',
        'quotations_without_sector',
        'projects_without_sales_person',
        'purchase_orders_without_quotation',
        'vendor_invoices_without_amount',
        'payment_stages_without_document',
        'companies_without_contact',
      ]);
      for (const check of checks) {
        assert.equal(check.count, 0, `${check.key} counts a complete record`);
        assert.ok(check.label && check.link.startsWith('/'), `${check.key} has a label and a link`);
      }
    });

    test('a quotation with no value', () => expectChange('quotations_without_value', 1, () => exec(`
      INSERT INTO quotations (quotation_no, client_name, sales_person, sector)
      VALUES ('QT-DQ-2', 'Complete Co', 'Asha', 'Energy')`)));

    test('a quotation whose sales person is blank', () => expectChange('quotations_without_sales_person', 1, () => exec(`
      INSERT INTO quotations (quotation_no, client_name, quotation_value, sales_person, sector)
      VALUES ('QT-DQ-3', 'Complete Co', 5000, '  ', 'Energy')`)));

    test('a quotation with no sector', () => expectChange('quotations_without_sector', 1, () => exec(`
      INSERT INTO quotations (quotation_no, client_name, quotation_value, sales_person)
      VALUES ('QT-DQ-4', 'Complete Co', 5000, 'Asha')`)));

    test('a project with no sales person', () => expectChange('projects_without_sales_person', 1, () => exec(`
      INSERT INTO projects (project_id, client_name, primary_service)
      VALUES ('PRJ-DQ-2', 'Complete Co', 'Audit')`)));

    test('a purchase order with no linked quotation', () => expectChange('purchase_orders_without_quotation', 1, () => exec(`
      INSERT INTO purchase_orders (po_number, project_id, po_value, currency, po_date)
      VALUES ('PO-DQ-2', 'PRJ-DQ-1', 20000, 'INR', '2026-03-01')`)));

    test('a vendor invoice with a number and no amount', () => expectChange('vendor_invoices_without_amount', 1, () => exec(`
      INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_invoice_no, invoice_date)
      VALUES ('VI-DQ-2', 'TR-DQ-1', 'AGT/2', '2026-02-06')`)));

    test('an invoiced payment stage with no document', () => expectChange('payment_stages_without_document', 1, () => exec(`
      INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
      VALUES ('PO-DQ-1', 2, 'Interim', 'Manual', 0.3, 'INV/DQ/2', '2026-03-01')`)));

    test('a company with no contact', () => expectChange('companies_without_contact', 1, () => exec(`
      INSERT INTO companies (name) VALUES ('Lonely Co')`)));

    test('fixing a record drops its count by one', () => expectChange('quotations_without_value', -1, () => exec(`
      UPDATE quotations SET quotation_value = 7500 WHERE quotation_no = 'QT-DQ-2'`)));

    test('each count equals the total of the list its link opens', async () => {
      const res = await request(app).get('/api/dashboard/data-quality').set('Cookie', cookie);
      for (const check of res.body.data.checks) {
        // The page route and the API resource share a name: /quotations → /api/quotations.
        const list = await request(app).get(`/api${check.link}`).set('Cookie', cookie);
        assert.equal(list.status, 200, `${check.link}: ${JSON.stringify(list.body)}`);
        assert.equal(list.body.total, check.count, `${check.key}: the list at ${check.link} disagrees`);
      }
    });
  }
);
