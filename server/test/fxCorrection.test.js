import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * A rate an admin corrects in Settings is theirs, and the ECB feed leaves it
 * alone. The feed only replaces rows marked 'feed', and the Settings form does
 * not send `source`, so the save itself has to mark a corrected feed row as
 * manual — or the next backfill quietly puts the ECB number back.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('correcting an ECB rate by hand', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let dbName;
  let agent;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `fx_correction_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));
    await db.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from, source) VALUES
      ('USD', 95.10, '2026-04-01', 'feed'), ('EUR', 108.20, '2026-04-01', 'feed')`);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    const { default: app } = await import('../src/app.js');
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  const row = async (currency) => (await db.query(
    `SELECT id, rate, source FROM exchange_rates WHERE from_currency = $1 AND effective_from = '2026-04-01'`, [currency]
  )).rows[0];

  test('a corrected feed rate becomes manual, and the next backfill leaves it alone', async () => {
    const usd = await row('USD');
    // What the Settings form sends: currency, rate, date and note — no source.
    const { body } = await agent.patch(`/api/exchange-rates/${usd.id}`)
      .send({ from_currency: 'USD', rate: 90, effective_from: '2026-04-01', note: 'bank confirmed' })
      .expect(200);
    assert.equal(body.data.source, 'manual');

    const { upsertFeedRates } = await import('../src/lib/fx.ts');
    const result = await upsertFeedRates([{ currency: 'USD', rate: 95.1, effective_from: '2026-04-01' }], { db });
    assert.deepEqual(result.kept_manual, ['USD 2026-04-01']);
    assert.deepEqual([Number((await row('USD')).rate), (await row('USD')).source], [90, 'manual']);
  });

  test('changing only the note of a feed rate leaves it a feed rate', async () => {
    const eur = await row('EUR');
    const { body } = await agent.patch(`/api/exchange-rates/${eur.id}`).send({ note: 'checked' }).expect(200);
    assert.equal(body.data.source, 'feed');
  });
});
