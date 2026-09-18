import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The activity log (#18 Phase 1.5): who did what, and who may read it.
 *
 * Runs in database mode, because that is the mode with two kinds of user to
 * tell apart and with real accounts to name as the actor. The shared
 * admin's side of it is in activityLogShared.test.js, in its own process,
 * since AUTH_MODE is read once when the app is imported.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('the activity log', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let createUser;
  let activity;
  let resetLimiter;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `activity_suite_${process.pid}_${Date.now()}`;
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
    activity = await import('../src/lib/activity.js');

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
    await db.query('DELETE FROM activity_log');
    await db.query('DELETE FROM users');
    await db.query('DELETE FROM email_log');
    await db.query('DELETE FROM job_runs');
    await db.query('DELETE FROM companies');
  };

  /** Every activity row, oldest first, as the table holds it. */
  const logged = async () =>
    (await db.query('SELECT * FROM activity_log ORDER BY id')).rows;

  async function signIn(email) {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  }

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

  // =================================================== actor resolution

  describe('who an act is recorded as', () => {
    test('a database user is themselves', () => {
      const actor = activity.actorFrom({ mode: 'database', id: 4, name: 'Sales User', role: 'sales' });

      assert.deepEqual(actor, { type: 'user', userId: 4, name: 'Sales User' });
    });

    test('the shared admin is a shared admin, not a user with an id', () => {
      const actor = activity.actorFrom({ mode: 'shared', id: null, username: 'shared-admin', role: 'admin' });

      assert.deepEqual(actor, { type: 'shared_admin', userId: null, name: 'shared-admin' });
    });

    test('the system actor has no account either', () => {
      assert.deepEqual(activity.SYSTEM_ACTOR, { type: 'system', userId: null, name: null });
    });

    test('an unrecognised session is refused rather than guessed at', () => {
      for (const user of [null, undefined, {}, { mode: 'database', id: null }, { mode: 'nonsense' }]) {
        assert.throws(() => activity.actorFrom(user), /no recognised signed-in user/);
      }
    });

    // Phase 1.5 audits only admin acts, so there is no sales-reachable
    // route to prove this through — and weakening one of those gates to
    // make a test easier would be the wrong trade. The helper is the thing
    // under test, so the helper is what is tested.
    test('a sales user records as themselves, with their own id', async () => {
      await clean();
      const sales = await createUser(
        { name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db
      );

      const row = await activity.logActivity(pool, {
        actor: activity.actorFrom({ mode: 'database', id: sales.id, name: sales.name, role: 'sales' }),
        action: 'quotation.created',
        entityType: 'quotation',
        entityId: 12,
      });

      assert.equal(row.actor_user_id, sales.id);
      assert.equal(row.actor_type, 'user');
      assert.equal(row.entity_id, '12', 'an id is kept as text, whatever it arrived as');
    });

    test('a shared admin is recorded with no account and their name in metadata', async () => {
      await clean();

      const row = await activity.logActivity(pool, {
        actor: activity.actorFrom({ mode: 'shared', username: 'shared-admin' }),
        action: 'user.created',
        entityType: 'user',
        entityId: 3,
      });

      assert.equal(row.actor_user_id, null, 'no fake account is invented for the shared password');
      assert.equal(row.actor_type, 'shared_admin');
      assert.deepEqual(row.metadata, { actor_name: 'shared-admin' });
    });

    test('a background operation can record as the system', async () => {
      await clean();

      const row = await activity.logActivity(pool, {
        actor: activity.SYSTEM_ACTOR,
        action: 'job.run',
        entityType: 'job',
        entityId: 'reminders.payment',
      });

      assert.equal(row.actor_user_id, null);
      assert.equal(row.actor_type, 'system');
      assert.deepEqual(row.metadata, {}, 'the system has no name to record');
    });
  });

  // ========================================================= the helper

  describe('the logging helper', () => {
    test('refuses an actor type the table does not know', async () => {
      await assert.rejects(
        activity.logActivity(pool, { actor: { type: 'root', userId: null }, action: 'x.y', entityType: 'thing' }),
        /actor_type must be one of/
      );
    });

    test('refuses an act with no action or no entity type', async () => {
      const actor = activity.SYSTEM_ACTOR;
      await assert.rejects(activity.logActivity(pool, { actor, action: '  ', entityType: 'thing' }), /needs an action/);
      await assert.rejects(activity.logActivity(pool, { actor, action: 'x.y', entityType: '' }), /needs an entity type/);
    });

    test('drops secret-looking metadata, however deep it is buried', async () => {
      await clean();

      const row = await activity.logActivity(pool, {
        actor: activity.SYSTEM_ACTOR,
        action: 'x.y',
        entityType: 'thing',
        metadata: {
          kept: 'yes',
          password: 'hunter2',
          password_hash: '$2b$12$abc',
          session_secret: 'sssh',
          authorization: 'Bearer abc',
          cookie: 'ctz_session=abc',
          api_key: 'k',
          nested: { keptToo: 1, refresh_token: 'nope' },
        },
      });

      assert.deepEqual(row.metadata, { kept: 'yes', nested: { keptToo: 1 } });
    });

    test('writes on the caller’s client, so a rolled-back act leaves no record', async () => {
      await clean();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await activity.logActivity(client, {
          actor: activity.SYSTEM_ACTOR, action: 'x.y', entityType: 'thing',
        });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      assert.deepEqual(await logged(), [], 'the audit row went back with the transaction');
    });
  });

  // ==================================================== the user events

  describe('account administration', () => {
    const post = (cookie, body) => request(app).post('/api/users').set('Cookie', cookie).send(body);
    const patch = (cookie, id, body) => request(app).patch(`/api/users/${id}`).set('Cookie', cookie).send(body);
    const setPassword = (cookie, id, body) =>
      request(app).post(`/api/users/${id}/password`).set('Cookie', cookie).send(body);

    test('creating an account records user.created, by the admin who did it', async () => {
      await clean();
      const admin = await asAdmin();

      const res = await post(admin.cookie, {
        name: 'Nina', email: 'nina@example.com', password: PASSWORD, role: 'sales',
      });

      assert.equal(res.status, 201);
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'user.created');
      assert.equal(rows[0].actor_user_id, admin.user.id);
      assert.equal(rows[0].actor_type, 'user');
      assert.equal(rows[0].entity_type, 'user');
      assert.equal(rows[0].entity_id, String(res.body.data.id));
      assert.deepEqual(rows[0].metadata, {
        name: 'Nina', email: 'nina@example.com', role: 'sales', active: true,
      });
    });

    test('an ordinary edit records user.updated and what moved', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD }, db);

      const res = await patch(admin.cookie, sam.id, { name: 'Samuel', role: 'admin' });

      assert.equal(res.status, 200);
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'user.updated');
      assert.equal(rows[0].entity_id, String(sam.id));
      assert.deepEqual(rows[0].metadata, {
        changed_fields: ['name', 'role'], old_role: 'sales', new_role: 'admin',
      });
    });

    test('an edit that changes nothing in the end records no changed fields', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD }, db);

      await patch(admin.cookie, sam.id, { name: 'Sam' });

      const rows = await logged();
      assert.equal(rows[0].action, 'user.updated');
      assert.deepEqual(rows[0].metadata, { changed_fields: [] });
    });

    test('switching an account off records user.deactivated, and only that', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD }, db);

      const res = await patch(admin.cookie, sam.id, { active: false, name: 'Sam Two' });

      assert.equal(res.status, 200);
      const rows = await logged();
      assert.equal(rows.length, 1, 'one act, one row — not user.updated as well');
      assert.equal(rows[0].action, 'user.deactivated');
      assert.deepEqual(rows[0].metadata, {
        changed_fields: ['name', 'active'],
        old_active: true,
        new_active: false,
        sessions_revoked: true,
      });
    });

    test('switching one back on records user.reactivated', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser(
        { name: 'Sam', email: 'sam@example.com', password: PASSWORD, active: false }, db
      );

      const res = await patch(admin.cookie, sam.id, { active: true });

      assert.equal(res.status, 200);
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'user.reactivated');
      assert.deepEqual(rows[0].metadata, {
        changed_fields: ['active'], old_active: false, new_active: true,
      });
    });

    test('setting an account off when it is already off is an ordinary update', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser(
        { name: 'Sam', email: 'sam@example.com', password: PASSWORD, active: false }, db
      );

      await patch(admin.cookie, sam.id, { active: false });

      const rows = await logged();
      assert.equal(rows[0].action, 'user.updated', 'nothing was switched off, so nothing was deactivated');
    });

    test('a password reset records the act and nothing of the password', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD }, db);

      const res = await setPassword(admin.cookie, sam.id, { password: 'another-good-long-password' });

      assert.equal(res.status, 200);
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'user.password_reset');
      assert.equal(rows[0].entity_id, String(sam.id));
      assert.deepEqual(rows[0].metadata, { sessions_revoked: true });

      const written = JSON.stringify(rows[0]);
      for (const secret of ['another-good-long-password', PASSWORD, '$2b$', 'ctz_session']) {
        assert.ok(!written.includes(secret), `${secret} must not reach the activity log`);
      }
    });

    test('a refused edit leaves no record of having happened', async () => {
      await clean();
      const admin = await asAdmin();

      // The last active admin demoting themselves: refused, whole.
      const res = await patch(admin.cookie, admin.user.id, { role: 'sales' });

      assert.equal(res.status, 409);
      assert.deepEqual(await logged(), [], 'the audit row rolled back with the edit');
      const [row] = (await db.query('SELECT role FROM users WHERE id = $1', [admin.user.id])).rows;
      assert.equal(row.role, 'admin', 'and the edit itself did not happen');
    });

    test('a sales user changing accounts is refused and records nothing', async () => {
      await clean();
      await asAdmin();
      const sales = await asSales();

      const attempts = [
        post(sales.cookie, { name: 'X', email: 'x@example.com', password: PASSWORD }),
        patch(sales.cookie, sales.user.id, { name: 'Sam Two' }),
        setPassword(sales.cookie, sales.user.id, { password: 'another-good-long-password' }),
      ];
      for (const attempt of attempts) assert.equal((await attempt).status, 403);

      assert.deepEqual(await logged(), []);
    });
  });

  // ============================================ the other admin events

  describe('operational acts', () => {
    const newCompany = async (name) =>
      (await db.query('INSERT INTO companies (name) VALUES ($1) RETURNING id, name', [name])).rows[0];

    test('merging two companies records company.merged against the survivor', async () => {
      await clean();
      const admin = await asAdmin();
      const gone = await newCompany('Acme Limited');
      const kept = await newCompany('Acme Ltd');

      const res = await request(app)
        .post(`/api/companies/${gone.id}/merge`).set('Cookie', admin.cookie).send({ into: kept.id });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'company.merged');
      assert.equal(rows[0].actor_user_id, admin.user.id);
      assert.equal(rows[0].entity_type, 'company');
      assert.equal(rows[0].entity_id, String(kept.id));
      assert.equal(rows[0].metadata.source_company_id, gone.id);
      assert.equal(rows[0].metadata.source_company_name, 'Acme Limited');
      assert.equal(rows[0].metadata.target_company_id, kept.id);
    });

    test('a merge a sales user is refused leaves no company.merged', async () => {
      await clean();
      await asAdmin();
      const sales = await asSales();
      const gone = await newCompany('Acme Limited');
      const kept = await newCompany('Acme Ltd');

      const res = await request(app)
        .post(`/api/companies/${gone.id}/merge`).set('Cookie', sales.cookie).send({ into: kept.id });

      assert.equal(res.status, 403);
      assert.deepEqual(await logged(), []);
      assert.equal(
        (await db.query('SELECT count(*)::int AS n FROM companies')).rows[0].n, 2,
        'and both companies are still there'
      );
    });

    test('a merge that fails records nothing', async () => {
      await clean();
      const admin = await asAdmin();
      const kept = await newCompany('Acme Ltd');

      const res = await request(app)
        .post(`/api/companies/999999/merge`).set('Cookie', admin.cookie).send({ into: kept.id });

      assert.equal(res.status, 404);
      assert.deepEqual(await logged(), []);
    });

    test('running a job by hand records job.run and points at the run', async () => {
      await clean();
      const admin = await asAdmin();

      const res = await request(app)
        .post('/api/jobs/reminders.payment/run').set('Cookie', admin.cookie).send({});

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'job.run');
      assert.equal(rows[0].actor_user_id, admin.user.id);
      assert.equal(rows[0].entity_type, 'job');
      assert.equal(rows[0].entity_id, 'reminders.payment');
      assert.equal(rows[0].metadata.job, 'reminders.payment');
      assert.equal(rows[0].metadata.run_id, res.body.data.id);
    });

    test('a sales user cannot run a job, and no job.run is recorded', async () => {
      await clean();
      await asAdmin();
      const sales = await asSales();

      const res = await request(app)
        .post('/api/jobs/reminders.payment/run').set('Cookie', sales.cookie).send({});

      assert.equal(res.status, 403);
      assert.deepEqual(await logged(), []);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM job_runs')).rows[0].n, 0);
    });

    test('a test email records email.test_sent, with the domain and nothing else', async () => {
      await clean();
      const admin = await asAdmin();

      const res = await request(app)
        .post('/api/emails/test').set('Cookie', admin.cookie).send({ to: 'someone@client.example' });

      assert.equal(res.status, 200, JSON.stringify(res.body));
      const rows = await logged();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].action, 'email.test_sent');
      assert.equal(rows[0].entity_type, 'email');
      assert.equal(rows[0].entity_id, String(res.body.data.id));
      assert.deepEqual(rows[0].metadata, {
        to_domain: 'client.example', mode: 'log', status: 'suppressed',
      });
      assert.ok(
        !JSON.stringify(rows[0].metadata).includes('someone@'),
        'the address itself stays in email_log, where it already is'
      );
    });

    test('a sales user cannot send a test email, and none is recorded', async () => {
      await clean();
      await asAdmin();
      const sales = await asSales();

      const res = await request(app)
        .post('/api/emails/test').set('Cookie', sales.cookie).send({ to: 'someone@client.example' });

      assert.equal(res.status, 403);
      assert.deepEqual(await logged(), []);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM email_log')).rows[0].n, 0);
    });
  });

  // ==================================================== the read endpoint

  describe('GET /api/activity', () => {
    const get = (cookie, qs = '') => request(app).get(`/api/activity${qs}`).set('Cookie', cookie);

    /** n rows straight into the table, oldest first, so ordering is predictable. */
    async function seed(n, over = () => ({})) {
      for (let i = 0; i < n; i++) {
        await activity.logActivity(pool, {
          actor: activity.SYSTEM_ACTOR, action: 'x.y', entityType: 'thing', entityId: i,
          ...over(i),
        });
      }
    }

    test('an admin may read it; a sales user may not; a stranger may not', async () => {
      await clean();
      const admin = await asAdmin();
      const sales = await asSales();

      assert.equal((await get(admin.cookie)).status, 200);
      assert.equal((await get(sales.cookie)).status, 403);
      assert.equal((await request(app).get('/api/activity')).status, 401);
    });

    test('there is no way to write, edit or erase history through it', async () => {
      await clean();
      const admin = await asAdmin();

      const calls = [
        request(app).post('/api/activity').set('Cookie', admin.cookie).send({ action: 'made.up' }),
        request(app).patch('/api/activity/1').set('Cookie', admin.cookie).send({ action: 'made.up' }),
        request(app).delete('/api/activity/1').set('Cookie', admin.cookie),
      ];
      for (const call of calls) assert.equal((await call).status, 404);
    });

    test('newest first, and only the fields an admin needs', async () => {
      await clean();
      const admin = await asAdmin();
      await db.query('DELETE FROM activity_log');
      await seed(3);

      const res = await get(admin.cookie);

      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.map((r) => r.entity_id), ['2', '1', '0']);
      assert.deepEqual(Object.keys(res.body.data[0]).sort(), [
        'action', 'actor', 'actor_type', 'created_at', 'entity_id', 'entity_type', 'id', 'metadata',
      ]);
      const body = JSON.stringify(res.body);
      assert.ok(!body.includes('password_hash'), 'no hash column is joined in');
      assert.ok(!body.includes('session_version'), 'nor the session counter');
    });

    test('the actor is named, and stays readable once the account is gone', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD }, db);
      await activity.logActivity(pool, {
        actor: { type: 'user', userId: sam.id, name: 'Sam' },
        action: 'user.updated', entityType: 'user', entityId: sam.id,
      });

      const named = await get(admin.cookie, '?action=user.updated');
      assert.deepEqual(named.body.data[0].actor, { id: sam.id, name: 'Sam' });

      await db.query('DELETE FROM users WHERE id = $1', [sam.id]);

      const orphaned = await get(admin.cookie, '?action=user.updated');
      assert.equal(orphaned.status, 200);
      assert.equal(orphaned.body.data.length, 1, 'the act is still on the record');
      assert.equal(orphaned.body.data[0].actor, null);
      assert.equal(orphaned.body.data[0].actor_type, 'user', 'it was still a person who did it');
    });

    test('a page is bounded by default and pages backwards from a cursor', async () => {
      await clean();
      const admin = await asAdmin();
      await db.query('DELETE FROM activity_log');
      await seed(5);

      const first = await get(admin.cookie, '?limit=2');
      assert.equal(first.body.limit, 2);
      assert.deepEqual(first.body.data.map((r) => r.entity_id), ['4', '3']);
      assert.equal(first.body.next_before_id, first.body.data[1].id);

      const second = await get(admin.cookie, `?limit=2&before_id=${first.body.next_before_id}`);
      assert.deepEqual(second.body.data.map((r) => r.entity_id), ['2', '1']);

      const last = await get(admin.cookie, `?limit=2&before_id=${second.body.next_before_id}`);
      assert.deepEqual(last.body.data.map((r) => r.entity_id), ['0']);
      assert.equal(last.body.next_before_id, null, 'a short page is the end');
    });

    test('the default limit is 50 and nothing may ask for more than 200', async () => {
      await clean();
      const admin = await asAdmin();

      assert.equal((await get(admin.cookie)).body.limit, 50);
      assert.equal((await get(admin.cookie, '?limit=200')).body.limit, 200);

      const tooMany = await get(admin.cookie, '?limit=201');
      assert.equal(tooMany.status, 422, 'refused, not quietly reduced');
      assert.ok(tooMany.body.error.fields.limit);
    });

    test('each filter narrows to what it names', async () => {
      await clean();
      const admin = await asAdmin();
      const sam = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD }, db);
      await db.query('DELETE FROM activity_log');

      await activity.logActivity(pool, {
        actor: { type: 'user', userId: sam.id, name: 'Sam' },
        action: 'user.updated', entityType: 'user', entityId: 7,
      });
      await activity.logActivity(pool, {
        actor: activity.SYSTEM_ACTOR, action: 'job.run', entityType: 'job', entityId: 'finance.digest',
      });

      const cases = [
        [`?actor_user_id=${sam.id}`, ['user.updated']],
        ['?action=job.run', ['job.run']],
        ['?entity_type=user', ['user.updated']],
        ['?entity_type=user&entity_id=7', ['user.updated']],
        ['?entity_type=user&entity_id=8', []],
        ['?actor_type=system', ['job.run']],
      ];
      for (const [qs, expected] of cases) {
        const res = await get(admin.cookie, qs);
        assert.equal(res.status, 200, qs);
        assert.deepEqual(res.body.data.map((r) => r.action), expected, qs);
      }
    });

    test('a filter it cannot make sense of is refused, not ignored', async () => {
      await clean();
      const admin = await asAdmin();

      const bad = [
        '?limit=0', '?limit=abc', '?before_id=-1', '?before_id=abc',
        '?actor_user_id=abc', '?actor_user_id=0', '?actor_type=root',
        '?action=', '?entity_type=',
      ];
      for (const qs of bad) {
        const res = await get(admin.cookie, qs);
        assert.equal(res.status, 422, qs);
      }
    });

    test('a repeated parameter is refused rather than half-read', async () => {
      await clean();
      const admin = await asAdmin();

      const res = await get(admin.cookie, '?action=job.run&action=user.updated');

      assert.equal(res.status, 422);
      assert.ok(res.body.error.fields.action);
    });

    test('metadata comes back as it was written', async () => {
      await clean();
      const admin = await asAdmin();
      await db.query('DELETE FROM activity_log');
      await activity.logActivity(pool, {
        actor: activity.SYSTEM_ACTOR, action: 'x.y', entityType: 'thing',
        metadata: { changed_fields: ['name'], nested: { n: 1 } },
      });

      const res = await get(admin.cookie);

      assert.deepEqual(res.body.data[0].metadata, { changed_fields: ['name'], nested: { n: 1 } });
    });
  });
});
