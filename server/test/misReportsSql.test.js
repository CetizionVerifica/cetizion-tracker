import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * The Daily Sales Briefing and Weekly Sales MIS figures against a real
 * database (docs/mis-reports-plan.md §8): one seeded week of enquiries,
 * quotations, POs (one in USD), stages, invoices, payments and review-queue
 * items, read as of Monday 5 October 2026.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `mis_reports_${process.pid}`;
const TODAY = '2026-10-05'; // a Monday; the week is 28 Sep – 4 Oct, yesterday 4 Oct

describe('MIS report figures', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let mis; let pool;

  before(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${NAME}`);
    await admin.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    ({ pool } = await import('../src/db.js'));
    mis = await import('../src/lib/misReports.js');

    const { rows: [stage] } = await db.query(`SELECT id FROM pipeline_stages WHERE name = 'Verbal yes, awaiting PO'`);
    await db.query(`
      INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('USD', 90, '2026-01-01');
      INSERT INTO users (name, email, password_hash, role, active) VALUES ('Priya Sales', 'priya@example.com', 'x', 'sales', true);
      INSERT INTO companies (name, sector) VALUES ('Acme Pharma', 'Pharmaceutical'), ('Beta Metals', 'Metal Industry');
      INSERT INTO projects (project_id, client_name, company_id, owner_user_id) VALUES
        ('P-1', 'Acme Pharma', (SELECT id FROM companies WHERE name = 'Acme Pharma'), (SELECT id FROM users WHERE email = 'priya@example.com')),
        ('P-2', 'Beta Metals', (SELECT id FROM companies WHERE name = 'Beta Metals'), NULL);

      -- Quotations: Q1 won with a PO this week; Q2 sent yesterday, open; Q3 awaiting a PO
      -- since September; Q4 marked won with no PO; Q5 won with the USD PO.
      INSERT INTO quotations (quotation_no, client_name, company_id, quotation_date, sent_at, status, stage_id, stage_changed_at, closed_at, quotation_value, currency, service_quoted, sector, country, owner_user_id) VALUES
        ('Q1', 'Acme Pharma', (SELECT id FROM companies WHERE name = 'Acme Pharma'), '2026-09-30', '2026-09-30 05:00+00', 'Won - PO Received', NULL, NULL, NULL, 100000, 'INR', 'EcoVadis', 'Pharmaceutical', 'India', (SELECT id FROM users WHERE email = 'priya@example.com')),
        ('Q2', 'Beta Metals', (SELECT id FROM companies WHERE name = 'Beta Metals'), '2026-10-04', '2026-10-04 05:00+00', 'Submitted', NULL, NULL, NULL, 1000, 'USD', 'ISO 14001', 'Metal Industry', 'Germany', NULL),
        ('Q3', 'Acme Pharma', (SELECT id FROM companies WHERE name = 'Acme Pharma'), '2026-09-15', '2026-09-15 05:00+00', 'Under Negotiation', ${stage.id}, '2026-09-20 05:00+00', NULL, 50000, 'INR', 'Audit', 'Pharmaceutical', 'India', NULL),
        ('Q4', 'Gamma Foods', NULL, '2026-09-10', '2026-09-10 05:00+00', 'Won - PO Received', NULL, NULL, '2026-09-25 05:00+00', 30000, 'INR', 'Audit', NULL, NULL, NULL),
        ('Q5', 'Beta Metals', (SELECT id FROM companies WHERE name = 'Beta Metals'), '2026-09-24', '2026-09-24 05:00+00', 'Won - PO Received', NULL, NULL, NULL, 2000, 'USD', 'ISO 14001', 'Metal Industry', 'Germany', NULL);

      -- A trigger stamps stage_changed_at on insert; the fixture wants Q3 waiting since 20 September.
      UPDATE quotations SET stage_changed_at = '2026-09-20 05:00+00' WHERE quotation_no = 'Q3';

      -- Enquiries: E1 this week, answered, converted; E2 this week, unquoted; E3 old, unquoted;
      -- E4 yesterday; E5 this week but made from our own quotation email (no TAT).
      INSERT INTO enquiries (enquiry_no, enquiry_date, client_name, company_id, status, quotation_no, first_responded_at, service, sector, country, source, created_at) VALUES
        ('E1', '2026-09-29', 'Acme Pharma', (SELECT id FROM companies WHERE name = 'Acme Pharma'), 'Converted', 'Q1', '2026-09-29 06:00+00', 'EcoVadis', 'Pharmaceutical', 'India', 'Referral', '2026-09-29 03:00+00'),
        ('E2', '2026-10-01', 'Beta Metals', (SELECT id FROM companies WHERE name = 'Beta Metals'), 'New', NULL, NULL, 'ISO 14001', 'Metal Industry', 'Germany', 'Website', '2026-10-01 03:00+00'),
        ('E3', '2026-09-20', 'Delta Agro', NULL, 'Contacted', NULL, NULL, 'Audit', 'Agriculture', 'India', 'Website', '2026-09-20 03:00+00'),
        ('E4', '2026-10-04', 'Epsilon Ltd', NULL, 'New', NULL, NULL, 'Audit', NULL, 'India', 'Referral', '2026-10-04 03:00+00'),
        ('E5', '2026-09-30', 'Zeta Inc', NULL, 'Converted', NULL, '2026-09-30 05:00+00', 'Audit', NULL, 'India', 'Other', '2026-09-30 03:00+00');

      -- POs: PO1 on Q1 (INR, 2 Oct); PO2 on Q5 (USD, yesterday); PO3 old, nothing invoiced; PO4 old, invoice long overdue.
      INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency, payment_terms_days) VALUES
        ('PO1', 'P-1', 'Q1', '2026-10-02', 100000, 'INR', 30),
        ('PO2', 'P-2', 'Q5', '2026-10-04', 2000, 'USD', 30),
        ('PO3', 'P-1', NULL, '2026-08-01', 40000, 'INR', 30),
        ('PO4', 'P-1', NULL, '2026-06-01', 200000, 'INR', 30);
      INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, amount_received) VALUES
        ('PO1', 1, 'Advance', 'On PO Registration', 0.5, 'INV-1', '2026-10-03', 0),
        ('PO1', 2, 'Final', 'On Delivery', 0.5, NULL, NULL, 0),
        ('PO2', 1, 'Full', 'On PO Registration', 1, NULL, NULL, 0),
        ('PO3', 1, 'Full', 'On PO Registration', 1, NULL, NULL, 0),
        ('PO4', 1, 'Full', 'On PO Registration', 1, 'INV-OLD', '2026-06-05', 0);
      INSERT INTO payments (stage_id, amount, received_on, mode) VALUES
        ((SELECT id FROM payment_stages WHERE invoice_no = 'INV-1'), 20000, '2026-10-04', 'bank_transfer');

      -- The readers: a mailbox, an enquiry made from our quotation email, a PO and an invoice in review.
      INSERT INTO connected_accounts (username, provider, email, is_shared) VALUES ('admin', 'test', 'sales@cetizionverifica.com', true);
      INSERT INTO email_enquiry_decisions (account_id, provider_id, direction, outcome, kind, method, enquiry_no, decided_at, received_at)
        VALUES ((SELECT id FROM connected_accounts LIMIT 1), 'm-e5', 'outbound', 'created', 'quotation_sent', 'rules', 'E5', '2026-09-30 05:10+00', '2026-09-30 05:00+00');
      INSERT INTO email_enquiry_decisions (account_id, provider_id, direction, outcome, kind, method, enquiry_no, decided_at, received_at)
        VALUES ((SELECT id FROM connected_accounts LIMIT 1), 'm-e4', 'inbound', 'created', 'new_enquiry', 'rules', 'E4', '2026-10-04 05:10+00', '2026-10-04 05:00+00');
      INSERT INTO email_po_decisions (account_id, provider_id, received_at, from_email, outcome, method, review_reason, mode, decided_at)
        VALUES ((SELECT id FROM connected_accounts LIMIT 1), 'm-po', '2026-10-01 05:00+00', 'buyer@somewhere.com', 'review', 'rules', 'no_match', 'live', '2026-10-01 05:10+00');
      INSERT INTO email_invoice_decisions (account_id, provider_id, sent_at, to_emails, outcome, method, review_reason, mode, invoice_no, decided_at)
        VALUES ((SELECT id FROM connected_accounts LIMIT 1), 'm-inv', '2026-09-26 05:00+00', ARRAY['ap@acme.com'], 'review', 'rules', 'po_not_found', 'live', 'INV-X', '2026-09-26 05:10+00');
    `);
  });

  after(async () => {
    await pool?.end();
    await db?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await admin.end();
  });

  const settings = { overdueDays: 7 };

  test('the daily briefing: yesterday at a glance', async () => {
    const d = await mis.dailyBriefing({ today: TODAY, db, settings });
    assert.deepEqual(d.period, { from: '2026-10-04', to: '2026-10-04' });
    const g = d.at_a_glance;
    assert.equal(g.new_enquiries, 1, 'E4');
    assert.equal(g.quotations_sent, 1, 'Q2');
    assert.equal(g.pos_received, 1, 'PO2');
    assert.equal(g.pos_received_inr, 180000, 'USD 2,000 at the PO-date rate of 90');
    assert.equal(g.invoices_raised, 0);
    assert.equal(g.payments_received, 1);
    assert.equal(g.payments_received_inr, 20000);
    assert.equal(d.quiet, false);
  });

  test('the daily briefing: the three pending tables, with Overdue past 7 days', async () => {
    const d = await mis.dailyBriefing({ today: TODAY, db, settings });
    const by = (table, kind) => d.pending[table].rows.filter((r) => r.kind === kind);

    const toInvoice = by('invoices', 'to_invoice');
    assert.deepEqual(toInvoice.map((r) => r.reference).sort(), ['PO2 · Full', 'PO3 · Full']);
    assert.equal(toInvoice.find((r) => r.reference.startsWith('PO3')).overdue, true, 'PO3 has waited since 1 August');
    assert.equal(toInvoice.find((r) => r.reference.startsWith('PO2')).days, 1);
    assert.equal(toInvoice.find((r) => r.reference.startsWith('PO2')).amount_inr, 180000);
    const due = by('invoices', 'invoice_due');
    assert.equal(due.find((r) => r.reference.includes('INV-OLD')).days, 92, '5 June + 30 days, to 5 October');
    assert.equal(due.find((r) => r.reference.includes('INV-1')).days, 0, 'not yet due');
    assert.equal(due.find((r) => r.reference.includes('INV-1')).amount, 30000, 'invoiced 50,000, received 20,000');
    assert.equal(by('invoices', 'invoice_review').length, 1);
    assert.equal(d.pending.invoices.overdue, 3, 'PO3, INV-OLD, and the invoice in review since 26 September');

    assert.deepEqual(by('pos', 'awaiting_po').map((r) => r.reference), ['Q3']);
    assert.equal(by('pos', 'awaiting_po')[0].overdue, true);
    assert.deepEqual(by('pos', 'won_without_po').map((r) => r.reference), ['Q4']);
    assert.equal(by('pos', 'po_review').length, 1);
    assert.ok(!d.pending.pos.rows.some((r) => ['Q1', 'Q5'].includes(r.reference)), 'quotations with a PO are not pending');

    assert.deepEqual(by('quotations', 'enquiry_unquoted').map((r) => r.reference.split(' ')[0]).sort(), ['E2', 'E3', 'E4']);
    assert.equal(by('quotations', 'enquiry_unquoted').find((r) => r.reference.startsWith('E3')).overdue, true);
    assert.deepEqual(by('quotations', 'quotation_open').map((r) => r.reference), ['Q2 · Submitted']);
    assert.equal(by('quotations', 'quotation_open')[0].amount_inr, 90000);

    assert.equal(d.at_a_glance.pending_invoices, d.pending.invoices.count);
    assert.equal(d.at_a_glance.overdue, d.pending.invoices.overdue + d.pending.pos.overdue + d.pending.quotations.overdue);
  });

  test('the daily briefing: top actions are one per client, worst first; highlights come from the records', async () => {
    const d = await mis.dailyBriefing({ today: TODAY, db, settings });
    assert.ok(d.top_actions.length <= 5);
    const clients = d.top_actions.map((a) => a.client.toLowerCase());
    assert.equal(new Set(clients).size, clients.length, 'one action per client');
    assert.equal(d.top_actions[0].reference, 'Invoice INV-OLD · PO4', '92 days × ₹2 lakh outranks everything');
    assert.deepEqual(d.events.map((e) => `${e.kind}:${e.number}`), ['enquiry:E4'], 'the quotation_sent decision is not an event; E4 is');
    assert.equal(d.readers.enquiries_created, 1);
    assert.match(d.highlights[0].summary, /New enquiry E4 from Epsilon Ltd/);
  });

  test('the weekly MIS: the eight questions from the same definitions as the Reports page', async () => {
    const w = await mis.weeklyMis({ today: TODAY, db, settings });
    assert.deepEqual(w.period, { from: '2026-09-28', to: '2026-10-04' });

    // 1. Enquiries, with the table and the TAT rule.
    assert.equal(w.enquiries.total, 4, 'E1, E2, E4, E5; E3 is 20 September');
    assert.equal(w.enquiries.per_day.length, 7);
    assert.equal(w.enquiries.per_day.find((d) => d.date === '2026-09-29').enquiries, 1);
    const e1 = w.enquiries.rows.find((r) => r.enquiry_no === 'E1');
    assert.equal(e1.country, 'India'); assert.equal(e1.source, 'Referral');
    assert.equal(e1.first_response_hours, 11.5, '06:00 UTC is 11:30 IST, from midnight IST on the enquiry date');
    assert.equal(w.enquiries.rows.find((r) => r.enquiry_no === 'E5').first_response_hours, null, 'made from our own quotation email');
    assert.deepEqual(w.enquiries.tat, { median_hours: 11.5, with_tat: 1, without_tat: 3 });
    assert.equal(w.enquiries.month_to_date, 2, 'E2 and E4 in October');

    // 2. Outcomes add up to 100%.
    assert.equal(w.outcomes.slices.find((s) => s.key === 'converted').count, 1);
    assert.equal(w.outcomes.slices.reduce((n, s) => n + s.pct, 0), 100);

    // 5 and revenue: two POs, the USD one converted at its PO date.
    assert.equal(w.revenue.total.pos, 2);
    assert.equal(w.revenue.total.po_value_inr, 280000);
    assert.deepEqual(w.pos.map((p) => [p.po_number, p.country]).sort(), [['PO1', 'India'], ['PO2', 'Germany']]);

    // 6. Invoiced and received this week, and month to date.
    assert.deepEqual([w.billing.week.invoices, w.billing.week.invoiced_inr, w.billing.week.payments, w.billing.week.received_inr], [1, 50000, 1, 20000]);
    assert.deepEqual([w.billing.month_to_date.invoiced_inr, w.billing.month_to_date.received_inr], [50000, 20000]);

    // 7. Receivables over 90 days match Insights' bucket.
    assert.equal(w.receivables.over_90.count, 1);
    assert.equal(w.receivables.over_90.amount_inr, 200000);
    assert.equal(w.receivables.oldest_days, 92);
    assert.equal(w.pending.pos.rows.filter((r) => r.overdue).length >= 1, true);

    // 8. Conversion and speed.
    assert.equal(w.speed.enquiry_to_po_pct, 25);
    assert.deepEqual([w.speed.won, w.speed.lost, w.speed.quote_to_contract_pct], [2, 0, 100]);
    assert.equal(w.speed.quote_to_po_days_median, 6, 'PO1 2 days after Q1, PO2 10 days after Q5');
    assert.equal(w.speed.average_po_ticket_inr, 140000);
    assert.equal(w.speed.pipeline.count, 2, 'Q2 and Q3 are open and sent');
    assert.equal(w.speed.pipeline.value_inr, 140000, 'USD 1,000 at 90, plus ₹50,000');
    assert.equal(w.speed.enquiry_tat_median_hours, 11.5);
  });

  test('a missing rate is reported as not converted, never guessed', async () => {
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, sent_at, status, quotation_value, currency) VALUES ('Q-AED', 'Dirham Co', '2026-10-01', '2026-10-01 05:00+00', 'Submitted', 5000, 'AED')`);
    const d = await mis.dailyBriefing({ today: TODAY, db, settings });
    const row = d.pending.quotations.rows.find((r) => r.reference.startsWith('Q-AED'));
    assert.equal(row.amount, 5000);
    assert.equal(row.amount_inr, null);
    assert.equal(d.pending.quotations.unconverted, 1);
    await db.query(`DELETE FROM quotations WHERE quotation_no = 'Q-AED'`);
  });
  test('a pending row with no owner account names its salesperson, not a blank', async () => {
    await db.query(`INSERT INTO quotations (quotation_no, client_name, quotation_date, sent_at, status, quotation_value, currency, sales_person)
                    VALUES ('QX-OWNER', 'Owner Test Ltd', '2026-09-30', '2026-09-30T10:00:00Z', 'Submitted', 1000, 'INR', 'Neha Kapoor')`);
    try {
      const d = await mis.dailyBriefing({ today: TODAY, db, settings });
      assert.equal(d.pending.quotations.rows.find((r) => r.reference.startsWith('QX-OWNER')).owner, 'Neha Kapoor');
    } finally {
      await db.query(`DELETE FROM quotations WHERE quotation_no = 'QX-OWNER'`);
    }
  });
});
