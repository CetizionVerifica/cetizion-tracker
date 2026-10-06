import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin } from '../auth/middleware.js';
import { pool } from '../db.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { disconnect as disconnectMailbox } from '../lib/mailbox/sync.js';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/passwords.js';
import {
  ActiveNeedsLoginError, DuplicateEmailError, LastAdminError, ROLES,
  createUserAsAdmin, listUsers, setUserPassword, updateUser,
} from '../lib/users.js';
import { ApiError } from '../middleware/error.js';

/**
 * Managing the accounts that sign in (#18 Phase 1B-B).
 *
 * Admin only, at the router, so a route added here later is guarded because
 * of where it lives rather than because somebody remembered. requireAdmin
 * reads the role off the request user, which requireAuth has just re-read
 * from the database — so an admin demoted a second ago is already out.
 *
 * Available in both sign-in modes on purpose. The point of the dual-mode
 * transition is that the shared admin can come in here first, create the
 * real accounts, check an active admin exists, and only then switch
 * AUTH_MODE to database. Requiring database mode in order to prepare for
 * database mode would be a circle nobody could step into.
 *
 * No hash ever leaves here: every row is selected by column list, and the
 * password column is not in any of them. Nor does one reach the activity
 * log: every call below records what changed, and a password is recorded as
 * the fact that it was reset and nothing else.
 *
 * Each of the three writes passes its activity row into the transaction the
 * change itself runs in, so the two commit together. An account edited with
 * no record of who edited it is the failure this phase exists to prevent,
 * and it is a worse outcome than the edit being refused.
 */

export const userRouter = Router();

userRouter.use(requireAdmin);

const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

const name = z.string().trim().min(1, 'Enter a name').max(160);
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);
const role = z.enum(ROLES, { message: `Role must be ${ROLES.slice(0, -1).join(', ')} or ${ROLES.at(-1)}` });
const password = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  // The helper's own words, so the policy is stated in exactly one place.
  if (problem) ctx.addIssue({ code: 'custom', message: `Password is not usable: ${problem}` });
});

const newUser = z.object({
  name,
  email,
  role: role.default('sales'),
  password,
  active: z.boolean().default(true),
});

/**
 * Every field optional, and `password` deliberately absent: a name change
 * must not be able to carry a new password along with it. That is its own
 * request, below.
 */
const userChanges = z
  .object({
    name: name.optional(),
    email: z.preprocess(blankToNull, email.nullable()).optional(),
    role: role.optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

const newPassword = z.object({ password });

const parse = (schema, body) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return parsed.data;
};

/**
 * `users.id` is a serial, so a 4-byte signed integer. Anything outside that
 * range is not a user that could exist, and handing it to Postgres anyway
 * is how `PATCH /api/users/99999999999` became a 500 carrying a database
 * range error instead of a plain "not found".
 *
 * Every rejection here is the same 404 the database gives for an id nobody
 * holds — too big, zero, negative, not a number, or simply gone. A caller
 * learns whether the user exists, which they were going to learn anyway,
 * and nothing about the column behind it.
 */
const MAX_USER_ID = 2_147_483_647;

const userId = (raw) => {
  if (!/^\d+$/.test(raw)) throw new ApiError(404, 'User not found');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_USER_ID) {
    throw new ApiError(404, 'User not found');
  }
  return id;
};

/** Turn the data layer's refusals into the answers the API gives. */
function asApiError(err) {
  if (err instanceof LastAdminError) return new ApiError(409, err.message);
  if (err instanceof DuplicateEmailError) {
    return new ApiError(422, 'Please check the highlighted fields', { fields: { email: err.message } });
  }
  // Switching on an attribution-only row. The table refuses it through
  // users_active_needs_login; what reaches the client is the same shape as
  // any other rejected field, and never the constraint's name — that is an
  // implementation detail of ours, and nothing a caller can act on.
  if (err instanceof ActiveNeedsLoginError) {
    return new ApiError(422, 'Please check the highlighted fields', {
      fields: { email: err.message, password: err.message },
    });
  }
  return err;
}

userRouter.get('/', async (req, res) => {
  res.json({ data: await listUsers(), limits: { min_password_length: MIN_PASSWORD_LENGTH } });
});

userRouter.post('/', async (req, res) => {
  const body = parse(newUser, req.body);
  const actor = actorFrom(req.user);

  let created;
  try {
    created = await createUserAsAdmin(body, pool, (client, row) =>
      logActivity(client, {
        actor,
        action: ACTIONS.USER_CREATED,
        entityType: 'user',
        entityId: row.id,
        // The account as it was created. Kept even though the users table
        // holds the same fields, because this is the only place that still
        // says who this account was once it has been deleted.
        metadata: { name: row.name, email: row.email, role: row.role, active: row.active },
      }));
  } catch (err) {
    throw asApiError(err);
  }

  // createUser returns the row whole. The hash is not ours to pass on, and
  // neither is session_version: it is bookkeeping between the cookie and
  // the row, it is not something an admin screen acts on, and every other
  // response here is shaped without it.
  const { password_hash: _hash, session_version: _sv, ...user } = created;
  res.status(201).json({ data: user });
});

/**
 * What one edit is called in the activity log.
 *
 * Switching an account off or back on is the change somebody will come
 * looking for, so it gets its own name — and only one name. Recording a
 * `user.updated` beside a `user.deactivated` would double every such edit
 * in the log and leave a reader working out whether two things happened;
 * the `changed_fields` below already say that the name moved too.
 */
function userEditAction(before, after) {
  if (before && before.active !== after.active) {
    return after.active ? ACTIONS.USER_REACTIVATED : ACTIONS.USER_DEACTIVATED;
  }
  return ACTIONS.USER_UPDATED;
}

/** Which of the editable fields actually moved, and what the notable ones moved from. */
function userEditMetadata(before, after) {
  const fields = ['name', 'email', 'role', 'active'];
  const changed = before ? fields.filter((f) => before[f] !== after[f]) : fields;
  const metadata = { changed_fields: changed };

  // What it changed from and to, not only that it changed. An admin
  // repointing somebody's account at an address they control is the case
  // this log exists for, and "an email changed on user 5 at 14:03" cannot
  // be acted on without going to a backup for the old value.
  for (const field of ['name', 'email']) {
    if (before && changed.includes(field)) {
      metadata[`old_${field}`] = before[field];
      metadata[`new_${field}`] = after[field];
    }
  }
  if (before && changed.includes('role')) {
    metadata.old_role = before.role;
    metadata.new_role = after.role;
  }
  if (before && changed.includes('active')) {
    metadata.old_active = before.active;
    metadata.new_active = after.active;
    // Switching somebody off raises their session_version in the same
    // statement, which ends the sessions they were holding. Worth saying,
    // because "they were signed out" is otherwise invisible here.
    if (!after.active) metadata.sessions_revoked = true;
  }
  return metadata;
}

userRouter.patch('/:id', async (req, res) => {
  const id = userId(req.params.id);
  const changes = parse(userChanges, req.body);
  const actor = actorFrom(req.user);

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

  // Somebody switched off stops syncing their mail (docs/per-user-mailboxes-plan.md
  // §4.5): tokens destroyed, subscriptions removed, the mailbox left listed
  // for the admin. Records already made keep their owner until an admin
  // reassigns them. Not inside updateUser's transaction: disconnecting talks
  // to Microsoft, and a provider that is slow or down must not hold the
  // deactivation up or roll it back. The stored mail stays: a client's
  // thread on a project somebody else now owns is still that project's
  // history, and removing bodies is the explicit Disconnect dialog's choice.
  if (changes.active === false) {
    const { rows } = await pool.query(`SELECT id, email FROM connected_accounts WHERE user_id = $1 AND status <> 'disconnected'`, [id]);
    const disconnected = [];
    for (const a of rows) {
      try { await disconnectMailbox(a.id, { removeBodies: false }); disconnected.push(a.email); } catch { /* the row records its own error; the admin sees it under Mailboxes */ }
    }
    updated.mailboxes_disconnected = disconnected;
  }

  res.json({ data: updated });
});

/**
 * Give somebody a new password, and nothing else.
 *
 * A switched-off account stays switched off: it gains a password it cannot
 * yet use, which is the honest outcome — deciding somebody may sign in is
 * the `active` flag's job, and doing it as a side effect of a password
 * reset is how people get let back in by accident.
 *
 * It does end every session that account already has. The reset raises the
 * row's session_version in the same statement that writes the hash, and a
 * cookie is only honoured while it still matches — so somebody whose
 * password was changed because it had leaked is out on their next request,
 * not twelve hours later. They come back with the new password.
 */
userRouter.post('/:id/password', async (req, res) => {
  const id = userId(req.params.id);
  const { password: plain } = parse(newPassword, req.body);

  const actor = actorFrom(req.user);

  const updated = await setUserPassword(id, plain, pool, (client, row) =>
    logActivity(client, {
      actor,
      action: ACTIONS.USER_PASSWORD_RESET,
      entityType: 'user',
      entityId: row.id,
      // Never the password, and never the hash. What an admin reading this
      // needs is that a reset happened, to whom, by whom and when — all of
      // which is in the row's own columns — plus the consequence that is
      // not: every session that account held has ended.
      metadata: { sessions_revoked: true },
    }));
  if (!updated) throw new ApiError(404, 'User not found');

  res.json({ data: updated });
});
