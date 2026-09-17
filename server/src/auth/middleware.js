import { ApiError } from '../middleware/error.js';
import { findUserById } from '../lib/users.js';
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
  // Deleted since signing in, switched off since signing in: both are gone.
  if (!row || !row.active) return null;

  return {
    mode: 'database',
    id: row.id,
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
