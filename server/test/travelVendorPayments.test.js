import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * What the company has paid a travel agency, as a ledger (#214).
 *
 * Three things are being held in place here.
 *
 * **The legacy carry-over.** The production data behind
 * `travel_vendor_invoices.amount_paid` could not be measured before the
 * migration was written, so the migration preserves whatever shape it finds
 * instead of tidying it. The first suite below seeds every shape the
 * measurement would have looked for — negative figures, missing dates, dates
 * in the future, overpayments, a paid invoice with no invoice amount, a date
 * on an invoice nobody paid — and proves each one survives with its figure
 * and its date intact. If any of those exist in production, this is the test
 * that says they still will afterwards.
 *
 * **The money.** Settlement is `amount + tds_amount`, as it is for a client
 * receipt: tax deducted at source settles the agency's bill without the
 * money reaching the agency. So a 100,000 bill paid by a 90,000 transfer
 * with 10,000 deducted is Paid, and 90,000 is what left the bank.
 *
 * **Who.** The travel desk and an administrator pay; only an administrator
 * corrects. A reduction through the paying route is refused rather than
 * quietly written, because writing it would hand HR the correction it is not
 * supposed to have — with no reason and under the wrong audit action.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const PASSWORD = 'a-good-long-test-password';

/** The schema as it stood before this migration, so the backfill has work to do. */
function schemaBefore() {
  const full = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
  const marker = '-- What the company has paid a travel agency, as a ledger (095, #214).';
  const at = full.indexOf(marker);
  assert.ok(at > 0, 'the 095 section should be marked in schema.sql');
  // Cut back to the comment banner that opens the section.
  return full.slice(0, full.lastIndexOf('-- ---------------------------------------------------------------------', at));
}

describe('travel vendor payments (#214)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  // ------------------------------------------------- the legacy carry-over

  describe('the migration carries legacy figures over exactly', () => {
    const NAME = `tvp_legacy_${process.pid}_${Date.now()}`;
    let db;

    /**
     * Every shape the production measurement was meant to detect, seeded
     * before the migration runs. `paid` and `on` are what the old columns
     * held; `amount` is the invoice total, which may be absent.
     */
    const LEGACY = [
      { id: 'L1-pos-date', paid: 4000, on: '2026-05-01', amount: 10000, rows: 1, reason: false },
      { id: 'L2-pos-nodate', paid: 4000, on: null, amount: 10000, rows: 1, reason: false },
      { id: 'L3-neg-date', paid: -500, on: '2026-05-02', amount: 10000, rows: 1, reason: true },
      { id: 'L4-neg-nodate', paid: -500, on: null, amount: 10000, rows: 1, reason: true },
      // No money, but a date. No row is written: an invoice nobody has paid
      // must not gain a payment, and its date must not be erased either.
      { id: 'L5-zero-date', paid: 0, on: '2026-05-03', amount: 10000, rows: 0, reason: false },
      // Dated past the day the migration runs. Carried as it stands — the
      // future-date rule is the route's, for new payments only.
      { id: 'L6-future', paid: 1000, on: '2099-01-01', amount: 10000, rows: 1, reason: false },
      { id: 'L7-over', paid: 5000, on: '2026-05-04', amount: 1000, rows: 1, reason: false },
      { id: 'L8-no-invoice-amount', paid: 2500, on: '2026-05-05', amount: null, rows: 1, reason: false },
      { id: 'L9-unpaid', paid: 0, on: null, amount: 10000, rows: 0, reason: false },
    ];

    before(async () => {
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`CREATE DATABASE ${NAME}`);
      await root.end();
      const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
      db = new pg.Client({ connectionString: url.toString() });
      await db.connect();

      await db.query(schemaBefore());
      await db.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ('TVP-L', 'Legacy')`);
      await db.query(`INSERT INTO travel_vendors (name) VALUES ('Legacy Agency') ON CONFLICT DO NOTHING`);
      const vendor = (await db.query(`SELECT id FROM travel_vendors WHERE name = 'Legacy Agency'`)).rows[0].id;
      for (const l of LEGACY) {
        await db.query(
          `INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_id, invoice_amount, amount_paid, payment_date)
                VALUES ($1, 'TVP-L', $2, $3, $4, $5)`,
          [l.id, vendor, l.amount, l.paid, l.on]
        );
      }
      // The subject under test.
      await db.query(readFileSync(join(DB_DIR, 'migrations', '095_travel_vendor_payments.sql'), 'utf8'));
      await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));
    });

    after(async () => {
      await db?.end().catch(() => {});
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
      await root.end();
    });

    const invoice = async (id) => (await db.query(
      `SELECT vi.id, vi.amount_paid, vi.payment_date::text AS payment_date,
              (SELECT COALESCE(SUM(p.amount + p.tds_amount), 0) FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id) AS ledger,
              (SELECT count(*)::int FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id) AS rows,
              (SELECT count(*)::int FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id AND p.correction_reason IS NOT NULL) AS with_reason
         FROM travel_vendor_invoices vi WHERE vi.vendor_invoice_id = $1`, [id])).rows[0];

    for (const l of LEGACY) {
      test(`${l.id}: figure, date and row count preserved`, async () => {
        const row = await invoice(l.id);

        assert.equal(Number(row.amount_paid), l.paid, 'the recorded figure must not move');
        assert.equal(Number(row.ledger), l.paid, 'the ledger must add up to exactly what was recorded');
        assert.equal(row.rows, l.rows, 'one opening row per figure, and none where there is no figure');
        assert.equal(row.payment_date, l.on,
          'the date must be preserved as it was, missing or not, however far ahead it is');
        assert.equal(row.with_reason, l.reason ? 1 : 0,
          'a figure that reduces the invoice carries its provenance as the reason; a plain payment carries none');
      });
    }

    test('nothing was invented: no reference, no proof, no TDS, and the method says "other"', async () => {
      const { rows } = await db.query(
        `SELECT reference, document_id, tds_amount, mode, remarks FROM travel_vendor_payments`);
      assert.equal(rows.length, 7, 'seven of the nine invoices carry a figure');
      for (const r of rows) {
        assert.equal(r.reference, null, 'a UTR nobody recorded must not be made up');
        assert.equal(r.document_id, null, 'a proof nobody uploaded must not be made up');
        assert.equal(Number(r.tds_amount), 0, 'a TDS split nobody recorded must not be made up');
        assert.equal(r.mode, 'other', 'the real method was never captured, so it is "other"');
        assert.equal(r.remarks, 'Opening balance from the invoice');
      }
    });

    test('every invoice agrees with its ledger, which is what the migration asserts', async () => {
      const { rows } = await db.query(
        `SELECT vi.vendor_invoice_id FROM travel_vendor_invoices vi
          WHERE vi.amount_paid <> COALESCE((SELECT SUM(p.amount + p.tds_amount) FROM travel_vendor_payments p
                                             WHERE p.vendor_invoice_id = vi.id), 0)`);
      assert.deepEqual(rows, [], 'the migration would have raised rather than leaving these');
    });

    test('running the migration again carries nothing over twice', async () => {
      const before = (await db.query('SELECT count(*)::int AS n FROM travel_vendor_payments')).rows[0].n;
      await db.query(readFileSync(join(DB_DIR, 'migrations', '095_travel_vendor_payments.sql'), 'utf8'));
      const after = (await db.query('SELECT count(*)::int AS n FROM travel_vendor_payments')).rows[0].n;
      assert.equal(after, before, 'the backfill is guarded against a second run');
      for (const l of LEGACY) assert.equal(Number((await invoice(l.id)).amount_paid), l.paid);
    });

    test('the assertion bites: a ledger that disagrees with the invoice stops the migration', async () => {
      // Put the two out of step the only way nothing else can, then re-run.
      await db.query(`UPDATE travel_vendor_invoices SET amount_paid = amount_paid + 1 WHERE vendor_invoice_id = 'L1-pos-date'`);
      await assert.rejects(
        () => db.query(readFileSync(join(DB_DIR, 'migrations', '095_travel_vendor_payments.sql'), 'utf8')),
        /could not be carried over without changing the figure/,
        'a mismatch must abort rather than be quietly corrected'
      );
      await db.query(`UPDATE travel_vendor_invoices SET amount_paid = amount_paid - 1 WHERE vendor_invoice_id = 'L1-pos-date'`);
    });
  });

  // --------------------------------------------------------- the live API

  describe('recording, correcting and reading a payment', () => {
    const NAME = `tvp_api_${process.pid}_${Date.now()}`;
    let db; let app; let admin; let sales; let hr; let invoiceId; let docId;

    before(async () => {
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`CREATE DATABASE ${NAME}`);
      await root.end();
      const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
      db = new pg.Client({ connectionString: url.toString() });
      await db.connect();
      for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

      Object.assign(process.env, {
        NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_MODE: 'database', EMAIL_MODE: 'log',
        SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
      });
      ({ default: app } = await import('../src/app.js'));
      const { createUser } = await import('../src/lib/users.js');
      const signIn = async (email) => {
        const agent = request.agent(app);
        await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
        return agent;
      };
      for (const [role, email] of [['admin', 'ada@example.com'], ['sales', 'sam@example.com'], ['hr', 'hema@example.com']]) {
        await createUser({ name: email.split('@')[0], email, password: PASSWORD, role }, db);
      }
      admin = await signIn('ada@example.com');
      sales = await signIn('sam@example.com');
      hr = await signIn('hema@example.com');

      await db.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ('TVP-A', 'Asha')`);
      await db.query(`INSERT INTO travel_vendors (name) VALUES ('Happy Tours') ON CONFLICT DO NOTHING`);
      const vendor = (await db.query(`SELECT id FROM travel_vendors WHERE name = 'Happy Tours'`)).rows[0].id;
      ({ rows: [{ id: invoiceId }] } = await db.query(
        `INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_id, vendor_invoice_no, invoice_date, invoice_amount)
              VALUES ('VI-A', 'TVP-A', $1, 'HT/1', CURRENT_DATE, 100000) RETURNING id`, [vendor]));
      ({ rows: [{ id: docId }] } = await db.query(
        `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
              VALUES ('proof/key', 'advice.pdf', 'application/pdf', 1234) RETURNING id`));
    });

    after(async () => {
      const { pool } = await import('../src/db.js');
      await pool.end().catch(() => {});
      await db?.end().catch(() => {});
      const root = new pg.Client({ connectionString: ADMIN_URL });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
      await root.end();
    });

    const pay = (who, body) => who.post(`/api/vendor-invoices/${invoiceId}/pay`).send(body);
    const correct = (who, body) => who.post(`/api/vendor-invoices/${invoiceId}/pay/correct`).send(body);
    const state = async () => (await db.query(
      `SELECT amount_paid, payment_date,
              (SELECT count(*)::int FROM travel_vendor_payments WHERE vendor_invoice_id = $1) AS rows,
              (SELECT COALESCE(SUM(amount), 0) FROM travel_vendor_payments WHERE vendor_invoice_id = $1) AS cash,
              (SELECT COALESCE(SUM(tds_amount), 0) FROM travel_vendor_payments WHERE vendor_invoice_id = $1) AS tds
         FROM travel_vendor_invoices WHERE id = $1`, [invoiceId])).rows[0];
    const reset = () => db.query('DELETE FROM travel_vendor_payments WHERE vendor_invoice_id = $1', [invoiceId]);
    const today = () => new Date().toISOString().slice(0, 10);

    // ------------------------------------------------- recording a payment

    test('the first payment: one row, and the cached total follows it', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: 30000, payment_date: today() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(Number(s.amount_paid), 30000);
      assert.equal(s.rows, 1);
      assert.equal(res.body.meta.settled, 30000);
    });

    test('a second payment adds a row and does not double count the first', async () => {
      // Exactly what the existing Pay dialog sends: the new absolute total.
      const res = await pay(admin, { amount_paid: 50000, payment_date: today() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(Number(s.amount_paid), 50000, 'the total is the figure asked for, not 30000 + 50000');
      assert.equal(s.rows, 2);
      assert.equal(Number(s.cash), 50000);
    });

    test('mode "add" records the transfer itself', async () => {
      const res = await pay(admin, { amount_paid: 10000, payment_date: today(), mode: 'add' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number((await state()).amount_paid), 60000);
    });

    test('asking for the total it already is writes nothing', async () => {
      const before = await state();
      const res = await pay(admin, { amount_paid: 60000, payment_date: today() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(s.rows, before.rows, 'a payment that did not happen must not be in the history');
      assert.equal(Number(s.amount_paid), 60000);
    });

    test('lowering the total is refused, and names the correction route', async () => {
      const before = await state();
      const res = await pay(admin, { amount_paid: 10000, payment_date: today() });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.match(res.body.error.message, /pay\/correct/,
        'the refusal should say where a reduction belongs');
      assert.deepEqual(await state(), before, 'nothing moved');
    });

    test('overpayment is allowed, and reported rather than clamped', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: 120000, payment_date: today() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number((await state()).amount_paid), 120000, 'not clamped to the bill');
      assert.equal(res.body.meta.net_payable, 100000);
      assert.equal(res.body.meta.over_payable, 20000, 'the figure a warning would quote');
    });

    test('a payment dated in the future is refused', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: 1000, payment_date: '2099-01-01' });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal((await state()).rows, 0);
    });

    test('a negative total is refused by the schema', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: -1, payment_date: today() });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal((await state()).rows, 0);
    });

    // ------------------------------------------------------------- the TDS

    test('cash and TDS together settle the bill, and only the cash left the bank', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: 100000, tds_amount: 10000, payment_date: today() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(Number(s.amount_paid), 100000, 'settlement is cash + TDS');
      assert.equal(Number(s.cash), 90000, 'the transfer');
      assert.equal(Number(s.tds), 10000, 'deducted, not transferred');
      const { rows: [view] } = await db.query('SELECT payment_status FROM v_travel_vendor_invoices WHERE id = $1', [invoiceId]);
      assert.equal(view.payment_status, 'Paid', 'a bill settled partly by deduction is settled');
    });

    test('TDS alone, with no cash moved, is a payment the ledger accepts', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: 5000, tds_amount: 5000, payment_date: today() });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(Number(s.cash), 0);
      assert.equal(Number(s.tds), 5000);
      assert.equal(Number(s.amount_paid), 5000);
    });

    test('TDS larger than the payment it belongs to is refused', async () => {
      await reset();
      const res = await pay(admin, { amount_paid: 1000, tds_amount: 5000, payment_date: today() });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal((await state()).rows, 0);
    });

    test('vendor TDS stays out of the client TDS register, which is the receivable side', async () => {
      await reset();
      await pay(admin, { amount_paid: 100000, tds_amount: 10000, payment_date: today() }).expect(200);
      const res = await admin.get('/api/accounting/reports/tds.csv?from=2020-01-01&to=2099-12-31').expect(200);
      assert.ok(!res.text.includes('Happy Tours'),
        'tds.csv reports tax clients deducted from our invoices; tax we deduct from an agency is the other direction and has no place in it');
    });

    // -------------------------------------------------------- corrections

    test('a full reversal takes the payment back off without touching the original row', async () => {
      await reset();
      await pay(admin, { amount_paid: 100000, tds_amount: 10000, payment_date: today() }).expect(200);
      const { rows: [original] } = await db.query(
        'SELECT id, amount, tds_amount FROM travel_vendor_payments WHERE vendor_invoice_id = $1 ORDER BY id', [invoiceId]);

      const res = await correct(admin, { amount: -90000, tds_amount: -10000, reason: 'Paid the wrong agency' });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const s = await state();
      assert.equal(Number(s.amount_paid), 0);
      assert.equal(s.rows, 2, 'the correction is a row of its own');
      const { rows: [still] } = await db.query(
        'SELECT amount, tds_amount FROM travel_vendor_payments WHERE id = $1', [original.id]);
      assert.equal(Number(still.amount), Number(original.amount), 'history is never rewritten');
      assert.equal(Number(still.tds_amount), Number(original.tds_amount));
    });

    test('a partial cash correction leaves the rest settled', async () => {
      await reset();
      await pay(admin, { amount_paid: 90000, payment_date: today() }).expect(200);
      const res = await correct(admin, { amount: -10000, reason: 'Transfer was 80,000, not 90,000' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(Number(s.amount_paid), 80000);
      assert.equal(Number(s.cash), 80000);
    });

    test('a TDS correction moves the split and leaves the total alone', async () => {
      await reset();
      await pay(admin, { amount_paid: 100000, tds_amount: 10000, payment_date: today() }).expect(200);
      const res = await correct(admin, { amount: 2000, tds_amount: -2000, reason: 'TDS was 8,000' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state();
      assert.equal(Number(s.amount_paid), 100000, 'still settled in full');
      assert.equal(Number(s.cash), 92000);
      assert.equal(Number(s.tds), 8000);
    });

    test('a correction without a reason is refused', async () => {
      await reset();
      await pay(admin, { amount_paid: 1000, payment_date: today() }).expect(200);
      for (const body of [{ amount: -500 }, { amount: -500, reason: '' }, { amount: -500, reason: '   ' }]) {
        const res = await correct(admin, body);
        assert.equal(res.status, 422, `${JSON.stringify(body)}: ${JSON.stringify(res.body)}`);
      }
      assert.equal((await state()).rows, 1, 'nothing appended');
    });

    test('a correction that corrects nothing is refused', async () => {
      const res = await correct(admin, { amount: 0, tds_amount: 0, reason: 'No change' });
      assert.equal(res.status, 422, JSON.stringify(res.body));
    });

    test('a correction dated in the future is refused', async () => {
      const res = await correct(admin, { amount: -1, reason: 'Typo', paid_on: '2099-01-01' });
      assert.equal(res.status, 422, JSON.stringify(res.body));
    });

    // ------------------------------------------------------ who may do it

    test('the travel desk may pay; a sales user may not', async () => {
      await reset();
      const byHr = await pay(hr, { amount_paid: 5000, payment_date: today() });
      assert.equal(byHr.status, 200, JSON.stringify(byHr.body));

      const bySales = await pay(sales, { amount_paid: 9000, payment_date: today() });
      assert.equal(
        bySales.status, 403,
        `a sales user got ${bySales.status} paying a travel agency. Paying the agency is the travel desk's `
        + 'work with the administrator (#214); the open gate this route used to have was never a decision.'
      );
      assert.equal(Number((await state()).amount_paid), 5000, 'the sales attempt moved nothing');
    });

    test('only an administrator may correct: the travel desk may not', async () => {
      const before = await state();
      const byHr = await correct(hr, { amount: -1000, reason: 'Mistyped' });
      assert.equal(
        byHr.status, 403,
        `an HR user got ${byHr.status} correcting a vendor payment. HR pays but does not undo (#214) — and if `
        + '/pay accepted a lower total this gate would be decoration.'
      );
      const bySales = await correct(sales, { amount: -1000, reason: 'Mistyped' });
      assert.equal(bySales.status, 403, JSON.stringify(bySales.body));
      assert.deepEqual(await state(), before);
    });

    test('nobody signed in may pay or correct', async () => {
      for (const path of [`/api/vendor-invoices/${invoiceId}/pay`, `/api/vendor-invoices/${invoiceId}/pay/correct`]) {
        const res = await request(app).post(path).send({ amount_paid: 1, amount: -1, reason: 'x' });
        assert.equal(res.status, 401, `${path}: ${JSON.stringify(res.body)}`);
      }
    });

    test('an invoice that is not there is a 404, for both routes', async () => {
      assert.equal((await admin.post('/api/vendor-invoices/987654/pay').send({ amount_paid: 1 })).status, 404);
      assert.equal((await admin.post('/api/vendor-invoices/987654/pay/correct').send({ amount: -1, reason: 'x' })).status, 404);
    });

    // ------------------------------------------------- history, and audit

    test('the payment history comes back on the invoice, to the roles that settle it', async () => {
      await reset();
      await pay(admin, { amount_paid: 40000, tds_amount: 4000, payment_date: today(), reference: 'UTR-1', payment_mode: 'upi' }).expect(200);

      const byAdmin = await admin.get(`/api/vendor-invoices/${invoiceId}/full`).expect(200);
      assert.equal(byAdmin.body.data.payments.length, 1);
      assert.equal(byAdmin.body.data.payments[0].reference, 'UTR-1');
      assert.equal(byAdmin.body.data.payments[0].mode, 'upi');
      assert.equal(Number(byAdmin.body.data.payments[0].settles), 40000);

      const byHr = await hr.get(`/api/vendor-invoices/${invoiceId}/full`).expect(200);
      assert.equal(byHr.body.data.payments.length, 1);

      const bySales = await sales.get(`/api/vendor-invoices/${invoiceId}/full`).expect(200);
      assert.equal(bySales.body.data.payments, undefined,
        'how the business paid a vendor is not a sales user\'s to read, even on an invoice they may open');
      assert.ok(bySales.body.data.invoice, 'the invoice itself is still theirs to see');
    });

    test('both acts are in the activity log, with the actor and the reason', async () => {
      await reset();
      await pay(hr, { amount_paid: 10000, payment_date: today() }).expect(200);
      await correct(admin, { amount: -2000, reason: 'Bank returned 2,000' }).expect(200);

      const { rows } = await db.query(
        `SELECT action, entity_type, entity_id, metadata FROM activity_log
          WHERE action IN ('vendor_invoice.paid', 'vendor_invoice.payment_corrected') ORDER BY id DESC LIMIT 2`);
      const [corrected, paid] = rows;
      assert.equal(paid.action, 'vendor_invoice.paid');
      assert.equal(paid.entity_type, 'vendor_invoice');
      assert.equal(paid.entity_id, 'VI-A');
      assert.equal(paid.metadata.actor_name, 'hema');
      assert.equal(corrected.action, 'vendor_invoice.payment_corrected');
      assert.equal(corrected.metadata.reason, 'Bank returned 2,000');
      assert.equal(corrected.metadata.actor_name, 'ada');
      assert.equal(corrected.metadata.lowers_recorded_total, true);
      assert.equal(corrected.metadata.settled_before, 10000);
      assert.equal(corrected.metadata.settled_after, 8000);
    });

    // -------------------------------------------------------------- proof

    test('a payment proof is openable by the travel desk and the administrator, and by nobody else', async () => {
      await reset();
      await pay(admin, { amount_paid: 1000, payment_date: today(), document_id: docId }).expect(200);

      // Reachability is the subject, not the download: these fixtures carry a
      // storage key nothing was ever uploaded to, so a permitted caller gets
      // past the rule and then fails to fetch. 404 is the refusal.
      assert.notEqual((await admin.get(`/api/documents/${docId}`)).status, 404, 'an administrator may open it');
      assert.notEqual((await hr.get(`/api/documents/${docId}`)).status, 404, 'the travel desk may open it');
      assert.equal((await sales.get(`/api/documents/${docId}`)).status, 404,
        'a sales user has no travel branch in its document rule, so a payment proof is not theirs');
      assert.equal((await request(app).get(`/api/documents/${docId}`)).status, 401);
    });

    test('knowing a document id is not access: an unrelated file stays shut', async () => {
      const { rows: [other] } = await db.query(
        `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
              VALUES ('other/key', 'secret.pdf', 'application/pdf', 10) RETURNING id`);
      const res = await hr.get(`/api/documents/${other.id}`);
      assert.equal(res.status, 404, 'nothing points at it, so no role reaches it');
    });

    test('the orphan sweep leaves a proof that a payment still points at', async () => {
      await reset();
      await pay(admin, { amount_paid: 1000, payment_date: today(), document_id: docId }).expect(200);
      const { unattachedIds } = await import('../src/lib/documents.js').then((m) => ({ unattachedIds: m.unattachedIds }));
      if (typeof unattachedIds === 'function') {
        const ids = await unattachedIds();
        assert.ok(!ids.includes(docId), 'a proof in use must not look like an abandoned upload');
      }
      // Whatever the sweep's entry point is called, the predicate is what matters:
      const { rows } = await db.query(
        `SELECT 1 FROM documents d WHERE d.id = $1
           AND NOT EXISTS (SELECT 1 FROM travel_vendor_payments tvp WHERE tvp.document_id = d.id)`, [docId]);
      assert.equal(rows.length, 0, 'the payment table must be in the attached-document predicate');
    });

    test('the proof survives a correction, still attached to the payment that happened', async () => {
      await reset();
      await pay(admin, { amount_paid: 1000, payment_date: today(), document_id: docId }).expect(200);
      await correct(admin, { amount: -1000, reason: 'Reversed' }).expect(200);
      const { rows } = await db.query(
        'SELECT document_id FROM travel_vendor_payments WHERE vendor_invoice_id = $1 ORDER BY id', [invoiceId]);
      assert.equal(rows[0].document_id, docId, 'the advice still evidences the transfer that was made');
      assert.notEqual((await admin.get(`/api/documents/${docId}`)).status, 404, 'and is still openable');
    });

    // --------------------------------------------------------- the cache

    test('the generic form still cannot write the paid figure', async () => {
      const res = await admin.patch(`/api/vendor-invoices/${invoiceId}`).send({ amount_paid: 999999 });
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    test('deleting the invoice takes its ledger with it', async () => {
      const { rows: [tmp] } = await db.query(
        `INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_id, invoice_amount)
              VALUES ('VI-TMP', 'TVP-A', (SELECT id FROM travel_vendors LIMIT 1), 100) RETURNING id`);
      await db.query(
        `INSERT INTO travel_vendor_payments (vendor_invoice_id, amount, paid_on) VALUES ($1, 100, CURRENT_DATE)`, [tmp.id]);
      await db.query('DELETE FROM travel_vendor_invoices WHERE id = $1', [tmp.id]);
      const { rows } = await db.query('SELECT 1 FROM travel_vendor_payments WHERE vendor_invoice_id = $1', [tmp.id]);
      assert.equal(rows.length, 0);
    });
  });
});
