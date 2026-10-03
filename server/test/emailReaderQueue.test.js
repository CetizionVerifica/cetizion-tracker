import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The readers' to-do list (src/lib/mailbox/readerQueue.js): an email whose
 * reading fails, or never starts, is read again on a later sync instead of
 * being lost once the delta link has moved past it.
 *
 * The PO reader stands in for all three: they settle the queue the same way.
 * A reading is made to fail for real: a trigger makes the database refuse
 * the PO's insert, as a deadlock or a dropped connection would.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `email_reader_queue_${process.pid}`;

let app; let agent; let db; let sync; let autoPo; let queue; let pdfmake;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;
const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const day = (daysAgo) => new Date(Date.now() + 330 * 60_000 - daysAgo * 864e5).toISOString().slice(0, 10);
const money = (v) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function mailbox() {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, is_shared, visibility, import_days) VALUES ('admin','test',$1,false,'share_everything',30) RETURNING *`,
    [`${uid('box')}@cetizionverifica.com`]);
  return a;
}

/** A client with a contact and one open quotation of 2,50,000 + GST. */
async function clientWithQuotation(name, email) {
  const { rows: [{ id }] } = await db.query('SELECT company_for($1) AS id', [name]);
  await db.query('INSERT INTO contacts (company_id, name, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, email.split('@')[0], email]);
  const { body } = await agent.post('/api/quotations').send({ client_name: name, service_quoted: 'EcoVadis', quotation_date: day(20), status: 'Submitted' }).expect(201);
  await agent.post('/api/quotation-lines').send({ quotation_id: body.data.id, description: 'EcoVadis assessment', qty: 1, rate: 250000, gst_rate: 18 }).expect(201);
  return body.data.quotation_no;
}

const poPdf = (number, buyer) => pdfmake.createPdf({ content: ['PURCHASE ORDER', buyer, 'To: Cetizion Verifica Pvt. Ltd.', `PO No: ${number}`,
  `1 EcoVadis assessment ${money(250000)}`, `Basic ${money(250000)}`, `IGST 18% ${money(45000)}`, `Total ${money(295000)}`, 'Payment: 100% on submission of report'] }).getBuffer();

const reading = (number, buyer) => ({
  is_purchase_order: true, document_type: 'purchase_order', confidence: 0.94, po_number: number, po_date: day(1), amendment_no: 0,
  buyer: { company_name: buyer }, vendor: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, our_quotation_ref: null, currency: 'INR',
  lines: [{ description: 'EcoVadis assessment', qty: 1, rate: money(250000), amount: money(250000) }],
  basic_value: money(250000), tax_value: money(45000), total_value: money(295000), gst_extra: false,
  payment_terms_text: '100% on submission of report', credit_days: 30, delivery_date: null, project_manager: {},
});

async function poEmail(number, buyer, from) {
  return {
    provider_id: uid('m'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
    from: { email: from, name: 'Anil' }, to: [{ email: 'sales@cetizionverifica.com' }], cc: [],
    subject: 'Purchase order for EcoVadis', body_html: '<p>Dear Sir, please find attached our purchase order.</p>',
    has_attachments: true, sent_at: at(0),
    attachments: [{ name: `PO_${number}.pdf`, contentType: 'application/pdf', content: await poPdf(number, buyer) }],
  };
}

const upload = async ({ buffer, fileName, contentType }) => (await db.query(
  'INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id', [uid('key'), fileName, contentType, buffer.length])).rows[0];

/** The database refuses every new PO until healed: an error no reader expects. */
const breakDatabase = () => db.query(`
  CREATE OR REPLACE FUNCTION test_refuse_po() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN RAISE EXCEPTION 'database hiccup'; END $$;
  DROP TRIGGER IF EXISTS test_refuse_po ON purchase_orders;
  CREATE TRIGGER test_refuse_po BEFORE INSERT ON purchase_orders FOR EACH ROW EXECUTE FUNCTION test_refuse_po();`);
const healDatabase = () => db.query('DROP TRIGGER IF EXISTS test_refuse_po ON purchase_orders');

const queued = async (accountId, providerId) => (await db.query(
  'SELECT reader, attempts, last_error, failed_at FROM email_reader_queue WHERE account_id = $1 AND provider_id = $2 ORDER BY reader', [accountId, providerId])).rows;
const poRow = async (no) => (await db.query('SELECT * FROM purchase_orders WHERE po_number = $1', [no])).rows[0];
const due = (accountId) => db.query(`UPDATE email_reader_queue SET next_attempt_at = now() - interval '1 second' WHERE account_id = $1`, [accountId]);

describe('the readers\' queue', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
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
    queue = await import('../src/lib/mailbox/readerQueue.js');
    ({ default: pdfmake } = await import('../src/lib/pdf.js'));
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  beforeEach(async () => {
    autoPo.deps.upload = upload;
    autoPo.deps.chat = null;
    await healDatabase();
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

  test('an email read without trouble leaves the queue as soon as its reader is done', async () => {
    const box = await mailbox();
    await clientWithQuotation('Queue One Ltd', 'anil@queue-one.co.in');
    const msg = await poEmail('4500070001', 'Queue One Ltd', 'anil@queue-one.co.in');
    autoPo.deps.chat = async () => reading('4500070001', 'Queue One Ltd');
    sync.pushTestMessages(box.id, [msg]);
    const r = await sync.syncAccount(box.id);
    assert.equal(r.purchase_orders?.registered, 1, JSON.stringify(r));
    assert.deepEqual(await queued(box.id, msg.provider_id), []);
  });

  test('a reading that throws stays queued, and the next sync reads it again and registers the PO', async () => {
    const box = await mailbox();
    await clientWithQuotation('Queue Two Ltd', 'anil@queue-two.co.in');
    const msg = await poEmail('4500070002', 'Queue Two Ltd', 'anil@queue-two.co.in');
    autoPo.deps.chat = async () => reading('4500070002', 'Queue Two Ltd');
    await breakDatabase();
    sync.pushTestMessages(box.id, [msg]);
    const first = await sync.syncAccount(box.id);
    assert.equal(first.purchase_orders?.errors, 1, JSON.stringify(first));
    assert.equal(await poRow('4500070002'), undefined);
    const [row] = await queued(box.id, msg.provider_id);
    assert.equal(row.reader, 'po');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /database hiccup/);
    assert.equal(row.failed_at, null);

    // Not due yet: a sync now leaves it alone.
    await healDatabase();
    const early = await sync.syncAccount(box.id);
    assert.equal(early.retried, undefined);
    assert.equal(await poRow('4500070002'), undefined);

    // Due: the message is fetched from the mailbox again (delta will not
    // hand it over twice) and read.
    await due(box.id);
    const second = await sync.syncAccount(box.id);
    assert.equal(second.retried?.retried, 1, JSON.stringify(second));
    assert.equal(second.retried?.purchase_orders?.registered, 1, JSON.stringify(second));
    assert.ok(await poRow('4500070002'), 'the PO is registered on the retry');
    assert.deepEqual(await queued(box.id, msg.provider_id), [], 'and leaves the queue');
  });

  test('mail stored but never handed to its readers (a crash) is read on the next sync', async () => {
    const box = await mailbox();
    await clientWithQuotation('Queue Three Ltd', 'anil@queue-three.co.in');
    const msg = await poEmail('4500070003', 'Queue Three Ltd', 'anil@queue-three.co.in');
    sync.pushTestMessages(box.id, [msg]);
    // ingest() stores and queues, as a sync does before its readers run;
    // the readers never run, as if the process stopped right there.
    const { messages } = await sync.providerFor(box).delta('inbox', null, at(30));
    const stored = await sync.ingest(box, messages.map((m) => ({ ...m, folder: 'inbox' })));
    assert.equal(stored.stored, 1);
    assert.deepEqual((await queued(box.id, msg.provider_id)).map((q) => q.reader), ['enquiry', 'po'], 'queued in the transaction that stored it');

    autoPo.deps.chat = async () => reading('4500070003', 'Queue Three Ltd');
    const r = await sync.syncAccount(box.id);
    assert.equal(r.stored, 0, 'nothing new from the mailbox');
    assert.equal(r.retried?.purchase_orders?.registered, 1, JSON.stringify(r));
    assert.ok(await poRow('4500070003'));
    assert.deepEqual(await queued(box.id, msg.provider_id), []);
  });

  test('a message the mailbox no longer has is read from the stored copy', async () => {
    const box = await mailbox();
    const providerId = uid('gone');
    const { rows: [t] } = await db.query(`INSERT INTO email_threads (account_id, conversation_id, subject) VALUES ($1, $2, 'Hello') RETURNING id`, [box.id, uid('conv')]);
    await db.query(
      `INSERT INTO email_messages (account_id, thread_id, provider_id, direction, from_email, to_emails, subject, body_html, sent_at)
       VALUES ($1, $2, $3, 'inbound', 'someone@client.example', ARRAY['sales@cetizionverifica.com'], 'Hello', '<p>Hi</p>', now())`, [box.id, t.id, providerId]);
    await db.query(`INSERT INTO email_reader_queue (account_id, provider_id, reader, cand) VALUES ($1, $2, 'po', $3)`,
      [box.id, providerId, JSON.stringify({ c: { direction: 'inbound', external: [{ email: 'someone@client.example' }] }, threadId: t.id, newThread: true, dropped: false })]);
    const r = await queue.retryQueued(box, sync.providerFor(box));
    assert.equal(r.retried, 1);
    assert.ok(r.purchase_orders, JSON.stringify(r));
    assert.deepEqual(await queued(box.id, providerId), [], 'read from the copy, and settled');
  });

  test('after the last attempt the email stops being retried, and admins are told', async () => {
    const box = await mailbox();
    await clientWithQuotation('Queue Four Ltd', 'anil@queue-four.co.in');
    const msg = await poEmail('4500070004', 'Queue Four Ltd', 'anil@queue-four.co.in');
    autoPo.deps.chat = async () => reading('4500070004', 'Queue Four Ltd');
    await breakDatabase();
    sync.pushTestMessages(box.id, [msg]);
    await sync.syncAccount(box.id);
    await db.query('UPDATE email_reader_queue SET attempts = $3 - 1 WHERE account_id = $1 AND provider_id = $2', [box.id, msg.provider_id, queue.MAX_ATTEMPTS]);
    await due(box.id);
    await sync.syncAccount(box.id);
    const [row] = await queued(box.id, msg.provider_id);
    assert.equal(row.attempts, queue.MAX_ATTEMPTS);
    assert.ok(row.failed_at, 'given up');
    const { rows: [note] } = await db.query(`SELECT title FROM notifications WHERE kind = 'mailbox' AND title LIKE $1`, [`%${box.email}%`]);
    assert.match(note.title, /could not be read for a purchase order/);

    // Given up: not retried again, however due.
    await healDatabase();
    await due(box.id);
    const r = await sync.syncAccount(box.id);
    assert.equal(r.retried, undefined);
  });

  test('a reader switched off clears its queue rather than keeping it for ever', async () => {
    const box = await mailbox();
    await clientWithQuotation('Queue Five Ltd', 'anil@queue-five.co.in');
    const msg = await poEmail('4500070005', 'Queue Five Ltd', 'anil@queue-five.co.in');
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'auto_po_enabled'`);
    try {
      sync.pushTestMessages(box.id, [msg]);
      await sync.syncAccount(box.id);
      assert.deepEqual((await queued(box.id, msg.provider_id)).filter((q) => q.reader === 'po'), []);
    } finally {
      await db.query(`UPDATE settings SET value = 'true' WHERE key = 'auto_po_enabled'`);
    }
  });

  test('disconnecting a mailbox empties its queue', async () => {
    const box = await mailbox();
    await db.query(`INSERT INTO email_reader_queue (account_id, provider_id, reader, cand) VALUES ($1, $2, 'enquiry', '{}')`, [box.id, uid('m')]);
    await sync.disconnect(box.id);
    const { rows } = await db.query('SELECT 1 FROM email_reader_queue WHERE account_id = $1', [box.id]);
    assert.equal(rows.length, 0);
  });
});
