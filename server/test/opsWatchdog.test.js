import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';

/**
 * How often the same alert may be raised again (#33, #38).
 *
 * Every condition repeated hourly, which is right for a disk filling up
 * and wrong for a backup schedule that does not exist yet: 24 identical
 * emails a day is how people learn to ignore alerts.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('how often the same alert is raised', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let dbName;
  let raiseAlert;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `alerts_suite_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.EMAIL_MODE = 'log';
    delete process.env.ALERT_EMAIL;

    ({ raiseAlert } = await import('../src/lib/ops/alerts.js'));
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await owner.end();
  });

  const keyFor = async (kind) => (await db.query(`SELECT dedupe_key FROM notifications WHERE kind = 'alert' AND dedupe_key LIKE $1 ORDER BY id DESC LIMIT 1`, [`alert:${kind}:%`])).rows[0]?.dedupe_key;

  test('a condition that can change within the hour may be raised hourly', async () => {
    assert.equal(await raiseAlert('disk', 'Disk 91% full', 'Path /'), true);
    assert.equal(await raiseAlert('disk', 'Disk 91% full', 'Path /'), false, 'not twice in the same hour');
    const key = await keyFor('disk');
    assert.match(key, /:\d{4}-\d{2}-\d{2}T\d{2}$/, 'the window is the hour');
  });

  test('a condition nobody can fix in minutes is raised once a day', async () => {
    assert.equal(await raiseAlert('backup', 'No successful database backup recorded recently', 'Last: never', { every: 'day' }), true);
    assert.equal(await raiseAlert('backup', 'No successful database backup recorded recently', 'Last: never', { every: 'day' }), false);
    const key = await keyFor('backup');
    assert.match(key, /:\d{4}-\d{2}-\d{2}$/, 'the window is the day, so it is one email and not twenty-four');
  });

  test('the slow conditions in the watchdog all ask for the daily window', () => {
    const src = readFileSync(new URL('../src/lib/ops/alerts.js', import.meta.url), 'utf8');
    for (const kind of ['certificate', 'backup', 'backup_verify']) {
      const line = src.split('\n').find((l) => l.includes(`raiseAlert('${kind}'`));
      assert.ok(line, `${kind} is still raised somewhere`);
      assert.match(line, /every: 'day'/, `${kind} repeats every hour, which is 24 identical emails a day`);
    }
  });
});
