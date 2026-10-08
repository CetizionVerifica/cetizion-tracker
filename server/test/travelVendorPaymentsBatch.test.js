import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * One transfer, several of one agency's bills (#214 §2.6).
 *
 * An agency is paid monthly, so this is how the business actually pays one:
 * a single transfer with a single UTR, settling a dozen bills. Four things
 * are held in place here, and each of them is the kind of thing that is
 * cheap to get right now and expensive to discover later.
 *
 * **One agency.** Proved against the locked rows rather than trusted from
 * the request. A transfer that paid two agencies at once is a reference that
 * reconciles against nothing.
 *
 * **All of it or none of it.** One transaction. Every refusal below is
 * followed by a check that no ledger row and no cached figure moved — not
 * just that the status was 4xx. A partial batch is the failure mode worth
 * testing for, because it is the one nobody would notice until the money
 * did not add up.
 *
 * **The two legs.** An allocation's `amount` is the cash that left the bank
 * for that bill and `tds_amount` is what was deducted; settlement is their
 * sum. This is deliberately not `/pay`'s shape, where `amount_paid` is the
 * settlement total — that field predates the ledger and its callers. The
 * test below pins both so neither drifts into the other.
 *
 * **Who.** The travel desk and the administrator. Sales may read a bill and
 * may not pay it, in bulk no more than singly.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const PASSWORD = 'a-good-long-test-password';

describe('bulk vendor payments (#214)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const NAME = `tvp_batch_${process.pid}_${Date.now()}`;
  let db; let dbUrl; let app; let admin; let sales; let hr; let anonymous;
  let vendorA; let vendorB; let docId;
  /** vendor_invoice_id → row id, for the bills seeded fresh before each test. */
  let id = {};

  const BILLS = [
    // Vendor A: one untouched, one part paid, one with a credit note on it.
    { ref: 'PRD-A1', vendor: 'A', amount: 100000 },
    { ref: 'PRD-A2', vendor: 'A', amount: 50000, paid: 20000 },
    { ref: 'PRD-A3', vendor: 'A', amount: 80000 },
    // Vendor B, for the mixed-vendor refusal.
    { ref: 'PRD-B1', vendor: 'B', amount: 60000 },
  ];

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    dbUrl = url.toString();
    db = new pg.Client({ connectionString: dbUrl });
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
    anonymous = request(app);

    await db.query(`INSERT INTO travel_logs (travel_id, employee_name) VALUES ('PRD-T1', 'Asha'), ('PRD-T2', 'Vijay')`);
    await db.query(`INSERT INTO travel_vendors (name) VALUES ('Prd Agency A'), ('Prd Agency B') ON CONFLICT DO NOTHING`);
    vendorA = (await db.query(`SELECT id FROM travel_vendors WHERE name = 'Prd Agency A'`)).rows[0].id;
    vendorB = (await db.query(`SELECT id FROM travel_vendors WHERE name = 'Prd Agency B'`)).rows[0].id;
    ({ rows: [{ id: docId }] } = await db.query(
      `INSERT INTO documents (storage_key, file_name, content_type, size_bytes)
            VALUES ('prd/advice', 'transfer-advice.pdf', 'application/pdf', 2048) RETURNING id`));
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

  /**
   * Every test starts from the same four bills.
   *
   * Rebuilt rather than cleaned, because the point of most of these tests is
   * that nothing moved, and "nothing moved" is only a claim worth making
   * against a state that was known before the request.
   */
  beforeEach(async () => {
    await db.query(`DELETE FROM travel_vendor_payments`);
    // The trail too: "nothing was audited" is only a claim worth making about
    // the one request under test.
    await db.query(`DELETE FROM activity_log WHERE entity_type = 'vendor_invoice'`);
    await db.query(`DELETE FROM travel_vendor_invoices WHERE vendor_invoice_id LIKE 'PRD-%'`);
    id = {};
    for (const bill of BILLS) {
      const { rows: [row] } = await db.query(
        `INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_id, vendor_invoice_no, invoice_date, invoice_amount)
              VALUES ($1, 'PRD-T1', $2, $3, CURRENT_DATE, $4) RETURNING id`,
        [bill.ref, bill.vendor === 'A' ? vendorA : vendorB, `AG/${bill.ref}`, bill.amount]
      );
      id[bill.ref] = row.id;
      if (bill.paid) {
        await db.query(
          `INSERT INTO travel_vendor_payments (vendor_invoice_id, amount, paid_on, mode, reference)
                VALUES ($1, $2, CURRENT_DATE, 'bank_transfer', 'OPENING')`,
          [row.id, bill.paid]
        );
      }
    }
  });

  const batch = (who, body) => who.post('/api/vendor-payments/batch').send(body);
  const today = () => new Date().toISOString().slice(0, 10);

  /** The ledger and the caches, for every PRD bill, as one comparable value. */
  const ledger = async () => (await db.query(
    `SELECT vi.vendor_invoice_id AS ref, vi.amount_paid, vi.payment_date,
            (SELECT count(*)::int FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id) AS rows,
            (SELECT COALESCE(SUM(p.amount), 0) FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id) AS cash,
            (SELECT COALESCE(SUM(p.tds_amount), 0) FROM travel_vendor_payments p WHERE p.vendor_invoice_id = vi.id) AS tds
       FROM travel_vendor_invoices vi
      WHERE vi.vendor_invoice_id LIKE 'PRD-%'
      ORDER BY vi.vendor_invoice_id`
  )).rows;

  const auditFor = async (ref) => (await db.query(
    `SELECT metadata FROM activity_log WHERE entity_type = 'vendor_invoice' AND entity_id = $1 AND action = 'vendor_invoice.paid' ORDER BY id`,
    [ref]
  )).rows;

  // ------------------------------------------------------------ happy path

  test('an administrator settles two of one agency\'s bills with one transfer', async () => {
    const res = await batch(admin, {
      payment_date: today(), payment_mode: 'bank_transfer', reference: 'UTR-PRD-1', document_id: docId,
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 100000 },
        { vendor_invoice_id: id['PRD-A2'], amount: 30000 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await ledger();
    const a1 = rows.find((r) => r.ref === 'PRD-A1');
    const a2 = rows.find((r) => r.ref === 'PRD-A2');
    assert.equal(a1.rows, 1, 'one ledger row of its own');
    assert.equal(Number(a1.amount_paid), 100000, 'and the cache the old readers use follows it');
    assert.equal(a2.rows, 2, 'the opening payment is still there beside the new one');
    assert.equal(Number(a2.amount_paid), 50000);
    assert.equal(String(a1.payment_date).slice(0, 10), today());

    assert.equal(res.body.meta.count, 2);
    assert.equal(res.body.meta.transferred, 130000);
    assert.equal(res.body.meta.tds, 0);
    assert.equal(res.body.meta.settled, 130000);
    assert.equal(res.body.data.vendor_id, vendorA);
    assert.equal(res.body.data.reference, 'UTR-PRD-1');
  });

  test('the travel desk may do it too', async () => {
    const res = await batch(hr, {
      payment_date: today(), reference: 'UTR-PRD-HR',
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 10000 },
        { vendor_invoice_id: id['PRD-A3'], amount: 20000 },
      ],
    });
    assert.equal(res.status, 200, `paying the agency is the travel desk's work: ${JSON.stringify(res.body)}`);
    const rows = await ledger();
    assert.equal(Number(rows.find((r) => r.ref === 'PRD-A1').amount_paid), 10000);
    assert.equal(Number(rows.find((r) => r.ref === 'PRD-A3').amount_paid), 20000);
  });

  test('every bill gets its own payment row carrying the one shared reference', async () => {
    await batch(admin, {
      payment_date: today(), payment_mode: 'upi', reference: 'UTR-SHARED', remarks: 'September bills',
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: id['PRD-A3'], amount: 2000 },
      ],
    }).expect(200);

    const { rows } = await db.query(
      `SELECT p.amount, p.mode, p.reference, p.remarks, p.recorded_by, vi.vendor_invoice_id AS ref
         FROM travel_vendor_payments p JOIN travel_vendor_invoices vi ON vi.id = p.vendor_invoice_id
        WHERE p.reference = 'UTR-SHARED' ORDER BY vi.vendor_invoice_id`
    );
    assert.equal(rows.length, 2, 'a row per bill, not one row for the transfer');
    assert.deepEqual(rows.map((r) => r.ref), ['PRD-A1', 'PRD-A3']);
    for (const row of rows) {
      assert.equal(row.mode, 'upi');
      assert.equal(row.remarks, 'September bills');
      assert.ok(row.recorded_by, 'the account that recorded it');
    }
  });

  test('each bill gets its own audit entry, and says which transfer it was part of', async () => {
    await batch(admin, {
      payment_date: today(), reference: 'UTR-AUDIT',
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 90000, tds_amount: 10000 },
        { vendor_invoice_id: id['PRD-A3'], amount: 5000 },
      ],
    }).expect(200);

    const a1 = await auditFor('PRD-A1');
    const a3 = await auditFor('PRD-A3');
    assert.equal(a1.length, 1, 'one auditable payment event for this bill');
    assert.equal(a3.length, 1);
    assert.equal(Number(a1[0].metadata.amount), 90000);
    assert.equal(Number(a1[0].metadata.tds_amount), 10000);
    assert.equal(Number(a1[0].metadata.settles), 100000);
    assert.equal(a1[0].metadata.reference, 'UTR-AUDIT');
    assert.equal(a1[0].metadata.mode, 'bank_transfer');
    assert.equal(a1[0].metadata.batch.size, 2, 'the transfer the entry belonged to');
    assert.equal(a1[0].metadata.batch.reference, 'UTR-AUDIT');
    assert.equal(a1[0].metadata.has_proof, false);
    // The advice itself is never in the log, only that there was one.
    assert.equal(a1[0].metadata.document_id, undefined);
  });

  // ------------------------------------------------------- authorization

  test('a sales user is refused, and nothing moves', async () => {
    const before = await ledger();
    const res = await batch(sales, {
      payment_date: today(),
      allocations: [{ vendor_invoice_id: id['PRD-A1'], amount: 1000 }],
    });
    assert.equal(res.status, 403, 'paying an agency is not a sales user\'s, in bulk no more than singly');
    assert.deepEqual(await ledger(), before);
  });

  test('nobody signed in is refused with 401', async () => {
    const res = await batch(anonymous, {
      payment_date: today(),
      allocations: [{ vendor_invoice_id: id['PRD-A1'], amount: 1000 }],
    });
    assert.equal(res.status, 401);
  });

  // --------------------------------------------------------- one agency

  test('bills of two agencies in one transfer are refused, and nothing is written', async () => {
    const before = await ledger();
    const res = await batch(admin, {
      payment_date: today(), reference: 'UTR-MIXED',
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: id['PRD-B1'], amount: 2000 },
      ],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(res.body.error.message, /one agency/i, 'the refusal says what the rule is');
    assert.match(res.body.error.message, /Prd Agency A and Prd Agency B/, 'and names the agencies');
    assert.deepEqual(await ledger(), before, 'not even the valid allocation was written');
    assert.equal((await auditFor('PRD-A1')).length, 0, 'and nothing was audited');
  });

  test('a bill that does not exist takes the whole transfer down', async () => {
    const before = await ledger();
    const res = await batch(admin, {
      payment_date: today(),
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: 9999999, amount: 2000 },
      ],
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.match(res.body.error.message, /Nothing has been recorded/);
    assert.deepEqual(await ledger(), before);
  });

  test('the same bill twice in one transfer is refused', async () => {
    const before = await ledger();
    const res = await batch(admin, {
      payment_date: today(),
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: id['PRD-A1'], amount: 2000 },
      ],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.deepEqual(await ledger(), before);
  });

  // ------------------------------------------------------- all or nothing

  test('one bad allocation and none of the good ones are written', async () => {
    const before = await ledger();
    for (const bad of [
      { vendor_invoice_id: id['PRD-A3'], amount: -5000 },
      { vendor_invoice_id: id['PRD-A3'], amount: 0 },
      { vendor_invoice_id: id['PRD-A3'], amount: 0, tds_amount: 0 },
      { vendor_invoice_id: id['PRD-A3'], amount: 'not a number' },
      { vendor_invoice_id: id['PRD-A3'], amount: 1000, tds_amount: -1 },
    ]) {
      const res = await batch(admin, {
        payment_date: today(),
        allocations: [{ vendor_invoice_id: id['PRD-A1'], amount: 10000 }, bad],
      });
      assert.ok(res.status >= 400 && res.status < 500, `${JSON.stringify(bad)} answered ${res.status}`);
      assert.deepEqual(await ledger(), before, `${JSON.stringify(bad)} left something behind`);
    }
  });

  test('a proof that is not a document takes the transfer down with it', async () => {
    // The constraint fires on the first insert rather than up front, which is
    // exactly the case the transaction is for: a 4xx, and nothing written.
    const before = await ledger();
    const res = await batch(admin, {
      payment_date: today(), document_id: 9999999,
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: id['PRD-A3'], amount: 1000 },
      ],
    });
    assert.ok(res.status >= 400 && res.status < 500, `answered ${res.status}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(await ledger(), before, 'the allocation that would have succeeded was taken back');
  });

  test('a transfer dated in the future is refused atomically', async () => {
    const before = await ledger();
    const res = await batch(admin, {
      payment_date: '2099-01-01',
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: id['PRD-A3'], amount: 1000 },
      ],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.deepEqual(await ledger(), before);
  });

  test('a negative allocation is refused: there is no bulk correction', async () => {
    const before = await ledger();
    const res = await batch(admin, {
      payment_date: today(),
      allocations: [{ vendor_invoice_id: id['PRD-A2'], amount: -20000 }],
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.deepEqual(await ledger(), before);
  });

  // ------------------------------------------- partial, full, overpayment

  test('one transfer can part-pay one bill, close another and overpay a third', async () => {
    const res = await batch(admin, {
      payment_date: today(), reference: 'UTR-MIXED-AMOUNTS',
      allocations: [
        // 30,000 of 100,000: partial.
        { vendor_invoice_id: id['PRD-A1'], amount: 30000 },
        // 30,000 on top of the 20,000 already paid: closes a 50,000 bill.
        { vendor_invoice_id: id['PRD-A2'], amount: 30000 },
        // 85,000 against an 80,000 bill: 5,000 over, allowed.
        { vendor_invoice_id: id['PRD-A3'], amount: 85000 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { rows: statuses } = await db.query(
      `SELECT vendor_invoice_id AS ref, payment_status FROM v_travel_vendor_invoices
        WHERE vendor_invoice_id LIKE 'PRD-A%' ORDER BY vendor_invoice_id`
    );
    assert.deepEqual(statuses.map((s) => [s.ref, s.payment_status]), [
      ['PRD-A1', 'Partially Paid'],
      ['PRD-A2', 'Paid'],
      ['PRD-A3', 'Paid'],
    ]);

    const by = Object.fromEntries(res.body.data.allocations.map((a) => [a.invoice_ref, a]));
    assert.equal(by['PRD-A1'].over_payable, 0);
    assert.equal(by['PRD-A2'].over_payable, 0);
    assert.equal(by['PRD-A3'].over_payable, 5000, 'reported per bill, never clamped');
    assert.equal(by['PRD-A2'].settled_before, 20000, 'measured against what the ledger already settled');
    assert.equal(by['PRD-A2'].settled_after, 50000);
    assert.equal(res.body.meta.overpaid, 1);
    assert.equal(res.body.meta.over_payable, 5000);
  });

  test('overpayment is not clamped in the ledger either', async () => {
    await batch(admin, {
      payment_date: today(),
      allocations: [{ vendor_invoice_id: id['PRD-A3'], amount: 200000 }],
    }).expect(200);
    const rows = await ledger();
    assert.equal(Number(rows.find((r) => r.ref === 'PRD-A3').amount_paid), 200000);
  });

  // --------------------------------------------------------------- the TDS

  test('cash and TDS are kept apart per bill, and together settle it', async () => {
    const res = await batch(admin, {
      payment_date: today(), reference: 'UTR-TDS',
      allocations: [
        // A full settlement of 100,000 by a 90,000 transfer.
        { vendor_invoice_id: id['PRD-A1'], amount: 90000, tds_amount: 10000 },
        // A different deduction on the next bill, and no cash at all on it.
        { vendor_invoice_id: id['PRD-A3'], amount: 0, tds_amount: 8000 },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = await ledger();
    const a1 = rows.find((r) => r.ref === 'PRD-A1');
    const a3 = rows.find((r) => r.ref === 'PRD-A3');
    assert.equal(Number(a1.cash), 90000, 'what left the bank');
    assert.equal(Number(a1.tds), 10000, 'deducted, not transferred');
    assert.equal(Number(a1.amount_paid), 100000, 'settlement is cash + TDS');
    assert.equal(Number(a3.cash), 0);
    assert.equal(Number(a3.tds), 8000);
    assert.equal(Number(a3.amount_paid), 8000);

    const { rows: [view] } = await db.query(
      `SELECT payment_status FROM v_travel_vendor_invoices WHERE vendor_invoice_id = 'PRD-A1'`);
    assert.equal(view.payment_status, 'Paid', 'a bill settled partly by deduction is settled');

    // The totals the success line quotes, worked out by the server.
    assert.equal(res.body.meta.transferred, 90000);
    assert.equal(res.body.meta.tds, 18000);
    assert.equal(res.body.meta.settled, 108000);
  });

  test('an allocation\'s amount is the cash, not the settlement total', async () => {
    // The one place the batch route differs from /pay, pinned on purpose: a
    // 90,000 + 10,000 allocation settles 100,000, where the same figures sent
    // to /pay as amount_paid: 90000, tds_amount: 10000 would settle 90,000.
    await batch(admin, {
      payment_date: today(),
      allocations: [{ vendor_invoice_id: id['PRD-A1'], amount: 90000, tds_amount: 10000 }],
    }).expect(200);
    const viaBatch = Number((await ledger()).find((r) => r.ref === 'PRD-A1').amount_paid);

    await db.query('DELETE FROM travel_vendor_payments');
    await admin.post(`/api/vendor-invoices/${id['PRD-A1']}/pay`)
      .send({ amount_paid: 90000, tds_amount: 10000, payment_date: today(), mode: 'add' })
      .expect(200);
    const viaSingle = Number((await ledger()).find((r) => r.ref === 'PRD-A1').amount_paid);

    assert.equal(viaBatch, 100000);
    assert.equal(viaSingle, 90000);
  });

  // ------------------------------------------------------------ the proof

  test('one advice proves the transfer and every row points at the same one', async () => {
    await batch(admin, {
      payment_date: today(), reference: 'UTR-PROOF', document_id: docId,
      allocations: [
        { vendor_invoice_id: id['PRD-A1'], amount: 1000 },
        { vendor_invoice_id: id['PRD-A3'], amount: 2000 },
      ],
    }).expect(200);

    const { rows } = await db.query(
      'SELECT id, document_id FROM travel_vendor_payments WHERE document_id = $1 ORDER BY id', [docId]);
    assert.equal(rows.length, 2, 'the file is referenced, not uploaded twice');

    const { assertDocumentReadable } = await import('../src/lib/documents.js');
    // The travel desk and the administrator may open it: it is a travel file.
    await assertDocumentReadable({ unrestricted: true, ownerId: null }, docId);
    await assertDocumentReadable({ unrestricted: false, ownerId: 99, hr: true }, docId);
    // A sales user may not. 404, as every refused document is.
    await assert.rejects(
      () => assertDocumentReadable({ unrestricted: false, ownerId: 99 }, docId),
      (err) => err.status === 404
    );

    // Still referenced after one of the rows it proves is corrected away, so
    // the daily purge of unattached uploads cannot take it.
    await db.query('DELETE FROM travel_vendor_payments WHERE id = $1', [rows[0].id]);
    const { rowCount } = await db.query(
      'SELECT 1 FROM travel_vendor_payments WHERE document_id = $1', [docId]);
    assert.equal(rowCount, 1, 'the advice is still the proof of the rest of the transfer');
    await assertDocumentReadable({ unrestricted: false, ownerId: 99, hr: true }, docId);
  });

  // ------------------------------------------------------------ the limit

  test('a transfer at the limit is accepted and one past it is refused', async () => {
    const { MAX_BATCH_ALLOCATIONS } = await import('../src/routes/workflow.js');
    assert.equal(MAX_BATCH_ALLOCATIONS, 50, 'the web side holds the same number');

    const made = [];
    for (let n = 0; n < MAX_BATCH_ALLOCATIONS + 1; n += 1) {
      const { rows: [row] } = await db.query(
        `INSERT INTO travel_vendor_invoices (vendor_invoice_id, travel_id, vendor_id, vendor_invoice_no, invoice_date, invoice_amount)
              VALUES ($1, 'PRD-T2', $2, $3, CURRENT_DATE, 1000) RETURNING id`,
        [`PRD-LIM-${n}`, vendorA, `AG/LIM/${n}`]
      );
      made.push(row.id);
    }
    const allocation = (invoiceId) => ({ vendor_invoice_id: invoiceId, amount: 100 });

    const over = await batch(admin, { payment_date: today(), allocations: made.map(allocation) });
    assert.equal(over.status, 422, JSON.stringify(over.body));
    assert.match(JSON.stringify(over.body), new RegExp(String(MAX_BATCH_ALLOCATIONS)));
    const { rows: none } = await db.query(
      'SELECT 1 FROM travel_vendor_payments WHERE vendor_invoice_id = ANY($1::int[])', [made]);
    assert.equal(none.length, 0, 'an oversized transfer writes nothing at all');

    const at = await batch(admin, {
      payment_date: today(),
      allocations: made.slice(0, MAX_BATCH_ALLOCATIONS).map(allocation),
    });
    assert.equal(at.status, 200, JSON.stringify(at.body));
    assert.equal(at.body.meta.count, MAX_BATCH_ALLOCATIONS);

    await db.query('DELETE FROM travel_vendor_invoices WHERE vendor_invoice_id LIKE $1', ['PRD-LIM-%']);
  });

  test('a transfer with no allocations at all is refused', async () => {
    const res = await batch(admin, { payment_date: today(), allocations: [] });
    assert.equal(res.status, 422, JSON.stringify(res.body));
  });

  // ------------------------------------------------------- the row locks

  test('a single payment landing at the same moment cannot be computed against a stale total', async () => {
    /**
     * Held open on purpose: a transaction takes the row lock on PRD-A1 and
     * keeps it while the batch asks for the same bill. If the batch read the
     * settled figure without the lock it would answer immediately from the
     * stale total; because it waits, its `settled_before` is what the other
     * transaction actually left behind.
     */
    const blocker = new pg.Client({ connectionString: dbUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM travel_vendor_invoices WHERE id = $1 FOR UPDATE', [id['PRD-A1']]);
      await blocker.query(
        `INSERT INTO travel_vendor_payments (vendor_invoice_id, amount, paid_on, mode, reference)
              VALUES ($1, 25000, CURRENT_DATE, 'bank_transfer', 'CONCURRENT')`,
        [id['PRD-A1']]
      );

      const pending = batch(admin, {
        payment_date: today(), reference: 'UTR-LOCKED',
        allocations: [{ vendor_invoice_id: id['PRD-A1'], amount: 10000 }],
      });

      // Still waiting on the lock, so it has read nothing yet.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const { rowCount: early } = await db.query(
        `SELECT 1 FROM travel_vendor_payments WHERE reference = 'UTR-LOCKED'`);
      assert.equal(early, 0, 'the batch has not written past the lock');

      await blocker.query('COMMIT');
      const res = await pending;
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const [allocation] = res.body.data.allocations;
      assert.equal(allocation.settled_before, 25000, 'the figure the other transaction left, not the one before it');
      assert.equal(allocation.settled_after, 35000);
      assert.equal(Number((await ledger()).find((r) => r.ref === 'PRD-A1').amount_paid), 35000);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await blocker.end().catch(() => {});
    }
  });
});
