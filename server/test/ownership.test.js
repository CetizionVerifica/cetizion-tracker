import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Record ownership (#18 Phase 2A): the column, its foreign key, and the
 * fact that nothing else changed.
 *
 * Two halves. The first applies migration 018 to a database that already
 * holds records and checks what it did to them — which is, deliberately,
 * almost nothing. The second drives the live API to prove the claim this
 * phase actually rests on: adding ownership must not alter a single visible
 * behaviour, because row-level filtering arrives whole in Phase 2C and a
 * half-scoped API is worse than an unscoped one.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');
const VIEWS = readFileSync(join(DB_DIR, 'views.sql'), 'utf8');
const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '051_record_ownership.sql'), 'utf8');

const OWNED = ['enquiries', 'quotations', 'projects'];

// The state migration 018 meets: this schema with Phase 2A undone. Dropping
// the column takes its index and its foreign key with it, which is exactly
// what the parent branch's schema looks like.
//
// The views go first. Phase 2C added owner_user_id to v_quotations and
// v_projects — the generic CRUD router reads those, and scoping has to be a
// predicate in SQL — so the column can no longer be dropped while they
// reference it. They are rebuilt after the migration, which is the order the
// real runner uses anyway: migrations, then views.
const UNDO_PHASE_2A = [
  'DROP VIEW IF EXISTS v_quotations, v_projects CASCADE;',
  ...OWNED.map((t) => `ALTER TABLE ${t} DROP COLUMN owner_user_id;`),
].join('\n');

// Records of the kind that already exist: named salesperson as free text,
// and no user account behind it, because there were none when they were typed.
const LEGACY_ROWS = `
INSERT INTO enquiries  (enquiry_no, client_name, sales_person) VALUES ('CTZ/ENQ/2026/900', 'Old Client', 'Ramesh');
INSERT INTO quotations (quotation_no, client_name, sales_person) VALUES ('CTZ/QT/2026/900', 'Old Client', 'Ramesh');
INSERT INTO projects   (project_id, client_name, sales_person)   VALUES ('PRJ-2026-900', 'Old Client', 'Ramesh');
`;

async function withDatabase(fn) {
  const name = `ownership_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/** A database at the parent branch's schema, holding records, then upgraded. */
async function upgraded(fn) {
  return withDatabase(async (db) => {
    await db.query(SCHEMA);
    await db.query(VIEWS);
    await db.query(UNDO_PHASE_2A);
    await db.query(LEGACY_ROWS);
    await db.query(MIGRATION);
    // Views rebuilt on top, as the migration runner does after any migration.
    await db.query(VIEWS);
    return fn(db);
  });
}

const rowsOf = async (db, sql, params) => (await db.query(sql, params)).rows;
const newUser = (db, over = '') =>
  db.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ('Sam', 'sam@example.com', 'x', 'sales', true) RETURNING id` + over
  ).then((r) => r.rows[0].id);

// =====================================================================
describe('migration 018 — record ownership', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('adds a nullable owner_user_id to all three sales tables', () =>
    upgraded(async (db) => {
      // Base tables only: Phase 2C also surfaces the column on v_quotations
      // and v_projects, which is asserted separately below.
      const cols = await rowsOf(
        db,
        `SELECT c.table_name, c.data_type, c.is_nullable, c.column_default
           FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.column_name = 'owner_user_id' AND c.table_schema = 'public'
            AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_name`
      );

      assert.deepEqual(cols.map((c) => c.table_name), ['enquiries', 'projects', 'quotations']);
      for (const c of cols) {
        assert.equal(c.data_type, 'integer', c.table_name);
        assert.equal(c.is_nullable, 'YES', c.table_name);
        assert.equal(c.column_default, null, `${c.table_name} gets no default`);
      }

      // The two views the generic CRUD router reads must carry it too, or
      // Phase 2C could not scope quotations and projects in SQL at all.
      const views = await rowsOf(
        db,
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'owner_user_id' AND table_schema = 'public'
            AND table_name IN ('v_quotations', 'v_projects')
          ORDER BY table_name`
      );
      assert.deepEqual(views.map((v) => v.table_name), ['v_projects', 'v_quotations']);
    }));

  test('leaves every existing record untouched, and unowned', () =>
    upgraded(async (db) => {
      for (const t of OWNED) {
        const [row] = await rowsOf(db, `SELECT sales_person, owner_user_id FROM ${t}`);
        assert.equal(row.owner_user_id, null, `${t} was not backfilled`);
        assert.equal(row.sales_person, 'Ramesh', `${t} kept its free-text salesperson`);
      }
    }));

  test('the migration writes no row at all', () => {
    // The guarantee the final report makes, read off the file rather than
    // inferred: Phase 2B owns the backfill, and this file must not pre-empt it.
    //
    // Anchored at the start of a statement, because the file says "ON DELETE
    // SET NULL" several times and that is a constraint, not a deletion.
    const sql = MIGRATION.replace(/--.*$/gm, '');
    assert.doesNotMatch(sql, /^\s*(UPDATE|INSERT|DELETE|TRUNCATE|COPY)\b/im);
  });

  test('each owner column points at users(id) and nulls on delete', () =>
    upgraded(async (db) => {
      const fks = await rowsOf(
        db,
        `SELECT conrelid::regclass::text AS tbl, conname, confdeltype,
                confrelid::regclass::text AS target
           FROM pg_constraint
          WHERE contype = 'f' AND conname LIKE '%owner_user_id%'
          ORDER BY conname`
      );

      assert.equal(fks.length, 3);
      for (const fk of fks) {
        assert.equal(fk.target, 'users', fk.tbl);
        // 'n' = SET NULL. Not 'c' (cascade) and not 'r' (restrict).
        assert.equal(fk.confdeltype, 'n', `${fk.tbl} must SET NULL, not cascade or restrict`);
        assert.equal(fk.conname, `${fk.tbl}_owner_user_id_fkey`);
      }
    }));

  test('each owner column is indexed', () =>
    upgraded(async (db) => {
      const idx = await rowsOf(
        db,
        `SELECT tablename, indexname FROM pg_indexes
          WHERE indexname LIKE '%owner_user_id_idx' ORDER BY indexname`
      );

      assert.deepEqual(
        idx.map((i) => i.indexname),
        ['enquiries_owner_user_id_idx', 'projects_owner_user_id_idx', 'quotations_owner_user_id_idx']
      );
    }));

  test('running it a second time changes nothing', () =>
    upgraded(async (db) => {
      const shape = () =>
        rowsOf(db, `SELECT conname FROM pg_constraint WHERE conname LIKE '%owner_user_id%' ORDER BY 1`);
      const before = await shape();

      await db.query(MIGRATION);

      assert.deepEqual(await shape(), before);
      for (const t of OWNED) {
        assert.equal((await rowsOf(db, `SELECT count(*)::int AS n FROM ${t}`))[0].n, 1);
      }
    }));

  test('it manages no transaction of its own, as the runner requires', () => {
    assert.doesNotMatch(
      MIGRATION.replace(/--.*$/gm, ''),
      /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im
    );
  });

  // --------------------------------------------------- reference behaviour

  test('a real user may own a record; an id nobody holds is refused', () =>
    upgraded(async (db) => {
      const sam = await newUser(db);

      for (const t of OWNED) {
        await db.query(`UPDATE ${t} SET owner_user_id = $1`, [sam]);
        const [row] = await rowsOf(db, `SELECT owner_user_id FROM ${t}`);
        assert.equal(row.owner_user_id, sam, t);

        await assert.rejects(
          db.query(`UPDATE ${t} SET owner_user_id = 999999`),
          /violates foreign key constraint/,
          `${t} must refuse an owner who does not exist`
        );
      }
    }));

  test('an inactive user stays a valid owner', () =>
    upgraded(async (db) => {
      const sam = await newUser(db);
      await db.query('UPDATE enquiries SET owner_user_id = $1', [sam]);

      // Somebody leaves: the account is switched off, and what they owned is
      // still what they owned.
      await db.query(`UPDATE users SET active = false, email = NULL, password_hash = NULL WHERE id = $1`, [sam]);

      const [row] = await rowsOf(db, 'SELECT owner_user_id FROM enquiries');
      assert.equal(row.owner_user_id, sam);
    }));

  test('deleting the owner keeps the record and forgets only the pointer', () =>
    upgraded(async (db) => {
      const sam = await newUser(db);
      for (const t of OWNED) await db.query(`UPDATE ${t} SET owner_user_id = $1`, [sam]);

      await db.query('DELETE FROM users WHERE id = $1', [sam]);

      for (const t of OWNED) {
        const rows = await rowsOf(db, `SELECT owner_user_id FROM ${t}`);
        assert.equal(rows.length, 1, `${t} row survived its owner being deleted`);
        assert.equal(rows[0].owner_user_id, null, `${t} owner was nulled, not cascaded`);
      }
    }));
});

// =====================================================================
describe('ownership changes no API behaviour', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl; let db; let app; let pool; let createUser;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `ownership_api_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(SCHEMA);
    await db.query(VIEWS);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const signIn = async (email) => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  };

  let admin; let sales;
  const setUp = async () => {
    for (const t of [...OWNED, 'users']) await db.query(`DELETE FROM ${t}`);
    const a = await createUser({ name: 'Alice', email: 'alice@example.com', password: PASSWORD, role: 'admin' }, db);
    const s = await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    admin = { user: a, cookie: await signIn(a.email) };
    sales = { user: s, cookie: await signIn(s.email) };
  };

  const body = {
    enquiries: { client_name: 'Acme', sales_person: 'Ramesh', service: 'ASI audit' },
    quotations: { client_name: 'Acme', sales_person: 'Ramesh', service_quoted: 'ASI audit' },
    projects: { client_name: 'Acme', sales_person: 'Ramesh', primary_service: 'ASI audit' },
  };
  const create = (t, cookie, extra = {}) =>
    request(app).post(`/api/${t}`).set('Cookie', cookie).send({ ...body[t], ...extra });

  test('a record can still be created with no owner at all', async () => {
    await setUp();

    // An admin's record is unowned, and that is still a valid record: the
    // column is nullable and nothing requires it. A *sales* user's record is
    // owned by them as of Phase 2C — covered in rowScoping.test.js.
    for (const t of OWNED) {
      const res = await create(t, admin.cookie);
      assert.equal(res.status, 201, `${t}: ${JSON.stringify(res.body)}`);
      const [row] = (await db.query(`SELECT owner_user_id FROM ${t}`)).rows;
      assert.equal(row.owner_user_id, null, `${t} needs no owner`);
    }
  });

  test('a client cannot set the owner on create', async () => {
    await setUp();

    for (const t of OWNED) {
      const res = await create(t, admin.cookie, { owner_user_id: sales.user.id });

      assert.equal(res.status, 201, `${t} accepts the record`);
      const [row] = (await db.query(`SELECT owner_user_id FROM ${t}`)).rows;
      assert.equal(row.owner_user_id, null, `${t} ignored the owner the client asked for`);
    }
  });

  test('a client cannot change the owner on update, not even an admin', async () => {
    await setUp();

    for (const t of OWNED) {
      const created = await create(t, admin.cookie);
      const { id } = created.body.data;
      // Something a person may genuinely own, set the only way Phase 2A
      // allows: directly, because no assignment API exists yet.
      await db.query(`UPDATE ${t} SET owner_user_id = $1 WHERE id = $2`, [admin.user.id, id]);

      const res = await request(app).patch(`/api/${t}/${id}`).set('Cookie', admin.cookie)
        .send({ owner_user_id: sales.user.id, client_name: 'Acme Renamed' });

      assert.equal(res.status, 200, `${t}: ${JSON.stringify(res.body)}`);
      const [row] = (await db.query(`SELECT owner_user_id, client_name FROM ${t} WHERE id = $1`, [id])).rows;
      assert.equal(row.client_name, 'Acme Renamed', `${t} applied the change it was allowed`);
      assert.equal(row.owner_user_id, admin.user.id, `${t} left ownership alone`);
    }
  });

  test('owner_user_id is not a filter or a sort key yet', async () => {
    await setUp();
    const mine = await create('enquiries', admin.cookie);
    await db.query('UPDATE enquiries SET owner_user_id = $1 WHERE id = $2', [admin.user.id, mine.body.data.id]);
    await create('enquiries', admin.cookie, { client_name: 'Other Co' });

    // An unknown filter is ignored, not applied — so this must not narrow.
    const filtered = await request(app)
      .get(`/api/enquiries?owner_user_id=${admin.user.id}`).set('Cookie', admin.cookie);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.length, 2, 'filtering by owner is not wired up in Phase 2A');

    const sorted = await request(app)
      .get('/api/enquiries?sort=owner_user_id:desc').set('Cookie', admin.cookie);
    assert.equal(sorted.status, 200, 'an unknown sort falls back to the default');
  });

  test('a sales user sees only their own records — enforced from Phase 2C', async () => {
    await setUp();
    const owned = await create('enquiries', admin.cookie);
    await db.query('UPDATE enquiries SET owner_user_id = $1 WHERE id = $2', [admin.user.id, owned.body.data.id]);
    await create('enquiries', sales.cookie, { client_name: 'Sam Co' });

    const res = await request(app).get('/api/enquiries').set('Cookie', sales.cookie);

    assert.equal(res.status, 200);
    // Phase 2A added the column and changed nothing; Phase 2C is what makes
    // this one row rather than two. Kept here as the before/after boundary.
    assert.equal(res.body.data.length, 1, 'only the record this sales user owns');
    assert.equal(res.body.data[0].client_name, 'Sam Co');
  });

  test('a won enquiry still becomes a quotation, and carries its owner across', async () => {
    await setUp();
    const enquiry = await create('enquiries', admin.cookie);
    await db.query('UPDATE enquiries SET owner_user_id = $1 WHERE id = $2', [admin.user.id, enquiry.body.data.id]);

    const res = await request(app).patch(`/api/enquiries/${enquiry.body.data.id}`)
      .set('Cookie', admin.cookie).send({ status: 'Won - Quotation Sent' });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [quotation] = (await db.query('SELECT sales_person, owner_user_id FROM quotations')).rows;
    assert.ok(quotation, 'the conversion still creates the quotation');
    assert.equal(quotation.sales_person, 'Ramesh', 'and still copies the free-text salesperson');
    // Phase 2A propagated nothing; Phase 2C carries responsibility down the
    // pipeline, from the enquiry's own owner_user_id rather than from the
    // free-text name beside it. Covered in full in rowScoping.test.js.
    assert.equal(quotation.owner_user_id, admin.user.id, 'the enquiry owner becomes the quotation owner');
  });
});
