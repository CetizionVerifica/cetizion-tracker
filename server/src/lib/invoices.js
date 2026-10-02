/**
 * Recording an invoice on a payment stage: the body of
 * POST /api/payment-stages/:id/invoice, shared with the email reader
 * (docs/email-po-plan.md §3.10.4) so both record an invoice the same way.
 *
 * In the tracker an invoice is a payment stage with an invoice number, an
 * invoice date and a document. Its amount is not stored: it is the stage's
 * share of the PO value.
 */
import { claimAttachment } from './documents.js';
import { claimNextId, financialYear } from './sequences.js';
import { parentClause, UNRESTRICTED } from '../auth/ownership.js';
import { ApiError } from '../middleware/error.js';

/** An invoice number as compared in SQL: case, spaces and dashes ignored (invoiceDetect.normaliseInvoiceNo). */
export const NORMALISED_INVOICE_NO = (column = 'invoice_no') => `lower(regexp_replace(${column}, '[[:space:]-]', '', 'g'))`;

/**
 * Runs inside the caller's transaction.
 *
 *   stageId, invoiceDate         required
 *   invoiceNo                    as printed; omitted, the next CVPL/{fy}/n
 *                                is claimed. A printed number in that series
 *                                is never issued again: the claim reads the
 *                                highest number already in the column.
 *   documentId                   the invoice PDF, claimed for the stage
 *   keepExistingDocument         the email reader's rule: a stage that has
 *                                a document keeps it (§3.10.4)
 *   scope                        the caller's reach; omitted, every stage
 *   mode                         'history': no invoice.issued webhook
 *
 * Returns { id, invoice_no, replaced, document_kept_existing }.
 */
export async function recordInvoice(client, { stageId, invoiceNo = null, invoiceDate, documentId, keepExistingDocument = false, scope = UNRESTRICTED, mode = 'live' }) {
  if (mode === 'history') {
    // For this transaction only: webhook_emit() stays quiet (067).
    await client.query(`SELECT set_config('app.suppress_webhooks', 'on', true)`);
  }
  // Locked and scoped in one statement: the stage is only this user's if
  // the purchase order above it is (#18 Phase 2C).
  const params = [Number(stageId)];
  const mine = parentClause(scope, params, { kind: 'via_po', alias: 'ps' });
  const { rows: [stage] } = await client.query(
    `SELECT ps.id, ps.document_id FROM payment_stages ps
      WHERE ps.id = $1 ${mine ? `AND ${mine}` : ''} FOR UPDATE`,
    params
  );
  if (!stage) throw new ApiError(404, 'Payment stage not found');

  // No file chosen keeps the invoice document already attached; a new one
  // replaces it — except for the email reader, which never replaces one.
  const kept = keepExistingDocument && stage.document_id !== null && documentId !== undefined && documentId !== null;
  const { documentId: finalDocument, replaced } = kept
    ? { documentId: stage.document_id, replaced: null }
    : await claimAttachment(client, { current: stage.document_id, requested: documentId });

  // Claimed here, inside the transaction, so concurrent callers queue for
  // the number instead of being handed the same one. The financial year
  // comes from the invoice's own date, not from today: an invoice dated
  // 28 March belongs to the year that is ending, whenever it is entered.
  const number = invoiceNo ?? await claimNextId('invoice', client, financialYear(invoiceDate));

  await client.query(
    'UPDATE payment_stages SET invoice_no = $1, invoice_date = $2, document_id = $3 WHERE id = $4',
    [number, invoiceDate, finalDocument, stage.id]
  );
  return { id: stage.id, invoice_no: number, replaced, document_kept_existing: kept };
}

/**
 * A stage whose invoice was recorded from past mail (history mode), and
 * that nobody has touched since: no payment recorded, and its PO not marked
 * checked. Its invoice is very likely paid already, outside the tracker, so
 * neither the client reminders nor the owner follow-ups chase it (§3.10.4,
 * decision 9). Derived from the decision log; nothing is stored on the stage.
 */
export const UNTOUCHED_HISTORY_INVOICE = (alias) => `(EXISTS (SELECT 1 FROM email_invoice_decisions d
      WHERE d.stage_id = ${alias}.id AND d.outcome = 'recorded' AND d.mode = 'history')
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.stage_id = ${alias}.id)
  AND NOT EXISTS (SELECT 1 FROM activity_log l WHERE l.action = 'purchase_order.email_read_checked'
                    AND l.entity_type = 'purchase_order' AND l.entity_id = ${alias}.po_number))`;
