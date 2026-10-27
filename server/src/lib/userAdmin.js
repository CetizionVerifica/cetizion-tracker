import { z } from 'zod';

import { pool } from '../db.js';
import { ACTIONS } from './activity.js';
import { disconnect as disconnectMailbox } from './mailbox/sync.js';
import { passwordProblem } from './passwords.js';
import { ActiveNeedsLoginError, DuplicateEmailError, LastAdminError, ROLES } from './users.js';
import { ApiError } from '../middleware/error.js';

/**
 * What the super admin portal checks before it changes an account
 * (routes/superAdmin.js): the request shapes, the ids, the errors it gives
 * back, and what each edit is called in the activity log.
 *
 * Passwords are never part of an edit: a name change must not be able to
 * carry a new password along with it, so that is its own request.
 */

const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

export const name = z.string().trim().min(1, 'Enter a name').max(160);
export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);
export const role = z.enum(ROLES, { message: `Role must be ${ROLES.slice(0, -1).join(', ')} or ${ROLES.at(-1)}` });
export const password = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  // The helper's own words, so the policy is stated in exactly one place.
  if (problem) ctx.addIssue({ code: 'custom', message: `Password is not usable: ${problem}` });
});

export const newUser = z.object({
  name,
  email,
  role: role.default('sales'),
  password,
  active: z.boolean().default(true),
});

const optionalText = (max) => z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();

/** Every field optional, and `password` deliberately absent. */
export const userChanges = z
  .object({
    name: name.optional(),
    email: z.preprocess(blankToNull, email.nullable()).optional(),
    role: role.optional(),
    active: z.boolean().optional(),
    // false exempts them from the personal daily MIS (mis-report-sender-plan.md §B2).
    daily_mis: z.boolean().optional(),
    phone: optionalText(40),
    time_zone: optionalText(60),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const profileExtras = z.object({ phone: optionalText(40), time_zone: optionalText(60) });

export const newPassword = z.object({ password });

export const parse = (schema, body) => {
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
 * is how a too-big id became a 500 carrying a database range error instead
 * of a plain "not found".
 *
 * Every rejection here is the same 404 the database gives for an id nobody
 * holds — too big, zero, negative, not a number, or simply gone.
 */
const MAX_USER_ID = 2_147_483_647;

export const userId = (raw) => {
  if (!/^\d+$/.test(raw)) throw new ApiError(404, 'User not found');
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_USER_ID) {
    throw new ApiError(404, 'User not found');
  }
  return id;
};

/** Turn the data layer's refusals into the answers the API gives. */
export function asApiError(err) {
  if (err instanceof LastAdminError) return new ApiError(409, err.message);
  if (err instanceof DuplicateEmailError) {
    return new ApiError(422, 'Please check the highlighted fields', { fields: { email: err.message } });
  }
  // Switching on an attribution-only row. The table refuses it through
  // users_active_needs_login; what reaches the client is the same shape as
  // any other rejected field, and never the constraint's name.
  if (err instanceof ActiveNeedsLoginError) {
    return new ApiError(422, 'Please check the highlighted fields', {
      fields: { email: err.message, password: err.message },
    });
  }
  return err;
}

/**
 * What one edit is called in the activity log. Switching an account off or
 * back on is the change somebody will come looking for, so it gets its own
 * name — and only one; `changed_fields` says what else moved.
 */
export function userEditAction(before, after) {
  if (before && before.active !== after.active) {
    return after.active ? ACTIONS.USER_REACTIVATED : ACTIONS.USER_DEACTIVATED;
  }
  return ACTIONS.USER_UPDATED;
}

/** Which of the editable fields actually moved, and what the notable ones moved from. */
export function userEditMetadata(before, after) {
  const fields = ['name', 'email', 'role', 'active', 'daily_mis', 'phone', 'time_zone'];
  const changed = before ? fields.filter((f) => before[f] !== after[f]) : fields;
  const metadata = { changed_fields: changed };

  // What it changed from and to, not only that it changed: an account
  // repointed at an address somebody controls is the case this log is for.
  for (const field of ['name', 'email', 'daily_mis', 'role', 'active']) {
    if (before && changed.includes(field)) {
      metadata[`old_${field}`] = before[field];
      metadata[`new_${field}`] = after[field];
    }
  }
  // Switching somebody off raises their session_version in the same
  // statement, which ends the sessions they were holding.
  if (before && changed.includes('active') && !after.active) metadata.sessions_revoked = true;
  return metadata;
}

/**
 * Stop syncing every mailbox a user connected; returns the addresses that
 * were stopped. Outside the edit's transaction on purpose: it talks to
 * Microsoft, and a slow provider must not hold a deactivation up or roll it
 * back. The stored mail stays.
 */
export async function disconnectMailboxesOf(id) {
  const { rows } = await pool.query(`SELECT id, email FROM connected_accounts WHERE user_id = $1 AND status <> 'disconnected'`, [id]);
  const disconnected = [];
  for (const a of rows) {
    try { await disconnectMailbox(a.id, { removeBodies: false }); disconnected.push(a.email); } catch { /* the row records its own error; the admin sees it under Mailboxes */ }
  }
  return disconnected;
}
