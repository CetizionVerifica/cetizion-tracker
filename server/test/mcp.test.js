import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The MCP server (#50): a sales token sees only its person's records, an
 * admin token sees all, a revoked token sees nothing, and nothing can be
 * deleted, re-staged or paid. Needs TEST_DATABASE_URL; skipped otherwise.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mcp_test_${process.pid}`;
let app; let pool; let staff;

async function fixtures(client) {
  await client.query(`
    INSERT INTO companies (id, name) VALUES (1001, 'Asha Client Ltd'), (1002, 'Ravi Client Ltd');
    INSERT INTO quotations (quotation_no, client_name, quotation_date, quotation_value, status, sales_person)
      VALUES ('QT-ASHA', 'Asha Client Ltd', '2026-07-01', 100000, 'Submitted', 'Asha'), ('QT-RAVI', 'Ravi Client Ltd', '2026-07-01', 900000, 'Submitted', 'Ravi');
    INSERT INTO projects (project_id, client_name, sales_person) VALUES ('PRJ-ASHA', 'Asha Client Ltd', 'Asha'), ('PRJ-RAVI', 'Ravi Client Ltd', 'Ravi');
    INSERT INTO purchase_orders (po_number, project_id, po_date, po_value) VALUES ('PO-ASHA', 'PRJ-ASHA', '2026-06-01', 100000), ('PO-RAVI', 'PRJ-RAVI', '2026-06-01', 900000);
    INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
      VALUES ('PO-ASHA', 1, 'Advance', 'On PO Registration', 1, 'INV-ASHA', '2026-06-02'), ('PO-RAVI', 1, 'Advance', 'On PO Registration', 1, 'INV-RAVI', '2026-06-02');
  `);
}

describe('MCP server scoping', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    await fixtures(client);
    await client.end();
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_USERNAME: 'tester', AUTH_PASSWORD: 'a-good-long-test-password', SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass' });
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const signIn = await request(app).post('/api/auth/login').send({ username: 'tester', password: 'a-good-long-test-password' });
    staff = signIn.headers['set-cookie'][0].split(';')[0];
  });

  after(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const token = async (body) => (await request(app).post('/api/api-tokens').set('Cookie', staff).send(body).expect(201)).body.data;
  let id = 0;
  async function call(tok, name, args = {}) {
    id += 1;
    const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${tok}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    if (res.status !== 200) return { status: res.status };
    const r = res.body.result;
    return { status: 200, error: Boolean(r.isError), text: r.content.map((c) => c.text).join('\n') };
  }

  test('a sales token sees only its own records, on every tool', async () => {
    const asha = (await token({ name: 'Asha', role: 'sales', person: 'asha' })).token;
    const pipeline = await call(asha, 'list_pipeline');
    assert.match(pipeline.text, /QT-ASHA/);
    assert.doesNotMatch(pipeline.text, /QT-RAVI|Ravi/);
    assert.equal((await call(asha, 'get_quotation', { quotation_no: 'QT-RAVI' })).error, true);
    assert.equal((await call(asha, 'get_project', { project_id: 'PRJ-RAVI' })).error, true);
    assert.equal((await call(asha, 'get_po', { po_number: 'PO-RAVI' })).error, true);
    assert.equal((await call(asha, 'get_company', { company_id: 1002 })).error, true);
    const own = await call(asha, 'get_company', { company_id: 1001 });
    assert.equal(own.error, false, own.text);
    const search = await call(asha, 'search_records', { text: 'Client' });
    assert.match(search.text, /Asha Client/);
    assert.doesNotMatch(search.text, /Ravi/);
    const collections = await call(asha, 'list_collections', { overdue_only: false });
    assert.match(collections.text, /INV-ASHA/);
    assert.doesNotMatch(collections.text, /INV-RAVI/);
    const kpis = JSON.parse((await call(asha, 'get_kpis', { from: '2026-01-01', to: '2026-12-31', person: 'Ravi' })).text);
    assert.equal(kpis.person, 'asha');
    assert.equal(kpis.quotations_issued, 1);
    assert.equal((await call(asha, 'list_activity', { entity: 'quotation', id: 'QT-RAVI' })).error, true);
    assert.equal((await call(asha, 'add_note', { entity: 'quotation', id: 'QT-RAVI', text: 'should not land' })).error, true);
  });

  test('an admin token sees everything', async () => {
    const admin = (await token({ name: 'Admin', role: 'admin' })).token;
    const pipeline = await call(admin, 'list_pipeline');
    assert.match(pipeline.text, /QT-ASHA/);
    assert.match(pipeline.text, /QT-RAVI/);
    assert.ok(JSON.parse((await call(admin, 'get_kpis', { from: '2026-01-01', to: '2026-12-31' })).text).quotations_issued >= 2);
  });

  test('writes are marked as made through MCP and logged', async () => {
    const asha = await token({ name: 'Asha writes', role: 'sales', person: 'Asha', can_write: true });
    const note = await call(asha.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'Client asked for a call on Friday' });
    assert.equal(note.error, false, note.text);
    assert.equal((await call(asha.token, 'update_next_step', { quotation_no: 'QT-ASHA', next_step: 'Call on Friday' })).error, false);
    const timeline = await request(app).get('/api/timeline?entity=quotation&id=QT-ASHA&kind=note').set('Cookie', staff);
    assert.match(JSON.stringify(timeline.body), /via MCP/);
    const list = await request(app).get('/api/api-tokens').set('Cookie', staff);
    assert.ok(list.body.log.some((l) => l.tool === 'add_note' && l.name === 'Asha writes'));
    assert.ok(!JSON.stringify(list.body).includes(asha.token), 'the token value is never listed');
  });

  test('a token reads unless it was given writing, and does not pretend otherwise', async () => {
    // role says whose records a token sees; it never said whether the token
    // may change them, so a token issued to answer questions could write
    // notes and tasks on everything it could see (#50).
    const reader = await token({ name: 'Reads only', role: 'admin' });
    assert.equal(reader.can_write, false, 'a token asked for without saying otherwise is a reading token');

    const tools = await request(app).post('/api/mcp').set('Authorization', `Bearer ${reader.token}`).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 300, method: 'tools/list' });
    const names = tools.body.result.tools.map((t) => t.name);
    for (const w of ['create_task', 'add_note', 'log_touch', 'update_next_step']) {
      assert.ok(!names.includes(w), `${w} is offered to a token that may not write`);
    }
    assert.ok(names.includes('list_pipeline'), 'and it can still do its job');
    assert.match(tools.body.result.tools.length ? JSON.stringify(tools.body) : '', /list_pipeline/);

    // Not merely hidden: asked for by name, it is refused.
    const tried = await call(reader.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'Trying to write' });
    assert.ok(tried.error || tried.status !== 200, 'a hidden tool is still refused when called directly');
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notes WHERE body = 'Trying to write'`);
    assert.equal(rows[0].n, 0, 'and nothing was written');

    // A token given writing still writes.
    const writer = await token({ name: 'May write', role: 'admin', can_write: true });
    assert.equal(writer.can_write, true);
    const wrote = await call(writer.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'A note from a writing token' });
    assert.equal(wrote.error, false, wrote.text);
  });

  test('a database error is not handed to the client verbatim', async () => {
    // 31 February passes the YYYY-MM-DD check and fails in Postgres. The
    // raw text names the column and the value, and it is written to the
    // token log, which every signed-in person can read.
    const t = await token({ name: 'Clumsy', role: 'admin', can_write: true });
    const bad = await call(t.token, 'create_task', { entity: 'quotation', id: 'QT-ASHA', title: 'A task with an impossible date', due_on: '2026-02-31' });
    assert.equal(bad.error, true);
    assert.doesNotMatch(bad.text, /out of range|due_on|column|relation|syntax/i, `raw database text reached the client: ${bad.text}`);
    assert.match(bad.text, /could not do that/);

    // The detail is not lost: it is in the log, where it belongs.
    const { rows } = await pool.query(`SELECT error FROM api_token_log WHERE tool = 'create_task' AND NOT ok ORDER BY id DESC LIMIT 1`);
    assert.match(rows[0].error, /date|range/i, 'the reason is recorded for whoever has to fix it');

    // And what the tracker does mean to say still reaches the client: a
    // record this token may not see is named as not found, not masked.
    const sales = await token({ name: 'Asha reads', role: 'sales', person: 'asha', can_write: true });
    const notMine = await call(sales.token, 'create_task', { entity: 'quotation', id: 'QT-RAVI', title: 'A task on a deal that is not theirs' });
    assert.equal(notMine.error, true);
    assert.match(notMine.text, /was not found/);
  });

  test('the rate limit is one budget per token, not one for everybody', async () => {
    // Behind a proxy every MCP client arrives from the same address, so an
    // address bucket is shared by all of them: one busy client starves the
    // rest. #50 asks for it to be per token.
    const a = await token({ name: 'Client A', role: 'admin' });
    const b = await token({ name: 'Client B', role: 'admin' });
    const remaining = async (tok) => {
      const res = await request(app).post('/api/mcp').set('Authorization', `Bearer ${tok}`).set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 500, method: 'tools/list' });
      return Number(res.headers['ratelimit-remaining']);
    };
    const first = await remaining(a.token);
    const second = await remaining(a.token);
    assert.equal(second, first - 1, 'the same token spends its own budget');
    const other = await remaining(b.token);
    assert.equal(other, first, 'a different token starts from its own, not from what the first one left');
  });

  test('revoking a token stops it at once, and nothing destructive exists', async () => {
    const t = await token({ name: 'Short lived', role: 'admin', can_write: true });
    const tools = await request(app).post('/api/mcp').set('Authorization', `Bearer ${t.token}`).set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    const names = tools.body.result.tools.map((x) => x.name);
    assert.ok(names.length >= 13);
    for (const n of names) assert.doesNotMatch(n, /delete|remove|status|pay|stage_move|send/);
    await request(app).post(`/api/api-tokens/${t.id}/revoke`).set('Cookie', staff).expect(200);
    assert.equal((await call(t.token, 'list_pipeline')).status, 401);
    assert.equal((await call('ctz_not-a-real-token-at-all-000000000000', 'list_pipeline')).status, 401);
    assert.equal((await request(app).post('/api/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  });
});
