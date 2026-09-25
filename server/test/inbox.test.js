import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Deleting an inbox.
 *
 * inbox_conversations.inbox_id cascades, so the delete takes the triage with
 * it — status, owner, labels, the reply clock, the enquiry link. The emails
 * are in email_threads and are not the inbox's to delete. These pin both
 * halves: that the cascade really does only reach the conversations, and
 * that a delete which would discard any of them has to say so first.
 *
 * Runs against a throwaway database, so it needs TEST_DATABASE_URL (CI sets
 * it); skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `inbox_test_${process.pid}`;
const USERNAME = 'tester';
const PASSWORD = 'a-good-long-test-password';

let app; let pool; let staff;
const cookieOf = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

async function seedFixtures(client) {
  await client.query(`
    INSERT INTO connected_accounts (id, provider, email, username, is_shared, status)
      VALUES (5001, 'microsoft', 'sales@cetizionverifica.com', 'admin', true, 'active'),
             (5002, 'microsoft', 'quotes@cetizionverifica.com', 'admin', true, 'active');
    INSERT INTO email_threads (id, account_id, conversation_id, subject, last_message_at)
      VALUES (6001, 5001, 't-1', 'Enquiry: pressure vessel', now()),
             (6002, 5001, 't-2', 'Re: calibration', now());
    -- Two messages on thread 6001 so the list has to pick the newer one,
    -- and one on 6002 carrying an attachment.
    INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, snippet, has_attachments, sent_at)
      VALUES (5001, 6001, 'm-1', 'inbound', 'asha@hetero.example', 'The older message nobody should see in the list.', false, now() - interval '2 hours'),
             (5001, 6001, 'm-2', 'inbound', 'asha@hetero.example', 'Could you quote stage 1 and stage 2 for a single site?', false, now()),
             (5001, 6002, 'm-3', 'inbound', 'bina@hetero.example', 'Payment advice attached.', true, now());
  `);
}

describe('the shared inbox', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await client.query(readFileSync(join(DB_DIR, f), 'utf8'));
    await seedFixtures(client);
    await client.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_USERNAME = USERNAME;
    process.env.AUTH_PASSWORD = PASSWORD;
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const signIn = await request(app).post('/api/auth/login').send({ username: USERNAME, password: PASSWORD });
    staff = cookieOf(signIn, 'cetizion_session');
  });

  after(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const create = (account_id, name) => request(app).post('/api/inbox/inboxes').set('Cookie', staff).send({ name, account_id });

  test('an inbox nothing has reached deletes without argument', async () => {
    const made = await create(5002, 'Quotes');
    assert.equal(made.status, 201, JSON.stringify(made.body));

    const gone = await request(app).delete(`/api/inbox/inboxes/${made.body.data.id}`).set('Cookie', staff);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.data.deleted, 'Quotes');
    assert.equal(gone.body.data.conversations, 0);

    const list = await request(app).get('/api/inbox/inboxes').set('Cookie', staff);
    assert.deepEqual(list.body.data.map((i) => i.name), []);
  });

  test('one that would discard conversations refuses, and says how many', async () => {
    const made = await create(5001, 'Sales');
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const id = made.body.data.id;
    await pool.query(
      `INSERT INTO inbox_conversations (inbox_id, thread_id, from_email, status, assignee)
       VALUES ($1, 6001, 'asha@hetero.example', 'open', 'Ravi'), ($1, 6002, 'bina@hetero.example', 'closed', 'Ravi')`, [id]);

    const refused = await request(app).delete(`/api/inbox/inboxes/${id}`).set('Cookie', staff);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error.message, /2 conversations/);
    assert.equal(refused.body.error.conversations, 2);

    // Refused means nothing happened, not "happened and then complained".
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM inbox_conversations WHERE inbox_id = $1', [id]);
    assert.equal(rows[0].n, 2);
  });

  test('the count is on the listing, so the dialog can say it before asking', async () => {
    const list = await request(app).get('/api/inbox/inboxes').set('Cookie', staff);
    const sales = list.body.data.find((i) => i.name === 'Sales');
    assert.equal(sales.conversations, 2);
    assert.equal(sales.open, 1);
  });

  /**
   * Which of our own addresses a thread arrived at. C13 prints it as
   * "to sales@", and with two shared mailboxes connected the reading pane
   * read identically whichever one the client had written to — while the
   * reply goes out from whichever it was.
   */
  /**
   * The band C13 does not have. The subject alone does not say whether a
   * "Re: Quotation …" is a question, an approval or a complaint.
   */
  test('the list carries the newest message, not the first', async () => {
    const list = await request(app).get('/api/inbox').set('Cookie', staff);
    const open = list.body.data.find((c) => c.thread_id === 6001);
    assert.equal(open.snippet, 'Could you quote stage 1 and stage 2 for a single site?');
    assert.equal(open.has_attachments, false);
  });

  test('a thread nobody has opened is unread, and opening it is what changes that', async () => {
    const before = await request(app).get('/api/inbox').set('Cookie', staff);
    const conversation = before.body.data.find((c) => c.thread_id === 6001);
    assert.equal(conversation.unread, true, 'nothing has opened it yet');

    // The fetch is the gesture; there is no separate "mark read" call.
    const opened = await request(app).get(`/api/inbox/${conversation.id}`).set('Cookie', staff);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    const after = await request(app).get('/api/inbox').set('Cookie', staff);
    assert.equal(after.body.data.find((c) => c.id === conversation.id).unread, false);

    const { rows } = await pool.query('SELECT first_opened_by FROM inbox_conversations WHERE id = $1', [conversation.id]);
    assert.equal(rows[0].first_opened_by, USERNAME, 'and it records who looked first');
  });

  test('a second reader does not overwrite who saw it first', async () => {
    const list = await request(app).get('/api/inbox').set('Cookie', staff);
    const conversation = list.body.data.find((c) => c.thread_id === 6001);
    await pool.query(`UPDATE inbox_conversations SET first_opened_by = 'Someone Else' WHERE id = $1`, [conversation.id]);

    await request(app).get(`/api/inbox/${conversation.id}`).set('Cookie', staff);

    const { rows } = await pool.query('SELECT first_opened_by FROM inbox_conversations WHERE id = $1', [conversation.id]);
    assert.equal(rows[0].first_opened_by, 'Someone Else', 're-reading is a no-op, not a write');
  });

  test('a conversation says which shared address it came to', async () => {
    const list = await request(app).get('/api/inbox').set('Cookie', staff);
    const [conversation] = list.body.data;
    assert.equal(conversation.inbox_email, 'sales@cetizionverifica.com');

    const one = await request(app).get(`/api/inbox/${conversation.id}`).set('Cookie', staff);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.data.inbox_email, 'sales@cetizionverifica.com', 'the reading pane reads it from the detail route');
  });

  test('discard=yes deletes the inbox and its triage, and leaves the mail', async () => {
    const list = await request(app).get('/api/inbox/inboxes').set('Cookie', staff);
    const id = list.body.data.find((i) => i.name === 'Sales').id;

    const gone = await request(app).delete(`/api/inbox/inboxes/${id}?discard=yes`).set('Cookie', staff);
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(gone.body.data.conversations, 2);

    const conversations = await pool.query('SELECT COUNT(*)::int AS n FROM inbox_conversations WHERE inbox_id = $1', [id]);
    assert.equal(conversations.rows[0].n, 0);

    // The point of the warning: the emails were never the inbox's to delete.
    const threads = await pool.query('SELECT COUNT(*)::int AS n FROM email_threads WHERE id IN (6001, 6002)');
    assert.equal(threads.rows[0].n, 2);

    // And the mailbox is free to take an inbox again.
    const after = await request(app).get('/api/inbox/inboxes').set('Cookie', staff);
    assert.ok(after.body.available_mailboxes.some((m) => m.id === 5001));
  });

  test('deleting an inbox that is not there is a 404, not a silent success', async () => {
    const missing = await request(app).delete('/api/inbox/inboxes/9999').set('Cookie', staff);
    assert.equal(missing.status, 404, JSON.stringify(missing.body));
  });
});
