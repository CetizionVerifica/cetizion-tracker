import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Service questionnaires (#208 phase 1), end to end against a throwaway
 * database with real sign-ins: an admin builds and publishes a form, a
 * salesperson sends it from their enquiry, the client fills it from the
 * link and submits, and nobody else reaches any of it. Every company and
 * person here is made up. Needs TEST_DATABASE_URL (CI sets it).
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `questionnaire_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

const FORM = {
  steps: [
    { key: 'organisation', title: 'Your organisation', questions: [
      { key: 'legal_name', type: 'text', label: 'Legal name', required: true, prefill: 'company.name' },
      { key: 'employee_count', type: 'number', label: 'Employees in scope', required: true, integer: true, min: 1 },
    ] },
    { key: 'scope', title: 'Scope', questions: [
      { key: 'previously_certified', type: 'yesno', label: 'Certified before?', required: true },
      { key: 'certifying_body', type: 'text', label: 'Which body?', required: true, show_if: { key: 'previously_certified', op: 'eq', value: true } },
      { key: 'sites', type: 'table', label: 'Sites', required: true, columns: [{ key: 'city', type: 'text', label: 'City', required: true }] },
      { key: 'org_chart', type: 'file', label: 'Organisation chart' },
    ] },
  ],
};
const ANSWERS = { legal_name: 'Example Industries', employee_count: 120, previously_certified: false, sites: [{ city: 'Pune' }] };

let app; let pool; let admin; let sam; let bea; let serviceId; let formId;
const tokenOf = (url) => url.split('/q/')[1];

describe('service questionnaires', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    await db.query(`UPDATE settings SET value = 'https://tracker.example' WHERE key = 'public_app_url'`);
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
    bea = await mk('Bea Sales', 'bea@cetizion.example', 'sales');

    ({ rows: [{ id: serviceId }] } = await pool.query(`INSERT INTO services (name) VALUES ('Example certification') RETURNING id`));
    await pool.query(`
      INSERT INTO companies (id, name, gstin) VALUES (7001, 'Example Industries', '27AAAAA0000A1Z5'), (7002, 'Sample Metals', NULL);
      INSERT INTO contacts (id, company_id, name, email) VALUES (8001, 7001, 'Asha Example', 'asha@example.com'), (8002, 7002, 'Ravi Sample', NULL);
    `);
    await pool.query(
      `INSERT INTO enquiries (enquiry_no, client_name, company_id, contact_id, contact_person, owner_user_id, status)
       VALUES ('ENQ-A', 'Example Industries', 7001, 8001, 'Asha Example', $1, 'New'), ('ENQ-B', 'Sample Metals', 7002, 8002, 'Ravi Sample', $2, 'New')`,
      [sam.id, bea.id]);
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
    del: (p) => request(app).delete(p).set('Cookie', who.cookie),
  });
  const pub = {
    get: (t) => request(app).get(`/api/public/questionnaire/${t}`),
    put: (t, b) => request(app).put(`/api/public/questionnaire/${t}/answers`).send(b),
    submit: (t, b) => request(app).post(`/api/public/questionnaire/${t}/submit`).send(b),
  };

  test('an admin builds a form; a draft lists what it lacks, publishing waits for it, and a published version is frozen', async () => {
    assert.equal((await as(sam).post('/api/questionnaires', { service_id: serviceId, name: 'Certification questionnaire' })).status, 403, 'admins only');
    const made = await as(admin).post('/api/questionnaires', { service_id: serviceId, name: 'Certification questionnaire' }).expect(201);
    formId = made.body.data.id;
    const draft = made.body.data.versions[0];
    assert.equal(draft.status, 'draft');

    const broken = structuredClone(FORM);
    broken.steps[1].questions[1].show_if.key = 'nowhere';
    const saved = await as(admin).patch(`/api/questionnaire-versions/${draft.id}`, { definition: broken }).expect(200);
    assert.match(saved.body.data.problems.join(' '), /must point to a question before it/);
    const refused = await as(admin).post(`/api/questionnaire-versions/${draft.id}/publish`);
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.problems.join(' '), /must point to a question before it/);

    await as(admin).patch(`/api/questionnaire-versions/${draft.id}`, { definition: FORM }).expect(200);
    const published = await as(admin).post(`/api/questionnaire-versions/${draft.id}/publish`).expect(200);
    assert.equal(published.body.data.versions[0].status, 'published');
    assert.equal((await as(admin).patch(`/api/questionnaire-versions/${draft.id}`, { definition: FORM })).status, 409);
    await assert.rejects(pool.query(`UPDATE questionnaire_versions SET definition = '{"steps":[]}' WHERE id = $1`, [draft.id]), /make a new version/);

    // A second version starts as a copy; publishing it retires the first.
    const next = await as(admin).post(`/api/questionnaires/${formId}/versions`).expect(201);
    const v2 = next.body.data.versions.find((v) => v.status === 'draft');
    assert.deepEqual(v2.definition, published.body.data.versions[0].definition);
    const after2 = await as(admin).post(`/api/questionnaire-versions/${v2.id}/publish`).expect(200);
    assert.deepEqual(after2.body.data.versions.map((v) => [v.version, v.status]), [[2, 'published'], [1, 'retired']]);
    const list = await as(sam).get('/api/questionnaires').expect(200);
    assert.equal(list.body.data.find((q) => q.id === formId).published.version, 2, 'everyone signed in can read the forms');
  });

  test('a salesperson sends it from their own enquiry; the email carries a link whose token is never stored or logged', async () => {
    assert.equal((await as(bea).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId })).status, 404, 'not her enquiry');
    const noEmail = await as(bea).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-B', questionnaire_id: formId });
    assert.equal(noEmail.status, 422);
    assert.ok(noEmail.body.error.fields.to, 'a contact with no email needs an address typed');

    const sent = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, message: 'As discussed on the call.' }).expect(201);
    const token = tokenOf(sent.body.data.url);
    assert.match(sent.body.data.url, /^https:\/\/tracker\.example\/q\/[A-Za-z0-9_-]{40,}$/);
    assert.equal(sent.body.data.email.to, 'asha@example.com', 'the enquiry\'s contact by default');
    assert.equal(sent.body.data.answers.legal_name, 'Example Industries', 'prefilled from the company');
    const { rows: [mail] } = await pool.query(`SELECT body_text, entity_id FROM email_log WHERE template = 'questionnaire_invite' ORDER BY id DESC LIMIT 1`);
    assert.ok(!mail.body_text.includes(token), 'the token is redacted from the email log');
    assert.match(mail.body_text, /As discussed on the call/);
    const { rows } = await pool.query(`SELECT token_hash FROM questionnaire_links WHERE token_hash = $1`, [token]);
    assert.equal(rows.length, 0, 'only the hash is stored');

    const listed = await as(sam).get('/api/questionnaire-responses?enquiry=ENQ-A').expect(200);
    assert.equal(listed.body.data[0].link_state, 'sent');
    assert.equal((await as(bea).get('/api/questionnaire-responses?enquiry=ENQ-A')).status, 404);
    assert.equal((await as(bea).get(`/api/questionnaire-responses/${sent.body.data.id}`)).status, 404);
    assert.equal((await as(admin).get(`/api/questionnaire-responses/${sent.body.data.id}`)).status, 200);
    const { rows: [enq] } = await pool.query(`SELECT questionnaire_status FROM v_enquiries WHERE enquiry_no = 'ENQ-A'`);
    assert.equal(enq.questionnaire_status, 'not_started');
  });

  test('an admin\'s hold on client emails holds the questionnaire email, and the owner sees it in their log', async () => {
    await pool.query(`INSERT INTO settings (key, value) VALUES ('client_emails_hold_all', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
    try {
      const sent = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId }).expect(201);
      assert.equal(sent.body.data.email.status, 'suppressed');
      const { rows: [mail] } = await pool.query(`SELECT id, status, reason FROM email_log WHERE template = 'questionnaire_invite' ORDER BY id DESC LIMIT 1`);
      assert.equal(mail.status, 'suppressed');
      assert.match(mail.reason, /held by an admin/);
      const mine = await as(sam).get('/api/emails?entity=enquiry&entity_id=ENQ-A').expect(200);
      assert.ok(mine.body.data.some((e) => e.id === mail.id), 'the enquiry\'s owner sees it');
      const theirs = await as(bea).get('/api/emails?entity=enquiry&entity_id=ENQ-A').expect(200);
      assert.ok(!theirs.body.data.some((e) => e.id === mail.id), 'nobody else does');
    } finally {
      await pool.query(`UPDATE settings SET value = 'false' WHERE key = 'client_emails_hold_all'`);
    }
  });

  test('the client fills it in from the link, saving as they go, and submits once; the owner is told', async () => {
    const sent = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, send_email: false }).expect(201);
    const t = tokenOf(sent.body.data.url);
    const opened = await pub.get(t).expect(200);
    assert.equal(opened.body.data.client_name, 'Example Industries');
    assert.equal(opened.body.data.requested_by, 'Sam Sales');
    for (const internal of ['requested_by_user_id', 'enquiry_id', 'company_id', 'created_by', 'link_id']) assert.ok(!(internal in opened.body.data), internal);

    const wrong = await pub.put(t, { step: 0, answers: { employee_count: 'many' } });
    assert.equal(wrong.status, 422);
    assert.ok(wrong.body.error.fields.employee_count);
    await pub.put(t, { step: 1, answers: { legal_name: 'Example Industries', employee_count: 120 } }).expect(200);
    const missing = await pub.submit(t, { name: 'Asha Example', email: 'asha@example.com', answers: { legal_name: 'Example Industries', employee_count: 120, previously_certified: true } });
    assert.equal(missing.status, 422);
    assert.deepEqual(Object.keys(missing.body.error.fields).sort(), ['certifying_body', 'sites']);
    assert.equal((await pub.submit(t, { answers: ANSWERS })).status, 422, 'a name and an email, please');
    await pub.submit(t, { name: 'Asha Example', email: 'asha@example.com', answers: ANSWERS }).expect(200);

    const { rows: [r] } = await pool.query('SELECT status, answers, submitted_by_name FROM questionnaire_responses WHERE id = $1', [sent.body.data.id]);
    assert.deepEqual([r.status, r.answers, r.submitted_by_name], ['submitted', ANSWERS, 'Asha Example']);
    assert.equal((await pub.put(t, { answers: ANSWERS })).status, 409, 'read-only once submitted');
    assert.equal((await pub.submit(t, { name: 'Asha Example', email: 'asha@example.com' })).status, 409, 'submitted once');
    const { rows: told } = await pool.query(`SELECT username FROM notifications WHERE kind = 'questionnaire_submitted'`);
    assert.deepEqual(told.map((n) => n.username), ['sam@cetizion.example']);
    const { rowCount: emailed } = await pool.query(`SELECT 1 FROM email_log WHERE template = 'questionnaire_submitted' AND to_email = 'sam@cetizion.example'`);
    assert.equal(emailed, 1);

    // Reopened by staff, the same link works again.
    await as(sam).post(`/api/questionnaire-responses/${sent.body.data.id}/reopen`).expect(200);
    await pub.put(t, { answers: { ...ANSWERS, employee_count: 140 } }).expect(200);
  });

  test('a token reaches one response only; a guessed, revoked, expired or withdrawn link is the same dead end', async () => {
    const a = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, send_email: false }).expect(201);
    const b = await as(bea).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-B', questionnaire_id: formId, to: 'ravi@sample.example' }).expect(201);
    const ta = tokenOf(a.body.data.url); const tb = tokenOf(b.body.data.url);
    assert.equal((await pub.get(tb)).body.data.client_name, 'Sample Metals');
    assert.ok(!JSON.stringify((await pub.get(ta)).body).includes('Sample Metals'));
    const dead = async (t) => { const r = await pub.get(t); assert.equal(r.status, 404); return r.body.error.message; };
    const message = await dead('x'.repeat(43));
    assert.equal(await dead('short'), message);

    // A second link (copied) works beside the first; revoking stops both.
    const copied = await as(sam).post(`/api/questionnaire-responses/${a.body.data.id}/link`, {}).expect(201);
    await pub.get(tokenOf(copied.body.data.url)).expect(200);
    await pub.get(ta).expect(200);
    await as(sam).post(`/api/questionnaire-responses/${a.body.data.id}/revoke`).expect(200);
    assert.equal(await dead(ta), message);
    assert.equal(await dead(tokenOf(copied.body.data.url)), message);

    await pool.query(`UPDATE questionnaire_links SET expires_at = now() - interval '1 minute' WHERE response_id = $1`, [b.body.data.id]);
    assert.equal(await dead(tb), message);

    // Sending again withdraws the open one and its links.
    const c = await as(bea).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-B', questionnaire_id: formId, send_email: false }).expect(201);
    const d = await as(bea).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-B', questionnaire_id: formId, send_email: false }).expect(201);
    assert.equal(await dead(tokenOf(c.body.data.url)), message);
    await pub.get(tokenOf(d.body.data.url)).expect(200);
    const { rows: [old] } = await pool.query('SELECT status FROM questionnaire_responses WHERE id = $1', [c.body.data.id]);
    assert.equal(old.status, 'withdrawn');
  });

  test('files: only the allowed kinds, only into a file question, and an answer may name only its own response\'s files', async () => {
    const a = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, send_email: false }).expect(201);
    const t = tokenOf(a.body.data.url);
    const upload = (key, body, meta) => request(app).post(`/api/public/questionnaire/${t}/files`).field('question_key', key).attach('file', Buffer.from(body), meta);
    assert.equal((await upload('org_chart', 'hello', { filename: 'a.txt', contentType: 'text/plain' })).status, 422);
    assert.equal((await upload('legal_name', '%PDF-1.4', { filename: 'a.pdf', contentType: 'application/pdf' })).status, 422, 'not a file question');

    // A file held by another response cannot be claimed.
    const b = await as(bea).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-B', questionnaire_id: formId, send_email: false }).expect(201);
    const { rows: [doc] } = await pool.query(`INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ('k/q', 'chart.pdf', 'application/pdf', 10) RETURNING id`);
    await pool.query(`INSERT INTO questionnaire_response_files (response_id, question_key, document_id) VALUES ($1, 'org_chart', $2)`, [b.body.data.id, doc.id]);
    const claim = await pub.put(t, { answers: { org_chart: [doc.id] } });
    assert.equal(claim.status, 422);
    assert.ok(claim.body.error.fields.org_chart);
    await pub.put(tokenOf(b.body.data.url), { answers: { org_chart: [doc.id] } }).expect(200);

    // Staff reach a client's file through the enquiry they own; another salesperson does not.
    assert.equal((await as(sam).get(`/api/documents/${doc.id}`)).status, 404);
    assert.notEqual((await as(bea).get(`/api/documents/${doc.id}`)).status, 404);
    const { rows: [purge] } = await pool.query(
      `SELECT count(*)::int AS n FROM documents d WHERE d.id = $1 AND EXISTS (SELECT 1 FROM questionnaire_response_files f WHERE f.document_id = d.id)`, [doc.id]);
    assert.equal(purge.n, 1);
  });

  test('staff fill it in for the client, and submit it themselves', async () => {
    const a = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, send_email: false }).expect(201);
    const id = a.body.data.id;
    assert.equal((await as(bea).patch(`/api/questionnaire-responses/${id}`, { answers: ANSWERS })).status, 404);
    await as(sam).patch(`/api/questionnaire-responses/${id}`, { step: 1, answers: { legal_name: 'Example Industries' } }).expect(200);
    const short = await as(sam).post(`/api/questionnaire-responses/${id}/submit`, {});
    assert.equal(short.status, 422);
    const done = await as(sam).post(`/api/questionnaire-responses/${id}/submit`, { answers: ANSWERS }).expect(200);
    assert.deepEqual([done.body.data.status, done.body.data.filled_by, done.body.data.submitted_by_name], ['submitted', 'staff', 'Sam Sales']);
  });

  test('sending another keeps a reopened questionnaire\'s answers: it goes back to submitted, not withdrawn', async () => {
    const a = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, send_email: false }).expect(201);
    await as(sam).post(`/api/questionnaire-responses/${a.body.data.id}/submit`, { answers: ANSWERS }).expect(200);
    await as(sam).post(`/api/questionnaire-responses/${a.body.data.id}/reopen`).expect(200);
    await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId, send_email: false }).expect(201);
    const { rows: [r] } = await pool.query('SELECT status, answers FROM questionnaire_responses WHERE id = $1', [a.body.data.id]);
    assert.deepEqual([r.status, r.answers], ['submitted', ANSWERS]);
    assert.equal((await pub.get(tokenOf(a.body.data.url))).status, 404, 'its links stop');
  });

  test('reminders: after the days in Settings, at most twice, never after the link expires, and off at 0', async () => {
    const { runQuestionnaireReminders } = await import('../src/lib/questionnaires.js');
    await pool.query(`UPDATE questionnaire_responses SET status = 'withdrawn' WHERE status <> 'submitted'`);
    const a = await as(sam).post('/api/questionnaire-responses', { enquiry_no: 'ENQ-A', questionnaire_id: formId }).expect(201);
    const id = a.body.data.id;
    const age = () => pool.query(`UPDATE questionnaire_links SET created_at = created_at - interval '4 days' WHERE response_id = $1`, [id]);
    assert.deepEqual((await runQuestionnaireReminders({ db: pool })).reminded, [], 'too soon');
    await age();
    const first = await runQuestionnaireReminders({ db: pool });
    assert.deepEqual(first.reminded.map((r) => [r.response_id, r.to]), [[id, 'asha@example.com']]);
    assert.deepEqual((await runQuestionnaireReminders({ db: pool })).reminded, [], 'not again the same day');
    await age();
    assert.equal((await runQuestionnaireReminders({ db: pool })).reminded.length, 1, 'a second');
    await age();
    assert.equal((await runQuestionnaireReminders({ db: pool })).reminded.length, 0, 'never a third');
    const { rows: [n] } = await pool.query(`SELECT count(*)::int AS n FROM email_log WHERE template = 'questionnaire_reminder'`);
    assert.equal(n.n, 2);
    await pool.query(`UPDATE settings SET value = '0' WHERE key = 'questionnaire_reminder_days'`);
    assert.equal((await runQuestionnaireReminders({ db: pool })).skipped, 'switched off in Settings');
    await pool.query(`UPDATE settings SET value = '3' WHERE key = 'questionnaire_reminder_days'`);
  });
});
