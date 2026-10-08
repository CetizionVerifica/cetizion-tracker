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
  // Who a record belongs to, and what it is measured against (#18).
  OWNERSHIP_ASSIGNED: 'ownership.assigned',
  OWNERSHIP_REASSIGNED: 'ownership.reassigned',
  OWNERSHIP_UNASSIGNED: 'ownership.unassigned',
  TARGET_CREATED: 'target.created',
  TARGET_UPDATED: 'target.updated',
  // Money (#85). An expense claim's approval and its reimbursement are the
  // two acts that turn a submitted claim into a payment, and a vendor
  // invoice's payment is the same act on the other side of a trip. Each is
  // recorded with the account that performed it, in the same transaction as
  // the change itself, so the trail cannot disagree with the record.
  CLAIM_DECIDED: 'claim.decided',
  CLAIM_REIMBURSED: 'claim.reimbursed',
  CLAIM_CORRECTED: 'claim.corrected',
  VENDOR_INVOICE_PAID: 'vendor_invoice.paid',
  // Which client invoice a trip's cost was billed on (#214). The link is
  // what makes a trip's cost recoverable, so it moves through its own
  // route and leaves the account that moved it behind.
  TRIP_BILLED_STAGE_SET: 'travel_log.billed_stage_set',
  // A quotation read from the PDF we emailed, checked against it by a person
  // (docs/email-enquiries-plan.md §3.9.6).
  QUOTATION_EMAIL_READ_CHECKED: 'quotation.email_read_checked',
  // A PO registered from a client's email, checked by a person against the
  // PO (docs/email-po-plan.md §3.8): its stages may be chased from then on.
  PURCHASE_ORDER_EMAIL_READ_CHECKED: 'purchase_order.email_read_checked',
  // What one email entered, taken back out by an admin (docs/email-auto-entry-plan.md §3.10).
  PURCHASE_ORDER_EMAIL_UNDONE: 'purchase_order.email_undone',
  INVOICE_EMAIL_UNDONE: 'payment_stage.email_invoice_undone',
  // Who a personal mailbox belongs to, changed by an admin
  // (docs/per-user-mailboxes-plan.md §4.3). Records already made stay put.
  MAILBOX_OWNER_CHANGED: 'mailbox.owner_changed',
};

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
