/**
 * A new version of a quotation (#23), shared by POST /api/quotations/:key/revise
 * and by generating a quotation from questionnaire answers (#208 phase 2),
 * so both keep, reset and record the same things.
 *
 *   reviseQuotation(client, q, { note, by })
 *     1. keeps the current version in quotation_revisions: its header
 *        fields and its lines exactly as they stand
 *     2. starts the next one: revision + 1, dated today with its validity
 *        reopened, not sent or accepted, a new approval round, and a Lost
 *        quotation back to Draft (the pipeline-stage trigger moves a sent or
 *        accepted card back with it)
 *     3. works the totals and the discount check out again
 *   and returns { revision, valid_until, quotation_date }.
 *
 * The caller has already locked the quotation (SELECT … FOR UPDATE), read
 * it from v_quotations within its reach, and refused one that may not be
 * revised; it records the event in its own words.
 */
import { businessToday } from './businessDate.ts';

export async function reviseQuotation(client, q, { note = null, by = null } = {}) {
  const { rows: lines } = await client.query('SELECT * FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
  const snapshot = { quotation_no: q.quotation_no, revision: q.revision, quotation_date: q.quotation_date, valid_until: q.valid_until, quotation_value: q.quotation_value, subtotal: q.subtotal, tax_total: q.tax_total, total: q.total, currency: q.currency, terms: q.terms, sent_at: q.sent_at, lines };
  await client.query('INSERT INTO quotation_revisions (quotation_id, revision, snapshot, note, created_by) VALUES ($1,$2,$3,$4,$5)', [q.id, q.revision, JSON.stringify(snapshot), note || null, by || null]);
  const { rows: [{ value: days }] } = await client.query(`SELECT value FROM settings WHERE key = 'quotation_validity_days'`).then((r) => ({ rows: r.rows.length ? r.rows : [{ value: '30' }] }));
  const today = businessToday();
  const { rows: [updated] } = await client.query(
    `UPDATE quotations SET revision = revision + 1, quotation_date = $2, valid_until = ($2::date + ($3::int || ' days')::interval)::date,
            sent_at = NULL, accepted_at = NULL, accepted_by_name = NULL,
            status = CASE WHEN status = 'Lost' THEN 'Draft' ELSE status END,
            -- a new version is a new approval round
            approval_status = 'not_needed', approval_reason = NULL, approval_requested_at = NULL,
            approval_requested_by = NULL, approval_decided_at = NULL, approved_by = NULL,
            approval_note = NULL, approved_discount_percent = NULL
      WHERE id = $1 RETURNING revision, valid_until, quotation_date`,
    [q.id, today, Number(days) || 30]
  );
  // The discount check runs again on the new version.
  await client.query('SELECT quotation_totals($1)', [q.id]);
  return updated;
}
