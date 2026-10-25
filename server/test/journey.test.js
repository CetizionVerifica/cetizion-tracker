import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * The sales journey end to end (docs/specs/sales-journey): v_sales_journey
 * builds one row per sale, GET /api/journey and /api/journey/of answer the
 * contract in server/src/lib/journey/CLAUDE.md §5, and each salesperson
 * sees the sales they hold a record in, through any of the three routes,
 * and nobody else's. A throwaway database with real sign-ins; every company
 * and person here is made up. Needs TEST_DATABASE_URL (CI sets it).
 *
 * Nothing from src/ is imported at the top of this file, and that is the
 * point: config.js fixes the database it talks to when it is first loaded,
 * so a module loaded before DATABASE_URL names the throwaway database would
 * bind the pool to whatever server/.env names — a developer's own database.
 * Everything is imported in before(), after the URL is set, and the pool is
 * checked before a single row is written.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `journey_test_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

let app; let pool; let admin; let sam; let bea; let hema; let businessToday; let daysBefore;
const ids = {};

describe('the sales journey', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
  before(async () => {
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.query(`CREATE DATABASE ${NAME}`);
    await root.end();
    const url = new URL(ADMIN_URL); url.pathname = `/${NAME}`;
    const db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    for (const f of ['schema.sql', 'views.sql']) await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
    await db.end();

    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = url.toString();
    process.env.AUTH_MODE = 'database';
    process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-pass';
    process.env.EMAIL_MODE = 'log';
    ({ default: app } = await import('../src/app.js'));
    ({ pool } = await import('../src/db.js'));
    assert.equal(pool.options.connectionString, url.toString(), 'the pool must be the throwaway database, never the one in .env');
    ({ businessToday } = await import('../src/lib/businessDate.ts'));
    ({ daysBefore } = await import('../src/lib/journey/steps.js'));
    const { createUser } = await import('../src/lib/users.js');
    const signIn = async (email) => {
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.headers['set-cookie'];
    };
    const mk = async (name, email, role) => { const u = await createUser({ name, email, role, password: PASSWORD }, pool); return { ...u, cookie: await signIn(email) }; };
    admin = await mk('Ada Admin', 'ada@cetizion.example', 'admin');
    sam = await mk('Sam Sales', 'sam@cetizion.example', 'sales');
    bea = await mk('Bea Sales', 'bea@cetizion.example', 'sales');
    hema = await mk('Hema HR', 'hema@cetizion.example', 'hr');

    // Ten sales, each one a rule:
    //   A  enquiry (Sam's) converted into a quotation (Bea's)
    //   B  a quotation of Sam's in euros, with no enquiry, slow
    //   C  a won quotation (Bea's) on Sam's project, with two POs, one overdue and one without stages
    //   D  an enquiry of Bea's, five days old
    //   E  an enquiry of Sam's, stuck;  U  an unqualified one of Sam's
    //   P  a PO on Bea's project with no quotation: revised once, and a cancelled one beside it
    //   W1-W3  three quotations on one project, lost, won and open; its PO names none and joins the won one
    await pool.query(`
      INSERT INTO exchange_rates (from_currency, rate, effective_from) VALUES ('EUR', 90, '2020-01-01');
      INSERT INTO projects (project_id, client_name, owner_user_id, sales_person, primary_service) VALUES
        ('PRJ-T-C', 'Sample Forgings', ${sam.id}, 'Bea Sales', 'ISO 45001 certification'),
        ('PRJ-T-P', 'Example Polymers', ${bea.id}, 'Bea Sales', 'Energy audit'),
        ('PRJ-T-W', 'Demo Castings', NULL, 'Bea Sales', 'ISO 9001 certification');
      INSERT INTO quotations (quotation_no, client_name, owner_user_id, sales_person, service_quoted, quotation_date, quotation_value, currency, status, sent_at, created_at, project_id) VALUES
        ('Q-T-A', 'Example Textiles', ${bea.id}, 'Bea Sales', 'ISO 9001 certification', CURRENT_DATE - 15, 300000, 'INR', 'Submitted', now() - interval '10 days', now() - interval '15 days', NULL),
        ('Q-T-B', 'Sample Agro', ${sam.id}, 'Sam Sales', 'ISO 14001 certification', CURRENT_DATE - 30, 10000, 'EUR', 'Under Negotiation', now() - interval '28 days', now() - interval '30 days', NULL),
        ('Q-T-C', 'Sample Forgings', ${bea.id}, 'Bea Sales', 'ISO 45001 certification', CURRENT_DATE - 70, 150000, 'INR', 'Won - PO Received', now() - interval '65 days', now() - interval '70 days', 'PRJ-T-C'),
        ('Q-T-W1', 'Demo Castings', ${bea.id}, 'Bea Sales', 'ISO 9001 certification', CURRENT_DATE - 60, 90000, 'INR', 'Lost', now() - interval '59 days', now() - interval '60 days', 'PRJ-T-W'),
        ('Q-T-W2', 'Demo Castings', ${bea.id}, 'Bea Sales', 'ISO 9001 certification', CURRENT_DATE - 50, 80000, 'INR', 'Won - PO Received', now() - interval '49 days', now() - interval '50 days', 'PRJ-T-W'),
        ('Q-T-W3', 'Demo Castings', ${bea.id}, 'Bea Sales', 'ISO 9001 certification', CURRENT_DATE - 10, 5000, 'USD', 'Submitted', now() - interval '9 days', now() - interval '10 days', 'PRJ-T-W');
      INSERT INTO enquiries (enquiry_no, client_name, owner_user_id, sales_person, service, status, enquiry_date, created_at, estimated_value, quotation_no) VALUES
        ('CTZ/ENQ/2026/901', 'Example Textiles', ${sam.id}, 'Sam Sales', 'ISO 9001 certification', 'Converted', CURRENT_DATE - 20, now() - interval '20 days', 250000, 'Q-T-A'),
        ('CTZ/ENQ/2026/902', 'Example Ceramics', ${bea.id}, 'Bea Sales', 'ISO 9001 certification', 'New', CURRENT_DATE - 5, now() - interval '5 days', 120000, NULL),
        ('CTZ/ENQ/2026/903', 'Sample Paper', ${sam.id}, 'Sam Sales', 'Energy audit', 'Contacted', CURRENT_DATE - 30, now() - interval '30 days', NULL, NULL),
        ('CTZ/ENQ/2026/904', 'Sample Dyes', ${sam.id}, 'Sam Sales', 'Energy audit', 'Unqualified', CURRENT_DATE - 10, now() - interval '10 days', NULL, NULL);
      INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value) VALUES
        ('PO-T-C1', 'PRJ-T-C', 'Q-T-C', CURRENT_DATE - 60, 100000),
        ('PO-T-C2', 'PRJ-T-C', 'Q-T-C', CURRENT_DATE - 55, 50000),
        ('PO-T-P1', 'PRJ-T-P', NULL, CURRENT_DATE - 60, 40000),
        ('PO-T-W1', 'PRJ-T-W', NULL, CURRENT_DATE - 20, 80000);
      INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, replaces_po_number) VALUES ('PO-T-P2', 'PRJ-T-P', CURRENT_DATE - 50, 45000, 'PO-T-P1');
      INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, cancelled) VALUES ('PO-T-P3', 'PRJ-T-P', CURRENT_DATE - 40, 30000, true);
      INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date, credit_days, amount_received, payment_received_date) VALUES
        ('PO-T-C1', 1, 'Advance', 'On PO Registration', 0.5, 'INV-T-1', CURRENT_DATE - 50, 30, 0, NULL),
        ('PO-T-C1', 2, 'On delivery', 'On Delivery', 0.5, NULL, NULL, NULL, 0, NULL),
        ('PO-T-W1', 1, 'In full', 'On PO Registration', 1, 'INV-T-2', CURRENT_DATE - 15, 30, 80000, CURRENT_DATE - 3);
    `);
    const { rows } = await pool.query(`SELECT quotation_no AS no, id FROM quotations UNION ALL SELECT enquiry_no, id FROM enquiries UNION ALL SELECT po_number, id FROM purchase_orders`);
    for (const r of rows) ids[r.no] = r.id;
  });

  after(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
    await root.end();
  });

  const as = (who) => ({
    get: (p) => request(app).get(p).set('Cookie', who.cookie),
    patch: (p, b) => request(app).patch(p).set('Cookie', who.cookie).send(b),
  });
  const key = { A: () => `q-${ids['Q-T-A']}`, B: () => `q-${ids['Q-T-B']}`, C: () => `q-${ids['Q-T-C']}`, W1: () => `q-${ids['Q-T-W1']}`,
    W2: () => `q-${ids['Q-T-W2']}`, W3: () => `q-${ids['Q-T-W3']}`, D: () => `e-${ids['CTZ/ENQ/2026/902']}`, E: () => `e-${ids['CTZ/ENQ/2026/903']}`,
    U: () => `e-${ids['CTZ/ENQ/2026/904']}`, P: () => `p-${ids['PO-T-P2']}` };
  const keys = (...names) => names.map((n) => key[n]()).sort();
  const board = async (who, qs = '') => {
    const res = await as(who).get(`/api/journey${qs}`).expect(200);
    return res.body.data;
  };
  const cardKeys = (data) => data.cards.map((c) => c.key).sort();
  const of = (who, qs) => as(who).get(`/api/journey/of?${qs}`);

  // ------------------------------------------------------------- identity

  test('one row per sale: every quotation, every unquoted enquiry, every live PO with no quotation', async () => {
    const { rows } = await pool.query('SELECT journey_key, anchor FROM v_sales_journey ORDER BY journey_key');
    assert.deepEqual(rows.map((r) => r.journey_key).sort(), keys('A', 'B', 'C', 'W1', 'W2', 'W3', 'D', 'E', 'U', 'P'));
    assert.deepEqual(rows.find((r) => r.journey_key === key.P()).anchor, 'po');
    const { rows: twice } = await pool.query('SELECT n FROM v_sales_journey, unnest(po_numbers) n GROUP BY n HAVING count(*) > 1');
    assert.deepEqual(twice, [], 'no PO is in two sales');
  });

  test('a quotation carries its enquiry, and both owners', async () => {
    const { rows: [a] } = await pool.query('SELECT * FROM v_sales_journey WHERE journey_key = $1', [key.A()]);
    assert.equal(a.enquiry_no, 'CTZ/ENQ/2026/901');
    assert.equal(a.enquiry_owner_id, sam.id);
    assert.equal(a.quotation_owner_id, bea.id);
    assert.equal(a.sales_person, 'Bea Sales', 'the quotation\'s salesperson first');
    const card = (await of(admin, 'quotation=Q-T-A').expect(200)).body.data;
    assert.equal(card.started_on, (await pool.query('SELECT (CURRENT_DATE - 20)::text AS d')).rows[0].d, 'the sale began with the enquiry');
  });

  test('two POs on one quotation are one sale, added up', async () => {
    const { rows: [c] } = await pool.query('SELECT * FROM v_sales_journey WHERE journey_key = $1', [key.C()]);
    assert.equal(c.po_count, 2);
    assert.deepEqual(c.po_numbers, ['PO-T-C1', 'PO-T-C2'], 'by PO date');
    assert.equal(c.first_po_number, 'PO-T-C1');
    assert.equal(Number(c.po_value_total), 150000);
    assert.equal(c.po_currency, 'INR');
    assert.equal(c.pos_without_stages, 1);
    assert.equal(c.overdue_stages, 1);
    assert.equal(Number(c.overdue_amount), 50000);
    assert.equal(c.billable_stages, 1);
    assert.deepEqual(c.project_owner_ids, [sam.id]);
  });

  test('a PO naming no quotation joins the won quotation on its project, not the newest', async () => {
    const { rows } = await pool.query(`SELECT journey_key, po_numbers, fully_paid FROM v_sales_journey WHERE journey_key = ANY($1)`, [[key.W1(), key.W2(), key.W3()]]);
    const byKey = Object.fromEntries(rows.map((r) => [r.journey_key, r]));
    assert.deepEqual(byKey[key.W2()].po_numbers, ['PO-T-W1']);
    assert.equal(byKey[key.W2()].fully_paid, true);
    assert.deepEqual(byKey[key.W3()].po_numbers, []);
    assert.deepEqual(byKey[key.W1()].po_numbers, []);
  });

  test('cancelled and replaced POs are in no sale; the revision stands on its own', async () => {
    const { rows } = await pool.query(`SELECT journey_key, po_numbers, client_name, project_owner_ids FROM v_sales_journey WHERE po_numbers && $1::text[]`, [['PO-T-P1', 'PO-T-P2', 'PO-T-P3']]);
    assert.deepEqual(rows.map((r) => [r.journey_key, r.po_numbers]), [[key.P(), ['PO-T-P2']]]);
    assert.equal(rows[0].client_name, 'Example Polymers', 'from the project, since a PO names no client');
    assert.deepEqual(rows[0].project_owner_ids, [bea.id]);
  });

  // ---------------------------------------------------------------- board

  test('the board: period, funnel, three columns, cards and settings', async () => {
    const data = await board(admin);
    const today = businessToday();
    assert.deepEqual(data.period, { from: daysBefore(today, 90), to: today });
    assert.deepEqual(data.funnel, { started: 10, quoted: 7, won: 3, with_po: 3 }, 'the PO-only sale got past quoting');
    assert.deepEqual(data.steps.map((s) => [s.key, s.label, s.count]), [['enquiry', 'Enquiry', 2], ['quotation', 'Quotation', 3], ['po', 'PO', 3]]);
    assert.deepEqual(data.settings, { enquiry_days: 7, quotation_days: 21, unsent_days: 5, po_days: 30, paid_visible_days: 30 });
    // Lost and unqualified wait for Show closed; the paid sale stays, paid three days ago.
    assert.deepEqual(cardKeys(data), keys('A', 'B', 'C', 'W2', 'W3', 'D', 'E', 'P'));
  });

  test('a card, as the contract draws it', async () => {
    const data = await board(admin);
    const b = data.cards.find((c) => c.key === key.B());
    assert.deepEqual(Object.keys(b), ['key', 'step', 'exit', 'small_step', 'progress', 'days_in_step', 'step_since', 'flag', 'next',
      'client_name', 'company_id', 'service', 'sales_person', 'value', 'currency', 'value_inr', 'value_hidden', 'records', 'started_on']);
    assert.equal(b.step, 'quotation');
    assert.equal(b.small_step, 'Negotiating');
    assert.deepEqual(b.progress, ['skipped', 'current', 'future']);
    assert.equal(b.days_in_step, 30);
    assert.deepEqual(b.flag, { kind: 'slow', label: 'Slow 30 days', tone: 'waiting' });
    assert.deepEqual(b.next, { verb: 'follow_up', label: 'Follow up' });
    assert.deepEqual([b.value, b.currency, b.value_inr], [10000, 'EUR', 900000], 'euros at the rate on the quotation\'s date');
    assert.ok(Number.isInteger(b.company_id), 'the client is linked to its company');
    assert.deepEqual(b.records, { enquiry_no: null, quotation_no: 'Q-T-B', po_number: null, project_id: null });

    const c = data.cards.find((x) => x.key === key.C());
    assert.equal(c.flag.kind, 'overdue');
    assert.equal(c.flag.label, '₹50,000 overdue');
    assert.deepEqual(c.next, { verb: 'set_split', label: 'Set the payment split' }, 'one of its POs has no stages yet');
    assert.deepEqual([c.value, c.value_inr], [150000, 150000]);
    assert.equal(c.records.po_number, 'PO-T-C1');

    const w2 = data.cards.find((x) => x.key === key.W2());
    assert.deepEqual([w2.exit, w2.small_step, w2.flag, w2.next], ['paid', 'Paid', null, null]);
    assert.deepEqual(w2.progress, ['skipped', 'done', 'done']);

    const quotations = data.steps.find((s) => s.key === 'quotation');
    assert.equal(quotations.without_rate, 1, 'the dollar quotation has no rate');
    assert.equal(quotations.value_inr, 300000 + 900000);
    // Enquiry first, then the flags that need someone, then the longest waiting.
    assert.deepEqual(data.cards.map((x) => x.step), ['enquiry', 'enquiry', 'quotation', 'quotation', 'quotation', 'po', 'po', 'po']);
    assert.equal(data.cards[0].key, key.E(), 'the stuck enquiry leads');
  });

  test('filters: owner, service, stuck only, show closed', async () => {
    assert.deepEqual(cardKeys(await board(admin, '?sales_person=Sam%20Sales')), keys('B', 'E'));
    assert.deepEqual(cardKeys(await board(admin, '?service=ISO%2014001%20certification')), keys('B'));
    const stuck = await board(admin, '?stuck=1');
    assert.deepEqual(stuck.cards.map((c) => c.key), [key.E(), key.B(), key.C(), key.P()]);
    assert.deepEqual(stuck.steps.map((s) => s.count), [1, 1, 2], 'the columns count what is shown');
    assert.deepEqual(cardKeys(await board(admin, '?closed=1')), keys('A', 'B', 'C', 'W1', 'W2', 'W3', 'D', 'E', 'U', 'P'));
    const narrowed = await board(admin, '?sales_person=Sam%20Sales');
    assert.deepEqual(narrowed.funnel, { started: 3, quoted: 1, won: 0, with_po: 0 }, 'the funnel follows the owner too');
  });

  test('a funnel figure opens its cohort, closed sales included', async () => {
    const quoted = await board(admin, '?cohort=quoted');
    assert.deepEqual(cardKeys(quoted), keys('A', 'B', 'C', 'W1', 'W2', 'W3', 'P'));
    assert.equal(quoted.cards.length, quoted.funnel.quoted);
    assert.deepEqual(cardKeys(await board(admin, '?cohort=with_po')), keys('C', 'W2', 'P'));
    const { rows: [{ from }] } = await pool.query(`SELECT (CURRENT_DATE - 25)::text AS from`);
    // A began with its enquiry 20 days ago, W3 with its quotation 10 days ago; C and the rest began earlier.
    const recent = await board(admin, `?from=${from}&cohort=started`);
    assert.deepEqual(recent.funnel, { started: 4, quoted: 2, won: 0, with_po: 0 });
    assert.deepEqual(cardKeys(recent), keys('A', 'W3', 'D', 'U'));
  });

  test('anything malformed is a 422 naming the field', async () => {
    for (const [qs, field] of [['?from=2026-02-30', 'from'], ['?to=yesterday', 'to'], ['?cohort=everyone', 'cohort'], ['?stuck=yes', 'stuck'],
      ['?closed=2', 'closed'], ['?from=2026-10-10&to=2026-10-01', 'from'], ['?sales_person=a&sales_person=b', 'sales_person']]) {
      const res = await as(admin).get(`/api/journey${qs}`);
      assert.equal(res.status, 422, qs);
      assert.ok(res.body.error.fields[field], `${qs}: ${JSON.stringify(res.body.error)}`);
    }
    assert.equal((await board(admin, '?sales_person=&cohort=&stuck=')).cards.length, 8, 'an empty filter is no filter');
  });

  // -------------------------------------------------------------- one sale

  test('/of finds the sale by enquiry number, slashes and all', async () => {
    const res = await of(admin, `enquiry=${encodeURIComponent('CTZ/ENQ/2026/901')}`).expect(200);
    const j = res.body.data;
    assert.equal(j.key, key.A());
    assert.deepEqual(j.steps.map((s) => [s.key, s.state]), [['enquiry', 'done'], ['quotation', 'current'], ['po', 'future']]);
    assert.deepEqual(j.steps[0].record, { kind: 'enquiry', no: 'CTZ/ENQ/2026/901', date: (await pool.query('SELECT (CURRENT_DATE - 20)::text AS d')).rows[0].d });
    assert.deepEqual(j.steps[0].small.map((s) => s.state), ['done', 'done', 'current'], 'a done step keeps its small steps');
    assert.deepEqual(j.steps[0].facts.map((f) => f.label), ['Received', 'Source', 'Owner', 'Estimate', 'Status']);
    assert.deepEqual(j.steps[0].facts[3], { label: 'Estimate', value: 250000, kind: 'money', currency: 'INR' });
    assert.equal(j.steps[1].small.find((s) => s.state === 'current').label, 'Sent');
    assert.deepEqual(j.steps[2], { key: 'po', label: 'PO', state: 'future', record: null, since: null, small: [], facts: [], reachable: false });
  });

  test('/of by quotation number or id, and by either PO of a sale', async () => {
    assert.equal((await of(admin, 'quotation=Q-T-B').expect(200)).body.data.key, key.B());
    assert.equal((await of(admin, `quotation=${ids['Q-T-B']}`).expect(200)).body.data.key, key.B(), 'the id, when no quotation has that number');
    const c = (await of(admin, 'po=PO-T-C2').expect(200)).body.data;
    assert.equal(c.key, key.C());
    assert.deepEqual(c.steps[2].record.count, 2);
    assert.equal(c.steps[2].record.no, 'PO-T-C1', 'the rail names the first PO');
    assert.equal(c.steps[2].facts[0].value, 'PO-T-C1 +1 more');
  });

  test('/of by project: its won quotation first, else the sale of its PO', async () => {
    assert.equal((await of(admin, 'project=PRJ-T-W').expect(200)).body.data.key, key.W2(), 'won beats the newer open one');
    assert.equal((await of(admin, 'project=PRJ-T-C').expect(200)).body.data.key, key.C());
    assert.equal((await of(admin, 'project=PRJ-T-P').expect(200)).body.data.key, key.P());
  });

  test('/of answers 404 for a record no sale holds, and 422 unless exactly one record is named', async () => {
    for (const qs of ['po=PO-T-P1', 'po=PO-T-P3', 'po=PO-NOWHERE', 'quotation=Q-NOWHERE', 'project=PRJ-NOWHERE']) {
      assert.equal((await of(admin, qs)).status, 404, qs);
    }
    const none = await as(admin).get('/api/journey/of');
    assert.equal(none.status, 422);
    assert.deepEqual(Object.keys(none.body.error.fields).sort(), ['enquiry', 'po', 'project', 'quotation']);
    const two = await of(admin, 'quotation=Q-T-B&po=PO-T-C1');
    assert.equal(two.status, 422);
    assert.deepEqual(Object.keys(two.body.error.fields).sort(), ['po', 'quotation']);
    assert.equal((await of(admin, 'enquiry=')).status, 422, 'an empty number is not a number');
  });

  // ---------------------------------------------------------------- scope

  test('a salesperson sees a sale through its enquiry, its quotation or its project, and no one else\'s', async () => {
    assert.deepEqual(cardKeys(await board(sam, '?closed=1')), keys('A', 'B', 'C', 'E', 'U'));
    assert.deepEqual(cardKeys(await board(bea, '?closed=1')), keys('A', 'C', 'W1', 'W2', 'W3', 'D', 'P'));
    const mine = await board(sam);
    assert.deepEqual(mine.steps.map((s) => s.count), [1, 2, 1], 'the columns are counted over Sam\'s sales only');
    assert.equal(mine.funnel.started, 5);
  });

  test('/of refuses a sale the caller holds no record in, as if there were none', async () => {
    assert.equal((await of(sam, 'quotation=Q-T-A').expect(200)).body.data.key, key.A(), 'Sam owns its enquiry');
    assert.equal((await of(sam, 'project=PRJ-T-C').expect(200)).body.data.key, key.C(), 'Sam owns its project');
    const refused = await of(sam, `enquiry=${encodeURIComponent('CTZ/ENQ/2026/902')}`);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.error.message, (await of(sam, 'po=PO-NOWHERE')).body.error.message, 'a refusal reads like a miss');
    assert.equal((await of(bea, 'quotation=Q-T-B')).status, 404);
    assert.equal((await of(sam, 'project=PRJ-T-W')).status, 404, 'an unowned project is nobody\'s');
  });

  test('a salesperson sees the facts and value only of the records they own; the rest by number', async () => {
    // Sam owns Q-T-A's enquiry; Bea owns the quotation.
    const a = (await of(sam, 'quotation=Q-T-A').expect(200)).body.data;
    assert.deepEqual(a.steps.map((s) => [s.key, s.reachable, s.facts.length > 0]), [['enquiry', true, true], ['quotation', false, false], ['po', false, false]]);
    assert.equal(a.steps[1].record.no, 'Q-T-A');
    assert.deepEqual([a.value, a.value_inr], [null, null]);
    const card = (await board(sam)).cards.find((c) => c.key === key.A());
    assert.deepEqual([card.step, card.value, card.value_inr], ['quotation', null, null]);
    const own = (await of(bea, 'quotation=Q-T-A').expect(200)).body.data;
    assert.deepEqual(own.steps.map((s) => s.reachable), [false, true, false], 'Bea does not own the enquiry');
    assert.equal(own.value, 300000);
    assert.ok((await of(admin, 'quotation=Q-T-A').expect(200)).body.data.steps.slice(0, 2).every((s) => s.reachable && s.facts.length));
  });

  test('a PO opens as its own page opens: by the quotation it names or its project, not by the sale\'s quotation', async () => {
    // PO-T-W1 names no quotation and sits on PRJ-T-W, which nobody owns; the
    // journey joins it to Bea's won Q-T-W2, but its own page refuses her.
    await as(bea).get('/api/purchase-orders/PO-T-W1').expect(404);
    const w2 = (await of(bea, 'quotation=Q-T-W2').expect(200)).body.data;
    assert.equal(w2.step, 'po');
    assert.deepEqual([w2.steps[1].reachable, w2.steps[2].reachable, w2.steps[2].facts], [true, false, []]);
    assert.deepEqual([w2.value, w2.value_hidden, w2.next], [null, true, null]);
    assert.equal(w2.steps[2].record.no, 'PO-T-W1', 'the number still shows');
    // Sam owns PRJ-T-C, and both POs of Q-T-C name that quotation and sit on it.
    await as(sam).get('/api/purchase-orders/PO-T-C1').expect(200);
    const c = (await of(sam, 'quotation=Q-T-C').expect(200)).body.data;
    assert.equal(c.steps[2].reachable, true);
    assert.ok(c.steps[2].facts.length > 0);
    assert.equal((await of(admin, 'quotation=Q-T-W2').expect(200)).body.data.steps[2].reachable, true);
  });

  test('HR is refused both routes', async () => {
    assert.equal((await as(hema).get('/api/journey')).status, 403);
    assert.equal((await of(hema, 'quotation=Q-T-B')).status, 403);
  });

  // ------------------------------------------------------------- settings

  test('a changed setting changes a flag, with no deploy; a blank one falls back', async () => {
    const flagOfD = async () => (await board(admin)).cards.find((c) => c.key === key.D()).flag;
    assert.equal(await flagOfD(), null, 'five days on a seven-day limit');

    await as(admin).patch('/api/settings/journey_stuck_enquiry_days', { value: '2' }).expect(200);
    assert.deepEqual(await flagOfD(), { kind: 'stuck', label: 'Stuck 5 days', tone: 'late' });
    await as(admin).patch('/api/settings/journey_stuck_enquiry_days', { value: '3' }).expect(200);
    assert.deepEqual(await flagOfD(), { kind: 'slow', label: 'Slow 5 days', tone: 'waiting' });
    assert.equal((await board(admin)).settings.enquiry_days, 3);

    await pool.query(`UPDATE settings SET value = '' WHERE key = 'journey_stuck_enquiry_days'`);
    assert.equal((await board(admin)).settings.enquiry_days, 7, 'blank is the default, not zero');
    await pool.query(`DELETE FROM settings WHERE key = 'journey_stuck_enquiry_days'`);
    assert.equal(await flagOfD(), null, 'a missing row is the default too');
    await pool.query(`INSERT INTO settings (key, value) VALUES ('journey_stuck_enquiry_days', '7')`);
  });
});
