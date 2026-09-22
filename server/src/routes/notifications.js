/**
 * The notification centre (#44):
 *
 *   GET  /api/notifications?unread=1&limit=       newest first
 *   GET  /api/notifications/summary               unread count for the bell
 *   POST /api/notifications/:id/read
 *   POST /api/notifications/read-all
 *   POST /api/notifications/sweep                 run the collector now
 */
import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { collectNotifications } from '../lib/notify.js';

export const notificationsRouter = Router();

/**
 * Whose notifications these are. Two spellings of the same person: the
 * address they sign in with, and the name the tracker records on a record
 * (a sales person, a task's assignee). A row addressed to either is theirs,
 * and a row addressed to nobody is everybody's.
 *
 * Matching both is what makes the bell work before #18 finishes joining
 * those two identities up.
 */
const audience = (req) => [req.user?.username || 'admin', req.user?.name || req.user?.username || 'admin'];
const MINE = '(n.username IS NULL OR lower(n.username) = lower($1) OR lower(n.username) = lower($2))';
// Read state belongs to the reader: a row addressed to nobody is everyone's,
// and one read_at on it would let the first person to look clear the bell
// for the whole team.
const READ = 'EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND lower(r.reader) = lower($1))';

notificationsRouter.get('/summary', async (req, res) => {
  const { rows: [r] } = await query(`SELECT COUNT(*) FILTER (WHERE NOT ${READ})::int AS unread, COUNT(*)::int AS total FROM notifications n WHERE ${MINE}`, audience(req));
  res.json({ data: r });
});

notificationsRouter.get('/', async (req, res) => {
  const params = audience(req); const where = [MINE];
  if (req.query.unread) where.push(`NOT ${READ}`);
  if (req.query.kind) { params.push(String(req.query.kind)); where.push(`n.kind = $${params.length}`); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await query(
    `SELECT n.*, (SELECT r.read_at FROM notification_reads r WHERE r.notification_id = n.id AND lower(r.reader) = lower($1)) AS read_at
       FROM notifications n WHERE ${where.join(' AND ')} ORDER BY ${READ}, n.created_at DESC LIMIT ${limit}`, params);
  res.json({ data: rows });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const { rowCount } = await query(
    `INSERT INTO notification_reads (notification_id, reader)
     SELECT n.id, $1 FROM notifications n WHERE ${MINE} AND NOT ${READ}
     ON CONFLICT DO NOTHING`, audience(req));
  await query(`UPDATE notifications n SET read_at = COALESCE(n.read_at, now())
                WHERE n.read_at IS NULL AND EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id)`);
  res.json({ data: { marked: rowCount } });
});

// The same work as the notifications.daily job, which POST /api/jobs/:name/run
// gates for the same reason: running it by hand is an operational act.
notificationsRouter.post('/sweep', requireAdmin, async (req, res) => {
  res.json({ data: await collectNotifications() });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { rows } = await query(
    `INSERT INTO notification_reads (notification_id, reader)
     SELECT n.id, $1 FROM notifications n WHERE ${MINE} AND n.id = $3
     ON CONFLICT (notification_id, reader) DO UPDATE SET read_at = EXCLUDED.read_at
     RETURNING notification_id AS id, read_at`, [...audience(req), Number(req.params.id)]);
  if (!rows.length) throw new ApiError(404, 'Notification not found');
  // The row's own read_at is what the digest reads: has anyone seen this.
  await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1', [rows[0].id]);
  res.json({ data: rows[0] });
});
