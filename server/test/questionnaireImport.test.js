import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Importing a questionnaire definition from a file into a draft (#208
 * phase 1b): the first ISO audits and Ecovadis forms, drafted as
 * docs/questionnaires/*.json, go into the builder exactly as written, keys
 * and all. Against a throwaway database with real sign-ins. Needs
 * TEST_DATABASE_URL (CI sets it).
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', 'db');
const NAME = `questionnaire_import_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';
const file = (name) => JSON.parse(readFileSync(join(HERE, '..', '..', 'docs', 'questionnaires', `${name}.json`), 'utf8'));
const SMALL = { steps: [{ key: 'about', title: 'About you', questions: [{ key: 'employee_count', type: 'number', label: 'Employees', required: true, integer: true, min: 1 }] }] };

let app; let pool; let admin; let sam; let serviceId;

describe('importing a questionnaire definition', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    const db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
    await db.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const { createUser } = await import('../src/lib/users.js');
    const signIn = async (email) => {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    const mk = async (name, email, role) => { const u = await createUser({ name, email, role, password: PASSWORD }, pool); return { ...u, cookie: await signIn(email) }; };
    admin = await mk('Ada Admin', 'ada@cetizion.example', 'admin');
    sam = await mk('Sam Sales', 'sam@cetizion.example', 'sales');
    ({ rows: [{ id: serviceId }] } = await pool.query(`INSERT INTO services (name) VALUES ('Example audits') RETURNING id`));
  });

  after(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  const as = (who) => ({
    get: (p) => request(app).get(p).set('Cookie', who.cookie),
    post: (p, b) => request(app).post(p).set('Cookie', who.cookie).send(b),
    patch: (p, b) => request(app).patch(p).set('Cookie', who.cookie).send(b),
  });
  let n = 0;
  const newForm = async () => {
    const made = await as(admin).post('/api/questionnaires', { service_id: serviceId, name: `Form ${++n}` }).expect(201);
    return { formId: made.body.data.id, draftId: made.body.data.versions[0].id };
  };
  const stored = async (versionId) => (await pool.query('SELECT status, definition, pricing FROM questionnaire_versions WHERE id = $1', [versionId])).rows[0];
  const importInto = (who, versionId, definition) => as(who).post(`/api/questionnaire-versions/${versionId}/import`, { definition });

  for (const name of ['iso-audits', 'ecovadis']) {
    test(`${name}.json goes into a draft exactly as written, and stays a draft until someone publishes it`, async () => {
      const { formId, draftId } = await newForm();
      const res = await importInto(admin, draftId, file(name)).expect(200);
      assert.deepEqual(res.body.data.problems, []);
      const v = await stored(draftId);
      assert.equal(v.status, 'draft', 'importing never publishes');
      assert.deepEqual(v.definition, file(name), 'every key, option key, condition and help text kept');
      const form = (await as(admin).get(`/api/questionnaires/${formId}`).expect(200)).body.data;
      assert.equal(form.versions.filter((x) => x.status === 'published').length, 0);
      assert.deepEqual(form.versions[0].problems, [], 'the builder shows nothing to fix');
      await as(admin).post(`/api/questionnaire-versions/${draftId}/publish`).expect(200);
      assert.equal((await stored(draftId)).status, 'published', 'publishing is still its own, separate step');
    });
  }

  test('the guidance headings keep their conditions and help, and option keys are not rewritten from labels', async () => {
    const { draftId } = await newForm();
    await importInto(admin, draftId, file('iso-audits')).expect(200);
    const qs = (await stored(draftId)).definition.steps.flatMap((s) => s.questions);
    const heading = qs.find((q) => q.key === 'information_security_heading');
    assert.deepEqual(heading.show_if, { key: 'standards', op: 'eq', value: 'iso_27001' });
    assert.match(heading.help, /Classified information/);
    assert.equal(qs.filter((q) => q.type === 'info' && q.show_if).length, 6, 'all six standard headings are conditional');
    assert.deepEqual(qs.find((q) => q.key === 'standards').options.map((o) => o.key),
      ['iso_9001', 'iso_22000', 'iso_50001', 'iso_27001', 'iso_37001', 'iso_45001', 'iso_39001', 'other']);
    assert.equal(qs.find((q) => q.key === 'audit_frequency').options[0].key, 'every_12_months');
  });

  test('a definition the builder could not publish is refused whole, listing why, and the draft is untouched', async () => {
    const { draftId } = await newForm();
    await importInto(admin, draftId, SMALL).expect(200);
    const before = await stored(draftId);
    const forward = structuredClone(SMALL);
    forward.steps[0].questions.unshift({ key: 'later', type: 'text', label: 'Later', show_if: { key: 'employee_count', op: 'gt', value: 5 } });
    const twice = structuredClone(SMALL);
    twice.steps[0].questions.push({ ...twice.steps[0].questions[0] });
    const cases = [
      ['not a form at all', 'just text'],
      ['no steps', {}],
      ['an unknown field', { ...SMALL, colour: 'blue' }],
      ['an unknown kind of question', { steps: [{ key: 'a', title: 'A', questions: [{ key: 'x', type: 'slider', label: 'X' }] }] }],
      ['an option key starting with a digit', { steps: [{ key: 'a', title: 'A', questions: [{ key: 'x', type: 'radio', label: 'X', options: [{ key: '12_month', label: '12' }] }] }] }],
      ['a condition on a later question', forward],
      ['a condition on an option that does not exist', (() => { const d = structuredClone(file('iso-audits')); d.steps[3].questions.find((q) => q.key === 'haccp_count').show_if.value = 'iso_2200'; return d; })()],
      ['a key used twice', twice],
      ['no questions', { steps: [{ key: 'a', title: 'A', questions: [] }] }],
    ];
    for (const [why, definition] of cases) {
      const res = await importInto(admin, draftId, definition);
      assert.equal(res.status, 422, why);
      assert.ok(res.body.error?.problems?.length || res.body.error?.fields, `${why}: says why`);
    }
    assert.deepEqual(await stored(draftId), before, 'nothing was written');
  });

  test('a file that is not JSON never reaches the draft', async () => {
    const { draftId } = await newForm();
    const before = await stored(draftId);
    const res = await request(app).post(`/api/questionnaire-versions/${draftId}/import`).set('Cookie', admin.cookie)
      .set('Content-Type', 'application/json').send('{"definition": {"steps": [');
    // Refused before the route runs. (Malformed JSON answers 500 app-wide today, not 400: a separate, existing issue.)
    assert.ok(res.status >= 400, `refused (${res.status})`);
    assert.deepEqual(await stored(draftId), before);
    assert.equal((await as(admin).post(`/api/questionnaire-versions/${draftId}/import`, { definition: SMALL, extra: 1 })).status, 422, 'only { definition }');
  });

  test('admins only; a published or retired version is never overwritten', async () => {
    const { formId, draftId } = await newForm();
    assert.equal((await importInto(sam, draftId, SMALL)).status, 403, 'a salesperson cannot import');
    assert.equal((await importInto(admin, 999999, SMALL)).status, 404);
    await importInto(admin, draftId, SMALL).expect(200);
    await as(admin).post(`/api/questionnaire-versions/${draftId}/publish`).expect(200);
    const published = await stored(draftId);
    const refused = await importInto(admin, draftId, file('ecovadis'));
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /published: make a new version/);
    assert.deepEqual(await stored(draftId), published, 'the published version is unchanged');

    // A new version takes the import; the published one is still the same, and retires only when the new one is published.
    const next = (await as(admin).post(`/api/questionnaires/${formId}/versions`).expect(201)).body.data.versions.find((x) => x.status === 'draft');
    await importInto(admin, next.id, file('ecovadis')).expect(200);
    assert.deepEqual(await stored(draftId), published);
    await as(admin).post(`/api/questionnaire-versions/${next.id}/publish`).expect(200);
    assert.equal((await stored(draftId)).status, 'retired');
    assert.equal((await importInto(admin, draftId, SMALL)).status, 409, 'a retired version is frozen too');
  });

  test('the pricing stays, and is checked against the imported questions', async () => {
    const { draftId } = await newForm();
    await importInto(admin, draftId, SMALL).expect(200);
    const pricing = { lines: [{ key: 'audit', description: 'Audit', qty: { answer: 'employee_count' }, rate: { fixed: 1000 } }] };
    await as(admin).patch(`/api/questionnaire-versions/${draftId}`, { pricing }).expect(200);
    const res = await importInto(admin, draftId, file('ecovadis')).expect(200);
    assert.ok(res.body.data.pricing_problems.some((p) => /employee_count/.test(p)), 'a rule reading a question the file does not have is listed');
    assert.deepEqual((await stored(draftId)).pricing, pricing, 'the pricing is not thrown away');
  });
});
