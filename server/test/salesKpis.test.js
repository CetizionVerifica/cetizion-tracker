import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before, describe } from 'node:test';
import pg from 'pg';

/**
 * Every KPI in issue #18 §5, against fixed data (#18: "Each KPI gets unit
 * tests against fixed data, like server/test/reportRules.test.js").
 *
 * The fixture below is small, all-INR and entirely hand-computable — the
 * expected numbers in these tests are arithmetic anybody can check against
 * the table at the top, not values captured from a previous run. A KPI
 * suite whose expectations came from the code it tests only ever proves the
 * code still does what it did.
 *
 * The definitions being pinned are the ones #18 §5 writes down, and several
 * of them differ from what the engine computed before:
 *
 *   orders won     by won_at, "moved to Won in the period" — not by a
 *                  cohort of quotations dated in the period.
 *   win rate       won ÷ (won + lost) *decided* in the period.
 *   pipeline       open at the END of the period, as it stood then.
 *   sales cycle    quotation_date to won_at, excluding inferred dates.
 *
 * Needs a Postgres it may create databases on: set TEST_DATABASE_URL.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');

const WON = 'Won - PO Received';
const LOST = 'Lost';

/**
 * FY26-27, 1 April 2026 to 1 April 2027.
 *
 *   ASHA
 *   enquiries   E1 10 Apr, converted (decided 1 May), quoted by Q1
 *               E2 10 May, unqualified (decided 1 Jun)
 *               E3 10 Jun, still New — logged, not decided
 *   quotations  Q1  20 Apr  1,00,000  WON  20 May   client Alpha
 *               Q2   1 Jun  2,00,000  WON   1 Jul   client Alpha
 *               Q3   1 Jul  3,00,000  LOST  1 Aug   client Beta
 *               Q4   1 Aug  4,00,000  open              client Gamma
 *               Q5   1 Feb  5,00,000  WON   1 Mar   client Delta, won date ESTIMATED
 *   RAVI
 *   quotations  R1  1 Sep  6,00,000  WON  1 Oct    client Epsilon
 *   OUTSIDE THE YEAR
 *               X1  1 Feb 2026  9,99,999 WON 1 Mar 2026 — the previous FY
 */
const PERIOD = { from: '2026-04-01', to: '2027-04-01' };

/**
 * One database for the whole file, not one per test.
 *
 * db.js builds its pool from DATABASE_URL at import time and the module is
 * cached, so a second throwaway database created later in the file is never
 * reached — every test after the first would silently query the first
 * one's data. That failure is invisible: the queries succeed and return
 * somebody else's numbers.
 *
 * So the database is made once, and each test clears and re-seeds it.
 */
let db;
let dbName;
let kpi;

async function reset() {
  await db.query('TRUNCATE quotations, enquiries, projects, purchase_orders, payment_stages, payments, sales_targets, users RESTART IDENTITY CASCADE');
  seq = 0;
}

let seq = 0;
async function addUser(db, name) {
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, 'not-a-real-hash', 'sales', true) RETURNING id`,
    [name, `${name.toLowerCase()}@example.com`]
  );
  return rows[0].id;
}

/**
 * A quotation with its outcome already decided.
 *
 * won_at and lost_at are written explicitly rather than by moving the
 * status afterwards: 064's trigger COALESCEs an explicit date, so this
 * stamps the exact day the fixture describes instead of "now", which is
 * what makes the expected numbers below stable.
 */
async function quotation(db, {
  person, client = 'Alpha Ltd', date, value, status = 'Submitted',
  wonAt = null, lostAt = null, estimated = false, currency = 'INR',
  sector = null, service = null, stageChangedAt = null,
}) {
  seq += 1;
  const { rows } = await db.query(
    `INSERT INTO quotations (
       quotation_no, client_name, quotation_date, quotation_value, currency, status,
       owner_user_id, originating_user_id, originating_user_snapshot_id,
       won_at, lost_at, won_at_estimated, sector, service_quoted, stage_changed_at
     ) VALUES ($1,$2,$3::date,$4,$5,$6,$7,$7,$7,$8::timestamptz,$9::timestamptz,$10,$11,$12,$13::timestamptz)
     RETURNING id, quotation_no`,
    [`CTZ/QT/${String(seq).padStart(4, '0')}`, client, date, value, currency, status,
      person, wonAt, lostAt, estimated, sector, service, stageChangedAt]
  );
  return rows[0];
}

async function enquiry(db, { person, date, status = 'New', decidedAt = null, quotationNo = null, contact = 'A Person' }) {
  seq += 1;
  const { rows } = await db.query(
    `INSERT INTO enquiries (
       enquiry_no, client_name, enquiry_date, status, contact_person,
       owner_user_id, originating_user_id, originating_user_snapshot_id,
       decided_at, quotation_no
     ) VALUES ($1,'Alpha Ltd',$2::date,$3,$4,$5,$5,$5,$6::timestamptz,$7) RETURNING id`,
    [`CTZ/ENQ/${String(seq).padStart(4, '0')}`, date, status, contact, person, decidedAt, quotationNo]
  );
  return rows[0].id;
}

/** The whole fixture, and the two user ids it belongs to. */
async function fixture(db) {
  const asha = await addUser(db, 'Asha');
  const ravi = await addUser(db, 'Ravi');

  const q1 = await quotation(db, { person: asha, client: 'Alpha Ltd', date: '2026-04-20', value: 100000, status: WON, wonAt: '2026-05-20', sector: 'Pharma', service: 'Audit' });
  await quotation(db, { person: asha, client: 'Alpha Ltd', date: '2026-06-01', value: 200000, status: WON, wonAt: '2026-07-01', sector: 'Pharma', service: 'Audit' });
  await quotation(db, { person: asha, client: 'Beta Ltd', date: '2026-07-01', value: 300000, status: LOST, lostAt: '2026-08-01', sector: 'Food', service: 'Testing' });
  await quotation(db, { person: asha, client: 'Gamma Ltd', date: '2026-08-01', value: 400000, status: 'Submitted', sector: 'Food', service: 'Testing', stageChangedAt: '2026-08-01' });
  await quotation(db, { person: asha, client: 'Delta Ltd', date: '2027-02-01', value: 500000, status: WON, wonAt: '2027-03-01', estimated: true });

  await quotation(db, { person: ravi, client: 'Epsilon Ltd', date: '2026-09-01', value: 600000, status: WON, wonAt: '2026-10-01' });

  // The previous financial year: proves the period filters rather than
  // counting everything and proves the comparison has something to find.
  await quotation(db, { person: asha, client: 'Zeta Ltd', date: '2026-02-01', value: 999999, status: WON, wonAt: '2026-03-01' });

  await enquiry(db, { person: asha, date: '2026-04-10', status: 'Converted', decidedAt: '2026-05-01', quotationNo: q1.quotation_no });
  await enquiry(db, { person: asha, date: '2026-05-10', status: 'Unqualified', decidedAt: '2026-06-01' });
  await enquiry(db, { person: asha, date: '2026-06-10', status: 'New' });

  return { asha, ravi };
}

const figuresFor = (report, id) => report.people.find((p) => p.user.id === id).figures;

describe('the sales KPI engine', { skip: !ADMIN_URL && 'set TEST_DATABASE_URL to run' }, () => {
  before(async () => {
    dbName = `kpi_${process.pid}_${Date.now()}`;
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const url = new URL(ADMIN_URL);
    url.pathname = `/${dbName}`;
    Object.assign(process.env, {
      SKIP_DOTENV: '1', NODE_ENV: 'test', DATABASE_URL: url.toString(),
      SESSION_SECRET: 'test-secret-that-is-long-enough-to-pass',
    });

    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
    await db.query(readFileSync(join(DB_DIR, 'schema.sql'), 'utf8'));
    await db.query(readFileSync(join(DB_DIR, 'views.sql'), 'utf8'));
    kpi = await import('../src/lib/salesKpis.js');
  });

  after(async () => {
    const { pool } = await import('../src/db.js');
    await pool?.end();
    await db?.end();
    const root = new pg.Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // ----------------------------------------------------- the §5 definitions

  test('counts and values of what was sent, in the period', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);

      assert.equal(f.quotations_sent, 5, 'the five dated inside FY26-27, not the one from FY25-26');
      assert.equal(f.quoted_value_inr, 1500000, '1L + 2L + 3L + 4L + 5L');
      assert.equal(f.enquiries_logged, 3);
    });

  test('orders won are counted by won date, not by when they were quoted', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;

      const year = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
      assert.equal(year.orders_won, 3, 'Q1, Q2 and Q5 were won inside the year');
      assert.equal(year.order_intake_inr, 800000, '1L + 2L + 5L');

      // Q2 was quoted on 1 June and won on 1 July. A cohort by quotation
      // date would put it in June; §5 puts it in July, which is when the
      // order actually came in.
      const june = figuresFor(await getTeamSalesKpis({
        period: { from: '2026-06-01', to: '2026-07-01' }, compare: false,
      }), asha);
      assert.equal(june.quotations_sent, 1, 'it was quoted in June');
      assert.equal(june.orders_won, 0, 'and won in July');

      const july = figuresFor(await getTeamSalesKpis({
        period: { from: '2026-07-01', to: '2026-08-01' }, compare: false,
      }), asha);
      assert.equal(july.orders_won, 1);
      assert.equal(july.order_intake_inr, 200000);
    });

  test('win rate is won over decided, in the period', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);

      // Three won, one lost, all decided inside the year.
      assert.equal(f.win_rate_percent, 75, '3 ÷ (3 + 1)');
    });

  test('average deal is intake over the won orders that carry a value', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
      // Rounded to paise, like every other money figure the engine returns.
      assert.equal(f.average_deal_inr, 266666.67, '8L over three won orders');
    });

  test('pipeline is what was open at the END of the period, not what is open now', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;

      const year = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
      assert.equal(year.open_quotations, 1, 'only Q4 was still open on 1 April 2027');
      assert.equal(year.pipeline_value_inr, 400000);

      // As at 1 July 2026, Q3 had been quoted (1 July is exclusive, so not
      // yet) and Q1 and Q2 were still undecided or just decided. Measured a
      // day later, Q1 is won and out, Q2 is won and out, Q3 is in.
      const midYear = figuresFor(await getTeamSalesKpis({
        period: { from: '2026-04-01', to: '2026-07-02' }, compare: false,
      }), asha);
      assert.equal(midYear.open_quotations, 1, 'Q3, quoted on 1 July and not lost until August');
      assert.equal(midYear.pipeline_value_inr, 300000,
        'Q1 and Q2 were already won by then, so they are not pipeline');
    });

  test('a deal decided after the period still counts as pipeline within it', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      // Q3 was quoted 1 July and lost 1 August. As at 15 July it was open.
      const f = figuresFor(await getTeamSalesKpis({
        period: { from: '2026-07-01', to: '2026-07-15' }, compare: false,
      }), asha);
      assert.equal(f.open_quotations, 1, 'reading the current status would call it lost and hide it');
      assert.equal(f.pipeline_value_inr, 300000);
    });

  test('sales cycle and time to quote are medians in days', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);

      // Q1: 20 Apr → 20 May = 30 days. Q2: 1 Jun → 1 Jul = 30 days.
      // Q5's won date is inferred and is excluded, so the median is 30.
      assert.equal(f.sales_cycle_days, 30);

      // E1 logged 10 Apr, its quotation dated 20 Apr.
      assert.equal(f.time_to_quote_days, 10);
    });

  test('a won date that was inferred is excluded from the cycle and counted as an estimate', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const person = (await getTeamSalesKpis({ period: PERIOD, compare: false }))
        .people.find((p) => p.user.id === asha);

      assert.equal(person.estimates.orders_won_with_estimated_date, 1, 'Q5');
      assert.equal(person.figures.orders_won, 3, 'it still counts as an order won');
      assert.equal(person.figures.sales_cycle_days, 30,
        'Q5 would be a 28-day cycle measured from a date nobody recorded');
    });

  test('enquiry to quotation is converted over decided', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
      assert.equal(f.enquiry_to_quotation_percent, 50, 'one of the two decided enquiries converted');
    });

  test('repeat clients are those with two or more won orders', async () => {
      await reset();
      const { asha, ravi } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const report = await getTeamSalesKpis({ period: PERIOD, compare: false });
      assert.equal(figuresFor(report, asha).repeat_clients, 1, 'Alpha Ltd bought twice');
      assert.equal(figuresFor(report, ravi).repeat_clients, 0, 'Epsilon bought once');
    });

  test('data gaps count owned records missing what a report needs', async () => {
      await reset();
      const { asha } = await fixture(db);
      await quotation(db, { person: asha, date: '2026-09-01', value: null, status: 'Submitted' });
      await enquiry(db, { person: asha, date: '2026-09-02', contact: null });

      const { getTeamSalesKpis } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
      assert.equal(f.data_gaps.quotations_without_value, 1);
      assert.equal(f.data_gaps.enquiries_without_contact, 1);
      assert.ok(f.data_gaps.quotations_without_sector >= 1);
    });

  test('stale quotations are open ones nothing has moved for longer than the setting', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;

      // Q4 was quoted and last moved on 1 August. Measured as at 1 April
      // 2027 it has been still for eight months.
      const year = await getTeamSalesKpis({ period: PERIOD, compare: false });
      assert.equal(year.stale_after_days, 14, 'the seeded default #18 §5 suggests');
      assert.equal(figuresFor(year, asha).stale_quotations, 1);

      // Measured a week after it was quoted, it is not stale yet.
      const fresh = await getTeamSalesKpis({
        period: { from: '2026-08-01', to: '2026-08-08' }, compare: false,
      });
      assert.equal(figuresFor(fresh, asha).stale_quotations, 0);
    });

  // ------------------------------------------------------ scoping and sums

  test('team totals equal the sum of the individuals', async () => {
      await reset();
      const { asha, ravi } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const report = await getTeamSalesKpis({ period: PERIOD, compare: false });

      const a = figuresFor(report, asha);
      const r = figuresFor(report, ravi);
      assert.equal(report.totals.orders_won, a.orders_won + r.orders_won);
      assert.equal(report.totals.order_intake_inr, a.order_intake_inr + r.order_intake_inr);
      assert.equal(report.totals.quotations_sent, a.quotations_sent + r.quotations_sent);
      assert.equal(report.totals.pipeline_value_inr, a.pipeline_value_inr + r.pipeline_value_inr);
      assert.equal(report.totals.order_intake_inr, 1400000, '8L from Asha, 6L from Ravi');
    });

  test('a win rate is recomputed from the counts, not averaged across people', async () => {
      await reset();
      const { asha, ravi } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const report = await getTeamSalesKpis({ period: PERIOD, compare: false });

      // Asha 3 won 1 lost (75%), Ravi 1 won 0 lost (100%). The mean of the
      // two rates is 87.5%; the team rate is 4 ÷ 5.
      assert.equal(report.totals.win_rate_percent, 80);
      assert.notEqual(report.totals.win_rate_percent,
        (figuresFor(report, asha).win_rate_percent + figuresFor(report, ravi).win_rate_percent) / 2);
    });

  test('a person who lost everything still drags the team win rate down', async () => {
    await reset();
    const { asha } = await fixture(db);
    const unlucky = await addUser(db, 'Unlucky');
    for (const d of ['2026-05-01', '2026-06-01', '2026-07-01']) {
      await quotation(db, { person: unlucky, client: 'Theta Ltd', date: d, value: 50000, status: LOST, lostAt: d });
    }

    const { getTeamSalesKpis } = kpi;
    const report = await getTeamSalesKpis({ period: PERIOD, compare: false });

    // Asha 3 won 1 lost, Ravi 1 won 0 lost, Unlucky 0 won 3 lost.
    // Four won out of eight decided.
    assert.equal(figuresFor(report, unlucky).win_rate_percent, 0);
    assert.equal(report.totals.orders_lost, 4, "his three losses and Asha's one");
    assert.equal(report.totals.win_rate_percent, 50,
      'a rate of 0 carries no count, so inferring losses from it would lose all three');
  });

  test('one person asked for alone gets the same figures as the team view gives them', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getSalespersonKpis, getTeamSalesKpis } = kpi;

      const alone = await getSalespersonKpis({ userId: asha, period: PERIOD, compare: false });
      const inTeam = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
      assert.deepEqual(alone.figures, inTeam,
        'two views that can disagree are two definitions; #18 requires one');
    });

  test('sector and service filters narrow every figure together', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;

      const pharma = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false, sector: 'Pharma' }), asha);
      assert.equal(pharma.quotations_sent, 2, 'Q1 and Q2');
      assert.equal(pharma.orders_won, 2);
      assert.equal(pharma.order_intake_inr, 300000);
      assert.equal(pharma.open_quotations, 0, 'the open one is Food');

      const food = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false, sector: 'Food' }), asha);
      assert.equal(food.quotations_sent, 2, 'Q3 and Q4');
      assert.equal(food.orders_won, 0);
      assert.equal(food.open_quotations, 1);
    });

  // ------------------------------------------------------------ comparison

  test('the previous period is reported beside this one', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const report = await getTeamSalesKpis({ period: { preset: 'fy', anchor: '2026-06-01' } });

      assert.equal(report.period.label, 'FY26-27');
      assert.equal(report.previous_period.period.label, 'FY25-26');
      assert.equal(
        report.previous_period.people.find((p) => p.user.id === asha).figures.orders_won, 1,
        'the deal won on 1 March 2026 belongs to the year before'
      );
    });

  test('the comparison does not compare against its own comparison', async () => {
      await reset();
      await fixture(db);
      const { getTeamSalesKpis } = kpi;
      const report = await getTeamSalesKpis({ period: PERIOD });
      assert.equal(report.previous_period.period.from, '2025-04-01');
      assert.ok(!('previous_period' in report.previous_period),
        'one level only, or a year report walks back through history');
    });

  // ------------------------------------------- owner versus originator

  test('reassigning a won deal does not move last year\'s intake between people', async () => {
      await reset();
      const { asha, ravi } = await fixture(db);
      const { getTeamSalesKpis } = kpi;

      const before = await getTeamSalesKpis({ period: PERIOD, compare: false });
      assert.equal(figuresFor(before, asha).order_intake_inr, 800000);

      // An admin hands Asha's whole book to Ravi.
      await db.query('UPDATE quotations SET owner_user_id = $1 WHERE owner_user_id = $2', [ravi, asha]);

      const after = await getTeamSalesKpis({ period: PERIOD, compare: false });
      assert.equal(figuresFor(after, asha).order_intake_inr, 800000,
        'the intake stays with whoever won it; figures a team was measured on must not move');
      assert.equal(figuresFor(after, ravi).order_intake_inr, 600000);

      // Pipeline is the other question, and it does move.
      assert.equal(figuresFor(after, asha).open_quotations, 0, 'she no longer carries any of it');
      assert.equal(figuresFor(after, ravi).open_quotations, 1, 'and he now does');
    });



  // ------------------------------------------------- business-day boundaries

  /**
   * The edges of a period are midnight *where the business is* (#18 §5).
   *
   * won_at, lost_at and decided_at are timestamptz; a period is a pair of
   * dates. Compared directly, Postgres reads the date in the session zone —
   * UTC in the container — so the first five and a half hours of every IST
   * day fall into the day before, and at a period edge into the period
   * before. A financial-year report that does that cannot reconcile with
   * the invoice series it exists to match.
   */
  const IST_FY_2627 = { from: '2026-04-01', to: '2027-04-01' };

  test('a deal won just after IST midnight on 1 April is in the new financial year', async () => {
    await reset();
    const { asha } = await fixture(db);
    // 02:00 IST on 1 April is 2026-03-31 20:30 UTC. Read in UTC it lands in
    // the old year; read in IST it is the first hours of the new one.
    await quotation(db, {
      person: asha, client: 'Boundary Ltd', date: '2026-03-20', value: 700000,
      status: WON, wonAt: '2026-04-01T02:00:00+05:30',
    });

    const { getTeamSalesKpis } = kpi;
    const next = figuresFor(await getTeamSalesKpis({ period: IST_FY_2627, compare: false }), asha);
    const prev = figuresFor(await getTeamSalesKpis({
      period: { from: '2025-04-01', to: '2026-04-01' }, compare: false,
    }), asha);

    assert.equal(next.orders_won, 4, 'the three FY26-27 fixtures plus this one');
    assert.ok(next.order_intake_inr >= 700000, 'and its value is in the new year');
    assert.equal(prev.orders_won, 1, 'the previous year keeps only the deal that belongs to it');
  });

  test('a deal won just before IST midnight on 1 April stays in the old year', async () => {
    await reset();
    const { asha } = await fixture(db);
    // 23:00 IST on 31 March is 2026-03-31 17:30 UTC — still the old year
    // either way, and the control for the test above.
    await quotation(db, {
      person: asha, client: 'Boundary Ltd', date: '2026-03-20', value: 700000,
      status: WON, wonAt: '2026-03-31T23:00:00+05:30',
    });

    const { getTeamSalesKpis } = kpi;
    const next = figuresFor(await getTeamSalesKpis({ period: IST_FY_2627, compare: false }), asha);
    assert.equal(next.orders_won, 3, 'the fixtures only; the boundary deal is last year\'s');
  });

  test('UTC midnight is the same business day, not the one before', async () => {
    await reset();
    const { asha } = await fixture(db);
    // 2026-06-01 00:00 UTC is 05:30 IST on 1 June — inside June, not May.
    await quotation(db, {
      person: asha, client: 'Utc Midnight Ltd', date: '2026-05-02', value: 150000,
      status: WON, wonAt: '2026-06-01T00:00:00+00:00',
    });

    const { getTeamSalesKpis } = kpi;
    const june = figuresFor(await getTeamSalesKpis({
      period: { from: '2026-06-01', to: '2026-07-01' }, compare: false,
    }), asha);
    const may = figuresFor(await getTeamSalesKpis({
      period: { from: '2026-05-01', to: '2026-06-01' }, compare: false,
    }), asha);

    assert.equal(june.orders_won, 1, 'counted in June');
    assert.equal(may.orders_won, 1, "May keeps only its own fixture, not this one");
  });

  test('an enquiry decided in the first hours of an IST day belongs to that day', async () => {
    await reset();
    const { asha } = await fixture(db);
    await enquiry(db, {
      person: asha, date: '2026-06-20', status: 'Unqualified',
      decidedAt: '2026-07-01T01:00:00+05:30',
    });

    const { getTeamSalesKpis } = kpi;
    const july = figuresFor(await getTeamSalesKpis({
      period: { from: '2026-07-01', to: '2026-08-01' }, compare: false,
    }), asha);
    assert.equal(july.enquiries_decided ?? 0, 0, 'enquiries_decided is not a reported figure');
    assert.equal(july.enquiry_to_quotation_percent, 0,
      'one enquiry decided in July, none converted — so the rate is 0, not null');
  });

  test('the sales cycle is whole business days, not seconds across an offset', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { getTeamSalesKpis } = kpi;
    // Quoted the 20th, won the 20th of the next month: thirty days.
    assert.equal(
      figuresFor(await getTeamSalesKpis({ period: IST_FY_2627, compare: false }), asha).sales_cycle_days,
      30,
      'measuring in epoch seconds across the IST offset gives 29.77'
    );
  });


  test('pipeline by status names each status once, not once per quotation', async () => {
    await reset();
    const { asha } = await fixture(db);
    // Three more open quotations in the same status as the fixture's one.
    for (const d of ['2026-08-02', '2026-08-03', '2026-08-04']) {
      await quotation(db, { person: asha, client: 'Bulk Ltd', date: d, value: 10000, status: 'Submitted' });
    }

    const { getTeamSalesKpis } = kpi;
    const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);

    assert.equal(f.open_quotations, 4);
    assert.deepEqual(f.pipeline_by_status, { Submitted: 4 },
      'the count rides on every row of its group; without DISTINCT this is four identical keys');
    assert.equal(Object.keys(f.pipeline_by_status).length, 1);
  });

  // ------------------------------------------------------- collections

  /**
   * A purchase order under one of Asha's won quotations, with a stage to
   * invoice and receipt against. Collections are attributed through the PO
   * to the quotation it fulfils — the same chain purchaseOrderClause uses
   * for access, so what a person is credited with and what they can open
   * are the same set.
   */
  async function orderFor(person, { poValue = 1000000, quotationNo }) {
    await db.query(
      `INSERT INTO projects (project_id, client_name, owner_user_id) VALUES ('PRJ-1', 'Alpha Ltd', $1)`,
      [person]
    );
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency, quotation_no)
       VALUES ('PO-1', 'PRJ-1', '2026-05-01', $1, 'INR', $2)`,
      [poValue, quotationNo]
    );
    const { rows } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, invoice_no, invoice_date)
       VALUES ('PO-1', 1, 'Advance', 'On PO Registration', 1, 'INV-1', '2026-06-15') RETURNING id`
    );
    return rows[0].id;
  }

  test('invoiced counts the stage value, by invoice date', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    await orderFor(asha, { poValue: 1000000, quotationNo: q.quotation_no });

    const { getTeamSalesKpis } = kpi;
    const inYear = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
    assert.equal(inYear.invoiced_inr, 1000000, 'the whole PO, since the stage is 100%');

    const wrongMonth = figuresFor(await getTeamSalesKpis({
      period: { from: '2026-07-01', to: '2026-08-01' }, compare: false,
    }), asha);
    assert.equal(wrongMonth.invoiced_inr, 0, 'the invoice is dated June');
  });

  test('collected counts receipts by their own date, not the stage total', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });

    // Two receipts, in two different months. The stage total is 6,00,000
    // and carries only the later date; a figure taken from the stage would
    // put all of it in August.
    await db.query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, origin) VALUES
        ($1, 400000, '2026-07-10', 'bank_transfer', 'receipt'),
        ($1, 200000, '2026-08-10', 'bank_transfer', 'receipt')`, [stage]);

    const { getTeamSalesKpis } = kpi;
    const july = figuresFor(await getTeamSalesKpis({
      period: { from: '2026-07-01', to: '2026-08-01' }, compare: false,
    }), asha);
    assert.equal(july.collected_inr, 400000, 'the ledger places each receipt in its own month');

    const august = figuresFor(await getTeamSalesKpis({
      period: { from: '2026-08-01', to: '2026-09-01' }, compare: false,
    }), asha);
    assert.equal(august.collected_inr, 200000);

    const year = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
    assert.equal(year.collected_inr, 600000, 'and the year is the sum of them');
  });

  test('tds counts as settled: the client paid it on our behalf', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });
    await db.query(
      `INSERT INTO payments (stage_id, amount, tds_amount, received_on, mode, origin)
       VALUES ($1, 90000, 10000, '2026-07-10', 'bank_transfer', 'receipt')`, [stage]);

    const { getTeamSalesKpis } = kpi;
    const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);
    assert.equal(f.collected_inr, 100000, 'the same rule payments_changed applies to the stage total');
  });

  test('a balance carried in from before receipts existed is reported as an estimate', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });

    await db.query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, notes, origin) VALUES
        ($1, 500000, '2026-07-10', 'other', 'Opening balance from the stage', 'opening_balance'),
        ($1, 100000, '2026-07-20', 'bank_transfer', NULL, 'receipt')`, [stage]);

    const { getTeamSalesKpis } = kpi;
    const person = (await getTeamSalesKpis({ period: PERIOD, compare: false }))
      .people.find((p) => p.user.id === asha);

    assert.equal(person.figures.collected_inr, 100000,
      'the confident figure is the money we can actually date');
    assert.equal(person.estimates.collected_estimated_inr, 500000,
      'and the lump carried in is reported beside it, not folded into it');
  });

  test('money on a stage that never reached the ledger is counted but not placed in a period', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });

    // A stage paid before #27 and untouched since: payments_opening only
    // fires when a new receipt arrives, so there is no row at all.
    await db.query(
      `UPDATE payment_stages SET amount_received = 250000, payment_received_date = '2025-01-01' WHERE id = $1`,
      [stage]);

    const { getTeamSalesKpis } = kpi;
    const person = (await getTeamSalesKpis({ period: PERIOD, compare: false }))
      .people.find((p) => p.user.id === asha);

    assert.equal(person.figures.collected_inr, 0, 'it cannot honestly be called this year\'s');
    assert.equal(person.estimates.collected_undated_inr, 250000,
      'but it is real money and must not simply vanish from the report');
  });

  test('a correction is reported as an adjustment, not hidden inside the total', async () => {
    await reset();
    const { asha } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });
    await db.query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, origin) VALUES
        ($1, 300000, '2026-07-10', 'bank_transfer', 'receipt'),
        ($1, -50000, '2026-07-15', 'other', 'adjustment')`, [stage]);

    const { getTeamSalesKpis } = kpi;
    const person = (await getTeamSalesKpis({ period: PERIOD, compare: false }))
      .people.find((p) => p.user.id === asha);
    assert.equal(person.figures.collected_inr, 300000);
    assert.equal(person.estimates.collections_adjustments_inr, -50000,
      'so a total that nets one off says where the difference went');
  });

  test('collections belong to whoever owns the work, and nobody else sees them', async () => {
    await reset();
    const { asha, ravi } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });
    await db.query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, origin)
       VALUES ($1, 700000, '2026-07-10', 'bank_transfer', 'receipt')`, [stage]);

    const { getTeamSalesKpis } = kpi;
    const report = await getTeamSalesKpis({ period: PERIOD, compare: false });
    assert.equal(figuresFor(report, asha).collected_inr, 700000);
    assert.equal(figuresFor(report, ravi).collected_inr, 0);
    assert.equal(report.totals.collected_inr, 700000, 'and the team total is the sum');
  });


  test('collections credit the originator, and do not move when a deal is reassigned', async () => {
    await reset();
    const { asha, ravi } = await fixture(db);
    const { rows: [q] } = await db.query("SELECT quotation_no FROM quotations WHERE client_name = 'Beta Ltd'");
    const stage = await orderFor(asha, { quotationNo: q.quotation_no });
    await db.query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, origin)
       VALUES ($1, 700000, '2026-07-10', 'bank_transfer', 'receipt')`, [stage]);

    const { getTeamSalesKpis } = kpi;
    const before = await getTeamSalesKpis({ period: PERIOD, compare: false });
    assert.equal(figuresFor(before, asha).collected_inr, 700000);

    // An admin hands Asha's whole book to Ravi.
    await db.query('UPDATE quotations SET owner_user_id = $1 WHERE owner_user_id = $2', [ravi, asha]);
    await db.query('UPDATE projects   SET owner_user_id = $1 WHERE owner_user_id = $2', [ravi, asha]);

    const after = await getTeamSalesKpis({ period: PERIOD, compare: false });
    assert.equal(figuresFor(after, asha).collected_inr, 700000,
      'money follows whoever sold it, like order intake — reassignment is not a transfer of history');
    assert.equal(figuresFor(after, ravi).collected_inr, 0);
  });

  test('money whose work names nobody goes to an unattributed bucket, not to the owner', async () => {
    await reset();
    const { asha } = await fixture(db);
    // A purchase order under a project with no originating quotation: there
    // is no originator to credit, and the current owner is not a substitute.
    await db.query(
      `INSERT INTO projects (project_id, client_name, owner_user_id) VALUES ('PRJ-ORPHAN', 'Orphan Ltd', $1)`,
      [asha]);
    await db.query(
      `INSERT INTO purchase_orders (po_number, project_id, po_date, po_value, currency)
       VALUES ('PO-ORPHAN', 'PRJ-ORPHAN', '2026-05-01', 900000, 'INR')`);
    const { rows: [s] } = await db.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
       VALUES ('PO-ORPHAN', 1, 'Advance', 'On PO Registration', 1) RETURNING id`);
    await db.query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, origin)
       VALUES ($1, 450000, '2026-07-10', 'bank_transfer', 'receipt')`, [s.id]);

    const { getTeamSalesKpis } = kpi;
    const report = await getTeamSalesKpis({ period: PERIOD, compare: false });

    assert.equal(figuresFor(report, asha).collected_inr, 0,
      'she owns the project, but owning it now is not the same as having sold it');
    assert.equal(report.totals.unattributed_collected_inr, 450000,
      'the money is real and is reported, credited to nobody');
  });

  // ------------------------------------------------------------ the shape

  test('an unknown period is refused rather than answered about the wrong dates', async () => {
      await reset();
      await fixture(db);
      const { getTeamSalesKpis } = kpi;
      await assert.rejects(
        () => getTeamSalesKpis({ period: { from: '2027-01-01', to: '2026-01-01' }, compare: false }),
        /after from/
      );
    });

  test('every figure §5 names is present, so a missing one fails loudly', async () => {
      await reset();
      const { asha } = await fixture(db);
      const { getTeamSalesKpis, KPI_DEFINITIONS } = kpi;
      const f = figuresFor(await getTeamSalesKpis({ period: PERIOD, compare: false }), asha);

      for (const key of [
        'enquiries_logged', 'quotations_sent', 'quoted_value_inr', 'orders_won',
        'order_intake_inr', 'win_rate_percent', 'pipeline_value_inr', 'average_deal_inr',
        'enquiry_to_quotation_percent', 'time_to_quote_days', 'sales_cycle_days',
        'stale_quotations', 'invoiced_inr', 'collected_inr', 'repeat_clients', 'data_gaps',
      ]) {
        assert.ok(key in f, `§5 names ${key}`);
        assert.ok(key in KPI_DEFINITIONS, `and a tooltip needs its definition: ${key}`);
      }
    });
});
