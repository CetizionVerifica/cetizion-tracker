import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The client portal (#47) must never show one company another's data, and
 * its session must never open the staff API. Since #198 it also shows the
 * same figures we hold: POs with their schedule and what is still to bill,
 * invoices with taxable value, GST and total, and a staff preview of it.
 * Phase 2 lets the client answer (confirm, query, report a payment) and
 * share files both ways, each checked against the session's company. Runs against a throwaway
 * database, so it needs TEST_DATABASE_URL (CI sets it); skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `portal_test_${process.pid}`;
const USERNAME = 'tester';
const PASSWORD = 'a-good-long-test-password';

let app; let pool; let staff;
const cookieOf = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0];

async function seedFixtures(client) {
  await client.query(`
    INSERT INTO companies (id, name, portal_enabled) VALUES (1001, 'Alpha Industries', true), (1002, 'Beta Metals', true);
    -- portal_access is off by default, so the grant is explicit here too:
    -- an admin allows a named contact, which is what #47 asks for.
    INSERT INTO contacts (id, company_id, name, email, portal_access) VALUES (2001, 1001, 'Asha Alpha', 'asha@alpha.example', true), (2002, 1002, 'Bina Beta', 'bina@beta.example', true);
    INSERT INTO documents (id, storage_key, file_name, content_type, size_bytes) VALUES (3001, 'k/a', 'alpha-po.pdf', 'application/pdf', 10), (3002, 'k/b', 'beta-po.pdf', 'application/pdf', 10);
    INSERT INTO projects (project_id, client_name) VALUES ('PRJ-A', 'Alpha Industries'), ('PRJ-B', 'Beta Metals');
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, document_id) VALUES ('PO-A', 'PRJ-A', '2026-08-01', 100000, 3001), ('PO-B', 'PRJ-B', '2026-08-01', 200000, 3002);
    INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
      VALUES ('PO-A', 1, 'Advance', 'On PO Registration', 1, 'INV-A-1', '2026-08-02'), ('PO-B', 1, 'Advance', 'On PO Registration', 1, 'INV-B-1', '2026-08-02');
    INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sent_at)
      VALUES ('QT-A', 'Alpha Industries', '2026-07-01', 100000, 'Submitted', now()), ('QT-B', 'Beta Metals', '2026-07-01', 200000, 'Submitted', now());
    INSERT INTO deliverables (company_id, client_name, title, reference, valid_until) VALUES (1001, '', 'Alpha certificate', 'CERT-A', '2027-01-01'), (1002, '', 'Beta certificate', 'CERT-B', '2027-01-01');
  `);
  // #198: Alpha's figures. A PO from a quotation at two GST rates (18% and
  // 5%, so 15.4% in all), half invoiced and paid with TDS deducted; a
  // cancelled PO; a PO and the revision that replaced it; an export PO; and
  // Alpha's first invoice matched to the accounts import.
  await client.query(`
    INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status) VALUES ('QT-AL', 'Alpha Industries', '2026-07-05', 0, 'Won - PO Received');
    INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate)
      SELECT id, 'Stage 1 audit', 1, 400000, 18 FROM quotations WHERE quotation_no = 'QT-AL'
      UNION ALL SELECT id, 'Training', 1, 100000, 5 FROM quotations WHERE quotation_no = 'QT-AL';
    INSERT INTO documents (id, storage_key, file_name, content_type, size_bytes) VALUES (3003, 'k/inv', 'alpha-inv-2.pdf', 'application/pdf', 10);
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, quotation_no) VALUES ('PO-A2', 'PRJ-A', '2026-08-10', 577000, 'QT-AL');
    INSERT INTO po_services (po_number, service, service_value) VALUES ('PO-A2', 'Stage 1 audit', 400000), ('PO-A2', 'Training', 100000);
    INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, document_id)
      VALUES ('PO-A2', 1, 'Advance', 'On PO Registration', 0.5, 'INV-A-2', '2026-08-11', 3003);
    INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, hold_reason)
      VALUES ('PO-A2', 2, 'On delivery', 'On Delivery', 0.5, 'internal: waiting on the auditor');
    INSERT INTO payments (stage_id, amount, tds_amount, received_on) SELECT id, 280000, 8500, '2026-08-20' FROM payment_stages WHERE invoice_no = 'INV-A-2';
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, cancelled) VALUES ('PO-AX', 'PRJ-A', '2026-08-12', 50000, true);
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-AOLD', 'PRJ-A', '2026-08-13', 60000);
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, replaces_po_number) VALUES ('PO-ANEW', 'PRJ-A', '2026-08-14', 70000, 'PO-AOLD');
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency) VALUES ('PO-AUSD', 'PRJ-A', '2026-08-15', 5000, 'USD');
    INSERT INTO books_entries (id, source, kind, books_id, number, entry_date, taxable_amount, tax_amount, total_amount)
      VALUES (4001, 'file', 'invoice', 'B-1', 'INV-A-1', '2026-08-02', 84745.76, 15254.24, 100000);
    INSERT INTO reconciliation_items (kind, match_key, stage_id, books_entry_id, status)
      SELECT 'invoice', 'invoice:INV-A-1', id, 4001, 'matched' FROM payment_stages WHERE invoice_no = 'INV-A-1';
  `);
}

describe('client portal isolation', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    await seedFixtures(client);
    await client.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_USERNAME = USERNAME;
    process.env.AUTH_PASSWORD = PASSWORD;
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const signIn = await request(app).post('/api/auth/login').send({ username: USERNAME, password: PASSWORD });
    staff = cookieOf(signIn, 'cetizion_session');
  });

  after(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  async function portalLogin(contactId) {
    const invite = await request(app).post(`/api/portal-admin/contacts/${contactId}/invite`).set('Cookie', staff);
    assert.equal(invite.status, 200, JSON.stringify(invite.body));
    const token = invite.body.data.url.split('/').pop();
    const login = await request(app).post('/api/portal/login').send({ token });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return { cookie: cookieOf(login, 'cetizion_portal'), token };
  }

  test('asking for a link says the same thing for any address', async () => {
    const known = await request(app).post('/api/portal/request-link').send({ email: 'asha@alpha.example' });
    const unknown = await request(app).post('/api/portal/request-link').send({ email: 'nobody@nowhere.example' });
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);
  });

  test('a contact sees only their own company, on every list', async () => {
    const { cookie } = await portalLogin(2001);
    const me = await request(app).get('/api/portal/me').set('Cookie', cookie);
    assert.equal(me.body.data.company_name, 'Alpha Industries');
    const body = JSON.stringify(await Promise.all(['projects', 'documents', 'invoices', 'certificates', 'messages']
      .map((p) => request(app).get(`/api/portal/${p}`).set('Cookie', cookie).then((r) => { assert.equal(r.status, 200, p); return r.body; }))));
    for (const own of ['PRJ-A', 'PO-A', 'INV-A-1', 'QT-A', 'CERT-A']) assert.ok(body.includes(own), own);
    for (const other of ['PRJ-B', 'PO-B', 'INV-B-1', 'QT-B', 'CERT-B', 'Beta']) assert.ok(!body.includes(other), other);
  });

  test("another company's files and quotations are not found", async () => {
    const { cookie } = await portalLogin(2001);
    assert.equal((await request(app).get('/api/portal/files/document/3002').set('Cookie', cookie)).status, 404);
    assert.equal((await request(app).get('/api/portal/files/quotation/QT-B').set('Cookie', cookie)).status, 404);
    assert.notEqual((await request(app).get('/api/portal/files/document/3001').set('Cookie', cookie)).status, 404);
    const own = await request(app).get('/api/portal/files/quotation/QT-A').set('Cookie', cookie);
    assert.equal(own.status, 200);
    assert.equal(own.headers['content-type'], 'application/pdf');
  });

  test('a portal session opens nothing on the staff side, and the reverse', async () => {
    const { cookie } = await portalLogin(2001);
    const value = cookie.split('=')[1];
    for (const path of ['/api/projects', '/api/documents/3001', '/api/export/projects.csv', '/api/companies', '/api/lookups']) {
      assert.equal((await request(app).get(path).set('Cookie', cookie)).status, 401, path);
      assert.equal((await request(app).get(path).set('Cookie', `cetizion_session=${value}`)).status, 401, `${path} with a swapped cookie`);
    }
    assert.equal((await request(app).get('/api/portal/me').set('Cookie', staff)).status, 401);
  });

  test('links work once', async () => {
    const { token } = await portalLogin(2001);
    assert.equal((await request(app).post('/api/portal/login').send({ token })).status, 401);
  });

  test('switching a section or the portal off, or withdrawing access, blocks at once', async () => {
    const { cookie } = await portalLogin(2001);
    await request(app).patch('/api/portal-admin/companies/1001').set('Cookie', staff).send({ portal_sections: ['projects'] }).expect(200);
    assert.equal((await request(app).get('/api/portal/invoices').set('Cookie', cookie)).status, 403);
    await request(app).patch('/api/portal-admin/companies/1001').set('Cookie', staff).send({ portal_enabled: false, portal_sections: ['projects', 'documents', 'invoices', 'certificates', 'contact'] }).expect(200);
    assert.equal((await request(app).get('/api/portal/me').set('Cookie', cookie)).status, 401);
    assert.equal((await request(app).post('/api/portal-admin/contacts/2001/invite').set('Cookie', staff)).status, 422);
    await request(app).patch('/api/portal-admin/companies/1001').set('Cookie', staff).send({ portal_enabled: true }).expect(200);
    const again = await portalLogin(2001);
    await request(app).patch('/api/portal-admin/contacts/2001').set('Cookie', staff).send({ portal_access: false }).expect(200);
    assert.equal((await request(app).get('/api/portal/me').set('Cookie', again.cookie)).status, 401);
    await request(app).patch('/api/portal-admin/contacts/2001').set('Cookie', staff).send({ portal_access: true }).expect(200);
  });

  test('messages reach the team, and views are audited', async () => {
    const { cookie } = await portalLogin(2002);
    const sent = await request(app).post('/api/portal/messages').set('Cookie', cookie).send({ subject: 'Invoice query', body: 'Please share the PO copy.' });
    assert.equal(sent.status, 201);
    await request(app).get('/api/portal/projects').set('Cookie', cookie).expect(200);
    const admin = await request(app).get('/api/portal-admin/companies/1002').set('Cookie', staff);
    const actions = admin.body.data.audit.map((a) => a.action);
    for (const a of ['login', 'view', 'message']) assert.ok(actions.includes(a), a);
    const notes = await request(app).get('/api/notes?entity=company&entity_id=1002').set('Cookie', staff);
    assert.match(JSON.stringify(notes.body), /Invoice query/);
  });

  // ---------------------------------------------------------------- #198: the same figures
  const stageId = async (invoiceNo) => (await pool.query('SELECT id FROM payment_stages WHERE invoice_no = $1', [invoiceNo])).rows[0].id;

  test('a project shows each live PO: its GST, services, schedule, and what is billed and still to bill', async () => {
    const { cookie } = await portalLogin(2001);
    const { body } = await request(app).get('/api/portal/projects').set('Cookie', cookie).expect(200);
    const orders = body.data.find((p) => p.project_id === 'PRJ-A').orders;
    const by = Object.fromEntries(orders.map((o) => [o.po_number, o]));
    assert.deepEqual(Object.keys(by).sort(), ['PO-A', 'PO-A2', 'PO-ANEW', 'PO-AUSD'], 'a cancelled PO and a replaced one are not shown');
    assert.equal(by['PO-ANEW'].revised_from, 'PO-AOLD');
    const a2 = by['PO-A2'];
    assert.deepEqual([Number(a2.value), Number(a2.taxable), Number(a2.gst)], [577000, 500000, 77000], 'GST at the quotation lines\' own rates');
    assert.deepEqual(a2.services, ['Stage 1 audit', 'Training']);
    assert.deepEqual([a2.billed, a2.received, a2.outstanding, a2.to_bill], [288500, 288500, 0, 288500]);
    assert.equal(a2.billed + a2.to_bill, Number(a2.value), 'billed and still to bill make the PO value');
    assert.deepEqual(a2.schedule.map((st) => [st.stage_name, st.state]), [['Advance', 'Paid'], ['On delivery', 'Not yet invoiced']]);
    assert.deepEqual([Number(by['PO-AUSD'].gst), Number(by['PO-AUSD'].taxable)], [0, 5000], 'an export PO carries no GST');
    const text = JSON.stringify(body);
    for (const internal of ['hold_reason', 'waiting on the auditor', 'gst_source', 'estimated']) assert.ok(!text.includes(internal), internal);
  });

  test('an invoice shows taxable, GST and total, paid and TDS; the books\' own split when matched', async () => {
    const { cookie } = await portalLogin(2001);
    const { body } = await request(app).get('/api/portal/invoices').set('Cookie', cookie).expect(200);
    const by = Object.fromEntries(body.data.map((i) => [i.invoice_no, i]));
    const one = by['INV-A-1'];
    assert.deepEqual([Number(one.taxable), Number(one.gst), Number(one.amount)], [84745.76, 15254.24, 100000], 'the accounts import is the legal record');
    const two = by['INV-A-2'];
    assert.deepEqual([Number(two.taxable), Number(two.gst), Number(two.amount)], [250000, 38500, 288500]);
    assert.deepEqual([Number(two.paid), Number(two.tds), Number(two.outstanding), two.status], [280000, 8500, 0, 'Paid']);
    assert.equal(two.project_id, 'PRJ-A');
    assert.equal(two.has_pdf, true);
    for (const i of body.data) {
      assert.equal(Math.round((Number(i.taxable) + Number(i.gst)) * 100), Math.round(Number(i.amount) * 100), `${i.invoice_no}: taxable + GST is the total`);
      assert.ok(!('gst_source' in i));
    }
    const pdf = await request(app).get('/api/portal/invoices/statement.pdf').set('Cookie', cookie).expect(200);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
  });

  test('an invoice opens from Invoices and a PO from Projects, without Documents; another company\'s are not found', async () => {
    const { cookie } = await portalLogin(2001);
    await request(app).patch('/api/portal-admin/companies/1001').set('Cookie', staff).send({ portal_sections: ['projects', 'invoices'] }).expect(200);
    try {
      // Stored files need Cloudinary, which tests do not have: "found" is anything but 404.
      assert.notEqual((await request(app).get(`/api/portal/files/invoice/${await stageId('INV-A-2')}`).set('Cookie', cookie)).status, 404);
      assert.equal((await request(app).get(`/api/portal/files/invoice/${await stageId('INV-B-1')}`).set('Cookie', cookie)).status, 404);
      assert.notEqual((await request(app).get('/api/portal/files/po/PO-A').set('Cookie', cookie)).status, 404);
      for (const other of ['PO-B', 'PO-AX']) assert.equal((await request(app).get(`/api/portal/files/po/${other}`).set('Cookie', cookie)).status, 404, other);
      assert.equal((await request(app).get('/api/portal/files/document/3001').set('Cookie', cookie)).status, 403, 'Documents is off');
    } finally {
      await request(app).patch('/api/portal-admin/companies/1001').set('Cookie', staff).send({ portal_sections: ['projects', 'documents', 'invoices', 'certificates', 'contact'] }).expect(200);
    }
  });

  test('GST with no quotation: the default rate, marked estimated, the paisa left on GST', async () => {
    await pool.query("INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-BEST', 'PRJ-B', '2026-08-20', 118000.01)");
    const { rows: [est] } = await pool.query("SELECT * FROM po_gst_split('PO-BEST', 118000.01)");
    assert.deepEqual([Number(est.taxable), Number(est.gst), Number(est.gst_rate), est.source], [100000.01, 18000, 18, 'estimated']);
    // 100 at 18%: taxable 84.745… rounds to 84.75, and GST takes the rest, so the two still make 100.
    const { rows: [small] } = await pool.query("SELECT * FROM po_gst_split('PO-BEST', 100)");
    assert.deepEqual([Number(small.taxable), Number(small.gst)], [84.75, 15.25]);
    assert.equal(Math.round((Number(small.taxable) + Number(small.gst)) * 100), 10000);
  });

  test('preview as client is what the client sees, and says where each GST split came from', async () => {
    const { cookie } = await portalLogin(2001);
    for (const sectionName of ['projects', 'invoices', 'documents', 'certificates']) {
      const client = (await request(app).get(`/api/portal/${sectionName}`).set('Cookie', cookie).expect(200)).body.data;
      const preview = await request(app).get(`/api/portal-admin/companies/1001/preview/${sectionName}`).set('Cookie', staff).expect(200);
      assert.equal(preview.body.meta.enabled, true);
      const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'gst_source' ? undefined : x)));
      assert.deepEqual(strip(preview.body.data), client, sectionName);
    }
    const { body } = await request(app).get('/api/portal-admin/companies/1001/preview/invoices').set('Cookie', staff).expect(200);
    const source = Object.fromEntries(body.data.map((i) => [i.invoice_no, i.gst_source]));
    assert.deepEqual([source['INV-A-1'], source['INV-A-2']], ['books', 'quotation']);
    await request(app).get('/api/portal-admin/companies/1001/preview/payroll').set('Cookie', staff).expect(404);
    await request(app).get('/api/portal-admin/companies/1001/preview/invoices').set('Cookie', cookie).expect(401);
  });

  // ---------------------------------------------------------------- #198 phase 2: the client answers
  const pdf = { filename: 'remittance.pdf', contentType: 'application/pdf' };
  const actionsOf = async (kind) => (await pool.query('SELECT * FROM portal_client_actions WHERE kind = $1 ORDER BY id', [kind])).rows;

  test('the client confirms, queries and reports a payment: each is a claim, and writes no payment', async () => {
    const { cookie } = await portalLogin(2001);
    const inv = await stageId('INV-A-1');
    const post = (body) => request(app).post('/api/portal/actions').set('Cookie', cookie).send(body);
    assert.equal((await post({ kind: 'confirmed', stage_ids: [inv] })).status, 201);
    const noNote = await post({ kind: 'query', stage_ids: [inv] });
    assert.equal(noNote.status, 422);
    assert.ok(noNote.body.error.fields.note);
    const noDate = await post({ kind: 'payment_advice', stage_ids: [inv], amount: 100000 });
    assert.equal(noDate.status, 422);
    assert.ok(noDate.body.error.fields.paid_on);
    assert.equal((await post({ kind: 'query', stage_ids: [inv], note: 'The GST rate looks wrong.' })).status, 201);
    assert.equal((await post({ kind: 'query', po_number: 'PO-A2', note: 'Can the second stage be split?' })).status, 201, 'a query may be about a PO alone');
    const advice = await post({ kind: 'payment_advice', stage_ids: [inv], amount: 98000, tds_amount: 2000, paid_on: '2026-09-01', reference: 'UTR-TEST-1' });
    assert.equal(advice.status, 201);
    assert.match(advice.body.data.message, /finance team/);

    const paid = await pool.query('SELECT count(*)::int AS n FROM payments WHERE stage_id = $1', [inv]);
    assert.equal(paid.rows[0].n, 0, 'nothing is written to the payments');
    const { body } = await request(app).get('/api/portal/invoices').set('Cookie', cookie).expect(200);
    const one = body.data.find((i) => i.invoice_no === 'INV-A-1');
    assert.equal(one.status, 'Payment reported');
    assert.equal(one.last_action.kind, 'payment_advice');
    const mine = (await request(app).get('/api/portal/actions').set('Cookie', cookie).expect(200)).body.data;
    assert.deepEqual(mine.map((a) => a.kind).sort(), ['confirmed', 'payment_advice', 'query', 'query']);
    assert.deepEqual(mine.find((a) => a.kind === 'payment_advice').invoices.map((i) => i.invoice_no), ['INV-A-1']);
    assert.equal((await actionsOf('confirmed'))[0].status, 'resolved', 'a confirmation is nothing to act on');
    // With no shared inbox set up, a query is a note on the company (as a portal message is).
    const notes = await request(app).get('/api/notes?entity=company&entity_id=1001').set('Cookie', staff);
    assert.match(JSON.stringify(notes.body), /Query on invoice INV-A-1/);
    const told = await pool.query("SELECT kind FROM notifications WHERE kind = 'portal_action'");
    assert.equal(told.rowCount, 3, 'two queries and the advice reach the team; a confirmation does not');
  });

  test("a client cannot answer on another company's invoice or PO, or see its answers", async () => {
    const { cookie } = await portalLogin(2002);
    const post = (body) => request(app).post('/api/portal/actions').set('Cookie', cookie).send(body);
    const alpha = await stageId('INV-A-1'); const beta = await stageId('INV-B-1');
    assert.equal((await post({ kind: 'confirmed', stage_ids: [alpha] })).status, 404);
    assert.equal((await post({ kind: 'confirmed', stage_ids: [beta, alpha] })).status, 404, 'one of them not theirs is enough');
    assert.equal((await post({ kind: 'query', po_number: 'PO-A', note: 'x' })).status, 404);
    // Ownership is checked before the file is stored.
    const withFile = await request(app).post('/api/portal/actions').set('Cookie', cookie)
      .field('kind', 'payment_advice').field('stage_ids', String(alpha)).field('amount', '10').field('paid_on', '2026-09-01')
      .attach('file', Buffer.from('%PDF-1.4'), pdf);
    assert.equal(withFile.status, 404);
    const text = await request(app).post('/api/portal/actions').set('Cookie', cookie)
      .field('kind', 'payment_advice').field('stage_ids', String(beta)).field('amount', '10').field('paid_on', '2026-09-01')
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    assert.equal(text.status, 422);
    const confirm = await request(app).post('/api/portal/actions').set('Cookie', cookie)
      .field('kind', 'confirmed').field('stage_ids', String(beta)).attach('file', Buffer.from('%PDF-1.4'), pdf);
    assert.equal(confirm.status, 422, 'a file goes with a payment advice only');
    const theirs = JSON.stringify((await request(app).get('/api/portal/actions').set('Cookie', cookie).expect(200)).body);
    for (const other of ['INV-A-1', 'PO-A2', 'GST rate']) assert.ok(!theirs.includes(other), other);
    // With Invoices switched off, the client cannot answer at all.
    await request(app).patch('/api/portal-admin/companies/1002').set('Cookie', staff).send({ portal_sections: ['projects'] }).expect(200);
    try {
      assert.equal((await post({ kind: 'confirmed', stage_ids: [beta] })).status, 403);
    } finally {
      await request(app).patch('/api/portal-admin/companies/1002').set('Cookie', staff).send({ portal_sections: ['projects', 'documents', 'invoices', 'certificates', 'contact'] }).expect(200);
    }
  });

  test('staff match a payment advice by recording the receipt, and resolve or reject a query', async () => {
    const [advice] = await actionsOf('payment_advice');
    const [q1, q2] = await actionsOf('query');
    const list = (qs) => request(app).get(`/api/portal-admin/actions${qs}`).set('Cookie', staff).expect(200).then((r) => r.body.data);
    const open = await list('');
    assert.deepEqual(open.map((a) => a.kind).sort(), ['payment_advice', 'query', 'query'], 'open by default; a confirmation is not work');
    assert.equal(open.find((a) => a.id === advice.id).company_name, 'Alpha Industries');
    assert.deepEqual((await list('?kind=query&po_number=PO-A2')).map((a) => a.id), [q2.id]);
    assert.equal((await list('?status=all')).length, 4);

    const pay = (stage, body) => request(app).post(`/api/payment-stages/${stage}/payment`).set('Cookie', staff).send(body);
    const receipt = { amount_received: 98000, tds_amount: 2000, payment_received_date: '2026-09-01', mode: 'add', portal_action_id: advice.id };
    assert.equal((await pay(await stageId('INV-B-1'), receipt)).status, 422, 'an advice is matched only on an invoice it is about');
    await pay(await stageId('INV-A-1'), receipt).expect(200);
    const [matched] = await actionsOf('payment_advice');
    assert.equal(matched.status, 'matched');
    const row = await pool.query('SELECT amount, tds_amount FROM payments WHERE portal_action_id = $1', [advice.id]);
    assert.deepEqual([Number(row.rows[0].amount), Number(row.rows[0].tds_amount)], [98000, 2000]);

    const resolve = (id, body) => request(app).post(`/api/portal-admin/actions/${id}/resolve`).set('Cookie', staff).send(body);
    const why = await resolve(q1.id, { status: 'rejected' });
    assert.equal(why.status, 422, 'a rejection says why');
    assert.ok(why.body.error.fields.resolution);
    await resolve(q1.id, { status: 'rejected', resolution: 'The rate is right: 18% on audits.' }).expect(200);
    await resolve(q2.id, { status: 'resolved' }).expect(200);
    assert.equal((await resolve(q2.id, { status: 'resolved' })).status, 404, 'settled once');
    assert.equal((await resolve(advice.id, { status: 'resolved' })).status, 404, 'a matched advice is settled');

    // One advice for two invoices is matched when both have their receipt.
    const { rows: [two] } = await pool.query("INSERT INTO portal_client_actions (company_id, kind, amount, paid_on) VALUES (1001, 'payment_advice', 20, '2026-09-03') RETURNING id");
    const a2 = await stageId('INV-A-2');
    await pool.query('INSERT INTO portal_client_action_stages (action_id, stage_id) VALUES ($1, $2), ($1, $3)', [two.id, await stageId('INV-A-1'), a2]);
    const small = { amount_received: 10, payment_received_date: '2026-09-03', mode: 'add', portal_action_id: two.id };
    await pay(await stageId('INV-A-1'), small).expect(200);
    assert.equal((await pool.query('SELECT status FROM portal_client_actions WHERE id = $1', [two.id])).rows[0].status, 'open', 'one of two');
    await pay(a2, small).expect(200);
    assert.equal((await pool.query('SELECT status FROM portal_client_actions WHERE id = $1', [two.id])).rows[0].status, 'matched');

    const { cookie } = await portalLogin(2001);
    const invoices = (await request(app).get('/api/portal/invoices').set('Cookie', cookie).expect(200)).body.data;
    assert.equal(invoices.find((i) => i.invoice_no === 'INV-A-1').status, 'Paid');
    const mine = (await request(app).get('/api/portal/actions').set('Cookie', cookie).expect(200)).body.data;
    assert.equal(mine.find((a) => a.id === q1.id).resolution, 'The rate is right: 18% on audits.');
    assert.equal(mine.find((a) => a.id === advice.id).status, 'matched');
    assert.equal((await request(app).get('/api/portal-admin/actions').set('Cookie', cookie)).status, 401);

    // The badges on Collections and Payment stages: the latest word on each invoice, once.
    const byStage = (await request(app).get('/api/portal-admin/actions/by-stage').set('Cookie', staff).expect(200)).body.data;
    assert.equal(new Set(byStage.map((r) => r.stage_id)).size, byStage.length, 'one row per invoice');
    const a1 = await stageId('INV-A-1');
    const onA1 = byStage.find((r) => r.stage_id === a1);
    assert.deepEqual([onA1.id, onA1.kind, onA1.status], [two.id, 'payment_advice', 'matched'], 'the latest action on it');
    assert.equal((await request(app).get('/api/portal-admin/actions/by-stage').set('Cookie', cookie)).status, 401);
  });

  test('files go both ways: what staff share, and what the client uploads, on their own records only', async () => {
    await pool.query(`
      INSERT INTO contacts (id, company_id, name, email, portal_access) VALUES (2003, 1001, 'Arun Alpha', 'arun@alpha.example', true);
      INSERT INTO documents (id, storage_key, file_name, content_type, size_bytes) VALUES
        (3010, 'k/c', 'costing.pdf', 'application/pdf', 10), (3011, 'k/r', 'audit-report.pdf', 'application/pdf', 10),
        (3012, 'k/u1', 'site-photo.jpg', 'image/jpeg', 10), (3013, 'k/u2', 'arun-sheet.pdf', 'application/pdf', 10),
        (3014, 'k/bs', 'beta-report.pdf', 'application/pdf', 10), (3015, 'k/rem', 'remit.pdf', 'application/pdf', 10);
      INSERT INTO attachments (id, entity, entity_id, document_id, label, shared_with_client) VALUES
        (5010, 'purchase_order', 'PO-A', 3010, 'Internal costing', false), (5011, 'project', 'PRJ-A', 3011, 'Audit report', false),
        (5014, 'purchase_order', 'PO-B', 3014, 'Beta report', true);
      INSERT INTO attachments (id, entity, entity_id, document_id, label, shared_with_client, uploaded_by_contact_id) VALUES
        (5012, 'purchase_order', 'PO-A', 3012, 'Site photo', true, 2001), (5013, 'project', 'PRJ-A', 3013, 'Arun sheet', true, 2003);
      INSERT INTO portal_client_actions (company_id, contact_id, kind, amount, paid_on, document_id) VALUES (1001, 2001, 'payment_advice', 10, '2026-09-02', 3015);
    `);
    await request(app).patch('/api/attachments/5011').set('Cookie', staff).send({ shared_with_client: true }).expect(200);
    const { cookie } = await portalLogin(2001);
    const docs = (await request(app).get('/api/portal/documents').set('Cookie', cookie).expect(200)).body.data;
    assert.deepEqual(docs.shared.map((x) => x.label), ['Audit report'], 'shared on purpose only, and only their own');
    assert.deepEqual(docs.uploads.map((x) => [x.label, x.mine, x.by_name]).sort(), [['Arun sheet', false, 'Arun Alpha'], ['Site photo', true, 'Asha Alpha']]);
    const targets = docs.targets.map((t) => t.entity_id);
    for (const t of ['PRJ-A', 'PO-A', 'PO-A2']) assert.ok(targets.includes(t), t);
    for (const t of ['PO-AX', 'PO-AOLD', 'PO-B', 'PRJ-B']) assert.ok(!targets.includes(t), t);

    const file = (id) => request(app).get(`/api/portal/files/document/${id}`).set('Cookie', cookie).then((r) => r.status);
    for (const id of [3011, 3012, 3015]) assert.notEqual(await file(id), 404, String(id));
    for (const id of [3010, 3014]) assert.equal(await file(id), 404, String(id));
    const beta = await portalLogin(2002);
    assert.equal((await request(app).get('/api/portal/files/document/3015').set('Cookie', beta.cookie)).status, 404, "another company's remittance");

    const upload = (fields, attach = ['file', Buffer.from('%PDF-1.4'), pdf]) => {
      let r = request(app).post('/api/portal/documents').set('Cookie', cookie);
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return attach ? r.attach(...attach) : r;
    };
    assert.equal((await upload({ entity: 'purchase_order', entity_id: 'PO-A', label: 'x' }, null)).status, 422, 'no file');
    assert.equal((await upload({ entity: 'purchase_order', entity_id: 'PO-A', label: 'x' }, ['file', Buffer.from('MZ'), { filename: 'a.exe', contentType: 'application/x-msdownload' }])).status, 422);
    assert.equal((await upload({ entity: 'purchase_order', entity_id: 'PO-A', label: '' })).status, 422, 'says what the file is');
    assert.equal((await upload({ entity: 'company', entity_id: '1001', label: 'x' })).status, 422, 'a project or a PO only');
    for (const other of ['PO-B', 'PO-AX']) assert.equal((await upload({ entity: 'purchase_order', entity_id: other, label: 'x' })).status, 404, other);
    assert.equal((await upload({ entity: 'project', entity_id: 'PRJ-B', label: 'x' })).status, 404, "another company's project");

    const del = (id) => request(app).delete(`/api/portal/documents/${id}`).set('Cookie', cookie).then((r) => r.status);
    assert.equal(await del(5013), 404, "a colleague's upload");
    assert.equal(await del(5011), 404, 'a staff file');
    // Once staff open the record, the client's upload is seen and stays.
    const timeline = await request(app).get('/api/timeline?entity=project&id=PRJ-A').set('Cookie', staff).expect(200);
    const item = timeline.body.data.find((i) => i.kind === 'file' && i.id === 5013);
    assert.equal(item.record.from_client, true);
    assert.equal((await request(app).delete('/api/portal/documents/5013').set('Cookie', (await portalLogin(2003)).cookie)).status, 404, 'seen by staff');
    assert.equal(await del(5012), 204, 'their own, unseen');
    assert.equal((await pool.query('SELECT 1 FROM attachments WHERE id = 5012')).rowCount, 0);
  });

  test('a query reaches the PO\'s owner and nobody twice; a payment report reaches everyone', async () => {
    const { rows: [owner] } = await pool.query("INSERT INTO users (name, email, password_hash, role, active) VALUES ('Olu Owner', 'olu@cetizion.example', 'x', 'sales', true) RETURNING id");
    await pool.query("UPDATE projects SET owner_user_id = $1 WHERE project_id = 'PRJ-B'", [owner.id]);
    const { cookie } = await portalLogin(2002);
    const beta = await stageId('INV-B-1');
    await request(app).post('/api/portal/actions').set('Cookie', cookie).send({ kind: 'query', stage_ids: [beta], note: 'Which address is this billed to?' }).expect(201);
    await request(app).post('/api/portal/actions').set('Cookie', cookie).send({ kind: 'payment_advice', stage_ids: [beta], amount: 5, paid_on: '2026-09-04' }).expect(201);
    const { rows } = await pool.query("SELECT username, title FROM notifications WHERE kind = 'portal_action' AND title LIKE '%Beta%' ORDER BY id");
    assert.deepEqual(rows.map((r) => r.username), ['olu@cetizion.example', null]);
  });

  // ---------------------------------------------------------------- #198 phase 3: bringing them in
  test('recording an invoice emails the client\'s portal contacts once, and only when the portal and its Invoices are on', async () => {
    await pool.query("UPDATE settings SET value = 'https://tracker.example' WHERE key = 'public_app_url'");
    const announced = async (stage) => (await pool.query(
      "SELECT to_email, subject, body_text FROM email_log WHERE template = 'portal_new_invoice' AND entity_id = $1 ORDER BY to_email", [String(stage)])).rows;
    const record = (stage, invoiceNo) => request(app).post(`/api/payment-stages/${stage}/invoice`).set('Cookie', staff)
      .send({ invoice_no: invoiceNo, invoice_date: '2026-09-10' }).expect(200);

    // Alpha: the portal is on with Invoices, and two contacts are allowed in.
    const { rows: [a] } = await pool.query("SELECT id FROM payment_stages WHERE po_number = 'PO-A2' AND stage_no = 2");
    await pool.query("UPDATE contacts SET opt_out_reminders = true WHERE id = 2003");
    await record(a.id, 'INV-A-3');
    const mails = await announced(a.id);
    assert.deepEqual(mails.map((m) => m.to_email), ['asha@alpha.example'], 'a contact who opted out of automatic email is left out');
    assert.equal(mails[0].subject, 'Invoice INV-A-3 for PO PO-A2 is in your client portal');
    assert.match(mails[0].body_text, /https:\/\/tracker\.example\/portal/);
    assert.match(mails[0].body_text, /including GST/);
    await record(a.id, 'INV-A-3');
    assert.equal((await announced(a.id)).length, 1, 'once, however often it is recorded');

    // Beta: switched off in Settings, then the Invoices section off.
    const stageB = async (no) => (await pool.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent) VALUES ('PO-B', $1, 'Extra', 'Manual', 0.01) RETURNING id`, [no])).rows[0].id;
    const b2 = await stageB(2); const b3 = await stageB(3); const b4 = await stageB(4);
    await pool.query("UPDATE settings SET value = 'false' WHERE key = 'portal_notify_new_invoice'");
    await record(b2, 'INV-B-2');
    assert.equal((await announced(b2)).length, 0, 'switched off');
    await pool.query("UPDATE settings SET value = 'true' WHERE key = 'portal_notify_new_invoice'");
    await request(app).patch('/api/portal-admin/companies/1002').set('Cookie', staff).send({ portal_sections: ['projects', 'documents'] }).expect(200);
    await record(b3, 'INV-B-3');
    assert.equal((await announced(b3)).length, 0, 'Invoices off');
    await request(app).patch('/api/portal-admin/companies/1002').set('Cookie', staff).send({ portal_sections: ['projects', 'documents', 'invoices', 'certificates', 'contact'] }).expect(200);
    await record(b4, 'INV-B-4');
    assert.deepEqual((await announced(b4)).map((m) => m.to_email), ['bina@beta.example']);

    // An invoice we emailed to the client ourselves, which the email reader
    // found in our sent mail: they have it already, so no portal email, even
    // when a person records it again later.
    const b5 = await stageB(5);
    const { rows: [box] } = await pool.query("INSERT INTO connected_accounts (username, provider, email) VALUES ('admin', 'test', 'accounts@cetizion.example') RETURNING id");
    await pool.query(`INSERT INTO email_invoice_decisions (account_id, provider_id, outcome, method, stage_id, invoice_no)
                      VALUES ($1, 'sent-1', 'recorded', 'rules', $2, 'INV-B-5')`, [box.id, b5]);
    await record(b5, 'INV-B-5');
    assert.equal((await announced(b5)).length, 0, 'we emailed it ourselves');

    // The billing contact hears of it, not every contact allowed in.
    await pool.query('UPDATE contacts SET opt_out_reminders = false, is_billing = (id = 2003) WHERE company_id = 1001');
    const { rows: [a9] } = await pool.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent) VALUES ('PO-A2', 9, 'Extra', 'Manual', 0.01) RETURNING id`);
    await record(a9.id, 'INV-A-9');
    assert.deepEqual((await announced(a9.id)).map((m) => m.to_email), ['arun@alpha.example'], 'the billing contact only');
  });
});
