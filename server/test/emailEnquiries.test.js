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
    // Answered by sender: the three are from three clients, so they are read side by side.
    const answers = {
      'model-named.com': { kind: 'new_enquiry', confidence: 0.95, company_name: 'Model Named Pvt Ltd', contact_name: 'Dev', service: 'ESG', summary: 'Wants an ESG strategy.' },
      'unsure.com': { kind: 'new_enquiry', confidence: 0.5, company_name: 'Unsure Ltd' },
      'seller.com': { kind: 'vendor_or_sales_pitch', confidence: 0.99, company_name: 'Seller Ltd' },
    };
    auto.deps.chat = async (system, user) => answers[/Sender domain: (\S+)/.exec(user)[1]];
    await deliver(box, [
      rfq({ from: { email: 'dev@model-named.com', name: 'Dev' }, subject: 'Hello', body_html: '<p>Can we talk about an ESG strategy?</p>' }),
      rfq({ from: { email: 'x@unsure.com' }, subject: 'Question' }),
      rfq({ from: { email: 'y@seller.com' }, subject: 'Our services' }),
    ]);
    const made = await enquiriesFrom(box.id);
    assert.equal(made.length, 1);
    assert.equal(made[0].client_name, 'Model Named Pvt Ltd');
    assert.match(made[0].notes, /Wants an ESG strategy/);
    const ds = (await decisions(box.id)).sort((a, b) => a.from_email.localeCompare(b.from_email));
    assert.deepEqual(ds.map((d) => [d.from_email, d.outcome, d.method, d.ai_calls]),
      [['dev@model-named.com', 'created', 'ai', 1], ['x@unsure.com', 'not_enquiry', 'ai', 1], ['y@seller.com', 'not_enquiry', 'ai', 1]]);
  });

  test('the AI reads the text of the PDF a client attached, not only the email', async () => {
    const box = await mailbox({ shared: true });
    const { default: pdfmake } = await import('../src/lib/pdf.js');
    const rfqPdf = await pdfmake.createPdf({ content: ['REQUEST FOR QUOTATION', 'Scope: BRSR reasonable assurance for FY 2025-26, three plants'] }).getBuffer();
    const prompts = [];
    auto.deps.chat = async (system, user) => { prompts.push(user); return { kind: 'new_enquiry', confidence: 0.9, company_name: 'Attached Rfq Ltd', service: 'BRSR' }; };
    await deliver(box, [rfq({
      from: { email: 'buyer@attached-rfq.com', name: 'Buyer' }, subject: 'RFQ', body_html: '<p>Please see attached.</p>', has_attachments: true,
      attachments: [{ name: 'RFQ.pdf', contentType: 'application/pdf', content: rfqPdf }],
    })]);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Text of the PDFs attached:\n--- RFQ\.pdf ---\nREQUEST FOR QUOTATION/);
    assert.match(prompts[0], /BRSR reasonable assurance/);
    assert.equal((await enquiriesFrom(box.id)).length, 1);
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

  describe('quotations read from PDFs', () => {
    let pdfmake;
    before(async () => { ({ default: pdfmake } = await import('../src/lib/pdf.js')); });
    const pdf = (lines, opts = {}) => pdfmake.createPdf({ content: lines, ...opts }).getBuffer();
    const quotePdf = (no = 'CV/Q/2025/045', rev = '') => pdf(['QUOTATION', `Quotation No: ${no} ${rev}`, 'To: Acme Steel Ltd, Kind attn: Ravi Kumar',
      'EcoVadis assessment 1 2,50,000.00', 'Sub-total 2,50,000.00', 'GST 18% 45,000.00', 'Total 2,95,000.00']);

    const extraction = (over = {}) => ({
      quotation_no_printed: 'CV/Q/2025/045', revision: 0, quotation_date: at(1).slice(0, 10), valid_until: null,
      client: { company_name: 'Acme Steel Ltd', contact_name: 'Ravi Kumar' }, currency: 'INR',
      lines: [{ description: 'EcoVadis assessment', qty: 1, rate: '2,50,000.00', gst_rate: 18, service: 'EcoVadis' }],
      subtotal: '2,50,000.00', tax_total: '45,000.00', total: '2,95,000.00', confidence: 0.93, ...over,
    });
    /** The fake AI: a classification for the covering email, the given extraction for the PDF. */
    const fakeAi = (answers, seen = []) => async (system, user) => {
      if (/You read a quotation/.test(system)) { seen.push(typeof user === 'string' ? user : JSON.stringify(user)); return answers.shift(); }
      return { kind: 'quotation_sent', confidence: 0.95, company_name: 'Acme Steel Ltd', contact_name: 'Ravi Kumar', service: 'EcoVadis' };
    };
    const sendQuote = async (box, { to = 'ravi@acme-steel-pdf.co.in', attachments, subject = 'Quotation for EcoVadis', sent = at(0) } = {}) => deliver(box, [rfq({
      folder: 'sentitems', from: { email: box.email }, to: [{ email: to, name: 'Ravi Kumar' }], subject,
      body_html: '<p>Dear Ravi, please find attached our quotation.</p>', has_attachments: true, sent_at: sent, attachments,
    })]);
    const byNo = async (no) => (await db.query('SELECT q.*, ps.name AS stage FROM quotations q LEFT JOIN pipeline_stages ps ON ps.id = q.stage_id WHERE quotation_no = $1', [no])).rows[0];

    test('16. a text PDF whose lines add up: a Submitted quotation on Sent, its printed number, totals from the lines, and a Converted enquiry', async () => {
      const box = await mailbox();
      auto.deps.chat = fakeAi([extraction()]);
      await sendQuote(box, { attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf() }] });
      const q = await byNo('CV/Q/2025/045');
      assert.ok(q, 'the printed number is kept');
      assert.equal(q.status, 'Submitted');
      assert.equal(q.stage, 'Sent');
      assert.ok(q.sent_at);
      assert.equal(Number(q.subtotal), 250000);
      assert.equal(Number(q.total), 295000);
      const { rows: lines } = await db.query('SELECT * FROM quotation_lines WHERE quotation_id = $1', [q.id]);
      assert.equal(lines.length, 1);
      const [e] = await enquiriesFrom(box.id);
      assert.equal(e.status, 'Converted');
      assert.equal(e.quotation_no, 'CV/Q/2025/045');
      const [d] = (await decisions(box.id)).filter((x) => x.outcome === 'created');
      assert.equal(d.quotation_extraction, 'created');
      assert.equal(d.ai_calls, 2, 'one call to judge the email, one to read the PDF');
      assert.equal(Number(d.printed_total), 295000);
    });

    test('17. lines that do not add up: no lines, the printed totals, and the quotation says so', async () => {
      const box = await mailbox();
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CV/Q/2025/046', lines: [{ description: 'Audit', qty: 1, rate: '2,00,000' }] })]);
      await sendQuote(box, { to: 'p@seventeen-co.com', attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf('CV/Q/2025/046') }] });
      const q = await byNo('CV/Q/2025/046');
      const { rows: lines } = await db.query('SELECT 1 FROM quotation_lines WHERE quotation_id = $1', [q.id]);
      assert.equal(lines.length, 0);
      assert.deepEqual([q.subtotal, q.tax_total, q.total, q.quotation_value].map(Number), [250000, 45000, 295000, 295000]);
      const { body } = await agent.get(`/api/quotations/${q.id}/full`).expect(200);
      assert.equal(body.data.read_from_email?.no_lines, true);
    });

    test('17a. the PDF\'s totals survive a revision, give way to real lines, and come back when the lines go', async () => {
      const q = await byNo('CV/Q/2025/046');
      await agent.post(`/api/quotations/${q.id}/revise`).send({ note: 'new version' }).expect(200);
      let now = await byNo('CV/Q/2025/046');
      assert.deepEqual([now.subtotal, now.tax_total, now.total, now.quotation_value].map(Number), [250000, 45000, 295000, 295000]);

      const { rows: [line] } = await db.query(`INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate) VALUES ($1, 'Typed in', 1, 100000, 18) RETURNING id`, [q.id]);
      now = await byNo('CV/Q/2025/046');
      assert.deepEqual([now.subtotal, now.total].map(Number), [100000, 118000], 'the lines take over');

      await db.query('DELETE FROM quotation_lines WHERE id = $1', [line.id]);
      now = await byNo('CV/Q/2025/046');
      assert.deepEqual([now.subtotal, now.tax_total, now.total, now.quotation_value].map(Number), [250000, 45000, 295000, 295000], 'the PDF\'s figures, not blank');
    });

    test('17b. a quotation built in the tracker with no lines still gets blank totals', async () => {
      const { rows: [q] } = await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_value, subtotal, tax_total, total) VALUES ('CTZ/QT/2026/990', 'Plain Ltd', 5000, 1, 2, 3) RETURNING id`);
      await db.query('SELECT quotation_totals($1)', [q.id]);
      const { rows: [after1] } = await db.query('SELECT subtotal, tax_total, total, quotation_value FROM quotations WHERE id = $1', [q.id]);
      assert.deepEqual({ ...after1, quotation_value: Number(after1.quotation_value) }, { subtotal: null, tax_total: null, total: null, quotation_value: 5000 });
    });

    test('18. a clashing printed number takes a tracker number; a free one in our series moves the counter', async () => {
      await db.query(`INSERT INTO quotations (quotation_no, client_name) VALUES ('CTZ/QT/2026/777', 'Somebody Else Ltd')`);
      const box = await mailbox();
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CTZ/QT/2026/777', quotation_date: '2026-09-30' })]);
      await sendQuote(box, { to: 'p@clash-co.com', attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf('CTZ/QT/2026/777') }], sent: '2026-10-01T05:00:00Z' });
      const [e] = await enquiriesFrom(box.id);
      assert.notEqual(e.quotation_no, 'CTZ/QT/2026/777');
      const q = await byNo(e.quotation_no);
      assert.match(q.remarks, /Printed number: CTZ\/QT\/2026\/777/);

      const box2 = await mailbox();
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CTZ/QT/2026/850', quotation_date: '2026-09-30' })]);
      await sendQuote(box2, { to: 'p@free-number.com', attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf('CTZ/QT/2026/850') }], sent: '2026-10-01T05:00:00Z' });
      assert.ok(await byNo('CTZ/QT/2026/850'));
      const { rows: [c] } = await db.query(`SELECT last_n FROM sequence_counters WHERE kind = 'quotation' AND year = '2026'`);
      assert.ok(c.last_n >= 850, 'the tracker will not issue 850 again');
    });

    test('19. the same printed number with Rev 1 revises the quotation; the old version is kept, nothing new is made', async () => {
      const box = await mailbox();
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CV/Q/2025/700' })]);
      await sendQuote(box, { to: 'p@rev-co.com', attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf('CV/Q/2025/700') }], sent: at(2) });
      const before1 = await byNo('CV/Q/2025/700');
      assert.ok(before1);
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CV/Q/2025/700', revision: 'Rev 1' })]);
      await sendQuote(box, { to: 'p@rev-co.com', subject: 'Revised quotation', attachments: [{ name: 'Quotation R1.pdf', contentType: 'application/pdf', content: await quotePdf('CV/Q/2025/700', 'Rev 1') }], sent: at(1) });
      const q = await byNo('CV/Q/2025/700');
      assert.equal(q.revision, 1);
      const { rows: revs } = await db.query('SELECT revision FROM quotation_revisions WHERE quotation_id = $1', [q.id]);
      assert.deepEqual(revs.map((r) => r.revision), [0]);
      assert.equal((await enquiriesFrom(box.id)).length, 1);
      const ds = await decisions(box.id);
      assert.deepEqual(ds.map((d) => [d.outcome, d.quotation_extraction]), [['created', 'created'], ['linked', 'revised']]);
    });

    test('20. an encrypted PDF, or low confidence: a Contacted enquiry, no quotation, a task, and the reason', async () => {
      const box = await mailbox();
      auto.deps.chat = fakeAi([]);
      const locked = await pdf(['secret'], { userPassword: 'x', ownerPassword: 'y', permissions: {} });
      await sendQuote(box, { to: 'p@locked-co.com', attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: locked }] });
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CV/Q/2025/800', confidence: 0.4 })]);
      await sendQuote(box, { to: 'p@unsure-co.com', attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf('CV/Q/2025/800') }] });
      const made = await enquiriesFrom(box.id);
      assert.equal(made.length, 2);
      assert.ok(made.every((e) => e.status === 'Contacted' && e.quotation_no === null));
      assert.equal(await byNo('CV/Q/2025/800'), undefined);
      const ds = (await decisions(box.id)).filter((d) => d.outcome === 'created');
      assert.deepEqual(ds.map((d) => [d.quotation_extraction, d.extraction_reason]), [['failed', 'encrypted'], ['failed', 'low_confidence']]);
      const { rows: tasks } = await db.query(`SELECT 1 FROM tasks WHERE entity = 'enquiry' AND entity_id = ANY($1)`, [made.map((e) => e.enquiry_no)]);
      assert.equal(tasks.length, 2);
    });

    test('21. a brochure and a quotation: the quotation is the one read', async () => {
      const box = await mailbox();
      const seen = [];
      auto.deps.chat = fakeAi([extraction({ quotation_no_printed: 'CV/Q/2025/900' })], seen);
      const brochure = await pdf(Array.from({ length: 40 }, () => 'About Cetizion Verifica: our services, our team and our clients across India.'));
      await sendQuote(box, { to: 'p@two-pdfs.com', attachments: [
        { name: 'Company profile.pdf', contentType: 'application/pdf', content: brochure },
        { name: 'Quotation.pdf', contentType: 'application/pdf', content: await quotePdf('CV/Q/2025/900') },
      ] });
      assert.equal(seen.length, 1);
      assert.match(seen[0], /CV\/Q\/2025\/900/);
      assert.doesNotMatch(seen[0], /our services, our team/);
      assert.ok(await byNo('CV/Q/2025/900'));
    });
  });

  describe('the admin and review screens', () => {
    test('the status lists each mailbox with its counts and its progress through past mail', async () => {
      const { body } = await agent.get('/api/mailboxes/auto-enquiries').expect(200);
      assert.equal(body.data.enabled, true);
      assert.equal(body.data.ai.configured, false);
      assert.ok(body.data.mailboxes.length > 5);
      const withHistory = body.data.mailboxes.find((m) => m.finished_at && m.backfill_created === 3);
      assert.ok(withHistory, 'the mailbox read back in test 5');
      assert.ok(body.data.mailboxes.some((m) => m.quotations_read > 0));
    });

    test('re-run clears what was judged not an enquiry and the backfill, and keeps what was made', async () => {
      const box = await mailbox({ shared: true });
      await deliver(box, [rfq({ from: { email: 'q@rerun-co.com' }, subject: 'Hello', body_html: '<p>Lunch?</p>' }), rfq({ from: { email: 'r@rerun-two.com', name: 'R' } })]);
      await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
      const { body } = await agent.post(`/api/mailboxes/${box.id}/auto-enquiries/rerun`).expect(200);
      assert.equal(body.data.decisions_cleared, 1);
      assert.deepEqual((await decisions(box.id)).map((d) => d.outcome), ['created']);
      const { rows } = await db.query('SELECT 1 FROM mailbox_enquiry_backfills WHERE account_id = $1', [box.id]);
      assert.equal(rows.length, 0);
    });

    test('"Created from email" and "Read from email" filter the lists', async () => {
      const { body: e } = await agent.get('/api/enquiries?from_email=1&limit=500').expect(200);
      const { rows: [{ n }] } = await db.query(`SELECT count(DISTINCT enquiry_no)::int AS n FROM email_enquiry_decisions WHERE outcome = 'created'`);
      assert.equal(e.data.length, n);
      const { body: q } = await agent.get('/api/quotations?from_email=1&limit=500').expect(200);
      assert.ok(q.data.length >= 3);
      assert.ok(q.data.every((x) => /^(CV\/Q|CTZ\/QT)/.test(x.quotation_no)));
      assert.ok(!q.data.some((x) => x.quotation_no === 'CTZ/QT/2026/901'), 'a tracker quotation named in an email was not read from it');
    });

    test('an enquiry and a quotation say where they came from', async () => {
      const { rows: [d] } = await db.query(`SELECT enquiry_no, thread_id FROM email_enquiry_decisions WHERE outcome = 'created' AND thread_id IS NOT NULL ORDER BY id LIMIT 1`);
      const { body } = await agent.get(`/api/mail/origin?entity=enquiry&id=${encodeURIComponent(d.enquiry_no)}`).expect(200);
      assert.equal(body.data.thread_id, d.thread_id);
      assert.ok(body.data.received_at);
      const { body: none } = await agent.get('/api/mail/origin?entity=enquiry&id=CTZ/ENQ/1999/001').expect(200);
      assert.equal(none.data, null);
      const { body: q } = await agent.get(`/api/mail/origin?entity=quotation&id=${encodeURIComponent('CV/Q/2025/046')}`).expect(200);
      assert.equal(q.data.quotation_extraction, 'created');
    });

    test('Mark checked records who checked the quotation, and the banner reads it back', async () => {
      const { rows: [q] } = await db.query(`SELECT id FROM quotations WHERE quotation_no = 'CV/Q/2025/046'`);
      const { body } = await agent.post(`/api/quotations/${q.id}/email-read-checked`).expect(200);
      assert.equal(body.data.checked, true);
      const { rows: [a] } = await db.query(`SELECT * FROM activity_log WHERE action = 'quotation.email_read_checked' AND entity_id = 'CV/Q/2025/046'`);
      assert.equal(a.actor_type, 'shared_admin');
      const { rows: [plain] } = await db.query(`SELECT id FROM quotations WHERE quotation_no = 'CTZ/QT/2026/990'`);
      await agent.post(`/api/quotations/${plain.id}/email-read-checked`).expect(422);
    });
  });

  describe('fixes from the review of #163', () => {
    const past = (over) => ({ ...rfq(over), history: true });

    test('the backfill leaves alone a thread a later reply put on a quotation, and never takes it off it', async () => {
      await db.query(`INSERT INTO quotations (quotation_no, client_name, status) VALUES ('CTZ/QT/2026/903', 'Linked Later Ltd', 'Submitted')`);
      const box = await mailbox({ shared: true });
      const conversation = uid('later');
      await deliver(box, [rfq({ conversation_id: conversation, from: { email: 'b@linked-later.com' }, subject: 'RE: CTZ/QT/2026/903 revised scope', sent_at: at(5) })]);
      const { rows: [before1] } = await db.query('SELECT entity, entity_id FROM email_threads WHERE account_id = $1', [box.id]);
      assert.deepEqual(before1, { entity: 'quotation', entity_id: 'CTZ/QT/2026/903' });
      sync.pushTestMessages(box.id, [past({ conversation_id: conversation, from: { email: 'b@linked-later.com', name: 'B' }, sent_at: at(9) })]);
      await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
      assert.equal((await enquiriesFrom(box.id)).length, 0);
      const { rows: [after1] } = await db.query('SELECT entity, entity_id FROM email_threads WHERE account_id = $1', [box.id]);
      assert.deepEqual(after1, before1);
    });

    test('the backfill joins an enquiry somebody typed in for that email, even one since converted', async () => {
      const day = at(100);
      await db.query(`INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, status) VALUES ('CTZ/ENQ/2025/950', ($1::timestamptz AT TIME ZONE 'Asia/Kolkata')::date + 1, 'Handmade Pumps', 'Converted')`, [day]);
      const box = await mailbox({ shared: true });
      sync.pushTestMessages(box.id, [past({ from: { email: 'buyer@handmade-pumps.com', name: 'Buyer' }, sent_at: day })]);
      await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
      assert.equal((await enquiriesFrom(box.id)).length, 0);
      const [d] = await decisions(box.id);
      assert.equal(d.outcome, 'linked');
      assert.equal(d.enquiry_no, 'CTZ/ENQ/2025/950');
    });

    test('our PDF quotation answering an enquiry we already have becomes its quotation', async () => {
      const { default: pdfmake } = await import('../src/lib/pdf.js');
      const box = await mailbox({ shared: true });
      await deliver(box, [rfq({ from: { email: 'buyer@answered-co.com', name: 'Buyer' }, sent_at: at(2) })]);
      const [e] = await enquiriesFrom(box.id);
      auto.deps.chat = async (system) => (/You read a quotation/.test(system)
        ? { quotation_no_printed: 'CV/Q/2025/960', revision: 0, quotation_date: at(1).slice(0, 10), client: { company_name: 'Answered Co' }, currency: 'INR', lines: [], subtotal: '1,00,000', tax_total: '18,000', total: '1,18,000', confidence: 0.9 }
        : { kind: 'quotation_sent', confidence: 0.95, company_name: 'Answered Co' });
      const content = await pdfmake.createPdf({ content: ['QUOTATION CV/Q/2025/960', 'To: Answered Co', 'Total 1,18,000'] }).getBuffer();
      await deliver(box, [rfq({
        folder: 'sentitems', from: { email: box.email }, to: [{ email: 'buyer@answered-co.com' }], subject: 'Our quotation', body_html: '<p>Attached.</p>',
        has_attachments: true, sent_at: at(1), attachments: [{ name: 'Quotation.pdf', contentType: 'application/pdf', content }],
      })]);
      assert.equal((await enquiriesFrom(box.id)).length, 1);
      const { rows: [after1] } = await db.query('SELECT quotation_no FROM enquiries WHERE enquiry_no = $1', [e.enquiry_no]);
      assert.equal(after1.quotation_no, 'CV/Q/2025/960');
      const ds = await decisions(box.id);
      assert.deepEqual(ds.map((d) => [d.outcome, d.quotation_extraction, d.ai_calls]), [['created', null, 0], ['linked', 'created', 2]]);
    });

    test('the same email decided in another mailbox while this one was being judged is joined, not made twice', async () => {
      const first = await mailbox({ shared: true });
      const second = await mailbox({ shared: true });
      const msg = rfq({ from: { email: 'race@race-co.com', name: 'Race' } });
      auto.deps.chat = async () => {
        // While this mailbox waits on the AI, the other one finishes.
        auto.deps.chat = null;
        await deliver(first, [msg]);
        return { kind: 'new_enquiry', confidence: 0.95, company_name: 'Race Co' };
      };
      await deliver(second, [{ ...msg, provider_id: uid('race-copy') }]);
      const made = await enquiriesFrom(first.id);
      assert.equal(made.length, 1);
      assert.equal((await enquiriesFrom(second.id)).length, 0);
      const [d] = await decisions(second.id);
      assert.deepEqual([d.outcome, d.enquiry_no, d.ai_calls], ['linked', made[0].enquiry_no, 1]);
    });

    test('a backfill whose progress is removed mid-run (Re-run, disconnect) stops cleanly', async () => {
      const box = await mailbox({ shared: true });
      sync.testPaging.size = 1;
      sync.pushTestMessages(box.id, [past({ from: { email: 'a@mid-run.com', name: 'A' }, sent_at: at(30) }), past({ from: { email: 'b@mid-run-two.com', name: 'B' }, sent_at: at(20) })]);
      auto.deps.chat = async () => {
        await db.query('DELETE FROM mailbox_enquiry_backfills WHERE account_id = $1', [box.id]);
        return { kind: 'other', confidence: 0.9 };
      };
      const r = await auto.backfillAccount(box, await auto.runContext({ backfill: true }));
      sync.testPaging.size = 50;
      assert.equal(r.restarted, true);
      assert.equal(r.error, undefined);
    });

    test('re-run keeps the AI-judged decisions of today, which the day\'s ceiling is counted from', async () => {
      const box = await mailbox({ shared: true });
      auto.deps.chat = async () => ({ kind: 'other', confidence: 0.9 });
      await deliver(box, [rfq({ from: { email: 'x@kept-today.com' } })]);
      auto.deps.chat = null;
      await deliver(box, [rfq({ from: { email: 'y@cleared-co.com' }, subject: 'Hello', body_html: '<p>Lunch?</p>' })]);
      const before1 = await auto.aiCallsToday();
      const { body } = await agent.post(`/api/mailboxes/${box.id}/auto-enquiries/rerun`).expect(200);
      assert.equal(body.data.decisions_cleared, 1, 'only the rules-judged one');
      assert.equal(await auto.aiCallsToday(), before1);
    });
  });
});
