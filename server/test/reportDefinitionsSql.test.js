import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';

/**
 * The Reports section's figures (lib/reportDefinitions.js) against a real
 * database: enquiries received, what became of them by the period's end, and
 * monthly revenue on the PO basis.
 *
 * The fixture is September 2026, with things happening on both sides of it
 * so "as of the period's end" is actually tested: a quotation lost in
 * October, an enquiry created at night UTC that is already the next day in
 * India, a PO cancelled and another replaced by a revision.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const TODAY = '2026-10-20';

describe('reports section figures', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db;
  let dbName;
  let defs;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    dbName = `report_defs_suite_${process.pid}_${Date.now()}`;
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
      INSERT INTO users (id, name, role, active) VALUES (101, 'Asha', 'sales', false), (102, 'Bilal', 'sales', false);
      INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 90, '2026-01-01');

      -- Beta's POs name no quotation, so their sector comes from the company.
      INSERT INTO companies (id, name, name_key, sector) VALUES (501, 'Beta', 'beta', 'pharma ');
      INSERT INTO projects (project_id, client_name, owner_user_id, company_id) VALUES ('P-1', 'Acme', 101, NULL), ('P-2', 'Beta', 102, 501);

      INSERT INTO quotations (quotation_no, client_name, status, quotation_date, valid_until, closed_at,
                              lost_reason_id, project_id, quotation_value, currency, sector, service_quoted, owner_user_id) VALUES
        ('Q-1', 'Acme', 'Won - PO Received', '2026-08-20', NULL, NULL, NULL, 'P-1', 100000, 'INR', 'Steel', 'EcoVadis', 101),
        ('Q-2', 'Beta', 'Lost', '2026-09-05', NULL, '2026-09-20 10:00+05:30',
           (SELECT id FROM lost_reasons WHERE name = 'Price'), NULL, 5000, 'INR', 'Pharma', 'ESG', 102),
        -- Lost, but only after the period ended: open as of 30 September.
        ('Q-3', 'Beta', 'Lost', '2026-09-06', NULL, '2026-10-15 10:00+05:30', NULL, NULL, 5000, 'INR', 'Pharma', 'ESG', 102),
        -- Ran out of validity mid-September with no decision.
        ('Q-4', 'Acme', 'Submitted', '2026-09-07', '2026-09-15', NULL, NULL, NULL, 2000, 'INR', 'Steel', 'HSE', 101),
        ('Q-5', 'Acme', 'Submitted', '2026-09-08', '2026-12-31', NULL, NULL, NULL, 2000, 'INR', 'Steel', 'HSE', 101);

      INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency) VALUES
        ('PO-1',   'P-1', 'Q-1', '2026-09-10', 118000, 'INR'),
        ('PO-1C',  'P-1', 'Q-1', '2026-09-11', 5000,   'INR'),
        ('PO-2',   'P-1', 'Q-1', '2026-08-01', 1000,   'INR'),
        ('PO-2R',  'P-1', 'Q-1', '2026-09-12', 1500,   'INR'),
        ('PO-USD', 'P-2', NULL,  '2026-09-15', 100,    'USD'),
        ('PO-EUR', 'P-2', NULL,  '2026-09-16', 50,     'EUR'),
        ('PO-OCT', 'P-2', NULL,  '2026-10-01', 700,    'INR'),
        -- Beta ordered before: an existing customer in September.
        ('PO-OLD', 'P-2', NULL,  '2026-03-01', 100,    'INR');
      UPDATE purchase_orders SET cancelled = true WHERE po_number = 'PO-1C';
      UPDATE purchase_orders SET replaces_po_number = 'PO-2' WHERE po_number = 'PO-2R';

      -- PO-1's split was recorded at registration; PO-2R has none, so it
      -- reads Q-1's lines; PO-USD and PO-EUR have neither, and no service text.
      INSERT INTO po_services (po_number, service, service_value) VALUES
        ('PO-1', 'EcoVadis', 88500), ('PO-1', 'HAZOP study', 29500);
      INSERT INTO quotation_lines (quotation_id, description, rate) VALUES
        ((SELECT id FROM quotations WHERE quotation_no = 'Q-1'), 'ESIA baseline', 1000);

      -- PO-1 invoiced in September, paid in October.
      INSERT INTO payment_stages (po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date,
                                  amount_received, payment_received_date) VALUES
        ('PO-1', 1, 'Full', 1, 'INV-1', '2026-09-20', 118000, '2026-10-05');

      INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status, quotation_no, source_id, owner_user_id, created_at) VALUES
        ('E-1', 'Acme', '2026-09-01', 'Converted', 'Q-1', (SELECT id FROM lead_sources WHERE name = 'Website'), 101, now()),
        ('E-2', 'Beta', '2026-09-02', 'Converted', 'Q-2', (SELECT id FROM lead_sources WHERE name = 'Referral'), 102, now()),
        ('E-3', 'Beta', '2026-09-03', 'Converted', 'Q-3', (SELECT id FROM lead_sources WHERE name = 'Referral'), 102, now()),
        ('E-4', 'Acme', '2026-09-04', 'Converted', 'Q-4', NULL, 101, now()),
        ('E-5', 'Gamma', '2026-09-05', 'Unqualified', NULL, (SELECT id FROM lead_sources WHERE name = 'Website'), 102, now()),
        ('E-6', 'Acme', '2026-09-08', 'Converted', 'Q-5', NULL, 101, now()),
        -- No enquiry date. 20:00 UTC on the 29th is the 30th in India: in September.
        ('E-7', 'Delta', NULL, 'New', NULL, NULL, 101, '2026-09-29 20:00+00'),
        -- 20:00 UTC on the 30th is 1 October in India: not in September.
        ('E-8', 'Delta', NULL, 'New', NULL, NULL, 101, '2026-09-30 20:00+00'),
        ('E-9', 'Delta', '2026-10-02', 'New', NULL, NULL, 101, now());
    `);

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = u.toString();
    process.env.AUTH_MODE = 'shared';
    process.env.AUTH_USERNAME = 'admin';
    process.env.AUTH_PASSWORD = 'a-good-long-test-password';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';

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

  const slice = (report, key) => report.outcomes.slices.find((s) => s.key === key).count;

  test('enquiries received: by day, split by source, a blank date falls back to the IST creation day', async () => {
    const report = await defs.salesReport(SEPT, { today: TODAY });
    assert.equal(report.grain, 'day');
    assert.equal(report.enquiries.total, 7);
    assert.equal(report.enquiries.buckets.length, 30);
    assert.equal(report.enquiries.buckets.find((b) => b.key === '2026-09-30').enquiries, 1);
    assert.equal(report.enquiries.dated_by_creation, 1);
    assert.deepEqual(report.enquiries.sources.map((s) => [s.name, s.enquiries]),
      [['Referral', 2], ['Website', 2], ['Not set', 3]]);
    assert.ok(report.notes.some((n) => n.key === 'enquiries_dated_by_creation'));
  });

  test('enquiry outcome as of the period end', async () => {
    const report = await defs.salesReport(SEPT, { today: TODAY });
    // E-1 has a PO in September; E-5 closed with no quotation.
    assert.equal(slice(report, 'converted'), 1);
    assert.equal(slice(report, 'lost'), 1);
    // E-2 lost in September, E-4 expired in September.
    assert.equal(slice(report, 'quoted_not_won'), 2);
    // E-3 (lost only in October), E-6 (open quotation), E-7 (not quoted).
    assert.equal(slice(report, 'pipeline'), 3);
    assert.deepEqual(report.outcomes.pipeline, { not_quoted: 1, quoted: 2 });
    // Q-3 is Lost today but was open on 30 September: no "unknown status" note.
    assert.ok(!report.notes.some((n) => n.key === 'unknown_quotation_status'));
    assert.deepEqual(report.outcomes.quoted_not_won_reasons,
      [{ reason: 'Expired without a decision', count: 1 }, { reason: 'Price', count: 1 }]);
    assert.equal(report.outcomes.slices.reduce((n, s) => n + s.pct, 0), 100);

    // Judged at the end of October instead, Q-3 is lost too.
    const later = await defs.salesReport({ from: '2026-09-01', to: '2026-10-31' }, { today: '2026-11-05' });
    assert.equal(later.outcomes.detail.find((d) => d.enquiry_no === 'E-3').outcome, 'quoted_not_won');
  });

  test('a PO after the period does not convert an enquiry inside it', async () => {
    const august = await defs.salesReport({ from: '2026-08-01', to: '2026-08-31' }, { today: TODAY });
    assert.equal(august.enquiries.total, 0);
    // E-1 judged as of 5 September: its PO came on the 10th.
    const early = await defs.salesReport({ from: '2026-09-01', to: '2026-09-05' }, { today: TODAY });
    assert.equal(early.outcomes.detail.find((d) => d.enquiry_no === 'E-1').outcome, 'pipeline');
  });

  test('monthly revenue: counting POs by PO date, incl. GST, in INR', async () => {
    const report = await defs.salesReport(SEPT, { today: TODAY });
    const [month] = report.revenue.months;
    // PO-1 118,000 + PO-2R 1,500 + PO-USD 100 × 90 — not the cancelled PO, not the
    // one it replaced, not the EUR one with no rate, not October's.
    assert.deepEqual([month.key, month.pos, month.po_value_inr], ['2026-09', 4, 128500]);
    assert.deepEqual(report.revenue.total.unconverted, [{ currency: 'EUR', amount: 50 }]);
    assert.deepEqual(month.detail.map((d) => d.po_number), ['PO-1', 'PO-2R', 'PO-USD', 'PO-EUR']);
    const po1 = month.detail[0];
    assert.deepEqual([po1.client, po1.sector, po1.service, po1.owner, po1.invoiced_inr, po1.received_inr],
      ['Acme', 'Metal Industry', 'EcoVadis, HSE', 'Asha', 118000, 118000]);
    // Billing by its own dates: invoiced in September, received in October.
    assert.deepEqual([month.invoiced_inr, month.received_inr], [118000, 0]);
    assert.ok(report.notes.some((n) => n.key === 'po_unconverted'));
    assert.match(report.narrative.revenue, /1,28,500 from 4 POs/);
  });

  test('sector-wise POs: quotation sector, else the company\'s, through the aliases', async () => {
    const { sectors } = await defs.salesReport(SEPT, { today: TODAY });
    assert.deepEqual(sectors.rows.map((r) => [r.sector, r.pos, r.value_inr]),
      [['Metal Industry', 2, 119500], ['Agriculture', 0, 0], ['Pharmaceutical', 2, 9000], ['Other', 0, 0]]);
    assert.equal(sectors.total.value_inr, 128500);
  });

  test('service-wise sales: the recorded split, then quotation lines, then text — adding up to revenue', async () => {
    const report = await defs.salesReport(SEPT, { today: TODAY });
    const byLine = Object.fromEntries(report.services.rows.map((r) => [r.line, [r.pos, r.value_inr]]));
    assert.deepEqual(byLine.EcoVadis, [1, 88500]);
    assert.deepEqual(byLine.HSE, [1, 29500]);
    assert.deepEqual(byLine.ESIA, [1, 1500]);
    assert.deepEqual(byLine.Other, [2, 9000]);
    assert.equal(report.services.rows.reduce((n, r) => n + r.value_inr, 0), report.revenue.total.po_value_inr);
    assert.deepEqual(report.services.sources, { po_services: 1, quotation_lines: 1, keywords: 2 });
    assert.ok(report.notes.some((n) => n.key === 'services_by_keywords'));
    // The best-selling named line, not Other.
    assert.match(report.narrative.services, /^EcoVadis sold the most/);
  });

  test('an admin\'s category changes take effect on the next report', async () => {
    await db.query(`UPDATE settings SET value = '["Pharmaceutical","Metal Industry"]' WHERE key = 'report_sectors'`);
    await db.query(`INSERT INTO services (name, report_line) VALUES ('Board briefing', 'ESG'), ('HAZOP study', NULL)`);
    await db.query(`INSERT INTO sector_aliases (alias, sector) VALUES ('Widgets', 'Pharmaceutical')`);
    try {
      const { sectors } = await defs.salesReport(SEPT, { today: TODAY });
      assert.deepEqual(sectors.rows.map((r) => r.sector), ['Pharmaceutical', 'Metal Industry', 'Other']);
      const usage = await defs.categoryUsage();
      assert.equal(usage.sector_usage.find((u) => u.name === 'Steel').category, 'Metal Industry');
      const service = (name) => usage.services.find((sv) => sv.name === name);
      assert.deepEqual([service('Board briefing').lines, service('Board briefing').assigned], [['ESG'], true]);
      assert.deepEqual([service('HAZOP study').lines, service('HAZOP study').assigned], [['HSE'], false]);
      // A spelling twice, in another case, is refused by the index.
      await assert.rejects(db.query(`INSERT INTO sector_aliases (alias, sector) VALUES (' widgets', 'Metal Industry')`), /sector_aliases_alias_key/);
    } finally {
      await db.query(`UPDATE settings SET value = '["Metal Industry","Agriculture","Pharmaceutical"]' WHERE key = 'report_sectors'`);
      await db.query(`DELETE FROM services WHERE name IN ('Board briefing', 'HAZOP study')`);
      await db.query(`DELETE FROM sector_aliases WHERE alias = 'Widgets'`);
    }
  });

  test('new and existing customers: by company, against every order ever placed', async () => {
    const { customers } = await defs.salesReport(SEPT, { today: TODAY });
    // Acme first ordered on 10 September; Beta in March. PO-2R is Acme's
    // second order; both Beta POs this month follow its March one.
    assert.deepEqual(customers.new_customers.map((c) => [c.customer, c.first_po_date, c.pos, c.value_inr]),
      [['Acme', '2026-09-10', 2, 119500]]);
    assert.deepEqual(customers.repeat_orders.map((r) => [r.po_number, r.customer, r.previous_orders]),
      [['PO-2R', 'Acme', 1], ['PO-USD', 'Beta', 1], ['PO-EUR', 'Beta', 2]]);
    assert.deepEqual(
      [customers.tiles.new_customers, customers.tiles.existing_customers, customers.tiles.repeat_value_inr, customers.tiles.repeat_share_pct],
      [1, 1, 10500, 8]);
    // Beta's enquiries come after its March order; everyone else had never ordered by then.
    assert.deepEqual(customers.new_customer_enquiries.map((e) => e.enquiry_no), ['E-1', 'E-4', 'E-5', 'E-6', 'E-7']);
    assert.match((await defs.salesReport(SEPT, { today: TODAY })).narrative.customers, /^1 new customer placed a first order; 3 repeat orders/);
  });

  test('order history is not narrowed by who is reading', async () => {
    // Bilal sees Beta's POs only. Beta is still an existing customer, and
    // PO-EUR still has two orders before it, whoever's they were.
    const { customers } = await defs.salesReport(SEPT, { today: TODAY, scope: { unrestricted: false, ownerId: 102 } });
    assert.deepEqual(customers.repeat_orders.map((r) => [r.po_number, r.previous_orders]), [['PO-USD', 1], ['PO-EUR', 2]]);
    assert.equal(customers.tiles.new_customers, 0);
  });

  test('drill-down: a list opened from a slice holds exactly what the slice counted', async () => {
    const q = (extra) => ({ report_from: SEPT.from, report_to: SEPT.to, ...extra });
    const admin = { unrestricted: true, ownerId: null };
    const report = await defs.salesReport(SEPT);

    for (const slice of report.outcomes.slices) {
      const numbers = await defs.reportEnquiryNumbers(q({ report_outcome: slice.key }), admin);
      assert.equal(numbers.length, slice.count, slice.key);
    }
    assert.deepEqual(await defs.reportEnquiryNumbers(q({ report_outcome: 'lost' }), admin), ['E-5']);
    assert.deepEqual(await defs.reportEnquiryNumbers(q({ report_outcome: 'not_quoted' }), admin), ['E-7']);
    assert.deepEqual(await defs.reportEnquiryNumbers(q({ report_customer: 'new' }), admin),
      report.customers.new_customer_enquiries.map((e) => e.enquiry_no));

    assert.deepEqual(await defs.reportPoNumbers(q({ report_sector: 'Metal Industry' }), admin), ['PO-1', 'PO-2R']);
    assert.deepEqual(await defs.reportPoNumbers(q({ report_service: 'HSE' }), admin), ['PO-1']);
    assert.deepEqual(await defs.reportPoNumbers(q({ report_customer: 'repeat' }), admin), ['PO-2R', 'PO-USD', 'PO-EUR']);
    assert.deepEqual(await defs.reportPoNumbers(q({ report_customer: 'new' }), admin), ['PO-1', 'PO-2R']);
    assert.deepEqual(await defs.reportPoNumbers(q({ report_month: '2026-09' }), admin), ['PO-1', 'PO-2R', 'PO-USD', 'PO-EUR']);
    // An admin's owner filter carries through; a sales user's cannot widen their own.
    assert.deepEqual(await defs.reportPoNumbers(q({ report_owner: '101' }), admin), ['PO-1', 'PO-2R']);
    assert.deepEqual(await defs.reportPoNumbers(q({ report_owner: '101' }), { unrestricted: false, ownerId: 102 }), ['PO-USD', 'PO-EUR']);

    await assert.rejects(defs.reportEnquiryNumbers(q({ report_outcome: 'maybe' }), admin), (err) => err.status === 422);
    const params = [];
    assert.deepEqual(await defs.reportListClauses('enquiries', {}, { scope: admin, params }), []);
    assert.deepEqual(await defs.reportListClauses('pos', q({ report_sector: 'Agriculture' }), { scope: admin, params }), ['po_number = ANY($1::text[])']);
    assert.deepEqual(params, [[]]);
  });

  test('an expired Draft or On Hold quotation stays in the pipeline, as on the Quotations page', async () => {
    await db.query(`
      INSERT INTO quotations (quotation_no, client_name, status, quotation_date, valid_until) VALUES
        ('Q-DRAFT', 'Nova', 'Draft', '2026-09-02', '2026-09-25'),
        ('Q-HOLD',  'Nova', 'On Hold', '2026-09-02', '2026-09-25'),
        ('Q-SENT',  'Nova', 'Submitted', '2026-09-02', '2026-09-25');
      INSERT INTO enquiries (enquiry_no, client_name, enquiry_date, status, quotation_no) VALUES
        ('E-DRAFT', 'Nova', '2026-11-01', 'Converted', 'Q-DRAFT'),
        ('E-HOLD',  'Nova', '2026-11-01', 'Converted', 'Q-HOLD'),
        ('E-SENT',  'Nova', '2026-11-01', 'Converted', 'Q-SENT');
    `);
    try {
      const { outcomes } = await defs.salesReport({ from: '2026-11-01', to: '2026-11-30' }, { today: '2026-12-10' });
      const outcome = (no) => outcomes.detail.find((d) => d.enquiry_no === no).outcome;
      assert.deepEqual([outcome('E-DRAFT'), outcome('E-HOLD'), outcome('E-SENT')], ['pipeline', 'pipeline', 'quoted_not_won']);
      // The same rule the Quotations page flags "expired" by.
      const { rows } = await db.query(`SELECT quotation_no FROM v_quotations WHERE expired AND quotation_no IN ('Q-DRAFT', 'Q-HOLD', 'Q-SENT') ORDER BY 1`);
      assert.deepEqual(rows.map((r) => r.quotation_no), ['Q-SENT']);
    } finally {
      await db.query(`DELETE FROM enquiries WHERE enquiry_no IN ('E-DRAFT', 'E-HOLD', 'E-SENT');
                      DELETE FROM quotations WHERE quotation_no IN ('Q-DRAFT', 'Q-HOLD', 'Q-SENT')`);
    }
  });

  test('an alias or a service line must name a listed category, and a list keeps what is in use', async () => {
    const { rows: [alias] } = await db.query(`INSERT INTO sector_aliases (alias, sector) VALUES ('Zinc', 'metal industry') RETURNING *`);
    try {
      // Saved in the list's own spelling.
      await defs.saveSectorAlias(db, { before: null, after: alias, input: { alias: 'Zinc', sector: 'metal industry' } });
      assert.equal((await db.query('SELECT sector FROM sector_aliases WHERE id = $1', [alias.id])).rows[0].sector, 'Metal Industry');
      // A sector the report does not list is refused, naming the ones it does.
      await assert.rejects(defs.saveSectorAlias(db, { before: null, after: { ...alias, sector: 'Metals Industry' }, input: { sector: 'Metals Industry' } }),
        (err) => err.status === 422 && /Metal Industry, Agriculture, Pharmaceutical/.test(err.message));
      // An edit that does not touch the sector is not re-judged.
      await defs.saveSectorAlias(db, { before: alias, after: { ...alias, sector: 'Gone' }, input: { alias: 'Zinc ' } });

      const { rows: [service] } = await db.query(`INSERT INTO services (name, report_line) VALUES ('Impact study', 'esia') RETURNING *`);
      await defs.saveServiceReportLine(db, { after: service, input: { report_line: 'esia' } });
      assert.equal((await db.query('SELECT report_line FROM services WHERE id = $1', [service.id])).rows[0].report_line, 'ESIA');
      await assert.rejects(defs.saveServiceReportLine(db, { after: { ...service, report_line: 'Climate' }, input: { report_line: 'Climate' } }),
        (err) => err.status === 422);
      await defs.saveServiceReportLine(db, { after: { ...service, report_line: 'Old line' }, input: { active: false } });

      // Dropping a category something points at is refused, naming what.
      await assert.rejects(defs.assertCategoriesUnused(db, 'report_sectors', ['Agriculture', 'Pharmaceutical']),
        (err) => err.status === 422 && /alias "Zinc"/.test(err.message));
      await assert.rejects(defs.assertCategoriesUnused(db, 'report_service_lines', ['EcoVadis']),
        (err) => err.status === 422 && /service "Impact study"/.test(err.message));
      await defs.assertCategoriesUnused(db, 'report_sectors', ['Pharmaceutical', 'Metal Industry', 'Agriculture', 'Mining']);
      await db.query('DELETE FROM services WHERE id = $1', [service.id]);
    } finally {
      await db.query('DELETE FROM sector_aliases WHERE id = $1', [alias.id]);
    }
  });

  test('a sales user sees only their own records', async () => {
    const report = await defs.salesReport(SEPT, { today: TODAY, scope: { unrestricted: false, ownerId: 102 } });
    assert.deepEqual(report.outcomes.detail.map((d) => d.enquiry_no), ['E-2', 'E-3', 'E-5']);
    // Bilal's POs are those under his project: USD and EUR.
    assert.deepEqual(report.revenue.months[0].detail.map((d) => d.po_number), ['PO-USD', 'PO-EUR']);
  });
});
