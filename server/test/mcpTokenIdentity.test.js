import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * An MCP token is a person, not a spelling (#18 §2, migration 063).
 *
 * Two things are proved here, and they are different questions.
 *
 * The migration: an existing database's tokens are bound to the account
 * their name names, where exactly one account carries it, and revoked where
 * none or several do. This is tested by putting api_tokens back into its
 * pre-063 shape and running the file, because a migration that is only ever
 * run against the schema it already produced proves nothing about the
 * databases it is written for.
 *
 * The surfaces: one salesperson cannot read another's records, through the
 * web API or through MCP, and cannot obtain a token that would let them —
 * which is issue #18's headline acceptance criterion ("by any route") and
 * the hole #89 counted six times in one week.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');
const MIGRATION_063 = readFileSync(join(DB_DIR, 'migrations', '063_mcp_token_identity.sql'), 'utf8');

/** api_tokens as 038 left it: a `person` name, and no account behind it. */
const UNDO_063 = `
  ALTER TABLE api_tokens DROP CONSTRAINT IF EXISTS api_tokens_sales_needs_user;
  ALTER TABLE api_tokens DROP COLUMN IF EXISTS user_id;
`;

async function withDatabase(prefix, fn) {
  const name = `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query(SCHEMA);
    await db.query(VIEWS);
    return await fn(db, url.toString());
  } finally {
    await db.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  }
}

describe('migration 063 — binding MCP tokens to accounts', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  const legacy = async (db, { name, role = 'sales', person = null, revoked = false }) => {
    const { rows } = await db.query(
      `INSERT INTO api_tokens (name, token_hash, token_prefix, role, person, revoked_at)
       VALUES ($1, $2, 'ctz_legacy', $3, $4, $5) RETURNING id`,
      [name, `hash-${name}`, role, person, revoked ? new Date() : null]
    );
    return rows[0].id;
  };
  const tokenRow = async (db, id) =>
    (await db.query('SELECT * FROM api_tokens WHERE id = $1', [id])).rows[0];

  test('binds a token whose name matches exactly one account', () =>
    withDatabase('mig063_bind', async (db) => {
      await db.query(UNDO_063);
      const { rows: [u] } = await db.query(
        `INSERT INTO users (name, email, password_hash, role, active)
         VALUES ('Ramesh Kumar', 'ramesh@example.com', 'x', 'sales', true) RETURNING id`);
      // Typed with different case and spacing, the way the old field was.
      const id = await legacy(db, { name: 'Ramesh token', person: '  ramesh   kumar ' });

      await db.query(MIGRATION_063);

      const t = await tokenRow(db, id);
      assert.equal(t.user_id, u.id, 'the same normalisation rule 060 uses');
      assert.equal(t.revoked_at, null, 'a token that could be bound keeps working');
      assert.equal(t.person, '  ramesh   kumar ', 'the name is kept verbatim for the tokens page, not dropped or rewritten');
    }));

  test('revokes a token whose name matches nobody', () =>
    withDatabase('mig063_nobody', async (db) => {
      await db.query(UNDO_063);
      const id = await legacy(db, { name: 'Ghost token', person: 'Nobody At All' });

      await db.query(MIGRATION_063);

      const t = await tokenRow(db, id);
      assert.equal(t.user_id, null);
      assert.ok(t.revoked_at, 'a credential we cannot resolve to a person stops working');
    }));

  test('revokes rather than guesses when two accounts share the name', () =>
    withDatabase('mig063_ambiguous', async (db) => {
      await db.query(UNDO_063);
      await db.query(`INSERT INTO users (name, email, password_hash, role, active) VALUES
        ('Ramesh', 'ramesh.a@example.com', 'x', 'sales', true),
        ('ramesh', 'ramesh.b@example.com', 'x', 'sales', true)`);
      const id = await legacy(db, { name: 'Contested', person: 'Ramesh' });

      await db.query(MIGRATION_063);

      const t = await tokenRow(db, id);
      assert.equal(t.user_id, null, 'pointing it at the wrong pipeline is the failure being fixed');
      assert.ok(t.revoked_at);
    }));

  test('leaves admin tokens alone: they carry no person and never did', () =>
    withDatabase('mig063_admin', async (db) => {
      await db.query(UNDO_063);
      const id = await legacy(db, { name: 'Admin token', role: 'admin' });

      await db.query(MIGRATION_063);

      const t = await tokenRow(db, id);
      assert.equal(t.revoked_at, null, 'an admin token sees everything by role; there is nothing to bind');
      assert.equal(t.user_id, null);
    }));

  test('an already-revoked token is not resurrected, and does not block the constraint', () =>
    withDatabase('mig063_revoked', async (db) => {
      await db.query(UNDO_063);
      const before = new Date('2026-01-01T00:00:00Z');
      const { rows: [r] } = await db.query(
        `INSERT INTO api_tokens (name, token_hash, token_prefix, role, person, revoked_at)
         VALUES ('Old', 'hash-old', 'ctz_old', 'sales', 'Nobody', $1) RETURNING id`, [before]);

      await db.query(MIGRATION_063);

      const t = await tokenRow(db, r.id);
      assert.equal(t.revoked_at.toISOString(), before.toISOString(), 'history is not rewritten');
    }));

  test('is idempotent', () =>
    withDatabase('mig063_twice', async (db) => {
      await db.query(UNDO_063);
      const { rows: [u] } = await db.query(
        `INSERT INTO users (name, email, password_hash, role, active)
         VALUES ('Solo', 'solo@example.com', 'x', 'sales', true) RETURNING id`);
      const id = await legacy(db, { name: 'Solo token', person: 'Solo' });

      await db.query(MIGRATION_063);
      await db.query(MIGRATION_063);

      const t = await tokenRow(db, id);
      assert.equal(t.user_id, u.id);
      assert.equal(t.revoked_at, null);
    }));

  test('from here on, a live sales token must name an account', () =>
    withDatabase('mig063_check', async (db) => {
      await assert.rejects(
        () => db.query(
          `INSERT INTO api_tokens (name, token_hash, token_prefix, role, person)
           VALUES ('Sneaky', 'hash-sneaky', 'ctz_x', 'sales', 'Whoever')`),
        /api_tokens_sales_needs_user/,
        'the invariant is in the database, not only in the route'
      );
    }));
});

describe('a salesperson cannot reach another\'s records, by any route', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let createUser;
  let admin; let asha; let ravi;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `crosssurface_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(SCHEMA);
    await db.query(VIEWS);

    Object.assign(process.env, {
      SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: dbUrl,
      AUTH_MODE: 'database', SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass', EMAIL_MODE: 'log',
    });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));

    const mk = async (over) => createUser({ password: PASSWORD, ...over }, db);
    const a = await mk({ name: 'Alice Admin', email: 'alice@example.com', role: 'admin' });
    const s1 = await mk({ name: 'Asha', email: 'asha@example.com', role: 'sales' });
    const s2 = await mk({ name: 'Ravi', email: 'ravi@example.com', role: 'sales' });

    // One statement per call: pg refuses parameters on a multi-command string.
    await db.query(`INSERT INTO companies (id, name) VALUES (1001, 'Asha Client Ltd'), (1002, 'Ravi Client Ltd')`);
    await db.query(
      `INSERT INTO quotations (quotation_no, client_name, company_id, quotation_date, quotation_value, status, sales_person, owner_user_id)
         VALUES ('QT-ASHA', 'Asha Client Ltd', 1001, '2026-07-01', 100000, 'Submitted', 'Asha', $1),
                ('QT-RAVI', 'Ravi Client Ltd', 1002, '2026-07-01', 900000, 'Submitted', 'Ravi', $2)`,
      [s1.id, s2.id]
    );
    await db.query(
      `INSERT INTO projects (project_id, client_name, company_id, sales_person, owner_user_id)
         VALUES ('PRJ-ASHA', 'Asha Client Ltd', 1001, 'Asha', $1), ('PRJ-RAVI', 'Ravi Client Ltd', 1002, 'Ravi', $2)`,
      [s1.id, s2.id]
    );

    const signIn = async (email) => {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    admin = { user: a, cookie: await signIn(a.email) };
    asha = { user: s1, cookie: await signIn(s1.email) };
    ravi = { user: s2, cookie: await signIn(s2.email) };
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  let callId = 0;
  async function mcp(tok, name, args = {}) {
    callId += 1;
    const res = await request(app).post('/api/mcp')
      .set('Authorization', `Bearer ${tok}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name, arguments: args } });
    if (res.status !== 200) return { status: res.status };
    const r = res.body.result;
    return { status: 200, error: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
  }

  const mintAs = (who, body) =>
    request(app).post('/api/api-tokens').set('Cookie', who.cookie).send(body);

  // -------------------------------------------------------------- the web API

  /**
   * What must not leak is the owned record — the quotation and the project.
   * The *company* deliberately may: companies and contacts are shared master
   * data, `/api/companies` is open to anybody signed in, and a client's name
   * and sector are not one salesperson's secret. The deals under them are,
   * which is why the references rather than the client name are asserted on
   * here. See docs/issue-18-row-scoping.md.
   */
  test('the web API does not show, search or export the other one\'s deal', async () => {
    const paths = [
      '/api/quotations',
      '/api/quotations/QT-RAVI',
      '/api/projects/PRJ-RAVI',
      '/api/search?q=Ravi',
      '/api/export/quotations.csv',
      '/api/lookups',
    ];
    for (const path of paths) {
      const res = await request(app).get(path).set('Cookie', asha.cookie);
      assert.ok(res.status === 200 || res.status === 404, `${path} answered ${res.status}`);
      const body = typeof res.text === 'string' && res.text ? res.text : JSON.stringify(res.body);
      assert.doesNotMatch(body, /QT-RAVI|PRJ-RAVI/, `${path} leaked Ravi's records to Asha`);
    }
  });

  test('and the admin sees both, so the tests above are not passing on an empty database', async () => {
    const res = await request(app).get('/api/export/quotations.csv').set('Cookie', admin.cookie);
    assert.equal(res.status, 200);
    assert.match(res.text, /QT-ASHA/);
    assert.match(res.text, /QT-RAVI/);
  });

  // ---------------------------------------------------------------- minting

  test('a sales user cannot mint a token at all — admin or otherwise', async () => {
    for (const body of [
      { name: 'Self admin', role: 'admin' },
      { name: 'Self sales', role: 'sales', user_id: asha.user.id },
      { name: 'As Ravi', role: 'sales', user_id: ravi.user.id },
    ]) {
      const res = await mintAs(asha, body);
      assert.equal(res.status, 403, `minting ${JSON.stringify(body)} must be admin-only`);
    }
    const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM api_tokens');
    assert.equal(rows[0].n, 0, 'and nothing was written while trying');
  });

  test('an admin cannot issue a sales token that names nobody', async () => {
    assert.equal((await mintAs(admin, { name: 'Nameless', role: 'sales' })).status, 422);
    assert.equal((await mintAs(admin, { name: 'Ghost', role: 'sales', person: 'Nobody At All' })).status, 422);
    assert.equal((await mintAs(admin, { name: 'Bad id', role: 'sales', user_id: 999_999 })).status, 422);
  });

  test('an admin cannot issue a token against a deactivated account', async () => {
    const { rows: [dead] } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ('Departed', NULL, NULL, 'sales', false) RETURNING id`);
    const res = await mintAs(admin, { name: 'Departed token', role: 'sales', user_id: dead.id });
    assert.equal(res.status, 422, 'a token is a way in; a switched-off account must not have one');
    await db.query('DELETE FROM users WHERE id = $1', [dead.id]);
  });

  test('a name is accepted only when it resolves to exactly one account', async () => {
    const { rows: [twin] } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ('Asha', 'asha.twin@example.com', 'x', 'sales', true) RETURNING id`);
    const res = await mintAs(admin, { name: 'Ambiguous', role: 'sales', person: 'Asha' });
    assert.equal(res.status, 422, 'two accounts carry the name; picking one points a token at a pipeline');
    await db.query('DELETE FROM users WHERE id = $1', [twin.id]);
  });

  test('the person stored is the account\'s own name, not whatever was typed', async () => {
    const res = await mintAs(admin, { name: 'Asha token', role: 'sales', user_id: asha.user.id, person: 'Ravi' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.person, 'Asha', 'nobody can make a token claim to be somebody else');
    assert.equal(res.body.data.user_id, asha.user.id);
    await db.query('DELETE FROM api_tokens WHERE id = $1', [res.body.data.id]);
  });

  // -------------------------------------------------------------------- MCP

  test('an MCP token scoped to one account cannot read the other\'s records', async () => {
    const tok = (await mintAs(admin, { name: 'Asha MCP', role: 'sales', user_id: asha.user.id })).body.data.token;

    const search = await mcp(tok, 'search_records', { text: 'Client' });
    assert.match(search.text, /QT-ASHA/);
    assert.doesNotMatch(search.text, /QT-RAVI|PRJ-RAVI/, 'search is scoped by owner_user_id, not a second door');

    assert.equal((await mcp(tok, 'get_quotation', { quotation_no: 'QT-RAVI' })).error, true);
    assert.equal((await mcp(tok, 'get_project', { project_id: 'PRJ-RAVI' })).error, true);
    assert.equal((await mcp(tok, 'get_company', { company_id: 1002 })).error, true);
    assert.equal((await mcp(tok, 'get_quotation', { quotation_no: 'QT-ASHA' })).error, false, 'her own still opens');
  });

  test('a token bound to Ravi sees Ravi\'s, which proves the filter is the owner and not an empty result', async () => {
    const tok = (await mintAs(admin, { name: 'Ravi MCP', role: 'sales', user_id: ravi.user.id })).body.data.token;
    const search = await mcp(tok, 'search_records', { text: 'Client' });
    assert.match(search.text, /QT-RAVI/);
    assert.doesNotMatch(search.text, /QT-ASHA/);
  });

  test('renaming the account does not change what its token sees', async () => {
    const tok = (await mintAs(admin, { name: 'Rename MCP', role: 'sales', user_id: asha.user.id })).body.data.token;
    await db.query("UPDATE users SET name = 'Asha Menon' WHERE id = $1", [asha.user.id]);
    try {
      const search = await mcp(tok, 'search_records', { text: 'Client' });
      assert.match(search.text, /QT-ASHA/, 'the whole point of binding to an id: a name can change');
      assert.doesNotMatch(search.text, /QT-RAVI/);
    } finally {
      await db.query("UPDATE users SET name = 'Asha' WHERE id = $1", [asha.user.id]);
    }
  });

  test('a sales token with no account behind it is refused, not admitted and scoped to nothing', async () => {
    // Written past the route and past the CHECK, which is the only way such
    // a row can exist at all. The point is that authenticate() still says no.
    const { rows: [t] } = await db.query(
      `INSERT INTO api_tokens (name, token_hash, token_prefix, role, person, user_id, revoked_at)
       VALUES ('Orphan', $1, 'ctz_orph', 'sales', 'Asha', NULL, now()) RETURNING id`,
      ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855']);
    await db.query('UPDATE api_tokens SET revoked_at = NULL WHERE id = $1', [t.id])
      .catch(() => {}); // the CHECK refuses this, which is itself the guard

    const res = await request(app).post('/api/mcp')
      .set('Authorization', 'Bearer ctz_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 9999, method: 'tools/call', params: { name: 'list_quotations', arguments: {} } });
    assert.equal(res.status, 401, 'an unresolvable credential is refused');
    await db.query('DELETE FROM api_tokens WHERE id = $1', [t.id]);
  });

  test('the admin token still sees everything, so scoping has not simply broken MCP', async () => {
    const tok = (await mintAs(admin, { name: 'Admin MCP', role: 'admin' })).body.data.token;
    const search = await mcp(tok, 'search_records', { text: 'Client' });
    assert.match(search.text, /QT-ASHA/);
    assert.match(search.text, /QT-RAVI/);
  });
});
