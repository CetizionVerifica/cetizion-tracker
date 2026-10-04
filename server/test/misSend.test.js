import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Sending the scheduled reports (docs/mis-reports-plan.md §8, "Sending"):
 * every run is recorded, nothing leaves in log mode, a period is sent once
 * by the schedule, a person can send again, a mailbox that cannot send
 * falls back or fails loudly, and the routes are an admin's.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mis_send_${process.pid}`;
const TODAY = '2026-10-05';

describe('sending the scheduled reports', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let pool; let app; let agent; let misSend; let mail;
  let mailbox;
  const sent = [];

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

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    delete process.env.SMTP_HOST;
    // No real model: the AI path is exercised with a fake chat below.
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    misSend = await import('../src/lib/misSend.js');
    mail = await import('../src/lib/mail.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    const { rows: [a] } = await db.query(`INSERT INTO connected_accounts (username, provider, email, is_shared) VALUES ('admin', 'test', 'sales@cetizionverifica.com', true) RETURNING *`);
    mailbox = a;
    // A fake mailbox provider: records what it was asked to send, or refuses.
    misSend.deps.providerFor = (account) => ({ send: async (msg) => { if (account.email.startsWith('broken')) throw new Error('Graph 401: token expired'); sent.push({ account: account.email, ...msg }); } });
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'mis_to'`, ['md@cetizionverifica.com, head@cetizionverifica.com']);
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'mis_sender_account_id'`, [String(a.id)]);
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const runs = async () => (await db.query('SELECT * FROM report_runs ORDER BY id')).rows;

  test('the sandbox checks each recipient, not the joined string', () => {
    const allowlist = ['@cetizionverifica.com'];
    assert.equal(mail.decideDelivery({ to: 'a@cetizionverifica.com, b@cetizionverifica.com', mode: 'sandbox', allowlist, configured: true }).deliver, true);
    const refused = mail.decideDelivery({ to: 'a@cetizionverifica.com, client@elsewhere.com', mode: 'sandbox', allowlist, configured: true });
    assert.equal(refused.deliver, false);
    assert.match(refused.reason, /client@elsewhere\.com is not on EMAIL_ALLOWLIST/);
  });

  test('the schedule does nothing while a report is off', async () => {
    const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'schedule' });
    assert.equal(r.status, 'skipped');
    assert.match(r.skipped, /switched off/);
    assert.equal((await runs()).length, 0, 'nothing recorded for a report that is off');
  });

  test('in log mode a scheduled run composes and logs the report, records it as not delivered, and tells admins', async () => {
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'mis_daily_enabled'`);
    const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'schedule' });
    assert.equal(r.status, 'skipped', JSON.stringify(r));
    assert.equal(r.sent_via, 'log');
    assert.match(r.error, /Composed and logged only: EMAIL_MODE=log/);
    assert.equal(String(r.period_from).slice(0, 10), '2026-10-04');
    assert.deepEqual(r.recipients, ['md@cetizionverifica.com', 'head@cetizionverifica.com']);
    assert.ok(r.pages >= 1, 'the PDF was built; the daily briefing has no page cap (docs/mis-briefing-fix-plan.md §3)');
    assert.equal(sent.length, 0, 'the mailbox was not asked to send');
    const { rows: [log] } = await db.query('SELECT * FROM email_log WHERE id = $1', [r.email_log_id]);
    assert.equal(log.status, 'suppressed');
    assert.equal(log.template, 'mis_daily');
    assert.equal(log.reason, 'EMAIL_MODE=log');
    assert.match(log.subject, /Daily Sales Briefing – 04 Oct 2026/);
    assert.equal(log.to_email, 'md@cetizionverifica.com, head@cetizionverifica.com');
    const { rows: alerts } = await db.query(`SELECT title FROM notifications WHERE kind = 'alert' AND title LIKE '%composed but not delivered%'`);
    assert.equal(alerts.length, 1, 'admins are told once a day');
  });

  test('a period is sent once by the schedule; a logged-only run does not count; Run now on the Jobs page keeps the guards; Send now sends again', async () => {
    const { config } = await import('../src/config.js');
    config.mail.mode = 'live'; // the fake mailbox provider "sends" from here on
    const first = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'schedule' });
    assert.equal(first.status, 'sent', 'the logged-only run above did not use up the period');
    assert.equal(first.sent_via, 'graph');
    const again = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'schedule' });
    assert.equal(again.status, 'skipped');
    assert.match(again.skipped, /already sent for 2026-10-04/);
    // The Jobs page's Run now passes a username, but it is still the job: the guards apply.
    const viaJob = await misSend.runDailyBriefing({ startedBy: 'shyam', today: TODAY });
    assert.equal(viaJob.status, 'skipped', JSON.stringify(viaJob));
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'mis_weekly_enabled'`);
    const off = await misSend.runWeeklyMis({ startedBy: 'shyam', today: TODAY });
    assert.match(off.skipped, /switched off/);
    // Send now is a decision: it sends, and says who.
    const byHand = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'shyam', guarded: false });
    assert.equal(byHand.status, 'sent');
    assert.equal(byHand.triggered_by, 'shyam');
    assert.equal((await runs()).filter((x) => x.status === 'sent').length, 2);
    sent.length = 0;
  });

  test('with delivery on, the report leaves from the sales mailbox with the PDF attached', async () => {
    const { config } = await import('../src/config.js');
    const before = config.mail.mode;
    config.mail.mode = 'live';
    try {
      const r = await misSend.runReport('weekly_mis', { today: TODAY, startedBy: 'shyam' });
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(r.sent_via, 'graph');
      assert.equal(sent.length, 1, 'one send, from the fake mailbox');
      assert.equal(sent[0].account, 'sales@cetizionverifica.com');
      assert.deepEqual(sent[0].to, ['md@cetizionverifica.com', 'head@cetizionverifica.com']);
      assert.equal(sent[0].attachments.length, 1);
      assert.equal(sent[0].attachments[0].name, 'Sales_MIS_Report_28Sep-04Oct2026.pdf');
      assert.equal(sent[0].attachments[0].content.subarray(0, 4).toString(), '%PDF');
      const { rows: [log] } = await db.query('SELECT status, provider_message_id FROM email_log WHERE id = $1', [r.email_log_id]);
      assert.equal(log.status, 'sent');
      assert.match(log.provider_message_id, /^graph:sales@/);
    } finally { config.mail.mode = before; }
  });

  test('a mailbox that cannot send, with no SMTP to fall back to, is a failed run and an alert', async () => {
    const { config } = await import('../src/config.js');
    const before = { mode: config.mail.mode, host: config.mail.host };
    // Live, and no SMTP server to fall back to (the developer's .env may name one).
    config.mail.mode = 'live'; config.mail.host = '';
    await db.query(`UPDATE connected_accounts SET email = 'broken@cetizionverifica.com' WHERE id = $1`, [mailbox.id]);
    try {
      const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'shyam' });
      assert.equal(r.status, 'failed');
      assert.match(r.error, /Graph 401/);
      assert.match(r.error, /no fallback/);
      const { rows: alerts } = await db.query(`SELECT title, body FROM notifications WHERE kind = 'alert' AND title LIKE '%Daily Sales Briefing%'`);
      assert.ok(alerts.length >= 1, 'admins are told');
    } finally {
      config.mail.mode = before.mode; config.mail.host = before.host;
      await db.query(`UPDATE connected_accounts SET email = 'sales@cetizionverifica.com' WHERE id = $1`, [mailbox.id]);
    }
  });

  test('no recipients is a failed run that says so', async () => {
    await db.query(`UPDATE settings SET value = 'none' WHERE key = 'mis_to'`);
    const r = await misSend.runReport('weekly_mis', { today: TODAY, startedBy: 'shyam' });
    assert.equal(r.status, 'failed');
    assert.match(r.error, /No recipients/);
    await db.query(`UPDATE settings SET value = 'md@cetizionverifica.com' WHERE key = 'mis_to'`);
  });

  test('the routes: preview, PDF, send and the run history, for an admin', async () => {
    const preview = await agent.get(`/api/mis-reports/weekly_mis/preview?date=${TODAY}`).expect(200);
    assert.deepEqual(preview.body.data.period, { from: '2026-09-28', to: '2026-10-04' });
    assert.match(preview.body.data.email.subject, /Weekly Sales MIS/);
    assert.equal(preview.body.data.file_name, 'Sales_MIS_Report_28Sep-04Oct2026.pdf');

    const pdf = await agent.get(`/api/mis-reports/daily_briefing/preview.pdf?date=${TODAY}`).expect(200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.ok(Number(pdf.headers['x-page-count']) >= 1, 'the page count is sent; the daily briefing has no page cap');

    await agent.get('/api/mis-reports/monthly/preview').expect(404);
    await agent.get('/api/mis-reports/daily_briefing/preview?date=yesterday').expect(422);

    const send = await agent.post('/api/mis-reports/daily_briefing/send').send({ date: TODAY }).expect(200);
    assert.equal(send.body.data.status, 'sent', JSON.stringify(send.body.data));
    assert.equal(send.body.data.triggered_by, 'admin');

    const list = await agent.get('/api/mis-reports/runs').expect(200);
    assert.ok(list.body.data.length >= 5);
    assert.equal(list.body.data[0].id, send.body.data.id, 'newest first');

    const noPdf = await agent.get(`/api/mis-reports/runs/${send.body.data.id}/pdf`);
    assert.equal(noPdf.status, 404, 'no document storage in tests, so no PDF kept');
  });

  test('with an AI, the briefing carries its highlights, checked; at the ceiling it goes without them', async () => {
    const misAi = await import('../src/lib/misAi.js');
    // A thread from yesterday in the shared mailbox, stored in full.
    await db.query(`UPDATE connected_accounts SET visibility = 'share_everything' WHERE id = $1`, [mailbox.id]);
    const { rows: [t] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, first_message_at, last_message_at, message_count, last_direction)
       VALUES ($1, 'conv-ai', 'Revised scope for 3 plants', '2026-10-04 05:00+00', '2026-10-04 05:00+00', 1, 'inbound') RETURNING id`, [mailbox.id]);
    await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, from_name, to_emails, subject, body_html, sent_at)
       VALUES ($1, $2, 'm-ai', 'inbound', 'ravi@acme.com', 'Ravi', ARRAY['sales@cetizionverifica.com'], 'Revised scope for 3 plants', '<p>Please revise the quotation for 3 plants, budget about 4,50,000.</p>', '2026-10-04 05:00+00')`,
      [mailbox.id, t.id]);
    const asked = [];
    misAi.deps.chat = async (system, user) => {
      asked.push({ system, user });
      return { highlights: [
        { thread_id: t.id, client: 'Acme', summary: 'Wants the quotation revised for 3 plants, budget about 4,50,000.', action: 'Send the revision', owner: 'Priya' },
        { thread_id: t.id, client: 'Acme', summary: 'Mentioned 7 plants.', action: null },
      ], actions_wording: [] };
    };
    try {
      const r = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'shyam' });
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(r.ai_used, true);
      assert.equal(r.ai.highlights, 1, 'the summary with a figure the thread lacks is dropped');
      assert.equal(asked.length, 1);
      assert.match(asked[0].user, /Revised scope for 3 plants/);
      assert.match(asked[0].system, /never invent a number/);
      const { rows: [log] } = await db.query('SELECT body_text FROM email_log WHERE id = $1', [r.email_log_id]);
      assert.match(log.body_text, /Acme: Wants the quotation revised for 3 plants/);
      const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM email_ai_calls WHERE purpose = 'mis_daily'`);
      assert.equal(n, 1, 'counted against the readers\' ceiling');

      // The ceiling reached: the report still goes, on the record-based highlights.
      await db.query(`UPDATE settings SET value = '1' WHERE key = 'auto_enquiry_daily_ai_limit'`);
      const r2 = await misSend.runReport('daily_briefing', { today: TODAY, startedBy: 'shyam' });
      assert.equal(r2.status, 'sent');
      assert.equal(r2.ai_used, false);
      assert.match(r2.ai.why, /ceiling/);
      assert.equal(asked.length, 1, 'the model was not asked again');
    } finally {
      misAi.deps.chat = null;
      await db.query(`UPDATE settings SET value = '5000' WHERE key = 'auto_enquiry_daily_ai_limit'`);
    }
  });

  test('the jobs are registered on the plan\'s schedule', async () => {
    const { JOBS } = await import('../src/jobs.js');
    assert.equal(JOBS['reports.daily_briefing'].cron, '56 8 * * *');
    assert.equal(JOBS['reports.weekly_mis'].cron, '54 8 * * 1');
  });
});
