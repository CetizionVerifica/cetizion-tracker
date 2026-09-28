import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import XLSX from 'xlsx';

/**
 * Two sheet rows with the same PO number, settled during review.
 *
 * The planner lets the first row create the PO and blocks the others. The
 * block has to lift the moment a reviewer settles it — by correcting the
 * number, or by unticking a row — or the commit stays refused and the only
 * way out is to re-plan, which throws the reviewer's edits away.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

// Each test uses its own PO number: a number committed by one test is
// rightly seen as already on the site by the next.
const sheet = (po) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Deal Register'],
    ['Deal ID', 'Client', 'Service / Proposal', 'Deal Stage', 'Currency', 'Proposal Date', 'PO / WO No.', 'PO Date / Received', 'PO Value'],
    ['CV-1', 'Repeat One', 'ASI audit', '4. Won – PO Received', 'INR', '01-Sep-2026', po, '10-Sep-2026', 100000],
    ['CV-2', 'Repeat Two', 'LCA study', '4. Won – PO Received', 'INR', '02-Sep-2026', po, '11-Sep-2026', 200000],
  ]), 'Deal Register');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

describe('a PO number on two rows of a sheet', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let dbName;
  let agent;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `import_repeated_po_${process.pid}_${Date.now()}`;
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

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    // Set, not deleted: dotenv would fill a deleted key in again from .env.
    process.env.OPENROUTER_API_KEY = '';

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

  const upload = async (po) => (await agent.post('/api/import/batches').attach('file', sheet(po), 'repeat.xlsx').expect(201)).body.data;
  const pos = (batch) => batch.items.filter((i) => i.step === 'purchase_order');
  const repeated = (item) => item.flags.filter((f) => f.code === 'duplicate_po_in_sheet').map((f) => f.level);

  test('the second row is blocked; correcting its number lifts the block and the batch commits', async () => {
    const batch = await upload('4509990001');
    const [first, second] = pos(batch);
    assert.deepEqual([repeated(first), repeated(second)], [['warn'], ['error']]);
    assert.equal(first.source_label, 'S.No CV-1', 'the label survives into the review');

    const edited = (await agent.patch(`/api/import/items/${second.id}`).send({ payload: { po_number: '4509990002' } }).expect(200)).body.data;
    const [f, s] = pos(edited);
    assert.deepEqual([repeated(f), repeated(s)], [[], []]);

    await agent.post(`/api/import/batches/${batch.id}/commit`).expect(200);
    const { rows } = await db.query(`SELECT po_number FROM purchase_orders WHERE po_number LIKE '450999000%' ORDER BY 1`);
    assert.deepEqual(rows.map((r) => r.po_number), ['4509990001', '4509990002']);
  });

  test('unticking the row that creates the PO settles it too, and ticking it again brings it back', async () => {
    const batch = await upload('4509990011');
    const [first] = pos(batch);

    const unticked = (await agent.patch(`/api/import/items/${first.id}`).send({ included: false }).expect(200)).body.data;
    assert.deepEqual(pos(unticked).map(repeated), [[], []], 'an unticked row creates nothing, so nothing collides');

    const back = (await agent.patch(`/api/import/items/${first.id}`).send({ included: true }).expect(200)).body.data;
    assert.deepEqual(pos(back).map(repeated), [['warn'], ['error']]);
  });
});
