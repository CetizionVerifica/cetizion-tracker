import { query } from '../db.js';
import { RATES, rateOn } from './salesReport.js';
import { QUOTATION_STATUS, ENQUIRY_STATUS } from './statuses.js';
import { listSalesTargets } from './salesTargets.js';
import { monthsIn, previousPeriod, resolvePeriod } from './reportingPeriod.js';
import { ApiError } from '../middleware/error.js';

/**
 * The KPIs of issue #18 §5, to their stated definitions.
 *
 * ## Which person a figure belongs to
 *
 * Two different questions, and they must not share an answer:
 *
 *   originating_user_id   who did the work. Every period and outcome
 *                         figure — quotations sent, orders won, intake,
 *                         win rate, sales cycle — is attributed here.
 *   owner_user_id         who is responsible now. Every workload figure —
 *                         open pipeline, stale quotations, data gaps —
 *                         is scoped here.
 *
 * Using the current owner for outcomes would mean an admin reassigning a
 * won deal retroactively moves last quarter's intake and target attainment
 * between two people, so figures a team was measured on change after the
 * fact. Using the originator for pipeline would mean "my open quotations"
 * lists deals somebody else now owns and hides ones just handed over.
 *
 * ## Periods
 *
 * Half-open `[from, to)` throughout, and the Indian financial year by
 * default — see lib/reportingPeriod.js for why that is the tracker's own
 * year rather than a preference.
 *
 * ## Avoiding N+1
 *
 * Every query here groups by person and answers for the whole team at
 * once; a single-person report is the same queries with one id in the
 * filter. The previous engine ran six queries per salesperson inside a
 * `Promise.all` over the team, so a fifteen-person team asked ninety
 * questions to draw one page.
 *
 * ## Estimates
 *
 * #18 requires that figures resting on inferred data are labelled. Three
 * do: a won date backfilled from `quotation_date` (064), collections
 * carried in as an opening balance, and collections with no date at all
 * (067). Each is counted separately and reported beside the figure rather
 * than folded into it.
 */

const WON = QUOTATION_STATUS.won;
const CONVERTED = ENQUIRY_STATUS.quoted;

// There is deliberately no list of "open" statuses here. Point-in-time
// pipeline asks whether a quotation had been decided by a date, which is
// what won_at / lost_at record; reading the current status instead would
// make last quarter's pipeline shrink every time somebody closes a deal
// today, and would miss a deal reopened since.

/** Who did the work, surviving the deletion of their account. */
const ATTRIB = 'COALESCE(%s.originating_user_id, %s.originating_user_snapshot_id)';
const attrib = (alias) => ATTRIB.replaceAll('%s', alias);

/**
 * #18 §5 suggests 14 days, and leaves the number open. It is a settings row
 * rather than a constant so the answer can change without a deploy — which
 * is also why the decision did not need to be made before this shipped.
 *
 * Read the same way auth/routes.js reads its lockout settings: a missing or
 * unparseable row falls back rather than throwing, because a report is not
 * the place to discover that a settings row was deleted.
 */
const STALE_DAYS_SETTING = 'stale_quotation_days';
const STALE_DAYS_DEFAULT = 14;

const numericSetting = async (key, fallback) =>
  Number((await query('SELECT value FROM settings WHERE key = $1', [key]).catch(() => ({ rows: [] }))).rows[0]?.value) || fallback;

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * A filter on the sector and service of the record itself.
 *
 * #18 §7 asks for these on the team view. They are columns on quotations
 * and enquiries, not a dimension table, so this is a predicate rather than
 * a join — and it is applied to every query so the parts of a page agree
 * with each other.
 */
function dimensionClause(alias, { sector, service }, params, { serviceColumn = 'service' } = {}) {
  const out = [];
  if (sector) {
    params.push(sector);
    out.push(`${alias}.sector = $${params.length}`);
  }
  if (service) {
    params.push(service);
    out.push(`${alias}.${serviceColumn} = $${params.length}`);
  }
  return out.length ? ` AND ${out.join(' AND ')}` : '';
}

/**
 * The people a report covers always occupy the same parameter position, and
 * the callers below put them there before building anything else.
 *
 * Written this way after the alternative bit: appending the id list last
 * and referring to it as `$3` worked only while nothing else pushed a
 * parameter, and the sector filter does. A fixed slot cannot drift as
 * clauses are added, and `$PEOPLE IS NULL OR ...` lets one query serve both
 * the whole team and one person.
 */
const PEOPLE = '$3::int[]';

const ownerFilter = (column) => ` AND (${PEOPLE} IS NULL OR ${column} = ANY(${PEOPLE}))`;

/**
 * Everything attributed to the person who did the work, in the period.
 *
 * One row per salesperson. The medians are computed in SQL rather than in
 * JavaScript because pulling every quotation back to sort it is the shape
 * of query that is fine at 92 rows and not at 92,000, and
 * percentile_cont is what the database is for.
 */
async function cohortByPerson({ from, to }, userIds, dims) {
  const params = [from, to, userIds ?? null];
  const q = attrib('q');
  const e = attrib('e');

  const { rows } = await query(
    `WITH ${RATES},
     quoted AS (
       SELECT ${q} AS person,
              COUNT(*)::int AS quotations_sent,
              COALESCE(SUM(q.quotation_value * r.rate), 0) AS quoted_value_inr,
              COUNT(*) FILTER (WHERE r.rate IS NULL AND q.currency <> 'INR')::int AS quoted_unconverted
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE q.quotation_date >= $1::date AND q.quotation_date < $2::date
          AND ${q} IS NOT NULL
          ${ownerFilter(q)}
          ${dimensionClause('q', dims, params, { serviceColumn: 'service_quoted' })}
        GROUP BY 1
     ),
     decided AS (
       -- By won_at / lost_at, which is what §5 means by "decided in the
       -- period". The previous engine counted a cohort by quotation_date,
       -- which answers a different question: of the deals we quoted in
       -- March, how many eventually landed — not how many we won in March.
       SELECT ${q} AS person,
              COUNT(*) FILTER (WHERE q.won_at >= $1::date AND q.won_at < $2::date)::int AS orders_won,
              COUNT(*) FILTER (WHERE q.lost_at >= $1::date AND q.lost_at < $2::date)::int AS orders_lost,
              COUNT(*) FILTER (WHERE q.won_at >= $1::date AND q.won_at < $2::date AND q.won_at_estimated)::int AS orders_won_estimated,
              COALESCE(SUM(q.quotation_value * r.rate) FILTER (WHERE q.won_at >= $1::date AND q.won_at < $2::date), 0) AS order_intake_inr,
              COUNT(*) FILTER (WHERE q.won_at >= $1::date AND q.won_at < $2::date AND q.quotation_value IS NOT NULL)::int AS won_with_value,
              COUNT(*) FILTER (WHERE q.won_at >= $1::date AND q.won_at < $2::date
                               AND r.rate IS NULL AND q.currency <> 'INR')::int AS intake_unconverted,
              -- Sales cycle: quotation_date to won_at, in days. Rows whose
              -- won date was inferred are excluded rather than counted as
              -- zero — a backfilled win is stamped with quotation_date, so
              -- including them would drag every median toward nothing.
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (q.won_at - q.quotation_date::timestamptz)) / 86400
              ) FILTER (WHERE q.won_at >= $1::date AND q.won_at < $2::date
                          AND NOT q.won_at_estimated AND q.quotation_date IS NOT NULL) AS sales_cycle_days
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE ((q.won_at >= $1::date AND q.won_at < $2::date)
            OR (q.lost_at >= $1::date AND q.lost_at < $2::date))
          AND ${q} IS NOT NULL
          ${ownerFilter(q)}
          ${dimensionClause('q', dims, params, { serviceColumn: 'service_quoted' })}
        GROUP BY 1
     ),
     enquiries_logged AS (
       SELECT ${e} AS person,
              COUNT(*)::int AS enquiries_logged
         FROM enquiries e
        WHERE e.enquiry_date >= $1::date AND e.enquiry_date < $2::date
          AND ${e} IS NOT NULL
          ${ownerFilter(e)}
          ${dimensionClause('e', dims, params)}
        GROUP BY 1
     ),
     enquiries_decided AS (
       SELECT ${e} AS person,
              COUNT(*)::int AS enquiries_decided,
              COUNT(*) FILTER (WHERE e.status = '${CONVERTED}')::int AS enquiries_converted,
              -- Time to quote: the enquiry's own date to the date of the
              -- quotation it became. enquiries.quotation_no is the link;
              -- an enquiry turned down never had one and is not counted.
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY (lq.quotation_date - e.enquiry_date)
              ) FILTER (WHERE lq.quotation_date IS NOT NULL AND e.enquiry_date IS NOT NULL) AS time_to_quote_days
         FROM enquiries e
         LEFT JOIN quotations lq ON lq.quotation_no = e.quotation_no
        WHERE e.decided_at >= $1::date AND e.decided_at < $2::date
          AND ${e} IS NOT NULL
          ${ownerFilter(e)}
          ${dimensionClause('e', dims, params)}
        GROUP BY 1
     ),
     repeat_clients AS (
       -- Clients with two or more won orders, ever — "repeat" is a property
       -- of the relationship, not of the period, so this is deliberately
       -- not filtered by date.
       SELECT person, COUNT(*)::int AS repeat_clients FROM (
         SELECT ${q} AS person, COALESCE(q.company_id::text, q.client_name) AS client
           FROM quotations q
          WHERE q.status = '${WON}' AND ${q} IS NOT NULL
            ${ownerFilter(q)}
          GROUP BY 1, 2
         HAVING COUNT(*) >= 2
       ) c GROUP BY 1
     )
     SELECT u.id AS person,
            COALESCE(qd.quotations_sent, 0)         AS quotations_sent,
            COALESCE(qd.quoted_value_inr, 0)        AS quoted_value_inr,
            COALESCE(qd.quoted_unconverted, 0)      AS quoted_unconverted,
            COALESCE(d.orders_won, 0)               AS orders_won,
            COALESCE(d.orders_lost, 0)              AS orders_lost,
            COALESCE(d.orders_won_estimated, 0)     AS orders_won_estimated,
            COALESCE(d.order_intake_inr, 0)         AS order_intake_inr,
            COALESCE(d.won_with_value, 0)           AS won_with_value,
            COALESCE(d.intake_unconverted, 0)       AS intake_unconverted,
            d.sales_cycle_days,
            COALESCE(el.enquiries_logged, 0)        AS enquiries_logged,
            COALESCE(ed.enquiries_decided, 0)       AS enquiries_decided,
            COALESCE(ed.enquiries_converted, 0)     AS enquiries_converted,
            ed.time_to_quote_days,
            COALESCE(rc.repeat_clients, 0)          AS repeat_clients
       FROM users u
       LEFT JOIN quoted qd            ON qd.person = u.id
       LEFT JOIN decided d            ON d.person  = u.id
       LEFT JOIN enquiries_logged el  ON el.person = u.id
       LEFT JOIN enquiries_decided ed ON ed.person = u.id
       LEFT JOIN repeat_clients rc    ON rc.person = u.id
      WHERE ($3::int[] IS NULL OR u.id = ANY($3::int[]))`,
    params
  );
  return rows;
}

/**
 * What each person is carrying, as at the end of the period.
 *
 * Point-in-time, which is what §5 means by "quotations still open at the
 * end of the period" — not "open right now". A quotation created before
 * `to` and not decided before `to` was open then, whatever has happened
 * since. Reading the current status instead would make last quarter's
 * pipeline shrink every time somebody closes a deal today.
 */
async function pipelineByPerson({ from, to }, userIds, dims, staleDays) {
  // $1 the as-at date, $2 the stale threshold, $3 the people — the same
  // fixed slot every query here uses.
  const params = [to, staleDays, userIds ?? null];

  const { rows } = await query(
    `WITH ${RATES},
     as_at AS (
       SELECT q.owner_user_id AS person, q.*, r.rate
         FROM quotations q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE q.owner_user_id IS NOT NULL
          AND q.quotation_date < $1::date
          AND (q.won_at  IS NULL OR q.won_at  >= $1::date)
          AND (q.lost_at IS NULL OR q.lost_at >= $1::date)
          ${ownerFilter('q.owner_user_id')}
          ${dimensionClause('q', dims, params, { serviceColumn: 'service_quoted' })}
     )
     SELECT person,
            COUNT(*)::int AS open_quotations,
            COALESCE(SUM(quotation_value * rate), 0) AS pipeline_value_inr,
            COUNT(*) FILTER (WHERE rate IS NULL AND currency <> 'INR')::int AS pipeline_unconverted,
            -- Stale: open, and nothing has moved it for longer than the
            -- setting. stage_changed_at is the pipeline's own clock;
            -- updated_at would reset on a typo fix and hide a dead deal.
            COUNT(*) FILTER (
              WHERE COALESCE(stage_changed_at, quotation_date::timestamptz) < $1::date - ($2::int * INTERVAL '1 day')
            )::int AS stale_quotations,
            json_object_agg(status, status_count) FILTER (WHERE status IS NOT NULL) AS by_status
       FROM (
         SELECT person, quotation_value, rate, currency, stage_changed_at, quotation_date, status,
                COUNT(*) OVER (PARTITION BY person, status)::int AS status_count
           FROM as_at
       ) s
      GROUP BY person`,
    params
  );
  return rows;
}

/**
 * Invoiced and collected, and how much of each we actually know (#18 §5, 067).
 *
 * Attributed through the purchase order: to the quotation it fulfils where
 * there is one, and to the project otherwise — the same chain
 * purchaseOrderClause uses for access, so what a person is credited with
 * and what they can open are the same set.
 *
 * Three buckets, because the data supports three different degrees of
 * confidence and collapsing them would report a guess as a fact:
 *
 *   collected_inr             receipts with a real date, in the period.
 *   collected_estimated_inr   opening balances: a pre-#27 cumulative total
 *                             carried in on the last receipt's date, so it
 *                             lands in one period when it may have arrived
 *                             across several.
 *   collected_undated_inr     money on a stage that never reached the
 *                             ledger, or a receipt with no date. Cannot be
 *                             placed in any period, and is reported as a
 *                             total rather than assigned to this one.
 */
async function collectionsByPerson({ from, to }, userIds) {
  const params = [from, to, userIds ?? null];
  const owner = `COALESCE(oq.owner_user_id, pr.owner_user_id)`;

  const { rows } = await query(
    `WITH ${RATES},
     stages AS (
       SELECT ps.*, po.po_value, po.po_date, po.currency AS po_currency,
              ${owner} AS person
         FROM payment_stages ps
         JOIN purchase_orders po ON po.po_number = ps.po_number
         JOIN projects pr        ON pr.project_id = po.project_id
         LEFT JOIN quotations oq ON oq.quotation_no = po.quotation_no
        WHERE ${owner} IS NOT NULL
          ${ownerFilter(owner)}
     ),
     invoiced AS (
       SELECT s.person,
              COALESCE(SUM(ROUND(s.po_value * s.stage_percent, 2) * r.rate), 0) AS invoiced_inr,
              COUNT(*)::int AS invoices_raised
         FROM stages s
         ${rateOn('r', "COALESCE(s.po_currency, 'INR')", 's.invoice_date')}
        WHERE s.invoice_date >= $1::date AND s.invoice_date < $2::date
        GROUP BY 1
     ),
     ledger AS (
       SELECT s.person,
              COALESCE(SUM((p.amount + p.tds_amount) * r.rate)
                FILTER (WHERE p.origin = 'receipt'
                          AND p.received_on >= $1::date AND p.received_on < $2::date), 0) AS collected_inr,
              COALESCE(SUM((p.amount + p.tds_amount) * r.rate)
                FILTER (WHERE p.origin = 'opening_balance'
                          AND p.received_on >= $1::date AND p.received_on < $2::date), 0) AS collected_estimated_inr,
              COALESCE(SUM((p.amount + p.tds_amount) * r.rate)
                FILTER (WHERE p.origin = 'adjustment'
                          AND p.received_on >= $1::date AND p.received_on < $2::date), 0) AS adjustments_inr,
              COALESCE(SUM((p.amount + p.tds_amount) * r.rate)
                FILTER (WHERE p.received_on IS NULL), 0) AS undated_ledger_inr
         FROM stages s
         JOIN payments p ON p.stage_id = s.id
         ${rateOn('r', "COALESCE(s.po_currency, 'INR')", 'p.received_on')}
        GROUP BY 1
     ),
     off_ledger AS (
       -- Money on a stage that predates #27 and has had no receipt since,
       -- so payments_opening never fired and there is no row to date. It
       -- is real money and must not vanish from a total; it simply cannot
       -- be placed in a period (067).
       SELECT s.person,
              COALESCE(SUM(s.amount_received * r.rate), 0) AS off_ledger_inr
         FROM stages s
         ${rateOn('r', "COALESCE(s.po_currency, 'INR')", 's.payment_received_date')}
        WHERE s.amount_received > 0
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.stage_id = s.id)
        GROUP BY 1
     )
     SELECT u.id AS person,
            COALESCE(i.invoiced_inr, 0)                AS invoiced_inr,
            COALESCE(i.invoices_raised, 0)             AS invoices_raised,
            COALESCE(l.collected_inr, 0)               AS collected_inr,
            COALESCE(l.collected_estimated_inr, 0)     AS collected_estimated_inr,
            COALESCE(l.adjustments_inr, 0)             AS adjustments_inr,
            COALESCE(l.undated_ledger_inr, 0) + COALESCE(o.off_ledger_inr, 0) AS collected_undated_inr
       FROM users u
       LEFT JOIN invoiced i   ON i.person = u.id
       LEFT JOIN ledger l     ON l.person = u.id
       LEFT JOIN off_ledger o ON o.person = u.id
      WHERE ($3::int[] IS NULL OR u.id = ANY($3::int[]))`,
    params
  );
  return rows;
}

/** Owned records missing something a report needs (#18 §5, "data gaps"). */
async function dataGapsByPerson(userIds) {
  const params = [];
  const { rows } = await query(
    `SELECT u.id AS person,
            COALESCE(q.no_value, 0)   AS quotations_without_value,
            COALESCE(q.no_sector, 0)  AS quotations_without_sector,
            COALESCE(e.no_contact, 0) AS enquiries_without_contact
       FROM users u
       LEFT JOIN (
         SELECT owner_user_id AS person,
                COUNT(*) FILTER (WHERE quotation_value IS NULL)::int AS no_value,
                COUNT(*) FILTER (WHERE sector IS NULL OR btrim(sector) = '')::int AS no_sector
           FROM quotations WHERE owner_user_id IS NOT NULL GROUP BY 1
       ) q ON q.person = u.id
       LEFT JOIN (
         SELECT owner_user_id AS person,
                COUNT(*) FILTER (WHERE contact_person IS NULL OR btrim(contact_person) = '')::int AS no_contact
           FROM enquiries WHERE owner_user_id IS NOT NULL GROUP BY 1
       ) e ON e.person = u.id
      WHERE ($1::int[] IS NULL OR u.id = ANY($1::int[]))`,
    [userIds ?? null]
  );
  return rows;
}

/** Every KPI for one person, assembled from the grouped rows. */
function assemble({ cohort, pipeline, collections, gaps, targets, period }) {
  const orders_won = cohort?.orders_won ?? 0;
  const orders_lost = cohort?.orders_lost ?? 0;
  const intake = round2(cohort?.order_intake_inr);
  const wonWithValue = cohort?.won_with_value ?? 0;

  const figures = {
    enquiries_logged: cohort?.enquiries_logged ?? 0,
    quotations_sent: cohort?.quotations_sent ?? 0,
    quoted_value_inr: round2(cohort?.quoted_value_inr),
    orders_won,
    // Reported as well as used: a team total has to add the losses up, and
    // recovering them from a win rate is lossy — somebody with no wins and
    // five losses has a rate of 0, from which no arithmetic gets the five
    // back, so their losses would silently leave the team's rate.
    orders_lost,
    order_intake_inr: intake,
    win_rate_percent: pct(orders_won, orders_won + orders_lost),
    pipeline_value_inr: round2(pipeline?.pipeline_value_inr),
    open_quotations: pipeline?.open_quotations ?? 0,
    pipeline_by_status: pipeline?.by_status ?? {},
    average_deal_inr: wonWithValue > 0 ? round2(intake / wonWithValue) : null,
    enquiry_to_quotation_percent: pct(cohort?.enquiries_converted ?? 0, cohort?.enquiries_decided ?? 0),
    time_to_quote_days: num(cohort?.time_to_quote_days),
    sales_cycle_days: num(cohort?.sales_cycle_days),
    stale_quotations: pipeline?.stale_quotations ?? 0,
    invoiced_inr: round2(collections?.invoiced_inr),
    collected_inr: round2(collections?.collected_inr),
    repeat_clients: cohort?.repeat_clients ?? 0,
    data_gaps: {
      quotations_without_value: gaps?.quotations_without_value ?? 0,
      quotations_without_sector: gaps?.quotations_without_sector ?? 0,
      enquiries_without_contact: gaps?.enquiries_without_contact ?? 0,
    },
  };

  /**
   * What each figure is resting on, reported beside it rather than folded
   * into it. #18: "Estimated figures, such as won dates before the history
   * existed, are labelled as estimated."
   */
  const estimates = {
    orders_won_with_estimated_date: cohort?.orders_won_estimated ?? 0,
    collected_estimated_inr: round2(collections?.collected_estimated_inr),
    collected_undated_inr: round2(collections?.collected_undated_inr),
    collections_adjustments_inr: round2(collections?.adjustments_inr),
    amounts_without_exchange_rate: {
      quoted: cohort?.quoted_unconverted ?? 0,
      intake: cohort?.intake_unconverted ?? 0,
      pipeline: pipeline?.pipeline_unconverted ?? 0,
    },
  };

  return { period, figures, estimates, targets };
}

/**
 * Targets that apply to a period, and how far along each is.
 *
 * A target is counted when it lies wholly inside the range, so an annual
 * figure is the sum of its months rather than the months plus the year
 * counted twice (#18 §4: "the team target is the sum"). A person with a
 * monthly target and a quarterly one covering the same months would
 * double-count, which is why 066 constrains a person to one target per
 * metric per period and leaves overlapping period types to an admin.
 */
function attainment(targetRows, figures, { from, to }) {
  const METRIC_FIGURE = {
    order_intake_value: 'order_intake_inr',
    won_quotations_count: 'orders_won',
    quotations_sent_count: 'quotations_sent',
    collections_value: 'collected_inr',
    enquiries_created_count: 'enquiries_logged',
  };

  // listSalesTargets returns the period as ISO text, so these compare as
  // dates rather than as whatever a locale makes of a JS Date.
  const inRange = targetRows.filter((t) => t.period_start >= from && t.period_end <= to);

  const byMetric = new Map();
  for (const t of inRange) {
    const prev = byMetric.get(t.metric) ?? { metric: t.metric, target_value: 0, unit: t.unit, currency: t.currency, periods: 0 };
    prev.target_value += Number(t.target_value);
    prev.periods += 1;
    byMetric.set(t.metric, prev);
  }

  return [...byMetric.values()].map((t) => {
    const figureKey = METRIC_FIGURE[t.metric];
    const actual = figureKey ? figures[figureKey] : null;
    if (actual === null || actual === undefined) {
      return {
        ...t,
        actual: null,
        attainment_percent: null,
        status: 'unavailable',
        note: t.metric === 'follow_up_completion_rate'
          ? 'There is no sales follow-up table to measure completion against.'
          : `No automated figure is computed for '${t.metric}'.`,
      };
    }
    return {
      ...t,
      actual,
      variance: round2(actual - t.target_value),
      attainment_percent: t.target_value > 0 ? Math.round((actual / t.target_value) * 10000) / 100 : null,
      status: 'ok',
      note: null,
    };
  });
}

/** One salesperson's KPIs, optionally against the previous period. */
export async function getSalespersonKpis({ userId, period: periodInput, compare = true, sector = null, service = null } = {}) {
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new ApiError(422, 'Invalid userId');

  const { rows: [user] } = await query(
    'SELECT id, name, email, role, active FROM users WHERE id = $1', [uid]);
  if (!user) throw new ApiError(404, 'Salesperson not found');

  const report = await teamReport({ period: periodInput, userIds: [uid], compare, sector, service });
  const mine = report.people.find((p) => p.user.id === uid);
  return { ...mine, period: report.period, previous_period: report.previous_period };
}

/**
 * The whole team, in a fixed number of queries.
 *
 * `userIds` narrows it to one person for the personal view; everything else
 * is identical, so the two views cannot drift apart in their definitions —
 * which is what #18's acceptance criterion "team totals equal the sum of
 * individuals" actually requires.
 */
async function teamReport({ period: periodInput, userIds = null, compare = true, sector = null, service = null }) {
  const period = resolvePeriod(periodInput);
  const dims = { sector, service };
  const staleDays = await numericSetting(STALE_DAYS_SETTING, STALE_DAYS_DEFAULT);

  const people = userIds
    ? (await query('SELECT id, name, email, role, active FROM users WHERE id = ANY($1::int[])', [userIds])).rows
    : (await query("SELECT id, name, email, role, active FROM users WHERE role = 'sales' ORDER BY active DESC, name ASC")).rows;
  const ids = people.map((p) => p.id);

  const [cohort, pipeline, collections, gaps, targetRows] = await Promise.all([
    cohortByPerson(period, ids, dims),
    pipelineByPerson(period, ids, dims, staleDays),
    collectionsByPerson(period, ids),
    dataGapsByPerson(ids),
    listSalesTargets(undefined, { salespersonUserIds: ids, from: period.from, to: period.to }),
  ]);

  const index = (rows) => new Map(rows.map((r) => [Number(r.person), r]));
  const [c, p, col, g] = [index(cohort), index(pipeline), index(collections), index(gaps)];
  const targetsBy = new Map();
  for (const t of targetRows) {
    const list = targetsBy.get(t.salesperson_user_id) ?? [];
    list.push(t);
    targetsBy.set(t.salesperson_user_id, list);
  }

  const assembled = people.map((user) => {
    const figures = assemble({
      cohort: c.get(user.id), pipeline: p.get(user.id),
      collections: col.get(user.id), gaps: g.get(user.id),
      targets: [], period,
    });
    return {
      user: { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active },
      ...figures,
      targets: attainment(targetsBy.get(user.id) ?? [], figures.figures, period),
    };
  });

  let previous = null;
  if (compare) {
    const prev = previousPeriod(period);
    // Asked for as the same *kind* of period, anchored a period back, so it
    // comes back labelled "FY25-26" rather than as a custom range of the
    // same dates. A comparison the reader cannot name is one they cannot
    // check, and the label is what the chart beside it is keyed on.
    const asPreset = period.type === 'custom'
      ? { from: prev.from, to: prev.to }
      : { preset: period.type, anchor: prev.from };
    // One level only: the comparison never compares with its own comparison.
    const prevReport = await teamReport({
      period: asPreset, userIds: ids, compare: false, sector, service,
    });
    previous = { period: prevReport.period, people: prevReport.people, totals: prevReport.totals };
  }

  return {
    period,
    previous_period: previous,
    stale_after_days: staleDays,
    people: assembled,
    totals: totalsOf(assembled),
    months: monthsIn(period).map((m) => m.from.slice(0, 7)),
  };
}

/**
 * Team totals as the sum of the individuals, computed from their figures
 * rather than by a separate query.
 *
 * #18's acceptance criterion is that "team totals equal the sum of
 * individuals". A second aggregate query would be a second definition that
 * can disagree with the first; adding the rows up cannot.
 *
 * Rates and medians are the exception: a median of medians is not a
 * median, and a win rate is not the mean of win rates, so both are
 * recomputed from the underlying counts.
 */
function totalsOf(people) {
  const sum = (key) => people.reduce((n, p) => n + (p.figures[key] ?? 0), 0);
  const wonTotal = sum('orders_won');
  const lostTotal = sum('orders_lost');
  const intake = round2(sum('order_intake_inr'));

  return {
    enquiries_logged: sum('enquiries_logged'),
    quotations_sent: sum('quotations_sent'),
    quoted_value_inr: round2(sum('quoted_value_inr')),
    orders_won: wonTotal,
    orders_lost: lostTotal,
    order_intake_inr: intake,
    win_rate_percent: pct(wonTotal, wonTotal + lostTotal),
    pipeline_value_inr: round2(sum('pipeline_value_inr')),
    open_quotations: sum('open_quotations'),
    stale_quotations: sum('stale_quotations'),
    invoiced_inr: round2(sum('invoiced_inr')),
    collected_inr: round2(sum('collected_inr')),
    repeat_clients: sum('repeat_clients'),
    // A target total is the sum of the people's, which is exactly what §4
    // says the team target is.
    targets: [...people.reduce((acc, p) => {
      for (const t of p.targets) {
        const prev = acc.get(t.metric) ?? { metric: t.metric, unit: t.unit, currency: t.currency, target_value: 0, actual: 0 };
        prev.target_value += Number(t.target_value);
        prev.actual += Number(t.actual ?? 0);
        acc.set(t.metric, prev);
      }
      return acc;
    }, new Map()).values()].map((t) => ({
      ...t,
      target_value: round2(t.target_value),
      actual: round2(t.actual),
      attainment_percent: t.target_value > 0 ? Math.round((t.actual / t.target_value) * 10000) / 100 : null,
    })),
  };
}

export async function getTeamSalesKpis(options = {}) {
  return teamReport(options);
}

/** What each figure means, served beside it so a tooltip cannot drift (#18 §8). */
export const KPI_DEFINITIONS = Object.freeze({
  enquiries_logged: 'Enquiries you logged, by enquiry date in the period.',
  quotations_sent: 'Quotations you sent, by quotation date in the period.',
  quoted_value_inr: 'The value of those quotations, in rupees at the rate in force on each quotation date.',
  orders_won: 'Quotations that moved to Won — PO Received during the period.',
  order_intake_inr: 'The value of those orders.',
  win_rate_percent: 'Won ÷ (won + lost), counting deals decided in the period.',
  pipeline_value_inr: 'Quotations still open at the end of the period, as they stood then.',
  average_deal_inr: 'Order intake ÷ the orders won that carry a value.',
  enquiry_to_quotation_percent: 'Enquiries converted ÷ enquiries decided in the period.',
  time_to_quote_days: 'Median days from an enquiry being logged to its quotation being dated.',
  sales_cycle_days: 'Median days from a quotation being dated to it being won. Deals whose won date was inferred are excluded.',
  stale_quotations: 'Open quotations with no pipeline movement for longer than the Settings threshold.',
  invoiced_inr: 'Invoices raised in the period on purchase orders against your work.',
  collected_inr: 'Receipts dated in the period. Money carried in from before receipts were itemised is reported separately as estimated.',
  repeat_clients: 'Clients with two or more won orders, ever.',
  data_gaps: 'Records you own that are missing a value, a sector or a client contact.',
});
