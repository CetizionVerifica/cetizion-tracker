import { query } from '../db.js';

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

/**
 * The next reference in a series (CTZ/QT/2026/063, PRJ-2026-008). Pass a
 * transaction client to read the series inside that transaction.
 */
export async function nextId(kind, client = { query }) {
  const spec = SEQUENCES[kind];
  const year = String(new Date().getFullYear());
  const prefix = spec.pattern.replace('{year}', year).replace(/\{n:\d+\}$/, '');
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
