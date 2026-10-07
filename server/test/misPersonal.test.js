import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The personal daily MIS's facts and checks (mis-report-sender-plan.md
 * §B3, §B4): what a person did, their mail, what waits on them and their
 * day ahead, each with an id; and what the AI writes from them, checked
 * against them before anything could be sent.
 *
 * The day reported on is "today" here (the report is for the morning
 * after), so the acts the test makes now are the person's acts of the day.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mis_personal_${process.pid}`;

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('the personal daily MIS: facts and checks', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let pool; let app; let misAi; let misPersonal;
  let admin; let sam; let hari;
  let mailbox; let day; let reportDay;
  let quotationNo; let idleQuotation;
  const liveReads = [];

  const as = (who) => (method, path) => request(app)[method](path).set('Cookie', who.cookie);
  const facts = () => misPersonal.personalFacts({ userId: sam.user.id, today: reportDay });

  async function mail({ direction, from, to = [], cc = [], subject, body = null, entity = null, entityId = null, company = null, minutesAgo = 30, trackerBy = null }) {
    const conv = `conv-${Math.random()}`;
    const { rows: [t] } = await db.query(
      `INSERT INTO email_threads (account_id, conversation_id, subject, entity, entity_id, company_id, last_message_at, message_count, last_direction)
       VALUES ($1, $2, $3, $4, $5, $6, now(), 1, $7) RETURNING id`, [mailbox.id, conv, subject, entity, entityId, company, direction]);
    const { rows: [m] } = await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, internet_message_id, direction, from_email, to_emails, cc_emails, subject, body_html, sent_at, sent_from_tracker_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - make_interval(mins => $11), $12) RETURNING id`,
      [mailbox.id, t.id, `p-${conv}`, `<${conv}@x>`, direction, from, to, cc, subject, body, minutesAgo, trackerBy]);
    return { thread: t.id, message: m.id };
  }
  async function reply(thread, { direction, from, to, subject, minutesAgo }) {
    const { rows: [m] } = await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, to_emails, subject, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(mins => $8)) RETURNING id`,
      [mailbox.id, thread, `p-${Math.random()}`, direction, from, to, subject, minutesAgo]);
    return m.id;
  }

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
    misAi = await import('../src/lib/misAi.js');
    misPersonal = await import('../src/lib/misPersonal.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    const { businessToday } = await import('../src/lib/businessDate.ts');
    const { createUser } = await import('../src/lib/users.js');
    const { loginLimiter } = await import('../src/auth/routes.js');
    day = businessToday();
    reportDay = addDays(day, 1);

    const signIn = async (email) => {
      for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1']) { try { loginLimiter.resetKey(ip); } catch { /* unknown key */ } }
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    const a = await createUser({ name: 'Ada Admin', email: 'ada@cetizion.com', password: PASSWORD, role: 'admin' }, db);
    const s = await createUser({ name: 'Sam Sales', email: 'sam@cetizion.com', password: PASSWORD, role: 'sales' }, db);
    const h = await createUser({ name: 'Hari HR', email: 'hari@cetizion.com', password: PASSWORD, role: 'hr' }, db);
    admin = { user: a, cookie: await signIn(a.email) };
    sam = { user: s, cookie: await signIn(s.email) };
    hari = { user: h, cookie: await signIn(h.email) };

    await db.query(`UPDATE settings SET value = 'cetizion.com' WHERE key = 'internal_email_domains'`);
    await db.query(`INSERT INTO settings (key, value) VALUES ('internal_email_domains', 'cetizion.com') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    ({ rows: [mailbox] } = await db.query(
      `INSERT INTO connected_accounts (username, provider, email, visibility, user_id, status) VALUES ('sam', 'test', 'sam@cetizion.com', 'subject', $1, 'active') RETURNING *`, [s.id]));
    misPersonal.deps.providerFor = () => ({
      async message(providerId) { liveReads.push(providerId); return { body_html: `<p>We attach the revised quotation for 2,95,000 (${providerId}).</p>`, subject: null }; },
      tokens: () => null,
    });

    // What Sam did today, through the app.
    const sm = as(sam);
    await sm('post', '/api/companies').send({ name: 'Infra Ltd' }).expect(201);
    const q = await sm('post', '/api/quotations').send({ client_name: 'Infra Ltd', service_quoted: 'EcoVadis', quotation_date: addDays(day, -30) }).expect(201);
    quotationNo = q.body.data.quotation_no;
    await sm('post', `/api/pipeline/${encodeURIComponent(quotationNo)}/move`).send({ stage_id: (await db.query(`SELECT id FROM pipeline_stages WHERE name = 'Negotiation'`)).rows[0].id }).expect(200);
    await sm('post', '/api/notes').send({ entity: 'quotation', entity_id: quotationNo, body: 'Client wants two audit dates' }).expect(201);
    const task = await sm('post', '/api/tasks').send({ entity: 'quotation', entity_id: quotationNo, title: 'Send PO copy' }).expect(201);
    await sm('patch', `/api/tasks/${task.body.data.id}`).send({ status: 'done' }).expect(200);
    await sm('post', '/api/tasks').send({ entity: 'quotation', entity_id: quotationNo, title: 'Call Mr Shah', assignee: 'Sam Sales', due_at: reportDay }).expect(201);

    // A quotation of Sam's nobody touched today, long overdue.
    ({ rows: [idleQuotation] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, service_quoted, quotation_date, sent_at, status, owner_user_id)
       VALUES ('CTZ/QT/IDLE/1', 'Delta Corp', 'Audit', $1, $1::date, 'Submitted', $2) RETURNING quotation_no`, [addDays(day, -40), s.id]));

    // Not Sam's acts: a job's, and the admin's.
    await db.query(`UPDATE quotations SET next_step = 'by a job' WHERE quotation_no = $1`, [quotationNo]);
    await as(admin)('post', '/api/companies').send({ name: 'Admin Co' }).expect(201);
  });

  after(async () => {
    await pool?.end();
    await db?.end();
  });

  test('the acts are the person\'s own, each once, at its time, with an id', async () => {
    const f = await facts();
    assert.equal(f.day, day);
    const kinds = f.acts.map((a) => a.kind);
    for (const k of ['record.created', 'quotation.stage_changed', 'note.added', 'task.created', 'task.completed']) assert.ok(kinds.includes(k), k);
    assert.ok(f.acts.every((a) => /^act:[a-z_]+:\d+$/.test(a.id) && /^\d{2}:\d{2}$/.test(a.time)));
    assert.equal(new Set(f.acts.map((a) => a.id)).size, f.acts.length, 'each act once');
    assert.ok(!f.acts.some((a) => a.detail?.name === 'Admin Co'), 'the admin\'s company is not Sam\'s');
    assert.ok(!f.acts.some((a) => JSON.stringify(a.detail).includes('by a job')), 'a job\'s change is nobody\'s');
    assert.equal(f.counts.records_created, kinds.filter((k) => k === 'record.created').length);
    assert.equal(f.counts.tasks_done, 1);
  });

  test('mail: sent and received with clients, internal-only, auto-replies and bulk left out, bodies read live and not stored', async () => {
    const sent = await mail({ direction: 'outbound', from: 'sam@cetizion.com', to: ['shah@infra.co.in'], subject: 'Revised quotation', entity: 'quotation', entityId: quotationNo, minutesAgo: 50 });
    const owed = await mail({ direction: 'inbound', from: 'buyer@delta.in', to: ['sam@cetizion.com'], subject: 'Need your rates', minutesAgo: 40 });
    await mail({ direction: 'outbound', from: 'sam@cetizion.com', to: ['ada@cetizion.com'], subject: 'Lunch?', minutesAgo: 35 });
    await mail({ direction: 'inbound', from: 'buyer@delta.in', to: ['sam@cetizion.com'], subject: 'Automatic reply: Need your rates', minutesAgo: 30 });
    await mail({ direction: 'inbound', from: 'newsletter@vendor.com', to: ['sam@cetizion.com'], subject: 'October offers', minutesAgo: 20 });
    const awaiting = await mail({ direction: 'inbound', from: 'ops@honor.in', to: ['sam@cetizion.com'], subject: 'Audit dates', minutesAgo: 25 });
    await reply(awaiting.thread, { direction: 'outbound', from: 'sam@cetizion.com', to: ['ops@honor.in'], subject: 'RE: Audit dates', minutesAgo: 10 });

    liveReads.length = 0;
    const f = await facts();
    assert.equal(f.counts.emails_sent, 2, 'the revised quotation and the reply on the audit dates');
    assert.equal(f.counts.emails_received, 2, 'the rates question and the audit dates');
    const reasons = Object.fromEntries(f.left_out.map((l) => [l.reason, l.count]));
    assert.equal(reasons['internal only'], 1);
    assert.equal(reasons['automatic reply'], 1);
    assert.equal(reasons['bulk mail'], 1);

    const s = f.sent.find((m) => m.id === `msg:${sent.message}`);
    assert.match(s.text, /2,95,000/);
    assert.deepEqual(s.record, { entity: 'quotation', id: quotationNo });
    assert.ok(liveReads.length >= 3, 'bodies read live from the mailbox');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM email_messages WHERE body_html IS NOT NULL');
    assert.equal(rows[0].n, 0, 'and never written back');

    assert.equal(f.threads.find((t) => t.thread_id === owed.thread).waiting_on, 'them');
    assert.equal(f.threads.find((t) => t.thread_id === awaiting.thread).waiting_on, 'client');
  });

  test('what waits on them is their overdue rows, with no action yesterday computed', async () => {
    const f = await facts();
    const idle = f.waiting.find((w) => w.key === `quotation:${idleQuotation.quotation_no}`);
    assert.ok(idle, 'the untouched overdue quotation');
    assert.equal(idle.no_action_yesterday, true);
    assert.equal(f.counts.overdue, f.waiting.length);
    const ahead = f.today_items.find((t) => t.title === 'Call Mr Shah');
    assert.ok(ahead && /^task:\d+$/.test(ahead.ref));
  });

  /** A report that covers everything, as a well-behaved model would write it. */
  function goodReport(f) {
    return {
      summary: { text: `Sam sent ${f.counts.emails_sent} client emails and completed ${f.counts.tasks_done} task.`, counts: { ...f.counts } },
      actions: [...f.acts, ...f.sent].map((x) => ({ at: x.time, text: `Did ${x.kind || 'an email'}`, refs: [x.id] })),
      mailbox: {
        highlights: [], commitments: [], awaiting: [],
        owed_replies: f.threads.filter((t) => t.waiting_on === 'them').map((t) => ({ thread_id: t.thread_id, text: 'Reply with the rates' })),
      },
      not_in_tracker: [],
      waiting: f.waiting.map((w) => ({ key: w.key, text: 'Follow up with the client', no_action_yesterday: false })),
      today: f.today_items.map((t) => ({ ref: t.ref, text: 'Call Mr Shah' })),
      for_management: ['A steady day.'],
    };
  }

  test('a report that covers everything passes, with code\'s "no action yesterday"', async () => {
    const f = await facts();
    const checked = await misAi.checkPersonal(goodReport(f), f);
    assert.equal(checked.failed, null);
    assert.deepEqual(checked.missing, []);
    const idle = checked.report.waiting.find((w) => w.key === `quotation:${idleQuotation.quotation_no}`);
    assert.equal(idle.no_action_yesterday, true, 'the model said false; code decides');
  });

  test('unknown ids, invented numbers and wrong times are dropped, and what they leave out is missing', async () => {
    const f = await facts();
    const r = goodReport(f);
    const [first, second, third] = r.actions;
    first.refs = ['act:activity_log:999999'];
    second.text = 'Quoted 12,00,000 to the client';
    third.at = '03:33';
    const checked = await misAi.checkPersonal(r, f);
    assert.equal(checked.dropped.filter((d) => d.section === 'actions').length, 3);
    assert.equal(checked.missing.length, 3);
    assert.ok(checked.missing.every((id) => /^(act|msg):/.test(id)));
  });

  test('wrong counts fail the report', async () => {
    const f = await facts();
    const r = goodReport(f);
    r.summary.counts.emails_sent += 1;
    const checked = await misAi.checkPersonal(r, f);
    assert.match(checked.failed, /counts do not match: emails_sent/);
  });

  test('owed replies are code\'s: a thread awaiting the client is not owed, and an owed one left out is missing', async () => {
    const f = await facts();
    const r = goodReport(f);
    const awaiting = f.threads.find((t) => t.waiting_on === 'client');
    r.mailbox.owed_replies = [{ thread_id: awaiting.thread_id, text: 'Reply to Honor' }];
    const checked = await misAi.checkPersonal(r, f);
    assert.ok(checked.dropped.some((d) => d.section === 'owed_replies'));
    assert.ok(checked.missing.some((k) => k.startsWith('thread:')));
  });

  test('"in email, not in the tracker" keeps only what the tracker lacks', async () => {
    const f = await facts();
    const r = goodReport(f);
    const t = f.threads[0];
    r.not_in_tracker = [
      { thread_id: t.thread_id, kind: 'quotation', ref: quotationNo, client: 'Infra Ltd', text: 'Quotation sent, not recorded' },
      { thread_id: t.thread_id, kind: 'po', ref: null, client: 'Unknown Buyer Pvt Ltd', text: 'PO received, not entered' },
      { thread_id: t.thread_id, kind: 'gossip', text: 'x' },
    ];
    const checked = await misAi.checkPersonal(r, f);
    assert.deepEqual(checked.report.not_in_tracker.map((n) => n.client), ['Unknown Buyer Pvt Ltd']);
    assert.ok(checked.dropped.some((d) => d.why === 'it is in the tracker'));
    assert.ok(checked.dropped.some((d) => d.why === 'an unknown kind'));
  });

  test('writePersonal re-asks once for what was missed, and fails a report that still misses it', async () => {
    const f = await facts();
    const full = goodReport(f);
    const short = { ...full, actions: full.actions.slice(1) };
    const answers = [short, full];
    misAi.deps.chat = async () => answers.shift();
    const ok = await misAi.writePersonal(f);
    assert.equal(ok.ok, true, ok.why);
    assert.equal(ok.checks.asked, 2);

    misAi.deps.chat = async () => short;
    const bad = await misAi.writePersonal(f);
    assert.equal(bad.ok, false);
    assert.match(bad.why, /left out 1 required item/);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM email_ai_calls WHERE purpose = 'mis_personal'`);
    assert.equal(rows[0].n, 4);
  });

  test('the personal reports have their own ceiling, apart from the readers\'', async () => {
    const { aiCallsToday } = await import('../src/lib/mailbox/autoEnquiry.js');
    const before = await aiCallsToday();
    await db.query(`INSERT INTO email_ai_calls (purpose) VALUES ('mis_personal')`);
    assert.equal(await aiCallsToday(), before, 'not counted against the readers');
    await db.query(`UPDATE settings SET value = '0' WHERE key = 'personal_mis_ai_limit'`);
    const f = await facts();
    const out = await misAi.writePersonal(f);
    assert.equal(out.ok, false);
    assert.match(out.why, /ceiling \(0\) is reached/);
    await db.query(`UPDATE settings SET value = '30' WHERE key = 'personal_mis_ai_limit'`);
  });

  test('the preview shows an admin the facts beside the AI\'s report, without the person\'s mail text', async () => {
    const f = await facts();
    misAi.deps.chat = async () => goodReport(f);
    const people = await as(admin)('get', '/api/mis-reports/personal/people').expect(200);
    const row = people.body.data.find((p) => p.id === sam.user.id);
    assert.equal(row.state, 'ready');
    assert.ok(!people.body.data.some((p) => p.id === hari.user.id), 'HR is not on the list');

    const plain = await as(admin)('get', `/api/mis-reports/personal/${sam.user.id}/preview?date=${reportDay}`).expect(200);
    assert.equal(plain.body.data.ai, null, 'no AI call unless asked');
    assert.ok(plain.body.data.facts.sent.length);
    assert.ok(plain.body.data.facts.sent.every((m) => m.text === null), 'the text stays the person\'s');
    assert.equal(plain.body.data.facts.redacted, true);

    const withAi = await as(admin)('get', `/api/mis-reports/personal/${sam.user.id}/preview?date=${reportDay}&ai=1`).expect(200);
    assert.equal(withAi.body.data.ai.ok, true, withAi.body.data.ai.why);
    assert.ok(withAi.body.data.ai.report.actions.length);

    await as(sam)('get', `/api/mis-reports/personal/${sam.user.id}/preview`).expect(403);
  });

  test('an act on a user names the person, not their id', async () => {
    await as(admin)('patch', `/api/users/${hari.user.id}`).send({ name: 'Hari Prasad' }).expect(200);
    const f = await misPersonal.personalFacts({ userId: admin.user.id, today: reportDay });
    const edit = f.acts.find((a) => a.entity === 'user' && a.entity_id === String(hari.user.id));
    assert.ok(edit, JSON.stringify(f.acts.map((a) => a.kind)));
    assert.equal(edit.record_name, 'Hari Prasad');
    assert.equal(misAi.personalInput(f).acts.find((a) => a.id === edit.id).record, 'user Hari Prasad');
    assert.equal(f.acts.find((a) => a.entity === 'company').record_name, null);
  });

  test('the ceiling setting is validated', async () => {
    await as(admin)('patch', '/api/settings/personal_mis_ai_limit').send({ value: 'lots' }).expect(422);
    await as(admin)('patch', '/api/settings/personal_mis_ai_limit').send({ value: '40' }).expect(200);
  });
});
