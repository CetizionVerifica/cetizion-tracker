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

  // ------------------------------------------------------------------ #44

  const setNotify = async (who, notify) => {
    const res = await request(app).patch('/api/auth/account').set('Cookie', who.cookie).send({ notify });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.notify;
  };
  const emails = async (template) => (await db.query(`SELECT to_email, entity_id FROM email_log WHERE template = $1 ORDER BY id`, [template])).rows;

  test('each person chooses, per kind, the app, email, both or off (#44)', async () => {
    const kept = await setNotify(asha, { kinds: { tasks: 'off' } });
    assert.deepEqual(kept.kinds, { tasks: 'off' });
    await setNotify(asha, { kinds: { approvals: 'email' } });
    const both = (await request(app).get('/api/auth/account').set('Cookie', asha.cookie)).body.data.profile?.notify
      ?? (await db.query('SELECT notify FROM users WHERE id = $1', [asha.user.id])).rows[0].notify;
    assert.deepEqual(both.kinds, { tasks: 'off', approvals: 'email' }, 'one group at a time, the others kept');

    await raise({ username: 'Asha', kind: 'task_due', title: 'Hidden task', dedupeKey: `t44-a-${Date.now()}` });
    await raise({ username: 'Asha', kind: 'approval', title: 'Emailed approval', dedupeKey: `t44-b-${Date.now()}` });
    await raise({ username: 'Asha', kind: 'follow_up', title: 'Shown follow-up', dedupeKey: `t44-c-${Date.now()}` });
    const titles = (await listed(asha)).map((n) => n.title);
    assert.ok(titles.includes('Shown follow-up'));
    assert.equal(titles.includes('Hidden task'), false, 'off is off');
    assert.equal(titles.includes('Emailed approval'), false, 'email only is not in the bell');
    assert.ok((await listed(ravi)).length >= 0);

    const bad = await request(app).patch('/api/auth/account').set('Cookie', asha.cookie).send({ notify: { kinds: { tasks: 'loudly' } } });
    assert.equal(bad.status, 422);
  });

  test('the email job sends what was asked for by email, once, and waits out quiet hours (#44)', async () => {
    const { sendNotificationEmails } = await import('../src/lib/notify.js');
    await setNotify(ravi, { kinds: { deals: 'both' }, quiet: { from: '00:00', to: '23:59' } });
    await raise({ username: 'ravi@cetizionverifica.com', kind: 'po_registered', title: 'PO 44 registered', entity: 'project', entityId: 'PRJ-44', dedupeKey: `t44-d-${Date.now()}` });
    const toRavi = async () => (await emails('notification')).filter((e) => e.to_email === 'ravi@cetizionverifica.com');
    await sendNotificationEmails();
    assert.equal((await toRavi()).length, 0, 'quiet hours: held back');
    await setNotify(ravi, { quiet: null });
    await sendNotificationEmails();
    await sendNotificationEmails();
    assert.equal((await toRavi()).length, 1, 'sent once, after the quiet hours');
    assert.ok((await emails('notification')).some((e) => e.to_email === 'asha@cetizionverifica.com'), 'and the approval Asha asked to get by email');
  });

  test('doing the thing clears its notification for everybody (#44)', async () => {
    const { rows: [t] } = await db.query(`INSERT INTO tasks (entity, entity_id, title, due_at, assignee) VALUES ('company', '1', 'Call back', CURRENT_DATE, 'Ravi') RETURNING id`);
    await raise({ username: 'Ravi', kind: 'task_due', title: 'Due today: Call back', entity: 'company', entityId: '1', dedupeKey: `task:${t.id}:2026-09-26` });
    const was = await unread(ravi);
    await db.query(`UPDATE tasks SET status = 'done' WHERE id = $1`, [t.id]);
    assert.equal(await unread(ravi), was - 1, 'the ticked task is no longer waiting');

    await db.query(`INSERT INTO quotations (quotation_no, client_name, status, approval_status, sales_person) VALUES ('CTZ/QT/2026/944', 'Approve Me', 'Submitted', 'pending', 'Ravi')`);
    await raise({ kind: 'approval', title: 'Approval waiting: CTZ/QT/2026/944', entity: 'quotation', entityId: 'CTZ/QT/2026/944', dedupeKey: `t44-e-${Date.now()}` });
    await db.query(`UPDATE quotations SET approval_status = 'approved' WHERE quotation_no = 'CTZ/QT/2026/944'`);
    const { rows: [n] } = await db.query(`SELECT resolved_at FROM notifications WHERE kind = 'approval' AND entity_id = 'CTZ/QT/2026/944'`);
    assert.ok(n.resolved_at, 'a decided approval is resolved');
  });

  test('the 08:30 digest goes to each person, with only what is theirs (#44)', async () => {
    const { runDigests } = await import('../src/lib/notify.js');
    await setNotify(asha, { digest: false });
    await raise({ username: 'Ravi', kind: 'follow_up', title: 'Ravi alone', dedupeKey: `t44-f-${Date.now()}` });
    const result = await runDigests({ today: '2026-09-28' });
    const tos = result.digests.map((d) => d.to);
    assert.ok(tos.includes('ravi@cetizionverifica.com'));
    assert.equal(tos.includes('asha@cetizionverifica.com'), false, 'she switched hers off');
    const logged = await emails('daily_digest');
    assert.ok(logged.some((e) => e.entity_id === `notifications:2026-09-28:${ravi.user.id}`), 'one per person, per day');
  });

  test('the Monday digest goes to admins only (#44)', async () => {
    const { runWeeklyDigest } = await import('../src/lib/notify.js');
    const boss = await createUser({ name: 'Boss', email: 'boss@cetizionverifica.com', password: PASSWORD, role: 'admin' }, db);
    const result = await runWeeklyDigest({ today: '2026-09-28' });
    assert.deepEqual(result.weekly.map((w) => w.to), [boss.email]);
  });

  test('the sweep no longer emails one address when people have accounts; the digests do (#44)', async () => {
    const { JOBS } = await import('../src/jobs.js');
    assert.equal(JOBS['notifications.digest'].cron, '30 8 * * 1-5', '08:30 on working days');
    assert.equal(JOBS['notifications.weekly'].cron, '0 9 * * 1');
    const { runNotifications } = await import('../src/lib/notify.js');
    const out = await runNotifications({ today: '2026-09-28' });
    assert.match(String(out.digest), /per person/);
  });
});
