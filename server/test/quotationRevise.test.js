import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * POST /api/quotations/:key/revise, pinned as it behaves (#208 phase 2B).
 * Generating a quotation from questionnaire answers revises an existing
 * Draft or Submitted one through the same step, so what a revision keeps,
 * resets and records is written down here before that step is shared.
 * Every company and person is made up. Needs TEST_DATABASE_URL (CI sets it).
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `quotation_revise_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';
const SNAPSHOT_KEYS = ['quotation_no', 'revision', 'quotation_date', 'valid_until', 'quotation_value', 'subtotal', 'tax_total', 'total', 'currency', 'terms', 'sent_at', 'lines'];

let app; let pool; let admin; let sam; let bea;
const json = (v) => JSON.parse(JSON.stringify(v));

describe('revising a quotation', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    const mk = async (name, email, role) => {
      const u = await createUser({ name, email, role, password: PASSWORD }, pool);
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return { ...u, email, cookie: res.headers['set-cookie'] };
    };
    admin = await mk('Ada Admin', 'ada@cetizion.example', 'admin');
    sam = await mk('Sam Sales', 'sam@cetizion.example', 'sales');
    bea = await mk('Bea Sales', 'bea@cetizion.example', 'sales');
  });

  after(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  const revise = (who, no, note) => request(app).post(`/api/quotations/${encodeURIComponent(no)}/revise`).set('Cookie', who.cookie).send(note === undefined ? {} : { note });
  const view = (id) => pool.query('SELECT * FROM v_quotations WHERE id = $1', [id]).then((r) => r.rows[0]);
  const row = (id) => pool.query(
    `SELECT revision, status, (SELECT name FROM pipeline_stages WHERE id = quotations.stage_id) AS stage,
            quotation_date::text, valid_until::text, sent_at, accepted_at, accepted_by_name,
            approval_status, approval_reason, approval_requested_at, approval_requested_by, approval_decided_at,
            approved_by, approval_note, approved_discount_percent, discount_percent, subtotal, tax_total, total
       FROM quotations WHERE id = $1`, [id]).then((r) => r.rows[0]);

  /** A quotation of Sam's, as it might stand after going out once. */
  async function quotation(no, { status = 'Submitted', lines = [[2, 1000, 0], [1, 500, 0]], approval = {}, accepted = false } = {}) {
    const { rows: [q] } = await pool.query(
      `INSERT INTO quotations (quotation_no, client_name, quotation_date, valid_until, status, currency, terms, sent_at,
                               accepted_at, accepted_by_name, owner_user_id)
       VALUES ($1, 'Example Industries', '2026-01-10', '2026-02-09', $2, 'INR', 'Payment within 30 days.', now() - interval '3 days',
               CASE WHEN $4 THEN now() - interval '1 day' END, CASE WHEN $4 THEN 'Asha Example' END, $3) RETURNING id`, [no, status, sam.id, accepted]);
    for (const [i, [qty, rate, discount]] of lines.entries()) {
      await pool.query(
        `INSERT INTO quotation_lines (quotation_id, description, qty, rate, discount_percent, gst_rate, sort_order)
         VALUES ($1, $2, $3, $4, $5, 18, $6)`, [q.id, `Line ${i + 1}`, qty, rate, discount, i]);
    }
    if (Object.keys(approval).length) {
      const cols = Object.keys(approval);
      await pool.query(`UPDATE quotations SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [q.id, ...Object.values(approval)]);
    }
    return q.id;
  }

  test('the current version is kept as it stood; the next one starts today, unsent, with its validity reopened', async () => {
    const id = await quotation('Q-REV-1');
    assert.equal((await row(id)).stage, 'Sent', 'set up: sent, so on the Sent stage');
    const before = json(await view(id));
    const lines = json((await pool.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [id])).rows);
    const { rows: [{ days }] } = await pool.query(`SELECT value::int AS days FROM settings WHERE key = 'quotation_validity_days'`);

    const res = await revise(admin, 'Q-REV-1', 'Scope changed').expect(200);
    assert.deepEqual(Object.keys(res.body.data).sort(), ['quotation_date', 'revision', 'valid_until']);
    assert.equal(res.body.data.revision, 1);

    // The history: one row for revision 0, exactly these fields, the lines as they were.
    const { rows: revs } = await pool.query('SELECT revision, note, created_by, snapshot FROM quotation_revisions WHERE quotation_id = $1', [id]);
    assert.equal(revs.length, 1);
    assert.equal(revs[0].revision, 0);
    assert.equal(revs[0].note, 'Scope changed');
    assert.equal(revs[0].created_by, admin.email, 'who revised it: the signed-in user\'s email');
    assert.deepEqual(Object.keys(revs[0].snapshot).sort(), [...SNAPSHOT_KEYS].sort());
    for (const k of SNAPSHOT_KEYS.filter((k) => k !== 'lines')) assert.deepEqual(revs[0].snapshot[k], before[k], k);
    assert.deepEqual(revs[0].snapshot.lines, lines);

    // The quotation: next revision, dated today, valid for the setting's days, not sent or accepted.
    const now = await row(id);
    const { businessToday } = await import('../src/lib/businessDate.ts');
    const today = businessToday();
    assert.equal(now.revision, 1);
    assert.equal(now.quotation_date, today);
    const { rows: [{ expected }] } = await pool.query(`SELECT ($1::date + $2::int)::text AS expected`, [today, days]);
    assert.equal(now.valid_until, expected);
    assert.equal(now.sent_at, null);
    assert.equal(now.accepted_at, null);
    assert.equal(now.accepted_by_name, null);
    // The new version has not gone to the client: the pipeline-stage trigger
    // moves a sent card back from Sent to Draft when sent_at is cleared.
    assert.equal(now.stage, 'Draft');
    assert.equal(now.status, 'Draft', 'a sent quotation, revised, is a Draft again');
    // Lines are not touched, and the totals are worked out again from them.
    assert.deepEqual(json((await pool.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [id])).rows), lines);
    assert.equal(Number(now.subtotal), 2500);
    assert.equal(Number(now.tax_total), 450);
    assert.equal(Number(now.total), 2950);

    // Recorded as an event on the quotation.
    const { rows: acts } = await pool.query(
      `SELECT action, metadata FROM activity_log WHERE entity_type = 'quotation' AND entity_id = 'Q-REV-1' AND metadata->>'event' = 'revised'`);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].metadata.revision, 1);
    assert.equal(acts[0].metadata.note, 'Scope changed');
    assert.equal(acts[0].metadata.client_name, 'Example Industries');
  });

  test('a second revision keeps revision 1 and moves on to 2; no note is kept as no note', async () => {
    await revise(admin, 'Q-REV-1').expect(200);
    const { rows: [{ id }] } = await pool.query(`SELECT id FROM quotations WHERE quotation_no = 'Q-REV-1'`);
    const { rows: revs } = await pool.query('SELECT revision, note, snapshot FROM quotation_revisions WHERE quotation_id = $1 ORDER BY revision', [id]);
    assert.deepEqual(revs.map((r) => [r.revision, r.note, r.snapshot.revision]), [[0, 'Scope changed', 0], [1, null, 1]]);
    assert.equal((await row(id)).revision, 2);
  });

  test('a new version is a new approval round: an approved discount is asked for again', async () => {
    // 20% off, over the default 10% threshold, approved for exactly 20%.
    const id = await quotation('Q-REV-2', {
      lines: [[1, 10000, 20]],
      approval: { approval_status: 'approved', approval_requested_by: 'sam@cetizion.example', approval_requested_at: new Date('2026-01-11'),
        approval_decided_at: new Date('2026-01-12'), approved_by: 'ada@cetizion.example', approval_note: 'Fine this once', approved_discount_percent: 20 },
    });
    await pool.query('SELECT quotation_totals($1)', [id]);
    assert.equal((await row(id)).approval_status, 'approved', 'set up: approved before the revision');

    await revise(admin, 'Q-REV-2').expect(200);
    const now = await row(id);
    assert.equal(now.approval_status, 'pending', 'the discount needs deciding again');
    assert.ok(now.approval_requested_at, 'asked again now');
    for (const k of ['approval_reason', 'approval_requested_by', 'approval_decided_at', 'approved_by', 'approval_note', 'approved_discount_percent']) {
      assert.equal(now[k], null, k);
    }
    assert.equal(Number(now.discount_percent), 20);
  });

  test('without a discount over the threshold, the approval round is simply cleared', async () => {
    const id = await quotation('Q-REV-3', { approval: { approval_status: 'approved', approved_by: 'ada@cetizion.example', approved_discount_percent: 5 } });
    await revise(admin, 'Q-REV-3').expect(200);
    const now = await row(id);
    assert.equal(now.approval_status, 'not_needed');
    assert.equal(now.approved_by, null);
    assert.equal(now.approved_discount_percent, null);
  });

  test('a Lost quotation revised is a Draft again; any other status is kept', async () => {
    const lost = await quotation('Q-REV-4', { status: 'Lost' });
    await revise(admin, 'Q-REV-4').expect(200);
    assert.equal((await row(lost)).status, 'Draft');
    const draft = await quotation('Q-REV-5', { status: 'Draft' });
    await revise(admin, 'Q-REV-5').expect(200);
    assert.equal((await row(draft)).status, 'Draft');
  });

  test('an accepted quotation awaiting its PO, revised, goes back to Negotiation (acceptance is cleared)', async () => {
    const id = await quotation('Q-REV-9', { status: 'Under Negotiation', accepted: true });
    assert.equal((await row(id)).stage, 'Verbal yes, awaiting PO', 'set up: accepted, awaiting the PO');
    await revise(admin, 'Q-REV-9').expect(200);
    const now = await row(id);
    assert.equal(now.stage, 'Negotiation');
    assert.equal(now.status, 'Under Negotiation');
    assert.equal(now.accepted_at, null);
    assert.equal(now.accepted_by_name, null);
  });

  test('a quotation in Negotiation, revised, stays in Negotiation', async () => {
    const id = await quotation('Q-REV-10', { status: 'Under Negotiation' });
    assert.equal((await row(id)).stage, 'Negotiation', 'set up: in negotiation, not accepted');
    await revise(admin, 'Q-REV-10').expect(200);
    const now = await row(id);
    assert.equal(now.stage, 'Negotiation');
    assert.equal(now.status, 'Under Negotiation');
    assert.equal(now.sent_at, null);
  });

  test('a won quotation is not revised, and nothing is written', async () => {
    const id = await quotation('Q-REV-6', { status: 'Won - PO Received' });
    const before = await row(id);
    const res = await revise(admin, 'Q-REV-6', 'try');
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /won quotation is not revised/);
    assert.deepEqual(await row(id), before);
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM quotation_revisions WHERE quotation_id = $1', [id]);
    assert.equal(n, 0);
  });

  test('a salesperson revises their own quotation; another salesperson\'s is not found', async () => {
    const id = await quotation('Q-REV-7');
    assert.equal((await revise(bea, 'Q-REV-7')).status, 404);
    assert.equal((await row(id)).revision, 0, 'nothing written for the refused caller');
    await revise(sam, 'Q-REV-7').expect(200);
    const { rows: [rev] } = await pool.query('SELECT created_by FROM quotation_revisions WHERE quotation_id = $1', [id]);
    assert.equal(rev.created_by, sam.email);
    assert.equal((await row(id)).revision, 1);
  });

  test('a quotation is found by its internal id as well as its number', async () => {
    const id = await quotation('Q-REV-8');
    await revise(admin, String(id)).expect(200);
    assert.equal((await row(id)).revision, 1);
  });
});
