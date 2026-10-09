import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The authorisation role matrix (#89).
 *
 * Four callers — nobody, two different sales users, an administrator — put
 * against every route the policy declares, in `AUTH_MODE=database`, which is
 * the only mode with two kinds of user to tell apart.
 *
 * Two halves, and the split matters:
 *
 *   The sweep proves *refusal*. Every declared route is asked for by a
 *   caller who should not have it, and the answer must be exactly 401 or
 *   403. A 404, a 422 or a 500 is not a pass: those mean the request reached
 *   something, and "it happened to fail" is not "it was refused".
 *
 *   The named tests below prove *permission and scope* — that the people who
 *   should get through do, that one salesperson cannot touch another's row,
 *   that the public routes are guarded by the mechanism the policy claims,
 *   and that a refused write left the database as it was.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL. It
 * creates one of its own, named authz_matrix_*, and drops only that.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const METRICS_TOKEN = 'metrics-token-for-the-role-matrix';
const HOOK_SECRET = 'incoming-webhook-secret-for-the-role-matrix';

/**
 * Refuse to run against anything that might hold real records.
 *
 * The suite only ever creates and drops a database it names itself, but the
 * connection it does that from is a real connection, and a mistyped
 * TEST_DATABASE_URL pointing at production is the kind of mistake that is
 * cheap to prevent and expensive to discover.
 */
function assertIsolatedTestDatabase(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`TEST_DATABASE_URL is not a URL: ${url}`); }
  const name = parsed.pathname.replace(/^\//, '');
  const forbidden = /^(cetizion[_-]?tracker.*|.*prod.*|.*live.*|.*staging.*)$/i;
  if (forbidden.test(name)) {
    throw new Error(
      `TEST_DATABASE_URL points at the database "${name}", which looks like a business database. ` +
      'Point it at an administrative database this suite may create throwaway databases on (CI uses "postgres").'
    );
  }
  return name;
}

describe('authorisation role matrix', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let testDbName;
  let db;
  let app;
  let pool;
  let createUser;
  let resetLimiter;
  let server;
  let policy;
  let declared;

  let anonymous;
  let salesA;
  let salesB;
  let admin;
  let hr;

  before(async () => {
    assertIsolatedTestDatabase(ADMIN_URL);

    const adminClient = new pg.Client({ connectionString: ADMIN_URL });
    await adminClient.connect();
    // The only name this suite ever drops, built here and never taken from
    // the environment.
    testDbName = `authz_matrix_${process.pid}_${Date.now()}`;
    await adminClient.query(`CREATE DATABASE ${testDbName}`);
    await adminClient.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${testDbName}`;
    dbUrl = u.toString();

    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    // Nothing leaves this process.
    process.env.EMAIL_MODE = 'log';
    process.env.METRICS_TOKEN = METRICS_TOKEN;
    process.env.INCOMING_WEBHOOK_SECRET = HOOK_SECRET;

    ({ default: app } = await import('../src/app.js'));
    // One server for every request in this file, rather than supertest's
    // default of a fresh ephemeral one per call.
    //
    // That default is not safe for a sweep of this size. Several hundred
    // listen/close cycles churn through the ephemeral port range, and on a
    // developer's machine another local process can take a port between
    // supertest reading it and the request arriving. The answer then comes
    // from that process, not from this application — during this work one
    // such reply was a plain-text `403 Invalid CSRF token`, a string that
    // appears nowhere in this repository or its dependencies. A security
    // sweep that occasionally interviews the wrong server is worse than no
    // sweep, because the failure looks exactly like a wrongly gated route.
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
    policy = await import('../src/lib/authz/policy.js');
    declared = policy.policyRoutes();

    const { loginLimiter } = await import('../src/auth/routes.js');
    resetLimiter = () => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
        try { loginLimiter.resetKey(ip); } catch { /* not a key this store knows */ }
      }
    };

    const signIn = async (email) => {
      resetLimiter();
      const res = await request(server).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };

    const a = await createUser({ name: 'Ada Admin', email: 'ada@example.com', password: PASSWORD, role: 'admin' }, db);
    const s1 = await createUser({ name: 'Sam Sales', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    const s2 = await createUser({ name: 'Bea Sales', email: 'bea@example.com', password: PASSWORD, role: 'sales' }, db);
    const h = await createUser({ name: 'Hema HR', email: 'hema@example.com', password: PASSWORD, role: 'hr' }, db);

    admin = { label: 'administrator', user: a, cookie: await signIn(a.email) };
    salesA = { label: 'sales user A', user: s1, cookie: await signIn(s1.email) };
    salesB = { label: 'sales user B', user: s2, cookie: await signIn(s2.email) };
    hr = { label: 'HR user', user: h, cookie: await signIn(h.email) };
    anonymous = { label: 'anonymous', user: null, cookie: null };
  });

  after(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
    await pool?.end();
    await db?.end();
    if (!testDbName) return;
    const adminClient = new pg.Client({ connectionString: ADMIN_URL });
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
    await adminClient.end();
  });

  const as = (who) => (method, path) => {
    const call = request(server)[method.toLowerCase()](path);
    return who.cookie ? call.set('Cookie', who.cookie) : call;
  };

  // ------------------------------------------------------------- the sweep

  /**
   * A concrete URL for a declared path. The values only have to route to the
   * same handler: refusal happens before any of them is looked up.
   */
  const SAMPLES = {
    key: 'CTZ-QT-2026-001', poNumber: 'PO-1', projectId: 'PRJ-2026-001', travelId: 'TRV-1',
    resource: 'quotations', report: 'summary', name: 'reminders.payment', kind: 'quotation',
    no: 'CTZ-QT-2026-001', token: 'x'.repeat(48), id: '1',
  };
  const concrete = (path) => path.replace(/:([A-Za-z0-9_]+)/g, (_, p) => SAMPLES[p] ?? '1');

  /** The routes the sweep drives: everything gated by the application session. */
  const gated = () => declared.filter((r) => r.access !== 'public');

  test('nobody signed in reaches nothing', async () => {
    const wrong = [];
    for (const entry of gated()) {
      const res = await as(anonymous)(entry.method, concrete(entry.path));
      if (res.status !== 401) {
        wrong.push(`${entry.method} ${entry.path} answered ${res.status} to an anonymous caller; expected 401.`);
      }
    }
    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });

  test('a sales user is refused every admin-only route', async () => {
    const wrong = [];
    for (const entry of gated().filter((r) => r.access === 'admin')) {
      const res = await as(salesA)(entry.method, concrete(entry.path));
      if (res.status !== 403) {
        wrong.push(
          `${entry.method} ${entry.path} answered ${res.status} to a sales user; expected 403 (${entry.why || 'admin only'}).`
        );
      }
    }
    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });

  test('an administrator is refused none of them', async () => {
    // Not that every call succeeds — most need a real record — but that none
    // is refused. 401 or 403 for an administrator is the failure.
    const wrong = [];
    for (const entry of gated().filter((r) => r.access === 'admin')) {
      const res = await as(admin)(entry.method, concrete(entry.path));
      if (res.status === 401 || res.status === 403) {
        wrong.push(`${entry.method} ${entry.path} answered ${res.status} to an administrator. Body: ${JSON.stringify(res.body)}`);
      }
    }
    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });

  /**
   * Routes whose 403 is not the route's own gate: either the row is somebody
   * else's, or the handler narrows the roles further than the three access
   * levels can express. A blanket sweep cannot tell those apart from a
   * wrongly closed route, so they are excluded here and proved one by one in
   * the named tests below, which is where such a rule can actually be checked.
   *
   * `travel-desk-only` is the second kind: `any` on the route, admin and HR
   * in the handler, sales refused (#214). It is proved in "paying a travel
   * agency is the travel desk's" below.
   */
  const OBJECT_SCOPED = ['record-owner', 'mailbox-owner', 'self-only', 'travel-desk-only'];
  const objectScoped = (entry) => (entry.restrictions || []).some((r) => OBJECT_SCOPED.includes(r));

  // The HR role (#196 §3): the travel desk, and nothing else.
  test('an HR user is refused every route the policy does not mark for HR', async () => {
    const key = (r) => `${r.method} ${r.path}`;
    const allowed = new Set(policy.hrRoutes().map(key));
    const wrong = [];
    for (const entry of gated().filter((r) => !allowed.has(key(r)))) {
      const res = await as(hr)(entry.method, concrete(entry.path));
      if (res.status !== 403) wrong.push(`${key(entry)} answered ${res.status} to an HR user; expected 403.`);
    }
    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });

  test('an HR user reaches every route marked for HR', async () => {
    const wrong = [];
    for (const entry of policy.hrRoutes().filter((r) => r.access !== 'public' && !objectScoped(r))) {
      const res = await as(hr)(entry.method, concrete(entry.path));
      if (res.status === 401 || res.status === 403) {
        wrong.push(`${entry.method} ${entry.path} answered ${res.status} to an HR user; the policy marks it for HR. Body: ${JSON.stringify(res.body)}`);
      }
    }
    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });

  test('a sales user reaches the routes open to any signed-in user', async () => {
    const wrong = [];

    for (const entry of gated().filter((r) => r.access === 'any' && !objectScoped(r))) {
      const res = await as(salesA)(entry.method, concrete(entry.path));
      if (res.status === 401 || res.status === 403) {
        wrong.push(`${entry.method} ${entry.path} answered ${res.status} to a sales user; the policy says any signed-in user. Body: ${JSON.stringify(res.body)}`);
      }
    }

    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });

  // ------------------------------------------------- object-level: accounts

  describe('an account is its owner\'s, and the roster is the administrator\'s', () => {
    test('a sales user cannot read the account list or change another account', async () => {
      const list = await as(salesA)('get', '/api/users');
      assert.equal(list.status, 403, JSON.stringify(list.body));

      const demote = await as(salesA)('patch', `/api/users/${admin.user.id}`).send({ role: 'sales' });
      assert.equal(demote.status, 403, JSON.stringify(demote.body));

      const password = await as(salesA)('post', `/api/users/${salesB.user.id}/password`).send({ password: 'another-long-password' });
      assert.equal(password.status, 403, JSON.stringify(password.body));

      // Refused, not half-done.
      const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [admin.user.id]);
      assert.equal(rows[0].role, 'admin', 'the administrator is still an administrator');
    });

    test('a sales user cannot promote themselves', async () => {
      const res = await as(salesA)('patch', `/api/users/${salesA.user.id}`).send({ role: 'admin' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      const { rows } = await db.query('SELECT role FROM users WHERE id = $1', [salesA.user.id]);
      assert.equal(rows[0].role, 'sales', 'still a sales user');
    });

    test('an administrator may', async () => {
      const res = await as(admin)('get', '/api/users');
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test('each person sees themselves at /api/auth/me', async () => {
      for (const who of [admin, salesA, salesB]) {
        const res = await as(who)('get', '/api/auth/me');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.email, who.user.email);
        assert.equal(res.body.data.role, who.user.role);
      }
      const out = await as(anonymous)('get', '/api/auth/me');
      assert.equal(out.status, 401);
    });
  });

  // ----------------------------------- object-level: one salesperson's rows

  describe('a saved reply belongs to whoever wrote it', () => {
    let mine;

    before(async () => {
      const res = await as(salesA)('post', '/api/inbox/canned')
        .send({ name: 'Sam\'s standard reply', body: 'Thank you for your enquiry.', shared: true });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      mine = res.body.data.id;
    });

    test('the other sales user cannot edit it', async () => {
      const res = await as(salesB)('patch', `/api/inbox/canned/${mine}`).send({ body: 'Rewritten by somebody else.' });
      assert.equal(res.status, 403, JSON.stringify(res.body));

      const { rows } = await db.query('SELECT body FROM canned_responses WHERE id = $1', [mine]);
      assert.equal(rows[0].body, 'Thank you for your enquiry.', 'the text is untouched');
    });

    test('the other sales user cannot delete it', async () => {
      const res = await as(salesB)('delete', `/api/inbox/canned/${mine}`);
      assert.equal(res.status, 403, JSON.stringify(res.body));

      const { rows } = await db.query('SELECT 1 FROM canned_responses WHERE id = $1', [mine]);
      assert.equal(rows.length, 1, 'the row is still there');
    });

    test('its author can', async () => {
      const res = await as(salesA)('patch', `/api/inbox/canned/${mine}`).send({ body: 'Thank you for getting in touch.' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test('and an administrator may tidy anybody\'s', async () => {
      const res = await as(admin)('patch', `/api/inbox/canned/${mine}`).send({ body: 'Tidied.' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  describe('a notification addressed to one person is not another\'s', () => {
    before(async () => {
      await db.query(
        `INSERT INTO notifications (kind, username, title, body) VALUES ('test', $1, 'For Sam only', 'A private line')`,
        [salesA.user.email]
      );
    });

    test('the addressee sees it', async () => {
      const res = await as(salesA)('get', '/api/notifications');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.data.some((n) => n.title === 'For Sam only'));
    });

    test('the other sales user does not', async () => {
      const res = await as(salesB)('get', '/api/notifications');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(!res.body.data.some((n) => n.title === 'For Sam only'), 'it is not in somebody else\'s bell');
    });
  });

  // ------------------------------------- refused writes change nothing

  // ------------------------------------- object-level: project milestones

  /**
   * `project-milestones` is declared `any` on all three operations with a
   * `record-owner` restriction, so the blanket sweep above skips it. That skip
   * has to be paid for here, because the scoping is the whole control: #119
   * was this resource shipped without one. Marking a milestone reached stamps
   * milestone_reached_on on every payment stage pointing at it, and a stage
   * triggered "On Milestone" is ready to invoice the moment that is not null.
   */
  describe('a milestone belongs to whoever is on the project', () => {
    let ownMilestone;
    let otherMilestone;

    before(async () => {
      // sales_person and owner_user_id both, deliberately. #18 Phase 2C
      // replaced the free-text name match with a predicate on owner_user_id,
      // so the name is left here as the thing that must NOT be what decides:
      // if the scoping ever regressed to matching it again, these rows would
      // still pass and the regression would be invisible.
      await db.query(
        `INSERT INTO projects (project_id, client_name, sales_person, owner_user_id) VALUES
           ('PRJ-MATRIX-A', 'A Client', $1, $3),
           ('PRJ-MATRIX-B', 'B Client', $2, $4)`,
        [salesA.user.name, salesB.user.name, salesA.user.id, salesB.user.id]
      );
      const { rows } = await db.query(
        `INSERT INTO project_milestones (project_id, name) VALUES
           ('PRJ-MATRIX-A', 'Kick-off'), ('PRJ-MATRIX-B', 'Kick-off')
         RETURNING id, project_id`
      );
      ownMilestone = rows.find((r) => r.project_id === 'PRJ-MATRIX-A').id;
      otherMilestone = rows.find((r) => r.project_id === 'PRJ-MATRIX-B').id;
    });

    test('the person on the project sees theirs and not the other', async () => {
      const res = await as(salesA)('get', '/api/project-milestones');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ids = res.body.data.map((m) => m.id);
      assert.ok(ids.includes(ownMilestone), 'their own project\'s milestone is missing');
      assert.ok(!ids.includes(otherMilestone), 'somebody else\'s project\'s milestone is listed');
    });

    test('reading another project\'s milestone directly is refused', async () => {
      const res = await as(salesA)('get', `/api/project-milestones/${otherMilestone}`);
      assert.equal(res.status, 404, `expected the row to be out of reach, got ${res.status}`);
    });

    test('marking another project\'s milestone reached does not reach it', async () => {
      const res = await as(salesA)('patch', `/api/project-milestones/${otherMilestone}`)
        .send({ reached_on: '2026-03-01' });
      const { rows } = await db.query('SELECT reached_on FROM project_milestones WHERE id = $1', [otherMilestone]);
      assert.equal(rows[0].reached_on, null,
        `PATCH answered ${res.status} and stamped another project's milestone. That is a stage into the invoice run (#119).`);
    });

    test('deleting another project\'s milestone does not reach it either', async () => {
      const res = await as(salesA)('delete', `/api/project-milestones/${otherMilestone}`);
      const { rows } = await db.query('SELECT 1 FROM project_milestones WHERE id = $1', [otherMilestone]);
      assert.equal(rows.length, 1, `DELETE answered ${res.status} and removed somebody else's milestone`);
    });

    test('their own they may mark, and an administrator may mark anybody\'s', async () => {
      const own = await as(salesA)('patch', `/api/project-milestones/${ownMilestone}`)
        .send({ reached_on: '2026-03-02' });
      assert.equal(own.status, 200, JSON.stringify(own.body));

      const byAdmin = await as(admin)('patch', `/api/project-milestones/${otherMilestone}`)
        .send({ reached_on: '2026-03-03' });
      assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));
    });
  });

  describe('a refused write leaves the database as it was', () => {
    test('a sales user cannot add an exchange rate', async () => {
      const before = await db.query('SELECT COUNT(*)::int AS n FROM exchange_rates');
      const res = await as(salesA)('post', '/api/exchange-rates')
        .send({ from_currency: 'USD', to_currency: 'INR', rate: 99, effective_from: '2026-06-01', source: 'manual' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      const after = await db.query('SELECT COUNT(*)::int AS n FROM exchange_rates');
      assert.equal(after.rows[0].n, before.rows[0].n, 'no rate was written');
    });

    test('a sales user cannot change a setting', async () => {
      await db.query(
        `INSERT INTO settings (key, value) VALUES ('margin_visible_to_sales', 'false')
         ON CONFLICT (key) DO UPDATE SET value = 'false'`
      );
      const res = await as(salesA)('patch', '/api/settings/margin_visible_to_sales').send({ value: 'true' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'margin_visible_to_sales'`);
      assert.equal(rows[0].value, 'false', 'the setting is untouched');
    });

    test('a sales user cannot delete a company', async () => {
      const made = await as(admin)('post', '/api/companies').send({ name: 'Untouchable Industries' });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const id = made.body.data.id;

      const res = await as(salesA)('delete', `/api/companies/${id}`);
      assert.equal(res.status, 403, JSON.stringify(res.body));

      const { rows } = await db.query('SELECT 1 FROM companies WHERE id = $1', [id]);
      assert.equal(rows.length, 1, 'the company is still there');
    });

    test('a sales user cannot issue themselves an API token', async () => {
      const before = await db.query('SELECT COUNT(*)::int AS n FROM api_tokens');
      const res = await as(salesA)('post', '/api/api-tokens').send({ name: 'mine', role: 'admin' });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      const after = await db.query('SELECT COUNT(*)::int AS n FROM api_tokens');
      assert.equal(after.rows[0].n, before.rows[0].n, 'no token was issued');
    });
  });

  // ----------------------------------------- public routes and their locks

  describe('the public routes are guarded by what the policy says guards them', () => {
    test('GET /api/health is open, and its deep answer is not', async () => {
      const open = await as(anonymous)('get', '/api/health');
      assert.equal(open.status, 200, JSON.stringify(open.body));

      const deepAnonymous = await as(anonymous)('get', '/api/health?deep=1');
      assert.equal(deepAnonymous.status, 401, JSON.stringify(deepAnonymous.body));

      const deepSales = await as(salesA)('get', '/api/health?deep=1');
      assert.equal(deepSales.status, 403, JSON.stringify(deepSales.body));

      const deepAdmin = await as(admin)('get', '/api/health?deep=1');
      assert.ok([200, 503].includes(deepAdmin.status), `administrator got ${deepAdmin.status}`);
    });

    test('GET /metrics needs the scrape token or an administrator', async () => {
      const open = await request(server).get('/metrics');
      assert.equal(open.status, 401, 'no token, no metrics');

      const wrong = await request(server).get('/metrics').set('Authorization', 'Bearer not-the-token');
      assert.equal(wrong.status, 401);

      const token = await request(server).get('/metrics').set('Authorization', `Bearer ${METRICS_TOKEN}`);
      assert.equal(token.status, 200);

      const sales = await as(salesA)('get', '/metrics');
      assert.equal(sales.status, 401, 'a sales session is not an administrator');

      const asAdmin = await as(admin)('get', '/metrics');
      assert.equal(asAdmin.status, 200);
    });

    test('POST /api/mcp needs an API token, and honours the one it is given', async () => {
      const none = await request(server).post('/api/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(none.status, 401, JSON.stringify(none.body));
      assert.match(String(none.headers['www-authenticate'] || ''), /Bearer/);

      const bogus = await request(server).post('/api/mcp')
        .set('Authorization', `Bearer ctz_${'a'.repeat(40)}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      assert.equal(bogus.status, 401, 'a well-formed token nobody issued is still nobody');

      const issued = await as(admin)('post', '/api/api-tokens').send({ name: 'matrix', role: 'admin', can_write: false });
      assert.equal(issued.status, 201, JSON.stringify(issued.body));
      const value = issued.body.data.token;

      const good = await request(server).post('/api/mcp')
        .set('Authorization', `Bearer ${value}`)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(good.status, 200, JSON.stringify(good.body));

      // A read-only token is offered no tool that writes.
      const names = (good.body?.result?.tools || []).map((t) => t.name);
      assert.ok(names.includes('search_records'), JSON.stringify(names));
      assert.ok(!names.includes('add_note'), 'a token that may not write is not offered the write tools');

      // Revoking bites at once: no cached session to outlive it.
      const revoke = await as(admin)('post', `/api/api-tokens/${issued.body.data.id}/revoke`);
      assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
      const after = await request(server).post('/api/mcp')
        .set('Authorization', `Bearer ${value}`)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      assert.equal(after.status, 401, 'a revoked token is refused');
    });

    test('POST /api/hooks/enquiries needs the signature, not just the address', async () => {
      const off = await request(server).post('/api/hooks/enquiries').send({ client_name: 'While switched off' });
      assert.equal(off.status, 404, 'the route does not exist until Settings switches it on');

      await db.query(
        `INSERT INTO settings (key, value) VALUES ('incoming_enquiries_enabled', 'true')
         ON CONFLICT (key) DO UPDATE SET value = 'true'`
      );

      const before = await db.query('SELECT COUNT(*)::int AS n FROM enquiries');

      const unsigned = await request(server).post('/api/hooks/enquiries')
        .set('Content-Type', 'application/json')
        .send({ client_name: 'Unsigned Ltd' });
      assert.equal(unsigned.status, 401, JSON.stringify(unsigned.body));

      // t=<unix seconds>,v1=<hmac of "t.body">, as lib/webhooks.js signs it.
      const header = (secret, body, at = Math.floor(Date.now() / 1000)) =>
        `t=${at},v1=${crypto.createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;

      const forged = JSON.stringify({ client_name: 'Forged Ltd' });
      const wrong = await request(server).post('/api/hooks/enquiries')
        .set('Content-Type', 'application/json')
        .set('x-cetizion-signature', header('the-wrong-secret', forged))
        .send(forged);
      assert.equal(wrong.status, 401, JSON.stringify(wrong.body));

      // The right secret over a different body is still not a signature for this one.
      const tampered = JSON.stringify({ client_name: 'Tampered Ltd' });
      const swapped = await request(server).post('/api/hooks/enquiries')
        .set('Content-Type', 'application/json')
        .set('x-cetizion-signature', header(HOOK_SECRET, forged))
        .send(tampered);
      assert.equal(swapped.status, 401, JSON.stringify(swapped.body));

      // And a correctly signed call from an hour ago is a replay, not a caller.
      const stale = JSON.stringify({ client_name: 'Replayed Ltd' });
      const old = await request(server).post('/api/hooks/enquiries')
        .set('Content-Type', 'application/json')
        .set('x-cetizion-signature', header(HOOK_SECRET, stale, Math.floor(Date.now() / 1000) - 3600))
        .send(stale);
      assert.equal(old.status, 401, JSON.stringify(old.body));

      const refused = await db.query('SELECT COUNT(*)::int AS n FROM enquiries');
      assert.equal(refused.rows[0].n, before.rows[0].n, 'none of the four unsigned or stale calls wrote an enquiry');

      const good = JSON.stringify({ client_name: 'Signed Ltd', service: 'Inspection' });
      const signed = await request(server).post('/api/hooks/enquiries')
        .set('Content-Type', 'application/json')
        .set('x-cetizion-signature', header(HOOK_SECRET, good))
        .send(good);
      assert.ok([200, 201].includes(signed.status), JSON.stringify(signed.body));

      const written = await db.query(`SELECT COUNT(*)::int AS n FROM enquiries WHERE client_name = 'Signed Ltd'`);
      assert.equal(written.rows[0].n, 1, 'only the signed call wrote anything');
    });

    test('the acceptance link is the credential, and it is bound to one quotation', async () => {
      const made = await as(salesA)('post', '/api/quotations')
        .send({ client_name: 'Acceptance Test Ltd', quotation_value: 125000, currency: 'INR', quotation_date: '2026-01-15' });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const quotationNo = made.body.data.quotation_no;

      const link = await as(salesA)('post', `/api/quotations/${encodeURIComponent(quotationNo)}/acceptance-link`).send({});
      assert.equal(link.status, 201, JSON.stringify(link.body));
      const token = link.body.data.url.split('/accept/')[1];
      assert.ok(token?.length >= 40, 'a token came back once');

      const guessed = await request(server).get(`/api/public/accept/${'z'.repeat(48)}`);
      assert.equal(guessed.status, 404, 'a guessed token opens nothing');

      const opened = await request(server).get(`/api/public/accept/${token}`);
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.data.quotation.quotation_no, quotationNo);

      // Bound to one quotation, and showing only the client's half of it.
      //
      // The whole key set rather than a couple of absences: clientView() in
      // routes/acceptance.js is an allow-list, and this is what holds it to
      // that. `sales_person` is on it deliberately — the email carrying the
      // link is already signed with that name — so the guarantee is not "no
      // owner" but "nothing the client was not sent".
      assert.deepEqual(Object.keys(opened.body.data.quotation).sort(), [
        'client_name', 'contact_name', 'currency', 'lines', 'quotation_date', 'quotation_no',
        'revision', 'sales_person', 'service_quoted', 'subtotal', 'tax_total', 'terms',
        'total', 'valid_until',
      ], 'the public acceptance view grew a field; add it here only if a client may see it');
      for (const internal of ['probability', 'stage_id', 'notes', 'cost', 'margin', 'approved_by']) {
        assert.equal(opened.body.data.quotation[internal], undefined, `${internal} is internal`);
      }

      // And it is not a way into the rest of the API.
      const elsewhere = await request(server).get('/api/quotations').set('Authorization', `Bearer ${token}`);
      assert.equal(elsewhere.status, 401, 'an acceptance token is not a session');
    });

    test('the portal has its own sign-in, and a staff session is not one', async () => {
      const me = await request(server).get('/api/portal/me');
      assert.equal(me.status, 401, JSON.stringify(me.body));

      const asStaff = await as(admin)('get', '/api/portal/me');
      assert.equal(asStaff.status, 401, 'a staff session is not a portal session');

      const bogus = await request(server).post('/api/portal/login').send({ token: 'q'.repeat(48) });
      assert.equal(bogus.status, 401, JSON.stringify(bogus.body));

      // request-link answers the same sentence either way, so it confirms nothing.
      const unknown = await request(server).post('/api/portal/request-link').send({ email: 'nobody@example.com' });
      assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
      assert.match(unknown.body.data.message, /If that address belongs to a client/);
    });

    test('GET /api/auth/config says which question the form will ask, and nothing else', async () => {
      const res = await request(server).get('/api/auth/config');
      assert.equal(res.status, 200);
      // `providers` arrived with OAuth sign-in (#71): the form has to know
      // which buttons to draw. It is still "nothing else" that matters, so
      // the shape is pinned here as well as the key set — a provider entry
      // is a label to click, never a client id or a secret.
      assert.deepEqual(Object.keys(res.body.data).sort(), ['mode', 'providers']);
      assert.equal(res.body.data.mode, 'database');
      assert.ok(Array.isArray(res.body.data.providers));
      for (const provider of res.body.data.providers) {
        assert.deepEqual(Object.keys(provider).sort(), ['id', 'label'],
          'a provider entry may carry what to draw and nothing more');
      }
    });
  });

  // ----------------------------------------------- travel finance (#85)

  describe('travel finance is gated as Issue #85 leaves it', () => {
    let claimId;
    let invoiceId;

    before(async () => {
      const trip = await as(salesA)('post', '/api/travel-logs')
        .send({ travel_id: 'TRV-MATRIX-1', employee_name: 'Sam Sales', travel_date: '2026-02-01' });
      // The trip is convenience, not the subject: the claim below is what matters.
      assert.ok([201, 422].includes(trip.status), JSON.stringify(trip.body));

      const claim = await as(salesA)('post', '/api/expense-claims').send({
        claim_id: 'CLM-MATRIX-1', travel_id: 'TRV-MATRIX-1', expense_category: 'Meals',
        amount_claimed: 5000, submission_date: '2026-02-02',
      });
      assert.equal(claim.status, 201, JSON.stringify(claim.body));
      claimId = claim.body.data.id;

      const invoice = await as(salesA)('post', '/api/vendor-invoices').send({
        vendor_invoice_id: 'VIN-MATRIX-1', travel_id: 'TRV-MATRIX-1',
        vendor_invoice_no: 'V-1', invoice_date: '2026-02-02', invoice_amount: 20000,
      });
      assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
      invoiceId = invoice.body.data.id;
    });

    test('admin and sales may both submit an ordinary claim', async () => {
      const bySales = await as(salesB)('post', '/api/expense-claims').send({
        claim_id: 'CLM-MATRIX-2', travel_id: 'TRV-MATRIX-1', expense_category: 'Travel',
        amount_claimed: 2500, submission_date: '2026-02-03',
      });
      assert.equal(bySales.status, 201, JSON.stringify(bySales.body));

      const byAdmin = await as(admin)('post', '/api/expense-claims').send({
        claim_id: 'CLM-MATRIX-3', travel_id: 'TRV-MATRIX-1', expense_category: 'Travel',
        amount_claimed: 1500, submission_date: '2026-02-03',
      });
      assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.body));
    });

    test('only an administrator may approve a claim', async () => {
      const res = await as(salesA)('post', `/api/expense-claims/${claimId}/decide`)
        .send({ approval_status: 'Approved', approved_by: 'Sam Sales' });
      const { rows } = await db.query('SELECT approval_status FROM employee_expense_claims WHERE id = $1', [claimId]);
      assert.equal(
        res.status, 403,
        `a sales user got ${res.status} approving their own claim, and the claim is now "${rows[0].approval_status}". ` +
        'requireAdmin on POST /api/expense-claims/:id/decide is the Issue #85 fix and it is in the history below this commit; losing it puts the live hole back.'
      );
      assert.equal(rows[0].approval_status, 'Submitted', 'the claim was not approved');
    });

    test('only an administrator may reimburse a claim', async () => {
      const res = await as(salesA)('post', `/api/expense-claims/${claimId}/reimburse`).send({ amount_reimbursed: 5000 });
      assert.equal(
        res.status, 403,
        `a sales user got ${res.status} reimbursing a claim. requireAdmin on POST /api/expense-claims/:id/reimburse is the Issue #85 fix; losing it lets a salesperson pay themselves.`
      );
    });

    test('protected claim fields cannot be written through ordinary CRUD', async () => {
      const res = await as(salesA)('patch', `/api/expense-claims/${claimId}`)
        .send({ approval_status: 'Approved', approved_by: 'Sam Sales', amount_reimbursed: 5000 });
      const { rows } = await db.query(
        'SELECT approval_status, amount_reimbursed FROM employee_expense_claims WHERE id = $1', [claimId]
      );
      assert.notEqual(rows[0].approval_status, 'Approved',
        `PATCH /api/expense-claims/:id approved the claim (${res.status}). An admin-only /decide route is decoration if PATCH can write approval_status. ` +
        'protectedFields for expense-claims is enforced in validate() in lib/crud.js (#85).');
      assert.equal(Number(rows[0].amount_reimbursed), 0, 'and it did not reimburse it either');
    });

    /**
     * #85 left this route open to every signed-in role, so a sales user could
     * pay a travel agency. That was never a decision — it was what an open
     * gate happened to allow — and #214 closes it: paying the agency is the
     * travel desk's work with the administrator. The capability is withdrawn
     * from sales deliberately, which is why this test now asserts the refusal
     * it used to assert the opposite of.
     */
    test('paying a travel agency is the travel desk\'s and the administrator\'s, not a sales user\'s', async () => {
      const byAdmin = await as(admin)('post', `/api/vendor-invoices/${invoiceId}/pay`)
        .send({ amount_paid: 20000, payment_date: '2026-02-06' });
      assert.equal(byAdmin.status, 200, JSON.stringify(byAdmin.body));

      const byHr = await as(hr)('post', `/api/vendor-invoices/${invoiceId}/pay`)
        .send({ amount_paid: 30000, payment_date: '2026-02-07' });
      assert.equal(byHr.status, 200, `the travel desk keeps it: ${JSON.stringify(byHr.body)}`);

      const bySales = await as(salesA)('post', `/api/vendor-invoices/${invoiceId}/pay`)
        .send({ amount_paid: 40000, payment_date: '2026-02-08' });
      assert.equal(
        bySales.status, 403,
        `a sales user got ${bySales.status} paying a travel agency. requireRole('admin', 'hr') on `
        + 'POST /api/vendor-invoices/:id/pay is the #214 decision; losing it hands the payment back to sales.'
      );
    });

    test('correcting a vendor payment is the administrator\'s alone', async () => {
      for (const who of [hr, salesA]) {
        const res = await as(who)('post', `/api/vendor-invoices/${invoiceId}/pay/correct`)
          .send({ amount: -1000, reason: 'Mistyped' });
        assert.equal(
          res.status, 403,
          `${who.label} got ${res.status} correcting a vendor payment. Only an administrator may take a figure `
          + 'back off an agency bill (#214) — HR pays but does not undo.'
        );
      }
    });

    test('protected vendor-payment fields cannot be written through ordinary CRUD', async () => {
      const { rows: before } = await db.query('SELECT amount_paid FROM travel_vendor_invoices WHERE id = $1', [invoiceId]);
      const res = await as(salesA)('patch', `/api/vendor-invoices/${invoiceId}`)
        .send({ amount_paid: 999999, payment_date: '2026-03-01' });
      const { rows: after } = await db.query('SELECT amount_paid FROM travel_vendor_invoices WHERE id = $1', [invoiceId]);
      assert.equal(
        Number(after[0].amount_paid), Number(before[0].amount_paid),
        `PATCH /api/vendor-invoices/:id moved amount_paid (${res.status}). A payment is recorded through POST /api/vendor-invoices/:id/pay. ` +
        'protectedFields for vendor-invoices is enforced in validate() in lib/crud.js (#85).'
      );
    });
  });

  // ------------------------------------- which invoice billed a trip (#214)

  describe('the trip billing link is the PO side\'s, not the travel desk\'s', () => {
    let tripId;
    let stageId;

    /**
     * Set up through SQL rather than the API, deliberately: the admin sweep
     * above drives every administrator-only route, DELETE /api/trip-types/:id
     * included, so by the time this runs the seeded Chargeable type may be
     * gone and POST /api/travel-logs cannot make a chargeable trip. The
     * subject here is the gate on one column, not trip creation.
     */
    before(async () => {
      await db.query(`INSERT INTO projects (project_id, client_name) VALUES ('PRJ-MX-214', 'Matrix 214 Ltd')`);
      await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value) VALUES ('PO-MX-214', 'PRJ-MX-214', 100000)`);
      // A travel invoice, not a share of the PO: since 097 (#214) a trip may
      // only be billed on `kind = 'travel'`. The subject here is still who
      // may write the link, not what the link may say.
      ({ rows: [{ id: stageId }] } = await db.query(
        `INSERT INTO payment_stages (kind, po_number, stage_name, trigger_event, amount, invoice_no, invoice_date)
              VALUES ('travel', 'PO-MX-214', 'Travel invoice', 'Manual', 25000, 'CVPL/MX/214', CURRENT_DATE) RETURNING id`));
      const { rows: [type] } = await db.query(
        `INSERT INTO trip_types (name, chargeable, sort_order) VALUES ('Chargeable (matrix 214)', true, 99)
         ON CONFLICT (name) DO UPDATE SET chargeable = true RETURNING id`);
      ({ rows: [{ id: tripId }] } = await db.query(
        `INSERT INTO travel_logs (travel_id, employee_name, po_number, trip_type_id)
              VALUES ('TRV-MX-214', 'Asha', 'PO-MX-214', $1) RETURNING id`, [type.id]));
    });

    const stored = async () => (await db.query(
      `SELECT billed_stage_id FROM travel_logs WHERE travel_id = 'TRV-MX-214'`)).rows[0].billed_stage_id;

    test('HR cannot reach the billing route, though it may edit the trip', async () => {
      const res = await as(hr)('post', '/api/travel-logs/TRV-MX-214/billed-stage').send({ billed_stage_id: stageId });
      assert.equal(
        res.status, 403,
        `an HR user got ${res.status} setting which client invoice billed a trip. The route is deliberately absent from ` +
        'HR_ROUTES: HR runs the travel desk (#196 §3) but which invoice recovered the cost is the PO side\'s (#214).'
      );
      assert.equal(await stored(), null, 'the link moved despite the 403');

      // The rest of the trip is still HR's work, which is why one field is
      // closed rather than the resource.
      const edit = await as(hr)('patch', `/api/travel-logs/${tripId}`).send({ remarks: 'Tickets reissued' });
      assert.equal(edit.status, 200, JSON.stringify(edit.body));
    });

    /**
     * The read-through phase (#214 §4) gives the travel desk one slice of
     * the sales side and nothing else. The sweeps above prove HR is refused
     * every route the policy does not mark for it; this proves the slice
     * itself is narrow — HR reads the invoice a trip is billed on through a
     * route it already had, and still cannot reach the payment stage behind
     * it by any other door.
     */
    test('the travel desk reads a trip\'s client invoice and nothing else of the sales side', async () => {
      const seen = await as(hr)('get', '/api/travel-logs/TRV-MX-214/full');
      assert.equal(seen.status, 200, JSON.stringify(seen.body));
      assert.ok(seen.body.data.billing, 'the billing block is HR\'s window on the sales side');
      assert.equal(seen.body.data.payments, undefined, 'and it is not a window on the receipts');

      for (const [method, path] of [
        ['get', '/api/payment-stages'], ['post', '/api/payment-stages'],
        ['get', '/api/payments'], ['get', '/api/quotations'],
        ['post', '/api/travel-invoices'],
      ]) {
        const res = await as(hr)(method, path).send({});
        assert.equal(
          res.status, 403,
          `an HR user got ${res.status} on ${method.toUpperCase()} ${path}. The billing block is a read-through `
          + 'slice (#214 §4); it must not come with generic payment-stage or receipt access.'
        );
      }
    });

    test('billed_stage_id cannot be written through ordinary CRUD by anybody', async () => {
      for (const who of [admin, salesA, hr]) {
        const res = await as(who)('patch', `/api/travel-logs/${tripId}`).send({ billed_stage_id: stageId });
        assert.equal(
          res.status, 403,
          `${who.label} got ${res.status} writing billed_stage_id through PATCH /api/travel-logs/:id. ` +
          'It moves only through POST /api/travel-logs/:travelId/billed-stage; protectedFields for travel-logs ' +
          'is enforced in validate() in lib/crud.js (#214). Without it the hidden selector on the Trip screen ' +
          'is the whole of the restriction.'
        );
        assert.equal(await stored(), null, `${who.label}: the column moved despite the refusal`);
      }
    });

    test('admin and sales set it and clear it through its own route', async () => {
      for (const who of [admin, salesA]) {
        const res = await as(who)('post', '/api/travel-logs/TRV-MX-214/billed-stage').send({ billed_stage_id: stageId });
        assert.equal(res.status, 200, `${who.label}: ${JSON.stringify(res.body)}`);
        assert.equal(await stored(), stageId);

        const cleared = await as(who)('post', '/api/travel-logs/TRV-MX-214/billed-stage').send({ billed_stage_id: null });
        assert.equal(cleared.status, 200, `${who.label} clearing: ${JSON.stringify(cleared.body)}`);
        assert.equal(await stored(), null);
      }
    });
  });
});
