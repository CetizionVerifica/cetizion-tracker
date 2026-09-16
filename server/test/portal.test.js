import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The client portal (#47) must never show one company another's data, and
 * its session must never open the staff API. Runs against a throwaway
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
    INSERT INTO contacts (id, company_id, name, email) VALUES (2001, 1001, 'Asha Alpha', 'asha@alpha.example'), (2002, 1002, 'Bina Beta', 'bina@beta.example');
    INSERT INTO documents (id, storage_key, file_name, content_type, size_bytes) VALUES (3001, 'k/a', 'alpha-po.pdf', 'application/pdf', 10), (3002, 'k/b', 'beta-po.pdf', 'application/pdf', 10);
    INSERT INTO projects (project_id, client_name) VALUES ('PRJ-A', 'Alpha Industries'), ('PRJ-B', 'Beta Metals');
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, document_id) VALUES ('PO-A', 'PRJ-A', '2026-08-01', 100000, 3001), ('PO-B', 'PRJ-B', '2026-08-01', 200000, 3002);
    INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
      VALUES ('PO-A', 1, 'Advance', 'On PO Registration', 1, 'INV-A-1', '2026-08-02'), ('PO-B', 1, 'Advance', 'On PO Registration', 1, 'INV-B-1', '2026-08-02');
    INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sent_at)
      VALUES ('QT-A', 'Alpha Industries', '2026-07-01', 100000, 'Submitted', now()), ('QT-B', 'Beta Metals', '2026-07-01', 200000, 'Submitted', now());
    INSERT INTO deliverables (company_id, client_name, title, reference, valid_until) VALUES (1001, '', 'Alpha certificate', 'CERT-A', '2027-01-01'), (1002, '', 'Beta certificate', 'CERT-B', '2027-01-01');
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
});
