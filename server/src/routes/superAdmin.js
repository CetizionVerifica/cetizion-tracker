import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { pool, query } from '../db.js';
import {
  SUPER_ADMIN_COOKIE, checkSuperAdmin, currentSuperAdmin, requireSuperAdmin,
  superAdminActor, superAdminConfig, superAdminCookieOptions, superAdminEnabled, superAdminToken,
} from '../auth/superAdmin.js';
import { ACTIONS, logActivity } from '../lib/activity.js';
import { MIN_PASSWORD_LENGTH } from '../lib/passwords.js';
import {
  ROLES, createUserAsAdmin, listUsers, setUserPassword, updateUser,
} from '../lib/users.js';
import { deleteUserWithBackup, deletionPlan, listDeletedUsers, readBackup } from '../lib/userDeletion.js';
import { ApiError } from '../middleware/error.js';
import {
  asApiError, disconnectMailboxesOf, newPassword, newUser, parse, profileExtras, userChanges,
  userEditAction, userEditMetadata, userId,
} from '../lib/userAdmin.js';

/**
 * The super admin portal's API (/api/super-admin).
 *
 *   POST   /login                 { email, password }
 *   POST   /logout
 *   GET    /me
 *   GET    /users
 *   POST   /users                 { name, email, role, password, active }
 *   PATCH  /users/:id             { name, email, role, active, daily_mis, phone, time_zone }
 *   POST   /users/:id/password    { password }
 *   GET    /users/:id/deletion-plan
 *   DELETE /users/:id             { replacement_user_id, move_targets }
 *   GET    /deleted-users
 *   GET    /deleted-users/:id/backup
 *
 * Mounted before the staff sign-in gate: the super admin has no staff
 * session, only its own cookie (see auth/superAdmin.js). Everything below
 * /login and /logout needs that cookie.
 *
 * This is the only place accounts are created, edited, given passwords,
 * switched off or deleted; /api/users is a read-only list for the admin
 * screens. The rules live in the data layer — one active admin always
 * remains, emails are unique, passwords meet the policy — and delete backs
 * the account up to Excel first (lib/userDeletion.js). Every write is
 * recorded in the activity log with the super admin as the actor, in the
 * transaction of the change.
 */

export const superAdminRouter = Router();

superAdminRouter.use(superAdminEnabled);

const credentials = z.object({
  email: z.string().trim().min(1, 'Enter the email address'),
  password: z.string().min(1, 'Enter the password'),
});

// Only failed attempts count, so an open tab never locks the super admin out.
export const superAdminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { message: 'Too many sign-in attempts — wait a few minutes and try again' } },
});

// Kept beside the staff sign-ins, marked so the two cannot be confused.
const recordSignIn = (who, ip, ok) =>
  query('INSERT INTO auth_events (username, ip, ok, reason) VALUES ($1,$2,$3,$4)',
    [`super-admin:${String(who || '').slice(0, 100)}`, ip, ok, ok ? null : 'bad credentials']).catch(() => {});

const meBody = (superAdmin) => ({
  email: superAdmin.email,
  expires_at: new Date(superAdmin.expiresAt).toISOString(),
});

superAdminRouter.post('/login', superAdminLoginLimiter, async (req, res) => {
  const { email: typed, password } = parse(credentials, req.body);
  const settings = superAdminConfig();

  if (!(await checkSuperAdmin(typed, password, settings))) {
    await recordSignIn(typed, req.ip, false);
    throw new ApiError(401, 'That email address and password do not match');
  }
  await recordSignIn(typed, req.ip, true);

  const expiresAt = Date.now() + settings.sessionMs;
  res.cookie(SUPER_ADMIN_COOKIE, superAdminToken(settings.email, expiresAt), {
    ...superAdminCookieOptions(), maxAge: settings.sessionMs,
  });
  res.json({ data: meBody({ email: settings.email, expiresAt }) });
});

superAdminRouter.post('/logout', (req, res) => {
  res.clearCookie(SUPER_ADMIN_COOKIE, superAdminCookieOptions());
  res.status(204).end();
});

superAdminRouter.get('/me', (req, res) => {
  const superAdmin = currentSuperAdmin(req);
  if (!superAdmin) throw new ApiError(401, 'Please sign in to the super admin portal');
  res.json({ data: meBody(superAdmin) });
});

// ------------------------------------------------------------------ users

superAdminRouter.use('/users', requireSuperAdmin);

superAdminRouter.get('/users', async (req, res) => {
  res.json({ data: await listUsers(), roles: ROLES, limits: { min_password_length: MIN_PASSWORD_LENGTH } });
});

superAdminRouter.post('/users', async (req, res) => {
  const body = parse(newUser, req.body);
  const extras = parse(profileExtras, req.body);
  const actor = superAdminActor(req.superAdmin);

  // Phone and time zone go in with the account, in the same transaction
  // and the same activity row, so nothing about it is written unrecorded.
  let created;
  try {
    created = await createUserAsAdmin({ ...body, ...extras }, pool, (client, row) =>
      logActivity(client, {
        actor,
        action: ACTIONS.USER_CREATED,
        entityType: 'user',
        entityId: row.id,
        metadata: {
          name: row.name, email: row.email, role: row.role, active: row.active,
          phone: row.phone, time_zone: row.time_zone,
        },
      }));
  } catch (err) {
    throw asApiError(err);
  }

  const [user] = (await listUsers()).filter((u) => u.id === created.id);
  res.status(201).json({ data: user });
});

superAdminRouter.patch('/users/:id', async (req, res) => {
  const id = userId(req.params.id);
  const changes = parse(userChanges, req.body);
  const actor = superAdminActor(req.superAdmin);

  let updated;
  try {
    updated = await updateUser(id, changes, pool, (client, { before, after }) =>
      logActivity(client, {
        actor,
        action: userEditAction(before, after),
        entityType: 'user',
        entityId: after.id,
        metadata: userEditMetadata(before, after),
      }));
  } catch (err) {
    throw asApiError(err);
  }
  if (!updated) throw new ApiError(404, 'User not found');

  if (changes.active === false) updated.mailboxes_disconnected = await disconnectMailboxesOf(id);
  res.json({ data: updated });
});

superAdminRouter.post('/users/:id/password', async (req, res) => {
  const id = userId(req.params.id);
  const { password: plain } = parse(newPassword, req.body);
  const actor = superAdminActor(req.superAdmin);

  const updated = await setUserPassword(id, plain, pool, (client, row) =>
    logActivity(client, {
      actor,
      action: ACTIONS.USER_PASSWORD_RESET,
      entityType: 'user',
      entityId: row.id,
      metadata: { sessions_revoked: true },
    }));
  if (!updated) throw new ApiError(404, 'User not found');

  res.json({ data: updated });
});

/** What deleting this user would involve: counts, and who may take over. Reads only. */
superAdminRouter.get('/users/:id/deletion-plan', async (req, res) => {
  const plan = await deletionPlan(userId(req.params.id));
  if (!plan) throw new ApiError(404, 'User not found');
  res.json({ data: plan });
});

const deletion = z.object({
  replacement_user_id: z.number().int().positive().nullable().default(null),
  move_targets: z.boolean().default(false),
});

/**
 * Back up, check, reassign and delete (lib/userDeletion.js). Nothing is
 * deleted unless the backup was stored and read back intact.
 */
superAdminRouter.delete('/users/:id', async (req, res) => {
  const id = userId(req.params.id);
  const body = parse(deletion, req.body);

  const result = await deleteUserWithBackup({
    userId: id,
    replacementUserId: body.replacement_user_id,
    moveTargets: body.move_targets,
    actor: superAdminActor(req.superAdmin),
  });

  // After the delete commits, so a refused delete leaves their mail syncing.
  // The archived row stays, so their mailboxes are still found by whose they are.
  const mailboxesDisconnected = await disconnectMailboxesOf(id);
  res.json({ data: { deleted_user: result.record, summary: result.summary, mailboxes_disconnected: mailboxesDisconnected } });
});

// ---------------------------------------------------------- deleted users

superAdminRouter.use('/deleted-users', requireSuperAdmin);

superAdminRouter.get('/deleted-users', async (req, res) => {
  res.json({ data: await listDeletedUsers() });
});

superAdminRouter.get('/deleted-users/:id/backup', async (req, res) => {
  const id = userId(req.params.id);
  const backup = await readBackup(id);
  if (!backup) throw new ApiError(404, 'Backup not found');

  await logActivity(pool, {
    actor: superAdminActor(req.superAdmin),
    action: ACTIONS.USER_BACKUP_DOWNLOADED,
    entityType: 'user',
    entityId: backup.row.user_id,
    metadata: { deleted_user_record_id: backup.row.id, backup_document_id: backup.row.backup_document_id },
  });

  res.setHeader('Content-Type', backup.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${backup.row.file_name.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(backup.body);
});

// Anything else under /api/super-admin is not found here, rather than falling
// through to the staff sign-in gate and answering as if it were a staff route.
superAdminRouter.use(() => { throw new ApiError(404, 'Not found'); });
