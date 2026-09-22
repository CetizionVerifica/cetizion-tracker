/**
 * Email log and jobs, for the admin page (#21):
 *
 *   GET  /api/emails                  the log, newest first (?status=, ?entity=&entity_id=, ?q=)
 *   GET  /api/emails/:id              one email with its body
 *   POST /api/emails/test  { to }     send a test email under the current mode
 *   GET  /api/jobs                    the registry with each job's last run
 *   POST /api/jobs/:name/run          run a job now
 *
 * Reading is open to anyone signed in: the log and the job registry are how
 * somebody checks whether the reminder their client mentions actually went
 * out, and that is an ordinary question to have.
 *
 * Making something happen is not. The two POSTs below are admin-only —
 * see each for why. Nothing here is the route by which the application's
 * own emails are sent; those go through lib/mail.js from the workflow that
 * causes them, and are untouched by this gate.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { testEmail } from '../lib/emailTemplates.js';
import { decideDelivery, mailConfigured, sendMail } from '../lib/mail.js';
import { isJob, JOBS, lastRuns, runJob } from '../jobs.js';

export const emailRouter = Router();
export const jobRouter = Router();

emailRouter.get('/', async (req, res) => {
  const params = []; const where = [];
  if (req.query.status) { params.push(String(req.query.status)); where.push(`status = $${params.length}`); }
  if (req.query.entity) { params.push(String(req.query.entity)); where.push(`entity = $${params.length}`); }
  if (req.query.entity_id) { params.push(String(req.query.entity_id)); where.push(`entity_id = $${params.length}`); }
  if (req.query.q) { params.push(`%${String(req.query.q).trim()}%`); where.push(`(to_email ILIKE $${params.length} OR subject ILIKE $${params.length})`); }
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const { rows } = await query(
    `SELECT id, to_email, cc, subject, template, entity, entity_id, status, mode, reason, provider_message_id, error, sent_by, created_at, sent_at
       FROM email_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    params
  );
  res.json({ data: rows, mode: config.mail.mode, configured: mailConfigured(), allowlist: config.mail.allowlist, from: config.mail.from || null });
});

emailRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Email not found');
  const { rows } = await query('SELECT * FROM email_log WHERE id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Email not found');
  res.json({ data: rows[0] });
});

const testSchema = z.object({ to: z.string().trim().email('Enter an email address') });

/**
 * Admin only. This sends real mail to an address the caller chooses, from
 * the tracker's own mailbox — in live mode it is an open relay for one
 * message, and in any mode it is a way to find out what the tracker's
 * outgoing mail looks like from outside. Neither is a sales user's job.
 */
emailRouter.post('/test', requireAdmin, async (req, res) => {
  const parsed = testSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: { to: parsed.error.issues[0].message } });
  const email = testEmail({ to: parsed.data.to, mode: config.mail.mode });
  const row = await sendMail({ ...email, to: parsed.data.to, template: 'test', sentBy: req.user?.username || 'admin' });
  res.json({ data: row, would: decideDelivery({ to: parsed.data.to }) });
});

jobRouter.get('/', async (req, res) => {
  const runs = await lastRuns();
  res.json({ data: Object.entries(JOBS).map(([name, job]) => ({ name, description: job.description, cron: job.cron, time_zone: config.businessTimeZone, last_run: runs[name] || null })) });
});

/**
 * Admin only. These are the tracker's global background operations —
 * payment and client reminders among them — and running one by hand emails
 * every client it decides is due, not the caller's own records. It is an
 * operational act with effects outside the app, so it belongs to whoever
 * administers the tracker rather than to anybody signed in.
 *
 * The schedule is unaffected: the worker runs these on its own timetable
 * without going through the API at all.
 */
jobRouter.post('/:name/run', requireAdmin, async (req, res) => {
  if (!isJob(req.params.name)) throw new ApiError(404, 'Unknown job');
  const run = await runJob(req.params.name, { startedBy: req.user?.username || 'admin' });
  res.json({ data: run });
});
