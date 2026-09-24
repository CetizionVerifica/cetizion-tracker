import { ApiError } from '../middleware/error.js';
import { findUserById } from '../lib/users.js';
import { sessionIsLive } from '../lib/sessions.js';
import { authConfig } from './config.js';
import { sessionSubject, verifySession } from './session.js';

/**
 * Who is making this request.
 *
 * In shared mode that is settled by the cookie alone: there is one account,
 * and the signature proves it. In database mode the cookie only carries an
 * id, and the account behind it is read back from the database **on every
 * authenticated request**.
 *
 * That re-read is the whole design. Signing the role into the cookie would
 * be cheaper and would also mean an administrator demoted at noon keeps
 * administering until their session expires that evening, and somebody
 * switched off after an incident keeps working until they happen to close
 * the tab. Neither is a delay anybody would accept if it were described out
 * loud, so the database stays the only authority and the cookie is reduced
 * to a name-tag.
 *
 * Nothing is cached. A cache here is the same twelve-hour delay wearing a
 * shorter name.
 */

/** @returns the verified payload for this request, or null when signed out. */
export function readSession(req) {
  const token = req.cookies?.[authConfig.cookieName];
  return token ? verifySession(token, authConfig.sessionSecret) : null;
}

/**
 * The signed-in user, or null.
 *
 * Throws only when the database cannot answer. That is deliberate: an
 * outage must surface as a failed request, never as an unauthenticated one
 * that some later branch decides to wave through.
 */
export async function currentUser(req) {
  const payload = readSession(req);
  const subject = sessionSubject(payload, authConfig.mode);
  if (!subject) return null;
  // Already proven by the signature; carried so callers need not re-read it.
  const expiresAt = payload.exp;

  if (subject.kind === 'shared') {
    // One account, full access — the tracker has never had another kind of
    // user in this mode, so `admin` is a description, not a promotion.
    // `username` is kept because routes written before database mode read it.
    return {
      mode: 'shared', id: null, username: subject.username,
      name: subject.username, email: null, role: 'admin', expiresAt,
    };
  }

  const row = await findUserById(subject.uid);
  // Four ways to be gone, and deliberately one answer for all of them:
  //
  //   deleted since signing in        no row
  //   switched off since signing in   !row.active
  //   password reset since signing in row.session_version moved on
  //   deactivated and reactivated     row.session_version moved on, and
  //                                   stayed there — reactivating never
  //                                   lowers it, so the old cookie is
  //                                   dead for good
  //   signed out from another device  the user_sessions row is revoked
  //
  // requireAuth turns every one of them into the same "your session has
  // ended" 401. Telling them apart would answer, to whoever still holds a
  // revoked cookie, whether the account exists and what was done to it.
  //
  // The active check stands on its own rather than leaning on the counter:
  // an account switched off by something that did not raise the counter is
  // still switched off.
  if (!row || !row.active) return null;
  if (row.session_version !== subject.sv) return null;
  // One more read, and it is the one that makes "sign out that phone" mean
  // anything: a revoked row ends this request even though the signature is
  // still perfectly good.
  if (!(await sessionIsLive(subject.sid, row.id))) return null;

  return {
    mode: 'database',
    id: row.id,
    sessionId: subject.sid,
    // Same key the older routes read, so they keep recording who acted.
    username: row.email,
    name: row.name,
    email: row.email,
    role: row.role,
    expiresAt,
  };
}

export async function requireAuth(req, res, next) {
  let user;
  try {
    user = await currentUser(req);
  } catch (err) {
    // Fail closed. The request does not continue, and it is not treated as
    // signed out either — that would invite retry-until-it-opens.
    return next(err);
  }

  if (!user) return next(new ApiError(401, 'Your session has ended — sign in again'));
  req.user = user;
  next();
}

/**
 * Allow only these roles past. Reads the role off req.user, which
 * requireAuth has just refreshed from the database, so a role changed a
 * second ago is already in force here.
 *
 * Deliberately not mounted across the app yet: Phase 1B-A establishes who
 * someone is, and the routes that should care come after it.
 */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new ApiError(401, 'Your session has ended — sign in again'));
  if (!roles.includes(req.user.role)) {
    // 403, not 404: the caller is known, and hiding that the route exists
    // from somebody already signed in buys nothing.
    return next(new ApiError(403, 'You do not have access to this'));
  }
  next();
};

export const requireAdmin = requireRole('admin');
