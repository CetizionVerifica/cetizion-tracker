/**
 * The activity log (#18 Phase 1.5): one helper that writes a row saying
 * what was done and by whom, and one that turns a request's session into
 * the actor fields.
 *
 * Writing is server-internal. No route creates, edits or deletes a row
 * here; the only endpoint over the table reads (src/routes/activity.js).
 *
 * Deliberately knows nothing about Express. It takes an actor and a
 * database handle, so the same call works from a route, from a background
 * job and from a test, and so a route can hand it the client of the
 * transaction the audited change is already running in — which is the
 * point: for a security-significant act the audit row commits with the act
 * or neither of them does.
 */
import { pool } from '../db.js';

/** The three authorities a request can arrive through. Matches the CHECK. */
export const ACTOR_TYPES = ['user', 'shared_admin', 'system'];

/**
 * Every action key this phase writes. Machine keys, dotted, stable —
 * renaming one silently orphans the history already recorded under it, so
 * they live here rather than being spelled out at each call site.
 */
export const ACTIONS = {
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  USER_PASSWORD_RESET: 'user.password_reset',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  COMPANY_MERGED: 'company.merged',
  JOB_RUN: 'job.run',
  EMAIL_TEST_SENT: 'email.test_sent',
  OWNERSHIP_ASSIGNED: 'ownership.assigned',
  OWNERSHIP_REASSIGNED: 'ownership.reassigned',
  OWNERSHIP_UNASSIGNED: 'ownership.unassigned',
  TARGET_CREATED: 'target.created',
  TARGET_UPDATED: 'target.updated',

  // The sales workflow (#18 §3). A status change is its own action rather
  // than a field inside `*.updated`: "moved to Won" is what a timeline, a
  // KPI and a handover argument all look for, and burying it in a generic
  // edit means every reader has to parse metadata to find it.
  ENQUIRY_CREATED: 'enquiry.created',
  ENQUIRY_UPDATED: 'enquiry.updated',
  ENQUIRY_STATUS_CHANGED: 'enquiry.status_changed',
  QUOTATION_CREATED: 'quotation.created',
  QUOTATION_UPDATED: 'quotation.updated',
  QUOTATION_STATUS_CHANGED: 'quotation.status_changed',
  QUOTATION_CONVERTED: 'quotation.converted',
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_STATUS_CHANGED: 'project.status_changed',
  STAGE_INVOICED: 'stage.invoiced',
  PAYMENT_RECORDED: 'payment.recorded',
};

/**
 * Sign-in is deliberately NOT here.
 *
 * @Hayyan612's #83 review called missing sign-in events "the biggest gap"
 * in this table, and on the face of it that is right. But `auth_events`
 * (040) already records every success and failure with the address and the
 * reason, and it is not a log the rate limiter happens to write — it is the
 * limiter's own store, read by recentFailures() to decide a lockout.
 * Copying those rows here would give one event two homes that can disagree,
 * which is the shape of problem this codebase keeps refusing elsewhere.
 *
 * What 040 was genuinely missing is fixed in 065 instead: it keyed a
 * sign-in to a typed username rather than to an account, and it recorded no
 * sign-out at all.
 */

/** Whoever asked, nobody did — a scheduled job, a migration, a script. */
export const SYSTEM_ACTOR = Object.freeze({ type: 'system', userId: null, name: null });

/**
 * The actor behind a request.
 *
 *   database mode   the account's own id, actor_type 'user'
 *   shared mode     no id at all, actor_type 'shared_admin'
 *
 * No row is invented for the shared admin. AUTH_USERNAME is a name in the
 * environment, not a person in the users table, and writing it into
 * actor_user_id would either need a fake account — which the Users screen
 * would then list and somebody would then try to sign in as — or would put
 * a number there that points at whoever happens to hold that id.
 *
 * The name is carried instead, and logActivity puts it in metadata where it
 * is plainly a label rather than an identity. That matches what the tracker
 * already does: email_log.sent_by and job_runs.started_by have recorded the
 * shared username as text since #21.
 *
 * Throws rather than guessing. Every audited route is behind requireAuth,
 * so an unrecognised session here is a bug, and the safe way for a bug to
 * surface on a security-significant path is a failed request.
 */
export function actorFrom(user) {
  if (user?.mode === 'database' && Number.isSafeInteger(user.id) && user.id > 0) {
    return { type: 'user', userId: user.id, name: user.name ?? null };
  }
  if (user?.mode === 'shared') {
    return { type: 'shared_admin', userId: null, name: user.username ?? null };
  }
  throw new Error('Cannot record activity: the request has no recognised signed-in user.');
}

/**
 * The actor behind an MCP call.
 *
 * A bearer token rather than a session cookie, but the same two shapes and
 * the same rule: the identity comes from the credential, never from the
 * payload. An import can carry its own `created_by` — that is what the
 * column is for — and it does not touch who the audit trail says acted.
 *
 *   sales token   `users.id`, since 063 bound every live one to an account.
 *   admin token   no account exists behind it, so `shared_admin` — the same
 *                 classification the legacy shared login gets, and for the
 *                 same reason: an administrator with no users row. The
 *                 token's own name is carried as the label, which is what
 *                 makes "Reporting" distinguishable from "Claude desktop"
 *                 in the log.
 *
 * Returns null rather than throwing when there is no token at all. Unlike a
 * request, an MCP writer can legitimately be called without one — the sheet
 * importer's own tests drive it directly — and the writers treat a missing
 * actor as "do not record" rather than as a failure.
 */
export function actorFromToken(token) {
  if (!token) return null;
  if (Number.isSafeInteger(token.user_id) && token.user_id > 0) {
    return { type: 'user', userId: token.user_id, name: token.person ?? null };
  }
  return { type: 'shared_admin', userId: null, name: token.name ?? token.person ?? null };
}

// Anything whose name suggests it would let somebody act as the person
// audited. A backstop, not a licence: call sites are expected not to pass
// these at all, and this exists so that one day somebody spreading a whole
// request body into metadata does not put a password in the audit trail.
const SECRET_KEY = /pass(word|phrase)?|secret|token|cookie|hash|auth|credential|session_secret|api[-_]?key/i;

// Metadata is context an admin reads, not a payload. A job result or an
// imported sheet would blow past this; the cap turns that into a visible
// truncation rather than an audit table full of somebody's spreadsheet.
const MAX_METADATA_BYTES = 8_000;

/**
 * Drop the keys that must never be recorded, and the ones carrying nothing.
 * Recursive, because a nested object is exactly where one gets in.
 */
function safeMetadata(value, depth = 0) {
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.map((v) => safeMetadata(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    if (raw === undefined) continue;
    out[key] = safeMetadata(raw, depth + 1);
  }
  return out;
}

function encodeMetadata(metadata) {
  if (metadata === null || metadata === undefined) return '{}';
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Activity metadata must be an object.');
  }
  const json = JSON.stringify(safeMetadata(metadata));
  if (json.length > MAX_METADATA_BYTES) {
    return JSON.stringify({ truncated: true, bytes: json.length });
  }
  return json;
}

const text = (value) => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
};

/**
 * Record one act.
 *
 * @param db      a pool, or the client of the transaction the audited
 *                change is running in — pass the client whenever there is
 *                one, so the two commit together.
 * @param actor      from actorFrom(req.user), or SYSTEM_ACTOR.
 * @param action     one of ACTIONS.
 * @param entityType what kind of thing was acted on ('user', 'company', …).
 * @param entityId   which one; null when the act names no single row.
 * @param metadata   non-secret context only.
 *
 * Never swallows a failure. A caller that cannot record what it did must
 * not report having done it.
 */
export async function logActivity(db = pool, { actor, action, entityType, entityId = null, metadata = {} } = {}) {
  if (!actor || !ACTOR_TYPES.includes(actor.type)) {
    throw new Error(`Activity actor_type must be one of: ${ACTOR_TYPES.join(', ')}.`);
  }
  if (actor.type !== 'user' && actor.userId !== null && actor.userId !== undefined) {
    throw new Error('Only a database user has an actor id.');
  }

  const cleanAction = text(action);
  const cleanEntityType = text(entityType);
  if (!cleanAction) throw new Error('An activity row needs an action.');
  if (!cleanEntityType) throw new Error('An activity row needs an entity type.');

  // The name goes in the row for every kind of actor, the shared admin and a
  // system label included.
  //
  // For a database user it is not redundant with actor_user_id: that column
  // is ON DELETE SET NULL, so deleting an account would otherwise leave
  // `{ actor: null, actor_type: 'user' }` — you would know a person did it
  // and never which person. Surviving exactly that deletion is the reason
  // the column is SET NULL rather than CASCADE.
  const withActorName = actor.name ? { actor_name: actor.name, ...metadata } : metadata;

  const { rows } = await db.query(
    `INSERT INTO activity_log (actor_user_id, actor_type, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, actor_user_id, actor_type, action, entity_type, entity_id, metadata, created_at`,
    [
      actor.type === 'user' ? (actor.userId ?? null) : null,
      actor.type,
      cleanAction,
      cleanEntityType,
      text(entityId),
      encodeMetadata(withActorName),
    ]
  );
  return rows[0];
}
