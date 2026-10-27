import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Trip and vendor cost figures that disagreed with themselves.
 *
 *   A rejected expense claim counted as trip cost, so every total built on
 *   a trip's cost (POs, projects, the dashboards) carried money nobody
 *   would pay, and the trip could never read "Reimbursed".
 *
 *   The dashboard's vendor amount owed ignored credit notes.
 *
 *   A credit note naming a leg went in full to every invoice line on that
 *   leg, so two lines on one leg had it taken off twice.
 *
 *   The project page's cost lines were whole invoices joined by the
 *   invoice's own trip (none, for an invoice covering several), before
 *   credit notes, and only for trips with a PO: they did not add up to the
 *   project's totals.
 *
 *   A credit note on no invoice reduces nothing: it is left as it is, but
 *   the project it belongs to shows it as a gap.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const PROJECT = 'PRJ-COST-1';

describe('cost figures', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let agent; let dbName;
  const ids = {};

  before(async () => {
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    dbName = `cost_figures_${process.pid}_${Date.now()}`;
    await owner.query(`CREATE DATABASE ${dbName}`);
    await owner.end();
    const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`;

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    process.env.CLOUDINARY_CLOUD_NAME = '';
    const { default: app } = await import('../src/app.js');
    agent = request.agent(app);
    await agent.post('/api/auth/login').send({ username: 'admin', password: 'a-good-long-test-password' }).expect(200);

    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    // A project with no PO, and two trips on it: costs follow the trip's own project.
    await db.query(`INSERT INTO projects (project_id, client_name) VALUES ($1, 'Cost client')`, [PROJECT]);
    ids.vendor = (await one(`INSERT INTO travel_vendors (name) VALUES ('Cost Agency') RETURNING id`)).id;
    for (const t of ['TRV-C1', 'TRV-C2']) {
      await db.query(
        `INSERT INTO travel_logs (travel_id, employee_name, project_id, vendor_id, trip_type_id, travel_start_date, travel_end_date)
         VALUES ($1, 'Asha', $2, $3, (SELECT id FROM trip_types WHERE name = 'Non-chargeable'), '2026-07-01', '2026-07-03')`,
        [t, PROJECT, ids.vendor]);
    }
    ids.leg1 = (await one(`INSERT INTO travel_segments (travel_id, mode) VALUES ('TRV-C1', 'flight') RETURNING id`)).id;
    ids.leg2 = (await one(`INSERT INTO travel_segments (travel_id, mode) VALUES ('TRV-C2', 'flight') RETURNING id`)).id;

    // One agency invoice over both trips (so its own travel_id is NULL):
    // two lines on trip 1's flight, one line for trip 2. ₹500 paid on it.
    ids.inv1 = (await one(
      `INSERT INTO travel_vendor_invoices (vendor_invoice_id, vendor_id, vendor_invoice_no, invoice_date, invoice_amount, amount_paid)
       VALUES ('VI-C1', $1, 'AG/1', '2026-07-05', 1000, 500) RETURNING id`, [ids.vendor])).id;
    await db.query(
      `INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, segment_id, line_total) VALUES
         ($1, 'TRV-C1', $2, 300), ($1, 'TRV-C1', $2, 100), ($1, 'TRV-C2', NULL, 600)`, [ids.inv1, ids.leg1]);
    // ₹100 back on trip 1's flight: once, spread over its two lines.
    await db.query(
      `INSERT INTO travel_vendor_credit_notes (vendor_id, credit_note_no, against_invoice_id, segment_id, refund_amount)
       VALUES ($1, 'CN-1', $2, $3, 100)`, [ids.vendor, ids.inv1, ids.leg1]);

    // A second invoice, three equal lines, ₹100 back on the invoice: a third
    // each does not go in paise, and the lines must still add up.
    ids.inv2 = (await one(
      `INSERT INTO travel_vendor_invoices (vendor_invoice_id, vendor_id, vendor_invoice_no, invoice_date, invoice_amount, amount_paid)
       VALUES ('VI-C2', $1, 'AG/2', '2026-07-06', 300, 0) RETURNING id`, [ids.vendor])).id;
    await db.query(
      `INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, line_total) VALUES
         ($1, 'TRV-C1', 100), ($1, 'TRV-C1', 100), ($1, 'TRV-C1', 100)`, [ids.inv2]);
    await db.query(
      `INSERT INTO travel_vendor_credit_notes (vendor_id, credit_note_no, against_invoice_id, refund_amount)
       VALUES ($1, 'CN-2', $2, 100)`, [ids.vendor, ids.inv2]);

    // A credit note on trip 2's flight that names no invoice: it reduces nothing.
    await db.query(
      `INSERT INTO travel_vendor_credit_notes (vendor_id, credit_note_no, segment_id, refund_amount)
       VALUES ($1, 'CN-LOOSE', $2, 50)`, [ids.vendor, ids.leg2]);

    // Trip 1's claims: one approved and paid, one rejected.
    await db.query(
      `INSERT INTO employee_expense_claims (claim_id, travel_id, amount_claimed, approval_status, amount_reimbursed) VALUES
         ('CLM-C1', 'TRV-C1', 200, 'Approved', 200), ('CLM-C2', 'TRV-C1', 500, 'Rejected', 0)`);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const owner = new pg.Client({ connectionString: ADMIN_URL });
    await owner.connect();
    await owner.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await owner.end();
  });

  const trip = async (id) => (await db.query('SELECT * FROM v_travel_logs WHERE travel_id = $1', [id])).rows[0];

  test('a rejected claim is not trip cost, and the trip reads reimbursed', async () => {
    const t = await trip('TRV-C1');
    assert.equal(Number(t.employee_claims), 200, 'the ₹500 rejected claim is not counted');
    assert.equal(Number(t.employee_reimbursed), 200);
    assert.equal(t.reimbursement_status, 'Reimbursed');
    // Trip 1's lines on invoice 1: 400 less the ₹100 credit; on invoice 2: 300 less ₹100.
    assert.equal(Number(t.vendor_cost), 500);
    assert.equal(Number(t.total_travel_cost), 700);
  });

  test('a credit note on a leg is taken off once, spread over that leg\'s lines', async () => {
    const { rows } = await db.query(
      'SELECT line_total, credited, net_cost FROM v_travel_invoice_lines WHERE vendor_invoice_id = $1 ORDER BY id', [ids.inv1]);
    assert.deepEqual(rows.map((r) => Number(r.credited)), [75, 25, 0]);
    const { rows: [inv] } = await db.query('SELECT net_payable FROM v_travel_vendor_invoices WHERE id = $1', [ids.inv1]);
    assert.equal(rows.reduce((s, r) => s + Number(r.net_cost), 0), Number(inv.net_payable));
    assert.equal(Number(inv.net_payable), 900);
  });

  test('an invoice\'s lines add up to what is payable, to the paisa', async () => {
    const { rows } = await db.query('SELECT net_cost FROM v_travel_invoice_lines WHERE vendor_invoice_id = $1', [ids.inv2]);
    const sum = Math.round(rows.reduce((s, r) => s + Number(r.net_cost) * 100, 0)) / 100;
    assert.equal(sum, 200);
  });

  test('the dashboard owes vendors what is payable after credit notes', async () => {
    const { body } = await agent.get('/api/dashboard/overview').expect(200);
    // Invoice 1: 900 payable, 500 paid. Invoice 2: 200 payable, none paid.
    assert.equal(Number(body.data.travel.vendor_to_pay_amount), 600);
    // 700 on trip 1, and 600 on trip 2.
    assert.equal(Number(body.data.travel.total_cost), 1300);
  });

  test('the project page\'s cost lines add up to its totals', async () => {
    const { body } = await agent.get(`/api/profitability/projects/${PROJECT}`).expect(200);
    const p = body.data;
    const vendorLines = p.lines.filter((l) => l.kind === 'travel_vendor' && !l.gap);
    assert.equal(vendorLines.length, 6, 'every invoice line on the project\'s trips, PO or not');
    const add = (rows, f) => Math.round(rows.reduce((s, r) => s + Number(f(r)) * 100, 0)) / 100;
    assert.equal(add(vendorLines, (l) => l.amount), 1100, 'net of credit notes, this trip\'s share only');
    assert.equal(add(vendorLines, (l) => l.amount_paid), Number(p.travel_vendor_paid));
    assert.equal(add(vendorLines, (l) => l.committed), Number(p.travel_vendor_committed));
    const costLines = p.lines.filter((l) => !l.gap);
    assert.equal(add(costLines, (l) => Number(l.amount_paid) + Number(l.committed)), Number(p.total_cost));
    assert.equal(Number(p.total_cost), 1300);
  });

  test('a credit note on no invoice is a gap on its project, and changes no figure', async () => {
    const { body } = await agent.get(`/api/profitability/projects/${PROJECT}`).expect(200);
    const p = body.data;
    assert.equal(Number(p.cost_gaps), 1);
    const loose = p.lines.find((l) => l.ref === 'CN-LOOSE');
    assert.ok(loose, 'the note shows among the cost lines');
    assert.match(loose.gap, /no invoice/i);
    assert.equal(Number(loose.committed), 0);
    const t = await trip('TRV-C2');
    assert.equal(Number(t.vendor_cost), 600, 'not taken off any cost');
  });

  // The rest on a second project of its own, so the figures above stay put.
  describe('paise, and credit notes larger than what they credit', () => {
    const P2 = 'PRJ-COST-2';
    const legs = {};
    const lines = async (inv) => (await db.query(
      'SELECT travel_id, line_total, credited, paid, net_cost FROM v_travel_invoice_lines WHERE vendor_invoice_id = $1 ORDER BY id', [inv])).rows;
    const sum = (rows, k) => Math.round(rows.reduce((s, r) => s + Number(r[k]) * 100, 0)) / 100;
    let n = 10;
    /** An invoice of `amounts` lines ([trip, leg key or null, amount]), with `paid` on it. */
    async function invoice(amounts, paid = 0) {
      n += 1;
      const total = amounts.reduce((s, [, , a]) => s + a, 0);
      const { rows: [{ id }] } = await db.query(
        `INSERT INTO travel_vendor_invoices (vendor_invoice_id, vendor_id, vendor_invoice_no, invoice_date, invoice_amount, amount_paid)
         VALUES ($1, $2, $3, '2026-07-10', $4, $5) RETURNING id`, [`VI-C${n}`, ids.vendor, `AG/${n}`, total, paid]);
      for (const [t, leg, a] of amounts) {
        await db.query('INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, segment_id, line_total) VALUES ($1, $2, $3, $4)',
          [id, t, leg ? legs[leg] : null, a]);
      }
      return id;
    }
    const credit = (inv, leg, amount) => db.query(
      `INSERT INTO travel_vendor_credit_notes (vendor_id, credit_note_no, against_invoice_id, segment_id, refund_amount)
       VALUES ($1, $2, $3, $4, $5)`, [ids.vendor, `CN-${inv}-${leg}-${amount}`, inv, leg ? legs[leg] : null, amount]);

    before(async () => {
      await db.query(`INSERT INTO projects (project_id, client_name) VALUES ($1, 'Cost client 2')`, [P2]);
      for (const t of ['TRV-C3', 'TRV-C4']) {
        await db.query(
          `INSERT INTO travel_logs (travel_id, employee_name, project_id, vendor_id, trip_type_id, travel_start_date, travel_end_date)
           VALUES ($1, 'Ravi', $2, $3, (SELECT id FROM trip_types WHERE name = 'Non-chargeable'), '2026-07-01', '2026-07-03')`,
          [t, P2, ids.vendor]);
      }
      for (const k of ['a', 'b']) {
        legs[k] = (await db.query(`INSERT INTO travel_segments (travel_id, mode) VALUES ('TRV-C3', 'train') RETURNING id`)).rows[0].id;
      }
    });

    test('the paisa left over from a leg\'s credit stays on that leg', async () => {
      // Three lines on trip 3's leg, then trip 4's line last: ₹100 back on the leg.
      const inv = await invoice([['TRV-C3', 'a', 100], ['TRV-C3', 'a', 100], ['TRV-C3', 'a', 100], ['TRV-C4', null, 100]]);
      await credit(inv, 'a', 100);
      const rows = await lines(inv);
      assert.equal(Number(rows[3].credited), 0, 'trip 4 had no credit, not even a paisa');
      assert.equal(sum(rows.slice(0, 3), 'credited'), 100);
    });

    test('what was paid adds up across the lines, to the paisa', async () => {
      const inv = await invoice([['TRV-C3', null, 100], ['TRV-C3', null, 100], ['TRV-C4', null, 100]], 100);
      assert.equal(sum(await lines(inv), 'paid'), 100);
    });

    test('a leg credited beyond its cost costs nothing, and the rest comes off the invoice', async () => {
      const inv = await invoice([['TRV-C3', 'b', 200], ['TRV-C4', null, 300]]);
      await credit(inv, 'b', 250);
      const rows = await lines(inv);
      assert.deepEqual(rows.map((r) => Number(r.net_cost)), [0, 250], 'never below nothing');
      assert.equal(sum(rows, 'credited'), 250, 'all of the credit note still comes off');
    });

    test('an invoice credited beyond its cost is a gap, and costs nothing', async () => {
      const inv = await invoice([['TRV-C4', null, 100]]);
      await credit(inv, null, 150);
      const rows = await lines(inv);
      assert.equal(Number(rows[0].net_cost), 0);
      const { rows: [p] } = await db.query('SELECT * FROM v_project_profitability WHERE project_id = $1', [P2]);
      assert.equal(Number(p.cost_gaps), 1);
      const { rows: [t] } = await db.query(`SELECT SUM(vendor_cost) AS c FROM v_travel_logs WHERE travel_id IN ('TRV-C3','TRV-C4')`);
      assert.equal(Number(t.c), Number(p.travel_vendor_paid) + Number(p.travel_vendor_committed), 'the trips cost what the project counts');
    });
  });
});
