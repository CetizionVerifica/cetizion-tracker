import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The travel desk (#196): the HR role, the trip's legs, a travel agency
 * invoice covering several trips, credit notes, and the views that add
 * them up. Database mode, with an admin, a sales user and an HR user.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `travel_desk_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

describe('the travel desk (#196)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let app; let admin; let sales; let hr; let vendor;

  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));

    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: url.toString(), AUTH_MODE: 'database', EMAIL_MODE: 'log',
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
    });
    ({ default: app } = await import('../src/app.js'));
    const { createUser } = await import('../src/lib/users.js');
    const signIn = async (email) => {
      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200);
      return agent;
    };
    for (const [role, email] of [['admin', 'ada@example.com'], ['sales', 'sam@example.com'], ['hr', 'hema@example.com']]) {
      await createUser({ name: email.split('@')[0], email, password: PASSWORD, role }, db);
    }
    admin = await signIn('ada@example.com');
    sales = await signIn('sam@example.com');
    hr = await signIn('hema@example.com');

    vendor = (await hr.post('/api/travel-vendors').send({ name: 'Happy Tours', gstin: '27AAAAA0000A1Z5', invoice_prefixes: 'HT/2627/, HTT/26-27/' }).expect(201)).body.data;
    await db.query(`INSERT INTO projects (project_id, client_name, service_request_no) VALUES ('PRJ-TD-1', 'Acme Travel Ltd', 'cv 108'), ('PRJ-TD-2', 'Beta Travel Ltd', NULL)`);
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value) VALUES ('PO-TD-1', 'PRJ-TD-2', 100000)`);
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool.end().catch(() => {});
    await db?.end().catch(() => {});
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  test('HR keeps the travel lists; a sales user still cannot', async () => {
    assert.deepEqual(vendor.invoice_prefixes, ['HT/2627/', 'HTT/26-27/']);
    const { body: types } = await hr.get('/api/trip-types').expect(200);
    assert.deepEqual(types.data.map((t) => [t.name, t.chargeable]), [['Chargeable', true], ['Non-chargeable', false], ['Marketing', false], ['Internal', false]]);
    await hr.post('/api/trip-types').send({ name: 'Training', chargeable: false }).expect(201);
    await sales.post('/api/trip-types').send({ name: 'Sales trip' }).expect(403);
    await sales.post('/api/travel-vendors').send({ name: 'Other Tours' }).expect(403);
  });

  test('HR reaches the travel desk only; its dropdowns carry the travel lists and what linking a trip needs', async () => {
    await hr.get('/api/quotations').expect(403);
    await hr.get('/api/purchase-orders').expect(403);
    await hr.get('/api/dashboard/overview').expect(403);
    await hr.get('/api/inbox/summary').expect(403);
    await hr.get('/api/expense-claims').expect(403);
    await hr.get('/api/dashboard/travel').expect(200);
    const { body } = await hr.get('/api/lookups').expect(200);
    assert.ok(Array.isArray(body.data.trip_types) && Array.isArray(body.data.travel_vendor_list));
    assert.deepEqual(Object.keys(body.data.purchase_orders[0]).sort(), ['client_name', 'currency', 'po_number', 'po_value', 'project_id']);
    assert.equal(body.data.purchase_orders[0].client_name, 'Beta Travel Ltd', 'every PO, not only the ones HR owns');
    for (const key of ['quotations', 'sales_people', 'pipeline_stages', 'companies']) assert.equal(body.data[key], undefined, key);
    // The service request number is kept once, normalised.
    assert.equal(body.data.projects.find((p) => p.project_id === 'PRJ-TD-1').service_request_no, 'CV108');
  });

  test('a trip: its vendor by name, its type by its link, its project typed once, billing only when chargeable', async () => {
    const internal = (await hr.post('/api/travel-logs').send({ travel_id: 'TRV-TD-1', employee_name: 'Asha', arranged_by: 'happy tours', travel_start_date: '2026-07-08', travel_end_date: '2026-07-12' }).expect(201)).body.data;
    assert.equal(internal.vendor_id, vendor.id, 'the free-text vendor finds the vendor, whatever its case');
    const { rows: [t1] } = await db.query(`SELECT trip_type, chargeable, arranged_by FROM v_travel_logs WHERE travel_id = 'TRV-TD-1'`);
    assert.deepEqual([t1.trip_type, t1.chargeable, t1.arranged_by], ['Non-chargeable', false, 'Happy Tours']);

    await hr.post('/api/travel-logs').send({ travel_id: 'TRV-TD-2', employee_name: 'Ravi', vendor_id: vendor.id, project_id: 'PRJ-TD-1' }).expect(201);
    const { rows: [t2] } = await db.query(`SELECT trip_type, project_id, client_name, service_request_no FROM v_travel_logs WHERE travel_id = 'TRV-TD-2'`);
    assert.deepEqual([t2.trip_type, t2.project_id, t2.client_name, t2.service_request_no], ['Chargeable', 'PRJ-TD-1', 'Acme Travel Ltd', 'CV108']);

    // With a PO, the project is the PO's: another one is refused.
    const clash = await hr.post('/api/travel-logs').send({ travel_id: 'TRV-TD-3', employee_name: 'Meera', po_number: 'PO-TD-1', project_id: 'PRJ-TD-1' });
    assert.equal(clash.status, 422, JSON.stringify(clash.body));
    await hr.post('/api/travel-logs').send({ travel_id: 'TRV-TD-3', employee_name: 'Meera', po_number: 'PO-TD-1' }).expect(201);

    // Billing names a travel invoice, and only for a chargeable trip. It is
    // set through the trip's own billing route, never the edit form: the
    // field is protected there (#214). Since 097 the stage it names has to
    // be a travel invoice — a share of the PO is not something a trip is
    // billed on — so that is what is raised here.
    const { rows: [stage] } = await db.query(
      `INSERT INTO payment_stages (kind, po_number, stage_name, trigger_event, amount, invoice_no, invoice_date)
            VALUES ('travel', 'PO-TD-1', 'Travel invoice', 'Manual', 25000, 'CVPL/TD/1', CURRENT_DATE) RETURNING id`);
    const notChargeable = await admin.post(`/api/travel-logs/${internal.travel_id}/billed-stage`).send({ billed_stage_id: stage.id });
    assert.equal(notChargeable.status, 422, JSON.stringify(notChargeable.body));
    await admin.post('/api/travel-logs/TRV-TD-3/billed-stage').send({ billed_stage_id: stage.id }).expect(200);
    const { rows: [billed] } = await db.query(`SELECT billed_invoice_no FROM v_travel_logs WHERE travel_id = 'TRV-TD-3'`);
    assert.equal(billed.billed_invoice_no, 'CVPL/TD/1');
  });

  test('legs, one bill for two trips, a credit note on a leg: each trip carries its own share', async () => {
    const leg1 = (await hr.post('/api/travel-segments').send({ travel_id: 'TRV-TD-1', mode: 'flight', from_place: 'Pune', to_place: 'Hyderabad', start_date: '2026-07-08' }).expect(201)).body.data;
    const leg2 = (await hr.post('/api/travel-segments').send({ travel_id: 'TRV-TD-2', mode: 'flight', from_place: 'Pune', to_place: 'Hyderabad', start_date: '2026-07-08' }).expect(201)).body.data;
    const hotel = await hr.post('/api/travel-segments').send({ travel_id: 'TRV-TD-1', mode: 'hotel', to_place: 'Hyderabad', start_date: '2026-07-08', end_date: '2026-07-08' });
    assert.equal(hotel.status, 422, 'a hotel stay needs a check-out after its check-in');
    await hr.post('/api/travel-segments').send({ travel_id: 'TRV-TD-1', mode: 'hotel', provider: 'Lakeview', to_place: 'Hyderabad', start_date: '2026-07-08', end_date: '2026-07-11' }).expect(201);
    const { rows: [nights] } = await db.query(`SELECT nights FROM v_travel_segments WHERE mode = 'hotel'`);
    assert.equal(nights.nights, 3);

    const bill = (await hr.post('/api/vendor-invoices').send({ vendor_invoice_id: 'VI-TD-1', vendor_id: vendor.id, vendor_invoice_no: 'HT/2627/1881', invoice_date: '2026-07-13' }).expect(201)).body.data;
    await hr.post('/api/vendor-invoice-lines').send({ vendor_invoice_id: bill.id, travel_id: 'TRV-TD-1', segment_id: leg1.id, base_fare: 9000, service_charge: 200, gst_amount: 800, line_total: 10000 }).expect(201);
    await hr.post('/api/vendor-invoice-lines').send({ vendor_invoice_id: bill.id, travel_id: 'TRV-TD-2', segment_id: leg2.id, line_total: 6000 }).expect(201);
    const { body: full } = await hr.get(`/api/vendor-invoices/${bill.id}/full`).expect(200);
    assert.equal(Number(full.data.invoice.invoice_amount), 16000, 'the total follows the lines');
    assert.equal(full.data.invoice.trip_count, 2);
    assert.equal(full.data.invoice.employee_name, 'Asha, Ravi');
    assert.equal(full.data.invoice.travel_id, null, 'no single trip');
    // An invoice of several lines is changed through its lines.
    await hr.patch(`/api/vendor-invoices/${bill.id}`).send({ invoice_amount: 1 }).expect(422);

    await db.query(`UPDATE travel_vendor_invoices SET amount_paid = 8000 WHERE id = $1`, [bill.id]);
    await hr.post('/api/vendor-credit-notes').send({ vendor_id: vendor.id, credit_note_no: 'HT/2627/CNT/151', against_invoice_id: bill.id, segment_id: leg2.id, kind: 'cancellation_note', refund_amount: 5500, cancellation_charges: 500 }).expect(201);
    const { rows: [cancelled] } = await db.query('SELECT status FROM travel_segments WHERE id = $1', [leg2.id]);
    assert.equal(cancelled.status, 'cancelled', 'a cancellation note on a leg cancels it');

    const { rows: trips } = await db.query(`SELECT travel_id, vendor_cost::float8 AS cost, vendor_paid::float8 AS paid FROM v_travel_logs WHERE travel_id IN ('TRV-TD-1','TRV-TD-2') ORDER BY 1`);
    assert.deepEqual(trips.map((t) => [t.travel_id, t.cost]), [['TRV-TD-1', 10000], ['TRV-TD-2', 500]], 'the refund falls to the cancelled leg');
    assert.equal(Math.round((trips[0].paid + trips[1].paid) * 100) / 100, 8000, 'what was paid is shared out, not counted twice');
    assert.ok(trips[1].paid < 500, 'a refunded leg is not shown as paid for beyond what it cost');

    const { rows: [inv] } = await db.query(`SELECT credited::float8, net_payable::float8, payment_status FROM v_travel_vendor_invoices WHERE id = $1`, [bill.id]);
    assert.deepEqual([inv.credited, inv.net_payable], [5500, 10500]);
    const { rows: [owed] } = await db.query(`SELECT outstanding::float8 FROM v_vendor_invoice_ageing WHERE id = $1`, [bill.id]);
    assert.equal(owed.outstanding, 2500, 'owed is the bill less its credit notes and what was paid');

    // A trip on a project with no PO counts against that project.
    const { rows: [project] } = await db.query(`SELECT total_travel_cost::float8 FROM v_projects WHERE project_id = 'PRJ-TD-1'`);
    assert.equal(project.total_travel_cost, 500);
  });

  test('an invoice entered the old way, against one trip, keeps working', async () => {
    const old = (await sales.post('/api/vendor-invoices').send({ vendor_invoice_id: 'VI-TD-2', travel_id: 'TRV-TD-3', vendor_invoice_no: 'HT/2627/1877', invoice_amount: 24629.02 }).expect(201)).body.data;
    const { rows: lines } = await db.query('SELECT travel_id, line_total::float8 FROM travel_vendor_invoice_lines WHERE vendor_invoice_id = $1', [old.id]);
    assert.deepEqual(lines.map((l) => [l.travel_id, l.line_total]), [['TRV-TD-3', 24629.02]], 'its one line is made for it');
    await sales.patch(`/api/vendor-invoices/${old.id}`).send({ invoice_amount: 25000 }).expect(200);
    const { rows: [line] } = await db.query('SELECT line_total::float8 FROM travel_vendor_invoice_lines WHERE vendor_invoice_id = $1', [old.id]);
    assert.equal(line.line_total, 25000, 'changing a one-line bill changes its line');
    const { rows: [header] } = await db.query('SELECT vendor_id FROM travel_vendor_invoices WHERE id = $1', [old.id]);
    assert.ok(header.vendor_id, 'the vendor comes from the trip, or "Vendor not recorded"');
    await sales.post('/api/vendor-invoices').send({ vendor_invoice_id: 'VI-TD-3', travel_id: 'TRV-TD-3', vendor_id: header.vendor_id, vendor_invoice_no: 'HT/2627/1877' }).expect(409);
  });

  test('a trip in full: its legs, its share of every bill, credit notes and files; HR files only on travel records', async () => {
    const { body } = await hr.get('/api/travel-logs/TRV-TD-2/full').expect(200);
    assert.equal(body.data.legs.length, 1);
    assert.equal(body.data.vendor_invoices.length, 1, `the bill it shares with another trip: ${JSON.stringify(body.data.invoice_lines)}`);
    assert.equal(body.data.invoice_lines.length, 1, 'its own line only');
    assert.equal(body.data.credit_notes.length, 1);

    const { rows: [doc] } = await db.query(`INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ('k-td-1', 'ticket.pdf', 'application/pdf', 10) RETURNING id`);
    await hr.post('/api/attachments').send({ entity: 'travel_log', entity_id: 'TRV-TD-2', document_id: doc.id, doc_type: 'ticket' }).expect(201);
    const { rows: [other] } = await db.query(`INSERT INTO documents (storage_key, file_name, content_type, size_bytes) VALUES ('k-td-2', 'x.pdf', 'application/pdf', 10) RETURNING id`);
    await hr.post('/api/attachments').send({ entity: 'company', entity_id: '1', document_id: other.id }).expect(403);
    const { rows: [files] } = await db.query(`SELECT document_count, missing_documents FROM v_travel_logs WHERE travel_id = 'TRV-TD-2'`);
    assert.equal(files.document_count, 1);
    assert.deepEqual(files.missing_documents, ['vendor invoice'], 'the ticket is on file; the bill has no PDF yet');
  });
});
