/**
 * Reading the sales journey (server layer §1, §4, §6): which sales a caller
 * may see, the owner and service filters, each value in rupees, and the
 * thresholds from Settings. Plain functions over a `db` (anything with
 * `.query`), so a test can pass its own client. What a row means is decided
 * in steps.js, never here.
 *
 * Every value from a request is a parameter. Nothing is interpolated except
 * column aliases taken from fixed maps in this file.
 */
import { purchaseOrderClause } from '../../auth/ownership.js';
import { RATES, rateOn } from '../salesReport.js';
import { JOURNEY_SETTINGS } from './steps.js';

/**
 * The sales this scope may see, as a predicate over v_sales_journey, or ''
 * when it sees them all.
 *
 * A sale is yours when you own any record in it: its enquiry, its quotation,
 * or the project one of its live POs sits under (spec D7) — the same reach
 * `scopedSources` gives a PO through its quotation or its project. A sale
 * whose records are all unowned is nobody's, and only an admin sees it, as
 * everywhere else (auth/ownership.js). The one parameter is referenced three
 * times on purpose: one value, three places.
 */
export function journeyClause(scope, params, { alias = 'j' } = {}) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  const n = params.length;
  return `(${alias}.enquiry_owner_id = $${n} OR ${alias}.quotation_owner_id = $${n} OR $${n} = ANY(${alias}.project_owner_ids))`;
}

/**
 * Whether this scope may open every live PO in the sale, by the rule each
 * PO's own page uses (purchaseOrderClause: the owner of the quotation the PO
 * names, or of the project it sits under), as a column for reachableSteps.
 * Not the sale's reach: a PO with no quotation number joins its project's
 * quotation here, and that quotation's owner cannot open it, and owning one
 * PO's project does not open the others whose figures the step adds up.
 */
export function poReachColumn(scope, params) {
  const each = purchaseOrderClause(scope, params, { alias: 'rp' });
  if (!each) return 'true AS po_reachable';
  return `COALESCE((SELECT bool_and(${each}) FROM purchase_orders rp WHERE rp.po_number = ANY(j.po_numbers)), false) AS po_reachable`;
}

/**
 * The five thresholds, as numbers. Read through setting_num, the rule every
 * view already uses, so a missing, blank or unreadable value falls back to
 * its default rather than to zero (which would call every sale stuck).
 */
export async function journeySettings(db) {
  const params = [];
  const columns = Object.entries(JOURNEY_SETTINGS).map(([name, { key, fallback }]) => {
    params.push(key, fallback);
    return `setting_num($${params.length - 1}::text, $${params.length}::numeric) AS ${name}`;
  });
  const { rows: [row] } = await db.query(`SELECT ${columns.join(', ')}`, params);
  return Object.fromEntries(Object.keys(JOURNEY_SETTINGS).map((name) => [name, Number(row[name])]));
}

/**
 * Journey rows with the three values a card can show converted to INR, the
 * way lib/pipeline.js converts: at the rate in force on the record's own date
 * (RATES / rateOn), null when there is none. A sale's POs are converted one
 * by one at each PO's own date, so a sale ordered in two currencies still has
 * a value in rupees; one PO without a rate leaves that value unknown rather
 * than short.
 */
async function selectJourneys(db, { ctes = '', where = [], extra = '', tail = '' }, params) {
  const { rows } = await db.query(
    `WITH ${RATES}${ctes}
     SELECT j.*,
            round(j.enquiry_estimated_value * re.rate, 2) AS enquiry_value_inr,
            round(j.quotation_value * rq.rate, 2) AS quotation_value_inr,
            pv.po_value_inr${extra}
       FROM v_sales_journey j
       ${rateOn('re', 'j.enquiry_currency', 'j.enquiry_date')}
       ${rateOn('rq', 'j.quotation_currency', 'j.quotation_date')}
       LEFT JOIN LATERAL (
         SELECT CASE WHEN bool_and(pr.rate IS NOT NULL) THEN round(SUM(p.po_value * pr.rate), 2) END AS po_value_inr
           FROM purchase_orders p ${rateOn('pr', 'p.currency', 'p.po_date')}
          WHERE p.po_number = ANY(j.po_numbers)
       ) pv ON true
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ${tail}`,
    params
  );
  return rows;
}

/**
 * Every sale this scope may see, narrowed by the board's owner and service
 * filters (exact, as Pipeline's sales_person filter is). The board's other
 * switches depend on each sale's state and are applied in steps.js.
 */
export async function journeyRows(db, scope, filters = {}) {
  const params = [];
  const where = [];
  const extra = `, ${poReachColumn(scope, params)}`;
  const mine = journeyClause(scope, params);
  if (mine) where.push(mine);
  if (filters.sales_person) { params.push(String(filters.sales_person)); where.push(`j.sales_person = $${params.length}`); }
  if (filters.service) { params.push(String(filters.service)); where.push(`j.service = $${params.length}`); }
  return selectJourneys(db, { where, extra }, params);
}

/**
 * The record a page names, by its own number, or by its id when no record
 * carries that number — the same reading the generic resource routes give a
 * key (lib/crud.js). `k` is the placeholder holding what was asked for.
 */
const byKey = (table, returned, number, k) =>
  `SELECT ${returned} FROM ${table}
    WHERE ${number} = ${k} OR (id::text = ${k} AND NOT EXISTS (SELECT 1 FROM ${table} WHERE ${number} = ${k}))`;

/**
 * How each kind of record finds the one sale holding it. An enquiry, a
 * quotation and a live PO are each in exactly one. A project can carry
 * several quotations, so its sale is the one with its won quotation, else
 * its newest; with none, the sale of its lowest-id live PO (server layer §2).
 */
export const OF_KINDS = {
  enquiry: { match: (k) => `j.enquiry_id IN (${byKey('enquiries', 'id', 'enquiry_no', k)})` },
  quotation: { match: (k) => `j.quotation_id IN (${byKey('quotations', 'id', 'quotation_no', k)})` },
  po: { match: (k) => `j.po_numbers && ARRAY(${byKey('purchase_orders', 'po_number', 'po_number', k)})` },
  project: {
    ctes: (k) => `, target AS (${byKey('projects', 'project_id', 'project_id', k)})`,
    match: () => `j.project_id IN (SELECT project_id FROM target) AND j.anchor IN ('quotation', 'po')`,
    order: `ORDER BY (j.anchor = 'quotation') DESC, (j.quotation_status = 'Won - PO Received') DESC,
                     j.quotation_id DESC NULLS LAST, j.first_po_id`,
  },
};

/**
 * The sale holding one record, or null when none does or this scope may not
 * reach it. Which sale holds a record is decided first and for everyone
 * alike; only then is it checked against the caller, so a project page shows
 * the same sale to whoever opens it, and a refusal looks exactly like a miss.
 */
export async function journeyOfRecord(db, scope, kind, value) {
  const of = OF_KINDS[kind];
  if (!of) throw new Error(`Unknown record kind: ${kind}`);
  const params = [String(value)];
  const k = '$1';
  const mine = journeyClause(scope, params);
  const [row] = await selectJourneys(db, {
    ctes: of.ctes ? of.ctes(k) : '',
    where: [of.match(k)],
    extra: `, ${mine || 'true'} AS reachable, ${poReachColumn(scope, params)}`,
    tail: `${of.order || ''} LIMIT 1`,
  }, params);
  if (!row?.reachable) return null;
  delete row.reachable;
  return row;
}
