import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Brings a database that holds real data up to date: every file in
 * db/migrations that has not run yet, in name order, then views.sql when it
 * needs rebuilding. schema_migrations records what has run, so each file
 * runs once. The container calls this before the API starts (src/start.js).
 *
 * - Each migration runs in its own transaction together with its record, so
 *   it is applied whole or not at all. That is why a migration file must not
 *   hold BEGIN or COMMIT itself.
 * - views.sql holds no data. It is rebuilt when it changed, or after any
 *   migration, since a table change can invalidate a view.
 * - A session advisory lock makes a second runner, e.g. another replica
 *   starting at the same moment, wait and then find nothing left to do.
 */

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
export const MIGRATIONS_DIR = join(DB_DIR, 'migrations');
export const VIEWS_FILE = join(DB_DIR, 'views.sql');

// Any fixed number; it only has to be the same for every runner.
const MIGRATION_LOCK_KEY = 72_910_001;
// A transaction statement on its own line: "BEGIN;", "COMMIT WORK;". A
// plpgsql body's BEGIN has no semicolon after it, so it does not match.
const OWN_TRANSACTION = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)(\s+(WORK|TRANSACTION))?\s*;/im;

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`;

const checksum = (sql) => createHash('sha256').update(sql).digest('hex');

function readFiles(migrationsDir, viewsFile) {
  const migrations = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(migrationsDir, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    });
  const viewsSql = readFileSync(viewsFile, 'utf8');
  return { migrations, views: { name: basename(viewsFile), sql: viewsSql, checksum: checksum(viewsSql) } };
}

function refuseOwnTransactions(migrations) {
  const offender = migrations.find((m) => OWN_TRANSACTION.test(m.sql.replace(/--.*$/gm, '')));
  if (offender) {
    throw new Error(
      `${offender.name} has its own BEGIN/COMMIT. Remove it: every migration already runs in a transaction.`
    );
  }
}

async function withLockedClient(connectionString, fn) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // Held by this session, so closing the connection releases it, even
    // when a migration has left the connection unusable.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(CREATE_TRACKING_TABLE);
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function applyMigration(client, migration) {
  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`${migration.name} failed and was rolled back: ${err.message}`, { cause: err });
  }
}

async function rebuildViews(client, views) {
  try {
    // views.sql runs as one transaction of its own.
    await client.query(views.sql);
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`${views.name} failed and was rolled back: ${err.message}`, { cause: err });
  }
  await recordFile(client, views);
}

const recordFile = (client, file) =>
  client.query(
    `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
    [file.name, file.checksum]
  );

/** @returns {{ applied: string[], viewsRebuilt: boolean }} */
export async function runMigrations({
  connectionString,
  migrationsDir = MIGRATIONS_DIR,
  viewsFile = VIEWS_FILE,
  log = console.log,
}) {
  const { migrations, views } = readFiles(migrationsDir, viewsFile);
  refuseOwnTransactions(migrations);

  return withLockedClient(connectionString, async (client) => {
    const { rows } = await client.query('SELECT name, checksum FROM schema_migrations');
    const recorded = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const m of migrations) {
      if (recorded.has(m.name) && recorded.get(m.name) !== m.checksum) {
        log(`! ${m.name} changed after it was applied; it is not run again. Put the change in a new migration.`);
      }
    }

    const pending = migrations.filter((m) => !recorded.has(m.name));
    for (const migration of pending) {
      await applyMigration(client, migration);
      log(`✓ ${migration.name}`);
    }

    const viewsRebuilt = pending.length > 0 || recorded.get(views.name) !== views.checksum;
    if (viewsRebuilt) {
      await rebuildViews(client, views);
      log(`✓ ${views.name}`);
    }
    if (!pending.length && !viewsRebuilt) log('• database schema is up to date');

    return { applied: pending.map((m) => m.name), viewsRebuilt };
  });
}

/**
 * For a database just rebuilt from schema.sql and views.sql, which already
 * contain every migration: record them all as applied, so none runs on it.
 */
export async function markMigrationsApplied({
  connectionString,
  migrationsDir = MIGRATIONS_DIR,
  viewsFile = VIEWS_FILE,
}) {
  const { migrations, views } = readFiles(migrationsDir, viewsFile);

  await withLockedClient(connectionString, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('TRUNCATE schema_migrations');
      for (const file of [...migrations, views]) await recordFile(client, file);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}
