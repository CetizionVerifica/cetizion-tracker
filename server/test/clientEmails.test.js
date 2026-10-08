import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import { CLIENT_EMAIL_KEYS, isClientEmail, parseHeld } from '../src/lib/clientEmails.js';

/**
 * An admin can see every kind of email that goes to a client and hold them
 * back, all at once or one kind at a time, while the team's own emails go
 * out as usual. A held email is logged as suppressed with the reason.
 * Runs against a throwaway database, so it needs TEST_DATABASE_URL (CI
 * sets it); the pure parts run without one.
 */

test('the held list keeps known kinds only, each once', () => {
  assert.deepEqual(parseHeld('["quotation","nonsense","quotation","payment_reminder"]'), ['payment_reminder', 'quotation']);
  assert.deepEqual(parseHeld('not json'), []);
  assert.deepEqual(parseHeld('{"quotation":true}'), []);
});

test('only client emails count as client emails', () => {
  for (const key of ['payment_reminder', 'portal_new_invoice', 'visit_client_reminder', 'quotation', 'quotation_acceptance', 'portal_link', 'portal_reply', 'mailbox_reply']) {
    assert.ok(isClientEmail(key), key);
  }
  for (const key of ['daily_digest', 'finance_digest', 'visit_reminder', 'alert', 'test', 'mis_personal', 'approval_request']) {
    assert.ok(!isClientEmail(key), key);
  }
});

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `client_emails_test_${process.pid}`;
const USERNAME = 'tester';
const PASSWORD = 'a-good-long-test-password';

describe('holding client emails', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  let app; let pool; let cookie; let sendMail; let replyToThread;
  const cookieOf = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

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
    await client.query(`
      INSERT INTO companies (id, name) VALUES (1001, 'Alpha Industries');
      INSERT INTO contacts (id, company_id, name, email) VALUES (2001, 1001, 'Asha Alpha', 'asha@alpha.example');
      INSERT INTO connected_accounts (id, username, provider, email, is_shared) VALUES (501, 'sales', 'test', 'sales@cetizion.example', true);
      INSERT INTO email_threads (id, account_id, conversation_id, subject, company_id, contact_id) VALUES (601, 501, 'conv-1', 'Audit dates', 1001, 2001);
      INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, to_emails, subject, sent_at)
        VALUES (501, 601, 'm-1', 'inbound', 'asha@alpha.example', '{sales@cetizion.example}', 'Audit dates', now());
    `);
    await client.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_USERNAME = USERNAME;
    process.env.AUTH_PASSWORD = PASSWORD;
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ sendMail } = await import('../src/lib/mail.js'));
    ({ replyToThread } = await import('../src/lib/mailbox/sync.js'));
    const signIn = await request(app).post('/api/auth/login').send({ username: USERNAME, password: PASSWORD });
    cookie = cookieOf(signIn, 'cetizion_session');
  });

  after(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const put = (body) => request(app).put('/api/client-emails').set('Cookie', cookie).send(body);

  test('lists every kind of client email, none held to start with', async () => {
    const res = await request(app).get('/api/client-emails').set('Cookie', cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.hold_all, false);
    assert.deepEqual(res.body.data.scenarios.map((s) => s.key), CLIENT_EMAIL_KEYS);
    assert.ok(res.body.data.scenarios.every((s) => !s.held && s.when && s.to));
  });

  test('one kind held: that kind is logged as held, other kinds and team email are not', async () => {
    const res = await put({ held: { quotation: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.scenarios.find((s) => s.key === 'quotation').held, true);
    assert.equal(res.body.data.scenarios.find((s) => s.key === 'portal_link').held, false);

    const quote = await sendMail({ to: 'asha@alpha.example', subject: 'Quotation Q-1', text: 'Attached.', template: 'quotation' });
    assert.equal(quote.status, 'suppressed');
    assert.equal(quote.reason, 'quotation emails are held by an admin');
    const link = await sendMail({ to: 'asha@alpha.example', subject: 'Portal link', text: 'Here.', template: 'portal_link' });
    assert.notEqual(link.reason, 'client emails are held by an admin');
    assert.doesNotMatch(String(link.reason), /held by an admin/);
    const digest = await sendMail({ to: 'team@cetizion.example', subject: 'Digest', text: 'Today.', template: 'daily_digest' });
    assert.doesNotMatch(String(digest.reason), /held by an admin/);

    const after = await request(app).get('/api/client-emails').set('Cookie', cookie);
    assert.equal(after.body.data.scenarios.find((s) => s.key === 'quotation').last_30_days.held, 1);
    assert.ok(after.body.data.recent.some((r) => r.id === quote.id));
    assert.ok(!after.body.data.recent.some((r) => r.id === digest.id), 'team email is not listed as a client email');
  });

  test('holding everything holds every kind and is recorded in the activity log', async () => {
    const res = await put({ hold_all: true });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.scenarios.every((s) => s.held));
    const reminder = await sendMail({ to: 'asha@alpha.example', subject: 'Overdue', text: 'Please pay.', template: 'payment_reminder' });
    assert.equal(reminder.status, 'suppressed');
    assert.equal(reminder.reason, 'client emails are held by an admin');
    const { rows } = await pool.query(`SELECT metadata FROM activity_log WHERE action = 'client_emails.changed' ORDER BY id`);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1].metadata.hold_all, { from: false, to: true });
  });

  test('a reply to a client from the Inbox is refused and logged while held', async () => {
    await assert.rejects(replyToThread(601, '<p>Monday works.</p>', 'tester'), (err) => err.status === 409 && /held by an admin/.test(err.message));
    const { rows: [row] } = await pool.query(`SELECT * FROM email_log WHERE template = 'mailbox_reply'`);
    assert.equal(row.status, 'suppressed');
    assert.equal(row.to_email, 'asha@alpha.example');
    assert.match(row.body_text, /Monday works/);
  });

  test('releasing keeps the kinds held one by one', async () => {
    const res = await put({ hold_all: false });
    assert.equal(res.body.data.hold_all, false);
    assert.deepEqual(res.body.data.scenarios.filter((s) => s.held).map((s) => s.key), ['quotation']);
  });

  test('an unknown kind is refused', async () => {
    const res = await put({ held: { newsletter: true } });
    assert.equal(res.status, 422);
    assert.equal((await put({})).status, 422);
  });
});
