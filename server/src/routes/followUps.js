/**
 * Follow-up cycles (docs/follow-up-escalation-plan.md §5.6):
 *
 *   GET /api/follow-ups?status=waiting|escalated|open|resolved&entity=&owner=
 *   GET /api/follow-ups/record?entity=&id=      the open cycle on one record, for its banner
 *   GET /api/follow-ups/summary                 per owner, the last 30 days (admin)
 *
 * A sales user sees cycles on the records they own today; an admin sees all.
 * Status is derived, never stored: resolved when resolved_at is set,
 * escalated when escalated_at is, otherwise waiting.
 */
import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { assertRecordReachable, parentClause, scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { businessToday, workingDaysBetween } from '../lib/businessDate.ts';
import { dateOf, keyOf, lastActivity, nextTask, recordLink } from '../lib/followUps.js';

export const followUpsRouter = Router();

const KINDS = ['enquiry', 'quotation', 'payment_stage'];
const STATUS = `CASE WHEN c.resolved_at IS NOT NULL THEN 'resolved' WHEN c.escalated_at IS NOT NULL THEN 'escalated' ELSE 'waiting' END`;

/** Each cycle with what the page shows about its record, and who owns it now. */
const ROWS = `
  SELECT c.*, ${STATUS} AS status,
         COALESCE(e.client_name, q.client_name, ps.client_name) AS client,
         CASE c.entity WHEN 'payment_stage' THEN COALESCE(ps.invoice_no, c.entity_id) ELSE c.entity_id END AS number,
         CASE c.entity WHEN 'payment_stage' THEN ps.po_number || ' · ' || ps.stage_name
                       WHEN 'quotation' THEN q.service_quoted ELSE e.service END AS detail,
         ou.id AS owner_user_id, COALESCE(ou.name, c.owner_name) AS owner
    FROM follow_up_cycles c
    LEFT JOIN enquiries e ON c.entity = 'enquiry' AND e.enquiry_no = c.entity_id
    LEFT JOIN quotations q ON c.entity = 'quotation' AND q.quotation_no = c.entity_id
    LEFT JOIN v_payment_stages ps ON c.entity = 'payment_stage' AND ps.id::text = c.entity_id
    LEFT JOIN projects pr ON pr.project_id = ps.project_id
    LEFT JOIN users ou ON ou.id = COALESCE(e.owner_user_id, q.owner_user_id, pr.owner_user_id)`;

/** Working days since the last activity (or since it fell due), per row. */
async function withIdleDays(rows) {
  if (!rows.length) return rows;
  const today = businessToday();
  const [activity, { rows: hol }] = await Promise.all([
    lastActivity({ query }, rows.map(keyOf)),
    query('SELECT holiday_on FROM holidays'),
  ]);
  const holidays = hol.map((h) => h.holiday_on);
  return rows.map((r) => {
    const last = activity.get(keyOf(r)) ?? null;
    const since = dateOf(last) ?? r.due_on;
    return { ...r, link: recordLink(r.entity, r.entity_id), last_activity_at: last, idle_days: r.resolved_at ? null : workingDaysBetween(since, today, holidays) };
  });
}

followUpsRouter.get('/', async (req, res) => {
  const scope = scopeOf(req);
  const params = [];
  const where = [];
  const mine = parentClause(scope, params, { kind: 'entity', alias: 'c' });
  if (mine) where.push(mine);

  const status = String(req.query.status || 'open');
  if (status === 'resolved') {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    params.push(days);
    where.push(`c.resolved_at IS NOT NULL AND c.resolved_at > now() - make_interval(days => $${params.length})`);
  } else if (status === 'escalated') where.push('c.resolved_at IS NULL AND c.escalated_at IS NOT NULL');
  else if (status === 'waiting') where.push('c.resolved_at IS NULL AND c.escalated_at IS NULL');
  else if (status === 'open') where.push('c.resolved_at IS NULL');
  else throw new ApiError(422, 'status must be waiting, escalated, open or resolved');

  if (req.query.entity) {
    if (!KINDS.includes(req.query.entity)) throw new ApiError(422, `entity must be one of ${KINDS.join(', ')}`);
    params.push(req.query.entity);
    where.push(`c.entity = $${params.length}`);
  }
  // Whose items: an admin's filter. A sales user is already narrowed to their own.
  if (req.query.owner && scope.unrestricted) {
    if (req.query.owner === 'none') where.push('ou.id IS NULL');
    else {
      const owner = Number(req.query.owner);
      if (!Number.isSafeInteger(owner) || owner <= 0) throw new ApiError(422, 'owner must be a user id or none');
      params.push(owner);
      where.push(`ou.id = $${params.length}`);
    }
  }

  const { rows } = await query(
    `${ROWS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY ${status === 'resolved' ? 'c.resolved_at DESC' : 'c.respond_by NULLS FIRST, c.due_on'}, c.id
     LIMIT 500`,
    params
  );
  res.json({ data: await withIdleDays(rows) });
});

/**
 * The open cycle on one record, or null. Null as soon as anything has been
 * logged since the reminder, without waiting for tomorrow's run: the banner
 * should go when the touch is saved.
 */
followUpsRouter.get('/record', async (req, res) => {
  const entity = String(req.query.entity || '');
  const id = String(req.query.id || '').trim();
  if (!KINDS.includes(entity)) throw new ApiError(422, `entity must be one of ${KINDS.join(', ')}`);
  if (!id) throw new ApiError(422, 'id is required');
  await assertRecordReachable(scopeOf(req), entity, id);

  const [{ rows: [cycle] }, next] = await Promise.all([
    query(
      `SELECT c.*, ${STATUS} AS status FROM follow_up_cycles c
        WHERE c.entity = $1 AND c.entity_id = $2 AND c.resolved_at IS NULL`,
      [entity, id]
    ),
    // The next follow-up the owner has planned, shown whether or not one is overdue.
    nextTask({ query }, entity, id),
  ]);
  if (!cycle) return res.json({ data: null, next_task: next });
  const last = (await lastActivity({ query }, [keyOf(cycle)])).get(keyOf(cycle));
  const since = cycle.reminded_at ?? cycle.escalated_at ?? cycle.created_at;
  if (last && new Date(last) > new Date(since)) return res.json({ data: null, acted: true, next_task: next });
  res.json({ data: cycle, next_task: next });
});

followUpsRouter.get('/summary', requireAdmin, async (req, res) => {
  const { rows } = await query(
    `SELECT COALESCE(u.id, c.reminded_user_id) AS user_id,
            COALESCE(u.name, c.owner_name, 'No owner') AS owner,
            COUNT(*) FILTER (WHERE c.reminded_at IS NOT NULL)::int AS reminded,
            COUNT(*) FILTER (WHERE c.resolved_reason = 'activity')::int AS resolved_by_activity,
            COUNT(*) FILTER (WHERE c.resolved_reason = 'rescheduled')::int AS rescheduled,
            COUNT(*) FILTER (WHERE c.escalated_at IS NOT NULL)::int AS escalated,
            COUNT(*) FILTER (WHERE c.resolved_at IS NULL)::int AS open
       FROM follow_up_cycles c
       LEFT JOIN users u ON u.id = c.reminded_user_id
      WHERE c.created_at > now() - interval '30 days' OR c.resolved_at IS NULL
      GROUP BY 1, 2
      ORDER BY escalated DESC, owner`
  );
  res.json({ data: rows });
});
