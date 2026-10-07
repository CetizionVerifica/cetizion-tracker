import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import nodemailer from 'nodemailer';
import pg from 'pg';
import request from 'supertest';

/**
 * Who the scheduled reports are sent from
 * (/mnt/project-files/plans/mis-report-sender-plan.md, Part A): a shared
 * mailbox, or a personal one whose owner allowed it; Send As and a display
 * name; a mailbox that cannot send falls back to SMTP and admins are told,
 * whatever the reason; each run records the From it carried; the settings
 * refuse what the reports could not use; the test goes to the caller only.
 *
 * In AUTH_MODE=database, so an owner and an admin can be told apart. SMTP is
 * nodemailer's jsonTransport; the mailbox provider is a fake.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mis_sender_${process.pid}`;
const TODAY = '2026-10-05';

describe('the sender of the scheduled reports', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let pool; let app; let misSend; let mail; let config;
  let admin; let owner; let other;
  let shared; let personal;
  const sent = [];
  const smtpSent = [];
  let refuseSendAs = false;

  const as = (who) => (method, path) => request(app)[method](path).set('Cookie', who.cookie);
  const setting = (key, value) => db.query('UPDATE settings SET value = $1 WHERE key = $2', [value, key]);
  const alerts = async (like) => (await db.query(`SELECT title, body FROM notifications WHERE kind = 'alert' AND title LIKE $1`, [like])).rows;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql', 'seed.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ config } = await import('../src/config.js'));
    misSend = await import('../src/lib/misSend.js');
    mail = await import('../src/lib/mail.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    const { createUser } = await import('../src/lib/users.js');
    const { loginLimiter } = await import('../src/auth/routes.js');

    const signIn = async (email) => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) { try { loginLimiter.resetKey(ip); } catch { /* unknown key */ } }
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    const a = await createUser({ name: 'Ada Admin', email: 'ada@example.com', password: PASSWORD, role: 'admin' }, db);
    const o = await createUser({ name: 'Sam Sales', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    const b = await createUser({ name: 'Bea Sales', email: 'bea@example.com', password: PASSWORD, role: 'sales' }, db);
    admin = { user: a, cookie: await signIn(a.email) };
    owner = { user: o, cookie: await signIn(o.email) };
    other = { user: b, cookie: await signIn(b.email) };

    ({ rows: [shared] } = await db.query(`INSERT INTO connected_accounts (username, provider, email, is_shared) VALUES ('x', 'test', 'sales@cetizionverifica.com', true) RETURNING *`));
    ({ rows: [personal] } = await db.query(`INSERT INTO connected_accounts (username, provider, email, is_shared, user_id) VALUES ('x', 'test', 'sam@cetizionverifica.com', false, $1) RETURNING *`, [o.id]));

    // A fake mailbox: records what it was asked to send, or refuses Send As as Exchange does.
    misSend.deps.providerFor = (account) => ({
      send: async (msg) => {
        if (refuseSendAs && msg.from) throw Object.assign(new Error('The user account which was used to submit this request does not have the right to send mail on behalf of the specified sending account.'), { status: 403, code: 'ErrorSendAsDenied' });
        sent.push({ account: account.email, ...msg });
      },
    });
    // SMTP: nodemailer's JSON transport, so a fallback can be seen leaving.
    const json = nodemailer.createTransport({ jsonTransport: true });
    mail.deps.transport = { sendMail: async (m) => { smtpSent.push(m); return json.sendMail(m); } };
    Object.assign(config.mail, { mode: 'live', host: 'smtp.test', from: 'Cetizion Tracker <tracker@cetizionverifica.com>', fromAllowed: [] });

    await setting('mis_to', 'md@cetizionverifica.com');
    await setting('mis_sender_account_id', String(shared.id));
  });

  after(async () => {
    mail.deps.transport = null;
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  test('which mailboxes can send: shared always; personal only with its owner\'s switch; never one that needs reconnecting', () => {
    assert.equal(misSend.mailboxProblem({ ...shared, status: 'active' }), null);
    assert.match(misSend.mailboxProblem({ ...personal, may_send_reports: false }), /owner has not allowed/);
    assert.equal(misSend.mailboxProblem({ ...personal, may_send_reports: true }), null);
    assert.match(misSend.mailboxProblem({ ...shared, status: 'needs_reconnect' }), /needs reconnecting/);
    assert.match(misSend.mailboxProblem({ ...shared, status: 'disconnected' }), /disconnected/);
    assert.match(misSend.mailboxProblem(undefined), /no longer connected/);
  });

  test('the SMTP From: EMAIL_FROM unless the address is allowed; a name is kept either way', () => {
    assert.equal(mail.addressOf('Cetizion Tracker <tracker@cetizionverifica.com>'), 'tracker@cetizionverifica.com');
    assert.deepEqual(mail.smtpFrom(null), { header: 'Cetizion Tracker <tracker@cetizionverifica.com>', address: 'tracker@cetizionverifica.com' });
    assert.deepEqual(mail.smtpFrom({ address: 'mis@cetizionverifica.com', name: 'Cetizion MIS' }), { header: { name: 'Cetizion MIS', address: 'tracker@cetizionverifica.com' }, address: 'tracker@cetizionverifica.com' });
    config.mail.fromAllowed = ['mis@cetizionverifica.com'];
    try {
      assert.deepEqual(mail.smtpFrom({ address: 'MIS@cetizionverifica.com', name: null }), { header: { name: 'Cetizion Tracker', address: 'MIS@cetizionverifica.com' }, address: 'MIS@cetizionverifica.com' });
    } finally { config.mail.fromAllowed = []; }
  });

  test('through a shared mailbox: the run records the From and the mailbox', async () => {
    sent.length = 0;
    const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'ada' });
    assert.equal(r.status, 'sent', JSON.stringify(r));
    assert.equal(r.sent_via, 'graph');
    assert.equal(r.sent_from, 'sales@cetizionverifica.com');
    assert.equal(r.sent_through, shared.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, undefined, 'no Send As asked for: the mailbox\'s own address');
    const { rows: [log] } = await db.query('SELECT from_email FROM email_log WHERE id = $1', [r.email_log_id]);
    assert.equal(log.from_email, 'sales@cetizionverifica.com');
    const [run] = (await misSend.listRuns()).filter((x) => x.id === r.id);
    assert.equal(run.sent_through_email, 'sales@cetizionverifica.com');
  });

  test('Send As and a display name go to Graph as the message\'s From', async () => {
    sent.length = 0;
    await setting('mis_sender_address', 'mis@cetizionverifica.com');
    await setting('mis_sender_name', 'Cetizion MIS');
    try {
      const r = await misSend.runReport('weekly_mis', { today: TODAY, startedBy: 'ada' });
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.deepEqual(sent[0].from, { address: 'mis@cetizionverifica.com', name: 'Cetizion MIS' });
      assert.equal(sent[0].account, 'sales@cetizionverifica.com', 'still through the chosen mailbox');
      assert.equal(r.sent_from, 'mis@cetizionverifica.com');
      assert.equal(r.sent_through, shared.id);
    } finally {
      await setting('mis_sender_address', 'none'); await setting('mis_sender_name', 'none');
    }
  });

  test('Send As refused by Exchange: the report goes by SMTP from EMAIL_FROM, and the alert says what to fix', async () => {
    refuseSendAs = true; smtpSent.length = 0;
    await setting('mis_sender_address', 'mis@cetizionverifica.com');
    try {
      const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'ada' });
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(r.sent_via, 'smtp');
      assert.equal(r.sent_from, 'tracker@cetizionverifica.com', 'the relay may not send as mis@, so EMAIL_FROM');
      assert.equal(r.sent_through, null);
      assert.match(r.error, /sales@cetizionverifica\.com is not allowed to send as mis@cetizionverifica\.com/);
      assert.equal(smtpSent.length, 1);
      assert.equal(smtpSent[0].attachments.length, 1, 'the PDF goes by SMTP too');
      const found = await alerts('%went by SMTP, not sales@cetizionverifica.com%');
      assert.equal(found.length, 1);
      assert.match(found[0].body, /Send As in Exchange/);
    } finally {
      refuseSendAs = false;
      await setting('mis_sender_address', 'none');
      await db.query(`DELETE FROM notifications WHERE kind = 'alert'`);
    }
  });

  test('never silent: a chosen mailbox that needs reconnecting sends by SMTP, the run says why, and admins are told', async () => {
    sent.length = 0; smtpSent.length = 0;
    await db.query(`UPDATE connected_accounts SET status = 'needs_reconnect' WHERE id = $1`, [shared.id]);
    try {
      const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'ada' });
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(r.sent_via, 'smtp');
      assert.equal(sent.length, 0, 'the mailbox was not asked');
      assert.equal(smtpSent.length, 1);
      assert.match(r.error, /Went by SMTP: sales@cetizionverifica\.com needs reconnecting/);
      const found = await alerts('%went by SMTP, not sales@cetizionverifica.com%');
      assert.equal(found.length, 1, 'today this went by SMTP and nobody was told');
      assert.match(found[0].body, /needs reconnecting/);

      const described = await as(admin)('get', '/api/mis-reports/sender').expect(200);
      assert.equal(described.body.data.via, 'smtp');
      assert.match(described.body.data.problem, /needs reconnecting/);
      assert.equal(described.body.data.through.email, 'sales@cetizionverifica.com', 'the saved choice is still named, not blank');
    } finally {
      await db.query(`UPDATE connected_accounts SET status = 'active' WHERE id = $1`, [shared.id]);
      await db.query(`DELETE FROM notifications WHERE kind = 'alert'`);
    }
  });

  test('a personal mailbox: only its owner allows it; then an admin may choose it; withdrawing it falls back loudly', async () => {
    // Saving it as the sender before the owner allowed it is refused, with the reason.
    const early = await as(admin)('patch', '/api/settings/mis_sender_account_id').send({ value: String(personal.id) }).expect(422);
    assert.match(early.body.error.message, /Its owner allows reports to be sent from it on the Mailboxes page/);

    // An admin cannot flip it for the owner, nor can a colleague; a shared mailbox has no switch.
    await as(admin)('patch', `/api/mailboxes/${personal.id}`).send({ may_send_reports: true }).expect(403);
    await as(other)('patch', `/api/mailboxes/${personal.id}`).send({ may_send_reports: true }).expect(404);
    await as(admin)('patch', `/api/mailboxes/${shared.id}`).send({ may_send_reports: true }).expect(422);

    const allowed = await as(owner)('patch', `/api/mailboxes/${personal.id}`).send({ may_send_reports: true }).expect(200);
    assert.equal(allowed.body.data.may_send_reports, true);
    const listed = await as(admin)('get', '/api/mailboxes').expect(200);
    assert.equal(listed.body.data.find((m) => m.id === personal.id).may_send_reports, true);

    await as(admin)('patch', '/api/settings/mis_sender_account_id').send({ value: String(personal.id) }).expect(200);
    sent.length = 0;
    const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'ada' });
    assert.equal(r.status, 'sent', JSON.stringify(r));
    assert.equal(sent[0].account, 'sam@cetizionverifica.com');
    assert.equal(r.sent_from, 'sam@cetizionverifica.com');

    // The owner changes their mind: the next report goes by SMTP, and admins are told why.
    await as(owner)('patch', `/api/mailboxes/${personal.id}`).send({ may_send_reports: false }).expect(200);
    const r2 = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'ada' });
    assert.equal(r2.sent_via, 'smtp');
    assert.match(r2.error, /owner has not allowed/);
    assert.equal((await alerts('%went by SMTP, not sam@cetizionverifica.com%')).length, 1);
    await setting('mis_sender_account_id', String(shared.id));
    await db.query(`DELETE FROM notifications WHERE kind = 'alert'`);
  });

  test('the settings refuse what the reports could not use', async () => {
    const patch = (key, value) => as(admin)('patch', `/api/settings/${key}`).send({ value });
    await patch('mis_sender_account_id', '99999').expect(422);
    await patch('mis_sender_account_id', 'sales@').expect(422);
    await patch('mis_sender_address', 'not an address').expect(422);
    await patch('mis_sender_name', 'Evil <x@y.z>').expect(422);
    assert.equal((await patch('mis_sender_name', 'Cetizion MIS').expect(200)).body.data.value, 'Cetizion MIS');
    assert.equal((await patch('mis_sender_address', 'MIS@cetizionverifica.com').expect(200)).body.data.value, 'MIS@cetizionverifica.com', 'through a mailbox, Exchange decides');

    // By SMTP, only an address the relay may use.
    await patch('mis_sender_account_id', 'none').expect(200);
    const refused = await patch('mis_sender_address', 'ceo@cetizionverifica.com').expect(422);
    assert.match(refused.body.error.message, /EMAIL_FROM_ALLOWED/);
    config.mail.fromAllowed = ['ceo@cetizionverifica.com'];
    try { await patch('mis_sender_address', 'ceo@cetizionverifica.com').expect(200); } finally { config.mail.fromAllowed = []; }

    // A sales user cannot change the sender at all.
    await as(owner)('patch', '/api/settings/mis_sender_account_id').send({ value: 'none' }).expect(403);
    await setting('mis_sender_account_id', String(shared.id));
    await setting('mis_sender_address', 'none'); await setting('mis_sender_name', 'none');
  });

  test('Send a test to me: to the caller only, by the reports\' path, once a minute; no run is recorded', async () => {
    const before = (await db.query('SELECT count(*)::int AS n FROM report_runs')).rows[0].n;
    sent.length = 0;
    const r = await as(admin)('post', '/api/mis-reports/sender/test').send({ to: 'someone@else.com' }).expect(200);
    assert.equal(r.body.data.status, 'sent', JSON.stringify(r.body.data));
    assert.equal(r.body.data.via, 'graph');
    assert.equal(r.body.data.from, 'sales@cetizionverifica.com');
    assert.deepEqual(sent[0].to, ['ada@example.com'], 'the body\'s address is ignored');
    assert.equal(sent[0].attachments[0].content.subarray(0, 4).toString(), '%PDF');
    await as(admin)('post', '/api/mis-reports/sender/test').expect(429);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM report_runs')).rows[0].n, before);
    await as(owner)('post', '/api/mis-reports/sender/test').expect(403);
  });
});
