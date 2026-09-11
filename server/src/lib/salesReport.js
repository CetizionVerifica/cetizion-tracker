import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

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

/** SQL grouping key for a free-text name: same spelling, same group. */
export const nameKey = (column) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;

// $1 = from, $2 = to, either null for an open end. A quotation with no date
// cannot be placed in a period, so it only counts when neither end is set.
const IN_PERIOD = `COALESCE(($1::date IS NULL OR quotation_date >= $1::date)
                        AND ($2::date IS NULL OR quotation_date <= $2::date), false)`;

const UP_TO_END = `COALESCE($2::date IS NULL OR quotation_date <= $2::date, false)`;

/** Won value per currency as [{ currency, amount }] — never summed across currencies. */
const amountsFor = (table, key, outerKey) => `
  COALESCE((
    SELECT json_agg(json_build_object('currency', a.currency, 'amount', a.amount)
                    ORDER BY a.currency <> 'INR', a.currency)
      FROM ${table} a
     WHERE a.${key} IS NOT DISTINCT FROM ${outerKey}
  ), '[]'::json)`;

const byCurrency = (a, b) => (a === 'INR' ? -1 : b === 'INR' ? 1 : a.localeCompare(b));

const isIsoDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
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

/** Won POs per sector, with how many distinct customers placed them. */
export async function sectorReport({ from, to }) {
  const { rows } = await query(
    `WITH won AS (
       SELECT NULLIF(${nameKey('sector')}, '') AS sector_key,
              NULLIF(btrim(sector), '')         AS sector,
              ${nameKey('client_name')}          AS client_key,
              quotation_value,
              currency
         FROM quotations
        WHERE status = 'Won - PO Received' AND ${IN_PERIOD}
     ),
     by_currency AS (
       SELECT sector_key, currency, SUM(quotation_value) AS amount
         FROM won
        WHERE quotation_value IS NOT NULL
        GROUP BY 1, 2
     )
     SELECT COALESCE(mode() WITHIN GROUP (ORDER BY w.sector), 'Not set') AS sector,
            w.sector_key IS NULL                                          AS not_set,
            COUNT(*)::int                                                 AS pos,
            COUNT(DISTINCT w.client_key)::int                             AS customers,
            COUNT(*) FILTER (WHERE w.quotation_value IS NULL)::int        AS pos_without_value,
            ${amountsFor('by_currency', 'sector_key', 'w.sector_key')}    AS amounts
       FROM won w
      GROUP BY w.sector_key
      ORDER BY w.sector_key IS NULL, pos DESC, sector`,
    [from, to]
  );

  const totals = new Map();
  for (const row of rows) {
    for (const { currency, amount } of row.amounts) {
      totals.set(currency, Math.round(((totals.get(currency) || 0) + amount) * 100) / 100);
    }
  }

  return {
    rows,
    summary: {
      pos: rows.reduce((sum, row) => sum + row.pos, 0),
      sectors: rows.filter((row) => !row.not_set).length,
      pos_without_sector: rows.find((row) => row.not_set)?.pos ?? 0,
      amounts: [...totals.keys()].sort(byCurrency).map((currency) => ({
        currency,
        amount: totals.get(currency),
      })),
    },
  };
}

/**
 * Every customer who was quoted in the period. Their type looks at all won
 * orders up to the end of the period, so a client whose earlier order falls
 * before the period still counts as repeat when they order again.
 */
export async function customerReport({ from, to }) {
  const { rows } = await query(
    `WITH q AS (
       SELECT ${nameKey('client_name')}    AS client_key,
              btrim(client_name)            AS client_name,
              NULLIF(btrim(sector), '')     AS sector,
              quotation_date,
              quotation_value,
              currency,
              status = 'Won - PO Received'  AS won,
              ${IN_PERIOD}                  AS in_period,
              ${UP_TO_END}                  AS up_to_end
         FROM quotations
     ),
     by_currency AS (
       SELECT client_key, currency, SUM(quotation_value) AS amount
         FROM q
        WHERE won AND in_period AND quotation_value IS NOT NULL
        GROUP BY 1, 2
     ),
     customers AS (
       SELECT client_key,
              mode() WITHIN GROUP (ORDER BY client_name)       AS customer,
              mode() WITHIN GROUP (ORDER BY sector)            AS sector,
              COUNT(*) FILTER (WHERE in_period)::int           AS quotations,
              COUNT(*) FILTER (WHERE in_period AND won)::int   AS orders,
              COUNT(*) FILTER (WHERE up_to_end AND won)::int   AS orders_to_date,
              MAX(quotation_date) FILTER (WHERE in_period)     AS last_quotation_date
         FROM q
        GROUP BY client_key
       HAVING COUNT(*) FILTER (WHERE in_period) > 0
     )
     SELECT c.customer,
            COALESCE(c.sector, 'Not set')                      AS sector,
            CASE WHEN c.orders_to_date >= 2 THEN 'Repeat customer'
                 WHEN c.orders_to_date = 1  THEN 'New customer'
                 ELSE 'No order yet' END                       AS customer_type,
            c.quotations,
            c.orders,
            c.orders_to_date,
            c.last_quotation_date,
            ${amountsFor('by_currency', 'client_key', 'c.client_key')} AS amounts
       FROM customers c
      ORDER BY LEAST(c.orders_to_date, 2) DESC, c.orders DESC, c.customer`,
    [from, to]
  );

  const count = (type) => rows.filter((row) => row.customer_type === type).length;
  return {
    rows,
    summary: {
      customers: rows.length,
      repeat: count('Repeat customer'),
      new: count('New customer'),
      no_order: count('No order yet'),
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
    'Won POs': row.pos,
    Customers: row.customers,
    ...valueColumns(row.amounts, currencies),
    'POs with no value entered': row.pos_without_value,
  }));
}

export function customerCsvRows({ rows }) {
  const currencies = currenciesIn(rows);
  return rows.map((row) => ({
    Customer: row.customer,
    Sector: row.sector,
    Type: row.customer_type,
    Quotations: row.quotations,
    Won: row.orders,
    'Won to date': row.orders_to_date,
    ...valueColumns(row.amounts, currencies),
    'Last quotation': row.last_quotation_date,
  }));
}
