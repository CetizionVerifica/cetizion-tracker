/**
 * The emails the tracker can send to clients, for the admin's Settings pane:
 *
 *   GET /api/client-emails     every kind, why it goes, whether it is held,
 *                              what went or was held in the last 30 days,
 *                              and the latest client emails from the log
 *   PUT /api/client-emails     { hold_all?: boolean, held?: { [key]: boolean } }
 *
 * Admin only, both. The list names clients' addresses, and the switches
 * decide whether clients hear from the company at all.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { appEnv } from '../lib/ops/environment.js';
import { mailConfigured } from '../lib/mail.js';
import { CLIENT_EMAILS, CLIENT_EMAIL_KEYS, clientEmailSwitches } from '../lib/clientEmails.js';

export const clientEmailRouter = Router();
clientEmailRouter.use(requireAdmin);

async function overview() {
  const { holdAll, held } = await clientEmailSwitches({ query });
  const { rows: settings } = await query(`SELECT value FROM settings WHERE key = 'emails_enabled'`);
  const emailsEnabled = !settings.length || settings[0].value.trim().toLowerCase() !== 'false';
  const { rows: counts } = await query(
    `SELECT template,
            count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE status = 'suppressed')::int AS held,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            max(created_at) AS last_at
       FROM email_log WHERE template = ANY($1) AND created_at > now() - interval '30 days'
      GROUP BY template`, [CLIENT_EMAIL_KEYS]);
  const { rows: recent } = await query(
    `SELECT id, to_email, cc, subject, template, entity, entity_id, status, mode, reason, error, sent_by, created_at, sent_at
       FROM email_log WHERE template = ANY($1) ORDER BY created_at DESC, id DESC LIMIT 100`, [CLIENT_EMAIL_KEYS]);
  const byKey = Object.fromEntries(counts.map((c) => [c.template, c]));
  return {
    hold_all: holdAll,
    environment: appEnv(),
    mode: config.mail.mode,
    emails_enabled: emailsEnabled,
    configured: mailConfigured(),
    scenarios: CLIENT_EMAILS.map((e) => ({
      ...e,
      held: holdAll || held.includes(e.key),
      held_here: held.includes(e.key),
      last_30_days: { sent: byKey[e.key]?.sent ?? 0, held: byKey[e.key]?.held ?? 0, failed: byKey[e.key]?.failed ?? 0 },
      last_at: byKey[e.key]?.last_at ?? null,
    })),
    recent,
  };
}

clientEmailRouter.get('/', async (_req, res) => {
  res.json({ data: await overview() });
});

const updateSchema = z.object({
  hold_all: z.boolean().optional(),
  held: z.record(z.string(), z.boolean()).optional(),
}).refine((b) => b.hold_all !== undefined || b.held !== undefined, 'Nothing to change');

clientEmailRouter.put('/', async (req, res) => {
  const parsed = updateSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, parsed.error.issues[0].message);
  const unknown = Object.keys(parsed.data.held || {}).filter((k) => !CLIENT_EMAIL_KEYS.includes(k));
  if (unknown.length) throw new ApiError(422, `Unknown kind of client email: ${unknown.join(', ')}`);

  const before = await clientEmailSwitches({ query });
  const holdAll = parsed.data.hold_all ?? before.holdAll;
  const changes = parsed.data.held || {};
  const held = CLIENT_EMAIL_KEYS.filter((k) => (Object.hasOwn(changes, k) ? changes[k] : before.held.includes(k)));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('client_emails_hold_all', $1), ('client_emails_held', $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(holdAll), JSON.stringify(held)]);
    // Who held or released client email, and what it was before: the
    // question this answers is "why did the client not get it?".
    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.CLIENT_EMAILS_CHANGED,
      entityType: 'setting',
      entityId: 'client_emails',
      metadata: { hold_all: { from: before.holdAll, to: holdAll }, held: { from: before.held, to: held } },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  res.json({ data: await overview() });
});
