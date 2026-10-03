/**
 * PO received → project in one step (#26):
 *
 *   POST /api/quotations/:key/register
 *     {
 *       project_id?             join an existing project instead of creating one
 *       project_manager?, project_manager_email?, planned_start_date?, planned_delivery_date?
 *       po_number, po_date?, po_value?, currency?, payment_terms_days?, document_id?
 *       payment_terms_template_id?   the schedule; blank = the default template, 0 = no stages
 *       review_id?                   the PO email in the review queue this settles (poReview.js)
 *       stages?                      the schedule itself, instead of a template:
 *                                    [{ stage_name, trigger_event, percent, credit_days?, milestone_name? }]
 *       onboarding_template_id?      the checklist; blank = the service's, else the default; 0 = none
 *     }
 *
 * One transaction: the quotation is marked won and linked, the project is
 * created or reused, the PO registered against the quotation, its service
 * lines taken from the quotation's lines (or its subject), the payment
 * stages built from the template, and the onboarding checklist added. The
 * work is registerPurchaseOrder(), which the email reader calls too
 * (docs/email-po-plan.md §3.5).
 *
 * Refused: a quotation that already has a PO (409), a PO number already
 * registered in any spelling, and an unknown currency (422).
 */
import { Router } from 'express';
import { z } from 'zod';
import { scopeOf } from '../auth/ownership.js';
import { transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { registerPurchaseOrder } from '../lib/purchaseOrders.js';
import { STATUS } from '../lib/statuses.js';
import { settleReview } from './poReview.js';

export const registerRouter = Router();

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const dateStr = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional());
const optStr = (max) => z.preprocess(blank, z.string().trim().max(max).optional());
const optInt = z.preprocess(blank, z.coerce.number().int().optional());

const schema = z.object({
  project_id: optStr(40),
  project_manager: optStr(120),
  project_manager_email: optStr(160),
  planned_start_date: dateStr,
  planned_delivery_date: dateStr,
  po_number: z.preprocess(blank, z.string({ message: 'PO number is required' }).trim().min(1, 'PO number is required').max(60)),
  po_date: dateStr,
  po_value: z.preprocess(blank, z.coerce.number().min(0).optional()),
  currency: optStr(3),
  payment_terms_days: z.preprocess(blank, z.coerce.number().int().min(0).max(365).optional()),
  document_id: optInt,
  payment_terms_template_id: optInt,
  onboarding_template_id: optInt,
  stages: z.array(z.object({
    stage_name: z.string().trim().min(1).max(120),
    trigger_event: z.enum(STATUS.trigger),
    percent: z.coerce.number().gt(0).max(100),
    credit_days: z.preprocess(blank, z.coerce.number().int().min(0).max(365).optional()),
    milestone_name: optStr(120),
  })).max(12).optional(),
  // A PO email from the review queue (poReview.js), settled by this registration.
  review_id: optInt,
});

registerRouter.post('/:key/register', async (req, res) => {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])) });
  }
  const scope = scopeOf(req);
  const { review_id: reviewId, ...input } = parsed.data;
  const data = await transaction(async (client) => {
    const registered = await registerPurchaseOrder(client, { ...input, quotation: decodeURIComponent(req.params.key) }, { scope });
    if (reviewId) await settleReview(client, req, reviewId, { poNumber: registered.po_number, quotationNo: registered.quotation_no });
    return registered;
  });
  res.status(201).json({ data });
});
