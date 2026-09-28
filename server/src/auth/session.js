import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sessions are a signed payload in a cookie rather than rows in a table.
 * Nothing to store, nothing to clean up, and the API can be restarted or run
 * twice over without anyone losing their place.
 *
 * Two shapes travel in that cookie, one per sign-in mode:
 *
 *   shared    { sub: 'admin', exp }           — unchanged since the first
 *                                               release, so deploying
 *                                               database support signs
 *                                               nobody out
 *   database  { v: 2, uid: 123, sv: 1, exp } — an id, the revocation
 *                                               counter it was signed at,
 *                                               and nothing else
 *
 * What a database session deliberately does NOT carry is the role, the
 * name or whether the account is still active. A cookie is a snapshot,
 * good for twelve hours; an administrator who has been demoted, or an
 * account switched off this morning, must not keep its powers until the
 * snapshot expires. Only the id is worth signing, because only the id
 * cannot go stale — everything else is read back per request.
 *
 * `sv` is not an exception to that. It is not a fact about the user that
 * anything trusts; it is a number the row must still agree with, and the
 * row is what is believed. Signing it is what gives the database a way to
 * say "not that cookie" about a session it never stored — a password reset
 * or a deactivation raises the row's counter, and every cookie already
 * issued stops matching. See middleware.currentUser.
 *
 * A v2 cookie from before `sv` existed carries no counter and is refused
 * rather than assumed to be version 1. Fail closed: the whole point of the
 * counter is that a cookie cannot vouch for itself.
 */

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const macOf = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

/**
 * Compare without leaking, through timing, how much of the input was right.
 * Both sides are hashed first so that even the length gives nothing away.
 */
export function constantTimeEqual(a, b) {
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function signSession(payload, secret) {
  const body = encode(payload);
  return `${body}.${macOf(body, secret)}`;
}

/** @returns the payload, or null for anything that is not a live, untampered token. */
export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;

  if (!constantTimeEqual(mac, macOf(body, secret))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return payload;
}

/**
 * The database session shape. Bumped if that payload ever changes meaning.
 *
 * 3 added `sid`, the row in user_sessions this cookie belongs to. Like `sv`
 * before it, it is required rather than defaulted: a cookie with no session
 * id is one signed before sessions could be listed or ended, and there is
 * no honest value to assume for it. Everybody signs in once more, which is
 * the same trade version 2 made.
 */
export const DATABASE_SESSION_VERSION = 3;

export const sharedPayload = (username, expiresAt) => ({ sub: username, exp: expiresAt });

export const databasePayload = (userId, sessionVersion, expiresAt, sessionId) => ({
  v: DATABASE_SESSION_VERSION,
  uid: userId,
  sv: sessionVersion,
  sid: sessionId,
  exp: expiresAt,
});

/**
 * Who a verified payload claims to be, *for the mode the API is running
 * in*, or null when it is not a session this mode accepts.
 *
 * The mode check is the point. A shared cookie signed before a cutover is
 * refused once the API runs on the database, and a database cookie is
 * refused while the API is back on the shared password. Both are signed
 * with the same secret, so without this a mode switch would leave the
 * other mode's sessions quietly working — one lock opened by two keys,
 * only one of which anybody is watching.
 *
 * @returns {{kind: 'shared', username: string}
 *          | {kind: 'database', uid: number, sv: number, sid: string}
 *          | null}
 */
export function sessionSubject(payload, mode) {
  if (!payload || typeof payload !== 'object') return null;

  if (mode === 'database') {
    const ok =
      payload.v === DATABASE_SESSION_VERSION &&
      Number.isSafeInteger(payload.uid) && payload.uid > 0 &&
      // Required, not defaulted. A cookie with no counter is one signed
      // before revocation existed, and there is no honest value to assume
      // for it — assuming 1 would let exactly the cookies this feature
      // exists to end carry on working.
      Number.isSafeInteger(payload.sv) && payload.sv > 0 &&
      // Same reasoning as `sv`: no session id, no session row to end.
      typeof payload.sid === 'string' && payload.sid.length > 0;
    return ok ? { kind: 'database', uid: payload.uid, sv: payload.sv, sid: payload.sid } : null;
  }

  // Shared: the original shape, which carries no version at all. Anything
  // versioned is from another mode and is not ours to accept.
  return payload.v === undefined && typeof payload.sub === 'string' && payload.sub !== ''
    ? { kind: 'shared', username: payload.sub }
    : null;
}
