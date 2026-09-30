import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Filling a client contact's email and phone from the screens people work in
 * (docs/client-data-gaps.md, gap 1).
 *
 * contacts.email has always existed and half the app reads it — sending a
 * quotation, chasing a payment, the portal, mailbox matching. What was
 * missing was any way to put one there: the enquiry and quotation forms
 * take a name, the trigger makes a contact out of that name alone, and
 * every one of those features then quietly did less than it should.
 *
 * Needs TEST_DATABASE_URL; skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `contacts_test_${process.pid}`;
let app; let pool; let db; let cookie;

describe('client contact details from the forms', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    Object.assign(process.env, {
      SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: url.toString(),
      AUTH_MODE: 'shared', AUTH_USERNAME: 'tester', AUTH_PASSWORD: 'a-good-long-test-password',
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
    });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const signIn = await request(app).post('/api/auth/login').send({ username: 'tester', password: 'a-good-long-test-password' });
    cookie = signIn.headers['set-cookie'][0].split(';')[0];
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const contactOf = async (company) => (await db.query(
    `SELECT c.name, c.email, c.phone FROM contacts c JOIN companies co ON co.id = c.company_id
      WHERE co.name = $1 ORDER BY c.id`, [company])).rows;

  test('an enquiry puts the address on the contact the trigger made', async () => {
    const res = await request(app).post('/api/enquiries').set('Cookie', cookie).send({
      client_name: 'Hetero Labs', enquiry_date: '2026-09-01', source: 'Website',
      contact_person: 'Ravi Kumar', contact_email: 'ravi@hetero.example', contact_phone: '+91 98765 43210',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const [ravi] = await contactOf('Hetero Labs');
    assert.equal(ravi.name, 'Ravi Kumar');
    assert.equal(ravi.email, 'ravi@hetero.example', 'the whole point: the address is on the contact');
    assert.equal(ravi.phone, '+91 98765 43210');
  });

  test('the form shows the address it is about to change', async () => {
    const list = await request(app).get('/api/enquiries?q=Hetero').set('Cookie', cookie).expect(200);
    const row = list.body.data.find((e) => e.client_name === 'Hetero Labs');
    assert.equal(row.contact_email, 'ravi@hetero.example', 'read back through v_enquiries');
    assert.equal(row.contact_phone, '+91 98765 43210');
  });

  test('a quotation writes to the same contact, and reads it back', async () => {
    const res = await request(app).post('/api/quotations').set('Cookie', cookie).send({
      client_name: 'Hetero Labs', quotation_date: '2026-09-02', contact_person: 'Ravi Kumar',
      contact_email: 'r.kumar@hetero.example', service_quoted: 'LCA',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.contact_email, 'r.kumar@hetero.example', 'v_quotations carries it');

    const rows = await contactOf('Hetero Labs');
    assert.equal(rows.length, 1, 'one contact, corrected — not a second Ravi');
    assert.equal(rows[0].email, 'r.kumar@hetero.example', 'a sent value replaces the stored one');
    assert.equal(rows[0].phone, '+91 98765 43210', 'and a field left alone stays');
  });

  test('a blank field is not an instruction to erase', async () => {
    const list = await request(app).get('/api/quotations?q=Hetero').set('Cookie', cookie).expect(200);
    const q = list.body.data[0];
    await request(app).patch(`/api/quotations/${q.id}`).set('Cookie', cookie)
      .send({ service_quoted: 'LCA and PCF', contact_email: '' }).expect(200);

    const [ravi] = await contactOf('Hetero Labs');
    assert.equal(ravi.email, 'r.kumar@hetero.example', 'clearing an address belongs on the contact form');
  });

  test('an address on its own is a save, now that quotations have an onSave', async () => {
    // Before this change a quotation had no onSave, so a PATCH naming no
    // column of its own was refused with "Nothing to update". contact_email
    // is not a column of quotations, so that is exactly this request.
    const list = await request(app).get('/api/quotations?q=Hetero').set('Cookie', cookie).expect(200);
    const q = list.body.data[0];
    await request(app).patch(`/api/quotations/${q.id}`).set('Cookie', cookie)
      .send({ contact_phone: '+91 90000 11111' }).expect(200);

    const [ravi] = await contactOf('Hetero Labs');
    assert.equal(ravi.phone, '+91 90000 11111');
    assert.equal(ravi.email, 'r.kumar@hetero.example', 'and nothing else moved');
  });

  test('an address that is not one is refused, and nothing is saved', async () => {
    const res = await request(app).post('/api/enquiries').set('Cookie', cookie).send({
      client_name: 'Bad Address Ltd', enquiry_date: '2026-09-03', source: 'Website',
      contact_person: 'Someone', contact_email: 'not-an-address',
    });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM enquiries WHERE client_name = 'Bad Address Ltd'`);
    assert.equal(rows[0].n, 0, 'a refused save writes no enquiry either');
  });

  test('the new checks find a client nothing can be sent to', async () => {
    // A company whose only contact is a name — which is every contact the
    // forms used to make — passed the old "has any contact" check.
    await db.query(`INSERT INTO companies (name) VALUES ('Silent Ltd')`);
    await db.query(`INSERT INTO contacts (company_id, name) SELECT id, 'Nobody Reachable' FROM companies WHERE name = 'Silent Ltd'`);

    const res = await request(app).get('/api/dashboard/data-quality').set('Cookie', cookie).expect(200);
    const by = Object.fromEntries(res.body.data.checks.map((c) => [c.key, c]));

    assert.equal(by.companies_without_contact.count, 0, 'it has a contact, so the old check is happy');
    assert.ok(by.companies_without_contact_email.count >= 1, 'and the new one is not');

    // The rule for this page: the count and the list its link opens agree.
    const link = by.companies_without_contact_email.link;
    assert.equal(link, '/companies?contacts_all_without_email=1');
    const list = await request(app).get('/api/companies?contacts_all_without_email=1').set('Cookie', cookie).expect(200);
    assert.equal(list.body.data.length, by.companies_without_contact_email.count,
      'a check whose link opens a different list is worse than no check');
    assert.ok(list.body.data.some((c) => c.name === 'Silent Ltd'));
  });

  test('every new check\'s link opens exactly the rows it counted', async () => {
    const res = await request(app).get('/api/dashboard/data-quality').set('Cookie', cookie).expect(200);
    for (const check of res.body.data.checks) {
      if (!['companies_without_contact_email', 'clients_without_billing_contact', 'open_quotations_without_contact_email'].includes(check.key)) continue;
      const [path, qs] = check.link.split('?');
      const list = await request(app).get(`/api${path}?${qs}`).set('Cookie', cookie);
      assert.equal(list.status, 200, `${check.key} -> ${list.status} for ${check.link}`);
      assert.equal(list.body.data.length, check.count, `${check.key}: counted ${check.count}, its link opens ${list.body.data.length}`);
    }
  });

  test('a record saved without naming anybody is still fine', async () => {
    const res = await request(app).post('/api/enquiries').set('Cookie', cookie)
      .send({ client_name: 'Nobody Named Ltd', enquiry_date: '2026-09-04', source: 'Website' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });
});
