import { pool } from '../db.js';
import { findActiveAdmin } from '../lib/users.js';
import { authConfig } from './config.js';

/**
 * The lockout guard.
 *
 * Phase 1A left this deliberately undone: while AUTH_USERNAME /
 * AUTH_PASSWORD is the real lock, a tracker with no database admin is
 * merely unfinished, and refusing to start over it would cost availability
 * to protect nothing. The moment the database becomes the only way in,
 * that same state is a locked building with the keys inside — nobody can
 * sign in, and nobody can create the account that would let them, because
 * creating accounts requires signing in.
 *
 * So `AUTH_MODE=database` will not start without at least one admin who is
 * active. It does not appoint one to get past itself: bootstrapAdmin
 * creates the first admin when it is configured to, and if it declined —
 * because the address it was given already belongs to somebody — then the
 * right answer is to stop and say so, not to invent a second administrator
 * nobody asked for.
 */

export class AuthReadinessError extends Error {}

/**
 * @returns {{mode: string, checked: boolean, adminId?: number}}
 * @throws {AuthReadinessError} database mode with nobody able to administer.
 */
export async function assertAuthReady({ db = pool, mode = authConfig.mode, log = console.log } = {}) {
  if (mode !== 'database') {
    // Shared mode is unaffected by an empty users table, and says nothing.
    return { mode, checked: false };
  }

  let admin;
  try {
    admin = await findActiveAdmin(db);
  } catch (err) {
    // Includes the users table not being there at all, which in database
    // mode is the same problem wearing a different error code.
    throw new AuthReadinessError(
      `AUTH_MODE=database, but the users table could not be read: ${err.message}`
    );
  }

  if (!admin) {
    throw new AuthReadinessError(
      'AUTH_MODE=database, but no active admin exists in the users table.\n' +
        '  Signing in would be impossible for everyone, including whoever would ' +
        'create the first account.\n' +
        '  Set BOOTSTRAP_ADMIN_NAME / BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD and ' +
        'deploy again, or run `npm run bootstrap`.\n' +
        '  AUTH_MODE=shared starts without one, because the shared password is still a way in.'
    );
  }

  log(`AUTH_MODE=database, and there is an active admin to sign in as.`);
  return { mode, checked: true, adminId: admin.id };
}
