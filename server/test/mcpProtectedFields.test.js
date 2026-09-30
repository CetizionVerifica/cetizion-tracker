import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The money columns are closed to the MCP importer too (#85).
 *
 * #85 shut the generic form against an expense claim's approval and
 * reimbursement and against a vendor invoice's payment. The MCP record
 * importer arrived afterwards and writes any importable resource through
 * `insertRecord` / `updateRecordRow` in crud.js, which no route handler
 * stands in front of — so a guard living in the CRUD route handlers would
 * have closed one door and left this one open.
 *
 * `import_records` needs an admin token, so this was never a way for a sales
 * user to approve their own claim. What it defeated is the other half of the
 * rule: that these columns move only through a route that checks the record's
 * state and writes an audit row naming the account. An admin token could have
 * marked a claim Approved, put any name in `approved_by`, and left nothing in
 * the activity log to say it happened.
 *
 * Every case below checks the stored row as well as the response, because a
 * refusal that half happened is the failure worth catching.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mcp_protected_${process.pid}_${Date.now()}`;

describe('MCP cannot write the workflow-owned columns', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let app; let pool; let db; let staff; let adminToken; let salesToken;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();

    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    // A trip, a claim on it and a vendor bill against it. Both money records
    // start clean, so any movement below is this test's doing.
    await db.query(`
      INSERT INTO travel_logs (travel_id, employee_name, arranged_by, travel_start_date)
        VALUES ('TRV-P1', 'Sam Sales', 'Yatra Travels', '2026-05-01');
      INSERT INTO employee_expense_claims (claim_id, travel_id, expense_category, amount_claimed)
        VALUES ('CLM-P1', 'TRV-P1', 'Taxi', 4000);
      INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_invoice_no, invoice_amount)
        VALUES ('VI-P1', 'TRV-P1', 'YT/2026/9', 12000);
    `);

    Object.assign(process.env, {
      SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: url.toString(),
      AUTH_USERNAME: 'tester', AUTH_PASSWORD: 'a-good-long-test-password',
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass', EMAIL_MODE: 'log',
    });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const signIn = await request(app).post('/api/auth/login')
      .send({ username: 'tester', password: 'a-good-long-test-password' });
    staff = signIn.headers['set-cookie'][0].split(';')[0];

    const mint = async (body) => (await request(app).post('/api/api-tokens')
      .set('Cookie', staff).send(body).expect(201)).body.data.token;
    adminToken = await mint({ name: 'Protected fields admin', role: 'admin', can_write: true });
    salesToken = await mint({ name: 'Protected fields sales', role: 'sales', person: 'Sam Sales', can_write: true });
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  let rpc = 0;
  async function call(tok, name, args = {}) {
    rpc += 1;
    const res = await request(app).post('/api/mcp')
      .set('Authorization', `Bearer ${tok}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: rpc, method: 'tools/call', params: { name, arguments: args } });
    if (res.status !== 200) return { status: res.status };
    const r = res.body.result;
    return { status: 200, error: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
  }

  /** Write for real — dry_run defaults to true and would prove nothing. */
  const importRows = (tok, entity, rows, extra = {}) =>
    call(tok, 'import_records', { entity, rows, dry_run: false, ...extra });

  const claim = async () => (await db.query(
    `SELECT approval_status, approved_by, amount_reimbursed, reimbursement_date, expense_category, remarks
       FROM employee_expense_claims WHERE claim_id = 'CLM-P1'`)).rows[0];

  const invoice = async () => (await db.query(
    `SELECT amount_paid, payment_date, vendor_invoice_no, remarks
       FROM travel_vendor_invoices WHERE vendor_invoice_id = 'VI-P1'`)).rows[0];

  const auditRows = async () => Number((await db.query('SELECT count(*)::int AS n FROM activity_log')).rows[0].n);

  describe('expense claims', () => {
    const FORBIDDEN = [
      ['approval_status', 'Approved'],
      ['approved_by', 'Somebody Else'],
      ['amount_reimbursed', 4000],
      ['reimbursement_date', '2026-06-01'],
    ];

    for (const [field, value] of FORBIDDEN) {
      test(`an admin token cannot update ${field} through import_records`, async () => {
        const before = await claim();

        const res = await importRows(adminToken, 'expense-claims',
          [{ claim_id: 'CLM-P1', travel_id: 'TRV-P1', [field]: value }], { match_on: 'claim_id' });

        assert.equal(res.status, 200);
        const report = JSON.parse(res.text);
        assert.equal(report.rejected, 1, `${field} was not rejected: ${res.text}`);
        assert.equal(report.updated, 0, `${field}: the batch still wrote something`);
        assert.equal(report.created, 0);
        assert.match(JSON.stringify(report.rows), new RegExp(field),
          'the refusal should name the field, so the caller can fix the row');

        assert.deepEqual(await claim(), before, `${field} changed on the stored row despite the refusal`);
      });

      test(`an admin token cannot create a claim carrying ${field}`, async () => {
        const res = await importRows(adminToken, 'expense-claims',
          [{ claim_id: `CLM-NEW-${field}`, travel_id: 'TRV-P1', amount_claimed: 100, [field]: value }],
          { match_on: 'claim_id' });

        assert.equal(res.status, 200);
        const report = JSON.parse(res.text);
        assert.equal(report.rejected, 1, `${field} was accepted on a create: ${res.text}`);
        assert.equal(report.created, 0);

        const { rows } = await db.query(
          'SELECT 1 FROM employee_expense_claims WHERE claim_id = $1', [`CLM-NEW-${field}`]);
        assert.equal(rows.length, 0, 'a refused row was written anyway');
      });
    }

    test('a null is an attempt too — presence is what counts, not the value', async () => {
      const before = await claim();

      const res = await importRows(adminToken, 'expense-claims',
        [{ claim_id: 'CLM-P1', travel_id: 'TRV-P1', approval_status: null }], { match_on: 'claim_id' });

      assert.equal(JSON.parse(res.text).rejected, 1,
        'sending the column explicitly as null must be refused like any other attempt');
      assert.deepEqual(await claim(), before);
    });

    test('one forbidden field refuses the whole batch, so no row is half-written', async () => {
      const res = await importRows(adminToken, 'expense-claims', [
        { claim_id: 'CLM-BATCH-OK', travel_id: 'TRV-P1', amount_claimed: 50 },
        { claim_id: 'CLM-BATCH-BAD', travel_id: 'TRV-P1', approved_by: 'Nobody' },
      ], { match_on: 'claim_id' });

      const report = JSON.parse(res.text);
      assert.equal(report.rejected, 1);
      assert.equal(report.created, 0, 'the good row was written while the bad one was refused');

      const { rows } = await db.query(
        `SELECT 1 FROM employee_expense_claims WHERE claim_id IN ('CLM-BATCH-OK', 'CLM-BATCH-BAD')`);
      assert.equal(rows.length, 0);
    });

    test('the fields that are the claimant\'s own still import', async () => {
      const audits = await auditRows();

      const res = await importRows(adminToken, 'expense-claims',
        [{ claim_id: 'CLM-P1', travel_id: 'TRV-P1', expense_category: 'Hotel', remarks: 'Corrected by import' }],
        { match_on: 'claim_id' });

      const report = JSON.parse(res.text);
      assert.equal(report.rejected, 0, res.text);
      assert.equal(report.updated, 1, res.text);

      const after = await claim();
      assert.equal(after.expense_category, 'Hotel');
      assert.equal(after.remarks, 'Corrected by import');
      // Untouched, which is the other half of the rule.
      assert.equal(after.approval_status, 'Submitted');
      assert.equal(Number(after.amount_reimbursed), 0);
      assert.equal(after.approved_by, null);

      assert.equal(await auditRows(), audits,
        'an ordinary import should not be writing money audit rows either');
    });

    test('a new claim with no forbidden field is created, and starts Submitted', async () => {
      const res = await importRows(adminToken, 'expense-claims',
        [{ claim_id: 'CLM-P2', travel_id: 'TRV-P1', expense_category: 'Train', amount_claimed: 800 }],
        { match_on: 'claim_id' });

      assert.equal(JSON.parse(res.text).created, 1, res.text);
      const { rows: [row] } = await db.query(
        `SELECT approval_status, amount_reimbursed FROM employee_expense_claims WHERE claim_id = 'CLM-P2'`);
      assert.equal(row.approval_status, 'Submitted');
      assert.equal(Number(row.amount_reimbursed), 0);
    });
  });

  describe('vendor invoices', () => {
    for (const [field, value] of [['amount_paid', 12000], ['payment_date', '2026-06-01']]) {
      test(`an admin token cannot write ${field} through import_records`, async () => {
        const before = await invoice();

        const res = await importRows(adminToken, 'vendor-invoices',
          [{ vendor_invoice_id: 'VI-P1', travel_id: 'TRV-P1', [field]: value }],
          { match_on: 'vendor_invoice_id' });

        const report = JSON.parse(res.text);
        assert.equal(report.rejected, 1, `${field} was not rejected: ${res.text}`);
        assert.equal(report.updated, 0);
        assert.deepEqual(await invoice(), before, `${field} changed despite the refusal`);
      });
    }

    test('the rest of a vendor invoice still imports', async () => {
      const res = await importRows(adminToken, 'vendor-invoices',
        [{ vendor_invoice_id: 'VI-P1', travel_id: 'TRV-P1', vendor_invoice_no: 'YT/2026/9-R', remarks: 'Reissued' }],
        { match_on: 'vendor_invoice_id' });

      assert.equal(JSON.parse(res.text).rejected, 0, res.text);
      const after = await invoice();
      assert.equal(after.vendor_invoice_no, 'YT/2026/9-R');
      assert.equal(Number(after.amount_paid), 0, 'the paid total moved on an ordinary import');
      assert.equal(after.payment_date, null);
    });
  });

  /**
   * Bulk writing is an admin's, as it is on the Import screen — and the tool
   * list is built per token, so a sales one is never offered import_records at
   * all. The answer is "no such tool" rather than a refusal, which is the
   * stronger of the two: there is nothing to probe. assertMayImport inside the
   * tool is the second lock, for a token whose role changed mid-session.
   */
  test('a sales token is not offered import_records, and cannot write with it', async () => {
    const listed = await request(app).post('/api/mcp')
      .set('Authorization', `Bearer ${salesToken}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 9001, method: 'tools/list', params: {} });
    const names = (listed.body.result?.tools || []).map((t) => t.name);
    assert.ok(names.length > 0, 'a sales token should still see the tools that are its own');
    assert.ok(!names.includes('import_records'), `import_records was offered to a sales token: ${names.join(', ')}`);

    const res = await importRows(salesToken, 'expense-claims',
      [{ claim_id: 'CLM-SALES', travel_id: 'TRV-P1', amount_claimed: 10 }], { match_on: 'claim_id' });
    assert.equal(res.error, true, 'calling it anyway must not succeed');

    const { rows } = await db.query(
      `SELECT 1 FROM employee_expense_claims WHERE claim_id = 'CLM-SALES'`);
    assert.equal(rows.length, 0);
  });
});
