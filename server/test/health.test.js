import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import request from 'supertest';

/**
 * The public health check the deploy job polls. started_at tells a new
 * container from the one it replaced, and the container only listens once
 * its migrations are done, so a newer started_at means the deploy is live.
 * The check queries the database, so it needs TEST_DATABASE_URL.
 */

const DATABASE_URL = process.env.TEST_DATABASE_URL;

describe('GET /api/health', { skip: !DATABASE_URL && 'set TEST_DATABASE_URL to run' }, async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = DATABASE_URL;
  // Imported after the environment is set, because config reads it once.
  const { default: app } = await import('../src/app.js');
  const { pool } = await import('../src/db.js');

  test('answers without a session and says when this process started', async () => {
    const before = Date.now();

    const first = await request(app).get('/api/health');
    const second = await request(app).get('/api/health');

    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'ok');
    assert.ok(!Number.isNaN(Date.parse(first.body.started_at)), 'started_at is a timestamp');
    assert.ok(Date.parse(first.body.started_at) <= before, 'it is when the process started, not when asked');
    assert.equal(second.body.started_at, first.body.started_at, 'it stays the same for the life of the process');
  });

  test.after(() => pool.end());
});
