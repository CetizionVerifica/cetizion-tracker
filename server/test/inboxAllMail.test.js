import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The Inbox shows the whole shared mailbox, fills itself, and pages.
 *
 *   - A mailbox that feeds an Inbox keeps every message: colleagues, no-reply
 *     senders and the "Never sync" list included. Those still never reach
 *     the enquiry reader. A mailbox with no Inbox filters as before.
 *   - A colleague writing to sales@ opens a conversation.
 *   - Two syncs of one mailbox never run at once.
 *   - POST /api/inbox/sync pulls mail without anybody pressing Sync.
 *   - GET /api/inbox returns a page and says how many there are.
 *
 * Mail goes in through the in-memory `test` provider and the real sync.
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `inbox_all_mail_${process.pid}`;

let app; let agent; let db; let sync; let autoSync;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;

async function mailbox({ inbox = true } = {}) {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility, import_days)
     VALUES ('admin', 'test', $1, true, 'share_everything', 30) RETURNING *`, [`${uid('sales')}@cetizionverifica.com`]);
  if (inbox) await db.query(`INSERT INTO inboxes (name, account_id, default_assignment) VALUES ($1, $2, 'unassigned')`, [`Inbox ${a.id}`, a.id]);
  return a;
}

const mail = (box, over = {}) => ({
  provider_id: uid('m'), conversation_id: uid('conv'),
  from: { email: 'ravi@acme-steel.co.in', name: 'Ravi Kumar' }, to: [{ email: box.email }], cc: [],
  subject: 'Hello', body_html: '<p>Hello</p>', sent_at: new Date().toISOString(), ...over,
});

const conversations = async (accountId) => (await db.query(
  `SELECT c.*, t.conversation_id FROM inbox_conversations c JOIN email_threads t ON t.id = c.thread_id WHERE t.account_id = $1`, [accountId])).rows;

describe('the inbox keeps all mail, syncs itself and pages', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
    await db.query(`INSERT INTO settings (key, value) VALUES ('internal_email_domains', 'cetizionverifica.com')
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await db.query(`INSERT INTO email_blocklist (pattern) VALUES ('newsletter.example')`);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    sync = await import('../src/lib/mailbox/sync.js');
    autoSync = await import('../src/lib/mailbox/autoSync.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  test('a mailbox that feeds an Inbox keeps the mail the filters would drop, and each one is a conversation', async () => {
    const box = await mailbox();
    const colleague = mail(box, { from: { email: 'priya@cetizionverifica.com', name: 'Priya' }, subject: 'Internal: site visit plan' });
    const robot = mail(box, { from: { email: 'no-reply@portal.example', name: 'Portal' }, subject: 'Your password was changed' });
    const blocked = mail(box, { from: { email: 'news@newsletter.example', name: 'News' }, subject: 'This week' });
    const client = mail(box, { subject: 'Quotation please' });
    sync.pushTestMessages(box.id, [colleague, robot, blocked, client]);

    const r = await sync.syncAccount(box.id);
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.stored, 4, JSON.stringify(r.skipped));
    assert.deepEqual(r.skipped, {});

    const convs = await conversations(box.id);
    assert.deepEqual(
      convs.map((c) => c.conversation_id).sort(),
      [colleague, robot, blocked, client].map((m) => m.conversation_id).sort(),
      'every message the address received is in the Inbox');

    // The filters still decide what the enquiry reader sees.
    const { rows: decided } = await db.query('SELECT provider_id FROM email_enquiry_decisions WHERE account_id = $1', [box.id]);
    const judged = decided.map((d) => d.provider_id);
    for (const m of [colleague, robot, blocked]) assert.ok(!judged.includes(m.provider_id), `${m.subject} never reaches the enquiry reader`);
  });

  test('a colleague replying on an open conversation still counts as our reply', async () => {
    const box = await mailbox();
    const first = mail(box, { subject: 'Need a quote' });
    sync.pushTestMessages(box.id, [first]);
    await sync.syncAccount(box.id);
    const answer = mail(box, {
      conversation_id: first.conversation_id, from: { email: 'priya@cetizionverifica.com', name: 'Priya' },
      to: [{ email: 'ravi@acme-steel.co.in' }], cc: [{ email: box.email }], subject: 'RE: Need a quote',
      sent_at: new Date(Date.now() + 60_000).toISOString(),
    });
    sync.pushTestMessages(box.id, [answer]);
    await sync.syncAccount(box.id);

    const [c] = await conversations(box.id);
    assert.equal(c.status, 'pending_client');
    assert.ok(c.first_response_at, 'the reply clock stopped');
    assert.equal(c.response_due_at, null);
  });

  test('a mailbox without an Inbox still filters as before', async () => {
    const box = await mailbox({ inbox: false });
    sync.pushTestMessages(box.id, [
      mail(box, { from: { email: 'priya@cetizionverifica.com', name: 'Priya' } }),
      mail(box, { from: { email: 'news@newsletter.example', name: 'News' } }),
    ]);
    const r = await sync.syncAccount(box.id);
    assert.equal(r.stored, 0);
    assert.deepEqual(r.skipped, { 'internal only': 1, 'blocked sender': 1 });
  });

  test('a second sync of the same mailbox steps aside while the first runs', async () => {
    const box = await mailbox();
    const { pool } = await import('../src/db.js');
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(2900, $1)', [box.id]);
      sync.pushTestMessages(box.id, [mail(box)]);
      const r = await sync.syncAccount(box.id);
      assert.equal(r.skipped, 'already syncing');
      const { rows: [{ count }] } = await db.query('SELECT COUNT(*)::int AS count FROM email_messages WHERE account_id = $1', [box.id]);
      assert.equal(count, 0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock(2900, $1)', [box.id]);
      holder.release();
    }
    const r = await sync.syncAccount(box.id);
    assert.equal(r.stored, 1, 'and the next one picks the mail up');
  });

  test('POST /api/inbox/sync pulls new mail without anybody pressing Sync', async () => {
    const box = await mailbox();
    const msg = mail(box, { subject: 'Arrived on its own' });
    sync.pushTestMessages(box.id, [msg]);

    const res = await agent.post('/api/inbox/sync').send({});
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.data.started, true);
    await autoSync.kickSync(); // the sweep already running

    const convs = await conversations(box.id);
    assert.deepEqual(convs.map((c) => c.conversation_id), [msg.conversation_id]);

    const again = await agent.post('/api/inbox/sync').send({});
    assert.equal(again.body.data.started, false, 'asking again at once starts nothing new');
    assert.ok(again.body.data.last_synced_at);
  });

  test('the list comes a page at a time, with the total', async () => {
    const box = await mailbox();
    const base = Date.now() - 3600e3;
    sync.pushTestMessages(box.id, Array.from({ length: 7 }, (_, i) => mail(box, {
      subject: `Paged ${i}`, sent_at: new Date(base + i * 60_000).toISOString(),
    })));
    await sync.syncAccount(box.id);
    const { rows: [inbox] } = await db.query('SELECT id FROM inboxes WHERE account_id = $1', [box.id]);

    const one = await agent.get(`/api/inbox?inbox_id=${inbox.id}&page_size=3`);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.deepEqual(one.body.meta, { page: 1, page_size: 3, total: 7, pages: 3 });
    assert.deepEqual(one.body.data.map((c) => c.subject), ['Paged 6', 'Paged 5', 'Paged 4']);

    const three = await agent.get(`/api/inbox?inbox_id=${inbox.id}&page_size=3&page=3`);
    assert.deepEqual(three.body.data.map((c) => c.subject), ['Paged 0']);

    const beyond = await agent.get(`/api/inbox?inbox_id=${inbox.id}&page_size=3&page=9`);
    assert.deepEqual(beyond.body.data, []);
    assert.equal(beyond.body.meta.total, 7);

    const capped = await agent.get(`/api/inbox?inbox_id=${inbox.id}&page_size=100000&page=-4`);
    assert.equal(capped.body.meta.page_size, 200);
    assert.equal(capped.body.meta.page, 1);
  });
});
