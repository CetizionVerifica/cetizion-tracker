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
 * invoices with taxable value, GST and total, and a staff preview of it. Runs against a throwaway
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
});
