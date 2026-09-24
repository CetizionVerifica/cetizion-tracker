#!/usr/bin/env node
/**
 * Database chores.
 *
 *   npm run db:create   create the database if it is not there yet
 *   npm run migrate     apply schema.sql then views.sql  (drops + rebuilds)
 *   npm run db:upgrade  apply pending db/migrations, then views.sql if needed  (keeps all data)
 *   npm run seed        load db/seed.sql  (the real workbook data)
 *   npm run seed:demo   load db/demo.sql  (the workbook's worked example)
 *   npm run reset       create + migrate + seed, in that order
 *   npm run bootstrap   create the first admin from BOOTSTRAP_ADMIN_*  (idempotent)
 *
 * In production db:upgrade needs no one to run it: the container does it
 * before the API starts (src/start.js).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../src/config.js';
import { markMigrationsApplied, runMigrations } from '../src/migrations.js';

const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

async function run(sqlFile, { database } = {}) {
  const client = new pg.Client(
    database ? { ...parse(config.databaseUrl), database } : config.databaseUrl
  );
  await client.connect();
  try {
    await client.query(readFileSync(join(dbDir, sqlFile), 'utf8'));
  } finally {
    await client.end();
  }
  console.log(`✓ ${sqlFile}`);
}

function parse(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
    database: u.pathname.slice(1),
  };
}

async function createDatabase() {
  const base = parse(config.databaseUrl);
  const client = new pg.Client({ ...base, database: 'postgres' });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [base.database]
    );
    if (rowCount) {
      console.log(`• database "${base.database}" already exists`);
    } else {
      // Identifier cannot be parameterised; it comes from local config only.
      await client.query(`CREATE DATABASE "${base.database.replace(/"/g, '')}"`);
      console.log(`✓ created database "${base.database}"`);
    }
  } finally {
    await client.end();
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);
const ESCAPE_HATCH = 'ALLOW_REMOTE_REBUILD';

/**
 * `migrate` drops every table and rebuilds from schema.sql.
 *
 * In Rails, Django, Prisma, Knex, Alembic and Laravel, "migrate" means
 * "apply what has not run yet and keep my data". Here it means the
 * opposite, and `db:upgrade` — the longer, less obvious name — is the safe
 * one. README, DOCUMENTS.md and docs/SALES-REPORTS.md all warn about it in
 * prose, and prose did not stop the author of this guard from emptying the
 * shared dev database while checking that a migration had applied.
 *
 * So: it refuses any host that is not this machine, names the host and the
 * database it refused, and points at the command that was meant. A genuine
 * remote rebuild sets ALLOW_REMOTE_REBUILD=yes, which cannot happen by
 * reflex. `reset` inherits this, which is right — `reset` is destructive by
 * contract and its name says so.
 */
function refuseRemoteRebuild() {
  const { host, database } = parse(config.databaseUrl);
  if (LOCAL_HOSTS.has(host) || process.env[ESCAPE_HATCH] === 'yes') {
    console.log(`• about to DROP and rebuild every table in "${database}" on ${host || 'localhost'}`);
    return;
  }
  console.error(
    `✗ refusing to rebuild "${database}" on ${host}: this command drops every table, and that host is not this machine.\n` +
    '  To apply pending migrations and keep the data, run:  npm run db:upgrade\n' +
    `  To rebuild a remote database on purpose, run:        ${ESCAPE_HATCH}=yes npm run migrate`
  );
  process.exit(1);
}

const commands = {
  create: createDatabase,
  migrate: async () => {
    refuseRemoteRebuild();
    await run('schema.sql');
    await run('views.sql');
    // schema.sql already holds every migration, so none may run on top of it.
    await markMigrationsApplied({ connectionString: config.databaseUrl });
    console.log('✓ migrations recorded as applied');
  },
  // For a database that already holds real data: only what has not run yet.
  upgrade: () => runMigrations({ connectionString: config.databaseUrl }),
  seed: () => run('seed.sql'),
  demo: () => run('demo.sql'),
  reset: async () => {
    await createDatabase();
    await commands.migrate();
    await commands.seed();
  },
  // The same step src/start.js runs after its migrations, by hand: for a
  // database that was upgraded outside a deploy, or to add the first admin
  // to one that already exists. Safe to repeat.
  bootstrap: async () => {
    const [{ bootstrapAdmin }, { pool }] = await Promise.all([
      import('../src/auth/bootstrap.js'),
      import('../src/db.js'),
    ]);
    try {
      const { status } = await bootstrapAdmin({
        log: (line) => console.log(`• ${line}`),
        warn: (line) => console.warn(`! ${line}`),
      });
      console.log(
        status === 'created' ? '✓ first admin created'
          : status === 'conflict' ? '! nothing was changed — see the warning above'
          : '✓ nothing to do'
      );
    } finally {
      await pool.end();
    }
  },
};

const command = process.argv[2];
if (!commands[command]) {
  console.error(`Usage: node scripts/db.js <${Object.keys(commands).join('|')}>`);
  process.exit(1);
}

commands[command]().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (err.hint) console.error(`  hint: ${err.hint}`);
  process.exit(1);
});
