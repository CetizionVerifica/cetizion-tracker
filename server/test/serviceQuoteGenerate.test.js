import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';
import request from 'supertest';

/**
 * Generating a quotation from a submitted questionnaire (#208 phase 2,
 * module CLAUDE.md §4), end to end against a throwaway database with real
 * sign-ins. Every company, person and rate is made up. Needs
 * TEST_DATABASE_URL (CI sets it).
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const NAME = `quote_generate_${process.pid}`;
const PASSWORD = 'a-good-long-test-password';

const FORM = {
  steps: [
    { key: 'organisation', title: 'Your organisation', questions: [
      { key: 'employee_count', type: 'number', label: 'Employees in scope', required: true, integer: true, min: 1 },
      { key: 'previously_certified', type: 'yesno', label: 'Certified before?', required: true },
      { key: 'sites', type: 'table', label: 'Sites', required: true, columns: [{ key: 'city', type: 'text', label: 'City', required: true }] },
    ] },
  ],
};
const PRICING = { lines: [
  { key: 'audit', description: 'Certification audit', qty: { band: { of: { answer: 'employee_count' }, bands: [[1, 45, 3], [46, 125, 5], [126, 425, 7]] } },
    rate: { catalogue: true }, multiply: [{ rows: 'sites' }], unit: 'man-day', sort_order: 10 },
  { key: 'stage1', description: 'Stage 1 review', include_if: { key: 'previously_certified', op: 'eq', value: false }, rate: { fixed: 15000 }, sort_order: 20 },
] };
const ANSWERS = { employee_count: 120, previously_certified: false, sites: [{ city: 'Pune' }] };

let app; let pool; let admin; let sam; let bea; let serviceId; let formId; let emptyFormId; let usdFormId; let today;
let ecoServiceId; let ecoFormId; let ecoFormAgainId;
/** A second service on the same enquiry (D12): a fixed assessment, and a per-site line only small clients fit. */
const ECO_PRICING = { lines: [
  { key: 'assessment', description: 'Ecovadis assessment', rate: { fixed: 60000 }, sort_order: 50 },
  { key: 'site_review', description: 'Site review', qty: { band: { of: { answer: 'employee_count' }, bands: [[1, 50, 1]] } }, rate: { fixed: 5000 }, sort_order: 60 },
] };
/** The same pricing on a rate card kept in dollars: the catalogue's 300, and 100 for Stage 1. */
const USD_PRICING = { lines: [PRICING.lines[0], { ...PRICING.lines[1], rate: { fixed: 100 } }] };

describe('generating a quotation from questionnaire answers', { skip: !ADMIN_URL && 'TEST_DATABASE_URL is not set' }, () => {
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
    const { createUser } = await import('../src/lib/users.js');
    const mk = async (name, email, role) => {
      const u = await createUser({ name, email, role, password: PASSWORD }, pool);
      const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return { ...u, email, cookie: res.headers['set-cookie'] };
    };
    admin = await mk('Ada Admin', 'ada@cetizion.example', 'admin');
    sam = await mk('Sam Sales', 'sam@cetizion.example', 'sales');
    bea = await mk('Bea Sales', 'bea@cetizion.example', 'sales');

    ({ rows: [{ id: serviceId }] } = await pool.query(
      `INSERT INTO services (name, default_rate, currency, unit, gst_rate) VALUES ('Example certification', 25000, 'INR', 'engagement', 18) RETURNING id`));
    await pool.query(`INSERT INTO companies (id, name) VALUES (7001, 'Example Industries'), (7002, 'Sample Metals')`);

    // A published questionnaire with pricing, and one without.
    const as = (who) => ({ post: (p, b) => request(app).post(p).set('Cookie', who.cookie).send(b), patch: (p, b) => request(app).patch(p).set('Cookie', who.cookie).send(b) });
    const { rows: [{ id: usdServiceId }] } = await pool.query(
      `INSERT INTO services (name, default_rate, currency, unit, gst_rate) VALUES ('Example overseas review', 300, 'USD', 'engagement', 18) RETURNING id`);
    ({ rows: [{ id: ecoServiceId }] } = await pool.query(
      `INSERT INTO services (name, default_rate, currency, unit, gst_rate) VALUES ('Example sustainability rating', 60000, 'INR', 'engagement', 18) RETURNING id`));
    for (const [name, pricing, set, svc] of [
      ['Priced', PRICING, (id) => { formId = id; }, serviceId],
      ['Unpriced', { lines: [] }, (id) => { emptyFormId = id; }, serviceId],
      ['Priced in dollars', USD_PRICING, (id) => { usdFormId = id; }, usdServiceId],
      ['Ecovadis', ECO_PRICING, (id) => { ecoFormId = id; }, ecoServiceId],
      ['Ecovadis, second form', ECO_PRICING, (id) => { ecoFormAgainId = id; }, ecoServiceId],
    ]) {
      const made = await as(admin).post('/api/questionnaires', { service_id: svc, name }).expect(201);
      const v = made.body.data.versions[0];
      await as(admin).patch(`/api/questionnaire-versions/${v.id}`, { definition: FORM, pricing }).expect(200);
      await as(admin).post(`/api/questionnaire-versions/${v.id}/publish`).expect(200);
      set(made.body.data.id);
    }

    // Exchange rates as the ECB job and a person leave them: rupees for one unit, dated relative to today.
    ({ businessToday: today } = await import('../src/lib/businessDate.ts'));
    today = today();
    await pool.query(`
      INSERT INTO exchange_rates (from_currency, rate, effective_from, source) VALUES
        ('USD', 70,    $1::date - 30, 'feed'),     -- older: not the newest
        ('USD', 83.5,  $1::date - 1,  'feed'),     -- the newest on or before today
        ('USD', 999,   $1::date + 5,  'feed'),     -- dated ahead: not yet in force
        ('EUR', 90,    $1::date - 1,  'manual'),   -- typed in by a person
        ('SGD', 61,    $1::date - 20, 'feed')      -- stale: weeks old
      -- GBP: none at all`, [today]);
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
    post: (p, b) => request(app).post(p).set('Cookie', who.cookie).send(b),
    patch: (p, b) => request(app).patch(p).set('Cookie', who.cookie).send(b),
  });
  const generate = (who, id, mode) => as(who).post(`/api/questionnaire-responses/${id}/quotation`, { mode });

  /** An enquiry of `owner`'s, and a questionnaire sent from it and submitted with `answers`. */
  let n = 0;
  async function submitted(owner, { answers = ANSWERS, currency = 'INR', form = formId, submit = true } = {}) {
    n += 1;
    const enquiryNo = `ENQ-G${n}`;
    await pool.query(
      `INSERT INTO enquiries (enquiry_no, client_name, company_id, contact_person, owner_user_id, status, currency, service, estimated_value, source_id)
       VALUES ($1, 'Example Industries', 7001, 'Asha Example', $2, 'Qualified', $3, 'Example certification', 100000, (SELECT id FROM lead_sources ORDER BY sort_order LIMIT 1))`,
      [enquiryNo, owner.id, currency]);
    const sent = await as(owner).post('/api/questionnaire-responses', { enquiry_no: enquiryNo, questionnaire_id: form, send_email: false }).expect(201);
    const id = sent.body.data.id;
    if (submit) {
      await pool.query(`UPDATE questionnaire_responses SET answers = $2, status = 'submitted', submitted_at = now() WHERE id = $1`, [id, JSON.stringify(answers)]);
    }
    return { id, enquiryNo };
  }
  const quotationOf = async (enquiryNo) => {
    const { rows: [e] } = await pool.query('SELECT id, quotation_no FROM enquiries WHERE enquiry_no = $1', [enquiryNo]);
    if (!e.quotation_no) return null;
    const { rows: [q] } = await pool.query('SELECT * FROM v_quotations WHERE quotation_no = $1', [e.quotation_no]);
    const { rows: lines } = await pool.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
    return { e, q, lines };
  };
  const quotationCount = async () => Number((await pool.query('SELECT count(*) FROM quotations')).rows[0].count);

  test('new: a Draft priced from the answers, owned as the enquiry is, named on the enquiry, and logged', async () => {
    const { id, enquiryNo } = await submitted(sam);
    const res = await generate(sam, id, 'new').expect(201);
    assert.deepEqual(res.body.data, { quotation_no: res.body.data.quotation_no, mode: 'new', revision: 0, lines: 2, price_needed_count: 0 });

    const { e, q, lines } = await quotationOf(enquiryNo);
    assert.equal(e.quotation_no, res.body.data.quotation_no, 'the enquiry names it, so marking the enquiry won makes nothing more');
    assert.equal(q.status, 'Draft');
    assert.equal(q.owner_user_id, sam.id);
    assert.equal(q.currency, 'INR');
    assert.equal(q.service_quoted, 'Example certification');
    assert.equal(q.remarks, `From the questionnaire answers on enquiry ${enquiryNo}`);
    assert.equal(q.questionnaire_response_id, id);
    assert.ok(q.generated_at);
    assert.equal(q.price_needed_count, 0);
    assert.equal(q.edited_since_generated, false);
    // 120 employees → 5 man-days × 1 site at the catalogue's 25,000; not certified → Stage 1 at 15,000.
    assert.deepEqual(lines.map((l) => [l.rule_key, l.description, Number(l.qty), Number(l.rate), l.unit, l.generated, l.price_needed, l.service_id]), [
      ['audit', 'Certification audit', 5, 25000, 'man-day', true, false, serviceId],
      ['stage1', 'Stage 1 review', 1, 15000, 'engagement', true, false, serviceId],
    ]);
    assert.equal(Number(q.subtotal), 140000);
    assert.equal(Number(q.total), 165200, '18% GST');

    const { rows: acts } = await pool.query(
      `SELECT metadata FROM activity_log WHERE entity_type = 'quotation' AND entity_id = $1 AND metadata->>'event' = 'generated_from_answers'`, [q.quotation_no]);
    assert.equal(acts.length, 1);
    assert.equal(acts[0].metadata.mode, 'new');
    assert.equal(acts[0].metadata.response_id, id);
    assert.equal(acts[0].metadata.lines, 2);

    // Marking the enquiry won afterwards creates no second quotation (spec C7).
    const before = await quotationCount();
    await as(sam).patch(`/api/enquiries/${enquiryNo}`, { status: 'Converted' }).expect(200);
    assert.equal(await quotationCount(), before);
    assert.equal((await quotationOf(enquiryNo)).e.quotation_no, q.quotation_no);

    // Asking for "new" again is refused: it already has one.
    const again = await generate(sam, id, 'new');
    assert.equal(again.status, 422);
    assert.match(again.body.error.message, /already has .*generate again to revise it/);
  });

  test('revise: the current version is kept, generated lines are replaced, and lines a person added stay', async () => {
    const { id, enquiryNo } = await submitted(sam);
    await generate(sam, id, 'new').expect(201);
    const first = await quotationOf(enquiryNo);
    await pool.query(`INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate, sort_order) VALUES ($1, 'Travel, agreed on the call', 1, 8000, 18, 30)`, [first.q.id]);
    // The client's answers change (reopened and submitted again): 300 employees, certified before.
    await pool.query(`UPDATE questionnaire_responses SET answers = $2 WHERE id = $1`, [id, JSON.stringify({ ...ANSWERS, employee_count: 300, previously_certified: true })]);

    const res = await generate(sam, id, 'revise').expect(200);
    assert.equal(res.body.data.mode, 'revise');
    assert.equal(res.body.data.revision, 1);
    assert.equal(res.body.data.lines, 1, 'certified before: no Stage 1');
    const now = await quotationOf(enquiryNo);
    assert.equal(now.q.quotation_no, first.q.quotation_no, 'the same quotation, revised');
    assert.equal(now.q.revision, 1);
    assert.deepEqual(now.lines.map((l) => [l.rule_key, l.description, Number(l.qty), Number(l.rate), l.generated]), [
      ['audit', 'Certification audit', 7, 25000, true],
      [null, 'Travel, agreed on the call', 1, 8000, false],
    ]);
    const { rows: revs } = await pool.query('SELECT revision, note, snapshot FROM quotation_revisions WHERE quotation_id = $1', [now.q.id]);
    assert.equal(revs.length, 1);
    assert.equal(revs[0].note, 'Generated from the Example certification questionnaire answers');
    assert.deepEqual(revs[0].snapshot.lines.map((l) => [l.description, l.generated]), [
      ['Certification audit', true], ['Stage 1 review', true], ['Travel, agreed on the call', false],
    ], 'the history keeps every line as it was, the hand-added one too');
  });

  test('revise: a quotation already sent goes back to Draft, as any revision does', async () => {
    const { id, enquiryNo } = await submitted(sam);
    await generate(sam, id, 'new').expect(201);
    const { q } = await quotationOf(enquiryNo);
    await pool.query(`UPDATE quotations SET status = 'Submitted', sent_at = now() WHERE id = $1`, [q.id]);
    await generate(sam, id, 'revise').expect(200);
    const now = await quotationOf(enquiryNo);
    assert.equal(now.q.status, 'Draft');
    assert.equal(now.q.sent_at, null);
  });

  test('a line the rules cannot price is kept at rate 0 with Price needed, and entering a rate clears it', async () => {
    const { id, enquiryNo } = await submitted(sam, { answers: { ...ANSWERS, employee_count: 5000 } });
    const res = await generate(sam, id, 'new').expect(201);
    assert.equal(res.body.data.price_needed_count, 1);
    const { q, lines } = await quotationOf(enquiryNo);
    const audit = lines.find((l) => l.rule_key === 'audit');
    assert.deepEqual([Number(audit.qty), Number(audit.rate), audit.price_needed], [1, 0, true]);
    assert.equal(q.price_needed_count, 1);
    await as(sam).patch(`/api/quotation-lines/${audit.id}`, { rate: 30000 }).expect(200);
    const after = await quotationOf(enquiryNo);
    assert.equal(after.lines.find((l) => l.id === audit.id).price_needed, false);
    assert.equal(after.q.price_needed_count, 0);
    assert.equal(after.q.edited_since_generated, true);
  });

  for (const [status, message] of [
    ['Won - PO Received', /is won; a won quotation is not regenerated/],
    ['Lost', /is lost; a lost quotation is not regenerated/],
    ['Under Negotiation', /is Under Negotiation\. Generating only revises a Draft or Submitted quotation/],
    ['On Hold', /is On Hold\. Generating only revises a Draft or Submitted quotation/],
  ]) {
    test(`a quotation ${status} is refused with 422, and nothing is written`, async () => {
      const { id, enquiryNo } = await submitted(sam);
      await generate(sam, id, 'new').expect(201);
      const { q } = await quotationOf(enquiryNo);
      await pool.query(`UPDATE quotations SET status = $2 WHERE id = $1`, [q.id, status]);
      const before = await quotationOf(enquiryNo);
      for (const mode of ['revise', 'new']) {
        const res = await generate(sam, id, mode);
        assert.equal(res.status, 422, mode);
        assert.match(res.body.error.message, message, mode);
      }
      const after = await quotationOf(enquiryNo);
      assert.equal(after.q.revision, before.q.revision);
      assert.deepEqual(after.lines.map((l) => l.id), before.lines.map((l) => l.id));
    });
  }

  // ── Currency: the rate card's currency into the quotation's, through INR (fx.ts, exchange_rates) ──

  const exchangeLogged = async (quotationNo) => (await pool.query(
    `SELECT metadata->'exchange' AS x FROM activity_log WHERE entity_id = $1 AND metadata->>'event' = 'generated_from_answers' ORDER BY id DESC LIMIT 1`, [quotationNo])).rows[0].x;
  const dayBefore = async (n) => (await pool.query(`SELECT ($1::date - $2::int)::text AS d`, [today, n])).rows[0].d;

  test('an INR rate card priced into USD: the newest rate on or before today, fixed on the line, and logged', async () => {
    const { id, enquiryNo } = await submitted(sam, { currency: 'USD' });
    const res = await generate(sam, id, 'new').expect(201);
    assert.equal(res.body.data.price_needed_count, 0);
    const { q, lines } = await quotationOf(enquiryNo);
    assert.equal(q.currency, 'USD');
    // 25,000 / 83.5 = 299.40 and 15,000 / 83.5 = 179.64: not 70 (older) and not 999 (dated ahead).
    assert.deepEqual(lines.map((l) => [l.rule_key, Number(l.qty), Number(l.rate), l.price_needed]), [['audit', 5, 299.4, false], ['stage1', 1, 179.64, false]]);
    assert.deepEqual(await exchangeLogged(q.quotation_no), {
      from: 'INR', to: 'USD', via: 'INR', as_of: today, factor: Number((1 / 83.5).toFixed(8)),
      rates: [{ currency: 'USD', inr_per_unit: 83.5, effective_from: await dayBefore(1), source: 'feed' }],
    });

    // A later rate changes nothing already quoted: the converted figure is the line's own.
    await pool.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from, source) VALUES ('USD', 100, $1::date, 'feed')`, [today]);
    assert.deepEqual((await quotationOf(enquiryNo)).lines.map((l) => Number(l.rate)), [299.4, 179.64]);
    await pool.query(`DELETE FROM exchange_rates WHERE from_currency = 'USD' AND effective_from = $1::date`, [today]);
  });

  test('a USD rate card priced into INR, and into EUR through INR', async () => {
    const inr = await submitted(sam, { form: usdFormId, currency: 'INR' });
    await generate(sam, inr.id, 'new').expect(201);
    const toInr = await quotationOf(inr.enquiryNo);
    // 300 × 83.5 = 25,050 and 100 × 83.5 = 8,350.
    assert.deepEqual(toInr.lines.map((l) => Number(l.rate)), [25050, 8350]);
    const xInr = await exchangeLogged(toInr.q.quotation_no);
    assert.deepEqual([xInr.from, xInr.to, xInr.factor, xInr.rates.map((r) => r.currency)], ['USD', 'INR', 83.5, ['USD']]);

    const eur = await submitted(sam, { form: usdFormId, currency: 'EUR' });
    await generate(sam, eur.id, 'new').expect(201);
    const toEur = await quotationOf(eur.enquiryNo);
    // 83.5 / 90 = 0.927777…: 300 → 278.33, 100 → 92.78.
    assert.deepEqual(toEur.lines.map((l) => Number(l.rate)), [278.33, 92.78]);
    const xEur = await exchangeLogged(toEur.q.quotation_no);
    assert.equal(xEur.factor, Number((83.5 / 90).toFixed(8)));
    assert.deepEqual(xEur.rates, [
      { currency: 'USD', inr_per_unit: 83.5, effective_from: await dayBefore(1), source: 'feed' },
      { currency: 'EUR', inr_per_unit: 90, effective_from: await dayBefore(1), source: 'manual' },
    ]);
  });

  test('no rate for the quotation\'s currency: every line needs a price, saying so, and nothing is guessed', async () => {
    const { id, enquiryNo } = await submitted(sam, { currency: 'GBP' });
    const res = await generate(sam, id, 'new').expect(201);
    assert.equal(res.body.data.price_needed_count, 2);
    const { q, lines } = await quotationOf(enquiryNo);
    assert.equal(q.currency, 'GBP', 'still in the client\'s currency, never quietly in rupees');
    assert.deepEqual(lines.map((l) => [Number(l.qty), Number(l.rate), l.price_needed]), [[1, 0, true], [1, 0, true]]);
    const x = await exchangeLogged(q.quotation_no);
    assert.deepEqual(x.rates, []);
    assert.match(x.unavailable, /^no exchange rate for GBP on or before .* to convert the INR rate card into GBP$/);
    assert.equal(x.factor, undefined);
  });

  test('a stale rate is not used: every line needs a price, naming how old the rate is', async () => {
    const { id, enquiryNo } = await submitted(sam, { currency: 'SGD' });
    const res = await generate(sam, id, 'new').expect(201);
    assert.equal(res.body.data.price_needed_count, 2);
    const { q, lines } = await quotationOf(enquiryNo);
    assert.ok(lines.every((l) => l.price_needed && Number(l.rate) === 0));
    const x = await exchangeLogged(q.quotation_no);
    assert.deepEqual(x.rates, [{ currency: 'SGD', inr_per_unit: 61, effective_from: await dayBefore(20), source: 'feed' }]);
    assert.match(x.unavailable, /^the newest SGD exchange rate is from .*, more than 4 publishing days before /);
  });

  test('the same currency needs no conversion, and none is logged', async () => {
    const { id, enquiryNo } = await submitted(sam);
    await generate(sam, id, 'new').expect(201);
    assert.equal(await exchangeLogged((await quotationOf(enquiryNo)).q.quotation_no), null);
  });

  test('refused: not submitted, no longer on an enquiry, no pricing rules, nothing to revise, a mode that is not one', async () => {
    const draft = await submitted(sam, { submit: false });
    assert.match((await generate(sam, draft.id, 'new')).body.error.message, /not submitted this questionnaire yet/);

    const orphan = await submitted(sam);
    await pool.query('UPDATE questionnaire_responses SET enquiry_id = NULL, requested_by_user_id = $2 WHERE id = $1', [orphan.id, sam.id]);
    const gone = await generate(sam, orphan.id, 'new');
    assert.equal(gone.status, 422);
    assert.equal(gone.body.error.message, 'This questionnaire is no longer linked to an enquiry');

    const unpriced = await submitted(sam, { form: emptyFormId });
    assert.match((await generate(sam, unpriced.id, 'new')).body.error.message, /no pricing rules yet/);

    const fresh = await submitted(sam);
    const nothing = await generate(sam, fresh.id, 'revise');
    assert.equal(nothing.status, 422);
    assert.match(nothing.body.error.message, /has no quotation to revise; generate a new one/);
    assert.equal((await generate(sam, fresh.id, 'replace')).status, 422);
    assert.equal((await as(sam).post(`/api/questionnaire-responses/${fresh.id}/quotation`, {})).status, 422);
    assert.equal(await quotationOf(fresh.enquiryNo), null, 'none of these wrote anything');
  });

  test('a salesperson reaches only the responses on their own enquiries; an admin reaches any', async () => {
    const { id, enquiryNo } = await submitted(bea);
    assert.equal((await generate(sam, id, 'new')).status, 404, 'the same 404 as one that does not exist');
    assert.equal((await generate(sam, 999999, 'new')).status, 404);
    assert.equal(await quotationOf(enquiryNo), null);
    const res = await generate(admin, id, 'new').expect(201);
    assert.equal((await quotationOf(enquiryNo)).q.owner_user_id, bea.id, 'still the enquiry owner\'s, not the admin\'s');
    assert.equal(res.body.data.mode, 'new');
  });

  // ── Part 4: nothing goes to the client while a line needs a price; why, worked out on read ──

  const full = (who, no) => as(who).get(`/api/quotations/${encodeURIComponent(no)}/full`);
  const send = (who, no) => as(who).post(`/api/quotations/${encodeURIComponent(no)}/send`, {});
  const link = (who, no) => as(who).post(`/api/quotations/${encodeURIComponent(no)}/acceptance-link`, {});

  test('the quotation says where it came from, how many lines need a price, and why each does', async () => {
    const { id, enquiryNo } = await submitted(sam, { answers: { ...ANSWERS, employee_count: 5000 } });
    await generate(sam, id, 'new').expect(201);
    const { q } = await quotationOf(enquiryNo);
    const res = await full(sam, q.quotation_no).expect(200);
    const d = res.body.data;
    assert.equal(d.questionnaire_response_id, id);
    assert.ok(d.generated_at);
    assert.equal(d.price_needed_count, 1);
    assert.equal(d.edited_since_generated, false);
    const audit = d.lines.find((l) => l.rule_key === 'audit');
    const stage1 = d.lines.find((l) => l.rule_key === 'stage1');
    assert.equal(audit.price_needed, true);
    assert.equal(audit.price_needed_reason, '"employee_count" is 5000, outside every band');
    assert.equal(stage1.price_needed, false);
    assert.equal('price_needed_reason' in stage1, false, 'only flagged lines carry a reason');
    // Not stored anywhere: the line row has no such column.
    const { rows: cols } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'quotation_lines' AND column_name LIKE '%reason%'`);
    assert.deepEqual(cols, []);
  });

  test('send and the acceptance link are refused while a line needs a price, and work once it has one', async () => {
    const { id, enquiryNo } = await submitted(sam, { answers: { ...ANSWERS, employee_count: 5000 } });
    await generate(sam, id, 'new').expect(201);
    const { q, lines } = await quotationOf(enquiryNo);

    for (const attempt of [send, link]) {
      const res = await attempt(sam, q.quotation_no);
      assert.equal(res.status, 422);
      assert.equal(res.body.error.message, '1 line needs a price before this can go to the client');
    }
    const after = await quotationOf(enquiryNo);
    assert.equal(after.q.sent_at, null, 'not sent');
    const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM quotation_acceptances WHERE quotation_id = $1', [q.id]);
    assert.equal(n, 0, 'no acceptance link made');

    // A person enters the rate: the flag clears itself, and sending goes through.
    const audit = lines.find((l) => l.rule_key === 'audit');
    await as(sam).patch(`/api/quotation-lines/${audit.id}`, { rate: 30000 }).expect(200);
    await send(sam, q.quotation_no).expect(200);
    const sent = await quotationOf(enquiryNo);
    assert.ok(sent.q.sent_at);
    assert.equal(sent.q.status, 'Submitted');
  });

  test('several unpriced lines are counted in the refusal', async () => {
    const { id, enquiryNo } = await submitted(sam, { currency: 'GBP' });
    await generate(sam, id, 'new').expect(201);
    const { q } = await quotationOf(enquiryNo);
    assert.equal((await send(sam, q.quotation_no)).body.error.message, '2 lines need a price before this can go to the client');
  });

  test('a currency reason stays as it was at generation, even when a rate arrives afterwards for that day', async () => {
    const { id, enquiryNo } = await submitted(sam, { currency: 'GBP' });
    await generate(sam, id, 'new').expect(201);
    const { q } = await quotationOf(enquiryNo);
    const reasonsOf = async () => (await full(sam, q.quotation_no).expect(200)).body.data.lines.map((l) => l.price_needed_reason);
    const before = await reasonsOf();
    assert.ok(before.every((r) => /^no exchange rate for GBP on or before .* to convert the INR rate card into GBP$/.test(r)), JSON.stringify(before));

    await pool.query(`INSERT INTO exchange_rates (from_currency, rate, effective_from, source) VALUES ('GBP', 105, $1::date, 'feed')`, [today]);
    try {
      assert.deepEqual(await reasonsOf(), before, 'the reason is the one it had, not today\'s');
      assert.ok((await quotationOf(enquiryNo)).lines.every((l) => Number(l.rate) === 0), 'and nothing was repriced by it');
    } finally {
      await pool.query(`DELETE FROM exchange_rates WHERE from_currency = 'GBP'`);
    }
  });

  test('when the answers have changed since, a flagged line says only what is known', async () => {
    const { id, enquiryNo } = await submitted(sam, { answers: { ...ANSWERS, employee_count: 5000 } });
    await generate(sam, id, 'new').expect(201);
    const { q } = await quotationOf(enquiryNo);
    await pool.query(`UPDATE questionnaire_responses SET answers = $2 WHERE id = $1`, [id, JSON.stringify(ANSWERS)]);
    const audit = (await full(sam, q.quotation_no).expect(200)).body.data.lines.find((l) => l.rule_key === 'audit');
    assert.equal(audit.price_needed, true);
    assert.equal(audit.price_needed_reason, 'the pricing rules could not price this line when it was generated');
  });

  test('a quotation typed by hand is not affected: no reasons to work out, and send is not held', async () => {
    const { rows: [q] } = await pool.query(
      `INSERT INTO quotations (quotation_no, client_name, status, owner_user_id) VALUES ('Q-BY-HAND', 'Sample Metals', 'Draft', $1) RETURNING id`, [sam.id]);
    await pool.query(`INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate) VALUES ($1, 'Consulting', 1, 20000, 18)`, [q.id]);
    const d = (await full(sam, 'Q-BY-HAND').expect(200)).body.data;
    assert.equal(d.price_needed_count, 0);
    assert.equal(d.questionnaire_response_id, null);
    assert.equal(d.generated_at, null);
    assert.equal(d.edited_since_generated, false);
    assert.equal('price_needed_reason' in d.lines[0], false);
    await send(sam, 'Q-BY-HAND').expect(200);
  });

  // ── Review fixes (R1–R4) ──

  /** A published questionnaire on the INR service with these pricing rules. */
  let extra = 0;
  async function publish(pricing) {
    extra += 1;
    const made = await as(admin).post('/api/questionnaires', { service_id: serviceId, name: `Review form ${extra}` }).expect(201);
    const v = made.body.data.versions[0];
    await as(admin).patch(`/api/questionnaire-versions/${v.id}`, { definition: FORM, pricing }).expect(200);
    await as(admin).post(`/api/questionnaire-versions/${v.id}/publish`).expect(200);
    return made.body.data.id;
  }

  test('R1: lines that each fit a quotation line but together exceed its totals are refused with 422, before anything is written', async () => {
    // 9 × 10^13 each: within a line (qty 1,000 × rate 9 × 10^10), beyond numeric(16,2) together or with GST.
    const big = { key: 'a', description: 'A', qty: { fixed: 1000 }, rate: { fixed: 90_000_000_000 } };
    for (const pricing of [{ lines: [big, { ...big, key: 'b' }] }, { lines: [big] }]) {
      const before = await quotationCount();
      const { id, enquiryNo } = await submitted(sam, { form: await publish(pricing) });
      const res = await generate(sam, id, 'new');
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.match(res.body.error.message, /^These lines come to .* with GST, more than a quotation can hold \(9,99,99,99,99,99,999\.99\)\./);
      assert.equal(await quotationCount(), before);
      assert.equal(await quotationOf(enquiryNo), null, 'nothing written');
    }
  });

  test('R1: on a revision, the lines a person added count towards the totals too', async () => {
    const { id, enquiryNo } = await submitted(sam);
    await generate(sam, id, 'new').expect(201);
    const { q } = await quotationOf(enquiryNo);
    // A hand line at the very top of a quotation's range (no GST), which the 1,65,200 of generated lines then tips over.
    // The generated lines go first, or this line's own totals would not fit.
    await pool.query(`DELETE FROM quotation_lines WHERE quotation_id = $1 AND generated`, [q.id]);
    await pool.query(`INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate, sort_order) VALUES ($1, 'Framework fee', 1000, 99999999999.99, 0, 50)`, [q.id]);
    const before = await quotationOf(enquiryNo);
    const res = await generate(sam, id, 'revise');
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /more than a quotation can hold/);
    const after = await quotationOf(enquiryNo);
    assert.equal(after.q.revision, before.q.revision, 'not revised');
    assert.deepEqual(after.lines.map((l) => l.id), before.lines.map((l) => l.id), 'lines untouched');
  });

  test('R2: a rule\'s own SAC code is kept on its line; other lines fall back to the service\'s', async () => {
    await pool.query(`UPDATE services SET sac_code = '998311' WHERE id = $1`, [serviceId]);
    try {
      const form = await publish({ lines: [
        { ...PRICING.lines[0], sac_code: '998399' },
        PRICING.lines[1],                                   // no sac_code: the service's
      ] });
      const { id, enquiryNo } = await submitted(sam, { form });
      await generate(sam, id, 'new').expect(201);
      const { q, lines } = await quotationOf(enquiryNo);
      assert.deepEqual(lines.map((l) => [l.rule_key, l.sac_code]), [['audit', '998399'], ['stage1', null]], 'only the rule\'s own is stored');
      await pool.query(`INSERT INTO quotation_lines (quotation_id, service_id, description, qty, rate, gst_rate, sort_order) VALUES ($1, $2, 'Hand line on the service', 1, 100, 18, 40), ($1, NULL, 'Hand line, no service', 1, 100, 18, 41)`, [q.id, serviceId]);

      const d = (await full(sam, q.quotation_no).expect(200)).body.data;
      assert.deepEqual(d.lines.map((l) => [l.description, l.sac_code]), [
        ['Certification audit', '998399'],
        ['Stage 1 review', '998311'],
        ['Hand line on the service', '998311'],
        ['Hand line, no service', null],
      ]);
      // The PDF prints what fullQuotation gives it.
      const { quotationDocument } = await import('../src/lib/quotationPdf.js');
      const doc = JSON.stringify(quotationDocument(d));
      assert.ok(doc.includes('SAC 998399') && doc.includes('SAC 998311'));
    } finally {
      await pool.query(`UPDATE services SET sac_code = NULL WHERE id = $1`, [serviceId]);
    }
  });

  test('R2: a quotation typed by hand reads its SAC codes exactly as before', async () => {
    await pool.query(`UPDATE services SET sac_code = '998311' WHERE id = $1`, [serviceId]);
    try {
      const { rows: [q] } = await pool.query(`INSERT INTO quotations (quotation_no, client_name, status, owner_user_id) VALUES ('Q-SAC-HAND', 'Sample Metals', 'Draft', $1) RETURNING id`, [sam.id]);
      await pool.query(`INSERT INTO quotation_lines (quotation_id, service_id, description, qty, rate, gst_rate) VALUES ($1, $2, 'On the service', 1, 100, 18), ($1, NULL, 'Free text', 1, 100, 18)`, [q.id, serviceId]);
      const d = (await full(sam, 'Q-SAC-HAND').expect(200)).body.data;
      assert.deepEqual(d.lines.map((l) => l.sac_code), ['998311', null]);
    } finally {
      await pool.query(`UPDATE services SET sac_code = NULL WHERE id = $1`, [serviceId]);
    }
  });

  // ── D12: one quotation per enquiry; each service's questionnaire contributes its own generated lines ──

  /** Another questionnaire sent from the same enquiry, and submitted. */
  async function alsoSent(enquiryNo, form, answers = ANSWERS) {
    const sent = await as(sam).post('/api/questionnaire-responses', { enquiry_no: enquiryNo, questionnaire_id: form, send_email: false }).expect(201);
    await pool.query(`UPDATE questionnaire_responses SET answers = $2, status = 'submitted', submitted_at = now() WHERE id = $1`, [sent.body.data.id, JSON.stringify(answers)]);
    return sent.body.data.id;
  }
  const byService = (lines) => lines.reduce((m, l) => ({ ...m, [l.service_id]: [...(m[l.service_id] || []), l] }), {});
  const shape = (ls) => (ls || []).map((l) => [l.id, l.rule_key, Number(l.qty), Number(l.rate), l.questionnaire_response_id]);

  test('D12: ISO and Ecovadis lines on one quotation, each linked to its own answers, under one number', async () => {
    const { id: iso, enquiryNo } = await submitted(sam);
    const made = await generate(sam, iso, 'new').expect(201);
    const eco = await alsoSent(enquiryNo, ecoFormId);
    assert.match((await generate(sam, eco, 'new')).body.error.message, /already has .*generate again to revise it/, 'not a second quotation');
    const res = await generate(sam, eco, 'revise').expect(200);
    assert.equal(res.body.data.quotation_no, made.body.data.quotation_no, 'the same quotation number');
    assert.equal(res.body.data.revision, 1, 'a new revision');

    const { e, q, lines } = await quotationOf(enquiryNo);
    assert.equal(e.quotation_no, q.quotation_no);
    assert.equal(q.questionnaire_response_id, eco, 'the quotation-level field: the response it was last generated from');
    const s = byService(lines);
    assert.deepEqual(s[serviceId].map((l) => [l.rule_key, l.questionnaire_response_id]), [['audit', iso], ['stage1', iso]]);
    assert.deepEqual(s[ecoServiceId].map((l) => [l.rule_key, l.questionnaire_response_id, l.price_needed]), [['assessment', eco, false], ['site_review', eco, true]]);
    const { rows: [{ c }] } = await pool.query(`SELECT count(*)::int AS c FROM quotations WHERE quotation_no LIKE 'CTZ/%' AND remarks LIKE $1`, [`%${enquiryNo}`]);
    assert.equal(c, 1, 'one quotation for the enquiry');

    // The quotation says where its lines came from, and each flagged line why, from its own answers.
    const d = (await full(sam, q.quotation_no).expect(200)).body.data;
    assert.deepEqual(d.generated_from.map((g) => [g.questionnaire_response_id, g.service_name, g.lines]).sort((a, b) => a[0] - b[0]),
      [[iso, 'Example certification', 2], [eco, 'Example sustainability rating', 2]].sort((a, b) => a[0] - b[0]));
    assert.equal(d.lines.find((l) => l.rule_key === 'site_review').price_needed_reason, '"employee_count" is 120, outside every band');
  });

  test('D12: regenerating one service leaves the other service\'s lines and the hand-added lines exactly as they were', async () => {
    const { id: iso, enquiryNo } = await submitted(sam);
    await generate(sam, iso, 'new').expect(201);
    const eco = await alsoSent(enquiryNo, ecoFormId);
    await generate(sam, eco, 'revise').expect(200);
    const { q } = await quotationOf(enquiryNo);
    await pool.query(`INSERT INTO quotation_lines (quotation_id, description, qty, rate, gst_rate, sort_order) VALUES ($1, 'Travel, agreed on the call', 1, 8000, 18, 90)`, [q.id]);
    const before = byService((await quotationOf(enquiryNo)).lines);

    // ISO again, with 300 employees: only ISO's lines change.
    await pool.query(`UPDATE questionnaire_responses SET answers = $2 WHERE id = $1`, [iso, JSON.stringify({ ...ANSWERS, employee_count: 300 })]);
    await generate(sam, iso, 'revise').expect(200);
    let after = byService((await quotationOf(enquiryNo)).lines);
    assert.deepEqual(shape(after[ecoServiceId]), shape(before[ecoServiceId]), 'Ecovadis lines untouched, same ids');
    assert.deepEqual(shape(after.undefined ?? after.null), shape(before.undefined ?? before.null), 'the hand-added line untouched');
    assert.deepEqual(after[serviceId].map((l) => [l.rule_key, Number(l.qty)]), [['audit', 7], ['stage1', 1]], 'ISO repriced, not duplicated');

    // Ecovadis again: only its lines change.
    const isoNow = shape(after[serviceId]);
    await generate(sam, eco, 'revise').expect(200);
    after = byService((await quotationOf(enquiryNo)).lines);
    assert.deepEqual(shape(after[serviceId]), isoNow, 'ISO lines untouched, same ids');
    assert.equal(after[ecoServiceId].length, 2, 'Ecovadis replaced, not added to');
  });

  test('D12: a newer response for the same service replaces that service\'s lines, never adding a second set', async () => {
    const { id: iso, enquiryNo } = await submitted(sam);
    await generate(sam, iso, 'new').expect(201);
    const eco = await alsoSent(enquiryNo, ecoFormId);
    await generate(sam, eco, 'revise').expect(200);
    // The Ecovadis questionnaire again, on a different form for the same service, answered by a small client.
    const ecoAgain = await alsoSent(enquiryNo, ecoFormAgainId, { ...ANSWERS, employee_count: 30 });
    await generate(sam, ecoAgain, 'revise').expect(200);
    const s = byService((await quotationOf(enquiryNo)).lines);
    assert.deepEqual(s[ecoServiceId].map((l) => [l.rule_key, l.questionnaire_response_id, l.price_needed]),
      [['assessment', ecoAgain, false], ['site_review', ecoAgain, false]], 'one set, from the newer response');
    assert.deepEqual(s[serviceId].map((l) => l.questionnaire_response_id), [iso, iso]);
  });

  test('D12: two services generating the same quotation at once queue on the enquiry: no deadlock, no lost or doubled lines', async () => {
    const { id: iso, enquiryNo } = await submitted(sam);
    await generate(sam, iso, 'new').expect(201);
    const eco = await alsoSent(enquiryNo, ecoFormId);
    // Both services, twice each, all at once, for a few rounds: before the enquiry was locked first this could deadlock (40P01).
    for (let round = 0; round < 5; round++) {
      const statuses = (await Promise.all([generate(sam, iso, 'revise'), generate(sam, eco, 'revise'), generate(sam, iso, 'revise'), generate(sam, eco, 'revise')])).map((r) => r.status);
      assert.deepEqual(statuses, [200, 200, 200, 200], `round ${round + 1}`);
    }
    const { q, lines } = await quotationOf(enquiryNo);
    assert.equal(q.revision, 20, 'every generation a revision, none lost');
    assert.deepEqual(lines.map((l) => l.rule_key), ['audit', 'stage1', 'assessment', 'site_review'], 'one set of lines per service');
  });

  test('D12: marking the enquiry Won with several services\' lines creates no further quotation', async () => {
    const { id: iso, enquiryNo } = await submitted(sam);
    await generate(sam, iso, 'new').expect(201);
    await generate(sam, await alsoSent(enquiryNo, ecoFormId), 'revise').expect(200);
    const { q } = await quotationOf(enquiryNo);
    const before = await quotationCount();
    await as(sam).patch(`/api/enquiries/${enquiryNo}`, { status: 'Converted' }).expect(200);
    assert.equal(await quotationCount(), before);
    assert.equal((await quotationOf(enquiryNo)).e.quotation_no, q.quotation_no, 'still the primary quotation');
  });

  test('D12: an edit to one service\'s generated line still shows after another service is generated', async () => {
    const { id: iso, enquiryNo } = await submitted(sam);
    await generate(sam, iso, 'new').expect(201);
    const { lines } = await quotationOf(enquiryNo);
    await as(sam).patch(`/api/quotation-lines/${lines[0].id}`, { description: 'Certification audit, as agreed' }).expect(200);
    await generate(sam, await alsoSent(enquiryNo, ecoFormId), 'revise').expect(200);
    assert.equal((await quotationOf(enquiryNo)).q.edited_since_generated, true);
  });

  test('D12: each line\'s Price needed reason comes from its own questionnaire\'s answers', async () => {
    const { id: iso, enquiryNo } = await submitted(sam, { answers: { ...ANSWERS, employee_count: 5000 } });
    await generate(sam, iso, 'new').expect(201);
    await generate(sam, await alsoSent(enquiryNo, ecoFormId, { ...ANSWERS, employee_count: 75 }), 'revise').expect(200);
    const { q } = await quotationOf(enquiryNo);
    const d = (await full(sam, q.quotation_no).expect(200)).body.data;
    assert.equal(d.lines.find((l) => l.rule_key === 'audit').price_needed_reason, '"employee_count" is 5000, outside every band', 'from the ISO answers');
    assert.equal(d.lines.find((l) => l.rule_key === 'site_review').price_needed_reason, '"employee_count" is 75, outside every band', 'from the Ecovadis answers');
  });

  test('R4: a reopened questionnaire says so, rather than that it was never submitted', async () => {
    const { id } = await submitted(sam);
    await as(sam).post(`/api/questionnaire-responses/${id}/reopen`, {}).expect(200);
    const res = await generate(sam, id, 'new');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.message, 'This questionnaire was reopened for changes; generate once the client submits it again');
    const never = await submitted(sam, { submit: false });
    assert.equal((await generate(sam, never.id, 'new')).body.error.message, 'The client has not submitted this questionnaire yet');
  });
});
