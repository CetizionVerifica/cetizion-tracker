/**
 * Invoices we emailed that were not recorded automatically
 * (docs/email-po-plan.md §3.10.5): the "Invoices to review" tab.
 *
 *   GET  /api/payment-stages/invoice-review                the open items
 *   POST /api/payment-stages/invoice-review/:id/record     read the invoice
 *        again and return what the invoice dialog is filled with; the dialog
 *        then posts to /api/payment-stages/:id/invoice with review_id, which
 *        marks the item recorded_by_hand
 *   POST /api/payment-stages/invoice-review/:id/dismiss    "Not an invoice"
 *
 * Admins see every item; a salesperson sees the items on POs they may open.
 * An item matched to no PO is an admin's.
 */
import { Router } from 'express';
import { query } from '../db.js';
import { purchaseOrderClause, scopeOf } from '../auth/ownership.js';
import { ApiError } from '../middleware/error.js';
import * as autoInvoice from '../lib/mailbox/autoInvoice.js';
import { aiCallsToday } from '../lib/mailbox/autoEnquiry.js';
import { aiConfig, chatJSON } from '../lib/ai.js';
import { mainText } from '../lib/mailbox/enquiryDetect.js';
import { buildInvoicePrompt, parseInvoiceVerdict, rankInvoicePdfs } from '../lib/mailbox/invoiceDetect.js';
import { readWithAi } from '../lib/mailbox/readAttachment.js';

export const invoiceReviewRouter = Router();

/** The rows this caller may see: admins all, sales the ones on POs they may open. */
function scoped(req, params) {
  const scope = scopeOf(req);
  if (scope.unrestricted) return '';
  return `AND EXISTS (SELECT 1 FROM purchase_orders po WHERE po.po_number = d.po_number
                        AND ${purchaseOrderClause(scope, params, { alias: 'po' })})`;
}

async function item(req, id) {
  const params = [Number(id)];
  if (!Number.isSafeInteger(params[0])) throw new ApiError(404, 'Review item not found');
  const mine = scoped(req, params);
  const { rows: [d] } = await query(`SELECT d.* FROM email_invoice_decisions d WHERE d.id = $1 AND d.outcome = 'review' ${mine}`, params);
  if (!d) throw new ApiError(404, 'Review item not found');
  return d;
}

invoiceReviewRouter.get('/invoice-review', async (req, res) => {
  const params = [];
  const mine = scoped(req, params);
  const { rows } = await query(
    `SELECT d.id, d.sent_at, d.to_emails, d.review_reason, d.document_type, d.confidence, d.thread_id, d.mode, d.invoice_no, d.po_number,
            a.email AS mailbox,
            COALESCE((SELECT json_agg(json_build_object('id', s.id, 'stage_no', s.stage_no, 'stage_name', s.stage_name, 'stage_amount', s.stage_amount,
                                                        'invoice_no', s.invoice_no, 'currency', s.currency) ORDER BY s.stage_no)
                        FROM v_payment_stages s WHERE s.po_number = d.po_number), '[]') AS stages
       FROM email_invoice_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'review' ${mine}
      ORDER BY d.sent_at DESC NULLS LAST, d.id DESC`, params);
  res.json({ data: rows });
});

/**
 * Read the invoice again and return the invoice dialog's prefill: number,
 * date, the PDF (stored as an unattached upload, purged if never saved) and
 * the stage suggested — the one the item names, else the PO's first open
 * stage. A person checks it before anything is saved.
 */
invoiceReviewRouter.post('/invoice-review/:id/record', async (req, res) => {
  const d = await item(req, req.params.id);
  const { rows: [account] } = await query('SELECT * FROM connected_accounts WHERE id = $1', [d.account_id]);
  const { rows: [msg] } = await query('SELECT * FROM email_messages WHERE account_id = $1 AND provider_id = $2', [d.account_id, d.provider_id]);
  const { rows: [open] } = await query(
    `SELECT id FROM payment_stages WHERE po_number = $1 AND invoice_no IS NULL ORDER BY stage_no LIMIT 1`, [d.po_number]);
  const base = { review_id: d.id, po_number: d.po_number, suggested_stage_id: d.stage_id ?? open?.id ?? null, prefill: null };

  const chat = autoInvoice.deps.chat || (aiConfig.enabled ? (system, user, opts) => chatJSON(system, user, { title: 'Cetizion Tracker email invoices', ...opts }) : null);
  if (!chat || !account) return res.json({ data: { ...base, prefill: { invoice_no: d.invoice_no }, note: 'The invoice could not be read again: enter it from the email.' } });
  const settings = await autoInvoice.invoiceSettings();
  const ctx = { settings, aiUsed: await aiCallsToday() };
  if (ctx.aiUsed >= settings.dailyAiLimit) return res.json({ data: { ...base, prefill: { invoice_no: d.invoice_no }, note: 'Today\'s AI limit is reached: enter the invoice from the email.' } });

  const m = { provider_id: d.provider_id, subject: msg?.subject || null, body_html: msg?.body_html || null, sent_at: d.sent_at, has_attachments: true };
  const read = await readWithAi(account, { m, c: { direction: 'outbound', external: [] } }, ctx, chat, {
    rank: rankInvoicePdfs, parse: parseInvoiceVerdict, fileName: 'invoice.pdf',
    prompt: ({ pdfText }) => buildInvoicePrompt({ pdfText, emailSubject: m.subject, emailText: mainText(m.body_html || '', 2000), sentAt: m.sent_at, to: (d.to_emails || []).map((email) => ({ email })) }),
  });
  if (read.error || read.unreadable) return res.json({ data: { ...base, prefill: { invoice_no: d.invoice_no }, note: 'The invoice could not be read again: enter it from the email.' } });
  const v = read.verdict;
  let documentId = null;
  if (read.pdf && autoInvoice.deps.upload) {
    try {
      documentId = (await autoInvoice.deps.upload({ buffer: read.pdf.content, fileName: read.pdf.name || 'invoice.pdf', contentType: 'application/pdf', owner: 'payment-stages' })).id;
    } catch (err) {
      console.warn('[invoice-review] the PDF could not be stored:', err.message);
    }
  }
  res.json({
    data: {
      ...base,
      prefill: {
        invoice_no: v.invoice_no ?? d.invoice_no, invoice_date: v.invoice_date, document_id: documentId,
        total_value: v.total_value, currency: v.currency || 'INR', po_reference: v.po_reference, stage_hint: v.stage_hint,
      },
    },
  });
});

invoiceReviewRouter.post('/invoice-review/:id/dismiss', async (req, res) => {
  const d = await item(req, req.params.id);
  await query(
    `UPDATE email_invoice_decisions SET outcome = 'dismissed', decided_by = $2, settled_at = now() WHERE id = $1 AND outcome = 'review'`,
    [d.id, req.user?.name || req.user?.username || null]);
  res.json({ data: { id: d.id, outcome: 'dismissed' } });
});

/**
 * An invoice recorded by hand from a review item: the item is settled,
 * inside the recording's transaction. Called by the invoice route.
 */
export async function settleInvoiceReview(client, req, reviewId, { stageId, invoiceNo }) {
  const params = [reviewId];
  const mine = scoped(req, params);
  const { rows: [po] } = await client.query('SELECT po_number FROM payment_stages WHERE id = $1', [stageId]);
  const { rowCount } = await client.query(
    `UPDATE email_invoice_decisions d SET outcome = 'recorded_by_hand', stage_id = $${params.length + 1}, invoice_no = $${params.length + 2},
            po_number = $${params.length + 3}, decided_by = $${params.length + 4}, settled_at = now()
      WHERE d.id = $1 AND d.outcome = 'review' ${mine}`,
    [...params, stageId, invoiceNo, po?.po_number ?? null, req.user?.name || req.user?.username || null]);
  if (!rowCount) throw new ApiError(409, 'That review item is already settled');
}
