import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';

/**
 * The sector, client and FX reports, and the "won but no PO" check, run
 * against a real database.
 *
 * "Won" is a row in the Purchase Orders register, not a quotation status, so
 * the fixture is built to tell the two apart: a quotation marked won with no
 * PO, a quotation with two phase POs, and a PO whose quotation still says
 * Submitted. Each of them gives a different answer under the status rule.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const Q1 = { from: '2026-04-01', to: '2026-06-30' };
const ALL_TIME = { from: null, to: null };

describe('sales report figures', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let dbName;
  let reports;
  let defs;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `sales_report_suite_${process.pid}_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();

    const u = new URL(ADMIN_URL);
    u.pathname = `/${dbName}`;

    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dbDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

    db = new pg.Client({ connectionString: u.toString() });
    await db.connect();
    await db.query(readFileSync(join(dbDir, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(dbDir, 'views.sql'), 'utf8'));

    await db.query(`
      INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 90, '2026-01-01');

      INSERT INTO projects (project_id, client_name) VALUES ('P-1', 'Acme'), ('P-2', 'Beta'), ('P-3', 'Gamma'), ('P-4', 'Delta'), ('P-5', 'Epsilon'), ('P-6', 'Zeta'), ('P-7', 'Omega'), ('P-8', 'Sigma');

      INSERT INTO quotations (quotation_no, client_name, status, quotation_date, sector, project_id, quotation_value, currency) VALUES
        -- Quoted before the period, won with two phase POs inside it: one deal.
        ('Q-A', 'Acme',  'Won - PO Received', '2026-01-10', 'Pharma', 'P-1', 3000, 'INR'),
        ('Q-B', 'Acme',  'Lost',              '2026-05-02', 'Pharma', NULL,  1000, 'INR'),
        -- Marked won, nothing registered — though its project holds Q-D's PO.
        ('Q-C', 'Beta',  'Won - PO Received', '2026-05-01', 'Metals', 'P-2', 700,  'INR'),
        ('Q-D', 'Beta',  'Won - PO Received', '2026-05-01', 'Metals', 'P-2', 500,  'INR'),
        -- A PO registered, the quotation's status never moved on.
        ('Q-E', 'Gamma', 'Submitted',         '2026-05-03', 'Steel',  'P-3', 100,  'USD'),
        -- Quoted in EUR; its PO below was saved with the dropdown left at INR.
        ('Q-F', 'Delta', 'Won - PO Received', '2026-05-04', 'Chemicals', 'P-4', 10700, 'EUR'),
        -- Outside the period: only for linking a PO on save.
        ('Q-G', 'Epsilon', 'Won - PO Received', '2025-01-01', 'Textiles', 'P-5', 500, 'EUR'),
        -- Same project: the lost one sorts first by number, the won one is the order.
        ('Q-H0', 'Zeta', 'Lost',              '2025-01-01', 'Retail', 'P-6', 900, 'INR'),
        ('Q-H1', 'Zeta', 'Won - PO Received', '2025-01-01', 'Energy', 'P-6', 900, 'INR'),
        ('Q-R', 'Omega', 'Won - PO Received', '2025-01-05', 'Mining', 'P-7', 3500000, 'INR'),
        ('Q-S', 'Sigma', 'Won - PO Received', '2025-01-05', 'Food',   'P-8', 1000, 'INR');

      INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency) VALUES
        ('PO-A1', 'P-1', 'Q-A', '2026-05-05', 1000, 'INR'),
        ('PO-A2', 'P-1', 'Q-A', '2026-06-10', 2000, 'INR'),
        ('PO-D',  'P-2', 'Q-D', '2026-05-20', 500,  'INR'),
        ('PO-E',  'P-3', 'Q-E', '2026-05-25', 100,  'USD'),
        ('PO-U',  'P-3', 'Q-E', NULL,         0,    'USD'),
        ('PO-F',  'P-4', 'Q-F', '2026-05-15', 10700, 'INR'),
        ('PO-G',  'P-5', NULL,  '2025-01-02', 250,  'INR'),
        -- No quotation named, so each is matched through its project; PO-H2 has no value entered.
        ('PO-H1', 'P-6', NULL,  '2026-06-01', 400,  'INR'),
        ('PO-H2', 'P-6', NULL,  '2026-06-02', 0,    'INR'),
        -- A ₹30L order amended to ₹35L, entered as a new PO; and an order cancelled outright.
        ('PO-441',    'P-7', 'Q-R', '2026-04-10', 3000000, 'INR'),
        ('PO-441-R1', 'P-7', 'Q-R', '2026-05-10', 3500000, 'INR'),
        ('PO-X',      'P-8', 'Q-S', '2026-05-12', 1000,    'INR');
      UPDATE purchase_orders SET replaces_po_number = 'PO-441' WHERE po_number = 'PO-441-R1';
      UPDATE purchase_orders SET cancelled = true WHERE po_number = 'PO-X';

      -- Enquiries that led to those quotations.
      INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status, quotation_no) VALUES
        ('E-R', 'Omega', '2026-04-02', 'Converted', 'Q-R'),
        ('E-S', 'Sigma', '2026-04-03', 'Converted', 'Q-S');
    `);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

    reports = await import('../src/lib/salesReport.js');
    defs = await import('../src/lib/reportDefinitions.js');
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

  const bySector = (report, name) => report.rows.find((row) => row.sector === name);

  test('sector-wise: won comes from the POs, and Win % counts deals', async () => {
    const report = await reports.sectorReport(Q1);

    // Two phase POs, one deal won, one lost: 50%, not 2 ÷ 3.
    const pharma = bySector(report, 'Pharma');
    assert.deepEqual(
      [pharma.pos, pharma.won_deals, pharma.lost, pharma.pipeline, pharma.win_rate, Number(pharma.won_value_inr)],
      [2, 1, 1, 0, 0.5, 3000]
    );

    // Q-C is marked won with no PO: not won, not lost, not pipeline — counted on its own.
    const metals = bySector(report, 'Metals');
    assert.deepEqual([metals.pos, metals.won_deals, metals.lost, metals.pipeline, metals.won_without_po], [1, 1, 0, 0, 1]);

    // A PO against a quotation still marked Submitted is won, and the quotation still shows as pipeline.
    const steel = bySector(report, 'Steel');
    assert.deepEqual([steel.pos, steel.won_deals, steel.pipeline, Number(steel.won_value_inr)], [1, 1, 1, 9000]);

    assert.deepEqual(
      [report.summary.pos, report.summary.won_deals, report.summary.lost, report.summary.won_without_po, report.summary.win_rate],
      [8, 6, 1, 1, 6 / 7]
    );
  });

  test('sector-wise: a PO with no date is named once a period is chosen', async () => {
    assert.deepEqual((await reports.sectorReport(Q1)).summary.undated_pos, ['PO-U']);

    // With no period there is nothing to fall outside of: it is counted, and not listed.
    const all = await reports.sectorReport(ALL_TIME);
    assert.deepEqual(all.summary.undated_pos, []);
    const steel = bySector(all, 'Steel');
    assert.deepEqual([steel.pos, steel.won_deals, steel.pos_without_value], [2, 1, 1]);
  });

  test('clients: Win % counts deals, not phase POs', async () => {
    const report = await reports.customerReport(Q1);
    const acme = report.rows.find((row) => row.client === 'Acme');
    assert.deepEqual([acme.pos, acme.won_deals, acme.lost, acme.win_rate], [2, 1, 1, 0.5]);
    // Beta's won-but-unregistered quotation keeps it on the report, with only the PO that exists.
    const beta = report.rows.find((row) => row.client === 'Beta');
    assert.deepEqual([beta.pos, beta.won_deals], [1, 1]);
  });

  test('FX deals: one row per client and currency, at the rate on the PO date', async () => {
    const { rows } = await reports.fxReport(Q1);
    assert.equal(rows.length, 1);
    const [usd] = rows;
    assert.deepEqual(
      [usd.customer, usd.sector, usd.currency, usd.deals, Number(usd.amount), Number(usd.rate), Number(usd.amount_inr), usd.po_numbers],
      ['Gamma', 'Steel', 'USD', 1, 100, 90, 9000, 'PO-E']
    );
  });

  test('a PO in a different currency from its quotation is listed, and only that', async () => {
    const { summary } = await reports.sectorReport(Q1);
    // PO-A1/PO-A2 are part of Q-A's value in the same currency: not listed.
    assert.deepEqual(summary.currency_mismatch_pos, [
      { po_number: 'PO-F', currency: 'INR', quotation_no: 'Q-F', quotation_currency: 'EUR' },
    ]);
  });

  test('saving a PO warns on a currency mismatch, never on the amount', async () => {
    const { linkPurchaseOrder } = await import('../src/lib/purchaseOrders.js');
    const po = async (number) => (await db.query('SELECT * FROM purchase_orders WHERE po_number = $1', [number])).rows[0];

    const mismatched = await po('PO-F');
    const warned = await linkPurchaseOrder(db, { before: mismatched, after: mismatched });
    assert.match(warned.save_warning, /Q-F is in EUR, but this PO is in INR/);

    // Same currency, a fraction of the quotation's value: nothing to say.
    const phase = await po('PO-A1');
    assert.equal(await linkPurchaseOrder(db, { before: phase, after: phase }), undefined);

    // A new PO linked by the server (its project has one won quotation) is checked too.
    const unlinked = await po('PO-G');
    const linked = await linkPurchaseOrder(db, { before: null, after: unlinked });
    assert.match(linked.save_warning, /Q-G is in EUR, but this PO is in INR/);
    assert.equal((await po('PO-G')).quotation_no, 'Q-G');
  });

  test('a PO with no quotation named is credited to the won quotation on its project, not the first by number', async () => {
    const report = await reports.sectorReport(Q1);
    assert.equal(bySector(report, 'Retail'), undefined, 'the lost quotation gets nothing');
    const energy = bySector(report, 'Energy');
    // Two POs, one deal; the one saved at 0 is "no value entered", not a ₹0 order.
    assert.deepEqual([energy.pos, energy.won_deals, energy.pos_without_value, Number(energy.won_value_inr)], [2, 1, 1, 400]);
  });

  test('a PO saved at 0 is "no value entered" in the Reports section too', async () => {
    const { revenue } = await defs.salesReport(Q1);
    const h2 = revenue.months.flatMap((m) => m.detail).find((row) => row.po_number === 'PO-H2');
    assert.equal(h2.po_value, null);
    assert.equal(revenue.total.without_value, 1);
  });

  test('a repeat client has two deals, not one deal split into phase POs', async () => {
    const { rows } = await reports.customerReport(Q1);
    const acme = rows.find((row) => row.client === 'Acme');
    assert.deepEqual(
      [acme.pos_to_date, acme.deals_to_date, acme.repeat_orders, acme.client_type],
      [2, 1, 0, 'Single enquiry client']
    );
  });

  test('a revised PO is one order at its revised value; a cancelled one is no order', async () => {
    const sectors = await reports.sectorReport(Q1);
    const mining = bySector(sectors, 'Mining');
    assert.deepEqual([mining.pos, mining.won_deals, Number(mining.won_value_inr)], [1, 1, 3500000]);
    assert.equal(bySector(sectors, 'Food'), undefined, 'the cancelled PO is not won business');

    const { rows } = await reports.customerReport(Q1);
    const omega = rows.find((row) => row.client === 'Omega');
    assert.deepEqual([omega.pos, omega.pos_to_date, omega.deals_to_date, omega.client_type], [1, 1, 1, 'Single enquiry client']);

    const { revenue } = await defs.salesReport(Q1);
    const numbers = revenue.months.flatMap((m) => m.detail).map((row) => row.po_number);
    assert.ok(numbers.includes('PO-441-R1'));
    assert.ok(!numbers.includes('PO-441') && !numbers.includes('PO-X'));
  });

  test('billing still counts a replaced or cancelled PO: its money is real', async () => {
    const { revenueReport } = await import('../src/lib/revenueReport.js');
    const report = await revenueReport(Q1, { includeYears: false });
    const statuses = report.payment_status.rows.reduce((n, row) => n + row.pos, 0);
    assert.equal(report.invoicing.total.pos, statuses);
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM purchase_orders WHERE po_date BETWEEN '2026-04-01' AND '2026-06-30'`
    );
    assert.equal(report.invoicing.total.pos, rows[0].n);
  });

  test('a PO can only replace another PO of the same project, once, and never in a loop', async () => {
    const { linkPurchaseOrder } = await import('../src/lib/purchaseOrders.js');
    const refused = async (after) => {
      await assert.rejects(linkPurchaseOrder(db, { before: null, after }), (err) => {
        assert.equal(err.status, 422);
        return Boolean(err.extra?.fields?.replaces_po_number);
      });
    };
    const base = { quotation_no: null, currency: 'INR' };
    await refused({ ...base, po_number: 'PO-NEW', project_id: 'P-7', replaces_po_number: 'PO-NEW' }); // itself
    await refused({ ...base, po_number: 'PO-NEW', project_id: 'P-7', replaces_po_number: 'PO-NOPE' }); // no such PO
    await refused({ ...base, po_number: 'PO-NEW', project_id: 'P-2', replaces_po_number: 'PO-441-R1' }); // other project
    await refused({ ...base, po_number: 'PO-NEW', project_id: 'P-7', replaces_po_number: 'PO-441' }); // already replaced by R1
    await refused({ ...base, po_number: 'PO-441', project_id: 'P-7', replaces_po_number: 'PO-441-R1' }); // R1 leads back to PO-441

    // The revision already on record saves again without complaint.
    const { rows: [r1] } = await db.query("SELECT * FROM purchase_orders WHERE po_number = 'PO-441-R1'");
    await linkPurchaseOrder(db, { before: r1, after: r1 });
  });

  test('an enquiry is converted exactly when its quotation has a PO that counts', async () => {
    const { outcomes } = await defs.salesReport(Q1);
    const outcome = (no) => outcomes.detail.find((row) => row.enquiry_no === no).outcome;
    // Revised: the revision still counts, so the deal converted.
    assert.equal(outcome('E-R'), 'converted');
    // The only PO was cancelled: not converted, the same as its quotation.
    assert.notEqual(outcome('E-S'), 'converted');
  });

  test('order intake is the counting POs by PO date, the same total as the Reports section', async () => {
    const { revenueReport } = await import('../src/lib/revenueReport.js');
    const [old, { revenue }] = await Promise.all([revenueReport(Q1, { includeYears: false }), defs.salesReport(Q1)]);
    assert.equal(old.orders.total.orders, revenue.total.pos);
    assert.equal(old.orders.total.order_intake_inr, revenue.total.po_value_inr);
    // Not PO-441 (replaced), not PO-X (cancelled), not PO-G (2025).
    assert.equal(old.orders.total.orders, 8);
  });
});
