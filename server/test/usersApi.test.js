import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Managing accounts through the API (#18 Phase 1B-B).
 *
 * Runs in database mode, because that is where an admin and a sales user
 * can both be signed in and told apart. The shared admin's access to the
 * same routes is proved in usersApiShared.test.js, in its own process.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('the Users API', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let resetLimiter;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `usersapi_suite_${process.pid}_${Date.now()}`;
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

  const clean = async () => {
    resetLimiter();
    await db.query('DELETE FROM users');
  };
  const rows = async () => (await db.query('SELECT * FROM users ORDER BY id')).rows;
  const rowOf = async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

  async function signIn(email) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  }

  /** An admin, signed in, plus their cookie. */
  async function asAdmin(over = {}) {
    const user = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin', ...over },
      db
    );
    return { user, cookie: await signIn(user.email) };
  }
  async function asSales(over = {}) {
    const user = await createUser(
      { name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales', ...over },
      db
    );
    return { user, cookie: await signIn(user.email) };
  }

  const get = (cookie) => request(app).get('/api/users').set('Cookie', cookie);
  const post = (cookie, body) => request(app).post('/api/users').set('Cookie', cookie).send(body);
  const patch = (cookie, id, body) => request(app).patch(`/api/users/${id}`).set('Cookie', cookie).send(body);
  const setPassword = (cookie, id, body) =>
    request(app).post(`/api/users/${id}/password`).set('Cookie', cookie).send(body);

  // ------------------------------------------------------------- access

  test('an admin may use it; a sales user may not; a stranger may not', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();

    assert.equal((await get(admin.cookie)).status, 200);

    for (const call of [
      get(sales.cookie),
      post(sales.cookie, { name: 'X', email: 'x@example.com', password: PASSWORD }),
      patch(sales.cookie, admin.user.id, { name: 'Renamed' }),
      setPassword(sales.cookie, admin.user.id, { password: PASSWORD }),
    ]) {
      const res = await call;
      assert.equal(res.status, 403, 'a sales user is turned away from every verb');
    }

    assert.equal((await request(app).get('/api/users')).status, 401, 'signed out is 401, not 403');
  });

  test('a sales user promoted to admin may use it on the next request', async () => {
    await clean();
    await asAdmin();
    const sales = await asSales();
    assert.equal((await get(sales.cookie)).status, 403);

    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [sales.user.id]);

    assert.equal((await get(sales.cookie)).status, 200, 'the same cookie, the new role');
  });

  // --------------------------------------------------------------- list

  test('the list gives an admin what they need and never a hash', async () => {
    await clean();
    const admin = await asAdmin();
    await asSales();
    await createUser({ name: 'Ramesh', active: false }, db); // attribution-only

    const res = await get(admin.cookie);

    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 3);
    assert.deepEqual(Object.keys(res.body.data[0]).sort(), [
      'active', 'created_at', 'email', 'id', 'last_login_at', 'name', 'role', 'updated_at',
    ]);
    const text = JSON.stringify(res.body);
    assert.ok(!/password_hash|scrypt/.test(text), text);
    assert.ok(!text.includes(PASSWORD));
  });

  test('a historical attribution-only user is listed as it is, with no invented address', async () => {
    await clean();
    const admin = await asAdmin();
    await createUser({ name: 'Ramesh', active: false }, db);

    const { data } = (await get(admin.cookie)).body;
    const ramesh = data.find((u) => u.name === 'Ramesh');

    assert.equal(ramesh.email, null, 'no address was made up for them');
    assert.equal(ramesh.active, false);
    assert.equal(ramesh.role, 'sales');
  });

  // ------------------------------------------------------------- create

  test('an admin creates a sales user who can then sign in', async () => {
    await clean();
    const admin = await asAdmin();

    const res = await post(admin.cookie, {
      name: '  Sam   Smith ', email: 'Sam@Example.com', role: 'sales', password: PASSWORD,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, 'Sam Smith', 'stray spaces collapsed');
    assert.equal(res.body.data.email, 'sam@example.com', 'stored lowercased');
    assert.equal(res.body.data.role, 'sales');
    assert.equal(res.body.data.active, true, 'active by default');
    assert.ok(!('password_hash' in res.body.data));

    resetLimiter();
    assert.ok(await signIn('sam@example.com'), 'and the new account works');
  });

  test('an admin creates another admin', async () => {
    await clean();
    const admin = await asAdmin();

    const res = await post(admin.cookie, {
      name: 'Bob', email: 'bob@example.com', role: 'admin', password: PASSWORD,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.role, 'admin');
  });

  test('the password is hashed and never echoed', async () => {
    await clean();
    const admin = await asAdmin();

    const res = await post(admin.cookie, {
      name: 'Sam', email: 'sam@example.com', password: PASSWORD,
    });

    assert.ok(!JSON.stringify(res.body).includes(PASSWORD));
    const stored = await rowOf(res.body.data.id);
    assert.match(stored.password_hash, /^scrypt\$v1\$/);
    assert.notEqual(stored.password_hash, PASSWORD);
  });

  test('bad input is refused field by field', async () => {
    await clean();
    const admin = await asAdmin();

    const cases = [
      [{ name: '', email: 'a@example.com', password: PASSWORD }, 'name'],
      [{ name: 'A', email: 'not-an-email', password: PASSWORD }, 'email'],
      [{ name: 'A', email: 'a@example.com', password: 'short' }, 'password'],
      [{ name: 'A', email: 'a@example.com', password: PASSWORD, role: 'finance' }, 'role'],
    ];
    for (const [body, field] of cases) {
      const res = await post(admin.cookie, body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.ok(res.body.error.fields[field], `expected a message on ${field}`);
    }
    assert.equal((await rows()).length, 1, 'nothing was written');
  });

  test('the same address cannot be taken twice, whatever the casing', async () => {
    await clean();
    const admin = await asAdmin();

    const res = await post(admin.cookie, { name: 'Impostor', email: 'ALICE@Example.com', password: PASSWORD });

    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.email);
    assert.equal((await rows()).length, 1);
  });

  // --------------------------------------------------------------- edit

  test('an admin edits a name, an address and a role — separately from any password', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();
    const before = await rowOf(sales.user.id);

    const renamed = await patch(admin.cookie, sales.user.id, { name: 'Samuel' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.data.name, 'Samuel');

    const remailed = await patch(admin.cookie, sales.user.id, { email: 'samuel@example.com' });
    assert.equal(remailed.body.data.email, 'samuel@example.com');

    const promoted = await patch(admin.cookie, sales.user.id, { role: 'admin' });
    assert.equal(promoted.body.data.role, 'admin');

    const after = await rowOf(sales.user.id);
    assert.equal(after.password_hash, before.password_hash, 'not one of those touched the password');
  });

  test('an edit cannot smuggle a password in with it', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();
    const before = await rowOf(sales.user.id);

    const res = await patch(admin.cookie, sales.user.id, { name: 'Samuel', password: 'a-sneaky-new-password' });

    assert.equal(res.status, 200, 'the name change is honoured');
    assert.equal((await rowOf(sales.user.id)).name, 'Samuel');
    assert.equal((await rowOf(sales.user.id)).password_hash, before.password_hash, 'the password is not');

    resetLimiter();
    const withSneaky = await request(app).post('/api/auth/login')
      .send({ email: 'sam@example.com', password: 'a-sneaky-new-password' });
    assert.equal(withSneaky.status, 401, 'and it certainly does not work');
  });

  test('an unknown id is a 404 and an empty change is a 422', async () => {
    await clean();
    const admin = await asAdmin();

    assert.equal((await patch(admin.cookie, 999_999, { name: 'Nobody' })).status, 404);
    assert.equal((await patch(admin.cookie, 'abc', { name: 'Nobody' })).status, 404);
    assert.equal((await patch(admin.cookie, admin.user.id, {})).status, 422);
  });

  test('editing an attribution-only user does not corrupt it', async () => {
    await clean();
    const admin = await asAdmin();
    const ramesh = await createUser({ name: 'Ramesh', active: false }, db);

    const res = await patch(admin.cookie, ramesh.id, { name: 'Ramesh Kumar' });

    assert.equal(res.status, 200);
    const after = await rowOf(ramesh.id);
    assert.equal(after.name, 'Ramesh Kumar');
    assert.equal(after.email, null, 'still no address');
    assert.equal(after.password_hash, null, 'still no password');
    assert.equal(after.active, false, 'still switched off');
  });

  test('switching an attribution-only user on is refused, because it has nothing to sign in with', async () => {
    await clean();
    const admin = await asAdmin();
    const ramesh = await createUser({ name: 'Ramesh', active: false }, db);

    const res = await patch(admin.cookie, ramesh.id, { active: true });

    // The table's own invariant, surfaced rather than bypassed.
    assert.equal(res.status, 422);
    assert.equal((await rowOf(ramesh.id)).active, false);
  });

  // --------------------------------------------- deactivate / reactivate

  test('deactivating a user ends their session on their next request', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();
    assert.equal((await request(app).get('/api/auth/me').set('Cookie', sales.cookie)).status, 200);

    const res = await patch(admin.cookie, sales.user.id, { active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.active, false);

    for (const path of ['/api/auth/me', '/api/projects']) {
      assert.equal(
        (await request(app).get(path).set('Cookie', sales.cookie)).status, 401,
        `${path} must be closed to them now`
      );
    }
  });

  test('reactivating a user lets them back in', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();
    await patch(admin.cookie, sales.user.id, { active: false });

    const res = await patch(admin.cookie, sales.user.id, { active: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.active, true);
    resetLimiter();
    assert.ok(await signIn('sam@example.com'), 'and they can sign in again');
  });

  // ------------------------------------------------------ password reset

  test('a reset replaces the password: the old one stops working, the new one starts', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();
    const replacement = 'the-replacement-password';

    const res = await setPassword(admin.cookie, sales.user.id, { password: replacement });
    assert.equal(res.status, 200);
    assert.ok(!('password_hash' in res.body.data));
    assert.ok(!JSON.stringify(res.body).includes(replacement));

    resetLimiter();
    const old = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: PASSWORD });
    assert.equal(old.status, 401, 'the old password is gone');

    resetLimiter();
    const fresh = await request(app).post('/api/auth/login').send({ email: 'sam@example.com', password: replacement });
    assert.equal(fresh.status, 200, 'the new one works');
  });

  test('a reset refuses a password the policy would not allow', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();
    const before = await rowOf(sales.user.id);

    const res = await setPassword(admin.cookie, sales.user.id, { password: 'short' });

    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.password);
    assert.equal((await rowOf(sales.user.id)).password_hash, before.password_hash, 'unchanged');
  });

  test('a reset does not switch a dormant account on by itself', async () => {
    await clean();
    const admin = await asAdmin();
    const ramesh = await createUser({ name: 'Ramesh', active: false }, db);
    await db.query(`UPDATE users SET email = 'ramesh@example.com' WHERE id = $1`, [ramesh.id]);

    const res = await setPassword(admin.cookie, ramesh.id, { password: PASSWORD });

    assert.equal(res.status, 200);
    const after = await rowOf(ramesh.id);
    assert.ok(after.password_hash, 'they now have a password');
    assert.equal(after.active, false, 'but are still not allowed to sign in');

    resetLimiter();
    const attempt = await request(app).post('/api/auth/login')
      .send({ email: 'ramesh@example.com', password: PASSWORD });
    assert.equal(attempt.status, 401, 'having a password is not permission');
  });

  test('a reset leaves an existing session alone — the documented limitation', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();

    await setPassword(admin.cookie, sales.user.id, { password: 'the-replacement-password' });

    // Sessions carry no password version, so there is nothing to compare
    // against. Deactivation is the way to cut somebody off now.
    assert.equal(
      (await request(app).get('/api/auth/me').set('Cookie', sales.cookie)).status, 200,
      'still signed in, as documented'
    );

    await patch(admin.cookie, sales.user.id, { active: false });
    assert.equal(
      (await request(app).get('/api/auth/me').set('Cookie', sales.cookie)).status, 401,
      'and deactivation is the answer when that matters'
    );
  });

  // --------------------------------------------------- the last admin

  test('the only admin cannot switch themselves off', async () => {
    await clean();
    const admin = await asAdmin();

    const res = await patch(admin.cookie, admin.user.id, { active: false });

    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /no active admin/);
    assert.equal((await rowOf(admin.user.id)).active, true, 'and nothing changed');
  });

  test('the only admin cannot demote themselves', async () => {
    await clean();
    const admin = await asAdmin();

    const res = await patch(admin.cookie, admin.user.id, { role: 'sales' });

    assert.equal(res.status, 409);
    assert.equal((await rowOf(admin.user.id)).role, 'admin');
  });

  test('the only admin cannot be removed by way of another admin either', async () => {
    await clean();
    const admin = await asAdmin();
    const other = await createUser({ name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'admin' }, db);
    // Two admins: Bob may go.
    assert.equal((await patch(admin.cookie, other.id, { active: false })).status, 200);
    // One admin: Alice may not.
    assert.equal((await patch(admin.cookie, admin.user.id, { active: false })).status, 409);
  });

  test('with a colleague in place, an admin may stand down', async () => {
    await clean();
    const admin = await asAdmin();
    await createUser({ name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'admin' }, db);

    const demoted = await patch(admin.cookie, admin.user.id, { role: 'sales' });

    assert.equal(demoted.status, 200, 'self-demotion is allowed when somebody else can administer');
    assert.equal(demoted.body.data.role, 'sales');
    // And the very next request is already a sales user's.
    assert.equal((await get(admin.cookie)).status, 403);
  });

  test('an inactive admin does not count as cover', async () => {
    await clean();
    const admin = await asAdmin();
    await createUser({ name: 'Retired', active: false, role: 'admin' }, db);

    const res = await patch(admin.cookie, admin.user.id, { active: false });

    assert.equal(res.status, 409, 'an admin who cannot sign in cannot administer');
  });

  // ------------------------------------------------- settings and lists

  test('a sales user reads the settings and lists but cannot change them', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();

    // Reading stays open: these fill the dropdowns and the FX figures that
    // a sales user needs to do the job at all.
    for (const path of ['/api/settings', '/api/lookups', '/api/services', '/api/travel-vendors', '/api/expense-categories']) {
      assert.equal((await request(app).get(path).set('Cookie', sales.cookie)).status, 200, `GET ${path}`);
    }

    // Writing does not. A reminder interval changes what the tracker sends
    // on its own; a renamed service re-labels every record that used it.
    const writes = [
      request(app).patch('/api/settings/reminder_interval_days').set('Cookie', sales.cookie).send({ value: '14' }),
      request(app).patch('/api/settings/fx_rate_EUR').set('Cookie', sales.cookie).send({ value: '95' }),
      request(app).post('/api/services').set('Cookie', sales.cookie).send({ name: 'Sneaky service' }),
      request(app).post('/api/travel-vendors').set('Cookie', sales.cookie).send({ name: 'Sneaky vendor' }),
      request(app).post('/api/expense-categories').set('Cookie', sales.cookie).send({ name: 'Sneaky category' }),
    ];
    // 403 for the fx_rate one too: who you are is settled before what the
    // setting is, so a sales user is never told which keys are read-only.
    for (const write of writes) assert.equal((await write).status, 403);

    // And the admin may do all of it.
    assert.equal(
      (await request(app).patch('/api/settings/reminder_interval_days').set('Cookie', admin.cookie).send({ value: '14' })).status,
      200
    );
    assert.equal(
      (await request(app).post('/api/services').set('Cookie', admin.cookie).send({ name: 'A real service' })).status,
      201
    );

    // The fx_rate_* keys are the exception, and not an authorisation one:
    // main moved rates to dated exchange rates (#79) and left these behind
    // read-only, so even an admin is refused. Asserted here so this suite
    // notices if that rule is ever quietly dropped.
    assert.equal(
      (await request(app).patch('/api/settings/fx_rate_EUR').set('Cookie', admin.cookie).send({ value: '95' })).status,
      422
    );
  });

  test('the resources a sales user works in every day are untouched', async () => {
    await clean();
    const sales = await asSales();

    // Quotations, enquiries, projects: the job itself. Phase 1B-B restricts
    // settings, not the work. Row-level ownership is a later phase.
    const created = await request(app).post('/api/quotations').set('Cookie', sales.cookie)
      .send({ client_name: 'A Client', quotation_date: '2026-01-15' });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    assert.equal((await request(app).get('/api/quotations').set('Cookie', sales.cookie)).status, 200);
    assert.equal(
      (await request(app).patch(`/api/quotations/${created.body.data.id}`).set('Cookie', sales.cookie)
        .send({ remarks: 'Updated by a sales user' })).status,
      200
    );
  });

  test('the importer stays admin-only, as Phase 1B-A left it', async () => {
    await clean();
    const admin = await asAdmin();
    const sales = await asSales();

    assert.equal((await request(app).get('/api/import/batches').set('Cookie', sales.cookie)).status, 403);
    assert.notEqual((await request(app).get('/api/import/batches').set('Cookie', admin.cookie)).status, 403);
  });

  /**
   * The guard, raced directly.
   *
   * Over HTTP the actor is themselves one of the admins in play, so the
   * losing request can just as well come back 401 (their own account went
   * first) as 409. That is safe but it is not what wants proving here, so
   * these two go at updateUser on separate connections: real contention,
   * and nothing in the way of reading which refusal happened.
   */
  test('two admins standing down at once: one succeeds, one is refused', async () => {
    await clean();
    const alice = await createUser(
      { name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db
    );
    const bob = await createUser(
      { name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'admin' }, db
    );
    const { updateUser, LastAdminError } = await import('../src/lib/users.js');

    // Each request, checking alone, sees a colleague still in place — and
    // both are right until they commit.
    const [a, b] = await racing(2, (i, client) =>
      updateUser([alice.id, bob.id][i], { active: false }, client)
    );

    const settled = [a, b].map((r) => (r.status === 'fulfilled' ? 'done' : r.reason.constructor.name));
    assert.deepEqual(settled.sort(), ['LastAdminError', 'done'], `got ${settled}`);
    assert.equal(await activeAdmins(), 1, 'an admin is left standing');
    assert.ok([a, b].some((r) => r.status === 'rejected' && r.reason instanceof LastAdminError));
  });

  test('four admins all standing down at once still leave exactly one', async () => {
    await clean();
    const ids = [];
    for (const n of [1, 2, 3, 4]) {
      const u = await createUser(
        { name: `Admin ${n}`, email: `admin${n}@example.com`, password: PASSWORD, role: 'admin' }, db
      );
      ids.push(u.id);
    }
    const { updateUser } = await import('../src/lib/users.js');

    const results = await racing(ids.length, (i, client) =>
      updateUser(ids[i], { active: false }, client)
    );

    assert.equal(await activeAdmins(), 1, 'exactly one left');
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'exactly one was refused');
  });

  test('over HTTP the invariant holds however the loser is told', async () => {
    await clean();
    const admin = await asAdmin();
    const bob = await createUser(
      { name: 'Bob', email: 'bob@example.com', password: PASSWORD, role: 'admin' }, db
    );

    const results = await Promise.all([
      patch(admin.cookie, admin.user.id, { active: false }),
      patch(admin.cookie, bob.id, { active: false }),
    ]);

    // 409 when the guard caught it, 401 when the actor's own account went
    // first and the second request was no longer anybody's. Either way:
    assert.equal(await activeAdmins(), 1, `one admin remains — statuses ${results.map((r) => r.status)}`);
    assert.ok(results.some((r) => r.status !== 200), 'and not everything went through');
  });

  async function activeAdmins() {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`);
    return rows[0].n;
  }

  /** n genuinely separate connections, so they contend in Postgres. */
  async function racing(n, fn) {
    const clients = await Promise.all(
      Array.from({ length: n }, async () => {
        const c = new pg.Client({ connectionString: dbUrl });
        await c.connect();
        return c;
      })
    );
    try {
      return await Promise.allSettled(clients.map((c, i) => fn(i, c)));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  }
});
