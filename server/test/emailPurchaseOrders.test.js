import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Purchase orders from email, automatically (docs/email-po-plan.md §8,
 * scenarios 1–10, 11a, 11b, 13, 15).
 *
 * Mail goes in through the in-memory `test` mailbox provider and the real
 * sync. The AI is a fake that answers with the reading each test gives it;
 * document storage is a fake that records a documents row. PDFs are built
 * with pdfmake, so their text is real and the amount checks run on it.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `email_pos_${process.pid}`;

let app; let agent; let db; let sync; let autoPo; let autoEnquiry; let pdfmake;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;
const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const day = (daysAgo) => new Date(Date.now() + 330 * 60_000 - daysAgo * 864e5).toISOString().slice(0, 10);

async function mailbox({ shared = false } = {}) {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility, import_days) VALUES ('admin','test',$1,$2,'share_everything',30) RETURNING *`,
    [`${uid('box')}@cetizionverifica.com`, shared]);
  if (shared) await db.query(`INSERT INTO inboxes (name, account_id, default_assignment) VALUES ($1, $2, 'unassigned')`, [`Inbox ${a.id}`, a.id]);
  return a;
}

/** A client with a contact, so a personal mailbox keeps their mail. */
async function client(name, email) {
  const { rows: [{ id }] } = await db.query('SELECT company_for($1) AS id', [name]);
  await db.query(`INSERT INTO contacts (company_id, name, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, email.split('@')[0], email]);
  return id;
}

/** A quotation for `name`, with one line, through the API. */
async function quotation(name, rate = 250000, { enquiry = false } = {}) {
  const { body } = await agent.post('/api/quotations').send({ client_name: name, service_quoted: 'EcoVadis', quotation_date: day(20), status: 'Submitted' }).expect(201);
  await agent.post('/api/quotation-lines').send({ quotation_id: body.data.id, description: 'EcoVadis assessment', qty: 1, rate, gst_rate: 18 }).expect(201);
  if (enquiry) {
    await db.query(`INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, status, quotation_no) VALUES ($1, $2, $3, 'Qualified', $4)`,
      [uid('ENQ'), day(25), name, body.data.quotation_no]);
  }
  return (await db.query('SELECT * FROM quotations WHERE id = $1', [body.data.id])).rows[0];
}

const money = (v) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A PO as a client prints it. */
const poPdf = ({ number = '4500012345', buyer = 'Acme Steel Ltd', vendor = 'Cetizion Verifica Pvt. Ltd.', basic = 250000, tax = 45000, ref = '', terms = '50% advance, balance on submission of report' } = {}) =>
  pdfmake.createPdf({ content: ['PURCHASE ORDER', buyer, `To: ${vendor}`, `PO No: ${number}`, ref ? `Ref: your offer ${ref}` : '',
    `1 EcoVadis assessment ${money(basic)}`, `Basic ${money(basic)}`, `IGST 18% ${money(tax)}`, `Total ${money(basic + tax)}`, `Payment: ${terms}`] }).getBuffer();

/** What the fake AI reads from that PDF. */
const reading = (over = {}) => {
  const basic = over.basic ?? 250000; const tax = over.tax ?? 45000;
  return {
    is_purchase_order: true, document_type: 'purchase_order', confidence: 0.94, po_number: '4500012345', po_date: day(3), amendment_no: 0,
    buyer: { company_name: 'Acme Steel Ltd' }, vendor: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, our_quotation_ref: null, currency: 'INR',
    lines: [{ description: 'EcoVadis assessment', qty: 1, rate: money(basic), amount: money(basic) }],
    basic_value: money(basic), tax_value: money(tax), total_value: money(basic + tax), gst_extra: false,
    payment_terms_text: '50% advance, balance on submission of report', credit_days: 30, delivery_date: null, project_manager: {},
    ...over,
  };
};

/** The fake AI answers each PO read with the next reading. */
function ai(...answers) {
  const calls = [];
  autoPo.deps.chat = async (system, user) => {
    calls.push({ system, user });
    if (!/purchase order to us/.test(system)) throw new Error('only POs are read in these tests');
    return answers.length > 1 ? answers.shift() : answers[0];
  };
  return calls;
}

const poEmail = (over = {}) => ({
  provider_id: uid('m'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
  from: { email: 'anil@acme-steel.co.in', name: 'Anil' }, to: [{ email: 'sales@cetizionverifica.com' }], cc: [],
  subject: 'Purchase order for EcoVadis', body_html: '<p>Dear Sir, please find attached our purchase order. Regards, Anil</p>',
  has_attachments: true, sent_at: at(0), ...over,
});

async function deliver(account, messages) {
  sync.pushTestMessages(account.id, messages);
  return sync.syncAccount(account.id);
}

const decision = async (accountId, providerId) => (await db.query('SELECT * FROM email_po_decisions WHERE account_id = $1 AND provider_id = $2', [accountId, providerId])).rows[0];
const poRow = async (no) => (await db.query('SELECT * FROM purchase_orders WHERE po_number = $1', [no])).rows[0];

describe('purchase orders from email', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
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
    autoPo = await import('../src/lib/mailbox/autoPurchaseOrder.js');
    autoEnquiry = await import('../src/lib/mailbox/autoEnquiry.js');
    ({ default: pdfmake } = await import('../src/lib/pdf.js'));
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    autoPo.deps.upload = async ({ buffer, fileName, contentType }) => (await db.query(
      'INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id', [uid('key'), fileName, contentType, buffer.length])).rows[0];
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  beforeEach(async () => {
    autoPo.deps.chat = null;
    await db.query(`UPDATE settings SET value = 'true' WHERE key = 'auto_po_enabled'`);
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

  test('1 and 10. a reply in the quotation thread naming our QT number registers the PO, and never makes an enquiry', async () => {
    const box = await mailbox();
    await client('Acme One Ltd', 'anil@acme-one.co.in');
    const q = await quotation('Acme One Ltd', 250000, { enquiry: true });
    await db.query(`UPDATE quotations SET sales_person = 'Seller Sam', sales_person_email = 'sam@example.test' WHERE id = $1`, [q.id]);
    const msg = poEmail({
      from: { email: 'anil@acme-one.co.in', name: 'Anil' }, subject: `RE: Quotation ${q.quotation_no} - EcoVadis`,
      attachments: [{ name: 'PO_4500010001.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500010001', buyer: 'Acme One Ltd', ref: q.quotation_no }) }],
    });
    ai(reading({ po_number: '4500010001', buyer: { company_name: 'Acme One Ltd' }, our_quotation_ref: q.quotation_no, po_date: day(3) }));
    const r = await deliver(box, [msg]);
    assert.equal(r.purchase_orders?.registered, 1, JSON.stringify(r));

    const po = await poRow('4500010001');
    assert.equal(po.quotation_no, q.quotation_no);
    assert.equal(Number(po.po_value), 295000);
    assert.equal(po.payment_terms_days, 30);
    assert.ok(po.document_id, 'the PDF is attached');
    assert.match(po.remarks, /Registered automatically from the purchase order emailed by anil@acme-one\.co\.in/);
    assert.match(po.project_id, new RegExp(`^PRJ-${day(3).slice(0, 4)}-`));
    const { rows: stages } = await db.query('SELECT stage_name, trigger_event, stage_percent::float AS p FROM payment_stages WHERE po_number = $1 ORDER BY stage_no', [po.po_number]);
    assert.deepEqual(stages.map((s) => [s.trigger_event, s.p]), [['On PO Registration', 0.5], ['On Delivery', 0.5]], 'from the PO\'s own terms');

    const { rows: [won] } = await db.query(`SELECT status, (closed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS closed FROM quotations WHERE id = $1`, [q.id]);
    assert.deepEqual(won, { status: 'Won - PO Received', closed: day(3) });
    const { rows: [e] } = await db.query('SELECT status FROM enquiries WHERE quotation_no = $1', [q.quotation_no]);
    assert.equal(e.status, 'Converted');

    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.mode, d.stages_source, d.po_number, d.ai_calls, d.created_quotation], ['registered', 'live', 'po_terms', '4500010001', 1, false]);
    const { rows: [t] } = await db.query('SELECT entity, entity_id FROM email_threads WHERE id = $1', [d.thread_id]);
    assert.deepEqual(t, { entity: 'purchase_order', entity_id: '4500010001' });
    const { rows: [note] } = await db.query(`SELECT 1 FROM notifications WHERE kind = 'po_registered' AND entity_id = $1`, [po.project_id]);
    assert.ok(note, 'live: the owner hears of it');

    // 10: never an enquiry, and not even judged as one.
    const { rows: judged } = await db.query('SELECT 1 FROM email_enquiry_decisions WHERE provider_id = $1', [msg.provider_id]);
    assert.equal(judged.length, 0);
  });

  test('2. a new thread with no QT number, from a client with one open quotation of that value, registers against it', async () => {
    const box = await mailbox();
    await client('Acme Two Ltd', 'anil@acme-two.co.in');
    const q = await quotation('Acme Two Ltd');
    const msg = poEmail({ from: { email: 'anil@acme-two.co.in' }, attachments: [{ name: 'order.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500020002', buyer: 'Acme Two Ltd' }) }] });
    ai(reading({ po_number: '4500020002', buyer: { company_name: 'Acme Two Ltd' } }));
    await deliver(box, [msg]);
    assert.equal((await poRow('4500020002'))?.quotation_no, q.quotation_no);
  });

  test('3. two open quotations of that value go to review, both suggested', async () => {
    const box = await mailbox();
    await client('Acme Three Ltd', 'anil@acme-three.co.in');
    const a = await quotation('Acme Three Ltd');
    const b = await quotation('Acme Three Ltd', 251000);
    const msg = poEmail({ from: { email: 'anil@acme-three.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500030003', buyer: 'Acme Three Ltd' }) }] });
    ai(reading({ po_number: '4500030003', buyer: { company_name: 'Acme Three Ltd' } }));
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.equal(d.outcome, 'review');
    assert.equal(d.review_reason, 'several_matches');
    assert.deepEqual([...d.suggested_quotations].sort(), [a.quotation_no, b.quotation_no].sort());
    assert.equal(await poRow('4500030003'), undefined);
    const { rows: [note] } = await db.query(`SELECT title FROM notifications WHERE kind = 'po_review' AND dedupe_key = $1`, [`po-review:${box.id}:${msg.provider_id}`]);
    assert.match(note.title, /PO 4500030003 from Acme Three Ltd needs a look/);
  });

  test('4. no quotation on file: the quotation (won) and the enquiry (converted) are made from the PO', async () => {
    const box = await mailbox();
    const msg = poEmail({
      from: { email: 'buyer@brand-new-steel.com' },
      attachments: [{ name: 'PO.pdf', contentType: 'application/pdf', content: await poPdf({ number: 'BNS/PO/2026/77', buyer: 'Brand New Steel Pvt Ltd', terms: '100% after completion' }) }],
    });
    ai(reading({ po_number: 'BNS/PO/2026/77', buyer: { company_name: 'Brand New Steel Pvt Ltd', gstin: '27AABCB7777A1Z1' }, payment_terms_text: '100% after completion', po_date: day(5) }));
    await deliver(box, [msg]);
    const po = await poRow('BNS/PO/2026/77');
    assert.ok(po, 'registered');
    const { rows: [q] } = await db.query(
      `SELECT q.*, (q.closed_at AT TIME ZONE 'Asia/Kolkata')::date::text AS closed, q.quotation_date::text AS qdate FROM quotations q WHERE quotation_no = $1`, [po.quotation_no]);
    assert.equal(q.client_name, 'Brand New Steel Pvt Ltd');
    assert.equal(q.status, 'Won - PO Received');
    assert.equal(q.qdate, day(5));
    assert.equal(q.closed, day(5));
    assert.equal(Number(q.total), 295000, 'its lines carry the PO\'s value');
    const { rows: [e] } = await db.query('SELECT e.status, s.name AS source FROM enquiries e LEFT JOIN lead_sources s ON s.id = e.source_id WHERE e.quotation_no = $1', [q.quotation_no]);
    assert.deepEqual(e, { status: 'Converted', source: 'Other' });
    const { rows: [co] } = await db.query('SELECT gstin FROM companies WHERE id = $1', [q.company_id]);
    assert.equal(co.gstin, '27AABCB7777A1Z1', 'the GSTIN read from the PO is kept for next time');
    const { rows: stages } = await db.query('SELECT trigger_event, stage_percent::float AS p FROM payment_stages WHERE po_number = $1', [po.po_number]);
    assert.deepEqual(stages.map((s) => [s.trigger_event, s.p]), [['On Delivery', 1]]);
    assert.equal((await decision(box.id, msg.provider_id)).created_quotation, true);
  });

  test('5. a PO already registered by hand in another spelling is linked, its PDF attached, nothing new made', async () => {
    const box = await mailbox();
    await client('Acme Five Ltd', 'anil@acme-five.co.in');
    const q = await quotation('Acme Five Ltd');
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`).send({ po_number: 'PO-55123', po_date: day(4) }).expect(201);
    const before = (await db.query('SELECT count(*)::int AS n FROM purchase_orders')).rows[0].n;
    const msg = poEmail({ from: { email: 'anil@acme-five.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: 'po 55123', buyer: 'Acme Five Ltd' }) }] });
    ai(reading({ po_number: 'po 55123', buyer: { company_name: 'Acme Five Ltd' } }));
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.po_number], ['linked', 'PO-55123']);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM purchase_orders')).rows[0].n, before);
    assert.ok((await poRow('PO-55123')).document_id, 'the PDF it had not got');
  });

  test('6. the same email in two mailboxes gives one registration and one AI call', async () => {
    const personal = await mailbox();
    const shared = await mailbox({ shared: true });
    await client('Acme Six Ltd', 'anil@acme-six.co.in');
    await quotation('Acme Six Ltd');
    const msg = poEmail({ from: { email: 'anil@acme-six.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500060006', buyer: 'Acme Six Ltd' }) }] });
    const calls = ai(reading({ po_number: '4500060006', buyer: { company_name: 'Acme Six Ltd' } }));
    await deliver(personal, [msg]);
    await deliver(shared, [{ ...msg, provider_id: uid('copy') }]);
    assert.equal(calls.length, 1);
    const { rows } = await db.query(`SELECT outcome, ai_calls FROM email_po_decisions WHERE lower(internet_message_id) = lower($1) ORDER BY id`, [msg.internet_message_id]);
    assert.deepEqual(rows.map((r) => [r.outcome, r.ai_calls]), [['registered', 1], ['linked', 0]]);
  });

  test('7 and 8. an amendment or a cancellation goes to review, and the PO is untouched', async () => {
    const box = await mailbox();
    await client('Acme Seven Ltd', 'anil@acme-seven.co.in');
    const q = await quotation('Acme Seven Ltd');
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`).send({ po_number: '4500070007', po_date: day(10) }).expect(201);
    const was = await poRow('4500070007');
    for (const [over, reason] of [[{ document_type: 'amendment', amendment_no: 1, basic: 300000, tax: 54000 }, 'amendment'], [{ is_purchase_order: false, document_type: 'cancellation' }, 'cancellation']]) {
      const msg = poEmail({ from: { email: 'anil@acme-seven.co.in' }, subject: 'Amendment to PO 4500070007',
        attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500070007', buyer: 'Acme Seven Ltd', basic: over.basic ?? 250000, tax: over.tax ?? 45000 }) }] });
      ai(reading({ po_number: '4500070007', buyer: { company_name: 'Acme Seven Ltd' }, ...over }));
      await deliver(box, [msg]);
      const d = await decision(box.id, msg.provider_id);
      assert.deepEqual([d.outcome, d.review_reason], ['review', reason]);
    }
    const now = await poRow('4500070007');
    assert.equal(Number(now.po_value), Number(was.po_value));
    const { rows: [note] } = await db.query(`SELECT title FROM notifications WHERE kind = 'po_review' AND title LIKE '%amendment 1%'`);
    assert.match(note.title, /PO 4500070007 .* needs a look \(amendment 1, now INR 354000\)/);
  });

  test('9. a PO addressed to another vendor goes to review', async () => {
    const box = await mailbox();
    await client('Acme Nine Ltd', 'anil@acme-nine.co.in');
    const msg = poEmail({ from: { email: 'anil@acme-nine.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500090009', buyer: 'Acme Nine Ltd', vendor: 'Bureau Veritas India' }) }] });
    ai(reading({ po_number: '4500090009', buyer: { company_name: 'Acme Nine Ltd' }, vendor: { company_name: 'Bureau Veritas India' } }));
    await deliver(box, [msg]);
    assert.equal((await decision(box.id, msg.provider_id)).review_reason, 'not_to_us');
  });

  test('11a. a PO 5% under its quotation goes to review with both values; 1.5% under registers', async () => {
    const box = await mailbox();
    await client('Acme Eleven Ltd', 'anil@acme-eleven.co.in');
    const q = await quotation('Acme Eleven Ltd', 200000);
    const send = async (number, basic) => {
      const tax = Math.round(basic * 0.18 * 100) / 100;
      const msg = poEmail({ from: { email: 'anil@acme-eleven.co.in' }, subject: `RE: ${q.quotation_no}`,
        attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number, buyer: 'Acme Eleven Ltd', basic, tax, ref: q.quotation_no }) }] });
      ai(reading({ po_number: number, buyer: { company_name: 'Acme Eleven Ltd' }, our_quotation_ref: q.quotation_no, basic, tax }));
      await deliver(box, [msg]);
      return decision(box.id, msg.provider_id);
    };
    const off = await send('4500110001', 190000);
    assert.deepEqual([off.outcome, off.review_reason, off.suggested_quotations], ['review', 'value_mismatch', [q.quotation_no]]);
    const near = await send('4500110002', 197000);
    assert.equal(near.outcome, 'registered');
    assert.equal(Number((await poRow('4500110002')).po_value), 232460);
  });

  test('11b. a known client with an open quotation 10% off goes to review, not to "create a quotation"', async () => {
    const box = await mailbox();
    await client('Acme Twelve Ltd', 'anil@acme-twelve.co.in');
    const q = await quotation('Acme Twelve Ltd', 278000);
    const msg = poEmail({ from: { email: 'anil@acme-twelve.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500120012', buyer: 'Acme Twelve Ltd' }) }] });
    ai(reading({ po_number: '4500120012', buyer: { company_name: 'Acme Twelve Ltd' } }));
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.review_reason, d.suggested_quotations], ['review', 'no_match', [q.quotation_no]]);
    assert.equal(d.created_quotation, false);
  });

  test('a PO from months ago is registered as history: stages, but no notification', async () => {
    const box = await mailbox();
    await client('Acme Old Ltd', 'anil@acme-old.co.in');
    await quotation('Acme Old Ltd');
    const msg = poEmail({ from: { email: 'anil@acme-old.co.in' }, sent_at: at(200), attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500200200', buyer: 'Acme Old Ltd' }) }] });
    ai(reading({ po_number: '4500200200', buyer: { company_name: 'Acme Old Ltd' }, po_date: day(201) }));
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.mode], ['registered', 'history']);
    const po = await poRow('4500200200');
    const { rows: stages } = await db.query('SELECT 1 FROM payment_stages WHERE po_number = $1', [po.po_number]);
    assert.equal(stages.length, 2);
    const { rows: notes } = await db.query(`SELECT 1 FROM notifications WHERE kind = 'po_registered' AND entity_id = $1`, [po.project_id]);
    assert.equal(notes.length, 0);
  });

  test('words alone, an unreadable answer and no AI: nothing registered, nothing lost', async () => {
    const box = await mailbox();
    await client('Acme Words Ltd', 'anil@acme-words.co.in');
    // Words alone: not even read.
    const words = poEmail({ from: { email: 'anil@acme-words.co.in' }, subject: 'RE: EcoVadis', body_html: '<p>We will send the PO next week.</p>', has_attachments: false });
    const calls = ai(reading());
    await deliver(box, [words]);
    assert.equal(calls.length, 0);
    assert.equal(await decision(box.id, words.provider_id), undefined);
    // The AI failing keeps it for a retry: nothing registered, nothing lost.
    autoPo.deps.chat = async () => { throw new Error('timeout'); };
    const failed = poEmail({ from: { email: 'anil@acme-words.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ buyer: 'Acme Words Ltd' }) }] });
    await deliver(box, [failed]);
    assert.equal((await decision(box.id, failed.provider_id)).outcome, 'retry');
    await db.query(`UPDATE email_po_decisions SET outcome = 'dismissed' WHERE account_id = $1 AND provider_id = $2`, [box.id, failed.provider_id]);
    // Low confidence: review.
    const unsure = poEmail({ from: { email: 'anil@acme-words.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500999001', buyer: 'Acme Words Ltd' }) }] });
    ai(reading({ po_number: '4500999001', confidence: 0.6 }));
    await deliver(box, [unsure]);
    assert.equal((await decision(box.id, unsure.provider_id)).review_reason, 'low_confidence');
  });

  test('13. the review queue: listed, read again for the dialog, registered by hand, or dismissed', async () => {
    const box = await mailbox();
    await client('Acme Review Ltd', 'anil@acme-review.co.in');
    const a = await quotation('Acme Review Ltd');
    const b = await quotation('Acme Review Ltd');
    const send = async (number) => {
      const msg = poEmail({ from: { email: 'anil@acme-review.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number, buyer: 'Acme Review Ltd' }) }] });
      ai(reading({ po_number: number, buyer: { company_name: 'Acme Review Ltd' } }));
      await deliver(box, [msg]);
      return decision(box.id, msg.provider_id);
    };
    const first = await send('4500131301');
    const second = await send('4500131302');

    const { body: list } = await agent.get('/api/purchase-orders/review').expect(200);
    const row = list.data.find((r) => r.id === first.id);
    assert.equal(row.review_reason, 'several_matches');
    assert.deepEqual(row.suggested.map((s) => s.quotation_no).sort(), [a.quotation_no, b.quotation_no].sort());
    assert.equal(row.mailbox, box.email);

    // Read again: the email's PDF goes to the AI a second time.
    const calls = ai(reading({ po_number: '4500131301', buyer: { company_name: 'Acme Review Ltd' } }));
    const { body: pre } = await agent.post(`/api/purchase-orders/review/${first.id}/register`).expect(200);
    assert.equal(calls.length, 1);
    assert.equal(pre.data.prefill.po_number, '4500131301');
    assert.equal(pre.data.prefill.po_value, 295000);
    assert.deepEqual(pre.data.prefill.stages.map((s) => s.percent), [50, 50]);
    assert.ok(pre.data.prefill.document_id, 'the PDF, ready to attach');

    await agent.post(`/api/quotations/${encodeURIComponent(a.quotation_no)}/register`)
      .send({ po_number: pre.data.prefill.po_number, po_date: pre.data.prefill.po_date, po_value: pre.data.prefill.po_value,
        stages: pre.data.prefill.stages, document_id: pre.data.prefill.document_id, review_id: first.id })
      .expect(201);
    const settled = (await db.query('SELECT * FROM email_po_decisions WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual([settled.outcome, settled.po_number, settled.quotation_no, settled.decided_by], ['registered_by_hand', '4500131301', a.quotation_no, 'admin']);
    assert.ok(settled.settled_at);
    assert.ok((await poRow('4500131301')).document_id);
    // A second registration cannot settle it again.
    await agent.post(`/api/quotations/${encodeURIComponent(b.quotation_no)}/register`).send({ po_number: 'X-1', review_id: first.id }).expect(409);

    await agent.post(`/api/purchase-orders/review/${second.id}/dismiss`).expect(200);
    assert.equal((await db.query('SELECT outcome FROM email_po_decisions WHERE id = $1', [second.id])).rows[0].outcome, 'dismissed');
    await agent.post(`/api/purchase-orders/review/${second.id}/dismiss`).expect(404);
    const { body: after } = await agent.get('/api/purchase-orders/review').expect(200);
    assert.ok(!after.data.some((r) => [first.id, second.id].includes(r.id)));
  });

  test('15. auto_po_enabled off: nothing is read for POs, and the enquiry reader judges the email as before', async () => {
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'auto_po_enabled'`);
    const box = await mailbox();
    await client('Acme Off Ltd', 'anil@acme-off.co.in');
    await quotation('Acme Off Ltd');
    const calls = ai(reading({ po_number: '4500150015' }));
    const msg = poEmail({ from: { email: 'anil@acme-off.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500150015', buyer: 'Acme Off Ltd' }) }] });
    await deliver(box, [msg]);
    assert.equal(calls.length, 0);
    assert.equal(await decision(box.id, msg.provider_id), undefined);
    const { rows } = await db.query('SELECT outcome FROM email_enquiry_decisions WHERE provider_id = $1', [msg.provider_id]);
    assert.equal(rows.length, 1, 'phase 1 judged it, as it did before phase 2');
  });
  // ------------------------------------------------------------ step 4: past mail

  /** A message in the mailbox's past: page() hands it over, delta does not. */
  const past = (over) => ({ ...poEmail(over), history: true, folder: 'inbox' });
  const readPast = async (box) => {
    const enquiries = await autoEnquiry.backfillAccount(box, await autoEnquiry.runContext({ backfill: true }));
    const pos = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
    return { enquiries, pos };
  };

  test('12. the PO backfill waits for the mailbox\'s enquiry backfill', async () => {
    const box = await mailbox();
    const r = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
    assert.equal(r.waiting, 'enquiry backfill');
    const { rows } = await db.query('SELECT 1 FROM mailbox_po_backfills WHERE account_id = $1', [box.id]);
    assert.equal(rows.length, 0, 'not even started');
    const swept = await autoPo.runPoBackfills();
    assert.ok(!swept.results.some((x) => x.id === box.id), 'the sweep skips it too');
  });

  test('12b. a re-run of enquiries does not hold the PO backfill back: the past mail was read through once', async () => {
    const box = await mailbox();
    await autoEnquiry.backfillAccount(box, await autoEnquiry.runContext({ backfill: true }));
    await agent.post(`/api/mailboxes/${box.id}/auto-enquiries/rerun`).expect(200);
    const { rows: e } = await db.query('SELECT 1 FROM mailbox_enquiry_backfills WHERE account_id = $1', [box.id]);
    assert.equal(e.length, 0, 'the enquiry read starts again');
    const r = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
    assert.deepEqual([r.waiting, r.finished], [undefined, true]);
    const { rows: [a] } = await db.query('SELECT past_enquiries_read_at, past_pos_read_at FROM connected_accounts WHERE id = $1', [box.id]);
    assert.ok(a.past_enquiries_read_at && a.past_pos_read_at);
  });

  test('12c. the PO backfill reads as far as the enquiry reader has got in Sent Items, and waits there', async () => {
    const box = await mailbox();
    const plain = (daysAgo) => ({
      folder: 'inbox', history: true, provider_id: uid('p'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
      from: { email: 'someone@plain-co.in' }, to: [{ email: box.email }], subject: 'Lunch?', body_html: '<p>Lunch on Friday?</p>', sent_at: at(daysAgo),
    });
    sync.pushTestMessages(box.id, [plain(200), plain(100)]);
    sync.testPaging.size = 1;
    try {
      // The whole Inbox read for enquiries, and Sent Items up to 150 days ago.
      await db.query(`INSERT INTO mailbox_enquiry_backfills (account_id, since, folder, reached) VALUES ($1, $2, 'sentitems', $3)`, [box.id, at(365), at(150)]);
      let r = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
      assert.deepEqual([r.pages, r.waiting], [1, 'enquiry backfill']);
      const reached = async () => (await db.query('SELECT reached, finished_at FROM mailbox_po_backfills WHERE account_id = $1', [box.id])).rows[0];
      let row = await reached();
      assert.ok(Math.abs(new Date(row.reached) - new Date(at(200))) < 60_000, 'read the 200-day-old page');
      r = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
      assert.deepEqual([r.pages, r.waiting], [0, 'enquiry backfill'], 'the 100-day-old page waits');
      await db.query('UPDATE mailbox_enquiry_backfills SET finished_at = now(), folder = NULL WHERE account_id = $1', [box.id]);
      r = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
      assert.equal(r.finished, true);
      row = await reached();
      assert.ok(new Date(row.reached) > new Date(at(150)));
    } finally {
      sync.testPaging.size = 50;
    }
  });

  test('11. an eight-month-old PO from past mail: history mode, its stages listed to settle, nobody told but one summary', async () => {
    const box = await mailbox();
    await client('Acme Past Ltd', 'anil@acme-past.co.in');
    const q = await quotation('Acme Past Ltd');
    await db.query(`UPDATE quotations SET sales_person = 'Seller Sam', sales_person_email = 'sam@example.test' WHERE id = $1`, [q.id]);
    await db.query(`INSERT INTO webhook_endpoints (name, url, events, secret) VALUES ('n8n-past', 'https://example.test/hook', ARRAY['po.received','quotation.won'], 's')`);
    try {
      const msg = past({ from: { email: 'anil@acme-past.co.in' }, sent_at: at(240), subject: `RE: ${q.quotation_no}`,
        attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500240240', buyer: 'Acme Past Ltd', ref: q.quotation_no }) }] });
      sync.pushTestMessages(box.id, [msg]);
      ai(reading({ po_number: '4500240240', buyer: { company_name: 'Acme Past Ltd' }, our_quotation_ref: q.quotation_no, po_date: day(241) }));
      const { pos } = await readPast(box);
      assert.deepEqual([pos.registered, pos.finished], [1, true]);

      const d = await decision(box.id, msg.provider_id);
      assert.deepEqual([d.outcome, d.mode], ['registered', 'history']);
      const po = await poRow('4500240240');
      const { rows: notes } = await db.query(`SELECT 1 FROM notifications WHERE kind = 'po_registered' AND entity_id = $1`, [po.project_id]);
      assert.equal(notes.length, 0);
      const { rows: steps } = await db.query('SELECT 1 FROM onboarding_tasks WHERE project_id = $1', [po.project_id]);
      assert.equal(steps.length, 0);
      const { rows: hooks } = await db.query('SELECT 1 FROM webhook_events WHERE entity_id IN ($1, $2)', [po.po_number, q.quotation_no]);
      assert.equal(hooks.length, 0, 'no po.received, no quotation.won');

      const { body: settle } = await agent.get('/api/payment-stages?from_past_po=1').expect(200);
      const mine = settle.data.filter((s) => s.po_number === po.po_number);
      assert.equal(mine.length, 2, 'both stages, waiting for the invoices that already happened');
      // An invoice recorded keeps it on the list ("Past POs and invoices to
      // settle", §3.10.4); the payment that already happened takes it off.
      await agent.post(`/api/payment-stages/${mine[0].id}/invoice`).send({ invoice_no: `INV-PAST-${n}`, invoice_date: day(200) }).expect(200);
      const { body: invoiced } = await agent.get('/api/payment-stages?from_past_po=1').expect(200);
      assert.equal(invoiced.data.filter((s) => s.po_number === po.po_number).length, 2);
      await agent.post(`/api/payment-stages/${mine[0].id}/payment`).send({ amount_received: Number(mine[0].stage_amount), payment_received_date: day(150) }).expect(200);
      const { body: after } = await agent.get('/api/payment-stages?from_past_po=1').expect(200);
      assert.equal(after.data.filter((s) => s.po_number === po.po_number).length, 1);
      const { body: fromEmail } = await agent.get('/api/purchase-orders?from_email=1').expect(200);
      assert.ok(fromEmail.data.some((p) => p.po_number === po.po_number));

      const { rows: summary } = await db.query(`SELECT title, link FROM notifications WHERE dedupe_key LIKE $1`, [`auto-po-backfill:${box.id}:%`]);
      assert.equal(summary.length, 1);
      assert.match(summary[0].title, /for purchase orders: 1 registered, 0 to review/);
      assert.equal(summary[0].link, '/payment-stages?from_past_po=1');

      // Read again: nothing twice.
      const again = await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
      assert.equal(again.finished, true);
      assert.equal(again.registered, 0);
    } finally {
      await db.query(`DELETE FROM webhook_endpoints WHERE name = 'n8n-past'`);
    }
  });

  test('an old RFQ that only looked like a PO is handed back to the enquiry reader', async () => {
    const box = await mailbox();
    const msg = past({
      from: { email: 'ravi@contract-rfq.co.in', name: 'Ravi' }, sent_at: at(100),
      subject: 'Request for quotation: EcoVadis assessment under our annual contract',
      body_html: '<p>Dear team, we are interested in EcoVadis certification for our plant. Please share your proposal and fee. Scope attached.</p>',
      attachments: [{ name: 'Scope.pdf', contentType: 'application/pdf', content: await poPdf({ number: 'NA', buyer: 'Contract Rfq' }) }],
    });
    sync.pushTestMessages(box.id, [msg]);
    ai({ is_purchase_order: false, document_type: 'other', confidence: 0.9 });
    const { enquiries } = await readPast(box);
    assert.equal(enquiries.created, 0, 'the enquiry pass left it for the PO reader');
    assert.equal((await decision(box.id, msg.provider_id)).outcome, 'not_po');
    const { rows } = await db.query('SELECT outcome FROM email_enquiry_decisions WHERE account_id = $1 AND provider_id = $2', [box.id, msg.provider_id]);
    assert.deepEqual(rows.map((r) => r.outcome), ['created'], 'then judged as an enquiry after all');
  });

  test('the PO banner: where it came from, and Mark checked', async () => {
    const box = await mailbox();
    await client('Acme Banner Ltd', 'anil@acme-banner.co.in');
    await quotation('Acme Banner Ltd');
    const msg = poEmail({ from: { email: 'anil@acme-banner.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: 'AB/PO/77', buyer: 'Acme Banner Ltd' }) }] });
    ai(reading({ po_number: 'AB/PO/77', buyer: { company_name: 'Acme Banner Ltd' } }));
    await deliver(box, [msg]);
    const key = encodeURIComponent('AB/PO/77');
    const { body: full } = await agent.get(`/api/purchase-orders/${key}/full`).expect(200);
    assert.deepEqual([full.data.from_email.from_email, full.data.from_email.mode, full.data.from_email.checked], ['anil@acme-banner.co.in', 'live', false]);
    const { body: origin } = await agent.get(`/api/mail/origin?entity=purchase_order&id=${key}`).expect(200);
    assert.deepEqual([origin.data.mailbox, origin.data.mode, origin.data.by_hand], [box.email, 'live', false]);
    const { body: checked } = await agent.post(`/api/purchase-orders/${key}/email-read-checked`).expect(200);
    assert.equal(checked.data.checked, true);
    // A PO typed in by hand has no banner to check.
    const q = await quotation('Acme Banner Ltd');
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`).send({ po_number: 'AB/PO/78' }).expect(201);
    await agent.post(`/api/purchase-orders/${encodeURIComponent('AB/PO/78')}/email-read-checked`).expect(422);
    assert.equal((await agent.get(`/api/purchase-orders/${encodeURIComponent('AB/PO/78')}/full`).expect(200)).body.data.from_email, null);
  });

  test('the mailbox status counts POs, and re-run reads not-POs again', async () => {
    const box = await mailbox();
    await client('Acme Status Ltd', 'anil@acme-status.co.in');
    const msg = poEmail({ from: { email: 'anil@acme-status.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ buyer: 'Acme Status Ltd' }) }] });
    ai({ is_purchase_order: false, document_type: 'other', confidence: 0.9 });
    await deliver(box, [msg]);
    const { body } = await agent.get('/api/mailboxes/auto-enquiries').expect(200);
    assert.equal(body.data.purchase_orders_enabled, true);
    const row = body.data.mailboxes.find((m) => m.id === box.id);
    assert.deepEqual([row.pos_registered, row.pos_to_review, row.not_po], [0, 0, 1]);
    // Today's AI-read decision stays (the ceiling counts it); an older one is cleared.
    await db.query(`UPDATE email_po_decisions SET decided_at = now() - interval '2 days' WHERE account_id = $1`, [box.id]);
    const { body: rerun } = await agent.post(`/api/mailboxes/${box.id}/auto-enquiries/rerun`).send({ kind: 'pos' }).expect(200);
    assert.deepEqual([rerun.data.kind, rerun.data.decisions_cleared], ['pos', 1]);
  });
  // ------------------------------------------------------------ review fixes

  test('live mail the AI could not read is kept, held from the enquiry reader, read again by the job, and reviewed after a week', async () => {
    await db.query(`UPDATE email_po_decisions SET outcome = 'dismissed' WHERE outcome = 'retry'`);
    const box = await mailbox();
    await client('Acme Retry Ltd', 'anil@acme-retry.co.in');
    await quotation('Acme Retry Ltd');
    autoPo.deps.chat = async () => { throw new Error('upstream timeout'); };
    const msg = poEmail({ from: { email: 'anil@acme-retry.co.in' }, subject: 'Purchase order for EcoVadis',
      attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500888001', buyer: 'Acme Retry Ltd' }) }] });
    await deliver(box, [msg]);
    let d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.ai_calls], ['retry', 1]);
    assert.ok(d.retry_since);
    const { rows: judged } = await db.query('SELECT 1 FROM email_enquiry_decisions WHERE provider_id = $1', [msg.provider_id]);
    assert.equal(judged.length, 0, 'still the PO reader\'s: not made an enquiry');

    ai(reading({ po_number: '4500888001', buyer: { company_name: 'Acme Retry Ltd' } }));
    const run = await autoPo.runPoBackfills();
    assert.equal(run.retried.registered, 1);
    d = await decision(box.id, msg.provider_id);
    assert.equal(d.outcome, 'registered');
    assert.ok(await poRow('4500888001'));

    autoPo.deps.chat = async () => { throw new Error('still down'); };
    const stuck = poEmail({ from: { email: 'anil@acme-retry.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500888002', buyer: 'Acme Retry Ltd' }) }] });
    await deliver(box, [stuck]);
    await db.query(`UPDATE email_po_decisions SET retry_since = now() - interval '8 days' WHERE account_id = $1 AND provider_id = $2`, [box.id, stuck.provider_id]);
    await autoPo.runPoBackfills();
    d = await decision(box.id, stuck.provider_id);
    assert.deepEqual([d.outcome, d.review_reason], ['review', 'unreadable']);
  });

  test('with no AI, PO-looking mail is not held back: the enquiry reader judges it as before', async () => {
    const box = await mailbox();
    await client('Acme NoAi Ltd', 'anil@acme-noai.co.in');
    autoPo.deps.chat = null;
    const msg = poEmail({ from: { email: 'anil@acme-noai.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ buyer: 'Acme NoAi Ltd' }) }] });
    await deliver(box, [msg]);
    assert.equal(await decision(box.id, msg.provider_id), undefined);
    const { rows } = await db.query('SELECT 1 FROM email_enquiry_decisions WHERE provider_id = $1', [msg.provider_id]);
    assert.equal(rows.length, 1);
  });

  test('a past PO with no quotation on file fires no webhook at all, enquiry.created included', async () => {
    await db.query(`INSERT INTO webhook_endpoints (name, url, events, secret) VALUES ('n8n-hist', 'https://example.test/hook', ARRAY['enquiry.created','po.received','quotation.won'], 's')`);
    try {
      const box = await mailbox();
      const msg = poEmail({ from: { email: 'buyer@old-new-client.com' }, sent_at: at(150),
        attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: 'ONC/77', buyer: 'Old New Client Ltd' }) }] });
      ai(reading({ po_number: 'ONC/77', buyer: { company_name: 'Old New Client Ltd' }, po_date: day(151) }));
      await deliver(box, [msg]);
      const d = await decision(box.id, msg.provider_id);
      assert.deepEqual([d.outcome, d.mode, d.created_quotation], ['registered', 'history', true]);
      const { rows: [e] } = await db.query('SELECT enquiry_no FROM enquiries WHERE quotation_no = $1', [d.quotation_no]);
      const { rows: hooks } = await db.query('SELECT event FROM webhook_events WHERE entity_id IN ($1, $2, $3)', [e.enquiry_no, d.quotation_no, 'ONC/77']);
      assert.deepEqual(hooks, []);
    } finally {
      await db.query(`DELETE FROM webhook_endpoints WHERE name = 'n8n-hist'`);
    }
  });

  test('a PO with no basic value whose lines add up to the total makes a quotation of that total, not 18% more', async () => {
    const box = await mailbox();
    const msg = poEmail({ from: { email: 'buyer@gross-lines.com' },
      attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: 'GL/1', buyer: 'Gross Lines Ltd' }) }] });
    ai(reading({ po_number: 'GL/1', buyer: { company_name: 'Gross Lines Ltd' }, basic_value: null,
      lines: [{ description: 'EcoVadis assessment', qty: 1, rate: '2,95,000.00', amount: '2,95,000.00' }] }));
    await deliver(box, [msg]);
    const po = await poRow('GL/1');
    const { rows: [q] } = await db.query('SELECT total::float, subtotal::float FROM quotations WHERE quotation_no = $1', [po.quotation_no]);
    assert.deepEqual([q.subtotal, q.total], [250000, 295000]);
  });

  test('two registrations of one PO number in two spellings at once: one gets in', async () => {
    await client('Acme Race Ltd', 'anil@acme-race.co.in');
    const a = await quotation('Acme Race Ltd');
    const b = await quotation('Acme Race Ltd');
    const results = await Promise.all([
      agent.post(`/api/quotations/${encodeURIComponent(a.quotation_no)}/register`).send({ po_number: 'RACE-777', po_date: day(1) }),
      agent.post(`/api/quotations/${encodeURIComponent(b.quotation_no)}/register`).send({ po_number: 'race 777', po_date: day(1) }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 422]);
    const { rows } = await db.query(`SELECT 1 FROM purchase_orders WHERE lower(regexp_replace(po_number, '[^a-zA-Z0-9]', '', 'g')) = 'race777'`);
    assert.equal(rows.length, 1);
  });

  test('reading a review item again counts against the daily AI ceiling', async () => {
    const box = await mailbox();
    await client('Acme Count Ltd', 'anil@acme-count.co.in');
    await quotation('Acme Count Ltd');
    ai(reading({ po_number: '4500777001', confidence: 0.5 }));
    const msg = poEmail({ from: { email: 'anil@acme-count.co.in' }, attachments: [{ name: 'po.pdf', contentType: 'application/pdf', content: await poPdf({ number: '4500777001', buyer: 'Acme Count Ltd' }) }] });
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    const before = await autoEnquiry.aiCallsToday();
    await agent.post(`/api/purchase-orders/review/${d.id}/register`).expect(200);
    assert.equal(await autoEnquiry.aiCallsToday(), before + 1);
  });

  test('retrying a PO email the tracker never stored reads it from the mailbox, body and all', async () => {
    const box = await mailbox();
    const msg = poEmail({ from: { email: 'notify@ansmtp.ariba.com', name: 'Ariba' }, has_attachments: false, history: true,
      body_html: '<p>Purchase order 4500066001 from Portal Buyer Ltd: EcoVadis assessment, total INR 2,95,000.</p>' });
    sync.pushTestMessages(box.id, [msg]);
    await db.query(
      `INSERT INTO email_po_decisions (account_id, provider_id, internet_message_id, conversation_id, from_email, received_at, outcome, method, retry_since)
       VALUES ($1, $2, $3, $4, $5, $6, 'retry', 'ai', now())`,
      [box.id, msg.provider_id, msg.internet_message_id, msg.conversation_id, msg.from.email, msg.sent_at]);
    const calls = ai({ is_purchase_order: false, document_type: 'other', confidence: 0.9 });
    await autoPo.retryPoReads(await autoPo.poRunContext({ backfill: true }));
    assert.equal(calls.length, 1);
    assert.match(calls[0].user, /4500066001 from Portal Buyer Ltd/, 'the AI was given the email, not an empty message');
  });

  test('a PO email still unreadable after a week goes to review, and someone is told', async () => {
    const box = await mailbox();
    const providerId = uid('m');
    await db.query(
      `INSERT INTO email_po_decisions (account_id, provider_id, from_email, received_at, outcome, method, retry_since)
       VALUES ($1, $2, 'buyer@week-old.co.in', now(), 'retry', 'ai', now() - interval '8 days')`, [box.id, providerId]);
    await autoPo.retryPoReads(await autoPo.poRunContext({ backfill: true }));
    const d = await decision(box.id, providerId);
    assert.deepEqual([d.outcome, d.review_reason], ['review', 'unreadable']);
    const { rows: [note] } = await db.query(`SELECT title FROM notifications WHERE dedupe_key = $1`, [`po-review:${box.id}:${providerId}`]);
    assert.match(note.title, /buyer@week-old\.co\.in could not be read for a week/);
  });
});
