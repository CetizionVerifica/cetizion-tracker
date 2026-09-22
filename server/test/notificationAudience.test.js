import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import request from 'supertest';

/**
 * Who a notification is for (#44, blocking item 2 on the batch 3 review).
 *
 * Every row was written with username = 'admin' — the default, which no
 * caller overrode — while the route read as req.user.username, which in
 * database auth mode is the person's email address. Nothing ever matched:
 * the bell read zero for everybody, the page said "All caught up" for ever,
 * and mark-as-read answered 404. Only the digest email worked, because it
 * reads the table directly.
 *
 * A row is now addressed to a person where the record names one, or to
 * nobody — meaning everyone — where it does not, and the reader is matched
 * on their sign-in address and on their account name, which are the two
 * spellings the tracker has for the same person until #18 joins them up.
 *
 * Database mode, because that is the mode the bug only appears in.
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';

describe('the notification centre', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let pool;
  let dbName;
  let createUser;
  let asha;
  let ravi;

  const signIn = async (email) => {
    const { loginLimiter } = await import('../src/auth/routes.js');
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) {
      try { loginLimiter.resetKey(ip); } catch { /* not a key this store knows */ }
    }
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.headers['set-cookie'];
  };

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `notify_suite_${process.pid}_${Date.now()}`;
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
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ createUser } = await import('../src/lib/users.js'));

    const a = await createUser({ name: 'Asha', email: 'asha@cetizionverifica.com', password: PASSWORD, role: 'sales' }, db);
    const r = await createUser({ name: 'Ravi', email: 'ravi@cetizionverifica.com', password: PASSWORD, role: 'sales' }, db);
    asha = { user: a, cookie: await signIn(a.email) };
    ravi = { user: r, cookie: await signIn(r.email) };
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await owner.end();
  });

  const raise = async (row) => {
    const { notify } = await import('../src/lib/notify.js');
    return notify(row);
  };
  const unread = async (who) => (await request(app).get('/api/notifications/summary').set('Cookie', who.cookie).expect(200)).body.data.unread;
  const listed = async (who) => (await request(app).get('/api/notifications').set('Cookie', who.cookie).expect(200)).body.data;

  test('a notification for nobody in particular reaches everybody', async () => {
    await raise({ kind: 'invoice_overdue', title: 'Invoice INV-1 is now overdue', dedupeKey: 'overdue:1' });
    assert.equal(await unread(asha), 1, 'the bell counts it');
    assert.equal(await unread(ravi), 1, 'for everyone, because an overdue invoice is not one person’s');
  });

  test('a notification addressed to a person reaches them, by the name the tracker records', async () => {
    // The tracker writes 'Asha' — a sales person's name — while the account
    // signs in as an email. Both are the same person.
    await raise({ username: 'Asha', kind: 'follow_up', title: 'Follow up Hindalco', dedupeKey: 'followup:1' });
    assert.equal(await unread(asha), 2);
    assert.equal(await unread(ravi), 1, 'and nobody else');
  });

  test('the address someone signs in with works just as well', async () => {
    await raise({ username: 'ravi@cetizionverifica.com', kind: 'task_due', title: 'Send the revised quotation', dedupeKey: 'task:1' });
    assert.equal(await unread(ravi), 2);
    assert.equal(await unread(asha), 2);
  });

  test('reading one marks it read for the reader, and only what is theirs', async () => {
    const mine = await listed(asha);
    const followUp = mine.find((n) => n.kind === 'follow_up');
    assert.ok(followUp, 'the row addressed to Asha is on her list');
    await request(app).post(`/api/notifications/${followUp.id}/read`).set('Cookie', asha.cookie).expect(200);
    assert.equal(await unread(asha), 1);

    // Ravi cannot mark Asha's row read: it is not his to see.
    const hers = (await listed(asha)).find((n) => n.kind === 'follow_up');
    await request(app).post(`/api/notifications/${hers.id}/read`).set('Cookie', ravi.cookie).expect(404);
  });

  test('read-all clears what the reader can see and leaves the rest', async () => {
    const before = await unread(ravi);
    assert.ok(before > 0);
    await request(app).post('/api/notifications/read-all').set('Cookie', ravi.cookie).expect(200);
    assert.equal(await unread(ravi), 0);
    // Asha still has her own unread row; his read-all did not touch it.
    assert.equal(await unread(asha), 1);
  });

  test('the sweep addresses what it raises, rather than leaving it for nobody', async () => {
    await db.query(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee, status) VALUES ('quotation', 'Q-1', 'Chase the PO', CURRENT_DATE, 'Ravi', 'todo')`);
    const { collectNotifications } = await import('../src/lib/notify.js');
    await collectNotifications();
    const { rows } = await db.query(`SELECT username FROM notifications WHERE kind IN ('task_due', 'task_overdue') ORDER BY id DESC LIMIT 1`);
    assert.equal(rows[0].username, 'Ravi', 'a task with an assignee is that person’s to see');
  });
});
