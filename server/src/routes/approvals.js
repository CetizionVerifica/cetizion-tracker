/**
 * Discount and exception approvals on quotations (#46):
 *
 *   POST /api/quotations/:key/approval/request  { reason }            put an exception up for approval
 *   POST /api/quotations/:key/approval/decide   { decision, note }    approved | rejected
 *
 * A discount above the Settings threshold goes to pending on its own when
 * the lines change (quotation_totals). Either way the approver is emailed,
 * and the sales person hears the decision. Until approved, the quotation
 * cannot be sent.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { approvalDecision, approvalRequest } from '../lib/emailTemplates.js';
import { sendMail } from '../lib/mail.js';

export const approvalRouter = Router();

async function load(key) {
  const { rows } = await query('SELECT * FROM v_quotations WHERE quotation_no = $1 OR (id::text = $1 AND NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_no = $1))', [decodeURIComponent(key)]);
  if (!rows.length) throw new ApiError(404, 'Quotation not found');
  return rows[0];
}

async function approverEmail() {
  const { rows } = await query(`SELECT key, value FROM settings WHERE key IN ('approver_email', 'finance_email')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return s.approver_email || s.finance_email || null;
}

const requestSchema = z.object({ reason: z.string().trim().min(1, 'Say what needs approving').max(1000) });

approvalRouter.post('/:key/approval/request', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: { reason: parsed.error.issues[0].message } });
  const q = await load(req.params.key);
  const { rows: [u] } = await query(
    `UPDATE quotations SET approval_status = 'pending', approval_reason = $2, approval_requested_at = now(), approval_requested_by = $3,
            approval_decided_at = NULL, approved_by = NULL, approval_note = NULL, approved_discount_percent = NULL
      WHERE id = $1 RETURNING approval_status, approval_requested_at`, [q.id, parsed.data.reason, req.user?.username || 'admin']);
  const to = await approverEmail();
  let email = null;
  if (to) {
    email = await sendMail({ ...approvalRequest({ quotation: q, reason: parsed.data.reason, requestedBy: req.user?.username }), to, template: 'approval_request', entity: 'quotation', entityId: q.quotation_no, sentBy: req.user?.username || 'admin' });
  }
  res.json({ data: { ...u, email: email && { status: email.status, reason: email.reason } } });
});

const decideSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().max(1000).optional().default('') });

approvalRouter.post('/:key/approval/decide', async (req, res) => {
  const parsed = decideSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Pick approved or rejected');
  const q = await load(req.params.key);
  if (q.approval_status !== 'pending') throw new ApiError(422, 'Nothing is waiting for approval on this quotation');
  const { rows: [u] } = await query(
    `UPDATE quotations SET approval_status = $2, approval_decided_at = now(), approved_by = $3, approval_note = $4,
            approved_discount_percent = CASE WHEN $2 = 'approved' THEN discount_percent ELSE NULL END
      WHERE id = $1 RETURNING approval_status, approval_decided_at, approved_by, approval_note`,
    [q.id, parsed.data.decision, req.user?.username || 'admin', parsed.data.note || null]);
  let email = null;
  if (q.sales_person_email) {
    email = await sendMail({ ...approvalDecision({ quotation: q, decision: parsed.data.decision, note: parsed.data.note, decidedBy: req.user?.username }), to: q.sales_person_email, template: 'approval_decision', entity: 'quotation', entityId: q.quotation_no, sentBy: req.user?.username || 'admin' });
  }
  res.json({ data: { ...u, email: email && { status: email.status, reason: email.reason } } });
});
