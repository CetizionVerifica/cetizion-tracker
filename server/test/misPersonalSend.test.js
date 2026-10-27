import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The personal daily MIS goes out (mis-report-sender-plan.md §B1, §B2,
 * §B5, §B6): from each person's own mailbox to management with the person
 * copied, once per person per day, never on a day off, never when the AI
 * could not write it; the briefing's Team reports line; the admin's Send
 * now and exempt switch; and each person's own reports and notice.
 *
 * "Today" is Wednesday 7 October 2026, so the reports are for Tuesday 6.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mis_personal_send_${process.pid}`;
const TODAY = '2026-10-07';
const DAY = '2026-10-06';

/** A model that covers every fact it is given, as the checks require. */
async function fakeChat(system, user) {
  const i = JSON.parse(user);
  return {
    summary: { text: `${i.person} had a working day.`, counts: i.counts },
    actions: [...i.acts.map((a) => ({ at: a.time, text: 'Worked on a record', refs: [a.id] })), ...i.sent.map((m) => ({ at: m.time, text: 'Emailed the client', refs: [m.id] }))],
    mailbox: { highlights: [], commitments: [], awaiting: [], owed_replies: i.threads.filter((t) => t.next_reply_from === 'them').map((t) => ({ thread_id: t.thread_id, text: 'Reply to the client' })) },
    not_in_tracker: [],
    waiting: i.waiting.map((w) => ({ key: w.key, text: 'Follow up' })),
    today: i.today.map((t) => ({ ref: t.ref, text: 'Do it' })),
    for_management: ['A steady day.'],
  };
}

describe('the personal daily MIS goes out', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let pool; let app; let misSend; let misAi; let misPersonal; let config; let mail;
  let admin; let sam; let pia; let ed; let hari;
  let samBox;
  const sent = [];

  const as = (who) => (method, path) => request(app)[method](path).set('Cookie', who.cookie);
  const runs = async (userId) => (await db.query(`SELECT * FROM report_runs WHERE kind = 'personal_daily' AND ($1::int IS NULL OR user_id = $1) ORDER BY id`, [userId ?? null])).rows;
  const alerts = async (like) => (await db.query(`SELECT title FROM notifications WHERE title LIKE $1`, [like])).rows;
  const live = async (fn) => {
    const before = { mode: config.mail.mode, host: config.mail.host, from: config.mail.from };
    config.mail.mode = 'live';
    try { return await fn(); } finally { Object.assign(config.mail, before); }
  };

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
    delete process.env.SMTP_HOST;
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    ({ config } = await import('../src/config.js'));
    misSend = await import('../src/lib/misSend.js');
    misAi = await import('../src/lib/misAi.js');
    misPersonal = await import('../src/lib/misPersonal.js');
    mail = await import('../src/lib/mail.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    config.mail.host = '';
    const { createUser } = await import('../src/lib/users.js');
    const { loginLimiter } = await import('../src/auth/routes.js');

    const signIn = async (email) => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) { try { loginLimiter.resetKey(ip); } catch { /* unknown key */ } }
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    const make = async (name, email, role) => { const user = await createUser({ name, email, password: PASSWORD, role }, db); return { user, cookie: await signIn(email) }; };
    admin = await make('Ada Admin', 'ada@cetizion.com', 'admin');
    sam = await make('Sam Sales', 'sam@cetizion.com', 'sales');
    pia = await make('Pia Sales', 'pia@cetizion.com', 'sales');
    ed = await make('Ed Director', 'ed@cetizion.com', 'sales');
    hari = await make('Hari HR', 'hari@cetizion.com', 'hr');

    await db.query(`INSERT INTO settings (key, value) VALUES ('internal_email_domains', 'cetizion.com') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    await db.query(`UPDATE settings SET value = 'md@cetizion.com' WHERE key = 'mis_to'`);
    await db.query(`UPDATE settings SET value = 'head@cetizion.com' WHERE key = 'mis_cc'`);
    ({ rows: [samBox] } = await db.query(
      `INSERT INTO connected_accounts (username, provider, email, visibility, user_id, status) VALUES ('sam', 'test', 'sam@cetizion.com', 'subject', $1, 'active') RETURNING *`, [sam.user.id]));
    await db.query(`INSERT INTO connected_accounts (username, provider, email, visibility, user_id, status) VALUES ('ed', 'test', 'ed@cetizion.com', 'subject', $1, 'active')`, [ed.user.id]);
    await db.query('UPDATE users SET daily_mis = false WHERE id = $1', [ed.user.id]);

    // Sam emailed a client on the day.
    const { rows: [t] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, last_message_at, message_count, last_direction)
       VALUES ($1, 'c-1', 'Revised quotation', $2, 1, 'outbound') RETURNING id`, [samBox.id, `${DAY} 11:00+05:30`]);
    await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, internet_message_id, direction, from_email, to_emails, subject, sent_at)
       VALUES ($1, $2, 'p-1', '<c-1@x>', 'outbound', 'sam@cetizion.com', ARRAY['shah@infra.com'], 'Revised quotation', $3)`, [samBox.id, t.id, `${DAY} 11:00+05:30`]);

    misPersonal.deps.providerFor = () => ({ async message() { return { body_html: '<p>Please find the revised quotation.</p>' }; }, tokens: () => null });
    misSend.deps.providerFor = (account) => ({ send: async (msg) => { if (account.email.startsWith('broken')) throw new Error('Graph 401: token expired'); sent.push({ account: account.email, ...msg }); } });
    misAi.deps.chat = fakeChat;
  });

  after(async () => {
    misAi.deps.chat = null;
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  test('nothing goes while the feature is off', async () => {
    const r = await misSend.runPersonalDaily({ today: TODAY });
    assert.match(r.skipped, /switched off/);
    assert.equal((await runs()).length, 0);
  });

  test('the people: sales and admin, an exempt one listed as exempt, HR left out', async () => {
    const people = await misPersonal.personalPeople(db);
    const state = Object.fromEntries(people.map((p) => [p.name, p.state]));
    assert.deepEqual(state, { 'Ada Admin': 'no_mailbox', 'Ed Director': 'exempt', 'Pia Sales': 'no_mailbox', 'Sam Sales': 'ready' });
  });

  test('in log mode the run composes Sam\'s report, logs it, and does not count it as sent', async () => {
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'personal_mis_enabled'`);
    const r = await misSend.runPersonalDaily({ today: TODAY });
    assert.equal(r.day, DAY);
    const byName = Object.fromEntries(r.runs.map((x) => [x.person, x]));
    assert.equal(byName['Sam Sales'].status, 'skipped');
    assert.match(byName['Sam Sales'].error, /Composed and logged only/);
    assert.match(byName['Pia Sales'].skipped, /no mailbox connected/);
    assert.match(byName['Ed Director'].skipped, /exempt/);
    assert.equal(sent.length, 0);
    const [run] = await runs(sam.user.id);
    assert.equal(run.sent_via, 'log');
    assert.equal(run.ai_checks.asked, 1);
  });

  test('with delivery on, it leaves from Sam\'s own mailbox to management, Sam copied, the PDF attached, once', async () => {
    await live(async () => {
      const r = await misSend.runPersonal(sam.user.id, { today: TODAY });
      assert.equal(r.status, 'sent', JSON.stringify(r));
      assert.equal(r.sent_via, 'graph');
      assert.equal(r.user_id, sam.user.id);
      assert.equal(sent.length, 1);
      const [m] = sent;
      assert.equal(m.account, 'sam@cetizion.com');
      assert.deepEqual(m.to, ['md@cetizion.com']);
      assert.deepEqual(m.cc, ['head@cetizion.com', 'sam@cetizion.com']);
      assert.equal(m.subject, 'Daily MIS · Sam Sales · Tue 6 Oct 2026');
      assert.equal(m.attachments[0].name, 'Daily_MIS_Sam_Sales_2026-10-06.pdf');
      assert.equal(m.attachments[0].content.subarray(0, 4).toString(), '%PDF');
      assert.match(m.html, /Emailed the client/);
      assert.match(m.html, /Actions taken/);
      assert.equal(m.from, undefined, 'no Send As: the mailbox\'s own address');

      const again = await misSend.runPersonal(sam.user.id, { today: TODAY });
      assert.equal(again.status, 'skipped');
      assert.match(again.skipped, /already sent/);
      assert.equal(sent.length, 1);
    });
  });

  test('the briefing\'s Team reports line says whose went and why the others did not', async () => {
    const t = await misPersonal.teamReports(db, DAY);
    assert.equal(t.sent, 1);
    assert.deepEqual(t.not_sent, [{ name: 'Ada Admin', why: 'no mailbox connected' }, { name: 'Pia Sales', why: 'no mailbox connected' }]);
    const built = await misSend.buildReport('daily_briefing', { today: TODAY });
    assert.match(built.email.text, /Team reports: Sent: 1 · Not sent: Ada Admin \(no mailbox connected\), Pia Sales \(no mailbox connected\)/);
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'personal_mis_enabled'`);
    assert.equal(await misPersonal.teamReports(db, DAY), null, 'not while the feature is off');
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'personal_mis_enabled'`);
  });

  test('a report the AI cannot write is not sent; only the last try tells admins', async () => {
    misAi.deps.chat = null;
    try {
      await live(async () => {
        const first = await misSend.runPersonal(sam.user.id, { today: '2026-10-08', final: false });
        assert.equal(first.status, 'failed');
        assert.match(first.error, /Not sent: no AI configured/);
        assert.equal((await alerts('%Daily MIS for Sam Sales not sent%')).length, 0, 'the 08:40 try does not alert');
        const last = await misSend.runPersonal(sam.user.id, { today: '2026-10-08', final: true });
        assert.equal(last.status, 'failed');
        assert.equal((await alerts('%Daily MIS for Sam Sales not sent%')).length, 1);
        assert.equal(sent.length, 1, 'nothing more went');
      });
    } finally { misAi.deps.chat = fakeChat; }
    assert.equal(misSend.isFinalAttempt(new Date('2026-10-08T04:10:00Z')), true, '09:40 IST');
    assert.equal(misSend.isFinalAttempt(new Date('2026-10-08T03:40:00Z')), false, '09:10 IST');
  });

  test('a mailbox Graph refuses goes by SMTP under the person\'s name, and admins are told', async () => {
    await db.query(`UPDATE connected_accounts SET email = 'broken-sam@cetizion.com' WHERE id = $1`, [samBox.id]);
    const smtp = [];
    mail.deps.transport = { sendMail: async (m) => { smtp.push(m); return { messageId: 'smtp-1' }; } };
    try {
      await live(async () => {
        config.mail.host = 'smtp.test'; config.mail.from = 'Tracker <tracker@cetizion.com>';
        const r = await misSend.runPersonal(sam.user.id, { today: '2026-10-09' });
        assert.equal(r.status, 'sent', JSON.stringify(r));
        assert.equal(r.sent_via, 'smtp');
        assert.match(r.error, /Went by SMTP: .*token expired/);
        assert.deepEqual(smtp[0].from, { name: 'Sam Sales · Daily MIS', address: 'tracker@cetizion.com' });
        assert.equal((await alerts('%Daily MIS for Sam Sales went by SMTP%')).length, 1);
      });
    } finally {
      mail.deps.transport = null;
      await db.query(`UPDATE connected_accounts SET email = 'sam@cetizion.com' WHERE id = $1`, [samBox.id]);
    }
  });

  test('no report for a weekend, a holiday or a day of leave', async () => {
    assert.match((await misSend.runPersonalDaily({ today: '2026-10-05' })).skipped, /weekend/);
    assert.match((await misSend.runPersonalDaily({ today: '2026-10-03' })).skipped, /holiday/);
    const { rows: [s] } = await db.query(`INSERT INTO staff (name, email) VALUES ('Sam Sales', 'sam@cetizion.com') RETURNING id`);
    await db.query(`INSERT INTO staff_leave (staff_id, starts_on, ends_on) VALUES ($1, '2026-10-12', '2026-10-12')`, [s.id]);
    const r = await misSend.runPersonal(sam.user.id, { today: '2026-10-13' });
    assert.equal(r.status, 'skipped');
    assert.match(r.skipped, /on leave/);
  });

  test('Send now: an admin sends one person\'s report; nobody else may', async () => {
    const res = await live(() => as(admin)('post', `/api/mis-reports/personal/${sam.user.id}/send`).send({ date: TODAY }).expect(200));
    assert.equal(res.body.data.status, 'sent', JSON.stringify(res.body.data));
    assert.equal(res.body.data.triggered_by, 'ada@cetizion.com');
    await as(sam)('post', `/api/mis-reports/personal/${sam.user.id}/send`).send({}).expect(403);
    await as(admin)('post', `/api/mis-reports/personal/${hari.user.id}/send`).send({}).expect(404);
    const history = await as(admin)('get', `/api/mis-reports/runs?kind=personal_daily&user_id=${sam.user.id}`).expect(200);
    assert.ok(history.body.data.length >= 3);
    assert.ok(history.body.data.every((r) => r.user_id === sam.user.id && r.person === 'Sam Sales'));
    await as(admin)('get', '/api/mis-reports/runs?kind=nonsense').expect(422);
  });

  test('the personal PDF preview is the AI\'s report; one that fails has none', async () => {
    const res = await as(admin)('get', `/api/mis-reports/personal/${sam.user.id}/preview.pdf?date=${TODAY}`).expect(200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.match(res.headers['content-disposition'], /Daily_MIS_Sam_Sales_2026-10-06\.pdf/);
    misAi.deps.chat = null;
    try {
      const refused = await as(admin)('get', `/api/mis-reports/personal/${sam.user.id}/preview.pdf?date=${TODAY}`).expect(422);
      assert.match(refused.body.error.message, /no AI configured/);
    } finally { misAi.deps.chat = fakeChat; }
  });

  test('My daily MIS: each person sees their own sent reports and nobody else\'s', async () => {
    const mine = await as(sam)('get', '/api/mis-reports/mine').expect(200);
    assert.ok(mine.body.data.runs.length >= 1);
    assert.ok(mine.body.data.runs.every((r) => r.status === 'sent'));
    const theirs = await as(pia)('get', '/api/mis-reports/mine').expect(200);
    assert.equal(theirs.body.data.runs.length, 0);
    // Sam's run, asked for by Pia: not found, as if it never was.
    await as(pia)('get', `/api/mis-reports/mine/${mine.body.data.runs[0].id}/pdf`).expect(404);
    await as(hari)('get', '/api/mis-reports/mine').expect(403);
  });

  test('the notice: shown once to a person whose report is sent, not to the exempt', async () => {
    const before = await as(sam)('get', '/api/mis-reports/mine').expect(200);
    assert.equal(before.body.data.notice.show, true);
    assert.match(before.body.data.notice.text, /sent to management from your mailbox, copied to you/);
    const seen = await as(sam)('post', '/api/mis-reports/mine/notice').send({}).expect(200);
    assert.equal(seen.body.data.show, false);
    assert.ok(seen.body.data.seen_at);
    const exempt = await as(ed)('get', '/api/mis-reports/mine').expect(200);
    assert.equal(exempt.body.data.notice.applies, false);
    const noMailbox = await as(pia)('get', '/api/mis-reports/mine').expect(200);
    assert.equal(noMailbox.body.data.notice.show, false);
  });

  test('only an admin exempts someone, and it is logged', async () => {
    const res = await as(admin)('patch', `/api/users/${pia.user.id}`).send({ daily_mis: false }).expect(200);
    assert.equal(res.body.data.daily_mis, false);
    const { rows: [log] } = await db.query(`SELECT metadata FROM activity_log WHERE entity_type = 'user' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [String(pia.user.id)]);
    assert.deepEqual(log.metadata.changed_fields, ['daily_mis']);
    assert.equal(log.metadata.new_daily_mis, false);
    await as(sam)('patch', `/api/users/${sam.user.id}`).send({ daily_mis: false }).expect(403);
    const list = await as(admin)('get', '/api/users').expect(200);
    assert.equal(list.body.data.find((u) => u.id === pia.user.id).daily_mis, false);
  });

  test('the switch is validated, and the jobs are scheduled Tuesday to Saturday', async () => {
    await as(admin)('patch', '/api/settings/personal_mis_enabled').send({ value: 'maybe' }).expect(422);
    await as(admin)('patch', '/api/settings/personal_mis_enabled').send({ value: 'TRUE' }).expect(200);
    const { JOBS } = await import('../src/jobs.js');
    assert.equal(JOBS['reports.personal_daily'].cron, '40 8 * * 2-6');
    assert.equal(JOBS['reports.personal_daily_retry'].cron, '10,40 9 * * 2-6');
  });
});
