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

const commands = {
  create: createDatabase,
  migrate: async () => {
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
