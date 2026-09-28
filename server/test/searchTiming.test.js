import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';

/**
 * #75 — how long GET /api/search takes against the real workbook data
 * (db/seed.sql). The median and slowest are printed, so every CI run
 * carries the measurement, and the median is held to the issue's 200 ms.
 *
 * Its own file, and so its own process: the app reads DATABASE_URL once,
 * on import, and this one must point at a database holding the seed.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

// Things people type: a whole reference, part of one, a client, a person.
const QUERIES = ['CTZ/QT/2026/007', 'CTZ/QT', 'assan', 'aluminium', 'PRJ-2026', 'ramesh', 'surveillance audit'];
const ROUNDS = 5;

describe('GET /api/search against the seed data', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let app;
  let pool;
  let cookie;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `search_timing_test_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      for (const file of ['schema.sql', 'views.sql', 'seed.sql']) {
        await client.query(readFileSync(join(DB_DIR, file), 'utf8'));
      }
    } finally {
      await client.end();
    }

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_USERNAME = 'tester';
    process.env.AUTH_PASSWORD = 'test-password-long-enough';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';

    app = (await import('../src/app.js')).default;
    pool = (await import('../src/db.js')).pool;
    const signIn = await request(app).post('/api/auth/login')
      .send({ username: 'tester', password: 'test-password-long-enough' });
    assert.equal(signIn.status, 200, 'sign-in failed');
    cookie = signIn.headers['set-cookie'];
  });

  after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  test('a search answers well inside 200 ms with the seed loaded', async () => {
    const search = (q) => request(app).get(`/api/search?q=${encodeURIComponent(q)}`).set('Cookie', cookie);
    const { rows: [{ quotations }] } = await pool.query('SELECT COUNT(*)::int AS quotations FROM quotations');
    assert.ok(quotations > 0, 'the seed loaded');

    // One pass to warm the pool and Postgres's plan cache, not counted.
    for (const q of QUERIES) assert.equal((await search(q)).status, 200);

    const times = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const q of QUERIES) {
        const started = process.hrtime.bigint();
        const res = await search(q);
        times.push(Number(process.hrtime.bigint() - started) / 1e6);
        assert.equal(res.status, 200);
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const slowest = times[times.length - 1];
    console.log(`[search timing] ${quotations} quotations, ${times.length} requests: median ${median.toFixed(1)} ms, slowest ${slowest.toFixed(1)} ms`);

    const exact = (await search('CTZ/QT/2026/007')).body.data[0];
    assert.equal(exact.title, 'CTZ/QT/2026/007', 'a real reference is still first');
    assert.ok(median < 200, `median ${median.toFixed(1)} ms`);
  });
});
