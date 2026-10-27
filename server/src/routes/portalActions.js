/**
 * What clients said in the portal (#198 phase 2, §4): the staff worklist.
 *
 *   GET  /api/portal-admin/actions?status=open&kind=query|payment_advice|confirmed&po_number=
 *   GET  /api/portal-admin/actions/by-stage      the latest action on each invoice, for the badges
 *   POST /api/portal-admin/actions/:id/resolve   { status: 'resolved' | 'rejected', resolution }
 *
 * Signed in: admins see every client's actions, anyone else those on a PO
 * they can open (purchaseOrderClause), the same reach as the PO itself.
 * A payment advice is matched by recording the payment it reports (the
 * payment route takes portal_action_id), not here: this only resolves a
 * query, or rejects an advice or a query with a reason the client sees.
 *
 * Mounted ahead of the portal-admin router, which is administrator-only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { purchaseOrderClause, scopeOf } from '../auth/ownership.js';

export const portalActionsRouter = Router();

/** The action's POs: the one it names, and those of the invoices it is about. */
const ACTION_POS = `(SELECT po.po_number FROM purchase_orders po WHERE po.po_number = a.po_number
                     UNION SELECT ps.po_number FROM portal_client_action_stages x JOIN payment_stages ps ON ps.id = x.stage_id WHERE x.action_id = a.id)`;

/** The clause that keeps an action to the staff who can open one of its POs; '' for an admin. */
function reachable(req, params) {
  const clause = purchaseOrderClause(scopeOf(req), params, { alias: 'rpo' });
  return clause ? `AND EXISTS (SELECT 1 FROM purchase_orders rpo WHERE rpo.po_number IN ${ACTION_POS} AND ${clause})` : '';
}

const listSchema = z.object({
  status: z.enum(['open', 'matched', 'resolved', 'rejected', 'all']).optional().default('open'),
  kind: z.enum(['confirmed', 'query', 'payment_advice']).optional(),
  po_number: z.string().trim().max(60).optional(),
});

portalActionsRouter.get('/', async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(422, 'Invalid filter');
  const { status, kind, po_number: po } = parsed.data;
  const params = [];
  const where = [];
  if (status !== 'all') { params.push(status); where.push(`a.status = $${params.length}`); }
  if (kind) { params.push(kind); where.push(`a.kind = $${params.length}`); }
  if (po) { params.push(po); where.push(`$${params.length} IN ${ACTION_POS}`); }
  const scope = reachable(req, params);
  const { rows } = await query(
    `SELECT a.id, a.kind, a.status, a.company_id, co.name AS company_name, ct.name AS contact_name, ct.email AS contact_email,
            a.po_number, a.note, a.amount, a.tds_amount, a.paid_on, a.reference, a.document_id, a.thread_id,
            a.resolution, a.resolved_by, a.resolved_at, a.created_at,
            COALESCE((SELECT json_agg(json_build_object('id', s.id, 'invoice_no', s.invoice_no, 'po_number', s.po_number, 'stage_name', s.stage_name,
                                                        'stage_amount', s.stage_amount, 'amount_received', s.amount_received, 'currency', s.currency,
                                                        'invoice_date', s.invoice_date, 'client_name', s.client_name)
                                      ORDER BY s.invoice_no)
                        FROM portal_client_action_stages x JOIN v_payment_stages s ON s.id = x.stage_id WHERE x.action_id = a.id), '[]') AS invoices,
            (SELECT json_agg(json_build_object('id', p.id, 'stage_id', p.stage_id, 'amount', p.amount, 'tds_amount', p.tds_amount, 'received_on', p.received_on))
               FROM payments p WHERE p.portal_action_id = a.id) AS payments
       FROM portal_client_actions a
       JOIN companies co ON co.id = a.company_id
       LEFT JOIN contacts ct ON ct.id = a.contact_id
      WHERE true ${where.length ? `AND ${where.join(' AND ')}` : ''} ${scope}
      ORDER BY a.created_at DESC LIMIT 300`, params);
  res.json({ data: rows });
});

/**
 * The client's latest word on each invoice, for the badges on Collections and
 * the Payment stages list (the PO page reads the full list for its one PO).
 * One row per stage that has any action, so it stays small however long the
 * history grows.
 */
portalActionsRouter.get('/by-stage', async (req, res) => {
  const params = [];
  const scope = reachable(req, params);
  const { rows } = await query(
    `SELECT DISTINCT ON (x.stage_id) x.stage_id, a.id, a.kind, a.status, a.note, a.amount, a.paid_on, a.resolved_at, a.created_at
       FROM portal_client_action_stages x
       JOIN portal_client_actions a ON a.id = x.action_id
      WHERE true ${scope}
      ORDER BY x.stage_id, a.created_at DESC, a.id DESC`, params);
  res.json({ data: rows });
});

const resolveSchema = z.object({
  status: z.enum(['resolved', 'rejected']),
  resolution: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(1000).optional()),
});

portalActionsRouter.post('/:id/resolve', async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const { status, resolution } = parsed.data;
  if (status === 'rejected' && !resolution) throw new ApiError(422, 'Please check the highlighted fields', { fields: { resolution: 'Say why: the client sees it' } });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Not found');
  const params = [id, status, resolution ?? null, req.user?.username || null];
  const scope = reachable(req, params);
  const { rows: [a] } = await query(
    `UPDATE portal_client_actions a SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
      WHERE a.id = $1 AND a.status = 'open' ${scope}
      RETURNING a.id, a.status, a.resolution, a.resolved_at`, params);
  if (!a) throw new ApiError(404, 'Not found, or already settled');
  res.json({ data: a });
});
