import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import pg from 'pg';
import { markMigrationsApplied, runMigrations } from '../src/migrations.js';

/**
 * The migration runner the container calls before the API starts. Each test
 * gets its own throwaway database and its own migration files, so these
 * need a Postgres the runner may create databases on: set TEST_DATABASE_URL
 * (CI does). Without it the suite is skipped.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const quiet = () => {};

async function withDatabase(fn) {
  const name = `migrations_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  try {
    return await fn(url.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

/** A migrations folder and a views file, written from { name: sql }. */
function fixtures(migrations, views = VIEWS) {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  const migrationsDir = join(dir, 'migrations');
  const viewsFile = join(dir, 'views.sql');
  writeMigrations(migrationsDir, migrations);
  writeFileSync(viewsFile, views);
  return { migrationsDir, viewsFile };
}

function writeMigrations(migrationsDir, migrations) {
  mkdirSync(migrationsDir, { recursive: true });
  for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(migrationsDir, name), sql);
}

async function exec(connectionString, sql) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function scalar(connectionString, sql) {
  const { rows } = await exec(connectionString, sql);
  return rows[0] ? Object.values(rows[0])[0] : undefined;
}

// Mirrors the real views.sql: its own transaction, and every build leaves a mark.
const VIEWS = `
BEGIN;
DROP VIEW IF EXISTS v_widgets;
CREATE VIEW v_widgets AS SELECT id, name FROM widgets;
INSERT INTO view_builds DEFAULT VALUES;
COMMIT;
`;

const BASE = {
  '001_widgets.sql': 'CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL);',
  '002_view_builds.sql': 'CREATE TABLE view_builds (id serial PRIMARY KEY);',
};

describe('runMigrations', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('applies pending migrations in name order, records each, then builds the views', () =>
    withDatabase(async (url) => {
      const files = fixtures({ '002_view_builds.sql': BASE['002_view_builds.sql'], '001_widgets.sql': BASE['001_widgets.sql'] });

      const result = await runMigrations({ connectionString: url, ...files, log: quiet });

      assert.deepEqual(result, { applied: ['001_widgets.sql', '002_view_builds.sql'], viewsRebuilt: true });
      assert.equal(await scalar(url, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations WHERE name <> 'views.sql'"), '001_widgets.sql,002_view_builds.sql');
      assert.equal(await scalar(url, 'SELECT count(*)::int FROM view_builds'), 1);
    }));

  test('a second run applies nothing and leaves the views alone', () =>
    withDatabase(async (url) => {
      const files = fixtures(BASE);
      await runMigrations({ connectionString: url, ...files, log: quiet });

      const again = await runMigrations({ connectionString: url, ...files, log: quiet });

      assert.deepEqual(again, { applied: [], viewsRebuilt: false });
      assert.equal(await scalar(url, 'SELECT count(*)::int FROM view_builds'), 1);
    }));

  test('only a newly added migration runs, and the views are rebuilt after it', () =>
    withDatabase(async (url) => {
      const files = fixtures(BASE);
      await runMigrations({ connectionString: url, ...files, log: quiet });
      writeMigrations(files.migrationsDir, { '003_widget_colour.sql': 'ALTER TABLE widgets ADD COLUMN colour text;' });

      const result = await runMigrations({ connectionString: url, ...files, log: quiet });

      assert.deepEqual(result, { applied: ['003_widget_colour.sql'], viewsRebuilt: true });
      assert.equal(await scalar(url, 'SELECT count(*)::int FROM view_builds'), 2);
    }));

  test('a changed views file is rebuilt even when no migration is pending', () =>
    withDatabase(async (url) => {
      const files = fixtures(BASE);
      await runMigrations({ connectionString: url, ...files, log: quiet });
      writeFileSync(files.viewsFile, VIEWS.replace('SELECT id, name', 'SELECT id, upper(name) AS name'));

      const result = await runMigrations({ connectionString: url, ...files, log: quiet });

      assert.deepEqual(result, { applied: [], viewsRebuilt: true });
      assert.equal(await scalar(url, 'SELECT count(*)::int FROM view_builds'), 2);
    }));

  test('a failing migration rolls back whole, is not recorded, and stops the ones after it', () =>
    withDatabase(async (url) => {
      const files = fixtures({
        ...BASE,
        '003_half_done.sql': "INSERT INTO widgets (name) VALUES ('kept?'); SELECT no_such_column FROM widgets;",
        '004_after.sql': 'CREATE TABLE after_failure (id int);',
      });

      await assert.rejects(runMigrations({ connectionString: url, ...files, log: quiet }), /003_half_done\.sql/);

      assert.equal(await scalar(url, "SELECT count(*)::int FROM schema_migrations WHERE name = '003_half_done.sql'"), 0);
      assert.equal(await scalar(url, 'SELECT count(*)::int FROM widgets'), 0, 'the insert before the error is rolled back');
      assert.equal(await scalar(url, "SELECT to_regclass('after_failure') IS NULL"), true);
    }));

  test('a migration that manages its own transaction is refused before anything runs', () =>
    withDatabase(async (url) => {
      const files = fixtures({ ...BASE, '003_own_tx.sql': 'BEGIN;\nALTER TABLE widgets ADD COLUMN size int;\nCOMMIT;' });

      await assert.rejects(runMigrations({ connectionString: url, ...files, log: quiet }), /003_own_tx\.sql.*BEGIN/s);

      assert.equal(await scalar(url, "SELECT to_regclass('widgets') IS NULL"), true, 'nothing was applied');
    }));

  test('a function body with BEGIN … END is not mistaken for a transaction', () =>
    withDatabase(async (url) => {
      const files = fixtures({
        ...BASE,
        '003_function.sql': `CREATE FUNCTION widget_count() RETURNS int AS $$
BEGIN
  RETURN (SELECT count(*) FROM widgets);
END;
$$ LANGUAGE plpgsql;`,
      });

      const result = await runMigrations({ connectionString: url, ...files, log: quiet });

      assert.ok(result.applied.includes('003_function.sql'));
      assert.equal(await scalar(url, 'SELECT widget_count()'), 0);
    }));

  test('two runs started together apply each migration exactly once', () =>
    withDatabase(async (url) => {
      const files = fixtures({
        ...BASE,
        '003_counted.sql': "CREATE TABLE IF NOT EXISTS runs (n int); INSERT INTO runs VALUES (1); SELECT pg_sleep(0.2);",
      });

      const results = await Promise.all([
        runMigrations({ connectionString: url, ...files, log: quiet }),
        runMigrations({ connectionString: url, ...files, log: quiet }),
      ]);

      assert.equal(await scalar(url, 'SELECT count(*)::int FROM runs'), 1);
      assert.deepEqual(results.map((r) => r.applied.length).sort(), [0, 3]);
    }));
});

describe('markMigrationsApplied', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  test('after a full rebuild, every migration counts as applied and none runs again', () =>
    withDatabase(async (url) => {
      const files = fixtures(BASE);
      // What `npm run migrate` does: schema and views straight from their files…
      await exec(url, 'CREATE TABLE widgets (id serial PRIMARY KEY, name text NOT NULL); CREATE TABLE view_builds (id serial PRIMARY KEY);');
      await exec(url, VIEWS);

      // …then records that the migrations are already part of that schema.
      await markMigrationsApplied({ connectionString: url, ...files });
      const result = await runMigrations({ connectionString: url, ...files, log: quiet });

      assert.deepEqual(result, { applied: [], viewsRebuilt: false });
    }));
});
