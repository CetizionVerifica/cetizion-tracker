import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { describe } from 'node:test';
import pg from 'pg';

/**
 * Migration 017 against the schema it will actually meet (#18 Phase 1.5).
 *
 * The comparison base matters here and is not origin/main. This branch is
 * stacked on feature/issue-18-auth-hardening, whose migration 016 has not
 * been merged, so a database built from main's schema.sql is not the
 * database 017 will be applied to. What 017 needs from the schema before it
 * is one thing — a users table with an integer primary key to point at —
 * and BEFORE below states exactly that, so this test says what the
 * migration depends on instead of depending on which branch is checked out.
 *
 * The check that matters is the other one: a live database upgraded by
 * running 017 and a fresh database built from db/schema.sql must end up
 * with the same table. They are two descriptions of one thing, and the way
 * they go wrong is that somebody edits one of them.
 *
 * Needs a Postgres the runner may create databases on: set
 * TEST_DATABASE_URL (CI does).
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const MIGRATION = readFileSync(join(DB_DIR, 'migrations', '017_activity_log.sql'), 'utf8');
const SCHEMA = readFileSync(join(DB_DIR, 'schema.sql'), 'utf8');

// All 017 asks of the schema before it. Phase 1A created this table and
// Phase 1C added session_version; neither is anything this migration reads.
const BEFORE = `
CREATE TABLE users (
  id     serial PRIMARY KEY,
  name   text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
`;

// ---------------------------------------------------------------------
// What the two databases are compared on: the column list, the constraints
// and the indexes, each read back from the catalogue in a stable order.
// ---------------------------------------------------------------------

const COLUMNS = `
  SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
   WHERE table_name = 'activity_log'
   ORDER BY column_name`;

const CHECKS = `
  SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
   WHERE conrelid = 'activity_log'::regclass
   ORDER BY conname`;

const INDEXES = `
  SELECT indexname, indexdef FROM pg_indexes
   WHERE tablename = 'activity_log' ORDER BY indexname`;

async function withDatabase(fn) {
  const name = `activity_migration_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/** Two throwaway databases at once: the upgraded one and the rebuilt one. */
const withBoth = (fn) => withDatabase((a) => withDatabase((b) => fn(a, b)));

const rowsOf = async (client, sql) => (await client.query(sql)).rows;

describe('migration 017 — activity_log', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('upgrades a Phase 1C database to the same table schema.sql builds', () =>
    withBoth(async (upgraded, rebuilt) => {
      await upgraded.query(BEFORE);
      await upgraded.query(MIGRATION);
      await rebuilt.query(SCHEMA);

      for (const sql of [COLUMNS, CHECKS, INDEXES]) {
        assert.deepEqual(await rowsOf(upgraded, sql), await rowsOf(rebuilt, sql));
      }
    }));

  test('running it a second time changes nothing', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);
      const before = await rowsOf(db, COLUMNS);

      await db.query(MIGRATION);

      assert.deepEqual(await rowsOf(db, COLUMNS), before);
    }));

  test('it manages no transaction of its own, as the runner requires', () => {
    assert.doesNotMatch(
      MIGRATION.replace(/--.*$/gm, ''),
      /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im
    );
  });

  // ------------------------------------------------------------ columns

  test('actor_user_id is nullable, so shared-mode and system rows fit', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);

      const [column] = await rowsOf(
        db,
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'activity_log' AND column_name = 'actor_user_id'`
      );

      assert.equal(column.is_nullable, 'YES');
      for (const type of ['shared_admin', 'system']) {
        await db.query(
          `INSERT INTO activity_log (actor_type, action, entity_type) VALUES ($1, 'x.y', 'thing')`,
          [type]
        );
      }
      assert.equal((await rowsOf(db, 'SELECT count(*)::int AS n FROM activity_log'))[0].n, 2);
    }));

  test('metadata defaults to an empty object and refuses a non-object', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);

      await db.query(`INSERT INTO activity_log (actor_type, action, entity_type) VALUES ('system', 'x.y', 'thing')`);
      const [row] = await rowsOf(db, 'SELECT metadata FROM activity_log');
      assert.deepEqual(row.metadata, {});

      await assert.rejects(
        db.query(`INSERT INTO activity_log (actor_type, action, entity_type, metadata)
                  VALUES ('system', 'x.y', 'thing', '"a string"'::jsonb)`),
        /activity_log_metadata_is_object/
      );
    }));

  test('actor_type is held to the three the application knows', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);

      for (const type of ['user', 'shared_admin', 'system']) {
        await db.query(
          `INSERT INTO activity_log (actor_type, action, entity_type) VALUES ($1, 'x.y', 'thing')`,
          [type]
        );
      }

      await assert.rejects(
        db.query(`INSERT INTO activity_log (actor_type, action, entity_type) VALUES ('admin', 'x.y', 'thing')`),
        /actor_type/
      );
    }));

  test('an actor id belongs only to a database user', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);
      const { rows: [sam] } = await db.query(`INSERT INTO users (name) VALUES ('Sam') RETURNING id`);

      await assert.rejects(
        db.query(
          `INSERT INTO activity_log (actor_user_id, actor_type, action, entity_type)
           VALUES ($1, 'shared_admin', 'x.y', 'thing')`,
          [sam.id]
        ),
        /activity_log_actor_id_needs_user/
      );
    }));

  test('a blank action, entity type or entity id is refused', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);

      const cases = [
        [`INSERT INTO activity_log (actor_type, action, entity_type) VALUES ('system', '  ', 'thing')`, /action_not_blank/],
        [`INSERT INTO activity_log (actor_type, action, entity_type) VALUES ('system', 'x.y', '')`, /entity_type_not_blank/],
        [`INSERT INTO activity_log (actor_type, action, entity_type, entity_id) VALUES ('system', 'x.y', 'thing', ' ')`, /entity_id_not_blank/],
      ];
      for (const [sql, message] of cases) await assert.rejects(db.query(sql), message);
    }));

  // --------------------------------------------------------- the actor FK

  test('deleting the account keeps the history and forgets only the id', () =>
    withDatabase(async (db) => {
      await db.query(BEFORE);
      await db.query(MIGRATION);
      const { rows: [sam] } = await db.query(`INSERT INTO users (name) VALUES ('Sam') RETURNING id`);
      await db.query(
        `INSERT INTO activity_log (actor_user_id, actor_type, action, entity_type, entity_id)
         VALUES ($1, 'user', 'user.deactivated', 'user', '7')`,
        [sam.id]
      );

      await db.query('DELETE FROM users WHERE id = $1', [sam.id]);

      const rows = await rowsOf(db, 'SELECT actor_user_id, actor_type, action FROM activity_log');
      assert.equal(rows.length, 1, 'the record of the act outlives the account that made it');
      assert.deepEqual(rows[0], { actor_user_id: null, actor_type: 'user', action: 'user.deactivated' });
    }));
});
