import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * New enquiries from email, automatically (docs/email-enquiries-plan.md §8).
 *
 * Mail goes in through the in-memory `test` mailbox provider and the real
 * sync, exactly as Microsoft 365 mail does. No AI key is configured, so the
 * rules decide, except where a test hands decide() a fake AI.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `email_enquiries_${process.pid}`;

let app; let agent; let db; let sync; let auto;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;
const at = (daysAgo, hour = 10) => new Date(Date.now() - daysAgo * 864e5 + hour * 3600e3 - 10 * 3600e3).toISOString();

async function mailbox({ shared = false, visibility = 'share_everything', username = 'admin', email = `${uid('box')}@cetizionverifica.com` } = {}) {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility, import_days) VALUES ($1,'test',$2,$3,$4,30) RETURNING *`,
    [username, email, shared, visibility]);
  if (shared) await db.query(`INSERT INTO inboxes (name, account_id, default_assignment) VALUES ($1, $2, 'unassigned')`, [`Inbox ${a.id}`, a.id]);
  return a;
}

const rfq = (over = {}) => ({
  provider_id: uid('m'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@acme>`,
  from: { email: 'ravi@acme-steel.co.in', name: 'Ravi Kumar' }, to: [{ email: 'sales@cetizionverifica.com' }], cc: [],
  subject: 'Request for quotation: EcoVadis assessment',
  body_html: '<p>Dear team, we are interested in EcoVadis certification for our plant. Please share your proposal and fee.</p>',
  sent_at: at(0), ...over,
});

async function deliver(account, messages) {
  sync.pushTestMessages(account.id, messages);
  return sync.syncAccount(account.id);
}

const decisions = async (accountId) => (await db.query('SELECT * FROM email_enquiry_decisions WHERE account_id = $1 ORDER BY id', [accountId])).rows;
const enquiriesFrom = async (accountId) => (await db.query(
  `SELECT e.* FROM enquiries e WHERE e.enquiry_no IN (SELECT enquiry_no FROM email_enquiry_decisions WHERE account_id = $1 AND outcome = 'created') ORDER BY e.id`, [accountId])).rows;

describe('new enquiries from email', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
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
    delete process.env.OPENROUTER_API_KEY;

    ({ default: app } = await import('../src/app.js'));
    sync = await import('../src/lib/mailbox/sync.js');
    auto = await import('../src/lib/mailbox/autoEnquiry.js');
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  beforeEach(async () => {
    auto.deps.chat = null;
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'auto_enquiries_enabled'`);
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

  test('1. a personal mailbox: an RFQ from an unknown sender becomes one enquiry, and the email is kept', async () => {
    const box = await mailbox();
    const msg = rfq({ from: { email: 'ravi@first-steel.co.in', name: 'Ravi Kumar' } });
    const r = await deliver(box, [msg]);
    assert.equal(r.enquiries.created, 1);

    const [e] = await enquiriesFrom(box.id);
    assert.equal(e.client_name, 'First Steel');
    assert.equal(e.status, 'New');
    assert.equal(e.contact_person, 'Ravi Kumar');
    assert.equal(e.service, 'EcoVadis');
    const { rows: [src] } = await db.query('SELECT name FROM lead_sources WHERE id = $1', [e.source_id]);
    assert.equal(src.name, 'Inbound email or call');
    const { rows: [ct] } = await db.query('SELECT email FROM contacts WHERE id = $1', [e.contact_id]);
    assert.equal(ct.email, 'ravi@first-steel.co.in');

    const { rows: [t] } = await db.query('SELECT * FROM email_threads WHERE account_id = $1 AND conversation_id = $2', [box.id, msg.conversation_id]);
    assert.ok(t, 'the email a personal mailbox would have dropped is stored now');
    assert.equal(t.entity, 'enquiry');
    assert.equal(t.entity_id, e.enquiry_no);
    const [d] = await decisions(box.id);
    assert.equal(d.outcome, 'created');
    assert.equal(d.method, 'rules');
    assert.equal(d.thread_id, t.id);
    assert.match(e.notes, /Created automatically from an email/);
    assert.doesNotMatch(e.notes, /interested in EcoVadis certification for our plant/, 'the body is never copied');
  });

  test('2. the same email in a shared mailbox too gives one enquiry; the second copy is linked', async () => {
    const personal = await mailbox();
    const shared = await mailbox({ shared: true });
    const msg = rfq({ from: { email: 'asha@twin-metals.com', name: 'Asha' } });
    await deliver(personal, [msg]);
    await deliver(shared, [{ ...msg, provider_id: uid('copy') }]);

    const [made] = await enquiriesFrom(personal.id);
    assert.ok(made);
    assert.equal((await enquiriesFrom(shared.id)).length, 0);
    const [d] = await decisions(shared.id);
    assert.equal(d.outcome, 'linked');
    assert.equal(d.enquiry_no, made.enquiry_no);
    const { rows: [conv] } = await db.query(
      `SELECT ic.enquiry_no FROM inbox_conversations ic JOIN email_threads t ON t.id = ic.thread_id WHERE t.account_id = $1`, [shared.id]);
    assert.equal(conv.enquiry_no, made.enquiry_no);
  });

  test('3. the client\'s reply in that thread creates nothing new', async () => {
    const box = await mailbox();
    const msg = rfq({ from: { email: 'neha@reply-chem.in', name: 'Neha' } });
    await deliver(box, [msg]);
    await deliver(box, [rfq({ conversation_id: msg.conversation_id, from: msg.from, subject: 'RE: Request for quotation', sent_at: at(0, 12) })]);
    assert.equal((await enquiriesFrom(box.id)).length, 1);
    assert.equal((await decisions(box.id)).length, 1);
  });

  test('4. a newsletter, an invoice email and internal mail create nothing', async () => {
    const box = await mailbox({ shared: true });
    await deliver(box, [
      rfq({ from: { email: 'news@esg-weekly.com' }, subject: 'ESG pricing trends', body_html: '<p>Our pricing guide for certification. <a href="#">Unsubscribe</a></p>' }),
      rfq({ from: { email: 'accounts@supplier-co.in' }, subject: 'Invoice 4411', body_html: '<p>Please find the invoice and remittance advice attached.</p>' }),
      rfq({ from: { email: 'colleague@cetizionverifica.com' }, subject: 'Request for quotation template' }),
    ]);
    assert.equal((await enquiriesFrom(box.id)).length, 0);
  });

  test('6. the same sender within 30 days, in a new thread, is linked, not duplicated', async () => {
    const box = await mailbox();
    const from = { email: 'kiran@repeat-agro.com', name: 'Kiran' };
    await deliver(box, [rfq({ from, sent_at: at(3) })]);
    await deliver(box, [rfq({ from, subject: 'Request for quotation: ISO 14001 audit', sent_at: at(1) })]);
    assert.equal((await enquiriesFrom(box.id)).length, 1);
    const ds = await decisions(box.id);
    assert.deepEqual(ds.map((d) => d.outcome), ['created', 'linked']);
    assert.equal(ds[1].enquiry_no, ds[0].enquiry_no);
  });

  test('7. switched off, nothing is judged and sync stores what it always did', async () => {
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'auto_enquiries_enabled'`);
    const box = await mailbox({ shared: true });
    const r = await deliver(box, [rfq({ from: { email: 'off@quiet-pharma.com' } })]);
    assert.equal(r.stored, 1);
    assert.equal(r.enquiries, undefined);
    assert.equal((await decisions(box.id)).length, 0);
  });

  test('8. a metadata-only mailbox still stores no subject or body, but the enquiry exists', async () => {
    const box = await mailbox({ visibility: 'metadata' });
    const msg = rfq({ from: { email: 'meta@hidden-textiles.com', name: 'Meta' } });
    await deliver(box, [msg]);
    const [e] = await enquiriesFrom(box.id);
    assert.ok(e);
    const { rows: [m] } = await db.query('SELECT subject, snippet, body_html FROM email_messages WHERE account_id = $1', [box.id]);
    assert.deepEqual(m, { subject: null, snippet: null, body_html: null });
    const { rows: [t] } = await db.query('SELECT subject FROM email_threads WHERE account_id = $1', [box.id]);
    assert.equal(t.subject, null);
    assert.doesNotMatch(e.notes, /Request for quotation/, 'the subject stays out of the notes too');
  });

  test('9. a sales user\'s personal mailbox makes them the owner; a shared mailbox leaves it unowned', async () => {
    const { rows: [u] } = await db.query(`INSERT INTO users (name, email, role, active) VALUES ('Priya Sales', 'priya@cetizionverifica.com', 'sales', false) RETURNING id`);
    await db.query(`UPDATE users SET active = true, password_hash = 'x' WHERE id = $1`, [u.id]);
    const mine = await mailbox({ username: 'priya@cetizionverifica.com', email: 'priya@cetizionverifica.com' });
    await deliver(mine, [rfq({ from: { email: 'owner@owned-foods.com', name: 'O' } })]);
    const [e] = await enquiriesFrom(mine.id);
    assert.equal(e.owner_user_id, u.id);
    assert.equal(e.sales_person, 'Priya Sales');

    const shared = await mailbox({ shared: true });
    await deliver(shared, [rfq({ from: { email: 'owner@unowned-glass.com', name: 'U' } })]);
    const [s] = await enquiriesFrom(shared.id);
    assert.equal(s.owner_user_id, null);
  });

  test('10. the manual convert route still makes the enquiry it always made', async () => {
    const box = await mailbox({ shared: true });
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'auto_enquiries_enabled'`);
    await deliver(box, [rfq({ from: { email: 'manual@hand-made.com', name: 'Manu' }, subject: 'Hello there' })]);
    const { rows: [conv] } = await db.query(`SELECT ic.id FROM inbox_conversations ic JOIN email_threads t ON t.id = ic.thread_id WHERE t.account_id = $1`, [box.id]);
    const { body } = await agent.post(`/api/inbox/${conv.id}/convert`).send({ client_name: 'Hand Made Ltd' }).expect(201);
    assert.equal(body.data.client_name, 'Hand Made Ltd');
    assert.equal(body.data.status, 'New');
    assert.equal(body.data.contact_person, 'Manu');
    const { rows: [t] } = await db.query('SELECT entity, entity_id FROM email_threads WHERE account_id = $1', [box.id]);
    assert.deepEqual(t, { entity: 'enquiry', entity_id: body.data.enquiry_no });
  });

  test('11. our email naming a tracker quotation, with no enquiry, makes a Converted enquiry on it, and the reply joins', async () => {
    const { rows: [q] } = await db.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, service_quoted, status) VALUES ('CTZ/QT/2026/901', 'Quoted Cables Ltd', CURRENT_DATE - 1, 250000, 'ISO 9001', 'Submitted') RETURNING *`);
    const box = await mailbox();
    const conversation = uid('qconv');
    await deliver(box, [rfq({
      folder: 'sentitems', conversation_id: conversation, from: { email: box.email, name: 'Us' }, to: [{ email: 'buyer@quoted-cables.com', name: 'Buyer' }],
      subject: 'Quotation CTZ/QT/2026/901 for ISO 9001', body_html: '<p>Please find our quotation.</p>', has_attachments: true,
    })]);
    const { rows: [e] } = await db.query('SELECT * FROM enquiries WHERE quotation_no = $1', [q.quotation_no]);
    assert.ok(e, 'an enquiry now points at the quotation');
    assert.equal(e.status, 'Converted');
    assert.equal(e.client_name, 'Quoted Cables Ltd');
    const { rows: [src] } = await db.query('SELECT name FROM lead_sources WHERE id = $1', [e.source_id]);
    assert.equal(src.name, 'Other');
    const { rows: [{ count }] } = await db.query(`SELECT count(*)::int AS count FROM quotations WHERE client_name = 'Quoted Cables Ltd'`);
    assert.equal(count, 1, 'no second quotation');

    await deliver(box, [rfq({ conversation_id: conversation, from: { email: 'buyer@quoted-cables.com' }, subject: 'RE: Quotation CTZ/QT/2026/901', sent_at: at(0, 14) })]);
    const { rows: [t] } = await db.query('SELECT entity, entity_id, message_count FROM email_threads WHERE account_id = $1 AND conversation_id = $2', [box.id, conversation]);
    assert.ok(t.entity === 'quotation' || t.entity === 'enquiry');
    const { rows: msgs } = await db.query('SELECT 1 FROM email_messages m JOIN email_threads t ON t.id = m.thread_id WHERE t.account_id = $1 AND t.conversation_id = $2', [box.id, conversation]);
    assert.equal(msgs.length, 2, 'the client\'s reply joins the same thread');
    assert.equal((await enquiriesFrom(box.id)).length, 1);
  });

  test('12. a quotation made outside the tracker: a Contacted enquiry with a task; a plain note makes nothing', async () => {
    const box = await mailbox();
    await deliver(box, [rfq({
      folder: 'sentitems', from: { email: box.email }, to: [{ email: 'md@outside-paper.com', name: 'MD' }],
      subject: 'Our proposal for EcoVadis', body_html: '<p>Please find attached our quotation.</p>', has_attachments: true,
    }), rfq({
      folder: 'sentitems', from: { email: box.email }, to: [{ email: 'md@plain-note.com', name: 'MD' }],
      subject: 'Our proposal', body_html: '<p>We will send the quotation tomorrow.</p>', has_attachments: false,
    })]);
    const made = await enquiriesFrom(box.id);
    assert.equal(made.length, 1);
    const [e] = made;
    assert.equal(e.client_name, 'Outside Paper');
    assert.equal(e.status, 'Contacted');
    assert.equal(e.quotation_no, null);
    const { rows: [src] } = await db.query('SELECT name FROM lead_sources WHERE id = $1', [e.source_id]);
    assert.equal(src.name, 'Other');
    const { rows: tasks } = await db.query(`SELECT title FROM tasks WHERE entity = 'enquiry' AND entity_id = $1`, [e.enquiry_no]);
    assert.equal(tasks.length, 1);
    assert.match(tasks[0].title, /Add the quotation sent to Outside Paper/);
    const [d] = (await decisions(box.id)).filter((x) => x.outcome === 'created');
    assert.equal(d.quotation_extraction, 'failed');
  });

  test('13. an inbound enquiry, then our quotation in a new thread: one enquiry, and the tracker quotation fills it', async () => {
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, status) VALUES ('CTZ/QT/2026/902', 'Second Thread Ltd', CURRENT_DATE, 'Submitted')`);
    const box = await mailbox({ shared: true });
    await deliver(box, [rfq({ from: { email: 'buyer@second-thread.com', name: 'Buyer' }, sent_at: at(2) })]);
    const [e] = await enquiriesFrom(box.id);
    assert.ok(e);
    await deliver(box, [rfq({
      folder: 'sentitems', from: { email: box.email }, to: [{ email: 'buyer@second-thread.com' }],
      subject: 'Quotation CTZ/QT/2026/902', body_html: '<p>Attached.</p>', has_attachments: true, sent_at: at(1),
    })]);
    assert.equal((await enquiriesFrom(box.id)).length, 1);
    const { rows: [after1] } = await db.query('SELECT quotation_no FROM enquiries WHERE enquiry_no = $1', [e.enquiry_no]);
    assert.equal(after1.quotation_no, 'CTZ/QT/2026/902');
  });

  test('15. a campaign to twenty recipients with "offer" in the subject makes nothing', async () => {
    const box = await mailbox();
    await deliver(box, [rfq({
      folder: 'sentitems', from: { email: box.email }, to: Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@campaign-${i}.com` })),
      subject: 'Festive offer on ESG assessments', body_html: '<p>Our offer.</p>', has_attachments: true,
    })]);
    assert.equal((await enquiriesFrom(box.id)).length, 0);
  });

  test('the AI path: a fake model decides, and code holds it to the threshold and the kind', async () => {
    const box = await mailbox({ shared: true });
    const answers = [
      { kind: 'new_enquiry', confidence: 0.95, company_name: 'Model Named Pvt Ltd', contact_name: 'Dev', service: 'ESG', summary: 'Wants an ESG strategy.' },
      { kind: 'new_enquiry', confidence: 0.5, company_name: 'Unsure Ltd' },
      { kind: 'vendor_or_sales_pitch', confidence: 0.99, company_name: 'Seller Ltd' },
    ];
    auto.deps.chat = async () => answers.shift();
    await deliver(box, [
      rfq({ from: { email: 'dev@model-named.com', name: 'Dev' }, subject: 'Hello', body_html: '<p>Can we talk about an ESG strategy?</p>' }),
      rfq({ from: { email: 'x@unsure.com' }, subject: 'Question' }),
      rfq({ from: { email: 'y@seller.com' }, subject: 'Our services' }),
    ]);
    const made = await enquiriesFrom(box.id);
    assert.equal(made.length, 1);
    assert.equal(made[0].client_name, 'Model Named Pvt Ltd');
    assert.match(made[0].notes, /Wants an ESG strategy/);
    const ds = await decisions(box.id);
    assert.deepEqual(ds.map((d) => [d.outcome, d.method, d.ai_calls]), [['created', 'ai', 1], ['not_enquiry', 'ai', 1], ['not_enquiry', 'ai', 1]]);
  });

  test('the AI failing falls back to rules, and never stops the sync', async () => {
    const box = await mailbox({ shared: true });
    auto.deps.chat = async () => { throw new Error('no route'); };
    const r = await deliver(box, [rfq({ from: { email: 'z@fallback-tiles.com', name: 'Z' } })]);
    assert.equal(r.error, undefined);
    const [d] = await decisions(box.id);
    assert.equal(d.method, 'rules');
    assert.equal(d.outcome, 'created');
  });

  describe('reading past mail', () => {
  const past = (over) => ({ ...rfq(over), history: true });

  test('5. the backfill reads history oldest first, dates enquiries by the email, resumes, and never repeats', async () => {
    const box = await mailbox({ shared: true });
    sync.testPaging.size = 2;
    const old = at(200);
    sync.pushTestMessages(box.id, [
      past({ from: { email: 'a@hist-one.com', name: 'A' }, sent_at: old }),
      past({ from: { email: 'b@hist-two.com', name: 'B' }, sent_at: at(150) }),
      past({ from: { email: 'c@hist-three.com', name: 'C' }, sent_at: at(100) }),
      past({ from: { email: 'news@hist-news.com' }, subject: 'Weekly', body_html: '<p>Unsubscribe</p>', sent_at: at(90) }),
      past({ from: { email: 'd@too-old.com', name: 'D' }, sent_at: at(400) }),
    ]);
    const ctx = await auto.runContext({ backfill: true });
    // A budget of zero still reads one page: the first run stops part-way.
    let r = await auto.backfillAccount(box, ctx, { budgetMs: 0 });
    assert.equal(r.pages, 1);
    assert.equal(r.created, 2);
    let { rows: [row] } = await db.query('SELECT * FROM mailbox_enquiry_backfills WHERE account_id = $1', [box.id]);
    assert.equal(row.next_link, '2', 'it stopped with a cursor to resume from');
    assert.equal(row.finished_at, null);

    r = await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
    ({ rows: [row] } = await db.query('SELECT * FROM mailbox_enquiry_backfills WHERE account_id = $1', [box.id]));
    assert.ok(row.finished_at, 'both folders read');
    assert.equal(row.created, 3);
    assert.equal(row.scanned, 4);

    const made = await enquiriesFrom(box.id);
    assert.deepEqual(made.map((e) => e.client_name), ['Hist One', 'Hist Two', 'Hist Three']);
    const { rows: [first] } = await db.query(`SELECT enquiry_date::text AS d, enquiry_no FROM enquiries WHERE client_name = 'Hist One'`);
    assert.equal(first.d, old.slice(0, 10), 'dated by the email, not by today');
    assert.match(first.enquiry_no, new RegExp(`/${old.slice(0, 4)}/`), 'numbered in the email\'s year');

    // A second run, and a run over the same ground, make nothing.
    await db.query('UPDATE mailbox_enquiry_backfills SET finished_at = NULL, folder = \'inbox\', next_link = NULL WHERE account_id = $1', [box.id]);
    r = await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
    assert.equal(r.created, 0);
    assert.equal((await enquiriesFrom(box.id)).length, 3);
    sync.testPaging.size = 50;

    const { rows: notes } = await db.query(`SELECT title FROM notifications WHERE dedupe_key LIKE $1`, [`auto-enquiry-backfill:${box.id}:%`]);
    assert.ok(notes.length >= 1);
    assert.match(notes[0].title, /3 enquiries created/);
  });

  test('14. with both folders in history, the Inbox enquiry is made first and the later quotation links to it', async () => {
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, status) VALUES ('CTZ/QT/2025/950', 'Order Matters Ltd', CURRENT_DATE - 40, 'Submitted')`);
    const box = await mailbox({ shared: true });
    sync.pushTestMessages(box.id, [
      // Sent Items holds the quotation; Inbox the request that came first.
      past({ folder: 'sentitems', from: { email: box.email }, to: [{ email: 'buyer@order-matters.com' }], subject: 'Quotation CTZ/QT/2025/950', body_html: '<p>Attached.</p>', has_attachments: true, sent_at: at(40) }),
      past({ from: { email: 'buyer@order-matters.com', name: 'Buyer' }, sent_at: at(45) }),
    ]);
    await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
    const made = await enquiriesFrom(box.id);
    assert.equal(made.length, 1);
    const { rows: [e] } = await db.query('SELECT status, quotation_no FROM enquiries WHERE enquiry_no = $1', [made[0].enquiry_no]);
    assert.equal(e.quotation_no, 'CTZ/QT/2025/950');
    assert.equal(e.status, 'New', 'its status is left for a person to move on');
  });

  test('the day\'s AI ceiling stops the backfill, and it carries on from the same page', async () => {
    const box = await mailbox({ shared: true });
    await db.query(`UPDATE settings SET value = '0' WHERE key = 'auto_enquiry_daily_ai_limit'`);
    auto.deps.chat = async () => ({ kind: 'new_enquiry', confidence: 0.9 });
    sync.pushTestMessages(box.id, [past({ from: { email: 'x@ceiling-co.com', name: 'X' }, sent_at: at(20) })]);
    const r = await auto.runBackfills();
    assert.equal(r.stopped, 'ai_limit');
    const { rows: [row] } = await db.query('SELECT * FROM mailbox_enquiry_backfills WHERE account_id = $1', [box.id]);
    assert.equal(row.finished_at, null);
    assert.equal((await enquiriesFrom(box.id)).length, 0);

    await db.query(`UPDATE settings SET value = '1500' WHERE key = 'auto_enquiry_daily_ai_limit'`);
    await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
    assert.equal((await enquiriesFrom(box.id)).length, 1);
  });
});
});
