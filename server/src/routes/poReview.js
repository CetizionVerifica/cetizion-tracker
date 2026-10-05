/**
 * Purchase orders read from email that were not registered automatically
 * (docs/email-po-plan.md §3.7): one queue, not silence.
 *
 *   GET  /api/purchase-orders/review                 the open items
 *   POST /api/purchase-orders/review/:id/register    read the PO again, and
 *        return what the Register PO dialog is filled with; the dialog then
 *        posts to /api/quotations/:key/register with review_id, which marks
 *        the item registered_by_hand
 *   POST /api/purchase-orders/review/:id/dismiss     "Not a PO"
 *   POST /api/purchase-orders/:poNumber/email-read-checked   the PO banner's "Mark checked"
 *
 * Admins see every item; a salesperson sees the items whose suggested
 * quotation is theirs. No PDF text is stored: the register action reads the
 * email again.
 */
import { Router } from 'express';
import { query, transaction } from '../db.js';
import { requireAdmin } from '../auth/middleware.js';
import { undoPo } from '../lib/mailbox/undoEntry.js';
import { purchaseOrderClause, scopeOf } from '../auth/ownership.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { ApiError } from '../middleware/error.js';
import * as autoPo from '../lib/mailbox/autoPurchaseOrder.js';
import { grossUp, stagesFromTerms } from '../lib/mailbox/pdfPurchaseOrder.js';
import { aiConfig, chatJSON } from '../lib/ai.js';
import { aiCallsToday } from '../lib/mailbox/autoEnquiry.js';
import { mainText } from '../lib/mailbox/enquiryDetect.js';
import { MAX_EMAIL_TEXT } from '../lib/mailbox/readLimits.js';
import { noteCorrection } from '../lib/mailbox/documentProfiles.js';

export const poReviewRouter = Router();

/** A review item read again is an AI call like any other: counted against the shared daily ceiling. */
export async function countAiCalls(n, purpose) {
  for (let i = 0; i < n; i += 1) await query('INSERT INTO email_ai_calls (purpose) VALUES ($1)', [purpose]);
}

/** The review rows this caller may see: admins all, sales the ones on their quotations, or read from their own mailbox (074). */
function scoped(req, params) {
  const scope = scopeOf(req);
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  return `AND (EXISTS (SELECT 1 FROM quotations q WHERE q.owner_user_id = $${params.length}
                        AND (q.quotation_no = ANY(COALESCE(d.suggested_quotations, '{}')) OR q.quotation_no = d.quotation_no))
            OR EXISTS (SELECT 1 FROM connected_accounts ma WHERE ma.id = d.account_id AND ma.user_id = $${params.length}))`;
}

async function item(req, id) {
  const params = [Number(id)];
  if (!Number.isSafeInteger(params[0])) throw new ApiError(404, 'Review item not found');
  const mine = scoped(req, params);
  const { rows: [d] } = await query(`SELECT d.* FROM email_po_decisions d WHERE d.id = $1 AND d.outcome = 'review' ${mine}`, params);
  if (!d) throw new ApiError(404, 'Review item not found');
  return d;
}

poReviewRouter.get('/review', async (req, res) => {
  const params = [];
  const mine = scoped(req, params);
  // A salesperson is offered only their own quotations: another person's
  // suggested for the same PO stays out of sight (#18 row scoping).
  const ownSuggestions = mine ? `AND q.owner_user_id = $${params.length}` : '';
  const { rows } = await query(
    `SELECT d.id, d.received_at, d.from_email, d.review_reason, d.review_note, d.document_type, d.confidence, d.thread_id, d.mode,
            a.email AS mailbox,
            COALESCE((SELECT json_agg(json_build_object('quotation_no', q.quotation_no, 'client_name', q.client_name,
                                                        'total', COALESCE(q.total, q.quotation_value), 'currency', q.currency, 'status', q.status)
                                      ORDER BY q.id)
                        FROM quotations q WHERE q.quotation_no = ANY(COALESCE(d.suggested_quotations, '{}')) ${ownSuggestions}), '[]') AS suggested
       FROM email_po_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'review' ${mine}
      ORDER BY d.received_at DESC NULLS LAST, d.id DESC`, params);
  res.json({ data: rows });
});

/**
 * Read the PO again and return the Register PO dialog's prefill. The AI's
 * reading is shown to a person who checks it before anything is saved, so
 * no bar applies here; the PDF is stored as an unattached upload, which the
 * daily purge removes if the dialog is never saved.
 */
poReviewRouter.post('/review/:id/register', async (req, res) => {
  const d = await item(req, req.params.id);
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [d.account_id]);
  const { rows: [msg] } = await query('SELECT * FROM email_messages WHERE account_id = $1 AND provider_id = $2', [d.account_id, d.provider_id]);
  const suggested = d.suggested_quotations || [];
  const base = { review_id: d.id, suggested_quotations: suggested, prefill: null };

  const chat = autoPo.deps.chat || (aiConfig.enabled ? (system, user, opts) => chatJSON(system, user, { title: 'Cetizion Tracker email purchase orders', ...opts }) : null);
  if (!chat || !account) return res.json({ data: { ...base, note: 'The PO could not be read again: enter it from the email.' } });
  const settings = await autoPo.poSettings();
  const ctx = { settings, aiUsed: await aiCallsToday() };
  if (ctx.aiUsed >= settings.dailyAiLimit) return res.json({ data: { ...base, note: 'Today\'s AI limit is reached: enter the PO from the email.' } });

  const m = {
    provider_id: d.provider_id, conversation_id: d.conversation_id, internet_message_id: d.internet_message_id,
    subject: msg?.subject || null, body_html: msg?.body_html || null, sent_at: d.received_at,
    from: { email: d.from_email || msg?.from_email || null, name: msg?.from_name || null },
    // Not stored for a dropped email: ask the mailbox.
    has_attachments: msg ? msg.has_attachments : true,
  };
  const before = ctx.aiUsed;
  const read = await autoPo.readPo(account, { m, c: { direction: 'inbound', external: [] } }, ctx, chat, mainText(m.body_html || '', MAX_EMAIL_TEXT));
  await countAiCalls(ctx.aiUsed - before, 'po_review_read');
  if (read.error || read.unreadable) return res.json({ data: { ...base, note: 'The PO could not be read again: enter it from the email.' } });
  const v = read.verdict;

  let documentId = null;
  if (read.pdf && autoPo.deps.upload) {
    try {
      documentId = (await autoPo.deps.upload({ buffer: read.pdf.content, fileName: read.pdf.name || 'purchase-order.pdf', contentType: 'application/pdf', owner: 'purchase-orders' })).id;
    } catch (err) {
      console.warn('[po-review] the PDF could not be stored:', err.message);
    }
  }
  const terms = stagesFromTerms(v.payment_terms_text);
  res.json({
    data: {
      ...base,
      prefill: {
        po_number: v.po_number, po_date: v.po_date, currency: v.currency || 'INR',
        // Including GST, as the tracker counts it.
        po_value: v.total_value ?? (v.basic_value ? grossUp(v.basic_value) : null),
        payment_terms_days: v.credit_days ?? 30, payment_terms_text: v.payment_terms_text,
        stages: terms.source === 'po_terms' ? terms.stages : null,
        project_manager: v.project_manager?.name || null, project_manager_email: v.project_manager?.email || null,
        planned_delivery_date: v.delivery_date, document_id: documentId,
        buyer: v.buyer?.company_name || null, our_quotation_ref: v.our_quotation_ref,
      },
    },
  });
});

poReviewRouter.post('/review/:id/dismiss', async (req, res) => {
  const d = await item(req, req.params.id);
  await query(
    `UPDATE email_po_decisions SET outcome = 'dismissed', decided_by = $2, settled_at = now() WHERE id = $1 AND outcome = 'review'`,
    [d.id, req.user?.name || req.user?.username || null]);
  res.json({ data: { id: d.id, outcome: 'dismissed' } });
});

/**
 * A PO registered from email has been checked against the client's PO by a
 * person: an event, in the activity log. From then on its stages are
 * chased like any other's (§3.8).
 */
poReviewRouter.post('/:poNumber/email-read-checked', async (req, res) => {
  const poNumber = decodeURIComponent(req.params.poNumber);
  const params = [poNumber];
  const mine = purchaseOrderClause(scopeOf(req), params, { alias: 'po' });
  const { rows: [po] } = await query(`SELECT po.po_number FROM purchase_orders po WHERE po.po_number = $1 ${mine ? `AND ${mine}` : ''}`, params);
  if (!po) throw new ApiError(404, 'Purchase order not found');
  if (!(await autoPo.poFromEmail(po.po_number))) throw new ApiError(422, 'This purchase order was not registered from an email');
  await logActivity(undefined, { actor: actorFrom(req.user), action: ACTIONS.PURCHASE_ORDER_EMAIL_READ_CHECKED, entityType: 'purchase_order', entityId: po.po_number });
  res.json({ data: await autoPo.poFromEmail(po.po_number) });
});

/**
 * Undo a PO registered automatically from email (docs/email-auto-entry-plan.md
 * §3.10): its stages, services and project removed, its quotation as it was.
 * Refused once anything has been recorded against it. Admins only: it
 * deletes records.
 */
poReviewRouter.post('/:poNumber/undo-from-email', requireAdmin, async (req, res) => {
  const poNumber = decodeURIComponent(req.params.poNumber);
  const removed = await transaction((db) => undoPo(db, poNumber, req.user?.name || req.user?.username || null));
  await logActivity(undefined, { actor: actorFrom(req.user), action: ACTIONS.PURCHASE_ORDER_EMAIL_UNDONE, entityType: 'purchase_order', entityId: poNumber, metadata: removed });
  res.json({ data: removed });
});

/**
 * A PO registered by hand from a review item: the item is settled, inside
 * the registration's transaction. Called by the register route.
 */
export async function settleReview(client, req, reviewId, { poNumber, quotationNo }) {
  const params = [reviewId];
  const mine = scoped(req, params);
  const { rowCount } = await client.query(
    `UPDATE email_po_decisions d SET outcome = 'registered_by_hand', po_number = $${params.length + 1}, quotation_no = $${params.length + 2},
            decided_by = $${params.length + 3}, settled_at = now()
      WHERE d.id = $1 AND d.outcome = 'review' ${mine}`,
    [...params, poNumber, quotationNo, req.user?.name || req.user?.username || null]);
  if (!rowCount) throw new ApiError(409, 'That review item is already settled');
  // A person did what the reader could not: counted against the client, towards a suggested document note (§6).
  const { rows: [r] } = await client.query(
    `SELECT pr.company_id, d.review_reason FROM email_po_decisions d JOIN purchase_orders p ON p.po_number = d.po_number JOIN projects pr ON pr.project_id = p.project_id WHERE d.id = $1`, [reviewId]);
  if (r) await noteCorrection(client, { companyId: r.company_id, docType: 'po', reason: r.review_reason, by: req.user?.name || req.user?.username || null });
}
