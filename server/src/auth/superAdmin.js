import { config } from '../config.js';
import { authConfig } from './config.js';
import { constantTimeEqual, signSession, verifySession } from './session.js';
import { verifyPassword } from '../lib/passwords.js';
import { ApiError } from '../middleware/error.js';

/**
 * The super admin: the one account that manages every other account, from
 * its own portal at /super-admin.
 *
 * Held in the environment, like AUTH_USERNAME / AUTH_PASSWORD, and never in
 * the users table — so no admin inside the tracker can edit, demote or
 * delete it, and it still works when the users table is empty or broken.
 *
 *   SUPER_ADMIN_EMAIL      the address typed on the portal's sign-in form
 *   SUPER_ADMIN_PASSWORD   the password as typed, or a scrypt hash from
 *                          `npm run hash-password` (scrypt$v1$...)
 *
 * Both blank: the portal is switched off and every route under it is a 404.
 *
 * Its session is a cookie of its own, signed with a key of its own (derived
 * from SESSION_SECRET, as the client portal's is), so a super admin cookie
 * can never pass as a staff session, nor a staff cookie as this one.
 */

export const SUPER_ADMIN_COOKIE = 'cetizion_super_admin';
export const SUPER_ADMIN_COOKIE_PATH = '/api/super-admin';
const SESSION_HOURS = 8;
export const MIN_SUPER_ADMIN_PASSWORD = 14;

const superAdminKey = () => `${authConfig.sessionSecret}:super-admin`;
// The whole shape hashPassword writes (scrypt$v1$N$r$p$salt$key), not just
// its first word: a plain password that happens to start with "scrypt$" is
// a password, and must be compared as one.
const HASH_SHAPE = /^scrypt\$v1\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=_-]+\$[A-Za-z0-9+/=_-]+$/;
const isHash = (value) => HASH_SHAPE.test(value);

/**
 * Why a password may not lock the super admin portal, or null when it may.
 * The hash script asks this before hashing, because once hashed a short
 * password can no longer be told from a long one.
 */
export function superAdminPasswordProblem(password) {
  if (String(password).length < MIN_SUPER_ADMIN_PASSWORD) {
    return `it must be at least ${MIN_SUPER_ADMIN_PASSWORD} characters`;
  }
  return null;
}

let warned = false;

/**
 * Who the super admin is, or null when the portal is switched off.
 *
 * Read per call rather than once at import, so a test can set the
 * environment before asking. In production a short plain password switches
 * the portal off with a warning instead of stopping the whole API: the
 * tracker staying up matters more than this one door being open.
 */
export function superAdminConfig() {
  const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.SUPER_ADMIN_PASSWORD || '');
  if (!email || !password) return null;

  if (config.nodeEnv === 'production' && !isHash(password) && superAdminPasswordProblem(password)) {
    if (!warned) {
      warned = true;
      console.warn(`[super-admin] SUPER_ADMIN_PASSWORD is shorter than ${MIN_SUPER_ADMIN_PASSWORD} characters — the super admin portal is switched off until it is changed.`);
    }
    return null;
  }
  return { email, password, sessionMs: SESSION_HOURS * 60 * 60 * 1000 };
}

/**
 * Does this email and password belong to the super admin?
 *
 * Both checks always run, so a wrong email and a wrong password take the
 * same time and give the same answer.
 */
export async function checkSuperAdmin(email, password, settings = superAdminConfig()) {
  if (!settings) return false;
  const emailOk = constantTimeEqual(String(email || '').trim().toLowerCase(), settings.email);
  const passwordOk = isHash(settings.password)
    ? await verifyPassword(String(password || ''), settings.password)
    : constantTimeEqual(String(password || ''), settings.password);
  return emailOk && passwordOk;
}

/** `sa: 1` marks the shape; the staff session never carries it. */
export function superAdminToken(email, expiresAt) {
  return signSession({ sa: 1, sub: email, exp: expiresAt }, superAdminKey());
}

export const superAdminCookieOptions = () => ({
  httpOnly: true,
  sameSite: 'strict',
  secure: authConfig.secureCookie,
  path: SUPER_ADMIN_COOKIE_PATH,
});

/**
 * The super admin behind this request, or null.
 *
 * The email in the cookie must still be the one in the environment, so
 * changing SUPER_ADMIN_EMAIL ends every session signed for the old one.
 */
export function currentSuperAdmin(req) {
  const settings = superAdminConfig();
  if (!settings) return null;
  const payload = verifySession(req.cookies?.[SUPER_ADMIN_COOKIE], superAdminKey());
  if (!payload || payload.sa !== 1 || payload.sub !== settings.email) return null;
  return { email: payload.sub, expiresAt: payload.exp };
}

/** Every route under /api/super-admin is a 404 while the portal is switched off. */
export function superAdminEnabled(req, res, next) {
  if (!superAdminConfig()) return next(new ApiError(404, 'Not found'));
  next();
}

export function requireSuperAdmin(req, res, next) {
  const superAdmin = currentSuperAdmin(req);
  if (!superAdmin) return next(new ApiError(401, 'Please sign in to the super admin portal'));
  req.superAdmin = superAdmin;
  next();
}

/**
 * How the super admin appears in the activity log: its own actor type, so
 * its acts are never mistaken for the shared tracker login's. It is not a
 * users row, so it is recorded by name with no id.
 */
export const superAdminActor = (superAdmin) => ({
  type: 'super_admin',
  userId: null,
  name: `Super admin (${superAdmin.email})`,
});
