/**
 * The emails the tracker can send to clients, for the Settings pane:
 *
 *   GET /api/client-emails     every kind, why it goes, whether it is held,
 *                              what went or was held in the last 30 days,
 *                              and the latest client emails from the log
 *                              (?owner=<user id> narrows an admin's list)
 *   PUT /api/client-emails     { hold_all?: boolean, held?: { [key]: boolean } }
 *
 * Reading follows ownership (auth/ownership.js): an admin sees every client
 * email and whose record each is on; a sales user sees only the emails on
 * records they own, counts included. Changing the holds is an admin's: the
 * switches decide whether clients hear from the company at all.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { ownershipScope } from '../auth/ownership.js';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { appEnv } from '../lib/ops/environment.js';
import { mailConfigured } from '../lib/mail.js';
import { CLIENT_EMAILS, CLIENT_EMAIL_KEYS, clientEmailSwitches, emailOwnersSql } from '../lib/clientEmails.js';

export const clientEmailRouter = Router();

/** Who is asking: everyone, or one owner's records. HR has no client email. */
function scopeFor(req) {
  const scope = ownershipScope(req.user);
  if (scope.hr) throw new ApiError(403, 'This is not part of the HR role');
  return scope;
}

async function overview(scope, { owner = null } = {}) {
  const { holdAll, held } = await clientEmailSwitches({ query });
  const { rows: settings } = await query(`SELECT value FROM settings WHERE key = 'emails_enabled'`);
  const emailsEnabled = !settings.length || settings[0].value.trim().toLowerCase() !== 'false';
  // A sales user sees their own records' emails; an admin may pick one owner.
  const ownerId = scope.unrestricted ? owner : scope.ownerId;
  const mine = ownerId ? 'WHERE $2 = ANY(owner_ids)' : '';
  const params = ownerId ? [CLIENT_EMAIL_KEYS, ownerId] : [CLIENT_EMAIL_KEYS];
  const logged = `WITH logged AS (
      SELECT e.id, e.to_email, e.cc, e.subject, e.template, e.entity, e.entity_id, e.status, e.mode, e.reason, e.error, e.sent_by, e.created_at, e.sent_at,
             ${emailOwnersSql('e')} AS owner_ids
        FROM email_log e WHERE e.template = ANY($1)
    )`;
  const { rows: counts } = await query(
    `${logged}
     SELECT template,
            count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE status = 'suppressed')::int AS held,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            max(created_at) AS last_at
       FROM logged ${mine ? `${mine} AND` : 'WHERE'} created_at > now() - interval '30 days'
      GROUP BY template`, params);
  const { rows: recent } = await query(
    `${logged}
     SELECT l.*, ARRAY(SELECT u.name FROM users u WHERE u.id = ANY(l.owner_ids) ORDER BY u.name) AS owners
       FROM logged l ${mine} ORDER BY created_at DESC, id DESC LIMIT 100`, params);
  // The owners an admin can narrow the list to: active people who own something.
  const owners = scope.unrestricted
    ? (await query(`SELECT u.id, u.name FROM users u WHERE u.active AND u.role IN ('sales','admin')
                      AND (EXISTS (SELECT 1 FROM quotations WHERE owner_user_id = u.id) OR EXISTS (SELECT 1 FROM projects WHERE owner_user_id = u.id)
                           OR EXISTS (SELECT 1 FROM enquiries WHERE owner_user_id = u.id))
                    ORDER BY u.name`)).rows
    : [];
  const byKey = Object.fromEntries(counts.map((c) => [c.template, c]));
  return {
    can_change: scope.unrestricted,
    only_mine: !scope.unrestricted,
    owner: ownerId,
    owners,
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
    recent: recent.map(({ owner_ids: _ids, ...r }) => r),
  };
}

clientEmailRouter.get('/', async (req, res) => {
  const scope = scopeFor(req);
  const owner = req.query.owner ? Number(req.query.owner) : null;
  if (owner !== null && !(Number.isSafeInteger(owner) && owner > 0)) throw new ApiError(422, 'owner is a user id');
  res.json({ data: await overview(scope, { owner }) });
});

const updateSchema = z.object({
  hold_all: z.boolean().optional(),
  held: z.record(z.string(), z.boolean()).optional(),
}).refine((b) => b.hold_all !== undefined || b.held !== undefined, 'Nothing to change');

clientEmailRouter.put('/', requireAdmin, async (req, res) => {
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
  res.json({ data: await overview(scopeFor(req)) });
});
