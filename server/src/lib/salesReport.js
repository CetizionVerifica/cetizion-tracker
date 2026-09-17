import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { nameKey } from './names.js';
import { share } from './reportMath.js';
import { QUOTATION_STATUS } from './statuses.js';

/**
 * Sales reports, read straight from the quotations table.
 *
 * A quotation marked "Won - PO Received" counts as a PO: many deals are won
 * well before their PO is registered, and counting registered POs alone
 * would leave those out.
 *
 * Clients and sectors are free text, so they are grouped by spelling. Case
 * and stray spaces are ignored; any other difference is a different name.
 * "Hetero" and "hetero " are one client, "Hindalco" and "Hindalco - Kuppam"
 * are two.
 */

// Same spelling, same group — defined once in names.js for reports and list filters alike.
export { nameKey };

// $1 = from, $2 = to, either null for an open end. A row with no date
// cannot be placed in a period, so it only counts when neither end is set.
export const inPeriod = (column) => `COALESCE(($1::date IS NULL OR ${column} >= $1::date)
                        AND ($2::date IS NULL OR ${column} <= $2::date), false)`;

export const IN_PERIOD = inPeriod('quotation_date');

const UP_TO_END = `COALESCE($2::date IS NULL OR quotation_date <= $2::date, false)`;

// Every dated rate, plus INR at 1 from the beginning of time. A currency with
// no row at all never appears, which gives a null rate through the lookup
// below — never a guessed one.
export const RATES = `rates AS (
  SELECT 'INR'::text AS currency, 1::numeric AS rate, '0001-01-01'::date AS effective_from
  UNION ALL
  SELECT from_currency, rate, effective_from
    FROM exchange_rates
   WHERE to_currency = 'INR'
)`;

/**
 * The rate in force on a record's own date: the newest row dated on or before
 * it. A quotation joins on its quotation date, a PO on its PO date, an invoice
 * on its invoice date and a payment on its payment date, so every figure is
 * converted at the rate that applied when it happened.
 *
 * A record with no date has nothing to look up, so it falls back to today's
 * rate — the same value it converted at before rates were dated. Undated
 * records are already reported as a data gap in their own right.
 *
 * Used as a LEFT JOIN LATERAL: a currency with no rate covering that date
 * yields rate NULL, and the amount is reported unconverted exactly as a
 * missing rate is today.
 */
export const rateOn = (alias, currency, date) => `LEFT JOIN LATERAL (
  SELECT rate, effective_from FROM rates
     WHERE currency = ${currency}
       AND effective_from <= COALESCE(${date}, CURRENT_DATE)
     ORDER BY effective_from DESC
     LIMIT 1
  ) ${alias} ON true`;

/** Won value per currency as [{ currency, amount }] — never summed across currencies. */
const amountsFor = (table, key, outerKey) => `
  COALESCE((
    SELECT json_agg(json_build_object('currency', a.currency, 'amount', a.amount)
                    ORDER BY a.currency <> 'INR', a.currency)
      FROM ${table} a
     WHERE a.${key} IS NOT DISTINCT FROM ${outerKey}
  ), '[]'::json)`;

/** The rates a row's INR value was built from, as [{ currency, rate, effective_from }]. */
const ratesUsedFor = (table, key, outerKey) => `
  COALESCE((
    SELECT json_agg(json_build_object('currency', u.currency, 'rate', u.rate,
                                      'effective_from', u.effective_from)
                    ORDER BY u.currency, u.effective_from)
      FROM ${table} u
     WHERE u.${key} IS NOT DISTINCT FROM ${outerKey}
  ), '[]'::json)`;

const byCurrency = (a, b) => (a === 'INR' ? -1 : b === 'INR' ? 1 : a.localeCompare(b));

const isIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // JavaScript accepts year 0000; Postgres does not, and would fail mid-query.
  if (Number(value.slice(0, 4)) < 1) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** Read ?from=&to= (YYYY-MM-DD, both optional) off a request. */
export function reportPeriod(reqQuery) {
  const period = {};
  for (const key of ['from', 'to']) {
    const value = String(reqQuery[key] ?? '').trim();
    if (value && !isIsoDate(value)) {
      throw new ApiError(422, `Use a YYYY-MM-DD date for "${key}"`);
    }
    period[key] = value || null;
  }
  if (period.from && period.to && period.from > period.to) {
    throw new ApiError(422, 'The start date is after the end date');
  }
  return period;
}

/** Sum [{ currency, amount }] lists per currency, INR first. */
function sumAmounts(lists) {
  const totals = new Map();
  for (const list of lists) {
    for (const { currency, amount } of list) {
      totals.set(currency, Math.round(((totals.get(currency) || 0) + amount) * 100) / 100);
    }
  }
  return [...totals.keys()].sort(byCurrency).map((currency) => ({ currency, amount: totals.get(currency) }));
}

/**
 * The sales funnel per sector. Enquiries are counted by enquiry date, the
 * rest by quotation date. Every quotation is exactly one of won, lost or
 * pipeline (Submitted, Under Negotiation, On Hold).
 */
export async function sectorReport({ from, to }) {
  const { rows } = await query(
    `WITH ${RATES},
     q AS (
       SELECT NULLIF(${nameKey('sector')}, '') AS sector_key,
              NULLIF(btrim(sector), '')         AS sector,
              ${nameKey('client_name')}          AS client_key,
              status = '${QUOTATION_STATUS.won}'       AS is_won,
              status = '${QUOTATION_STATUS.lost}'                    AS is_lost,
              quotation_value,
              currency,
              quotation_date
         FROM quotations
        WHERE ${IN_PERIOD}
     ),
     e AS (
       SELECT NULLIF(${nameKey('sector')}, '') AS sector_key,
              NULLIF(btrim(sector), '')         AS sector
         FROM enquiries
        WHERE ${inPeriod('enquiry_date')}
     ),
     sectors AS (
       SELECT sector_key, mode() WITHIN GROUP (ORDER BY sector) AS sector
         FROM (SELECT sector_key, sector FROM q
               UNION ALL
               SELECT sector_key, sector FROM e) names
        GROUP BY sector_key
     ),
     quoted AS (
       SELECT sector_key,
              COUNT(*) FILTER (WHERE is_won)                             AS pos,
              COUNT(*) FILTER (WHERE is_lost)                            AS lost,
              COUNT(*) FILTER (WHERE NOT is_won AND NOT is_lost)         AS pipeline,
              COUNT(DISTINCT client_key) FILTER (WHERE is_won)           AS customers,
              COUNT(*) FILTER (WHERE is_won AND quotation_value IS NULL) AS pos_without_value,
              COUNT(*) FILTER (WHERE is_won AND currency <> 'INR')       AS fx_deals
         FROM q
        GROUP BY sector_key
     ),
     enquired AS (
       SELECT sector_key, COUNT(*) AS enquiries FROM e GROUP BY sector_key
     ),
     by_currency AS (
       SELECT sector_key, currency, SUM(quotation_value) AS amount
         FROM q
        WHERE is_won AND quotation_value IS NOT NULL
        GROUP BY 1, 2
     ),
     converted AS (
       SELECT q.sector_key, SUM(q.quotation_value * r.rate) FILTER (WHERE is_won) AS won_value_inr
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        GROUP BY q.sector_key
     ),
     unconverted AS (
       SELECT q.sector_key, q.currency, SUM(q.quotation_value) AS amount
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE is_won AND q.quotation_value IS NOT NULL AND r.rate IS NULL
        GROUP BY 1, 2
     ),
     rates_used AS (
       SELECT q.sector_key, q.currency, r.rate, r.effective_from
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE is_won AND q.currency <> 'INR' AND r.rate IS NOT NULL
        GROUP BY 1, 2, 3, 4
     )
     SELECT COALESCE(s.sector, 'Not set')                              AS sector,
            s.sector_key IS NULL                                       AS not_set,
            COALESCE(en.enquiries, 0)::int                             AS enquiries,
            COALESCE(qu.pos, 0)::int                                   AS pos,
            COALESCE(qu.lost, 0)::int                                  AS lost,
            COALESCE(qu.pipeline, 0)::int                              AS pipeline,
            COALESCE(qu.customers, 0)::int                             AS customers,
            COALESCE(qu.pos_without_value, 0)::int                     AS pos_without_value,
            COALESCE(qu.fx_deals, 0)::int                              AS fx_deals,
            ROUND(COALESCE(co.won_value_inr, 0), 2)                    AS won_value_inr,
            ${amountsFor('by_currency', 'sector_key', 's.sector_key')}  AS amounts,
            ${amountsFor('unconverted', 'sector_key', 's.sector_key')}  AS unconverted,
            ${ratesUsedFor('rates_used', 'sector_key', 's.sector_key')}  AS rate_details
       FROM sectors s
       LEFT JOIN quoted qu   ON qu.sector_key IS NOT DISTINCT FROM s.sector_key
       LEFT JOIN enquired en ON en.sector_key IS NOT DISTINCT FROM s.sector_key
       LEFT JOIN converted co ON co.sector_key IS NOT DISTINCT FROM s.sector_key
      ORDER BY s.sector_key IS NULL, pos DESC, pipeline DESC, enquiries DESC, sector`,
    [from, to]
  );

  // Won ÷ decided (won + lost). Open deals have no outcome yet, so they are left out.
  for (const row of rows) row.win_rate = share(row.pos, row.pos + row.lost);
  const total = (field) => rows.reduce((sum, row) => sum + row[field], 0);

  return {
    rows,
    summary: {
      enquiries: total('enquiries'),
      pos: total('pos'),
      lost: total('lost'),
      pipeline: total('pipeline'),
      fx_deals: total('fx_deals'),
      win_rate: share(total('pos'), total('pos') + total('lost')),
      sectors: rows.filter((row) => !row.not_set && row.pos > 0).length,
      pos_without_sector: rows.find((row) => row.not_set)?.pos ?? 0,
      amounts: sumAmounts(rows.map((row) => row.amounts)),
      won_value_inr: Math.round(total('won_value_inr') * 100) / 100,
      unconverted: sumAmounts(rows.map((row) => row.unconverted)),
    },
  };
}

/**
 * Won POs billed in a currency other than INR, per client, sector and
 * currency, with the INR value at the rate set in Settings.
 */
export async function fxReport({ from, to }) {
  const { rows } = await query(
    `WITH ${RATES}
     SELECT mode() WITHIN GROUP (ORDER BY btrim(q.client_name))                    AS customer,
            COALESCE(mode() WITHIN GROUP (ORDER BY NULLIF(btrim(q.sector), '')),
                     'Not set')                                                     AS sector,
            NULLIF(${nameKey('q.sector')}, '') IS NULL                              AS not_set,
            q.currency,
            COUNT(*)::int                                                           AS deals,
            COUNT(*) FILTER (WHERE q.quotation_value IS NULL)::int                  AS deals_without_value,
            COALESCE(SUM(q.quotation_value), 0)                                     AS amount,
            r.rate,
            r.effective_from                                                        AS rate_effective_from,
            ROUND(COALESCE(SUM(q.quotation_value), 0) * r.rate, 2)                  AS amount_inr,
            string_agg(q.quotation_no, ', ' ORDER BY q.quotation_date, q.quotation_no) AS quotation_nos
       FROM quotations q
       ${rateOn('r', 'q.currency', 'q.quotation_date')}
      WHERE q.status = '${QUOTATION_STATUS.won}' AND q.currency <> 'INR' AND ${IN_PERIOD}
      GROUP BY ${nameKey('q.client_name')}, NULLIF(${nameKey('q.sector')}, ''), q.currency, r.rate, r.effective_from
      ORDER BY currency, amount DESC, customer`,
    [from, to]
  );

  const converted = rows.filter((row) => row.rate !== null);
  return {
    rows,
    summary: {
      deals: rows.reduce((sum, row) => sum + row.deals, 0),
      amounts: sumAmounts([rows]),
      amount_inr: Math.round(converted.reduce((sum, row) => sum + row.amount_inr, 0) * 100) / 100,
      missing_rates: [...new Set(rows.filter((row) => row.rate === null).map((row) => row.currency))].sort(),
    },
  };
}

export const CLIENT_TYPES = { repeat: 'Repeat client', single: 'Single enquiry client' };

/**
 * Every client with an enquiry or a quotation in the period, listed once
 * however many of each they have.
 *
 * Enquiries are the rows on the Enquiries page; an enquiry that became a
 * quotation is still one enquiry, and its quotation counts only under POs
 * won / lost. A client is a repeat client with 2 or more won POs up to the
 * end of the period, so an order placed before the period still counts;
 * every other client is a single enquiry client.
 */
export async function customerReport({ from, to }) {
  const { rows } = await query(
    `WITH ${RATES},
     q AS (
       SELECT ${nameKey('client_name')}   AS client_key,
              btrim(client_name)           AS client_name,
              status = '${QUOTATION_STATUS.won}' AS is_won,
              status = '${QUOTATION_STATUS.lost}'              AS is_lost,
              quotation_value,
              currency,
              quotation_date,
              ${IN_PERIOD}                 AS in_period,
              ${UP_TO_END}                 AS up_to_end
         FROM quotations
     ),
     e AS (
       SELECT ${nameKey('client_name')} AS client_key,
              btrim(client_name)         AS client_name
         FROM enquiries
        WHERE ${inPeriod('enquiry_date')}
     ),
     clients AS (
       SELECT client_key, mode() WITHIN GROUP (ORDER BY client_name) AS client
         FROM (SELECT client_key, client_name FROM q WHERE in_period
               UNION ALL
               SELECT client_key, client_name FROM e) names
        GROUP BY client_key
     ),
     enquired AS (
       SELECT client_key, COUNT(*) AS enquiries FROM e GROUP BY client_key
     ),
     quoted AS (
       SELECT q.client_key,
              COUNT(*) FILTER (WHERE in_period AND is_won)                                AS pos,
              COUNT(*) FILTER (WHERE in_period AND is_lost)                               AS lost,
              COUNT(*) FILTER (WHERE up_to_end AND is_won)                                AS pos_to_date,
              COUNT(*) FILTER (WHERE in_period AND is_won AND quotation_value IS NULL)    AS pos_without_value,
              SUM(q.quotation_value * r.rate) FILTER (WHERE in_period AND is_won)         AS won_value_inr
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        GROUP BY q.client_key
     ),
     unconverted AS (
       SELECT q.client_key, q.currency, SUM(q.quotation_value) AS amount
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE in_period AND is_won AND q.quotation_value IS NOT NULL AND r.rate IS NULL
        GROUP BY 1, 2
     ),
     rates_used AS (
       SELECT q.client_key, q.currency, r.rate, r.effective_from
         FROM q
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE in_period AND is_won AND q.currency <> 'INR' AND r.rate IS NOT NULL
        GROUP BY 1, 2, 3, 4
     )
     SELECT c.client,
            COALESCE(en.enquiries, 0)::int                                  AS enquiries,
            COALESCE(qu.pos, 0)::int                                        AS pos,
            COALESCE(qu.lost, 0)::int                                       AS lost,
            COALESCE(qu.pos_to_date, 0)::int                                AS pos_to_date,
            GREATEST(COALESCE(qu.pos_to_date, 0) - 1, 0)::int               AS repeat_orders,
            COALESCE(qu.pos_without_value, 0)::int                          AS pos_without_value,
            ROUND(COALESCE(qu.won_value_inr, 0), 2)                         AS won_value_inr,
            ${amountsFor('unconverted', 'client_key', 'c.client_key')}      AS unconverted,
            ${ratesUsedFor('rates_used', 'client_key', 'c.client_key')}      AS rate_details
       FROM clients c
       LEFT JOIN quoted qu   ON qu.client_key = c.client_key
       LEFT JOIN enquired en ON en.client_key = c.client_key
      ORDER BY pos_to_date DESC, won_value_inr DESC, enquiries DESC, client`,
    [from, to]
  );

  for (const row of rows) {
    row.client_type = row.pos_to_date >= 2 ? CLIENT_TYPES.repeat : CLIENT_TYPES.single;
    row.win_rate = share(row.pos, row.pos + row.lost);
  }

  const summarise = (list) => {
    const total = (field) => list.reduce((sum, row) => sum + row[field], 0);
    return {
      clients: list.length,
      enquiries: total('enquiries'),
      pos: total('pos'),
      lost: total('lost'),
      win_rate: share(total('pos'), total('pos') + total('lost')),
      won_value_inr: Math.round(total('won_value_inr') * 100) / 100,
      repeat_orders: total('repeat_orders'),
      pos_without_value: total('pos_without_value'),
      unconverted: sumAmounts(list.map((row) => row.unconverted)),
    };
  };

  return {
    rows,
    summary: {
      repeat: summarise(rows.filter((row) => row.client_type === CLIENT_TYPES.repeat)),
      single: summarise(rows.filter((row) => row.client_type === CLIENT_TYPES.single)),
      total: summarise(rows),
    },
  };
}

// ---------------------------------------------------------------------
// CSV shapes — spreadsheet-friendly headers, one value column per currency
// ---------------------------------------------------------------------

function currenciesIn(rows) {
  return [...new Set(rows.flatMap((row) => row.amounts.map((a) => a.currency)))].sort(byCurrency);
}

function valueColumns(amounts, currencies) {
  return Object.fromEntries(
    currencies.map((c) => [`Won value (${c})`, amounts.find((a) => a.currency === c)?.amount ?? 0])
  );
}

export function sectorCsvRows({ rows }) {
  const currencies = currenciesIn(rows);
  return rows.map((row) => ({
    Sector: row.sector,
    Enquiries: row.enquiries,
    'POs won': row.pos,
    Lost: row.lost,
    Pipeline: row.pipeline,
    'Win %': row.win_rate === null ? '' : Math.round(row.win_rate * 1000) / 10,
    ...valueColumns(row.amounts, currencies),
    'FX deals': row.fx_deals,
    'POs with no value entered': row.pos_without_value,
  }));
}

export function fxCsvRows({ rows }) {
  return rows.map((row) => ({
    Client: row.customer,
    Sector: row.sector,
    Currency: row.currency,
    'Won POs': row.deals,
    'Won value': row.amount,
    'Rate (INR per unit)': row.rate ?? 'Not set',
    'Won value (INR)': row.amount_inr ?? '',
    'POs with no value entered': row.deals_without_value,
    Quotations: row.quotation_nos,
  }));
}

const notConverted = (list) => list.map((a) => `${a.currency} ${a.amount}`).join('; ');

export function customerCsvRows({ rows }) {
  return rows.map((row) => ({
    'Client group': row.client,
    Type: row.client_type,
    Enquiries: row.enquiries,
    'POs won': row.pos,
    Lost: row.lost,
    'Win %': row.win_rate === null ? '' : Math.round(row.win_rate * 1000) / 10,
    'Won value (INR)': row.won_value_inr,
    'Not in INR value (rate not set)': notConverted(row.unconverted),
    'Repeat orders': row.repeat_orders,
    'POs won to date': row.pos_to_date,
    'POs with no value entered': row.pos_without_value,
  }));
}
