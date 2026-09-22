import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * Three of the "should fix" notes on the batch 3 review (#59).
 *
 *   - the renewals job opened dead engagements before it settled them, so
 *     the first morning would mint real quotations for work nobody is
 *     renewing
 *   - notes and attachments carried no author, so every timeline entry was
 *     anonymous, which fails two of #22's acceptance lines
 *   - Collections dropped debt in another currency from every total without
 *     saying so, where Cashflow lists the same case honestly
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

test('the renewals job settles before it opens anything', async () => {
  const src = readFileSync(new URL('../src/lib/renewals.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function runRenewals'));
  const order = ['settleEngagements', 'discoverEngagements', 'openRenewals'].map((f) => body.indexOf(`await ${f}`));
  assert.ok(order.every((i) => i > 0), 'the three steps are all still there');
  assert.deepEqual([...order].sort((a, b) => a - b), order,
    'settle runs first: opening a renewal mints a real quotation, and an engagement that is already dead should be retired before anything is minted for it');
  // And opening is bounded at both ends, so a discovery back-dated from a
  // two-year-old delivery is not "due" today.
  const opens = src.slice(src.indexOf('export async function openRenewals'));
  assert.match(opens, /next_due_on \+ 90 >= \$1::date/, 'there is a lower bound on how far past its date a renewal may be opened');
});

describe('authors, and debt in another currency', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `batch3_suite_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'sami';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'sami', password: 'a-good-long-test-password' }).expect(200);
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

  test('a note is signed by whoever wrote it, without being asked', async () => {
    const { body } = await agent.post('/api/notes')
      .send({ entity: 'quotation', entity_id: 'CTZ/QT/2026/001', body: 'Client asked for a revised schedule.' })
      .expect(201);
    assert.equal(body.data.author, 'sami', 'the timeline says who, rather than an anonymous someone');
  });

  test('an author sent explicitly is kept, so an import can carry its own', async () => {
    const { body } = await agent.post('/api/notes')
      .send({ entity: 'quotation', entity_id: 'CTZ/QT/2026/001', body: 'Migrated from the old sheet.', author: 'Ramesh' })
      .expect(201);
    assert.equal(body.data.author, 'Ramesh');
  });

  test('debt in another currency is reported, not quietly dropped', async () => {
    // One rupee invoice and one dollar invoice, both overdue.
    await db.query(`
      INSERT INTO companies (id, name) VALUES (7001, 'Rupee Client'), (7002, 'Dollar Client');
      INSERT INTO projects (project_id, client_name, company_id) VALUES ('PRJ-INR', 'Rupee Client', 7001), ('PRJ-USD', 'Dollar Client', 7002);
      INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
        VALUES ('PO-INR', 'PRJ-INR', '2026-01-01', 100000, 'INR'), ('PO-USD', 'PRJ-USD', '2026-01-01', 10000, 'USD');
      INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, credit_days)
        VALUES ('PO-INR', 1, 'Advance', 'On PO Registration', 0.5, 'INV-INR', '2026-02-01', 30),
               ('PO-USD', 1, 'Advance', 'On PO Registration', 0.5, 'INV-USD', '2026-02-01', 30);
    `);

    const { body } = await agent.get('/api/collections').expect(200);
    assert.ok(Array.isArray(body.data.foreign), 'the response says what it left out');
    const usd = body.data.foreign.find((f) => f.currency === 'USD');
    assert.ok(usd, `the dollar invoice is listed: ${JSON.stringify(body.data.foreign)}`);
    assert.equal(usd.invoice_no, 'INV-USD');
    assert.ok(Number(usd.amount) > 0, 'with its amount, unconverted');

    // The rupee total is still rupees only — converting on a collections
    // screen would be inventing a rate — but it is no longer silent.
    assert.equal(Number(body.data.totals.outstanding), 50000);
    assert.ok(!body.data.foreign.some((f) => f.currency === 'INR'), 'and rupee debt is not double-counted into it');
  });
});
