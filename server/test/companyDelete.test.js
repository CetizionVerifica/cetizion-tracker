import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Deleting a company (089).
 *
 * quotations, enquiries and projects used to point at companies ON DELETE
 * SET NULL. Nulling the link is an UPDATE, the link trigger saw a record with
 * no company and linked it from client_name again, and that created the
 * company afresh. The delete answered 204 and the client was back on the list
 * with a new id, so to the person deleting it nothing happened at all.
 *
 * Now a company still named on those records is refused with a message that
 * points at merging, a company with nothing behind it is deleted and stays
 * deleted, and merging (which moves the records first) still works.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('deleting a company', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  let cookie;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const name = `companydelete_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'shared-admin';
    process.env.AUTH_PASSWORD = 'the-shared-password-in-env';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));

    const signIn = await request(app).post('/api/auth/login')
      .send({ username: 'shared-admin', password: 'the-shared-password-in-env' });
    assert.equal(signIn.status, 200);
    cookie = signIn.headers['set-cookie'];
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await admin.end();
  });

  const clean = async () => {
    await db.query('DELETE FROM quotations');
    await db.query('DELETE FROM enquiries');
    await db.query('DELETE FROM projects');
    await db.query('DELETE FROM activity_log');
    await db.query('DELETE FROM companies');
  };
  const companies = async () => (await db.query('SELECT id, name FROM companies ORDER BY id')).rows;

  test('a company still named on a quotation is refused, and nothing is re-created', async () => {
    await clean();
    await db.query(`INSERT INTO quotations (quotation_no, client_name, contact_person) VALUES ('Q-DEL-1', 'Acme Steel', 'Ravi')`);
    const [acme] = await companies();

    const res = await request(app).delete(`/api/companies/${acme.id}`).set('Cookie', cookie);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error.message, /still has quotations/);
    assert.match(res.body.error.message, /Merge it/);
    assert.deepEqual(await companies(), [acme], 'the same company, same id, and no second copy');
    const { rows: [q] } = await db.query(`SELECT company_id FROM quotations WHERE quotation_no = 'Q-DEL-1'`);
    assert.equal(q.company_id, acme.id, 'the quotation still points at it');
  });

  test('enquiries and projects hold a company the same way', async () => {
    await clean();
    await db.query(`INSERT INTO enquiries (enquiry_no, client_name) VALUES ('E-DEL-1', 'Beta Cement')`);
    await db.query(`INSERT INTO projects (project_id, client_name) VALUES ('P-DEL-1', 'Gamma Power')`);
    const [beta, gamma] = await companies();

    const e = await request(app).delete(`/api/companies/${beta.id}`).set('Cookie', cookie);
    const p = await request(app).delete(`/api/companies/${gamma.id}`).set('Cookie', cookie);

    assert.equal(e.status, 409);
    assert.match(e.body.error.message, /still has enquiries/);
    assert.equal(p.status, 409);
    assert.match(p.body.error.message, /still has projects/);
    assert.equal((await companies()).length, 2);
  });

  test('a company with no records behind it is deleted and stays deleted', async () => {
    await clean();
    const { rows: [stray] } = await db.query(`INSERT INTO companies (name) VALUES ('Stray Spelling') RETURNING id`);
    await db.query(`INSERT INTO contacts (company_id, name) VALUES ($1, 'Somebody')`, [stray.id]);

    const res = await request(app).delete(`/api/companies/${stray.id}`).set('Cookie', cookie);

    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.deepEqual(await companies(), []);
  });

  test('merging still folds the records across and deletes the loser', async () => {
    await clean();
    await db.query(`INSERT INTO quotations (quotation_no, client_name) VALUES ('Q-DEL-2', 'Acme Ltd.')`);
    await db.query(`INSERT INTO enquiries (enquiry_no, client_name) VALUES ('E-DEL-2', 'Acme Ltd.')`);
    const { rows: [keep] } = await db.query(`INSERT INTO companies (name) VALUES ('Acme Limited') RETURNING id`);
    const loser = (await companies()).find((c) => c.name === 'Acme Ltd.');

    const res = await request(app).post(`/api/companies/${loser.id}/merge`).set('Cookie', cookie).send({ into: keep.id });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await companies()).map((c) => c.id), [keep.id]);
  });
});
