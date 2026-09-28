/**
 * My account (C20): the ways in, the devices, and the fields only you may
 * change.
 *
 *   GET    /api/auth/account                     everything the page draws
 *   PATCH  /api/auth/account                     name, signature, phone, time zone, emails
 *   POST   /api/auth/account/password            change your own
 *   DELETE /api/auth/account/identities/:provider unlink Microsoft or Google
 *   DELETE /api/auth/account/sessions/:id        sign out one device
 *   POST   /api/auth/account/sessions/revoke-all sign out everywhere
 *
 * The line this file holds: a person may change what they are called, how
 * they sign, how to reach them, and which emails they get. Their role,
 * their email address and whether their account is active are facts about
 * their job, set by an admin under Users — offering them here would be
 * offering somebody the ability to promote themselves.
 *
 * Only in database mode. Shared mode is one account in an environment
 * variable: there is no row to own, no identity to link and no session to
 * list, so the whole router answers 404 rather than half-working.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { MIN_PASSWORD_LENGTH, passwordProblem, verifyPasswordOrDummy } from '../lib/passwords.js';
import { findUserById, setUserPassword } from '../lib/users.js';
import { listSessions, revokeAllSessions, revokeSession } from '../lib/sessions.js';
import { authConfig } from './config.js';
import { databasePayload, signSession } from './session.js';
import { enabledProviders } from './oauth.js';
import { requireAuth } from './middleware.js';
import { CHANNELS, GROUPS } from '../lib/notificationPrefs.js';

export const accountRouter = Router();

const NOTIFY_KEYS = ['follow_up_late', 'deal_accepted', 'discount_approval', 'monday_brief'];

// What each person hears about and how (#44): see lib/notificationPrefs.js.
const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'A time like 19:00');
const notifySchema = z.object({
  ...Object.fromEntries(NOTIFY_KEYS.map((k) => [k, z.boolean().optional()])),
  kinds: z.partialRecord(z.enum(Object.keys(GROUPS)), z.enum(CHANNELS)).optional(),
  quiet: z.object({ from: hhmm, to: hhmm }).nullable().optional(),
  digest: z.boolean().optional(),
  weekly: z.boolean().optional(),
}).strict();

accountRouter.use(requireAuth, (req, res, next) => {
  if (authConfig.mode !== 'database' || !req.user?.id) {
    return next(new ApiError(404, 'This deployment signs in with one shared account, so there is no personal account page.'));
  }
  next();
});

const trimmed = (max) => z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().trim().max(max).nullable().optional()
);

const profileSchema = z.object({
  name: z.string().trim().min(1, 'A name is needed').max(120).optional(),
  phone: trimmed(40),
  signature: trimmed(300),
  time_zone: trimmed(60),
  // partialRecord, not record: in zod 4 a record keyed by an enum is
  // exhaustive, so `{ monday_brief: true }` was rejected for not mentioning
  // the other three. The page deliberately sends one switch at a time.
  notify: notifySchema.optional(),
});

const passwordSchema = z.object({
  current_password: z.string().min(1, 'Enter your current password'),
  new_password: z.string().min(1, 'Enter a new password'),
});

const parse = (schema, body) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])),
    });
  }
  return parsed.data;
};

/** Never the hash, and never another person's anything. */
const profileOf = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  phone: row.phone ?? null,
  signature: row.signature ?? null,
  time_zone: row.time_zone ?? null,
  notify: row.notify ?? {},
  password_set: Boolean(row.password_hash),
});

async function identitiesOf(userId) {
  const { rows } = await query(
    'SELECT provider, email, linked_at, last_used_at FROM auth_identities WHERE user_id = $1 ORDER BY provider',
    [userId]);
  return rows;
}

accountRouter.get('/', async (req, res) => {
  const row = await findUserById(req.user.id);
  if (!row) throw new ApiError(404, 'Account not found');

  const [identities, sessions] = await Promise.all([identitiesOf(row.id), listSessions(row.id)]);
  res.json({
    data: {
      profile: profileOf(row),
      identities,
      // Which one is the device asking, so the list can say "this device"
      // and not offer to sign it out from under itself by accident.
      sessions: sessions.map((s) => ({ ...s, current: s.id === req.user.sessionId })),
      // The providers this deployment has configured, so the page can offer
      // to link one that is available and not one that is not.
      providers: enabledProviders(),
      notify_keys: NOTIFY_KEYS,
      // The groups the settings page offers, with their labels (#44).
      notify_groups: Object.entries(GROUPS).map(([key, g]) => ({ key, label: g.label })),
      notify_channels: CHANNELS,
    },
  });
});

accountRouter.patch('/', async (req, res) => {
  const body = parse(profileSchema, req.body);
  const row = await findUserById(req.user.id);
  if (!row) throw new ApiError(404, 'Account not found');

  // Merged, not replaced: the page sends one switch at a time, and a
  // replace would silently clear the other three.
  // Per-kind channels merge the same way, one group at a time.
  const notify = body.notify
    ? { ...(row.notify || {}), ...body.notify, ...(body.notify.kinds ? { kinds: { ...(row.notify?.kinds || {}), ...body.notify.kinds } } : {}) }
    : row.notify;

  const { rows: [updated] } = await query(
    `UPDATE users
        SET name = COALESCE($2, name),
            phone = $3, signature = $4, time_zone = $5, notify = $6::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [row.id, body.name ?? null,
      'phone' in body ? body.phone ?? null : row.phone,
      'signature' in body ? body.signature ?? null : row.signature,
      'time_zone' in body ? body.time_zone ?? null : row.time_zone,
      JSON.stringify(notify || {})]);

  res.json({ data: profileOf(updated) });
});

/**
 * Change your own password.
 *
 * The current one is required even though the caller is already signed in:
 * a borrowed laptop with an open tab should not be enough to take the
 * account. setUserPassword raises session_version, which ends every cookie
 * signed under the old password — including this one, so a fresh session
 * is started and the cookie replaced before answering. Signing yourself
 * out of the tab you are typing in is not a security property, it is a bug.
 */
accountRouter.post('/password', async (req, res) => {
  const body = parse(passwordSchema, req.body);
  const row = await findUserById(req.user.id);
  if (!row) throw new ApiError(404, 'Account not found');

  if (!(await verifyPasswordOrDummy(body.current_password, row.password_hash))) {
    throw new ApiError(422, 'That is not your current password', { fields: { current_password: 'Does not match' } });
  }
  const problem = passwordProblem(body.new_password);
  if (problem) throw new ApiError(422, problem, { fields: { new_password: problem } });

  await setUserPassword(row.id, body.new_password);
  // Every other device is now signed out, which is the point of a password
  // change. This one is signed in again, deliberately.
  await revokeAllSessions(row.id, { except: req.user.sessionId });

  const fresh = await findUserById(row.id);
  const expiresAt = Date.now() + authConfig.sessionTtlMs;
  res.cookie(authConfig.cookieName, signSession(
    databasePayload(fresh.id, fresh.session_version, expiresAt, req.user.sessionId),
    authConfig.sessionSecret
  ), {
    httpOnly: true, sameSite: 'lax', secure: authConfig.secureCookie, path: '/',
    maxAge: authConfig.sessionTtlMs,
  });

  res.json({ data: { changed: true, minimum_length: MIN_PASSWORD_LENGTH } });
});

/**
 * Unlink a provider.
 *
 * Refused when it would leave no way in. An account with no password and
 * no identity cannot be signed into by anybody, including an admin, and
 * unlinking is not where somebody should discover that.
 */
accountRouter.delete('/identities/:provider', async (req, res) => {
  const row = await findUserById(req.user.id);
  if (!row) throw new ApiError(404, 'Account not found');

  const identities = await identitiesOf(row.id);
  const target = identities.find((i) => i.provider === req.params.provider);
  if (!target) throw new ApiError(404, 'That account is not linked');

  if (!row.password_hash && identities.length === 1) {
    throw new ApiError(422, 'That is the only way into this account. Set a password first, or link the other provider.');
  }

  await query('DELETE FROM auth_identities WHERE user_id = $1 AND provider = $2', [row.id, req.params.provider]);
  res.json({ data: { unlinked: req.params.provider } });
});

accountRouter.delete('/sessions/:id', async (req, res) => {
  const ended = await revokeSession(req.params.id, req.user.id);
  if (!ended) throw new ApiError(404, 'That session has already ended');
  res.json({ data: { ended: req.params.id, was_current: req.params.id === req.user.sessionId } });
});

/**
 * Sign out everywhere.
 *
 * Including here: somebody pressing this has usually lost a device, and
 * "everywhere except the browser I am holding" is not what the words say.
 * It also bumps session_version, which is the only thing that reaches
 * cookies signed before sessions were recorded at all.
 */
accountRouter.post('/sessions/revoke-all', async (req, res) => {
  const ended = await revokeAllSessions(req.user.id);
  res.clearCookie(authConfig.cookieName, {
    httpOnly: true, sameSite: 'lax', secure: authConfig.secureCookie, path: '/',
  });
  res.json({ data: { ended } });
});
