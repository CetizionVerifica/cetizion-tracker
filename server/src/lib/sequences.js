import { query } from '../db.js';
import { businessToday } from './businessDate.js';

const SEQUENCES = {
  enquiry: { table: 'enquiries', column: 'enquiry_no', pattern: 'CTZ/ENQ/{year}/{n:3}' },
  quotation: { table: 'quotations', column: 'quotation_no', pattern: 'CTZ/QT/{year}/{n:3}' },
  project: { table: 'projects', column: 'project_id', pattern: 'PRJ-{year}-{n:3}' },
  travel: { table: 'travel_logs', column: 'travel_id', pattern: 'TRV-{year}-{n:3}' },
  claim: { table: 'employee_expense_claims', column: 'claim_id', pattern: 'CLM-{year}-{n:3}' },
  vendor_invoice: {
    table: 'travel_vendor_invoices',
    column: 'vendor_invoice_id',
    pattern: 'VINV-{year}-{n:3}',
  },
};

export const isSequence = (kind) => Object.hasOwn(SEQUENCES, kind);

/** The column a series numbers, e.g. enquiry_no. */
export const sequenceColumn = (kind) => SEQUENCES[kind].column;

/**
 * Take the next reference in a series for a record being created. Call it
 * inside the transaction that inserts the record: saves in the same series
 * wait for each other, so two can never be handed the same number.
 *
 * Pass an explicit year string (e.g. '2025') for historical records whose
 * date falls in a different year than today. Omit it to use the current
 * business year (existing behaviour for all normal creates).
 */
export async function claimNextId(kind, client, year) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SEQUENCES[kind].column]);
  return nextId(kind, client, year);
}

/**
 * The next reference in a series (CTZ/QT/2026/063, PRJ-2026-008). Pass a
 * transaction client to read the series inside that transaction.
 *
 * year — optional 4-digit string (e.g. '2025'). Defaults to the current
 *         business year when omitted.
 */
export async function nextId(kind, client = { query }, year) {
  const spec = SEQUENCES[kind];
  // Use the explicitly requested year, or fall back to the business's current year.
  // On 1 January before 05:30 IST the server's UTC clock still says last year,
  // so businessToday() is always used rather than new Date().getFullYear().
  const resolvedYear = year ?? businessToday().slice(0, 4);
  const prefix = spec.pattern.replace('{year}', resolvedYear).replace(/\{n:\d+\}$/, '');
  const width = Number(/\{n:(\d+)\}/.exec(spec.pattern)?.[1] || 3);

  const { rows } = await client.query(
    `SELECT ${spec.column} AS value FROM ${spec.table} WHERE ${spec.column} LIKE $1`,
    [`${prefix}%`]
  );

  const highest = rows.reduce((max, r) => {
    const tail = String(r.value).slice(prefix.length);
    const n = /^\d+$/.test(tail) ? Number(tail) : 0;
    return Math.max(max, n);
  }, 0);

  return `${prefix}${String(highest + 1).padStart(width, '0')}`;
}
