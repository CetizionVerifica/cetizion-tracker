import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Registering a PO from a quotation (#26), at the request level.
 *
 * The one the review caught: a PO value includes GST and a quotation line
 * does not, so scaling the lines by the PO against the quotation total left
 * every service line short by exactly the tax, while the form told users the
 * lines add up to the PO. These assert the arithmetic on a real database.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe('registering a purchase order from a quotation', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let app;
  let agent;
  let dbName;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `register_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();

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
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  /** A quotation with priced lines, ready to register. */
  async function quotationWith(lines) {
    const created = await agent.post('/api/quotations')
      .send({ client_name: `Register test ${Date.now()}${Math.random()}`, service_quoted: 'Audit', quotation_date: '2026-09-21' })
      .expect(201);
    const { id, quotation_no: quotationNo } = created.body.data;
    for (const l of lines) {
      await agent.post('/api/quotation-lines')
        .send({ quotation_id: id, description: l.description, qty: 1, rate: l.rate, gst_rate: l.gst_rate })
        .expect(201);
    }
    const { body } = await agent.get(`/api/quotations/${encodeURIComponent(quotationNo)}`).expect(200);
    return body.data;
  }

  const sum = (rows) => Math.round(rows.reduce((n, r) => n + Number(r.service_value), 0) * 100) / 100;

  test('the service lines add up to the PO value, not to the PO less the GST', async () => {
    const q = await quotationWith([
      { description: 'EcoVadis', rate: 100000, gst_rate: 18 },
      { description: 'ISO 14001', rate: 50000, gst_rate: 18 },
    ]);
    // 150,000 of work, 27,000 of GST, and the client sends a PO for the lot.
    assert.equal(Number(q.total), 177000);

    const poNumber = `REG-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: 177000, project: { client_name: q.client_name } })
      .expect(201);

    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    assert.equal(sum(body.data.services), 177000, 'the lines are what the PO is for, GST included');
  });

  test('a negotiated PO scales every line down, and still adds up', async () => {
    const q = await quotationWith([
      { description: 'EcoVadis', rate: 100000, gst_rate: 18 },
      { description: 'ISO 14001', rate: 50000, gst_rate: 18 },
    ]);
    const poNumber = `REG-CUT-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: 141600, project: { client_name: q.client_name } })
      .expect(201);

    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    assert.equal(sum(body.data.services), 141600);
    // 80% of the PO, so 80% of each line: the proportions survive.
    const byName = Object.fromEntries(body.data.services.map((s) => [s.service, Number(s.service_value)]));
    assert.equal(byName.EcoVadis, 94400);
    assert.equal(byName['ISO 14001'], 47200);
  });

  test('lines at different GST rates each keep their own, and the total is exact', async () => {
    const q = await quotationWith([
      { description: 'Audit', rate: 100000, gst_rate: 18 },
      { description: 'Reimbursables', rate: 10000, gst_rate: 5 },
    ]);
    const poValue = Math.round(Number(q.total) * 100) / 100;
    const poNumber = `REG-MIX-${Date.now()}`;
    await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: poValue, project: { client_name: q.client_name } })
      .expect(201);

    const { body } = await agent.get(`/api/purchase-orders/${encodeURIComponent(poNumber)}/full`).expect(200);
    assert.equal(sum(body.data.services), poValue, 'a rounding paisa never leaves a gap');
    const byName = Object.fromEntries(body.data.services.map((s) => [s.service, Number(s.service_value)]));
    assert.equal(byName.Audit, 118000, '100,000 at 18%');
    assert.equal(byName.Reimbursables, 10500, '10,000 at 5%, not at 18%');
  });

  // ------------------------------------------------------------------ #26

  test('a milestone stage gets its milestone, and reaching it makes the stage billable (#26)', async () => {
    const { rows: [t] } = await db.query(`INSERT INTO payment_terms_templates (name, active) VALUES ('Advance and milestone ${Date.now()}', true) RETURNING id`);
    await db.query(
      `INSERT INTO payment_terms_template_lines (template_id, sort_order, stage_name, percent, trigger_event, milestone_name)
       VALUES ($1, 1, 'Advance', 40, 'On PO Registration', NULL), ($1, 2, 'On stage 1 audit', 60, 'On Milestone', 'Stage 1 audit complete')`, [t.id]);
    const q = await quotationWith([{ description: 'Audit', rate: 100000, gst_rate: 18 }]);
    const poNumber = `REG-MS-${Date.now()}`;
    const reg = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', payment_terms_template_id: t.id, project: { client_name: q.client_name } })
      .expect(201);
    const projectId = reg.body.data.project_id;

    const { body: full } = await agent.get(`/api/projects/${encodeURIComponent(projectId)}/full`).expect(200);
    assert.deepEqual(full.data.milestones.map((m) => [m.name, m.reached_on, m.stages.map((st) => st.stage_name)]),
      [['Stage 1 audit complete', null, ['On stage 1 audit']]]);
    const stageStatus = async () => (await db.query(`SELECT stage_status FROM v_payment_stages WHERE po_number = $1 AND stage_name = 'On stage 1 audit'`, [poNumber])).rows[0].stage_status;
    assert.equal(await stageStatus(), 'Not Due');

    await agent.patch(`/api/project-milestones/${full.data.milestones[0].id}`).send({ reached_on: '2026-10-05' }).expect(200);
    assert.equal(await stageStatus(), 'To Invoice', 'reaching the milestone is what makes the stage billable');
    await agent.patch(`/api/project-milestones/${full.data.milestones[0].id}`).send({ reached_on: null }).expect(200);
    assert.equal(await stageStatus(), 'Not Due', 'and taking it back undoes it');
  });

  test('a PO for another amount says so, and the owner and project manager are told (#26)', async () => {
    const q = await quotationWith([{ description: 'Audit', rate: 100000, gst_rate: 18 }]);
    await db.query(`UPDATE quotations SET sales_person = 'Seller Sam', sales_person_email = 'sam@example.test' WHERE id = $1`, [q.id]);
    const poNumber = `REG-DIFF-${Date.now()}`;
    const { body } = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', po_value: 100000, project_manager: 'Priya PM', project: { client_name: q.client_name } })
      .expect(201);
    assert.equal(body.data.po_value_differs, true);
    assert.equal(Number(body.data.quoted_total), 118000);

    const { rows } = await db.query(`SELECT username, kind, body FROM notifications WHERE kind = 'po_registered' AND entity_id = $1 ORDER BY username`, [body.data.project_id]);
    assert.deepEqual(rows.map((r) => r.username), ['Priya PM', 'sam@example.test'], 'the manager by name, the owner by the email they sign in with');
    assert.match(rows[0].body, /quoted INR 118000/);

    const same = await quotationWith([{ description: 'Audit', rate: 100000, gst_rate: 18 }]);
    const { body: exact } = await agent.post(`/api/quotations/${encodeURIComponent(same.quotation_no)}/register`)
      .send({ po_number: `${poNumber}-B`, po_date: '2026-09-21', project: { client_name: same.client_name } })
      .expect(201);
    assert.equal(exact.data.po_value_differs, false);
  });

  test('the delivery date typed on the project reaches its orders (#26)', async () => {
    const q = await quotationWith([{ description: 'Audit', rate: 100000, gst_rate: 18 }]);
    const poNumber = `REG-DLV-${Date.now()}`;
    const reg = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', project: { client_name: q.client_name } })
      .expect(201);
    const { rows: [pr] } = await db.query('SELECT id FROM projects WHERE project_id = $1', [reg.body.data.project_id]);
    const res = await agent.patch(`/api/projects/${pr.id}`).send({ actual_delivery_date: '2026-11-30' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { rows: [po] } = await db.query('SELECT actual_delivery_date::text AS d FROM purchase_orders WHERE po_number = $1', [poNumber]);
    assert.equal(po.d, '2026-11-30');
    assert.equal(String(res.body.data.actual_delivery_date).slice(0, 10), '2026-11-30', 'and the project reads it back');
  });

  test('the milestone migration gives existing On Milestone stages their milestone (#26)', async () => {
    const q = await quotationWith([{ description: 'Audit', rate: 100000, gst_rate: 18 }]);
    const poNumber = `REG-OLD-${Date.now()}`;
    const reg = await agent.post(`/api/quotations/${encodeURIComponent(q.quotation_no)}/register`)
      .send({ po_number: poNumber, po_date: '2026-09-21', payment_terms_template_id: 0, project: { client_name: q.client_name } })
      .expect(201);
    await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, milestone_name, milestone_reached_on)
       VALUES ($1, 1, 'Report', 'On Milestone', 1, 'Final report', '2026-10-01')`, [poNumber]);
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(new URL('../db/migrations/057_project_milestones.sql', import.meta.url), 'utf8');
    await db.query(migration);
    await db.query(migration);
    const { rows } = await db.query(
      `SELECT m.name, m.reached_on::text AS reached, count(s.id)::int AS stages FROM project_milestones m JOIN payment_stages s ON s.milestone_id = m.id
        WHERE m.project_id = $1 GROUP BY m.id`, [reg.body.data.project_id]);
    assert.deepEqual(rows, [{ name: 'Final report', reached: '2026-10-01', stages: 1 }]);
  });
});
