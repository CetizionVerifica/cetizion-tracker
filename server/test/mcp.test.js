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
    const asha = await token({ name: 'Asha writes', role: 'sales', person: 'Asha' });
    const note = await call(asha.token, 'add_note', { entity: 'quotation', id: 'QT-ASHA', text: 'Client asked for a call on Friday' });
    assert.equal(note.error, false, note.text);
    assert.equal((await call(asha.token, 'update_next_step', { quotation_no: 'QT-ASHA', next_step: 'Call on Friday' })).error, false);
    const timeline = await request(app).get('/api/timeline?entity=quotation&id=QT-ASHA&kind=note').set('Cookie', staff);
    assert.match(JSON.stringify(timeline.body), /via MCP/);
    const list = await request(app).get('/api/api-tokens').set('Cookie', staff);
    assert.ok(list.body.log.some((l) => l.tool === 'add_note' && l.name === 'Asha writes'));
    assert.ok(!JSON.stringify(list.body).includes(asha.token), 'the token value is never listed');
  });

  test('revoking a token stops it at once, and nothing destructive exists', async () => {
    const t = await token({ name: 'Short lived', role: 'admin' });
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
