/**
 * Sessions you can see and end (C20).
 *
 * The cookie still proves who somebody is; this table is what can be taken
 * away. A row per sign-in, checked on every authenticated request, so
 * "sign out that phone" is a real button rather than a list nobody can act
 * on.
 *
 * The read on the hot path is a SELECT, not an UPDATE. Stamping
 * `last_seen_at` on every request would write a new row version per page
 * view for no benefit — a minute's resolution is more than enough to tell
 * "now" from "two hours ago", which is all the screen says.
 */
import { pool, query } from '../db.js';

/** How stale last_seen_at may get before a request bothers to move it. */
const TOUCH_AFTER_MS = 60_000;

/** Only what a device's own user-agent is worth keeping: enough to recognise it. */
const UA_MAX = 300;

export const SIGN_IN_METHODS = ['password', 'microsoft', 'google'];

/**
 * Start a session and return its id, for signing into the cookie.
 *
 * `via` is how they got in. It is recorded rather than derived because by
 * the time anyone reads the list, the provider that issued it may have
 * been unlinked.
 */
export async function startSession({ userId, via = 'password', req }, db = pool) {
  const { rows: [row] } = await db.query(
    `INSERT INTO user_sessions (user_id, via, user_agent, ip)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, SIGN_IN_METHODS.includes(via) ? via : 'password',
      String(req?.get?.('user-agent') || '').slice(0, UA_MAX) || null,
      req?.ip || null]);
  return row.id;
}

/**
 * Is this session still live?
 *
 * Returns false for a row that was revoked, belongs to somebody else, or
 * was never there — one answer for all three, the way currentUser already
 * treats its four ways of being gone.
 */
export async function sessionIsLive(sessionId, userId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  // A failed query is NOT "no row". This read decides every authenticated
  // request, and swallowing the error here turned a momentary database
  // failure into a spurious 401 — the one answer currentUser's own comment
  // says it must not give for anything but a session that really has ended.
  // requireAuth already routes a thrown error to next(err), deliberately,
  // so that a blip is a 500 nobody retries their way past rather than a
  // sign-out. Letting it throw is what makes that work.
  const { rows: [row] } = await query(
    `SELECT revoked_at, last_seen_at FROM user_sessions WHERE id = $1 AND user_id = $2`,
    [sessionId, userId]);
  if (!row || row.revoked_at) return false;

  if (Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_AFTER_MS) {
    // Not awaited: a slow write must not slow down every request, and a
    // missed stamp costs a minute of accuracy on one line of one screen.
    query('UPDATE user_sessions SET last_seen_at = now() WHERE id = $1', [sessionId]).catch(() => {});
  }
  return true;
}

/** Everything still live for this person, newest activity first. */
export async function listSessions(userId) {
  const { rows } = await query(
    `SELECT id, via, user_agent, ip, created_at, last_seen_at
       FROM user_sessions
      WHERE user_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC LIMIT 50`,
    [userId]);
  return rows;
}

/** End one. Returns false when it was not theirs to end. */
export async function revokeSession(sessionId, userId) {
  // Same reason as sessionIsLive, read the other way round: a swallowed
  // error here reports "not yours to end" about a session that is still
  // live, so somebody told to sign a lost phone out is told it was already
  // gone. revokeAllSessions below never did this; these two were the
  // outliers.
  const { rowCount } = await query(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId]);
  return rowCount > 0;
}

/**
 * End all of them, optionally sparing the one asking.
 *
 * The session_version bump is what reaches cookies signed before this table
 * existed — they carry no session id, so there is no row to revoke, and
 * raising the counter is the only thing that stops them. It is also the
 * design's "rotate the user's session salt": one person's sessions end,
 * not everybody's.
 */
export async function revokeAllSessions(userId, { except = null } = {}) {
  const { rowCount } = await query(
    `UPDATE user_sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, except]);
  if (!except) await query('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [userId]);
  return rowCount;
}
