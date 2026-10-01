import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * /api/insights against a real database (docs/insights-dashboard-plan.md §7):
 * who sees which rows in every section, that ?owner= is an admin's filter
 * only, that other currencies convert at the record-date rate (or are listed
 * as unconverted), and that the totals agree with /collections and /pipeline.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-good-long-test-password';
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

describe('insights API', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let dbUrl;
  let db;
  let app;
  let pool;
  const ids = {};
  const cookies = {};

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    const name = `insights_api_${process.pid}_${Date.now()}`;
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();
    const u = new URL(ADMIN_URL);
    u.pathname = `/${name}`;
    dbUrl = u.toString();

    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    const { createUser } = await import('../src/lib/users.js');

    for (const [key, name, email, role] of [['asha', 'Asha', 'asha@qa.example', 'sales'], ['ben', 'Ben', 'ben@qa.example', 'sales'], ['meera', 'Meera', 'meera@qa.example', 'admin']]) {
      ids[key] = (await createUser({ name, email, role, password: PASSWORD }, db)).id;
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      cookies[key] = res.headers['set-cookie'];
    }

    // One dollar is 80 rupees from the start of 2026; there is no euro rate.
    await db.query(`INSERT INTO exchange_rates (from_currency, to_currency, rate, effective_from) VALUES ('USD', 'INR', 80, '2026-01-01')`);

    // Quotations sent in January and never touched since: all overdue for follow-up.
    await db.query(
      `INSERT INTO quotations (quotation_no, client_name, status, quotation_date, quotation_value, currency, owner_user_id) VALUES
        ('Q-A1', 'Hetero', 'Submitted', '2026-01-10', 100000, 'INR', $1),
        ('Q-A2', 'Acme',   'Submitted', '2026-01-10', 1000,   'USD', $1),
        ('Q-A3', 'Euro',   'Submitted', '2026-01-10', 500,    'EUR', $1),
        ('Q-B1', 'Midal',  'Submitted', '2026-01-10', 50000,  'INR', $2)`,
      [ids.asha, ids.ben]
    );
    // Enquiries nobody has answered.
    await db.query(
      `INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, status, estimated_value, owner_user_id, created_at) VALUES
        ('ENQ-A', '2026-01-05', 'Hetero', 'New', 20000, $1, '2026-01-05T05:00:00Z'),
        ('ENQ-B', '2026-01-05', 'Midal',  'New', 10000, $2, '2026-01-05T05:00:00Z')`,
      [ids.asha, ids.ben]
    );
    // Each owner has a project with an invoiced, unpaid stage; Asha also has a
    // dollar invoice and a euro one.
    await db.query(`INSERT INTO projects (project_id, client_name, owner_user_id) VALUES ('P-A', 'Hetero', $1), ('P-B', 'Midal', $2)`, [ids.asha, ids.ben]);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency) VALUES
        ('PO-A', 'P-A', '2026-01-15', 200000, 'INR'), ('PO-AU', 'P-A', '2026-02-01', 1000, 'USD'),
        ('PO-AE', 'P-A', '2026-02-01', 400, 'EUR'), ('PO-B', 'P-B', '2026-01-15', 100000, 'INR')`
    );
    await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date, credit_days) VALUES
        ('PO-A', 1, 'Advance', 1, 'INV-A', '2026-01-20', 30), ('PO-AU', 1, 'Advance', 1, 'INV-AU', '2026-02-05', 30),
        ('PO-AE', 1, 'Advance', 1, 'INV-AE', '2026-02-05', 30), ('PO-B', 1, 'Advance', 1, 'INV-B', '2026-01-20', 30)`
    );
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${new URL(dbUrl).pathname.slice(1)} WITH (FORCE)`);
    await root.end();
  });

  const get = (who, path) => request(app).get(path).set('Cookie', cookies[who]);
  const insights = async (who, qs = '') => {
    const res = await get(who, `/api/insights${qs}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const key of ['follow_ups', 'receivables', 'enquiry_risk', 'po_pipeline', 'revenue']) {
      assert.equal(res.body.data[key].error, undefined, `${key}: ${res.body.data[key].error}`);
    }
    return res.body.data;
  };
  const numbers = (rows) => rows.map((r) => r.number).sort();

  test('IN-01: a sales user sees only their own records in every section', async () => {
    const d = await insights('asha');
    assert.equal(d.scope.unrestricted, false);
    assert.deepEqual(d.owners, [], 'no staff list for a sales user');
    assert.deepEqual(numbers(d.follow_ups.top), ['Q-A1', 'Q-A2', 'Q-A3']);
    assert.equal(d.follow_ups.count, 3);
    assert.deepEqual(numbers(d.enquiry_risk.top), ['ENQ-A']);
    assert.equal(d.enquiry_risk.by_reason.find((r) => r.reason === 'no_reply').count, 1);
    assert.deepEqual(d.receivables.top.map((r) => r.invoice_no).sort(), ['INV-A', 'INV-AU']);
    const sent = d.po_pipeline.stages.find((s) => s.label === 'Sent');
    assert.equal(sent.count, 3, 'her three sent quotations');
  });

  test('IN-02: owner= is ignored for a sales user', async () => {
    const own = await insights('ben');
    const asked = await insights('ben', `?owner=${ids.asha}`);
    assert.deepEqual(numbers(asked.follow_ups.top), ['Q-B1']);
    assert.deepEqual(asked.follow_ups, own.follow_ups);
    assert.equal(asked.receivables.outstanding, own.receivables.outstanding);
  });

  test('IN-03: an admin sees everything, or one owner with owner=', async () => {
    const all = await insights('meera');
    assert.equal(all.scope.unrestricted, true);
    assert.deepEqual(all.owners.map((o) => o.name), ['Asha', 'Ben', 'Meera']);
    assert.equal(all.follow_ups.count, 4);
    assert.equal(all.enquiry_risk.count, 2);
    const asha = await insights('meera', `?owner=${ids.asha}`);
    assert.equal(asha.scope.owner_user_id, ids.asha);
    assert.deepEqual(numbers(asha.follow_ups.top), ['Q-A1', 'Q-A2', 'Q-A3']);
    assert.equal(asha.owners.length, 3, 'the picker stays, so the admin can pick again');
  });

  test('IN-04: other currencies convert at the record-date rate; a missing rate is unconverted', async () => {
    const d = await insights('asha');
    assert.equal(d.follow_ups.value_inr, 100000 + 1000 * 80);
    assert.equal(d.follow_ups.unconverted, 1, 'the euro quotation');
    assert.equal(d.receivables.outstanding, 200000 + 1000 * 80);
    assert.deepEqual(d.receivables.unconverted.map((r) => r.invoice_no), ['INV-AE']);
  });

  test('IN-05: the same totals as /collections and /pipeline for an admin', async () => {
    const d = await insights('meera');
    const collections = (await get('meera', '/api/collections')).body.data;
    // /collections is rupees only and lists the rest; Insights converts the dollar invoice.
    assert.equal(d.receivables.outstanding, collections.totals.outstanding + 1000 * 80);
    assert.equal(d.receivables.overdue, collections.totals.overdue + 1000 * 80);
    const usd = d.receivables.top.find((r) => r.invoice_no === 'INV-AU');
    for (const b of d.receivables.buckets) {
      assert.equal(b.amount, collections.totals.buckets[b.key] + (bandOf(usd.days_overdue) === b.key ? 80000 : 0), b.key);
    }
    const pipeline = (await get('meera', '/api/pipeline')).body.data;
    for (const s of d.po_pipeline.stages.filter((x) => x.stage_id)) {
      const board = pipeline.stages.find((x) => x.id === s.stage_id);
      assert.equal(s.count, board.count, s.label);
      assert.equal(s.weighted, Math.round(board.weighted * 100) / 100, s.label);
    }
  });

  test('IN-06: POs not fully paid are on the PO side, revisions and cancellations are not', async () => {
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, cancelled) VALUES ('PO-X', 'P-A', '2026-03-01', 999, true)`);
    try {
      const d = await insights('asha');
      const total = d.po_pipeline.po_status.reduce((n, s) => n + s.count, 0);
      assert.equal(total, 3, 'PO-A, PO-AU, PO-AE; not the cancelled PO-X');
    } finally {
      await db.query(`DELETE FROM purchase_orders WHERE po_number = 'PO-X'`);
    }
  });

  test('IN-07: revenue rolls into quarters, and order basis carries the target', async () => {
    const months = await insights('meera', '?granularity=month&horizon=6');
    assert.ok(months.revenue.periods.length >= 6);
    const quarters = await insights('meera', '?granularity=quarter&horizon=6');
    assert.ok(quarters.revenue.periods.every((p) => /^Q\d FY\d\d-\d\d$/.test(p.label)));
    const sum = (list, f) => Math.round(list.reduce((n, p) => n + p[f], 0));
    // The quarter window may run a month or two longer, never shorter.
    assert.ok(sum(quarters.revenue.periods, 'invoiced') >= sum(months.revenue.periods, 'invoiced'));

    const year = Number(months.today.slice(0, 4));
    await db.query(
      `INSERT INTO sales_targets (salesperson_user_id, calendar_year, metric, target_value, unit, currency)
       VALUES ($1, $2, 'order_intake_value', 1200000, 'currency', 'INR')`, [ids.asha, year]
    );
    const order = await insights('asha', '?basis=order&horizon=3');
    assert.equal(order.revenue.basis, 'order');
    const current = order.revenue.periods.find((p) => p.period === months.today.slice(0, 7));
    assert.equal(current.target, 100000, 'a twelfth of the annual target');
    const ben = await insights('ben', '?basis=order&horizon=3');
    assert.ok(ben.revenue.periods.every((p) => p.target === null), 'Asha\'s target is not Ben\'s');
  });

  test('IN-09: the lists open on what Insights counted', async () => {
    const list = async (who, path) => {
      const res = await get(who, path);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.data.map((r) => r.quotation_no ?? r.enquiry_no).sort();
    };
    assert.deepEqual(await list('asha', '/api/quotations?follow_up=overdue'), ['Q-A1', 'Q-A2', 'Q-A3']);
    assert.deepEqual(await list('meera', '/api/quotations?follow_up=overdue'), ['Q-A1', 'Q-A2', 'Q-A3', 'Q-B1']);
    assert.deepEqual(await list('meera', '/api/quotations?follow_up=overdue&overdue_days=0-3'), [], 'all of them are months late');
    assert.deepEqual(await list('meera', '/api/quotations?follow_up=overdue&overdue_days=15%2B'), ['Q-A1', 'Q-A2', 'Q-A3', 'Q-B1']);
    assert.deepEqual(await list('ben', '/api/enquiries?risk=no_reply'), ['ENQ-B']);
    assert.deepEqual(await list('meera', '/api/enquiries?risk=at_risk'), ['ENQ-A', 'ENQ-B']);
    assert.deepEqual(await list('meera', '/api/enquiries?risk=decision_near'), []);
    assert.deepEqual(await list('meera', '/api/quotations?month=2026-01'), ['Q-A1', 'Q-A2', 'Q-A3', 'Q-B1']);
    assert.deepEqual(await list('meera', '/api/quotations?month=2026-02'), []);
    await db.query(`UPDATE quotations SET expected_close_date = '2026-12-15' WHERE quotation_no = 'Q-B1'`);
    assert.deepEqual(await list('meera', '/api/quotations?close_month=2026-12'), ['Q-B1']);
    assert.deepEqual(await list('asha', '/api/quotations?close_month=2026-12'), [], 'still scoped');
  });

  test('IN-08: nonsense options fall back to the defaults', async () => {
    const d = await insights('asha', '?granularity=week&horizon=7&basis=x');
    assert.deepEqual([d.granularity, d.horizon, d.basis], ['month', 6, 'cash']);
  });
});

function bandOf(days) {
  if (days <= 0) return 'not-due';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
