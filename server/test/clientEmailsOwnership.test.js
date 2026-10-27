import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Who sees which client email. An admin sees every one, and whose record
 * it is on; a sales user sees only the client emails on records they own,
 * on Settings > Client emails, in the email log and on a company's
 * timeline. An owner who is no longer an active user is not listed against
 * an email. Needs TEST_DATABASE_URL (CI sets it); skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `client_emails_owner_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

describe('client emails follow ownership', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  let app; let pool; let db;
  const people = {};
  const ids = {};

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const { createUser } = await import('../src/lib/users.js');

    for (const [key, name, role] of [['alice', 'Alice', 'admin'], ['sam', 'Sam', 'sales'], ['tara', 'Tara', 'sales'], ['ivan', 'Ivan', 'sales']]) {
      const user = await createUser({ name, email: `${key}@example.com`, password: PASSWORD, role }, db);
      people[key] = { user };
    }
    for (const key of ['alice', 'sam', 'tara']) {
      const res = await request(app).post('/api/auth/login').send({ email: `${key}@example.com`, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      people[key].cookie = res.headers['set-cookie'];
    }
    await db.query('UPDATE users SET active = false WHERE id = $1', [people.ivan.user.id]);

    await db.query(`
      INSERT INTO companies (id, name) VALUES (1001, 'Alpha Industries'), (1002, 'Beta Metals'), (1003, 'Gamma Works');
      INSERT INTO quotations (quotation_no, client_name, company_id, quotation_date, quotation_value, owner_user_id) VALUES
        ('Q-SAM', 'Alpha Industries', 1001, '2026-09-01', 1000, $1),
        ('Q-TARA', 'Beta Metals', 1002, '2026-09-01', 1000, $2),
        ('Q-IVAN', 'Gamma Works', 1003, '2026-09-01', 1000, $3);
    `.replace('$1', people.sam.user.id).replace('$2', people.tara.user.id).replace('$3', people.ivan.user.id));
    const log = async (key, entity, entityId, template, to = 'client@example.com') => {
      const { rows: [r] } = await db.query(
        `INSERT INTO email_log (to_email, subject, template, entity, entity_id, status, body_text) VALUES ($1, $2, $3, $4, $5, 'sent', 'Body') RETURNING id`,
        [to, `${key} email`, template, entity, entityId]);
      ids[key] = r.id;
    };
    await log('samQuote', 'quotation', 'Q-SAM', 'quotation');
    await log('samReminder', 'company', '1001', 'payment_reminder');
    await log('taraQuote', 'quotation', 'Q-TARA', 'quotation');
    await log('taraLink', 'company', '1002', 'portal_link');
    await log('ivanQuote', 'quotation', 'Q-IVAN', 'quotation');
    await log('digest', 'digest', '2026-10-08', 'daily_digest', 'sam@example.com');
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const as = (who) => (method, path) => request(app)[method](path).set('Cookie', people[who].cookie);
  const recentIds = (res) => res.body.data.recent.map((r) => r.id).sort((a, b) => a - b);

  test('a sales user sees only the client emails on their own records', async () => {
    const res = await as('sam')('get', '/api/client-emails');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(recentIds(res), [ids.samQuote, ids.samReminder]);
    assert.equal(res.body.data.can_change, false);
    assert.equal(res.body.data.only_mine, true);
    assert.deepEqual(res.body.data.owners, []);
    assert.equal(res.body.data.scenarios.find((s) => s.key === 'quotation').last_30_days.sent, 1);
  });

  test('a sales user cannot change the holds', async () => {
    const res = await as('sam')('put', '/api/client-emails').send({ hold_all: true });
    assert.equal(res.status, 403);
  });

  test('an admin sees every client email and whose record it is on', async () => {
    const res = await as('alice')('get', '/api/client-emails');
    assert.equal(res.status, 200);
    assert.deepEqual(recentIds(res), [ids.samQuote, ids.samReminder, ids.taraQuote, ids.taraLink, ids.ivanQuote]);
    const byId = Object.fromEntries(res.body.data.recent.map((r) => [r.id, r]));
    assert.deepEqual(byId[ids.samQuote].owners, ['Sam']);
    assert.deepEqual(byId[ids.taraLink].owners, ['Tara']);
    assert.deepEqual(byId[ids.ivanQuote].owners, [], 'an owner who is not an active user is not listed');
    assert.deepEqual(res.body.data.owners.map((o) => o.name), ['Sam', 'Tara']);

    const tara = await as('alice')('get', `/api/client-emails?owner=${people.tara.user.id}`);
    assert.deepEqual(recentIds(tara), [ids.taraQuote, ids.taraLink]);
  });

  test('the email log is scoped the same way', async () => {
    const list = await as('sam')('get', '/api/emails');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.map((r) => r.id).sort((a, b) => a - b), [ids.samQuote, ids.samReminder]);
    assert.equal((await as('sam')('get', `/api/emails/${ids.taraQuote}`)).status, 404);
    assert.equal((await as('sam')('get', `/api/emails/${ids.samQuote}`)).status, 200);
    const all = await as('alice')('get', '/api/emails');
    assert.ok(all.body.data.some((r) => r.id === ids.digest), 'an admin sees every email');
  });

  test('a company timeline shows a sales user only their own client emails', async () => {
    const theirs = await as('sam')('get', '/api/timeline?entity=company&id=1002&kind=email');
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(JSON.stringify(theirs.body).includes('taraLink email'), false);
    assert.equal(JSON.stringify(theirs.body).includes('taraQuote email'), false);
    const mine = await as('sam')('get', '/api/timeline?entity=company&id=1001&kind=email');
    assert.match(JSON.stringify(mine.body), /samReminder email/);
    assert.match(JSON.stringify(mine.body), /samQuote email/);
  });
});
