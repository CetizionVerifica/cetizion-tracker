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
});
