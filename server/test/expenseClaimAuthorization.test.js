import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Who may turn an expense claim into money (#85).
 *
 * Submitting a claim is ordinary work and stays open. Deciding one and
 * paying it are the administrator's, and until #85 neither route carried a
 * role check at all: any signed-in person could approve a claim, name
 * whoever they liked as its approver, and then reimburse it. The generic
 * resource form reached the same four columns, so guarding only the routes
 * would have closed one door and left the other standing open.
 *
 * The tests below are written around that pair. Every "cannot" checks the
 * row afterwards as well as the status code, because a refusal that half
 * happened is the failure worth catching — a 403 with the column changed
 * would pass a test that only read the response.
 *
 * Runs in database mode, the only mode with two kinds of user to tell
 * apart. Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('expense claim authorisation', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let resetLimiter;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `claim_authz_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

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
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    // Nothing leaves this process: 'log' is the default and the safe one.
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));

    const { loginLimiter } = await import('../src/auth/routes.js');
    resetLimiter = () => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
        try { loginLimiter.resetKey(ip); } catch { /* not a key this store knows */ }
      }
    };
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  let admin;
  let sales;

  before(async () => {
    const signIn = async (email) => {
      resetLimiter();
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };

    const a = await createUser(
      { name: 'Ada Admin', email: 'ada@example.com', password: PASSWORD, role: 'admin' }, db
    );
    const s = await createUser(
      { name: 'Sam Sales', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db
    );
    admin = { user: a, cookie: await signIn(a.email) };
    sales = { user: s, cookie: await signIn(s.email) };
  });

  const as = (cookie) => (method, path) =>
    cookie ? request(app)[method](path).set('Cookie', cookie) : request(app)[method](path);

  let seq = 0;
  const unique = (prefix) => `${prefix}-${process.pid}-${++seq}`;

  /** A trip for claims to hang off. Either role may enter one. */
  const makeTrip = async () => {
    const travel_id = unique('TRV');
    const res = await as(sales.cookie)('post', '/api/travel-logs')
      .send({ travel_id, employee_name: 'Sam Sales' });
    assert.equal(res.status, 201, `trip: ${JSON.stringify(res.body)}`);
    return travel_id;
  };

  /** A plain pending claim, entered by the sales user, as the job requires. */
  const makeClaim = async (over = {}) => {
    const res = await as(sales.cookie)('post', '/api/expense-claims').send({
      claim_id: unique('CLM'), travel_id: await makeTrip(), amount_claimed: 1000, ...over,
    });
    assert.equal(res.status, 201, `claim: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };

  /** The stored row, read straight from the database rather than the API. */
  const row = async (id) => {
    const { rows } = await db.query('SELECT * FROM employee_expense_claims WHERE id = $1', [id]);
    return rows[0];
  };

  const auditFor = async (action, claimId) => {
    const { rows } = await db.query(
      'SELECT * FROM activity_log WHERE action = $1 AND entity_id = $2 ORDER BY id DESC',
      [action, claimId]
    );
    return rows;
  };

  // ------------------------------------------------- submitting a claim

  describe('submitting', () => {
    test('a sales user may enter a claim, and it starts Submitted', async () => {
      const claim = await makeClaim();
      assert.equal(claim.approval_status, 'Submitted');
      assert.equal(Number(claim.amount_reimbursed), 0);
      assert.equal(claim.status, 'Pending approval', 'the worklist shows it as awaiting review');
    });

    test('a sales user may still correct the claim facts', async () => {
      const claim = await makeClaim();
      const res = await as(sales.cookie)('patch', `/api/expense-claims/${claim.id}`)
        .send({ amount_claimed: 1200, remarks: 'receipt attached' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.amount_claimed), 1200);
    });

    test('a sales user cannot enter a claim that is already approved', async () => {
      // The whole point: an approved claim is one step from being paid, and
      // creating one is the quietest way to skip the decision entirely.
      const res = await as(sales.cookie)('post', '/api/expense-claims').send({
        claim_id: unique('CLM'), travel_id: await makeTrip(), amount_claimed: 500,
        approval_status: 'Approved', approved_by: 'Finance Director',
      });
      assert.equal(res.status, 403, JSON.stringify(res.body));

      const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM employee_expense_claims WHERE amount_claimed = 500');
      assert.equal(rows[0].n, 0, 'nothing was written');
    });
  });

  // --------------------------------------- the four columns, on the form

  describe('the protected columns, through ordinary CRUD', () => {
    const PROTECTED = {
      approval_status: 'Approved',
      approved_by: 'Somebody Else',
      amount_reimbursed: 999,
      reimbursement_date: '2026-03-01',
    };

    for (const [field, value] of Object.entries(PROTECTED)) {
      test(`a sales user cannot PATCH ${field}`, async () => {
        const claim = await makeClaim();
        const before = await row(claim.id);

        const res = await as(sales.cookie)('patch', `/api/expense-claims/${claim.id}`).send({ [field]: value });
        assert.equal(res.status, 403, `${field}: ${JSON.stringify(res.body)}`);

        const after = await row(claim.id);
        assert.deepEqual(after, before, `${field}: the row is untouched`);
      });

      test(`an admin cannot PATCH ${field} either — the workflow owns it`, async () => {
        // Being allowed to make the change is not the same as being allowed
        // to make it without the check, the arithmetic or the audit row.
        const claim = await makeClaim();
        const before = await row(claim.id);

        const res = await as(admin.cookie)('patch', `/api/expense-claims/${claim.id}`).send({ [field]: value });
        assert.equal(res.status, 403, `${field}: ${JSON.stringify(res.body)}`);

        const after = await row(claim.id);
        assert.deepEqual(after, before, `${field}: the row is untouched`);
      });
    }

    test('the refusal names the field, so a stale form is diagnosable', async () => {
      const claim = await makeClaim();
      const res = await as(admin.cookie)('patch', `/api/expense-claims/${claim.id}`)
        .send({ approval_status: 'Approved' });
      assert.equal(res.status, 403);
      // The envelope is { error: { message, ...extra } } — see middleware/error.js.
      assert.ok(res.body.error?.fields?.approval_status, JSON.stringify(res.body));
      assert.match(res.body.error.message, /approval_status/);
    });
  });

  // ------------------------------------------------ deciding and paying

  describe('deciding', () => {
    test('a sales user cannot decide a claim', async () => {
      const claim = await makeClaim();
      const before = await row(claim.id);

      const res = await as(sales.cookie)('post', `/api/expense-claims/${claim.id}/decide`)
        .send({ approval_status: 'Approved' });
      assert.equal(res.status, 403, JSON.stringify(res.body));

      assert.deepEqual(await row(claim.id), before, 'the claim is still as it was');
    });

    test('an admin can, and the approver is the account that decided', async () => {
      const claim = await makeClaim();
      const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/decide`)
        // Sent and ignored: identity comes from the session, not the body.
        .send({ approval_status: 'Approved', approved_by: 'Somebody Else' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.approval_status, 'Approved');
      assert.equal(res.body.data.approved_by, 'Ada Admin', 'the signed-in admin, not the body');
    });

    test('deciding writes an audit row naming the account', async () => {
      const claim = await makeClaim();
      await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/decide`).send({ approval_status: 'Approved' });

      const [entry] = await auditFor('claim.decided', claim.claim_id);
      assert.ok(entry, 'an audit row was written');
      assert.equal(entry.actor_user_id, admin.user.id);
      assert.equal(entry.actor_type, 'user');
      assert.equal(entry.metadata.approval_status_after, 'Approved');
    });
  });

  describe('reimbursing', () => {
    /** An approved claim, ready to be paid. */
    const approved = async (amount = 1000) => {
      const claim = await makeClaim({ amount_claimed: amount });
      const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/decide`)
        .send({ approval_status: 'Approved' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return claim;
    };

    test('a sales user cannot reimburse', async () => {
      const claim = await approved();
      const before = await row(claim.id);

      const res = await as(sales.cookie)('post', `/api/expense-claims/${claim.id}/reimburse`)
        .send({ amount_reimbursed: 1000 });
      assert.equal(res.status, 403, JSON.stringify(res.body));

      assert.deepEqual(await row(claim.id), before, 'no money was recorded');
    });

    test('an admin can, and an unapproved claim is still refused', async () => {
      const paid = await approved();
      const ok = await as(admin.cookie)('post', `/api/expense-claims/${paid.id}/reimburse`)
        .send({ amount_reimbursed: 1000, reimbursement_date: '2026-02-01' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(Number(ok.body.data.amount_reimbursed), 1000);

      const pending = await makeClaim();
      const no = await as(admin.cookie)('post', `/api/expense-claims/${pending.id}/reimburse`)
        .send({ amount_reimbursed: 10 });
      assert.equal(no.status, 409, 'not approved yet, exactly as before');
    });

    test('partial reimbursement still works the way it always has', async () => {
      // amount_reimbursed is a running total, not the size of one payment.
      // The dialog adds this payment to what is recorded and sends the sum,
      // and the view reads the status back off that figure. Unchanged by #85.
      const claim = await approved(1000);

      const first = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/reimburse`)
        .send({ amount_reimbursed: 400 });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(Number(first.body.data.amount_reimbursed), 400);
      assert.equal(first.body.data.status, 'Partly reimbursed');

      const second = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/reimburse`)
        .send({ amount_reimbursed: 1000 });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(Number(second.body.data.amount_reimbursed), 1000, 'a total, not 400 + 1000');
      assert.equal(second.body.data.status, 'Reimbursed');
    });

    test('reimbursing writes an audit row with the before and after totals', async () => {
      const claim = await approved(800);
      await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/reimburse`).send({ amount_reimbursed: 300 });

      const [entry] = await auditFor('claim.reimbursed', claim.claim_id);
      assert.ok(entry, 'an audit row was written');
      assert.equal(entry.actor_user_id, admin.user.id);
      assert.equal(entry.metadata.amount_reimbursed_before, 0);
      assert.equal(entry.metadata.amount_reimbursed_after, 300);
    });

    test('a reimbursed claim cannot have its approval quietly taken back', async () => {
      const claim = await approved(500);
      await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/reimburse`).send({ amount_reimbursed: 500 });

      const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/decide`)
        .send({ approval_status: 'Rejected' });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal((await row(claim.id)).approval_status, 'Approved', 'still approved, money still accounted for');
    });
  });

  // -------------------------------------------------------- corrections

  describe('correcting a wrong figure', () => {
    const reimbursed = async () => {
      const claim = await makeClaim({ amount_claimed: 1000 });
      await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/decide`).send({ approval_status: 'Approved' });
      await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/reimburse`).send({ amount_reimbursed: 900 });
      return claim;
    };

    test('a sales user cannot correct', async () => {
      const claim = await reimbursed();
      const res = await as(sales.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
        .send({ amount_reimbursed: 0, reason: 'nice try' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(Number((await row(claim.id)).amount_reimbursed), 900);
    });

    test('an admin can put a total back down, which no other route allows', async () => {
      const claim = await reimbursed();
      const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
        .send({ amount_reimbursed: 100, reason: 'keyed 900 instead of 100' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(Number(res.body.data.amount_reimbursed), 100);
      assert.equal(res.body.data.status, 'Partly reimbursed');
    });

    test('a correction needs a reason, and is recorded with it', async () => {
      const claim = await reimbursed();
      const no = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
        .send({ amount_reimbursed: 100 });
      assert.equal(no.status, 422, JSON.stringify(no.body));

      await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
        .send({ amount_reimbursed: 100, reason: 'keyed 900 instead of 100' });
      const [entry] = await auditFor('claim.corrected', claim.claim_id);
      assert.ok(entry, 'an audit row was written');
      assert.equal(entry.metadata.reason, 'keyed 900 instead of 100');
      assert.equal(entry.metadata.amount_reimbursed_before, 900);
      assert.equal(entry.metadata.amount_reimbursed_after, 100);
    });

    test('a correction cannot exceed what was claimed', async () => {
      const claim = await reimbursed();
      const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
        .send({ amount_reimbursed: 5000, reason: 'too much' });
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.equal(Number((await row(claim.id)).amount_reimbursed), 900, 'unchanged');
    });

    /**
     * The same invariant /decide enforces, judged on the state the correction
     * would arrive at rather than on the field that happens to be in the body.
     *
     * Money recorded against a claim that is not approved is money the tracker
     * has stopped counting — the view reads the status from approval_status
     * first, so the reimbursement vanishes from every figure while the payment
     * does not. /decide refuses to create that state; a correction that
     * reached it by another door would be the same hole with a reason on it.
     */
    describe('the resulting state, not just the fields sent', () => {
      test('rejecting a part-reimbursed claim, without saying what happened to the money, fails', async () => {
        const claim = await reimbursed(); // 900 of 1000, Approved
        const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ approval_status: 'Rejected', reason: 'claimed in error' });
        assert.equal(res.status, 422, JSON.stringify(res.body));
        // Both halves of the problem are named, not just the one field sent.
        assert.ok(res.body.error?.fields?.approval_status, JSON.stringify(res.body));
        assert.ok(res.body.error?.fields?.amount_reimbursed, JSON.stringify(res.body));
      });

      test('moving an approved, reimbursed claim back to Submitted fails too', async () => {
        const claim = await reimbursed();
        const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ approval_status: 'Submitted', reason: 'reopening' });
        assert.equal(res.status, 422, JSON.stringify(res.body));
      });

      test('a refused correction changes neither the claim nor the audit trail', async () => {
        const claim = await reimbursed();
        const before = await row(claim.id);
        const auditBefore = await auditFor('claim.corrected', claim.claim_id);

        const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ approval_status: 'Rejected', reason: 'claimed in error' });
        assert.equal(res.status, 422);

        assert.deepEqual(await row(claim.id), before, 'the claim is untouched');
        assert.deepEqual(
          await auditFor('claim.corrected', claim.claim_id), auditBefore,
          'and nothing was recorded — the transaction rolled back whole'
        );
      });

      test('saying what happened to the money in the same correction is accepted', async () => {
        const claim = await reimbursed();
        const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ amount_reimbursed: 0, approval_status: 'Rejected', reason: 'keyed against the wrong claim' });
        assert.equal(res.status, 200, JSON.stringify(res.body));

        const after = await row(claim.id);
        assert.equal(after.approval_status, 'Rejected');
        assert.equal(Number(after.amount_reimbursed), 0);
        assert.equal(res.body.data.status, 'Rejected', 'and the worklist agrees');
      });

      test('lowering a total is flagged in the audit row, because nothing else records it', async () => {
        // amount_reimbursed is one column, not a ledger: lowering it overwrites
        // the old figure rather than booking a reversal against it. The audit
        // row is the only surviving record that 900 was ever there.
        const claim = await reimbursed();
        await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ amount_reimbursed: 0, approval_status: 'Rejected', reason: 'keyed against the wrong claim' });

        const [entry] = await auditFor('claim.corrected', claim.claim_id);
        assert.equal(entry.metadata.amount_reimbursed_before, 900);
        assert.equal(entry.metadata.amount_reimbursed_after, 0);
        assert.equal(entry.metadata.lowers_recorded_total, true);
        assert.equal(entry.metadata.reason, 'keyed against the wrong claim');
      });

      test('a claim left Approved may still have its figure corrected', async () => {
        const claim = await reimbursed();
        const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ amount_reimbursed: 250, reason: 'keyed 900 instead of 250' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(Number(res.body.data.amount_reimbursed), 250);
        assert.equal(res.body.data.approval_status, 'Approved', 'still approved');
        assert.equal(res.body.data.status, 'Partly reimbursed');
      });

      test('a claim with nothing reimbursed may be rejected outright', async () => {
        // The invariant only bites when money is recorded; an ordinary
        // rejection is untouched by it.
        const claim = await makeClaim();
        await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/decide`).send({ approval_status: 'Approved' });
        const res = await as(admin.cookie)('post', `/api/expense-claims/${claim.id}/correct`)
          .send({ approval_status: 'Rejected', reason: 'duplicate of CLM-2026-001' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.approval_status, 'Rejected');
      });

      test('a sales user cannot reach any of this', async () => {
        const claim = await reimbursed();
        const before = await row(claim.id);
        for (const body of [
          { amount_reimbursed: 0, approval_status: 'Rejected', reason: 'nice try' },
          { approval_status: 'Submitted', reason: 'nice try' },
        ]) {
          const res = await as(sales.cookie)('post', `/api/expense-claims/${claim.id}/correct`).send(body);
          assert.equal(res.status, 403, JSON.stringify(res.body));
        }
        assert.deepEqual(await row(claim.id), before, 'untouched');
      });
    });
  });

  // ------------------------------------------------ vendor invoices too

  describe('vendor invoice payments stay open to both roles', () => {
    const makeInvoice = async () => {
      const res = await as(sales.cookie)('post', '/api/vendor-invoices').send({
        vendor_invoice_id: unique('VINV'), travel_id: await makeTrip(), invoice_amount: 2000,
      });
      assert.equal(res.status, 201, `invoice: ${JSON.stringify(res.body)}`);
      return res.body.data;
    };

    /**
     * #85's rule was that paying a vendor is ordinary work for admin and
     * sales. #214 narrowed it: paying a travel agency is the travel desk's
     * work with the administrator, and the gate sales came through was never
     * a decision — just the consequence of leaving the route open. The
     * capability is withdrawn here deliberately.
     */
    test('a sales user may no longer record a vendor payment (#214)', async () => {
      const invoice = await makeInvoice();
      const res = await as(sales.cookie)('post', `/api/vendor-invoices/${invoice.id}/pay`)
        .send({ amount_paid: 2000, payment_date: '2026-02-10' });
      assert.equal(res.status, 403, JSON.stringify(res.body));

      const { rows } = await db.query('SELECT amount_paid FROM travel_vendor_invoices WHERE id = $1', [invoice.id]);
      assert.equal(Number(rows[0].amount_paid), 0, 'the refusal left the invoice alone');
    });

    test('an admin may too', async () => {
      const invoice = await makeInvoice();
      const res = await as(admin.cookie)('post', `/api/vendor-invoices/${invoice.id}/pay`).send({ amount_paid: 500 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test('paying is recorded, with the account that recorded it', async () => {
      const invoice = await makeInvoice();
      await as(admin.cookie)('post', `/api/vendor-invoices/${invoice.id}/pay`).send({ amount_paid: 750 });

      const { rows } = await db.query(
        'SELECT * FROM activity_log WHERE action = $1 AND entity_id = $2',
        ['vendor_invoice.paid', invoice.vendor_invoice_id]
      );
      assert.equal(rows.length, 1, 'one audit row');
      assert.equal(rows[0].actor_user_id, admin.user.id);
      assert.equal(rows[0].metadata.amount_paid_after, 750);
    });

    test('but the paid columns are not reachable through the form, for either role', async () => {
      const invoice = await makeInvoice();
      const before = await db.query('SELECT * FROM travel_vendor_invoices WHERE id = $1', [invoice.id]);

      for (const who of [sales, admin]) {
        const res = await as(who.cookie)('patch', `/api/vendor-invoices/${invoice.id}`).send({ amount_paid: 9999 });
        assert.equal(res.status, 403, JSON.stringify(res.body));
      }
      const after = await db.query('SELECT * FROM travel_vendor_invoices WHERE id = $1', [invoice.id]);
      assert.deepEqual(after.rows[0], before.rows[0], 'untouched');
    });

    test('the rest of a vendor invoice is still editable by anyone', async () => {
      const invoice = await makeInvoice();
      const res = await as(sales.cookie)('patch', `/api/vendor-invoices/${invoice.id}`)
        .send({ remarks: 'awaiting the vendor’s GST invoice' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  // ------------------------------------------------------- signed out

  describe('signed out', () => {
    test('every one of these needs a session first', async () => {
      const anonymous = as(null);
      const calls = [
        ['post', '/api/expense-claims'],
        ['post', '/api/expense-claims/1/decide'],
        ['post', '/api/expense-claims/1/reimburse'],
        ['post', '/api/expense-claims/1/correct'],
        ['post', '/api/vendor-invoices/1/pay'],
      ];
      for (const [method, path] of calls) {
        const res = await anonymous(method, path).send({});
        assert.equal(res.status, 401, `${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    });
  });
});
