import { query } from '../db.js';

/**
 * What Cetizion owes travel vendors, aged (#76).
 *
 * The rows and the buckets both come from v_vendor_invoice_ageing, which
 * builds on the vendor invoice view, so every figure matches the Vendor
 * invoices page. The page and its CSV both read payablesRows(), so what
 * leaves as a spreadsheet is what the page shows, in the same order.
 * Vendor bills are recorded in rupees; nothing here mixes currencies.
 */

/** Every bucket, in reading order: aged first, then the two gaps. */
export const BUCKETS = ['not due', '0-30', '31-60', '61-90', '90+', 'date missing', 'amount missing'];

/** Longest overdue first; bills that cannot be aged after those that can. */
export async function payablesRows() {
  const { rows } = await query(`
    SELECT id, vendor_invoice_id, vendor_invoice_no, travel_id, travel_vendor, employee_name,
           client_name, invoice_date, invoice_amount, amount_paid, outstanding, pay_by,
           payment_status, days_overdue, bucket
      FROM v_vendor_invoice_ageing
     ORDER BY days_overdue DESC, pay_by NULLS LAST, invoice_date NULLS LAST, vendor_invoice_id`);
  return rows;
}

/**
 * A count and an outstanding sum for every bucket — zero rows included, so
 * the summary always has the same seven cards. "amount missing" has a count
 * and no sum: those bills are a gap, never zero.
 *
 * Separate from payables() because the MCP tool wants the totals beside a
 * single page of rows rather than beside all of them, and a second copy of
 * this GROUP BY is a second answer to "what do we owe".
 */
export async function payablesSummary() {
  const { rows: grouped } = await query(`
    SELECT bucket,
           COUNT(*)::int                     AS invoices,
           COALESCE(SUM(outstanding), 0)     AS outstanding
      FROM v_vendor_invoice_ageing
     GROUP BY bucket`);
  const byBucket = new Map(grouped.map((row) => [row.bucket, row]));
  const buckets = BUCKETS.map((bucket) => ({
    bucket,
    invoices: byBucket.get(bucket)?.invoices ?? 0,
    outstanding: bucket === 'amount missing' ? null : byBucket.get(bucket)?.outstanding ?? 0,
  }));
  const total = buckets.reduce((sum, b) => sum + (b.outstanding ?? 0), 0);
  return {
    buckets,
    total_outstanding: Math.round(total * 100) / 100,
    amount_missing: byBucket.get('amount missing')?.invoices ?? 0,
  };
}

/** Every row, with the bucket summary beside it. What the page reads. */
export async function payables() {
  const [rows, summary] = await Promise.all([payablesRows(), payablesSummary()]);
  return { rows, ...summary };
}
