import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, beforeEach, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Invoices we email to clients, recorded on the right payment stage
 * (docs/email-po-plan.md §3.10, §8 scenarios 16–28).
 *
 * Mail goes in through the in-memory `test` mailbox provider and the real
 * sync. The AI is a fake that answers with the reading each test gives it;
 * document storage is a fake that records a documents row; PDFs are real.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `email_invoices_${process.pid}`;

let app; let agent; let db; let sync; let autoInvoice; let autoPo; let autoEnquiry; let pdfmake; let fy;
let n = 0;
const uid = (p) => `${p}-${process.pid}-${(n += 1)}`;
const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const day = (daysAgo) => new Date(Date.now() + 330 * 60_000 - daysAgo * 864e5).toISOString().slice(0, 10);
const money = (v) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function mailbox() {
  const { rows: [a] } = await db.query(
    `INSERT INTO connected_accounts (username, provider, email, visibility, import_days) VALUES ('admin','test',$1,'share_everything',30) RETURNING *`,
    [`${uid('accounts')}@cetizionverifica.com`]);
  return a;
}

/** A client, its contact, and a PO for 2,95,000 with two 50% stages of 1,47,500. */
async function poFor(name, poNumber, { poDate = day(30), credit = 30 } = {}) {
  const email = `accounts@${name.toLowerCase().replace(/[^a-z]+/g, '-')}.co.in`;
  const { rows: [{ id: companyId }] } = await db.query('SELECT company_for($1) AS id', [name]);
  await db.query(`INSERT INTO contacts (company_id, name, email, is_billing) VALUES ($1, 'Accounts', $2, true) ON CONFLICT DO NOTHING`, [companyId, email]);
  const { body } = await agent.post('/api/quotations').send({ client_name: name, service_quoted: 'EcoVadis', quotation_date: poDate }).expect(201);
  await agent.post('/api/quotation-lines').send({ quotation_id: body.data.id, description: 'EcoVadis assessment', qty: 1, rate: 250000, gst_rate: 18 }).expect(201);
  await agent.post(`/api/quotations/${encodeURIComponent(body.data.quotation_no)}/register`).send({
    po_number: poNumber, po_date: poDate, payment_terms_days: credit,
    stages: [{ stage_name: 'Advance (50%)', trigger_event: 'On PO Registration', percent: 50 }, { stage_name: 'On delivery (50%)', trigger_event: 'On Delivery', percent: 50 }],
  }).expect(201);
  return { email, companyId, quotationNo: body.data.quotation_no };
}

const invoicePdf = ({ no, buyer, po = '', taxable = 125000, tax = 22500, title = 'TAX INVOICE', seller = 'Cetizion Verifica Pvt. Ltd.' }) =>
  pdfmake.createPdf({ content: [title, seller, `Invoice No: ${no}`, `Bill to: ${buyer}`, po ? `PO No: ${po}` : '',
    `Taxable value ${money(taxable)}`, `IGST 18% ${money(tax)}`, `Total ${money(taxable + tax)}`] }).getBuffer();

const reading = (over = {}) => {
  const taxable = over.taxable ?? 125000; const tax = over.tax ?? 22500;
  const { taxable: _t, tax: _x, ...rest } = over;
  return {
    document_type: 'tax_invoice', confidence: 0.94, revised_or_cancelled: false, invoice_no: 'INV-1', invoice_date: day(1),
    seller: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, buyer: { company_name: 'Acme' }, po_reference: null, project_reference: null,
    quotation_reference: null, currency: 'INR', taxable_value: money(taxable), tax_value: money(tax), total_value: money(taxable + tax), stage_hint: null, due_date: null,
    ...rest,
  };
};

function ai(...answers) {
  const calls = [];
  autoInvoice.deps.chat = async (system) => {
    calls.push(system);
    if (!/whether it is our tax invoice/.test(system)) throw new Error('only invoices are read here');
    return answers.length > 1 ? answers.shift() : answers[0];
  };
  return calls;
}

/** Our invoice email, sent from `box` to the client. */
const invoiceEmail = (box, to, { no, buyer, po, taxable, tax, subject, sent = at(0), title, history = false, seller } = {}) => ({
  folder: 'sentitems', provider_id: uid('sent'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@cetizion>`,
  from: { email: box.email }, to: [{ email: to, name: 'Accounts' }], cc: [], subject: subject || `Invoice ${no}`,
  body_html: '<p>Dear Sir, please find attached our invoice.</p>', has_attachments: true, sent_at: sent, history,
  attachments: [{ name: `${String(no).replace(/\//g, '-')}.pdf`, contentType: 'application/pdf', content: null, _pdf: { no, buyer, po, taxable, tax, title, seller } }],
});

async function deliver(account, messages) {
  for (const m of messages) for (const a of m.attachments || []) if (a._pdf) { a.content = await invoicePdf(a._pdf); delete a._pdf; }
  sync.pushTestMessages(account.id, messages);
  return sync.syncAccount(account.id);
}

const decision = async (accountId, providerId) => (await db.query('SELECT * FROM email_invoice_decisions WHERE account_id = $1 AND provider_id = $2', [accountId, providerId])).rows[0];
const stagesOf = async (po) => (await db.query('SELECT * FROM v_payment_stages WHERE po_number = $1 ORDER BY stage_no', [po])).rows;

describe('invoices from email', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
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
    autoInvoice = await import('../src/lib/mailbox/autoInvoice.js');
    autoPo = await import('../src/lib/mailbox/autoPurchaseOrder.js');
    autoEnquiry = await import('../src/lib/mailbox/autoEnquiry.js');
    ({ default: pdfmake } = await import('../src/lib/pdf.js'));
    fy = (await import('../src/lib/sequences.js')).financialYear;
    (await import('../src/lib/ai.js')).aiConfig.enabled = false;
    const upload = async ({ buffer, fileName, contentType }) => (await db.query(
      'INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ($1,$2,$3,$4) RETURNING id', [uid('key'), fileName, contentType, buffer.length])).rows[0];
    autoInvoice.deps.upload = upload;
    autoPo.deps.upload = upload;
    await db.query(`INSERT INTO webhook_endpoints (name, url, events, secret) VALUES ('n8n', 'https://example.test/hook', ARRAY['invoice.issued'], 's')`);
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  beforeEach(async () => {
    autoInvoice.deps.chat = null;
    autoPo.deps.chat = null;
    await db.query(`UPDATE settings SET value = 'true' WHERE key IN ('auto_invoice_enabled', 'auto_po_enabled')`);
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

  test('16 and 17. an invoice citing the PO is recorded on stage 1, with its PDF; the balance goes to stage 2', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Sixteen Ltd', '4500016016');
    const no = `CVPL/${fy(day(2))}/0901`;
    ai(reading({ invoice_no: no, invoice_date: day(2), buyer: { company_name: 'Acme Sixteen Ltd' }, po_reference: '4500016016', stage_hint: '50% advance' }));
    const msg = invoiceEmail(box, client.email, { no, buyer: 'Acme Sixteen Ltd', po: '4500016016', sent: at(1) });
    const r = await deliver(box, [msg]);
    assert.equal(r.invoices?.recorded, 1, JSON.stringify(r));
    const [s1, s2] = await stagesOf('4500016016');
    assert.deepEqual([s1.invoice_no, String(s1.invoice_date).slice(0, 10)], [no, day(2)]);
    assert.ok(s1.document_id, 'the PDF is on the stage');
    assert.notEqual(s1.stage_status, 'To Invoice');
    assert.equal(s2.invoice_no, null);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.mode, d.stage_id, d.po_number, d.invoice_no], ['recorded', 'live', s1.id, '4500016016', no]);
    const { body: origin } = await agent.get(`/api/mail/origin?entity=payment_stage&id=${s1.id}`).expect(200);
    assert.equal(origin.data.mailbox, box.email);
    const { body: fromEmail } = await agent.get('/api/payment-stages?from_email=1').expect(200);
    assert.deepEqual(fromEmail.data.map((s) => s.id), [s1.id], 'Source → Invoice recorded from email');
    const { rows: hooks } = await db.query(`SELECT 1 FROM webhook_events WHERE event = 'invoice.issued' AND entity_id = $1`, [String(s1.id)]);
    assert.equal(hooks.length, 1, 'live: invoice.issued fires');
    const { rows: [note] } = await db.query(`SELECT title FROM notifications WHERE kind = 'invoice_recorded' AND entity_id = '4500016016'`);
    assert.equal(note.title, `Invoice ${no} recorded from email on PO 4500016016`);

    const balance = `CVPL/${fy(day(0))}/0902`;
    ai(reading({ invoice_no: balance, invoice_date: day(0), buyer: { company_name: 'Acme Sixteen Ltd' }, po_reference: '4500016016', stage_hint: 'Balance 50%' }));
    await deliver(box, [invoiceEmail(box, client.email, { no: balance, buyer: 'Acme Sixteen Ltd', po: '4500016016' })]);
    assert.equal((await stagesOf('4500016016'))[1].invoice_no, balance);
  });

  test('18. an invoice for 40% of a 50/50 PO goes to review, and nothing is recorded', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Eighteen Ltd', '4500018018');
    ai(reading({ invoice_no: 'INV-18', buyer: { company_name: 'Acme Eighteen Ltd' }, po_reference: '4500018018', taxable: 100000, tax: 18000 }));
    const msg = invoiceEmail(box, client.email, { no: 'INV-18', buyer: 'Acme Eighteen Ltd', po: '4500018018', taxable: 100000, tax: 18000 });
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.review_reason, d.po_number], ['review', 'amount_not_a_stage', '4500018018']);
    assert.ok((await stagesOf('4500018018')).every((s) => !s.invoice_no));
  });

  test('19. a proforma is logged not_invoice by the rules: no AI, nothing recorded, no number used', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Nineteen Ltd', '4500019019');
    const { rows: [before] } = await db.query(`SELECT last_n FROM sequence_counters WHERE kind = 'invoice' AND year = $1`, [fy()]);
    const calls = ai(reading());
    const msg = invoiceEmail(box, client.email, { no: 'PI-19', buyer: 'Acme Nineteen Ltd', subject: 'Proforma invoice for the advance', title: 'PROFORMA INVOICE' });
    await deliver(box, [msg]);
    assert.equal(calls.length, 0);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.document_type, d.method], ['not_invoice', 'proforma', 'rules']);
    const { rows: [after] } = await db.query(`SELECT last_n FROM sequence_counters WHERE kind = 'invoice' AND year = $1`, [fy()]);
    assert.equal(after?.last_n ?? null, before?.last_n ?? null);
  });

  test('20 and 28. a printed CVPL number is kept, and the tracker\'s next invoice is past it; the route still claims one when none is given', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Twenty Ltd', '4500020020');
    const no = `CVPL/${fy(day(1))}/0420`;
    ai(reading({ invoice_no: no, invoice_date: day(1), buyer: { company_name: 'Acme Twenty Ltd' }, po_reference: '4500020020' }));
    await deliver(box, [invoiceEmail(box, client.email, { no, buyer: 'Acme Twenty Ltd', po: '4500020020' })]);
    const [s1, s2] = await stagesOf('4500020020');
    assert.equal(s1.invoice_no, no);
    const { body } = await agent.post(`/api/payment-stages/${s2.id}/invoice`).send({ invoice_date: day(1) }).expect(200);
    const next = Number(body.data.invoice_no.split('/').pop());
    assert.ok(next > 420, `the next number, ${body.data.invoice_no}, is past the printed one`);
  });

  test('21. a stage that already has a document keeps it', async () => {
    const box = await mailbox();
    const client = await poFor('Acme TwentyOne Ltd', '4500021021');
    const [s1] = await stagesOf('4500021021');
    const { rows: [doc] } = await db.query(`INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ($1, 'ours.pdf', 'application/pdf', 10) RETURNING id`, [uid('key')]);
    await db.query('UPDATE payment_stages SET document_id = $2 WHERE id = $1', [s1.id, doc.id]);
    ai(reading({ invoice_no: 'INV-21', buyer: { company_name: 'Acme TwentyOne Ltd' }, po_reference: '4500021021' }));
    const msg = invoiceEmail(box, client.email, { no: 'INV-21', buyer: 'Acme TwentyOne Ltd', po: '4500021021' });
    await deliver(box, [msg]);
    const [now] = await stagesOf('4500021021');
    assert.deepEqual([now.invoice_no, now.document_id], ['INV-21', doc.id]);
    assert.equal((await decision(box.id, msg.provider_id)).document_kept_existing, true);
  });

  test('22. a number already on another PO\'s stage goes to review; the same invoice again is linked', async () => {
    const box = await mailbox();
    const a = await poFor('Acme TwentyTwo Ltd', '4500022022');
    await poFor('Other TwentyTwo Ltd', '4500022099');
    const [other] = await stagesOf('4500022099');
    await agent.post(`/api/payment-stages/${other.id}/invoice`).send({ invoice_no: 'INV 22', invoice_date: day(5) }).expect(200);
    ai(reading({ invoice_no: 'inv-22', buyer: { company_name: 'Acme TwentyTwo Ltd' }, po_reference: '4500022022' }));
    const msg = invoiceEmail(box, a.email, { no: 'inv-22', buyer: 'Acme TwentyTwo Ltd', po: '4500022022' });
    await deliver(box, [msg]);
    assert.equal((await decision(box.id, msg.provider_id)).review_reason, 'invoice_no_in_use');

    // Our own invoice, re-sent: linked, not recorded twice.
    ai(reading({ invoice_no: 'INV-22B', buyer: { company_name: 'Acme TwentyTwo Ltd' }, po_reference: '4500022022' }));
    const first = invoiceEmail(box, a.email, { no: 'INV-22B', buyer: 'Acme TwentyTwo Ltd', po: '4500022022' });
    await deliver(box, [first]);
    const again = invoiceEmail(box, a.email, { no: 'INV-22B', buyer: 'Acme TwentyTwo Ltd', po: '4500022022', subject: 'Reminder: Invoice INV-22B' });
    await deliver(box, [again]);
    assert.equal((await decision(box.id, again.provider_id)).outcome, 'linked');
    assert.equal((await stagesOf('4500022022')).filter((s) => s.invoice_no).length, 1);
  });

  test('23. an invoice read before its PO waits, is recorded once the PO is in, and goes to review after 7 days', async () => {
    const box = await mailbox();
    const email = 'accounts@acme-twentythree.co.in';
    ai(reading({ invoice_no: 'INV-23', buyer: { company_name: 'Acme TwentyThree Ltd' }, po_reference: '4500023023' }));
    const msg = invoiceEmail(box, email, { no: 'INV-23', buyer: 'Acme TwentyThree Ltd', po: '4500023023' });
    await deliver(box, [msg]);
    let d = await decision(box.id, msg.provider_id);
    assert.equal(d.outcome, 'waiting');
    assert.equal(d.reading.invoice_no, 'INV-23', 'the facts are kept for the retry, not the text');

    await poFor('Acme TwentyThree Ltd', '4500023023');
    autoInvoice.deps.chat = async () => { throw new Error('a retry must not call the AI'); };
    const run = await autoInvoice.runInvoiceBackfills();
    assert.ok(run.retried.recorded >= 1);
    d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.reading], ['recorded', null]);
    assert.equal((await stagesOf('4500023023'))[0].invoice_no, 'INV-23');
    assert.ok((await stagesOf('4500023023'))[0].document_id, 'the PDF, fetched again from the mailbox');

    ai(reading({ invoice_no: 'INV-23X', buyer: { company_name: 'Nobody Yet Ltd' }, po_reference: '4500023999' }));
    const lost = invoiceEmail(box, 'accounts@nobody-yet.co.in', { no: 'INV-23X', buyer: 'Nobody Yet Ltd', po: '4500023999' });
    await deliver(box, [lost]);
    await db.query(`UPDATE email_invoice_decisions SET decided_at = now() - interval '8 days' WHERE account_id = $1 AND provider_id = $2`, [box.id, lost.provider_id]);
    await autoInvoice.runInvoiceBackfills();
    assert.equal((await decision(box.id, lost.provider_id)).review_reason, 'po_not_found');
  });

  test('24. an eight-month-old invoice: recorded quietly, the client is not reminded, and it waits in "to settle" until paid', async () => {
    const box = await mailbox();
    const client = await poFor('Acme TwentyFour Ltd', '4500024024', { poDate: day(260) });
    ai(reading({ invoice_no: 'INV-24', invoice_date: day(240), buyer: { company_name: 'Acme TwentyFour Ltd' }, po_reference: '4500024024' }));
    const msg = invoiceEmail(box, client.email, { no: 'INV-24', buyer: 'Acme TwentyFour Ltd', po: '4500024024', sent: at(240) });
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.mode], ['recorded', 'history']);
    const [s1, s2] = await stagesOf('4500024024');
    assert.equal(s1.stage_status, 'Overdue');
    assert.equal((await db.query(`SELECT 1 FROM webhook_events WHERE entity_id = $1`, [String(s1.id)])).rows.length, 0, 'no invoice.issued');
    assert.equal((await db.query(`SELECT 1 FROM notifications WHERE kind = 'invoice_recorded' AND entity_id = '4500024024'`)).rows.length, 0);

    // A person records the other stage's old invoice: that one is theirs to chase.
    await db.query(`UPDATE purchase_orders SET actual_delivery_date = $2 WHERE po_number = $1`, ['4500024024', day(210)]);
    await agent.post(`/api/payment-stages/${s2.id}/invoice`).send({ invoice_no: 'INV-24-HAND', invoice_date: day(200) }).expect(200);
    const { runPaymentReminders } = await import('../src/lib/reminders.js');
    const sent = [];
    const out = await runPaymentReminders({ send: async (mail) => { sent.push(mail); return { status: 'sent', id: 1 }; } });
    const chased = out.sent.flatMap((r) => r.stages);
    assert.ok(chased.includes('INV-24-HAND'), 'the invoice a person recorded is chased');
    assert.ok(!chased.includes('INV-24'), 'the one read from past mail is not');

    const toSettle = async () => (await agent.get('/api/payment-stages?from_past_po=1').expect(200)).body.data.map((s) => s.invoice_no);
    assert.ok((await toSettle()).includes('INV-24'));
    await agent.post(`/api/payment-stages/${s1.id}/payment`).send({ amount_received: 147500, payment_received_date: day(200) }).expect(200);
    assert.ok(!(await toSettle()).includes('INV-24'), 'paid: settled');
  });

  test('25. a vendor\'s bill we sent on goes to review', async () => {
    const box = await mailbox();
    const client = await poFor('Acme TwentyFive Ltd', '4500025025');
    ai(reading({ invoice_no: 'PS-25', seller: { company_name: 'Print Shop' }, buyer: { company_name: 'Cetizion Verifica Pvt. Ltd.' } }));
    const msg = invoiceEmail(box, client.email, { no: 'PS-25', buyer: 'Cetizion Verifica', seller: 'Print Shop', subject: 'Bill from the printer' });
    await deliver(box, [msg]);
    assert.equal((await decision(box.id, msg.provider_id)).review_reason, 'not_from_us');
  });

  test('26. the invoice backfill waits for the PO backfill, then puts the past invoice on the past PO\'s stage', async () => {
    const box = await mailbox();
    const email = 'buyer@acme-twentysix.co.in';
    const { rows: [{ id: co }] } = await db.query(`SELECT company_for('Acme TwentySix Ltd') AS id`);
    await db.query(`INSERT INTO contacts (company_id, name, email) VALUES ($1, 'Buyer', $2)`, [co, email]);
    const { body: q } = await agent.post('/api/quotations').send({ client_name: 'Acme TwentySix Ltd', service_quoted: 'EcoVadis', quotation_date: day(300), status: 'Submitted' }).expect(201);
    await agent.post('/api/quotation-lines').send({ quotation_id: q.data.id, description: 'EcoVadis assessment', qty: 1, rate: 250000, gst_rate: 18 }).expect(201);
    const poPdf = await pdfmake.createPdf({ content: ['PURCHASE ORDER', 'Acme TwentySix Ltd', 'To: Cetizion Verifica Pvt. Ltd.', 'PO No: 4500026026',
      'Basic 2,50,000.00', 'IGST 45,000.00', 'Total 2,95,000.00', 'Payment: 50% advance, balance on report'] }).getBuffer();
    sync.pushTestMessages(box.id, [{
      folder: 'inbox', history: true, provider_id: uid('po'), conversation_id: uid('conv'), internet_message_id: `<${uid('mid')}@client>`,
      from: { email }, to: [{ email: box.email }], subject: `RE: ${q.data.quotation_no}`, body_html: '<p>Our purchase order is attached.</p>',
      has_attachments: true, sent_at: at(250), attachments: [{ name: 'PO.pdf', contentType: 'application/pdf', content: poPdf }],
    }]);
    const sentInvoice = invoiceEmail(box, email, { no: 'INV-26', buyer: 'Acme TwentySix Ltd', po: '4500026026', sent: at(230), history: true });
    for (const a of sentInvoice.attachments) { a.content = await invoicePdf(a._pdf); delete a._pdf; }
    sync.pushTestMessages(box.id, [sentInvoice]);

    autoPo.deps.chat = async () => ({
      is_purchase_order: true, document_type: 'purchase_order', confidence: 0.95, po_number: '4500026026', po_date: day(251),
      buyer: { company_name: 'Acme TwentySix Ltd' }, vendor: { company_name: 'Cetizion Verifica Pvt. Ltd.' }, our_quotation_ref: q.data.quotation_no,
      currency: 'INR', lines: [], basic_value: '2,50,000.00', tax_value: '45,000.00', total_value: '2,95,000.00',
      payment_terms_text: '50% advance, balance on report', credit_days: 30,
    });
    ai(reading({ invoice_no: 'INV-26', invoice_date: day(231), buyer: { company_name: 'Acme TwentySix Ltd' }, po_reference: '4500026026' }));

    const ctx = await autoInvoice.invoiceRunContext({ backfill: true });
    assert.equal((await autoInvoice.backfillInvoiceAccount(box, ctx)).waiting, 'PO backfill');
    await autoEnquiry.backfillAccount(box, await autoEnquiry.runContext({ backfill: true }));
    await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
    // Other mailboxes in this database never read their POs: a day later, this one goes ahead.
    await db.query(`UPDATE mailbox_po_backfills SET finished_at = now() - interval '25 hours' WHERE account_id = $1`, [box.id]);
    const r = await autoInvoice.backfillInvoiceAccount(box, await autoInvoice.invoiceRunContext({ backfill: true }));
    assert.deepEqual([r.recorded, r.finished], [1, true]);
    const [s1] = await stagesOf('4500026026');
    assert.equal(s1.invoice_no, 'INV-26', 'the history PO\'s stage gets its invoice from the same year of mail');
    const { rows: [summary] } = await db.query(`SELECT title FROM notifications WHERE dedupe_key LIKE $1`, [`auto-invoice-backfill:${box.id}:%`]);
    assert.match(summary.title, /for invoices: 1 recorded, 0 to review/);
  });

  test('26b. a re-run of POs does not hold the invoice backfill back: the past mail was read through once', async () => {
    const box = await mailbox();
    await autoEnquiry.backfillAccount(box, await autoEnquiry.runContext({ backfill: true }));
    await autoPo.backfillPoAccount(box, await autoPo.poRunContext({ backfill: true }));
    await db.query(`UPDATE connected_accounts SET past_pos_read_at = now() - interval '25 hours' WHERE id = $1`, [box.id]);
    await agent.post(`/api/mailboxes/${box.id}/auto-enquiries/rerun`).send({ kind: 'pos' }).expect(200);
    assert.equal(await autoInvoice.posReadUpTo(box.id), true);
    const r = await autoInvoice.backfillInvoiceAccount(box, await autoInvoice.invoiceRunContext({ backfill: true }));
    assert.deepEqual([r.waiting, r.finished], [undefined, true]);
  });

  test('27. auto_invoice_enabled off: no invoices are read', async () => {
    await db.query(`UPDATE settings SET value = 'false' WHERE key = 'auto_invoice_enabled'`);
    const box = await mailbox();
    const client = await poFor('Acme TwentySeven Ltd', '4500027027');
    const calls = ai(reading());
    const msg = invoiceEmail(box, client.email, { no: 'INV-27', buyer: 'Acme TwentySeven Ltd', po: '4500027027' });
    const r = await deliver(box, [msg]);
    assert.equal(calls.length, 0);
    assert.equal(r.invoices, undefined);
    assert.equal(await decision(box.id, msg.provider_id), undefined);
  });

  test('the invoice review queue: listed, read again, recorded by hand, or dismissed', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Review Inv Ltd', '4500031031');
    const send = async (no) => {
      ai(reading({ invoice_no: no, buyer: { company_name: 'Acme Review Inv Ltd' }, po_reference: '4500031031', taxable: 100000, tax: 18000 }));
      const msg = invoiceEmail(box, client.email, { no, buyer: 'Acme Review Inv Ltd', po: '4500031031', taxable: 100000, tax: 18000 });
      await deliver(box, [msg]);
      return decision(box.id, msg.provider_id);
    };
    const first = await send('INV-R1');
    const second = await send('INV-R2');
    const { body: list } = await agent.get('/api/payment-stages/invoice-review').expect(200);
    const row = list.data.find((r) => r.id === first.id);
    assert.deepEqual([row.review_reason, row.po_number, row.stages.length], ['amount_not_a_stage', '4500031031', 2]);

    ai(reading({ invoice_no: 'INV-R1', invoice_date: day(1), buyer: { company_name: 'Acme Review Inv Ltd' }, po_reference: '4500031031', taxable: 100000, tax: 18000 }));
    const { body: pre } = await agent.post(`/api/payment-stages/invoice-review/${first.id}/record`).expect(200);
    assert.deepEqual([pre.data.prefill.invoice_no, pre.data.prefill.total_value], ['INV-R1', 118000]);
    assert.ok(pre.data.prefill.document_id);
    assert.ok(pre.data.suggested_stage_id);

    // The reviewer re-splits, then records (§3.10.3): here, straight onto stage 1.
    await agent.post(`/api/payment-stages/${pre.data.suggested_stage_id}/invoice`)
      .send({ invoice_no: pre.data.prefill.invoice_no, invoice_date: pre.data.prefill.invoice_date, document_id: pre.data.prefill.document_id, review_id: first.id })
      .expect(200);
    const settled = (await db.query('SELECT * FROM email_invoice_decisions WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual([settled.outcome, settled.stage_id, settled.invoice_no, settled.decided_by], ['recorded_by_hand', pre.data.suggested_stage_id, 'INV-R1', 'admin']);

    await agent.post(`/api/payment-stages/invoice-review/${second.id}/dismiss`).expect(200);
    await agent.post(`/api/payment-stages/invoice-review/${second.id}/dismiss`).expect(404);
    const { body: after } = await agent.get('/api/payment-stages/invoice-review').expect(200);
    assert.ok(!after.data.some((r) => [first.id, second.id].includes(r.id)));
  });
  // ------------------------------------------------------------ review fixes

  test('an invoice email with no PDF costs no AI call, and is decided by the rules', async () => {
    const box = await mailbox();
    const client = await poFor('Acme NoPdf Ltd', '4500041041');
    const calls = ai(reading());
    const msg = invoiceEmail(box, client.email, { no: 'X-1', buyer: 'Acme NoPdf Ltd' });
    msg.attachments = [{ name: 'invoice-sheet.xlsx', contentType: 'application/vnd.ms-excel', content: Buffer.from('not a pdf') }];
    delete msg.attachments[0]._pdf;
    // The live mailbox says only that something is attached: the files stay
    // with the provider, the message carries no list.
    sync.pushTestMessages(box.id, [msg]);
    delete msg.attachments;
    await sync.syncAccount(box.id);
    assert.equal(calls.length, 0);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.method], ['not_invoice', 'rules']);
  });

  test('a live invoice the AI could not read waits unread, and the job reads it later', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Unread Ltd', '4500042042');
    autoInvoice.deps.chat = async () => { throw new Error('timeout'); };
    const msg = invoiceEmail(box, client.email, { no: 'INV-42', buyer: 'Acme Unread Ltd', po: '4500042042' });
    await deliver(box, [msg]);
    let d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.reading, d.ai_calls], ['waiting', null, 1]);
    ai(reading({ invoice_no: 'INV-42', buyer: { company_name: 'Acme Unread Ltd' }, po_reference: '4500042042' }));
    await autoInvoice.runInvoiceBackfills();
    d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.ai_calls], ['recorded', 2]);
    assert.equal((await stagesOf('4500042042'))[0].invoice_no, 'INV-42');
  });

  test('a review item naming an invoiced stage suggests an open one; one with no PO is recorded by hand on the PO chosen', async () => {
    const box = await mailbox();
    const client = await poFor('Acme Suggest Ltd', '4500043043');
    const [s1, s2] = await stagesOf('4500043043');
    await agent.post(`/api/payment-stages/${s1.id}/invoice`).send({ invoice_no: 'INV-43', invoice_date: day(3) }).expect(200);
    const { rows: [revised] } = await db.query(
      `INSERT INTO email_invoice_decisions (account_id, provider_id, outcome, review_reason, method, po_number, stage_id, invoice_no)
       VALUES ($1, $2, 'review', 'revised', 'ai', '4500043043', $3, 'INV-43') RETURNING id`, [box.id, uid('rev'), s1.id]);
    ai(reading({ invoice_no: 'INV-43', buyer: { company_name: 'Acme Suggest Ltd' } }));
    const { body } = await agent.post(`/api/payment-stages/invoice-review/${revised.id}/record`).expect(200);
    assert.equal(body.data.suggested_stage_id, s2.id, 'never the stage that already has an invoice');

    const { rows: [noPo] } = await db.query(
      `INSERT INTO email_invoice_decisions (account_id, provider_id, outcome, review_reason, method, invoice_no)
       VALUES ($1, $2, 'review', 'po_not_found', 'ai', 'INV-43B') RETURNING id`, [box.id, uid('nopo')]);
    await agent.post(`/api/payment-stages/${s2.id}/invoice`).send({ invoice_no: 'INV-43B', invoice_date: day(1), review_id: noPo.id }).expect(200);
    const settled = (await db.query('SELECT outcome, po_number, stage_id FROM email_invoice_decisions WHERE id = $1', [noPo.id])).rows[0];
    assert.deepEqual(settled, { outcome: 'recorded_by_hand', po_number: '4500043043', stage_id: s2.id });
    void client;
  });

  // ---------------------------------------------------------- wrong PO

  test('an invoice citing a PO not in the tracker waits for it, rather than landing on another PO with a stage of that amount', async () => {
    const box = await mailbox();
    const { email } = await poFor('Recurring Audit Ltd', 'RA-1001');
    const msg = invoiceEmail(box, email, { no: 'CVPL/WAIT/0001', buyer: 'Recurring Audit Ltd', po: 'RA-2002' });
    ai(reading({ invoice_no: 'CVPL/WAIT/0001', buyer: { company_name: 'Recurring Audit Ltd' }, po_reference: 'RA-2002' }));
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.equal(d.outcome, 'waiting', JSON.stringify(d));
    assert.deepEqual((await stagesOf('RA-1001')).map((st) => st.invoice_no), [null, null], 'the other PO is left alone');
  });

  test('an invoice to a client we cannot identify, naming a PO number another client has, goes to review', async () => {
    const box = await mailbox();
    await poFor('Short Numbers Ltd', '1001');
    const msg = invoiceEmail(box, 'accounts@never-seen-before.example', { no: 'CVPL/WHO/0001', buyer: 'Never Seen Before Pvt Ltd', po: '1001' });
    ai(reading({ invoice_no: 'CVPL/WHO/0001', buyer: { company_name: 'Never Seen Before Pvt Ltd' }, po_reference: '1001' }));
    await deliver(box, [msg]);
    const d = await decision(box.id, msg.provider_id);
    assert.deepEqual([d.outcome, d.review_reason], ['review', 'client_unknown'], JSON.stringify(d));
    assert.deepEqual((await stagesOf('1001')).map((st) => st.invoice_no), [null, null]);
  });

  test('an invoice citing nothing still finds its client\'s PO by the stage amount', async () => {
    const box = await mailbox();
    const { email } = await poFor('Cites Nothing Ltd', 'CN-1001');
    const msg = invoiceEmail(box, email, { no: 'CVPL/AMT/0001', buyer: 'Cites Nothing Ltd' });
    ai(reading({ invoice_no: 'CVPL/AMT/0001', buyer: { company_name: 'Cites Nothing Ltd' } }));
    await deliver(box, [msg]);
    assert.equal((await stagesOf('CN-1001'))[0].invoice_no, 'CVPL/AMT/0001');
  });
});
