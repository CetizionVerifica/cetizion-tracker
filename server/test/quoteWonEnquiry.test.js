import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * quoteWonEnquiry (lib/enquiries.js), pinned as it behaves (#208 phase 2B):
 * the Draft quotation an enquiry gets when it is marked Converted. Generating
 * a quotation from questionnaire answers creates its quotation the same way,
 * so what this writes is written down here before that part is shared.
 * Every company and person is made up. Needs TEST_DATABASE_URL (CI sets it).
 *
 * QWE_GOLDEN=<file> also writes every row it created, for a before/after diff.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `quote_won_enquiry_${process.pid}`;

let pool; let quoteWonEnquiry; let businessToday; let sam;
const golden = {};
// Columns that differ run to run (ids, clocks), not by what the function decides.
const VOLATILE = new Set(['id', 'quotation_id', 'created_at', 'updated_at', 'stage_changed_at', 'approval_requested_at', 'last_contacted_at']);
const steady = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE.has(k)).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));

describe('quoteWonEnquiry', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    ({ pool } = await import('../src/db.js'));
    ({ quoteWonEnquiry } = await import('../src/lib/enquiries.js'));
    ({ businessToday } = await import('../src/lib/businessDate.ts'));
    const { createUser } = await import('../src/lib/users.js');
    sam = await createUser({ name: 'Sam Sales', email: 'sam@cetizion.example', role: 'sales', password: 'a-good-long-test-password' }, pool);
    await pool.query(`
      INSERT INTO services (name, description, default_rate, currency, unit, gst_rate) VALUES
        ('Example audit', 'Example audit, two days on site', 40000, 'INR', 'man-day', 18),
        ('Gap review', NULL, 500, 'USD', 'engagement', 0)`);
  });

  after(async () => {
    if (process.env.QWE_GOLDEN) writeFileSync(process.env.QWE_GOLDEN, JSON.stringify(golden, null, 2));
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  /** An enquiry row, saved, and the function run on it as the save hook would. */
  async function convert(fields, { beforeStatus = 'Qualified' } = {}) {
    const cols = { client_name: 'Example Industries', status: 'Converted', currency: 'INR', ...fields };
    const keys = Object.keys(cols);
    const { rows: [enquiry] } = await pool.query(
      `INSERT INTO enquiries (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(cols));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await quoteWonEnquiry(client, { before: { ...enquiry, status: beforeStatus }, after: enquiry });
      await client.query('COMMIT');
      return { enquiry, result };
    } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  }
  const created = async (no) => {
    const { rows: [q] } = await pool.query('SELECT * FROM quotations WHERE quotation_no = $1', [no]);
    const { rows: lines } = await pool.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
    const { rows: [e] } = await pool.query('SELECT quotation_no FROM enquiries WHERE quotation_no = $1', [no]);
    return { q, lines, linked: e?.quotation_no ?? null };
  };
  const remember = async (name, no) => { const c = await created(no); golden[name] = { quotation: steady(c.q), lines: c.lines.map(steady), linked: c.linked }; return c; };

  test('one service: a Draft dated as the enquiry, one line at the enquiry\'s estimate, linked back to the enquiry', async () => {
    const { result } = await convert({
      enquiry_no: 'ENQ-W1', enquiry_date: '2026-03-05', contact_person: 'Asha Example', sector: 'Metals', service: 'Example audit',
      estimated_value: 55000, sales_person: 'Sam Sales', sales_person_email: 'sam@cetizion.example', owner_user_id: sam.id,
    });
    assert.deepEqual(Object.keys(result), ['quotation_created']);
    assert.match(result.quotation_created, /2026/, 'numbered in the year of its own date');
    const { q, lines, linked } = await remember('one_service', result.quotation_created);
    assert.equal(linked, result.quotation_created, 'the enquiry now names its quotation');
    assert.equal(q.client_name, 'Example Industries');
    assert.equal(q.contact_person, 'Asha Example');
    assert.equal(q.service_quoted, 'Example audit');
    assert.equal(q.sector, 'Metals');
    assert.equal(q.sales_person, 'Sam Sales');
    assert.equal(q.sales_person_email, 'sam@cetizion.example');
    assert.equal(q.status, 'Draft');
    assert.equal(q.remarks, 'From enquiry ENQ-W1');
    assert.equal(q.currency, 'INR');
    assert.equal(q.owner_user_id, sam.id, 'the enquiry\'s owner');
    assert.equal(q.originating_user_id, null);
    assert.equal(q.originating_user_snapshot_id, null);
    assert.equal(q.originating_user_name, null);
    const { rows: [{ d }] } = await pool.query('SELECT quotation_date::text AS d FROM quotations WHERE id = $1', [q.id]);
    assert.equal(d, '2026-03-05');
    assert.equal(lines.length, 1);
    const [l] = lines;
    assert.equal(l.description, 'Example audit, two days on site', 'the catalogue description');
    assert.equal(Number(l.qty), 1);
    assert.equal(l.unit, 'man-day');
    assert.equal(Number(l.rate), 55000, 'a single service carries the estimate as its rate');
    assert.equal(Number(l.gst_rate), 18);
    assert.equal(l.sort_order, 0);
    assert.equal(l.generated, false);
    assert.equal(l.price_needed, false);
    assert.equal(Number(q.quotation_value), 64900, 'the totals trigger sets the value from the lines: 55,000 + 18% GST');
  });

  test('several services: a line each, at the catalogue rate only in the quotation\'s currency, otherwise 0', async () => {
    const { result } = await convert({ enquiry_no: 'ENQ-W2', enquiry_date: '2026-03-06', service: 'Example audit', services_interested: 'Gap review, Unknown thing', estimated_value: 90000 });
    const { lines, q } = await remember('several_services', result.quotation_created);
    assert.equal(q.service_quoted, 'Example audit');
    assert.deepEqual(lines.map((l) => [l.description, Number(l.rate), l.unit, Number(l.gst_rate), l.sort_order, l.service_id !== null]), [
      ['Example audit, two days on site', 40000, 'man-day', 18, 0, true],
      ['Gap review', 0, 'engagement', 0, 1, true],      // a USD rate on an INR quotation: not used
      ['Unknown thing', 0, null, 18, 2, false],         // not in the catalogue
    ]);
  });

  test('no service picked: the typed services stand in for it', async () => {
    const { result } = await convert({ enquiry_no: 'ENQ-W3', enquiry_date: '2026-03-07', services_interested: 'Example audit', estimated_value: null });
    const { q, lines } = await remember('services_interested_only', result.quotation_created);
    assert.equal(q.service_quoted, 'Example audit');
    assert.equal(Number(lines[0].rate), 40000, 'no estimate: the catalogue rate');
  });

  test('no enquiry date: dated today, numbered in this year', async () => {
    const { result } = await convert({ enquiry_no: 'ENQ-W4', service: 'Example audit', estimated_value: 1000 });
    const today = businessToday();
    assert.match(result.quotation_created, new RegExp(today.slice(0, 4)));
    const { rows: [{ d }] } = await pool.query('SELECT quotation_date::text AS d FROM quotations WHERE quotation_no = $1', [result.quotation_created]);
    assert.equal(d, today);
    golden.no_date = { dated_today: d === today };
  });

  test('a foreign-currency enquiry keeps its currency, and its estimate', async () => {
    const { result } = await convert({ enquiry_no: 'ENQ-W5', enquiry_date: '2026-03-08', service: 'Gap review', estimated_value: 750, currency: 'USD' });
    const { q, lines } = await remember('foreign_currency', result.quotation_created);
    assert.equal(q.currency, 'USD');
    assert.equal(Number(lines[0].rate), 750);
  });

  test('the originating salesperson is carried only when the enquiry has one', async () => {
    const a = await convert({ enquiry_no: 'ENQ-W6', enquiry_date: '2026-03-09', service: 'Example audit', estimated_value: 1,
      originating_user_id: sam.id, originating_user_snapshot_id: sam.id, originating_user_name: 'Sam Sales' });
    const qa = (await remember('originating_full', a.result.quotation_created)).q;
    assert.deepEqual([qa.originating_user_id, qa.originating_user_snapshot_id, qa.originating_user_name], [sam.id, sam.id, 'Sam Sales']);
    const b = await convert({ enquiry_no: 'ENQ-W7', enquiry_date: '2026-03-09', service: 'Example audit', estimated_value: 1, originating_user_id: sam.id });
    const qb = (await remember('originating_id_only', b.result.quotation_created)).q;
    assert.deepEqual([qb.originating_user_id, qb.originating_user_snapshot_id, qb.originating_user_name], [sam.id, sam.id, null], 'the snapshot falls back to the id');
  });

  test('nothing is created when the enquiry is not newly won, or already has a quotation', async () => {
    const count = async () => Number((await pool.query('SELECT count(*) FROM quotations')).rows[0].count);
    const n = await count();
    assert.equal((await convert({ enquiry_no: 'ENQ-W8', status: 'Qualified', service: 'Example audit', estimated_value: 1 })).result, undefined, 'not won');
    assert.equal((await convert({ enquiry_no: 'ENQ-W9', service: 'Example audit', estimated_value: 1 }, { beforeStatus: 'Converted' })).result, undefined, 'already won before this save');
    // A quotation of its own (an enquiry names at most one, and a quotation belongs to at most one enquiry).
    await pool.query(`INSERT INTO quotations (quotation_no, client_name, status) VALUES ('Q-EXISTING', 'Example Industries', 'Draft')`);
    assert.equal((await convert({ enquiry_no: 'ENQ-W10', service: 'Example audit', estimated_value: 1, quotation_no: 'Q-EXISTING' })).result, undefined, 'already has one');
    assert.equal(await count(), n + 1, 'only the quotation this test made itself');
  });
});
