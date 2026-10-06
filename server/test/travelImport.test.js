import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';
import XLSX from 'xlsx';
import { readTravelWorkbook } from '../src/import/travel/parse.js';
import { planTravel } from '../src/import/travel/plan.js';
import { fieldFor } from '../src/import/travel/fields.js';
import { docTypeOf, matchFile } from '../src/import/travel/files.js';
import { JULY, travelWorkbook } from './fixtures/travelWorkbook.js';

/**
 * The travel importer (#196 §5): HR's monthly agency workbook, read tab by
 * tab, grouped into trips with legs, the agency's invoices with a line per
 * leg, credit and cancellation notes, then committed and recognised again
 * when the same workbook comes back. The workbook is made up
 * (fixtures/travelWorkbook.js).
 */

const TYPES = [
  { id: 1, name: 'Chargeable', chargeable: true, active: true, sort_order: 1 },
  { id: 2, name: 'Non-chargeable', chargeable: false, active: true, sort_order: 2 },
  { id: 3, name: 'Marketing', chargeable: false, active: true, sort_order: 3 },
  { id: 4, name: 'Internal', chargeable: false, active: true, sort_order: 4 },
];
const ctx = (over = {}) => ({
  vendor: { id: 1, name: 'Happy Tours', invoice_prefixes: ['HT/2627/'] }, gapDays: 7,
  staff: [{ id: 5, name: 'Kiran Patil', email: null }], tripTypes: TYPES,
  pos: [{ po_number: 'PO-TI-1', project_id: 'PRJ-TI-1' }],
  projects: [{ project_id: 'PRJ-TI-1', client_name: 'Example Pharma', service_request_no: null, open: true },
    { project_id: 'PRJ-TI-2', client_name: 'Example Chemicals', service_request_no: 'CV201', open: true }],
  existing: { invoices: [], otherVendorInvoices: [], legs: [], credits: [] }, today: '2026-10-06', ...over,
});
const plan = (over, book) => planTravel(readTravelWorkbook(book || travelWorkbook()), ctx(over));
const codes = (it) => it.flags.map((f) => f.code);
const tripOf = (p, name, date) => p.items.find((it) => it.step === 'trip' && it.payload.employee_name === name && it.payload.travel_start_date === date);
const legsOf = (p, trip) => p.items.filter((it) => it.step === 'segment' && it.payload.trip_seq === trip.seq);

describe('reading the workbook', () => {
  test('every tab finds its own header row, whatever its headers drifted to', () => {
    const { tabs } = readTravelWorkbook(travelWorkbook());
    assert.deepEqual(tabs.map((t) => [t.name, t.rows.length]), [['July', 5], ['Aug', 4], ['Sept', 2], ['Hotels Jul', 1]]);
    const aug = tabs.find((t) => t.name === 'Aug');
    // Two "PO No." columns are both kept, and the unnamed one is named by its letter.
    assert.ok(aug.headers.includes('PO No.') && aug.headers.includes('PO No. (2)'));
    assert.ok(aug.headers.includes('Column S'));
    assert.equal(fieldFor('Included in customer invoice (yes/No) / if yes, invoice number'), 'invoice_no');
    assert.equal(fieldFor('Types: Marketing/Non-Chargeable, Chargeable'), 'trip_type');
    assert.equal(fieldFor('Checking'), 'ignore');
  });

  test('a tab that is not a travel list is passed over', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Notes'], ['Remember to file the July tickets']]), 'Notes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(JULY), 'July');
    const { tabs } = readTravelWorkbook(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert.deepEqual(tabs.map((t) => t.name), ['July']);
  });
});

describe('planning (§5.2, §5.3)', () => {
  const p = plan();

  test('one person, however spelled; a first name matches the one staff member it can be', () => {
    const people = p.items.filter((it) => it.step === 'traveller');
    assert.deepEqual(people.map((it) => it.payload.name), ['Asha Rao', 'Kiran Patil', 'Vikram Joshi', 'Neha Iyer']);
    assert.deepEqual(people[0].payload.spellings, ['Asha Rao', 'asha rao']);
    assert.ok(codes(people[0]).includes('new_staff'));
    assert.equal(people[1].payload.staff_id, 5);
    assert.ok(codes(people[1]).includes('matched_first_name'));
  });

  test('out, a hotel and back is one trip of three legs, linked by its PO', () => {
    const trip = tripOf(p, 'Asha Rao', '2026-07-08');
    assert.equal(trip.payload.po_number, 'PO-TI-1');
    assert.equal(trip.payload.trip_type_id, 1, 'a trip on a PO is chargeable unless the sheet says');
    assert.equal(trip.payload.travel_end_date, '2026-07-12');
    assert.deepEqual(legsOf(p, trip).map((l) => [l.payload.mode, l.payload.from_place, l.payload.to_place]),
      [['flight', 'Pune', 'Hyderabad'], ['hotel', null, 'Hyderabad'], ['flight', 'Hyderabad', 'Pune']]);
    assert.ok(codes(trip).includes('legs_grouped'));
  });

  test('rows sharing an invoice number are one invoice with a line per leg, across trips and people', () => {
    const invoice = (no) => p.items.find((it) => it.step === 'vendor_invoice' && it.payload.vendor_invoice_no === no);
    const lines = (inv) => p.items.filter((it) => it.step === 'invoice_line' && it.payload.invoice_seq === inv.seq);
    assert.equal(lines(invoice('HT/2627/1001')).length, 2);
    const shared = lines(invoice('HT/2627/1003'));
    assert.equal(new Set(shared.map((l) => l.payload.trip_seq)).size, 2, 'two people, two trips, one invoice');
    assert.equal(invoice('HT/2627/1001').payload.invoice_date, '2026-07-06');
    assert.ok(codes(invoice('HT/2627/1001')).includes('vendor_by_prefix'));
    // A blank total is fare + charge + GST, said so.
    const blank = lines(invoice('HT/2627/1002'))[0];
    assert.equal(blank.payload.line_total, 7316);
    assert.ok(codes(blank).includes('total_blank'));
  });

  test('a typed date takes the tab\'s year; a service request finds the project; a name in PO No. is a client', () => {
    const kiran = tripOf(p, 'Kiran Patil', '2026-07-20');
    assert.ok(kiran, 'read "20 july,22" as 20 July 2026');
    assert.ok(codes(legsOf(p, kiran)[0]).includes('text_date'));
    assert.equal(kiran.payload.project_id, 'PRJ-TI-2');
    assert.ok(codes(kiran).includes('project_by_service_request'));
    const vikram = tripOf(p, 'Vikram Joshi', '2026-07-25');
    assert.equal(vikram.payload.client_label, 'Megafine Example');
    assert.equal(vikram.payload.trip_type_id, 2, 'linked to nothing: non-chargeable');
    assert.ok(codes(legsOf(p, vikram)[0]).includes('po_holds_client'));
    assert.ok(codes(vikram).includes('no_po_or_project'));
  });

  test('cancellations: a note against its invoice, the leg marked, the charge read from the remark', () => {
    const notes = p.items.filter((it) => it.step === 'credit_note');
    assert.deepEqual(notes.map((n) => [n.payload.credit_note_no, n.payload.kind, n.payload.against_invoice_no, n.payload.refund_amount]),
      [['HT/2627/CN/301', 'credit_note', 'HT/2627/1102', 2000], ['HT/2627/CNT/151', 'cancellation_note', 'HT/2627/1201', 5000]]);
    assert.equal(notes[0].payload.cancellation_charges, 1500);
    const kolkata = p.items.find((it) => it.seq === notes[0].payload.segment_seq);
    assert.equal(kolkata.payload.status, 'partly_refunded', 'only the return was cancelled');
    assert.ok(codes(kolkata).includes('charges_read'));
    const jaipur = p.items.find((it) => it.seq === notes[1].payload.segment_seq);
    assert.equal(jaipur.payload.status, 'cancelled');
    assert.equal(tripOf(p, 'Asha Rao', '2026-09-03').payload.cancelled, true);
    // The note row bills nothing: the Jaipur invoice has its one line.
    assert.equal(p.items.filter((it) => it.step === 'invoice_line' && it.payload.segment_seq === jaipur.seq).length, 1);
  });

  test('a trip type the list does not have blocks the commit until one is chosen; a typed one is used', () => {
    const expo = tripOf(p, 'Asha Rao', '2026-08-20');
    assert.ok(expo.flags.some((f) => f.level === 'red' && f.code === 'trip_type_unknown'));
    assert.equal(tripOf(p, 'Neha Iyer', '2026-08-04').payload.trip_type_id, 4);
    // Remembered for the vendor, the wording is a type next time.
    const again = plan({ memory: { tripTypes: { conference: 3 } } });
    assert.equal(tripOf(again, 'Asha Rao', '2026-08-20').payload.trip_type_id, 3);
    assert.equal(again.summary.red, 0);
  });

  test('the same workbook again: everything recognised, nothing new', () => {
    const legs = p.items.filter((it) => it.step === 'segment').map((s, i) => {
      const trip = p.items.find((t) => t.seq === s.payload.trip_seq);
      return { segment_id: 100 + i, travel_id: `TRV-2026-${String(i + 1).padStart(3, '0')}`, employee_name: trip.payload.employee_name,
        start_date: s.payload.start_date, from_place: s.payload.from_place, to_place: s.payload.to_place };
    });
    const invoices = p.items.filter((it) => it.step === 'vendor_invoice').map((it, i) => ({ id: i + 1, vendor_invoice_id: `VINV-2026-00${i + 1}`, vendor_invoice_no: it.payload.vendor_invoice_no }));
    const again = plan({ existing: { invoices, otherVendorInvoices: [], legs, credits: ['HT/2627/CN/301', 'HT/2627/CNT/151'] } });
    const fresh = again.items.filter((it) => it.step !== 'traveller' && it.action === 'create');
    assert.deepEqual(fresh.map((it) => `${it.step} ${it.seq}`), []);
    assert.ok(again.items.filter((it) => it.step === 'trip').every((t) => codes(t).includes('trip_exists')));
  });

  test('an invoice number another vendor has is a red flag', () => {
    const p2 = plan({ existing: { invoices: [], otherVendorInvoices: ['HT/2627/1001'], legs: [], credits: [] } });
    const inv = p2.items.find((it) => it.step === 'vendor_invoice' && it.payload.vendor_invoice_no === 'HT/2627/1001');
    assert.ok(inv.flags.some((f) => f.level === 'red' && f.code === 'other_vendors_invoice'));
  });
});

describe('documents by file name (§5.4)', () => {
  const known = {
    invoices: [{ id: 1, vendor_invoice_no: 'HT/2627/18' }, { id: 2, vendor_invoice_no: 'HT/2627/1877' }],
    credits: [{ id: 9, credit_note_no: 'HT/2627/CN/349' }],
    trips: [{ travel_id: 'TRV-2026-014' }],
  };
  test('an invoice, a credit note or a trip, by the number its name holds', () => {
    assert.equal(matchFile('HT-2627-1877.pdf', known).record.id, 2, 'the whole number, not the shorter one inside it');
    assert.equal(matchFile('ht_2627_18 invoice.pdf', known).record.id, 1);
    assert.equal(matchFile('HT_2627_CN_349.pdf', known).kind, 'credit_note');
    assert.equal(matchFile('TRV-2026-014-ticket.pdf', known).record.travel_id, 'TRV-2026-014');
    assert.equal(matchFile('TRV-2026-0145.pdf', known), null);
    assert.equal(matchFile('holiday.jpg', known), null);
    assert.deepEqual(['TRV-1 boarding pass.jpg', 'e-ticket.pdf', 'hotel folio.pdf', 'visa.pdf', 'approval.pdf', 'scan.pdf'].map(docTypeOf),
      ['boarding_pass', 'ticket', 'hotel_bill', 'visa', 'travel_approval', 'other']);
  });
});

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `travel_import_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

describe('uploading, reviewing and committing (#196 §5.1)', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  let db; let app; let hr; let sales;
  const workbook = travelWorkbook();
  const upload = (agent, buffer = workbook, fields = {}) => {
    let r = agent.post('/api/import/travel').attach('file', buffer, 'travel.xlsx');
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r;
  };
  const item = (batch, step, f) => batch.items.find((it) => it.step === step && f(it));

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
    await createUser({ name: 'Hema', email: 'hema@example.com', password: PASSWORD, role: 'hr' }, db);
    await createUser({ name: 'Sam', email: 'sam@example.com', password: PASSWORD, role: 'sales' }, db);
    hr = await signIn('hema@example.com');
    sales = await signIn('sam@example.com');
    await db.query(`INSERT INTO travel_vendors (name, invoice_prefixes, payment_terms_days) VALUES ('Happy Tours', '{HT/2627/}', 15), ('Other Tours', '{OT/}', 30)`);
    await db.query(`INSERT INTO staff (name) VALUES ('Kiran Patil')`);
    await db.query(`INSERT INTO projects (project_id, client_name, service_request_no) VALUES ('PRJ-TI-1', 'Example Pharma', NULL), ('PRJ-TI-2', 'Example Chemicals', 'CV 201')`);
    await db.query(`INSERT INTO purchase_orders (po_number, project_id, po_value) VALUES ('PO-TI-1', 'PRJ-TI-1', 500000)`);
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

  test('a sales user cannot reach it; HR does not reach the sales importer', async () => {
    await upload(sales).expect(403);
    await sales.get('/api/import/travel').expect(403);
    await hr.get('/api/import/batches').expect(403);
    const binary = (res, cb) => { const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
    const { body } = await hr.get('/api/import/travel/template.xlsx').buffer(true).parse(binary).expect(200);
    const { tabs } = readTravelWorkbook(body);
    assert.equal(tabs[0].rows.length, 1, 'the template reads as a travel list itself');
  });

  test('upload, fix what is red, commit; then the same workbook again writes nothing', async () => {
    // The vendor is found by its invoice prefixes.
    const { body: { data: batch } } = await upload(hr).expect(201);
    assert.equal(batch.vendor_name, 'Happy Tours');
    assert.equal(batch.summary.blocking, 1);
    await hr.post(`/api/import/travel/${batch.id}/commit`).expect(422);

    const expo = item(batch, 'trip', (it) => it.payload.travel_start_date === '2026-08-20');
    const { body: { data: fixed } } = await hr.patch(`/api/import/travel/${batch.id}/items/${expo.id}`).send({ payload: { trip_type_id: 3 } }).expect(200);
    assert.equal(fixed.summary.blocking, 0);

    const { body: { data: done } } = await hr.post(`/api/import/travel/${batch.id}/commit`).expect(200);
    assert.equal(done.status, 'committed');
    assert.deepEqual(done.written, { traveller: 3, trip: 8, segment: 10, vendor_invoice: 8, invoice_line: 10, credit_note: 2 });

    const { rows: [inv] } = await db.query(`SELECT invoice_amount, payment_terms_days, (SELECT count(*)::int FROM travel_vendor_invoice_lines l WHERE l.vendor_invoice_id = i.id) AS lines
                                             FROM travel_vendor_invoices i WHERE vendor_invoice_no = 'HT/2627/1001'`);
    assert.deepEqual([Number(inv.invoice_amount), inv.payment_terms_days, inv.lines], [11092, 15, 2]);
    const { rows: [trip] } = await db.query(`SELECT t.*, tt.name AS type FROM travel_logs t JOIN trip_types tt ON tt.id = t.trip_type_id
                                              WHERE employee_name = 'Asha Rao' AND travel_start_date = '2026-07-08'`);
    assert.equal(trip.po_number, 'PO-TI-1');
    assert.equal(trip.type, 'Chargeable');
    const { rows: legs } = await db.query('SELECT mode, status FROM travel_segments WHERE travel_id = $1 ORDER BY seq', [trip.travel_id]);
    assert.deepEqual(legs.map((l) => l.mode), ['flight', 'hotel', 'flight']);
    const { rows: [jaipur] } = await db.query(`SELECT s.status, t.cancelled FROM travel_segments s JOIN travel_logs t ON t.travel_id = s.travel_id WHERE s.to_place = 'Jaipur'`);
    assert.deepEqual(jaipur, { status: 'cancelled', cancelled: true });
    const { rows: [note] } = await db.query(`SELECT n.cancellation_charges, i.vendor_invoice_no FROM travel_vendor_credit_notes n
                                              JOIN travel_vendor_invoices i ON i.id = n.against_invoice_id WHERE credit_note_no = 'HT/2627/CN/301'`);
    assert.deepEqual([Number(note.cancellation_charges), note.vendor_invoice_no], [1500, 'HT/2627/1102']);
    const { rows: staff } = await db.query('SELECT name FROM staff ORDER BY name');
    assert.deepEqual(staff.map((s) => s.name), ['Asha Rao', 'Kiran Patil', 'Neha Iyer', 'Vikram Joshi']);
    assert.equal((await db.query('SELECT source_file FROM import_batches WHERE id = $1', [batch.id])).rows[0].source_file, null, 'the workbook is not kept past the commit');

    // Again: every trip, leg, invoice and note is recognised, and the trip type wording is remembered.
    const { body: { data: second } } = await upload(hr).expect(201);
    assert.equal(second.summary.blocking, 0, 'the trip type chosen for "Conference" is remembered');
    const { body: { data: again } } = await hr.post(`/api/import/travel/${second.id}/commit`).expect(200);
    assert.deepEqual(again.written, { traveller: 0, trip: 0, segment: 0, vendor_invoice: 0, invoice_line: 0, credit_note: 0 });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM travel_logs')).rows[0].n, 8);

    // The sales importer's list shows sales batches only.
    const { rows: [admin] } = await db.query(`SELECT count(*)::int AS n FROM import_batches WHERE kind = 'travel'`);
    assert.equal(admin.n, 2);
  });

  test('a leg can be split off into a trip of its own, and a column corrected is remembered for the vendor', async () => {
    const book = travelWorkbook({ aug: null, sept: null, hotels: null, july: JULY.map((r, i) => (i === 3 || i === 4 ? r.map((c) => (c === 'HT/2627/1001' ? 'HT/2627/9001' : c)) : r)).map((r) => r.map((c) => (c === 'Asha Rao' || c === 'asha rao' ? 'Ravi Menon' : c))) });
    const { body: { data: batch } } = await upload(hr, book, { vendor_id: '1' }).expect(201);
    const back = item(batch, 'segment', (it) => it.payload.from_place === 'Hyderabad');
    const { body: { data: split } } = await hr.post(`/api/import/travel/${batch.id}/items/${back.id}/split`).expect(201);
    const trips = split.items.filter((it) => it.step === 'trip' && it.payload.employee_name === 'Ravi Menon');
    assert.equal(trips.length, 2);
    assert.deepEqual(trips.map((t) => [t.payload.origin, t.payload.travel_start_date]).sort(), [['Hyderabad', '2026-07-12'], ['Pune', '2026-07-08']]);
    const line = item(split, 'invoice_line', (it) => it.payload.segment_seq === back.seq);
    assert.equal(line.payload.trip_seq, trips.find((t) => t.payload.origin === 'Hyderabad').seq, 'the leg\'s line goes with it');

    // Airlines is not read from now on, for this vendor.
    const { body: { data: remapped } } = await hr.patch(`/api/import/travel/${batch.id}`).send({ column: { header: 'Airlines', field: 'ignore' } }).expect(200);
    assert.equal(item(remapped, 'segment', () => true).payload.provider, null);
    const { body: { data: next } } = await upload(hr, book, { vendor_id: '1' }).expect(201);
    assert.equal(item(next, 'segment', () => true).payload.provider, null, 'remembered for the vendor');
    await hr.delete(`/api/import/travel/${next.id}`).expect(204);
    await hr.post(`/api/import/travel/${batch.id}/commit`).expect(200);
    await hr.delete(`/api/import/travel/${batch.id}`).expect(409);
  });
});
