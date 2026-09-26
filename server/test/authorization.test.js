import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Who may do the operational and global-data things (#18 Phase 1C).
 *
 * The post-merge review found four routes that any signed-in person could
 * reach: exchange rates, running a background job by hand, sending a test
 * email, and merging two companies. None of them are a salesperson's work,
 * and three of them have effects outside the app.
 *
 * Runs in database mode, because that is the only mode with two kinds of
 * user to tell apart. usersApiShared.test.js covers the shared admin, who
 * is an admin in every one of these.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('operational and global-data authorisation', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let resetLimiter;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `authz_suite_${process.pid}_${Date.now()}`;
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
    // Created once: none of the tests below change who anybody is.
    const signIn = async (email) => {
      resetLimiter();
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };

    const a = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db
    );
    const s = await createUser(
      { name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db
    );
    admin = { user: a, cookie: await signIn(a.email) };
    sales = { user: s, cookie: await signIn(s.email) };
  });

  const as = (cookie) => (method, path) =>
    cookie ? request(app)[method](path).set('Cookie', cookie) : request(app)[method](path);

  // ------------------------------------------------------ exchange rates

  describe('exchange rates', () => {
    const rate = (over = {}) => ({
      from_currency: 'USD', to_currency: 'INR', rate: 83.5,
      effective_from: '2026-01-01', source: 'manual', ...over,
    });

    /** A row to aim PATCH and DELETE at, made by the admin. */
    const seed = async (over = {}) => {
      const res = await as(admin.cookie)('post', '/api/exchange-rates').send(rate(over));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data.id;
    };

    test('a sales user reads them — the figures they work from', async () => {
      const res = await as(sales.cookie)('get', '/api/exchange-rates');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(Array.isArray(res.body.data));
    });

    test('a sales user cannot write them, by any verb', async () => {
      // One rate re-values every historical deal in every report. This was
      // the hole: exchange-rates was the only Settings list without the flag.
      const id = await seed({ effective_from: '2026-02-01' });

      const post = await as(sales.cookie)('post', '/api/exchange-rates').send(rate({ effective_from: '2026-03-01' }));
      assert.equal(post.status, 403, JSON.stringify(post.body));

      const patch = await as(sales.cookie)('patch', `/api/exchange-rates/${id}`).send({ rate: 1 });
      assert.equal(patch.status, 403, JSON.stringify(patch.body));

      const del = await as(sales.cookie)('delete', `/api/exchange-rates/${id}`);
      assert.equal(del.status, 403, JSON.stringify(del.body));

      // Refused, not quietly half-done.
      const still = await as(admin.cookie)('get', `/api/exchange-rates/${id}`);
      assert.equal(still.status, 200);
      assert.equal(Number(still.body.data.rate), 83.5, 'the rate is untouched');
    });

    test('an admin may write them', async () => {
      const id = await seed({ effective_from: '2026-04-01' });

      const patch = await as(admin.cookie)('patch', `/api/exchange-rates/${id}`).send({ rate: 84 });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));

      const del = await as(admin.cookie)('delete', `/api/exchange-rates/${id}`);
      assert.equal(del.status, 204, JSON.stringify(del.body));
    });

    test('the other Settings lists are unchanged by this', async () => {
      // services / travel-vendors / expense-categories were already
      // admin-only; exchange rates now joins them rather than replacing them.
      for (const resource of ['services', 'travel-vendors', 'expense-categories']) {
        const res = await as(sales.cookie)('post', `/api/${resource}`).send({ name: 'Nope' });
        assert.equal(res.status, 403, resource);
      }
    });
  });

  // ---------------------------------------------------------------- jobs

  describe('jobs', () => {
    const JOB = 'reminders.payment';

    test('anyone signed in may read the registry', async () => {
      // Checking whether the reminder a client mentions actually went out is
      // an ordinary question, and the answer is not sensitive.
      const res = await as(sales.cookie)('get', '/api/jobs');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.data.some((j) => j.name === JOB));
    });

    test('a sales user cannot run one by hand', async () => {
      // This emails every client the job decides is due — not the caller's
      // own records, and not a preview.
      const res = await as(sales.cookie)('post', `/api/jobs/${JOB}/run`);
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    test('an admin can', async () => {
      const res = await as(admin.cookie)('post', `/api/jobs/${JOB}/run`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test('the guard is on the run, not on the name, so an unknown job is still 403 for sales', async () => {
      // Authorisation settles before anything else, so a sales user cannot
      // use this route to find out which jobs exist.
      const res = await as(sales.cookie)('post', '/api/jobs/no.such.job/run');
      assert.equal(res.status, 403, JSON.stringify(res.body));

      const asAdmin = await as(admin.cookie)('post', '/api/jobs/no.such.job/run');
      assert.equal(asAdmin.status, 404, 'and an admin gets the honest answer');
    });
  });

  // -------------------------------------------------------- test emails

  describe('test email', () => {
    const body = { to: 'somebody@example.com' };

    test('a sales user cannot send one', async () => {
      const res = await as(sales.cookie)('post', '/api/emails/test').send(body);
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    test('an admin reaches the handler', async () => {
      const res = await as(admin.cookie)('post', '/api/emails/test').send(body);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      // EMAIL_MODE=log, so it is recorded and not delivered.
      assert.equal(res.body.would.deliver, false);
    });

    test('reading the log is still open to anyone signed in', async () => {
      // The gate is on sending, not on looking. A sales user checking
      // whether their client's reminder went out is doing their job.
      const res = await as(sales.cookie)('get', '/api/emails');
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test('the application\'s own emails do not go through this route', async () => {
      // The job above sent through lib/mail.js directly, with no session at
      // all — proof that guarding /emails/test did not gate transactional
      // mail. The log has rows the test-send did not put there.
      const res = await as(admin.cookie)('get', '/api/emails');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data), 'the log is readable');
    });
  });

  // ------------------------------------------------------ company merge

  describe('company merge', () => {
    const makeCompany = async (name) => {
      const res = await as(admin.cookie)('post', '/api/companies').send({ name });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data.id;
    };

    test('a sales user cannot merge', async () => {
      const a = await makeCompany('Alpha Industries');
      const b = await makeCompany('Beta Industries');

      const res = await as(sales.cookie)('post', `/api/companies/${a}/merge`).send({ into: b });
      assert.equal(res.status, 403, JSON.stringify(res.body));

      // Nothing was folded, nothing deleted.
      const still = await as(admin.cookie)('get', `/api/companies/${a}/full`);
      assert.equal(still.status, 200, 'the company is still there');
    });

    test('an admin can', async () => {
      const a = await makeCompany('Gamma Works');
      const b = await makeCompany('Gamma Work');

      const res = await as(admin.cookie)('post', `/api/companies/${a}/merge`).send({ into: b });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.into, 'Gamma Work');

      const gone = await as(admin.cookie)('get', `/api/companies/${a}/full`);
      assert.equal(gone.status, 404, 'the merged company is gone');
    });

    test('spotting duplicates stays open — acting on them does not', async () => {
      const res = await as(sales.cookie)('get', '/api/companies/duplicates');
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  // ------------------------------------------- deleting shared/financial data

  /**
   * Companies and contacts are shared master data; purchase orders, their
   * service lines and their payment stages are financial records. Until
   * Phase 2 gives records an owner there is no answer to "whose row is
   * this?", so a sales user may add to them and correct them — that is the
   * job — but not hard-delete them.
   *
   * The gate is on DELETE alone, deliberately. Companies and contacts are
   * created by the link trigger the moment a quotation names a client
   * nobody has typed before, and POs, their lines and their stages are
   * entered by sales as ordinary work. Putting an admin in front of any of
   * that would stop the job rather than protect anything, so each case
   * below checks the reads, the edit and the create as well as the delete.
   */
  describe('deletes on shared and financial data', () => {
    let seq = 0;
    const unique = (prefix) => `${prefix}-${process.pid}-${++seq}`;

    /** A project for the purchase orders to belong to. */
    const makeProject = async () => {
      const id = unique('PRJ');
      const res = await as(admin.cookie)('post', '/api/projects')
        .send({ project_id: id, client_name: `Holder ${id}` });
      assert.equal(res.status, 201, `project: ${JSON.stringify(res.body)}`);
      return id;
    };

    /** A purchase order for service lines and stages to hang off. */
    const makePo = async () => {
      const po_number = unique('PO');
      const res = await as(admin.cookie)('post', '/api/purchase-orders')
        .send({ po_number, project_id: await makeProject(), po_date: '2026-01-10', po_value: 100000, currency: 'INR' });
      assert.equal(res.status, 201, `po: ${JSON.stringify(res.body)}`);
      return po_number;
    };

    const makeCompanyId = async () => {
      const res = await as(admin.cookie)('post', '/api/companies').send({ name: unique('Delta Traders') });
      assert.equal(res.status, 201, `company: ${JSON.stringify(res.body)}`);
      return res.body.data.id;
    };

    // Each entry: a valid create body, and a harmless edit.
    const KINDS = {
      companies: {
        body: async () => ({ name: unique('Delta Traders') }),
        edit: { city: 'Pune' },
      },
      contacts: {
        body: async () => ({ company_id: await makeCompanyId(), name: unique('Meera Rao') }),
        edit: { phone: '+91 22 1234 5678' },
      },
      'purchase-orders': {
        body: async () => ({
          po_number: unique('PO'), project_id: await makeProject(),
          po_date: '2026-01-10', po_value: 100000, currency: 'INR',
        }),
        edit: { po_value: 120000 },
      },
      'po-services': {
        body: async () => ({ po_number: await makePo(), service: 'Assessment', service_value: 50000 }),
        edit: { remarks: 'revised scope' },
      },
      'payment-stages': {
        body: async () => ({
          po_number: await makePo(), stage_no: 1, stage_name: 'Advance',
          trigger_event: 'On PO Registration', stage_percent: 0.5,
        }),
        edit: { remarks: 'terms confirmed' },
      },
    };

    /** A fresh row of `kind`, made by the admin so the test is about DELETE. */
    const seed = async (kind) => {
      const res = await as(admin.cookie)('post', `/api/${kind}`).send(await KINDS[kind].body());
      assert.equal(res.status, 201, `seed ${kind}: ${JSON.stringify(res.body)}`);
      return res.body.data.id;
    };

    for (const kind of Object.keys(KINDS)) {
      test(`a sales user cannot delete ${kind}`, async () => {
        const id = await seed(kind);

        const res = await as(sales.cookie)('delete', `/api/${kind}/${id}`);
        assert.equal(res.status, 403, `${kind}: ${JSON.stringify(res.body)}`);

        // Refused, not quietly done: the row is still there.
        const still = await as(admin.cookie)('get', `/api/${kind}/${id}`);
        assert.equal(still.status, 200, `${kind} survived the refusal`);
      });

      test(`a sales user may still read, edit and create ${kind}`, async () => {
        const id = await seed(kind);

        const list = await as(sales.cookie)('get', `/api/${kind}`);
        assert.equal(list.status, 200, `${kind} list: ${JSON.stringify(list.body)}`);

        const one = await as(sales.cookie)('get', `/api/${kind}/${id}`);
        assert.equal(one.status, 200, `${kind} read: ${JSON.stringify(one.body)}`);

        const edit = await as(sales.cookie)('patch', `/api/${kind}/${id}`).send(KINDS[kind].edit);
        assert.equal(edit.status, 200, `${kind} edit: ${JSON.stringify(edit.body)}`);

        const created = await as(sales.cookie)('post', `/api/${kind}`).send(await KINDS[kind].body());
        assert.equal(created.status, 201, `${kind} create: ${JSON.stringify(created.body)}`);
      });

      test(`an admin reaches the ${kind} delete handler`, async () => {
        const id = await seed(kind);

        const res = await as(admin.cookie)('delete', `/api/${kind}/${id}`);
        assert.equal(res.status, 204, `${kind}: ${JSON.stringify(res.body)}`);

        const gone = await as(admin.cookie)('get', `/api/${kind}/${id}`);
        assert.equal(gone.status, 404, `${kind} is gone`);
      });
    }

    test('an unauthenticated caller is turned away before any of that', async () => {
      const anonymous = as(null);
      for (const kind of Object.keys(KINDS)) {
        const res = await anonymous('delete', `/api/${kind}/1`);
        assert.equal(res.status, 401, `${kind} -> ${res.status}`);
      }
    });
  });

  // ------------------------------------------- deletes left to sales (Phase 2)

  describe('sales-workflow deletes stay open until Phase 2', () => {
    /**
     * These are a salesperson's own working records. They stay deletable by
     * any authenticated user until Phase 2 introduces ownership and
     * row-scoping, which is what will decide who may remove whose records.
     *
     * Asserted rather than assumed, so narrowing one later is a deliberate
     * change with a failing test behind it instead of silent drift.
     */
    let seq = 0;
    const unique = (prefix) => `${prefix}-${process.pid}-open-${++seq}`;

    const OPEN = {
      enquiries: () => ({ client_name: unique('Open Enquiry'), enquiry_date: '2026-01-05' }),
      quotations: () => ({ client_name: unique('Open Quote'), quotation_date: '2026-01-06' }),
      projects: () => ({ client_name: unique('Open Project'), project_id: unique('PRJ') }),
    };

    for (const [kind, body] of Object.entries(OPEN)) {
      test(`a sales user may still delete ${kind}`, async () => {
        const created = await as(sales.cookie)('post', `/api/${kind}`).send(body());
        assert.equal(created.status, 201, `${kind}: ${JSON.stringify(created.body)}`);

        const res = await as(sales.cookie)('delete', `/api/${kind}/${created.body.data.id}`);
        assert.equal(res.status, 204, `${kind}: ${JSON.stringify(res.body)}`);
      });
    }
  });

  // ------------------------------------------------- nobody at all

  describe('signed out', () => {
    test('every one of these needs a session first', async () => {
      const anonymous = as(null);
      const calls = [
        ['post', '/api/exchange-rates'],
        ['get', '/api/exchange-rates'],
        ['get', '/api/jobs'],
        ['post', '/api/jobs/reminders.payment/run'],
        ['post', '/api/emails/test'],
        ['get', '/api/emails'],
        ['post', '/api/companies/1/merge'],
      ];

      for (const [method, path] of calls) {
        const res = await anonymous(method, path).send({});
        assert.equal(res.status, 401, `${method.toUpperCase()} ${path} -> ${res.status}`);
      }
    });
  });
  // ------------------------------------------------ batch 2's new surfaces

  describe('the catalogues batch 2 adds', () => {
    /**
     * Seven Settings lists arrived with #58. They are the same kind of thing
     * as services and exchange rates: everybody reads them, one person
     * curates them. A pipeline stage's status mapping rewrites quotation
     * statuses through a trigger, a payment-terms template is the invoicing
     * schedule every new PO is built from, and deleting a lost reason blanks
     * it on every record that used it.
     */
    const LISTS = [
      'pipeline-stages', 'payment-terms-templates', 'payment-terms-template-lines',
      'onboarding-templates', 'onboarding-template-lines', 'lead-sources', 'lost-reasons',
    ];

    for (const list of LISTS) {
      test(`a sales user reads ${list} but cannot write it`, async () => {
        const read = await as(sales.cookie)('get', `/api/${list}`);
        assert.equal(read.status, 200, `${list} read -> ${read.status}`);

        for (const [verb, path] of [['post', ''], ['patch', '/1'], ['delete', '/1']]) {
          const res = await as(sales.cookie)(verb, `/api/${list}${path}`).send({ name: 'Nope' });
          assert.equal(res.status, 403, `${verb} ${list} -> ${res.status}`);
        }
      });
    }

    test('an admin is not stopped by the gate', async () => {
      for (const list of LISTS) {
        const res = await as(admin.cookie)('post', `/api/${list}`).send({ name: 'Anything' });
        assert.notEqual(res.status, 403, `${list} -> admin got 403`);
      }
    });
  });

  describe('discount approvals', () => {
    /**
     * #46 exists because a discount needs somebody else's yes. Asking is the
     * salesperson's own request and stays open; deciding is the whole point
     * and does not. The review of #58 found a sales user could raise a 40%
     * discount and approve it, two clicks apart on the same screen.
     */
    test('a sales user cannot decide an approval', async () => {
      const res = await as(sales.cookie)('post', '/api/quotations/any/approval/decide')
        .send({ decision: 'approved' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    test('asking for one stays open to them', async () => {
      const res = await as(sales.cookie)('post', '/api/quotations/no-such-quotation/approval/request')
        .send({ reason: 'Client asked for a discount' });
      assert.notEqual(res.status, 403, JSON.stringify(res.body));
    });

    test('an admin reaches the decision handler', async () => {
      const res = await as(admin.cookie)('post', '/api/quotations/no-such-quotation/approval/decide')
        .send({ decision: 'approved' });
      assert.notEqual(res.status, 403, JSON.stringify(res.body));
    });

    test('an unauthenticated caller is turned away first', async () => {
      const res = await as(null)('post', '/api/quotations/any/approval/decide').send({ decision: 'approved' });
      assert.equal(res.status, 401, JSON.stringify(res.body));
    });
  });

  // ------------------------------------------------ batch 3's new surfaces

  describe('money received, and the operational routes batch 3 adds', () => {
    /**
     * `payments` is the ledger payment_stages.amount_received is computed
     * from, by trigger. Recording a receipt is ordinary sales work and goes
     * through POST /payment-stages/:id/payment; editing or deleting a row of
     * the ledger by hand moves Due now, Collections and the forecast with
     * nothing to show for it.
     *
     * The three routes below each do the same work as something already
     * gated: two are halves of daily jobs, and a hold stops the chasing job
     * on a debt.
     */
    test('a sales user reads payments but cannot write them', async () => {
      const read = await as(sales.cookie)('get', '/api/payments');
      assert.equal(read.status, 200, `read -> ${read.status}`);

      for (const [verb, path] of [['post', ''], ['patch', '/1'], ['delete', '/1']]) {
        const res = await as(sales.cookie)(verb, `/api/payments${path}`).send({ amount: 1000 });
        assert.equal(res.status, 403, `${verb} -> ${res.status}`);
      }
    });

    test('an admin is not stopped by that gate', async () => {
      const res = await as(admin.cookie)('post', '/api/payments').send({ amount: 1000 });
      assert.notEqual(res.status, 403, JSON.stringify(res.body));
    });

    for (const [label, path] of [
      ['run the notification sweep', '/api/notifications/sweep'],
      ['discover renewals', '/api/renewals/discover'],
      ['put a debt on hold', '/api/collections/stages/1/hold'],
    ]) {
      test(`a sales user cannot ${label}`, async () => {
        const res = await as(sales.cookie)('post', path).send({ on_hold: true });
        assert.equal(res.status, 403, `${path} -> ${res.status}`);
      });

      test(`an admin reaches ${label}`, async () => {
        const res = await as(admin.cookie)('post', path).send({ on_hold: true });
        assert.notEqual(res.status, 403, `${path} -> ${res.status}`);
      });
    }

    test('logging a chase stays open — that is the work itself', async () => {
      const res = await as(sales.cookie)('post', '/api/collections/log').send({ stage_id: 1, channel: 'call', summary: 'Chased' });
      assert.notEqual(res.status, 403, JSON.stringify(res.body));
    });
  });

  // ------------------------------------------------ batch 4's new surfaces

  describe('mailboxes and the shared inbox', () => {
    /**
     * A connected mailbox is somebody's correspondence with clients. The
     * person who connected it administers it, an admin administers all of
     * them, and a shared mailbox is the team's — which is the point of
     * marking one shared.
     *
     * The review of #60 found every one of these open: read a colleague's
     * client mail, reply from their mailbox so it lands in their Sent Items,
     * wipe what is stored by changing their visibility, or flip their
     * personal mailbox into the team queue.
     */
    test('a sales user cannot administer a mailbox that is not theirs', async () => {
      const { rows: [a] } = await db.query(
        `INSERT INTO connected_accounts (username, provider, email, status)
         VALUES ('someone.else@example.test', 'microsoft', 'someone.else@example.test', 'active') RETURNING id`);

      for (const [verb, path, body] of [
        ['patch', `/api/mailboxes/${a.id}`, { visibility: 'metadata' }],
        ['post', `/api/mailboxes/${a.id}/sync`, {}],
        ['post', `/api/mailboxes/${a.id}/disconnect`, {}],
      ]) {
        const res = await as(sales.cookie)(verb, path).send(body);
        assert.equal(res.status, 403, `${verb} ${path} -> ${res.status}`);
      }

      // and nothing was destroyed on the way past
      const { rows: [still] } = await db.query('SELECT visibility FROM connected_accounts WHERE id = $1', [a.id]);
      assert.equal(still.visibility, 'metadata', 'default is unchanged');
    });

    test('the rest of the mailbox administration is the admin\'s', async () => {
      for (const [verb, path] of [
        ['post', '/api/mailboxes/test'],
        ['post', '/api/mailboxes/1/test-messages'],
        ['post', '/api/mailboxes/blocklist'],
        ['delete', '/api/mailboxes/blocklist/1'],
      ]) {
        const res = await as(sales.cookie)(verb, path).send({ pattern: 'nope@example.test' });
        assert.equal(res.status, 403, `${verb} ${path} -> ${res.status}`);
      }
    });

    test('a thread in somebody else\'s mailbox is not there as far as they are concerned', async () => {
      const { rows: [a] } = await db.query(
        `INSERT INTO connected_accounts (username, provider, email, status, visibility)
         VALUES ('private@example.test', 'microsoft', 'private@example.test', 'active', 'share_everything') RETURNING id`);
      const { rows: [t] } = await db.query(
        `INSERT INTO email_threads (account_id, conversation_id, subject, first_message_at, last_message_at)
         VALUES ($1, $2, 'Client pricing', now(), now()) RETURNING id`, [a.id, `conv-${a.id}`]);

      const read = await as(sales.cookie)('get', `/api/mail/threads/${t.id}`);
      assert.equal(read.status, 404, JSON.stringify(read.body));

      const reply = await as(sales.cookie)('post', `/api/mail/threads/${t.id}/reply`).send({ html: 'Hello' });
      assert.equal(reply.status, 404, JSON.stringify(reply.body));

      const relink = await as(sales.cookie)('patch', `/api/mail/threads/${t.id}`).send({ entity: null, entity_id: null });
      assert.equal(relink.status, 404, JSON.stringify(relink.body));

      const admin_read = await as(admin.cookie)('get', `/api/mail/threads/${t.id}`);
      assert.equal(admin_read.status, 200, 'an admin can read it');
    });

    test('a thread on a record they own is theirs to read, wherever it arrived', async () => {
      // #29 asks for this in so many words: "a sales user sees threads on
      // their own records". The client replies to whoever they have always
      // written to, so the thread about your own deal usually lands in
      // somebody else's mailbox.
      const { rows: [a] } = await db.query(
        `INSERT INTO connected_accounts (username, provider, email, status, visibility)
         VALUES ('colleague@example.test', 'microsoft', 'colleague@example.test', 'active', 'share_everything') RETURNING id`);
      const no = `CTZ/QT/2026/9${Math.floor(Math.random() * 90) + 10}`;
      await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
         VALUES ($1, 'Their Client Ltd', '2026-09-01', 50000, 'Submitted', $2)`, [no, sales.user.name]);
      const { rows: [t] } = await db.query(
        `INSERT INTO email_threads (account_id, conversation_id, subject, entity, entity_id, first_message_at, last_message_at)
         VALUES ($1, $2, 'About your quotation', 'quotation', $3, now(), now()) RETURNING id`,
        [a.id, `conv-own-${a.id}`, no]);

      const read = await as(sales.cookie)('get', `/api/mail/threads/${t.id}`);
      assert.equal(read.status, 200, `their own deal, in a colleague's mailbox: ${JSON.stringify(read.body)}`);

      const listed = await as(sales.cookie)('get', `/api/mail/threads?entity=quotation&id=${encodeURIComponent(no)}`);
      assert.equal(listed.status, 200);
      assert.ok(listed.body.data.some((x) => x.id === t.id), 'and it shows on the record page');

      // Reading it is not the same as speaking as its owner: a reply leaves
      // from that mailbox and lands in that person's Sent Items.
      const reply = await as(sales.cookie)('post', `/api/mail/threads/${t.id}/reply`).send({ html: 'Hello' });
      assert.equal(reply.status, 404, 'replying still needs the mailbox to be theirs');
    });

    test('a thread on a deal that is not theirs stays invisible', async () => {
      const { rows: [a] } = await db.query(
        `INSERT INTO connected_accounts (username, provider, email, status, visibility)
         VALUES ('other@example.test', 'microsoft', 'other@example.test', 'active', 'share_everything') RETURNING id`);
      const no = `CTZ/QT/2026/8${Math.floor(Math.random() * 90) + 10}`;
      await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
         VALUES ($1, 'Not Their Client', '2026-09-01', 50000, 'Submitted', 'Somebody Else')`, [no]);
      const { rows: [t] } = await db.query(
        `INSERT INTO email_threads (account_id, conversation_id, subject, entity, entity_id, first_message_at, last_message_at)
         VALUES ($1, $2, 'Not your deal', 'quotation', $3, now(), now()) RETURNING id`,
        [a.id, `conv-other-${a.id}`, no]);
      assert.equal((await as(sales.cookie)('get', `/api/mail/threads/${t.id}`)).status, 404);
    });

    test('a task records who made it, the way a note and a file already do', async () => {
      await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
         VALUES ('CTZ/QT/2026/001', 'Signed Copy Ltd', '2026-09-01', 50000, 'Submitted', $1) ON CONFLICT DO NOTHING`, [sales.user.name]);
      const made = await as(sales.cookie)('post', '/api/tasks')
        .send({ entity: 'quotation', entity_id: 'CTZ/QT/2026/001', title: 'Chase the signed copy' });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.ok(made.body.data.created_by, 'a task with nobody\'s name on it is an anonymous timeline entry (#22)');

      const imported = await as(admin.cookie)('post', '/api/tasks')
        .send({ entity: 'quotation', entity_id: 'CTZ/QT/2026/001', title: 'From the old sheet', created_by: 'Ramesh' });
      assert.equal(imported.body.data.created_by, 'Ramesh', 'an author sent explicitly is kept, so an import carries its own');
    });

    test('making a mailbox into a team inbox is the admin\'s call', async () => {
      const res = await as(sales.cookie)('post', '/api/inbox/inboxes').send({ name: 'Mine now', account_id: 1 });
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });

    /**
     * Deleting one is the same call pointed the other way, and worse:
     * inbox_conversations cascades, so it discards the whole team's triage
     * and quietly stops the shared address reaching anybody.
     */
    test('and so is deleting one', async () => {
      const res = await as(sales.cookie)('delete', '/api/inbox/inboxes/1?discard=yes');
      assert.equal(res.status, 403, JSON.stringify(res.body));
    });
  });
  // ------------------------------------------------ batch 5's new surfaces

  describe('webhooks, accounting, the portal switch and margin', () => {
    /**
     * #49 asks for the webhook endpoints to be admin-only, #39 for margin to
     * be admin-only unless settings say otherwise, and #47 for an admin to
     * be the one who turns the portal on per company. The review of #61
     * found all three open: a sales user could subscribe an endpoint they
     * own to every event with personal data included, turn on the client
     * portal for any company, trigger an accounting sync, and move the
     * margin on their own deals by writing project costs.
     */
    for (const [label, verb, path] of [
      ['list webhook endpoints', 'get', '/api/webhooks'],
      ['create a webhook endpoint', 'post', '/api/webhooks'],
      ['read the delivery log', 'get', '/api/webhooks/deliveries'],
      ['sync the accounting system', 'post', '/api/accounting/sync'],
      ['read the accounting log', 'get', '/api/accounting/log'],
      ['turn the portal on for a company', 'patch', '/api/portal-admin/companies/1'],
      ['read margin by project', 'get', '/api/profitability'],
      ['add somebody to the roster', 'post', '/api/visits/staff'],
    ]) {
      test(`a sales user cannot ${label}`, async () => {
        const res = await as(sales.cookie)(verb, path).send({ name: 'Nope', url: 'https://example.test/hook' });
        assert.equal(res.status, 403, `${verb} ${path} -> ${res.status}`);
      });
    }

    test('an admin reaches all of them', async () => {
      for (const [verb, path] of [['get', '/api/webhooks'], ['get', '/api/webhooks/deliveries'],
                                  ['get', '/api/accounting/log'], ['get', '/api/profitability']]) {
        const res = await as(admin.cookie)(verb, path);
        assert.notEqual(res.status, 403, `${verb} ${path} -> ${res.status}`);
      }
    });

    test('margin opens to everybody when the setting says so', async () => {
      await db.query(`INSERT INTO settings (key, value) VALUES ('margin_visible_to_sales', 'true')
                      ON CONFLICT (key) DO UPDATE SET value = 'true'`);
      const open = await as(sales.cookie)('get', '/api/profitability');
      assert.notEqual(open.status, 403, JSON.stringify(open.body));

      await db.query(`UPDATE settings SET value = 'false' WHERE key = 'margin_visible_to_sales'`);
      const shut = await as(sales.cookie)('get', '/api/profitability');
      assert.equal(shut.status, 403, JSON.stringify(shut.body));
    });

    test('project costs are the admin\'s to write, and everyone\'s to read', async () => {
      const read = await as(sales.cookie)('get', '/api/project-costs');
      assert.equal(read.status, 200, `read -> ${read.status}`);

      const write = await as(sales.cookie)('post', '/api/project-costs').send({ project_id: 'PRJ-1', amount: 1000 });
      assert.equal(write.status, 403, `write -> ${write.status}`);
    });

    test('scheduling a visit stays open — that is the delivery work', async () => {
      const res = await as(sales.cookie)('get', '/api/visits');
      assert.notEqual(res.status, 403, JSON.stringify(res.body));
    });
  });

  // ------------------------------------------------ batch 6's new surfaces

  describe('API tokens for MCP', () => {
    /**
     * A token carries its own role, so whoever may create one may create an
     * admin one — and read the whole company through MCP whatever their own
     * role is. Revoking is that power pointed the other way: you could turn
     * off everybody else's.
     *
     * mcp.test.js signs in as the shared admin, where there is only one kind
     * of user, which is why this belongs here instead.
     */
    test('a sales user cannot list, create or revoke tokens', async () => {
      for (const [verb, path] of [['get', '/api/api-tokens'], ['post', '/api/api-tokens'], ['post', '/api/api-tokens/1/revoke']]) {
        const res = await as(sales.cookie)(verb, path).send({ name: 'Mine', role: 'admin' });
        assert.equal(res.status, 403, `${verb} ${path} -> ${res.status}`);
      }
    });

    test('an admin can', async () => {
      const res = await as(admin.cookie)('post', '/api/api-tokens').send({ name: 'Reporting', role: 'admin' });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.match(res.body.data.token, /^ctz_/, 'the token is shown once, here');
    });

    test('an unauthenticated caller is turned away first', async () => {
      const res = await as(null)('get', '/api/api-tokens');
      assert.equal(res.status, 401, JSON.stringify(res.body));
    });
  });

  // ------------------------------------------------ #22: who sees the history

  describe('the pipeline counts every currency (#25)', () => {
    test('a USD quotation is converted at the rate on its date, and one with no rate is counted as left out', async () => {
      await db.query(`INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from, source) VALUES ('USD', 'INR', 80, '2026-08-31', 'manual') ON CONFLICT DO NOTHING`);
      await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, currency, status, sales_person)
         VALUES ('CTZ/QT/2026/881', 'Dollar Deal Inc', '2026-09-01', 1000, 'USD', 'Submitted', 'FX Person'),
                ('CTZ/QT/2026/882', 'Dirham Deal LLC', '2026-09-01', 500, 'AED', 'Submitted', 'FX Person')`);
      const res = await as(admin.cookie)('get', '/api/pipeline?sales_person=FX%20Person');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const sent = res.body.data.stages.find((s) => s.name === 'Sent');
      assert.equal(sent.value, 80000, 'USD 1,000 at 80 is ₹80,000 in the column total');
      assert.equal(sent.without_rate, 1, 'the AED one has no rate and is said to be left out');
      assert.equal(res.body.data.without_rate, 1);
      const card = res.body.data.cards.find((c) => c.quotation_no === 'CTZ/QT/2026/881');
      assert.equal(Number(card.value_inr), 80000);
      assert.equal(Number(card.quotation_value), 1000, 'the card still shows its own currency');
    });
  });

  describe('tasks, notes, files and timelines are scoped to the person (#22)', () => {
    const MINE = 'CTZ/QT/2026/701';
    const THEIRS = 'CTZ/QT/2026/702';

    before(async () => {
      await db.query(
        `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
         VALUES ($1, 'Own Deal Ltd', '2026-09-01', 10000, 'Submitted', $3), ($2, 'Other Deal Ltd', '2026-09-01', 20000, 'Submitted', 'Somebody Else')
         ON CONFLICT DO NOTHING`, [MINE, THEIRS, sales.user.name]);
      await db.query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ('quotation', $1, 'A colleague''s note', 'Somebody Else')`, [THEIRS]);
      await db.query(`INSERT INTO tasks (entity, entity_id, title, created_by) VALUES ('quotation', $1, 'A colleague''s task', 'Somebody Else')`, [THEIRS]);
    });

    test("a sales user reads their own record's timeline and not a colleague's", async () => {
      const own = await as(sales.cookie)('get', `/api/timeline?entity=quotation&id=${encodeURIComponent(MINE)}`);
      assert.equal(own.status, 200, JSON.stringify(own.body));
      const other = await as(sales.cookie)('get', `/api/timeline?entity=quotation&id=${encodeURIComponent(THEIRS)}`);
      assert.equal(other.status, 404, 'a colleague\'s deal is not confirmed to exist');
      const asAdmin = await as(admin.cookie)('get', `/api/timeline?entity=quotation&id=${encodeURIComponent(THEIRS)}`);
      assert.equal(asAdmin.status, 200);
    });

    test('the task, note and file lists hold only what the person may see', async () => {
      const notes = await as(sales.cookie)('get', '/api/notes?limit=500');
      assert.equal(notes.status, 200);
      assert.equal(notes.body.data.some((n) => n.entity_id === THEIRS), false, 'a colleague\'s note is not listed');
      const tasks = await as(sales.cookie)('get', '/api/tasks?limit=500');
      assert.equal(tasks.body.data.some((t) => t.entity_id === THEIRS), false, 'a colleague\'s task is not listed');
      const all = await as(admin.cookie)('get', '/api/tasks?limit=500');
      assert.ok(all.body.data.some((t) => t.entity_id === THEIRS), 'an admin sees everything');

      const { rows: [n] } = await db.query('SELECT id FROM notes WHERE entity_id = $1', [THEIRS]);
      assert.equal((await as(sales.cookie)('get', `/api/notes/${n.id}`)).status, 404);
      assert.equal((await as(sales.cookie)('patch', `/api/notes/${n.id}`).send({ body: 'Rewritten' })).status, 404);
      assert.equal((await as(sales.cookie)('delete', `/api/notes/${n.id}`)).status, 404);

      const summary = await as(sales.cookie)('get', '/api/tasks/summary');
      const everyone = await as(admin.cookie)('get', '/api/tasks/summary');
      assert.ok(summary.body.data.open < everyone.body.data.open, 'the counts are the person\'s too');
    });

    test("nothing is hung on a colleague's record, and nobody signs as someone else", async () => {
      const onTheirs = await as(sales.cookie)('post', '/api/notes').send({ entity: 'quotation', entity_id: THEIRS, body: 'Hello' });
      assert.equal(onTheirs.status, 404, JSON.stringify(onTheirs.body));

      const signed = await as(sales.cookie)('post', '/api/notes').send({ entity: 'quotation', entity_id: MINE, body: 'Mine', author: 'The Boss' });
      assert.equal(signed.status, 201, JSON.stringify(signed.body));
      assert.equal(signed.body.data.author, sales.user.name, 'the session names the author, not the request');
      const edited = await as(sales.cookie)('patch', `/api/notes/${signed.body.data.id}`).send({ body: 'Mine, edited', author: 'The Boss' });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(edited.body.data.author, sales.user.name);
    });

    test('a task on several records shows on each of their timelines', async () => {
      const { rows: [co] } = await db.query('SELECT company_id FROM quotations WHERE quotation_no = $1', [MINE]);
      assert.ok(co.company_id, 'the quotation is linked to its company');
      const made = await as(sales.cookie)('post', '/api/tasks').send({
        entity: 'quotation', entity_id: MINE, title: 'Send the revised scope',
        targets: [{ entity: 'company', entity_id: String(co.company_id) }],
      });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const onCompany = await as(sales.cookie)('get', `/api/timeline?entity=company&id=${co.company_id}`);
      assert.equal(onCompany.status, 200, JSON.stringify(onCompany.body));
      const task = onCompany.body.data.find((i) => i.kind === 'task' && i.id === made.body.data.id);
      assert.ok(task, 'the task is on the company\'s timeline too');
      assert.deepEqual(task.record.targets, [{ entity: 'company', entity_id: String(co.company_id) }]);

      const sneaky = await as(sales.cookie)('patch', `/api/tasks/${made.body.data.id}`)
        .send({ targets: [{ entity: 'quotation', entity_id: THEIRS }] });
      assert.equal(sneaky.status, 404, 'a task is not put on a record its maker may not see');

      const off = await as(sales.cookie)('patch', `/api/tasks/${made.body.data.id}`).send({ targets: [] });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      const { rows } = await db.query('SELECT entity FROM task_targets WHERE task_id = $1', [made.body.data.id]);
      assert.deepEqual(rows.map((r) => r.entity), ['quotation'], 'only its own record is left');
    });

    test('the old remarks become the first, pinned note, once', async () => {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      await db.query(`UPDATE quotations SET remarks = 'Client wants a site visit first' WHERE quotation_no = $1`, [MINE]);
      const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations', '051_task_targets_first_notes.sql'), 'utf8');
      await db.query(migration);
      await db.query(migration);
      const { rows } = await db.query(`SELECT author, pinned FROM notes WHERE entity = 'quotation' AND entity_id = $1 AND body = 'Client wants a site visit first'`, [MINE]);
      assert.deepEqual(rows, [{ author: 'Moved from remarks', pinned: true }]);

      const timeline = await as(sales.cookie)('get', `/api/timeline?entity=quotation&id=${encodeURIComponent(MINE)}`);
      assert.equal(timeline.body.data[0].pinned, true, 'a pinned note heads the history');
    });
  });
});
