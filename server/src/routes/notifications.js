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
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { collectNotifications } from '../lib/notify.js';

export const notificationsRouter = Router();

const who = (req) => req.user?.username || 'admin';

notificationsRouter.get('/summary', async (req, res) => {
  const { rows: [r] } = await query(`SELECT COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread, COUNT(*)::int AS total FROM notifications WHERE username = $1`, [who(req)]);
  res.json({ data: r });
});

notificationsRouter.get('/', async (req, res) => {
  const params = [who(req)]; const where = ['username = $1'];
  if (req.query.unread) where.push('read_at IS NULL');
  if (req.query.kind) { params.push(String(req.query.kind)); where.push(`kind = $${params.length}`); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await query(`SELECT * FROM notifications WHERE ${where.join(' AND ')} ORDER BY read_at IS NOT NULL, created_at DESC LIMIT ${limit}`, params);
  res.json({ data: rows });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const { rowCount } = await query('UPDATE notifications SET read_at = now() WHERE username = $1 AND read_at IS NULL', [who(req)]);
  res.json({ data: { marked: rowCount } });
});

notificationsRouter.post('/sweep', async (req, res) => {
  res.json({ data: await collectNotifications() });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const { rows } = await query('UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND username = $2 RETURNING id, read_at', [Number(req.params.id), who(req)]);
  if (!rows.length) throw new ApiError(404, 'Notification not found');
  res.json({ data: rows[0] });
});
