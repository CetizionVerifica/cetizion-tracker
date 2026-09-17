import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import { buildWhere } from '../src/lib/crud.js';
import { resources } from '../src/lib/resources.js';

/**
 * The quotation rules that live in the database (#25, #46): discount
 * approval, the pipeline stage trigger and the stage backfill. Each run gets
 * a throwaway database built from schema.sql and views.sql, so this needs TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
const views = readFileSync(new URL('../db/views.sql', import.meta.url), 'utf8');
const pipelineMigration = readFileSync(new URL('../db/migrations/014_pipeline.sql', import.meta.url), 'utf8');

test('old enquiry statuses still filter the list', () => {
  const params = [];
  const where = buildWhere(resources.enquiries, { status: 'In Progress,Qualified' }, params);
  assert.match(where, /status/);
  assert.deepEqual(params[0], ['Contacted', 'Qualified']);
});

describe('quotation rules in the database', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  const name = `pipeline_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  let admin; let db;
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];

  before(async () => {
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query("SET TIME ZONE 'UTC'");
    await db.query(schema);
    await db.query(views);
  });

  after(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
  });

  const stageId = async (stage) => (await one('SELECT id FROM pipeline_stages WHERE name = $1', [stage])).id;
  async function quotation(no, fields = {}) {
    const cols = ['quotation_no', 'client_name', ...Object.keys(fields)];
    const vals = [no, 'Test Client', ...Object.values(fields)];
    return one(`INSERT INTO quotations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, vals);
  }
  async function discount(q, percent) {
    await db.query('DELETE FROM quotation_lines WHERE quotation_id = $1', [q.id]);
    await db.query('INSERT INTO quotation_lines (quotation_id, description, qty, rate, discount_percent) VALUES ($1, $2, 1, 1000, $3)', [q.id, 'Audit', percent]);
    await db.query('SELECT quotation_totals($1)', [q.id]);
    return one('SELECT approval_status, discount_percent FROM quotations WHERE id = $1', [q.id]);
  }

  test('raising a discount after approval asks for approval again', async () => {
    const q = await quotation('T-DISC-1');
    assert.equal((await discount(q, 12)).approval_status, 'pending');
    await db.query(`UPDATE quotations SET approval_status = 'approved', approved_discount_percent = discount_percent WHERE id = $1`, [q.id]);
    assert.equal((await discount(q, 12)).approval_status, 'approved', 'the approved discount itself stays approved');
    assert.equal((await discount(q, 40)).approval_status, 'pending');
  });

  test('a hand-requested exception does not switch the discount check off', async () => {
    const q = await quotation('T-DISC-2');
    await discount(q, 5);
    await db.query(`UPDATE quotations SET approval_status = 'approved', approval_reason = 'special terms', approved_discount_percent = 5 WHERE id = $1`, [q.id]);
    assert.equal((await discount(q, 5)).approval_status, 'approved');
    assert.equal((await discount(q, 30)).approval_status, 'pending');
  });

  test('a card moved back by hand stays there on later writes', async () => {
    const q = await quotation('T-STAGE-1');
    await db.query('UPDATE quotations SET sent_at = now() WHERE id = $1', [q.id]);
    await db.query('UPDATE quotations SET accepted_at = now() WHERE id = $1', [q.id]);
    assert.equal((await one('SELECT stage_id FROM quotations WHERE id = $1', [q.id])).stage_id, await stageId('Verbal yes, awaiting PO'));
    await db.query('UPDATE quotations SET stage_id = $2 WHERE id = $1', [q.id, await stageId('Negotiation')]);
    await db.query(`UPDATE quotations SET remarks = 'edited' WHERE id = $1`, [q.id]);
    assert.equal((await one('SELECT stage_id FROM quotations WHERE id = $1', [q.id])).stage_id, await stageId('Negotiation'));
  });

  test('clearing the send and acceptance (a revision) moves the card back', async () => {
    const q = await quotation('T-STAGE-2');
    await db.query('UPDATE quotations SET sent_at = now() WHERE id = $1', [q.id]);
    assert.equal((await one('SELECT stage_id FROM quotations WHERE id = $1', [q.id])).stage_id, await stageId('Sent'));
    await db.query('UPDATE quotations SET sent_at = NULL, accepted_at = NULL WHERE id = $1', [q.id]);
    const row = await one('SELECT stage_id, probability FROM quotations WHERE id = $1', [q.id]);
    assert.equal(row.stage_id, await stageId('Draft'));
    assert.equal(row.probability, 10);
  });

  test('reopening a lost card clears the competitor with the reason', async () => {
    const q = await quotation('T-STAGE-3');
    const reason = await one(`SELECT id FROM lost_reasons WHERE name = 'Price'`);
    await db.query('UPDATE quotations SET stage_id = $2, lost_reason_id = $3, competitor = $4 WHERE id = $1', [q.id, await stageId('Lost'), reason.id, 'Rival Ltd']);
    await db.query('UPDATE quotations SET stage_id = $2 WHERE id = $1', [q.id, await stageId('Negotiation')]);
    const row = await one('SELECT lost_reason_id, competitor FROM quotations WHERE id = $1', [q.id]);
    assert.equal(row.lost_reason_id, null);
    assert.equal(row.competitor, null);
  });

  test('the stage backfill keeps the history instead of stamping today', async () => {
    // Old rows: no stage yet, and a last change long ago.
    await db.query('ALTER TABLE quotations DISABLE TRIGGER c_stage_sync, DISABLE TRIGGER quotations_set_updated_at');
    const won = await quotation('T-FILL-WON', { status: 'Won - PO Received', quotation_date: '2025-04-01' });
    const lost = await quotation('T-FILL-LOST', { status: 'Lost', quotation_date: '2025-05-01' });
    const open = await quotation('T-FILL-OPEN', { status: 'Submitted', quotation_date: '2025-06-01' });
    await db.query(`UPDATE quotations SET stage_id = NULL, stage_changed_at = NULL, closed_at = NULL, updated_at = '2025-07-01T10:00:00Z' WHERE quotation_no LIKE 'T-FILL-%'`);
    await db.query(`INSERT INTO projects (project_id, client_name) VALUES ('T-FILL-PRJ', 'Test Client')`);
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value) VALUES ('T-FILL-PO', 'T-FILL-PRJ', 'T-FILL-WON', '2025-04-20', 1000)`);
    await db.query('ALTER TABLE quotations ENABLE TRIGGER c_stage_sync, ENABLE TRIGGER quotations_set_updated_at');

    await db.query(pipelineMigration);

    const get = (id) => one('SELECT stage_id, stage_changed_at, closed_at FROM quotations WHERE id = $1', [id]);
    const w = await get(won.id); const l = await get(lost.id); const o = await get(open.id);
    assert.equal(w.stage_id, await stageId('Won, PO received'));
    assert.equal(w.closed_at.toISOString().slice(0, 10), '2025-04-20', 'a win closes on its PO date');
    assert.equal(l.closed_at.toISOString(), '2025-07-01T10:00:00.000Z', 'a loss closes at its last change');
    assert.equal(o.closed_at, null);
    assert.equal(o.stage_changed_at.toISOString(), '2025-07-01T10:00:00.000Z');
  });
});
