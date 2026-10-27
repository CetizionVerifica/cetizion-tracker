import { createHash } from 'node:crypto';
import XLSX from 'xlsx';

import { pool } from '../db.js';
import { config } from '../config.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, logActivity } from './activity.js';
import { businessYear } from './businessDate.ts';
import {
  USER_BACKUP_FOLDER, documentStorageReady, fetchDocument, purgeAfterCommit, uploadDocument,
} from './documents.js';
import { changeRecordOwner } from './ownershipHistory.js';
import { ADMIN_INVARIANT_LOCK_KEY, notDeleted, refuseIfNoAdminLeft } from './users.js';

/**
 * Deleting an account from the super admin portal, without losing track of
 * what it owned.
 *
 * In order, and nothing is deleted unless every step before it worked:
 *
 *   1. The user is locked for this deletion, so a second request (a double
 *      click, a second tab) is turned away rather than run twice.
 *   2. An Excel backup is built of everything they owned or created, their
 *      sales targets, and their history.
 *   3. It is stored privately (documents.js: authenticated Cloudinary,
 *      served only through the API), then read back and checked: same
 *      SHA-256, and every sheet opens with the rows it was written with.
 *   4. One transaction: their records must be exactly as they were when the
 *      backup was made; their open records move to the replacement through
 *      changeRecordOwner (ownership_history and the activity log, as any
 *      reassignment); this year's and later sales targets move only if the
 *      super admin asked; the deleted_users row is written; the account is
 *      archived; one active admin must remain.
 *
 * A failure anywhere rolls the transaction back, removes the uploaded
 * backup, and is recorded as user.deletion_failed.
 *
 * Archived, not removed. The records belong to the company: closed ones
 * keep this person as their owner, and past targets stay theirs, so every
 * report that names who did the work goes on naming them. The account is
 * switched off, its password and sign-in identities are removed, its
 * sessions end, its email is freed for a new account, and the screens that
 * manage accounts no longer list it.
 */

/**
 * Where backups are kept. One object, so a test can stand in for Cloudinary
 * without the suite ever uploading anything.
 */
export const backupStore = {
  ready: () => documentStorageReady,
  upload: uploadDocument,
  fetch: fetchDocument,
  discard: purgeAfterCommit,
};

// Taken for the length of one deletion, on (this key, the user's id).
const DELETION_LOCK_KEY = 72_910_031;
// Excel refuses a cell longer than this.
const MAX_CELL = 32_000;
// Enough for years of anybody's activity; a cap so one account cannot make a
// file storage refuses.
const MAX_ACTIVITY_ROWS = 20_000;

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Which of their records still need somebody: the same definitions the follow-ups and KPIs use. */
const OPEN = {
  enquiries: `t.status IN ('New','Contacted','Qualified','Nurture')`,
  quotations: `t.status NOT IN ('Won - PO Received','Lost')`,
  // A project has no status column: active while the work is not complete
  // or money is still to bill or to collect.
  projects: `(t.percent_complete < 1 OR COALESCE(v.balance_due_now, 0) > 0 OR COALESCE(v.balance_to_bill, 0) > 0)`,
};
const VIEW = { enquiries: 'v_enquiries', quotations: 'v_quotations', projects: 'v_projects' };
const LABEL = { enquiries: 'Enquiries', quotations: 'Quotations', projects: 'Projects' };
const RECORD_TYPES = Object.keys(OPEN);

const linkOf = `CASE WHEN t.owner_user_id = $1 AND t.originating_user_id = $1 THEN 'Owner and creator'
                     WHEN t.owner_user_id = $1 THEN 'Owner' ELSE 'Creator' END`;

/** The records they own or created, with whether each is still open. */
async function associatedRecords(db, type, userId) {
  const { rows } = await db.query(
    `SELECT ${linkOf} AS "Link", (t.owner_user_id = $1 AND ${OPEN[type]}) AS "Open (moves)", v.*
       FROM ${type} t JOIN ${VIEW[type]} v ON v.id = t.id
      WHERE t.owner_user_id = $1 OR t.originating_user_id = $1
      ORDER BY t.id`,
    [userId]
  );
  return rows;
}

/**
 * Everything the deletion depends on, as one hash: their records and
 * targets, and the replacement's targets (which decide whether a target
 * can move). Taken when the backup is made and again under lock; any
 * difference means the backup no longer describes what is being deleted.
 */
async function fingerprint(db, userId, replacementId) {
  const { rows: [r] } = await db.query(
    `SELECT md5(concat_ws('#',
       COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM enquiries t WHERE t.owner_user_id = $1 OR t.originating_user_id = $1), ''),
       COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM quotations t WHERE t.owner_user_id = $1 OR t.originating_user_id = $1), ''),
       COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM projects t WHERE t.owner_user_id = $1 OR t.originating_user_id = $1), ''),
       COALESCE((SELECT string_agg(t::text, '|' ORDER BY t.id) FROM sales_targets t WHERE t.salesperson_user_id IN ($1, $2)), '')
     )) AS fp`,
    [userId, replacementId ?? 0]
  );
  return r.fp;
}

/** Who may take over open records: what changeRecordOwner accepts. */
async function candidates(db, userId) {
  const { rows } = await db.query(
    `SELECT id, name, email FROM users
      WHERE active AND role = 'sales' AND email IS NOT NULL AND id <> $1
      ORDER BY lower(name), id`,
    [userId]
  );
  return rows;
}

const targetKey = (t) => `${t.calendar_year}|${t.metric}|${t.currency ?? ''}`;

/**
 * What will happen to each sales target, decided from the rows as they are.
 * Past years always stay with the person, so the reports of those years
 * still compare them with what they achieved. This year's and later ones
 * move only when the super admin asked, and never onto a target the
 * replacement already has.
 */
function planTargets(targets, replacementTargets, { user, replacement, moveTargets, year }) {
  const taken = new Set(replacementTargets.map(targetKey));
  return targets.map((t) => {
    if (t.calendar_year < year) return { target: t, action: 'keep', note: `Stays with ${user.name} (past year)` };
    if (!moveTargets || !replacement) return { target: t, action: 'keep', note: `Stays with ${user.name}` };
    if (taken.has(targetKey(t))) {
      return { target: t, action: 'keep', note: `Stays with ${user.name} (${replacement.name} already has this target)` };
    }
    return { target: t, action: 'move', note: `Moves to ${replacement.name}` };
  });
}

const NOT_DELETED = notDeleted('u');

/**
 * API tokens are tied to a person by name (api_tokens.person), not by id.
 * A deleted person's still-working tokens would go on reading the records
 * that still name them, so the deletion revokes them.
 */
const LIVE_TOKENS = `FROM api_tokens WHERE revoked_at IS NULL AND role <> 'admin' AND lower(btrim(person)) = lower(btrim($1))`;

/**
 * What deleting this user would involve, for the confirmation screen.
 * Reads only.
 */
export async function deletionPlan(userId, db = pool) {
  const { rows: [user] } = await db.query(
    `SELECT u.id, u.name, u.email, u.role, u.active FROM users u WHERE u.id = $1 AND ${NOT_DELETED}`, [userId]);
  if (!user) return null;

  const records = {};
  for (const type of RECORD_TYPES) {
    const rows = await associatedRecords(db, type, userId);
    records[type] = {
      total: rows.length,
      open_owned: rows.filter((r) => r['Open (moves)']).length,
    };
  }
  const { rows: targets } = await db.query(
    'SELECT calendar_year FROM sales_targets WHERE salesperson_user_id = $1', [userId]);
  const year = businessYear();

  // The tracker always keeps one active admin (users.js). Asked here, before
  // any backup is made, so the screen can say so rather than fail at the end.
  const { rows: [admins] } = await db.query(
    `SELECT count(*)::int AS n FROM users u WHERE u.role = 'admin' AND u.active AND u.id <> $1 AND ${NOT_DELETED}`, [userId]);

  const { rows: [tokens] } = await db.query(`SELECT count(*)::int AS n ${LIVE_TOKENS}`, [user.name]);

  const openOwned = RECORD_TYPES.reduce((n, type) => n + records[type].open_owned, 0);
  return {
    api_tokens: tokens.n,
    user,
    records,
    admin_remains: admins.n > 0,
    open_owned: openOwned,
    needs_replacement: openOwned > 0,
    targets: {
      total: targets.length,
      past: targets.filter((t) => t.calendar_year < year).length,
      current_or_future: targets.filter((t) => t.calendar_year >= year).length,
    },
    candidates: await candidates(db, userId),
    storage_ready: backupStore.ready(),
  };
}

// ------------------------------------------------------------- the workbook

/** One cell's worth: dates kept as dates, JSON as text, nothing over Excel's limit. */
function cell(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return `(${value.length} bytes of file data)`;
  if (typeof value === 'object') value = JSON.stringify(value);
  if (typeof value === 'string' && value.length > MAX_CELL) return `${value.slice(0, MAX_CELL)}… (cut short)`;
  return value;
}

const cleanRows = (rows) => rows.map((row) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)])));

/**
 * The sheets, in order. Every value is written as data: SheetJS writes
 * strings as text cells, so a note beginning with "=" is not a formula.
 */
async function collectSheets(db, { user, replacement, targetPlan, deletedBy, year }) {
  const userId = user.id;
  const sheets = [];
  const counts = {};

  for (const type of RECORD_TYPES) {
    const rows = (await associatedRecords(db, type, userId)).map((r) => ({
      ...r,
      'Open (moves)': r['Open (moves)'] ? 'Yes' : 'No',
      'Moves to': r['Open (moves)'] && replacement ? replacement.name : '',
    }));
    sheets.push({ name: LABEL[type], rows });
  }

  const { rows: purchaseOrders } = await db.query(
    `SELECT v.* FROM v_purchase_orders v
      WHERE v.project_id IN (SELECT p.project_id FROM projects p WHERE p.owner_user_id = $1 OR p.originating_user_id = $1)
         OR v.quotation_no IN (SELECT q.quotation_no FROM quotations q WHERE q.owner_user_id = $1 OR q.originating_user_id = $1)
      ORDER BY v.id`,
    [userId]
  );
  sheets.push({ name: 'Purchase orders', rows: purchaseOrders });

  const poNumbers = purchaseOrders.map((po) => po.po_number);
  const { rows: stages } = await db.query(
    'SELECT v.* FROM v_payment_stages v WHERE v.po_number = ANY($1::text[]) ORDER BY v.po_number, v.id',
    [poNumbers]
  );
  sheets.push({ name: 'Payment stages', rows: stages });

  sheets.push({
    name: 'Sales targets',
    rows: targetPlan.map(({ target, note }) => ({ 'What happens': note, ...target })),
  });

  const { rows: ownership } = await db.query(
    `SELECT * FROM ownership_history
      WHERE $1 IN (previous_owner_user_id, new_owner_user_id, changed_by_user_id,
                   previous_owner_snapshot_id, new_owner_snapshot_id, changed_by_snapshot_id)
      ORDER BY id`,
    [userId]
  );
  sheets.push({ name: 'Ownership history', rows: ownership });

  const { rows: followUps } = await db.query(
    'SELECT * FROM follow_up_cycles WHERE reminded_user_id = $1 ORDER BY id', [userId]);
  sheets.push({ name: 'Follow-ups', rows: followUps });

  const { rows: activity } = await db.query(
    `SELECT * FROM activity_log
      WHERE actor_user_id = $1 OR (entity_type = 'user' AND entity_id = $1::text)
      ORDER BY id DESC LIMIT ${MAX_ACTIVITY_ROWS}`,
    [userId]
  );
  sheets.push({ name: 'Activity', rows: activity });

  for (const s of sheets) counts[s.name] = s.rows.length;

  const moving = targetPlan.filter((p) => p.action === 'move').length;
  const summary = [
    ['Deleted user', user.name],
    ['Email', user.email ?? ''],
    ['Role', user.role],
    ['User id', user.id],
    ['Account created', user.created_at ? new Date(user.created_at) : ''],
    ['Backup made', new Date()],
    ['Deleted by', deletedBy],
    ['Open records move to', replacement ? `${replacement.name} (${replacement.email})` : 'Nobody — there were none'],
    ['Sales targets', `${targetPlan.length} (${moving} move, ${targetPlan.length - moving} stay with ${user.name})`],
    ['Business year', year],
    ...sheets.map((s) => [`Rows: ${s.name}`, s.rows.length]),
    ['Note', `The records stay in the tracker. Open ones move to the replacement; closed ones and past targets stay under ${user.name}, whose account is archived and can no longer sign in.`],
  ].map(([Field, Value]) => ({ Field, Value }));

  return { sheets: [{ name: 'Summary', rows: summary }, ...sheets], counts };
}

/** @returns {Buffer} */
export function buildWorkbook(sheets) {
  const book = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const clean = cleanRows(rows);
    const sheet = clean.length
      ? XLSX.utils.json_to_sheet(clean)
      : XLSX.utils.json_to_sheet([], { header: ['(no records)'] });
    XLSX.utils.book_append_sheet(book, sheet, name.slice(0, 31));
  }
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** The stored file is the one that was written: same bytes, every sheet, every row. */
export function verifyWorkbook(stored, { sha, sheets }) {
  if (sha256(stored) !== sha) throw new Error('the stored backup is not the file that was written');
  const book = XLSX.read(stored, { type: 'buffer' });
  for (const { name, rows } of sheets) {
    const sheet = book.Sheets[name.slice(0, 31)];
    if (!sheet) throw new Error(`the stored backup has no "${name}" sheet`);
    const found = XLSX.utils.sheet_to_json(sheet, { defval: null }).length;
    if (found !== rows.length) throw new Error(`the "${name}" sheet has ${found} rows, not ${rows.length}`);
  }
}

// ----------------------------------------------------------------- deletion

const fail = (status, message, extra) => new ApiError(status, message, extra);

/**
 * Back up, check, reassign and delete — or do none of it.
 *
 * @returns the deleted_users row and what was done.
 */
export async function deleteUserWithBackup({ userId, replacementUserId = null, moveTargets = false, actor }) {
  if (!backupStore.ready()) {
    throw fail(503, 'Document storage is not set up, so no backup can be kept. Nobody was deleted.');
  }

  const client = await pool.connect();
  let locked = false;
  let documentId = null;
  let stage = 'starting';
  try {
    const { rows: [lock] } = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [DELETION_LOCK_KEY, userId]);
    locked = lock.ok;
    if (!locked) throw fail(409, 'This user is already being deleted. Wait a moment and refresh.');

    const { rows: [user] } = await client.query(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.created_at FROM users u WHERE u.id = $1 AND ${NOT_DELETED}`, [userId]);
    if (!user) throw fail(404, 'User not found');

    // ----------------------------------------------------------- the plan
    stage = 'planning';
    const plan = await deletionPlan(userId, client);
    let replacement = null;
    if (replacementUserId !== null) {
      if (replacementUserId === userId) {
        throw fail(422, 'Please check the highlighted fields', { fields: { replacement_user_id: 'Choose somebody other than the person being deleted' } });
      }
      replacement = plan.candidates.find((c) => c.id === replacementUserId) ?? null;
      if (!replacement) {
        throw fail(422, 'Please check the highlighted fields', { fields: { replacement_user_id: 'Records can only move to an active Sales user' } });
      }
    }
    if (!plan.admin_remains) {
      throw fail(409, 'That would leave the tracker with no active admin. Add an Admin user (or make someone an Admin) first. Nobody was deleted.');
    }
    if (plan.needs_replacement && !replacement) {
      throw fail(422, 'Please check the highlighted fields', {
        fields: { replacement_user_id: `Choose who takes over their ${plan.open_owned} open record${plan.open_owned === 1 ? '' : 's'}` },
      });
    }

    const year = businessYear();
    const { rows: targets } = await client.query(
      'SELECT * FROM sales_targets WHERE salesperson_user_id = $1 ORDER BY calendar_year, metric, id', [userId]);
    const { rows: replacementTargets } = replacement
      ? await client.query('SELECT * FROM sales_targets WHERE salesperson_user_id = $1', [replacement.id])
      : { rows: [] };
    const targetPlan = planTargets(targets, replacementTargets, { user, replacement, moveTargets, year });

    // --------------------------------------------------------- the backup
    stage = 'backup';
    const before = await fingerprint(client, userId, replacement?.id);
    const { sheets, counts } = await collectSheets(client, { user, replacement, targetPlan, deletedBy: actor.name, year });
    const buffer = buildWorkbook(sheets);
    if (buffer.length > config.documentMaxBytes) {
      throw fail(413, `The backup is ${(buffer.length / 1048576).toFixed(1)} MB, more than storage accepts. Nobody was deleted.`);
    }
    const sha = sha256(buffer);
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'user';

    stage = 'upload';
    const stored = await backupStore.upload({
      buffer, fileName: `deleted-user-${user.id}-${slug}-${stamp}.xlsx`, contentType: XLSX_TYPE, owner: USER_BACKUP_FOLDER,
    });
    documentId = stored.id;

    stage = 'verify';
    const { body } = await backupStore.fetch(documentId);
    verifyWorkbook(body, { sha, sheets });

    // --------------------------------------------------- the one transaction
    stage = 'delete';
    await client.query('BEGIN');
    let result;
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_INVARIANT_LOCK_KEY]);
      const { rows: [still] } = await client.query(`SELECT u.id FROM users u WHERE u.id = $1 AND ${NOT_DELETED} FOR UPDATE`, [userId]);
      if (!still) throw fail(404, 'User not found');
      if ((await fingerprint(client, userId, replacement?.id)) !== before) {
        throw fail(409, 'Their records changed while the backup was being made. Nobody was deleted; try again.');
      }

      const reason = `${user.name} was deleted; their open records moved to ${replacement?.name}`;
      const moved = {};
      for (const type of RECORD_TYPES) {
        const { rows } = await client.query(
          `SELECT t.id FROM ${type} t JOIN ${VIEW[type]} v ON v.id = t.id
            WHERE t.owner_user_id = $1 AND ${OPEN[type]} ORDER BY t.id`,
          [userId]
        );
        for (const { id } of rows) {
          await changeRecordOwner(client, {
            entityType: type, entityIdOrKey: String(id), expectedOwnerId: userId,
            newOwnerId: replacement.id, reason, actor,
          });
        }
        moved[type] = rows.length;
      }

      for (const { target, action } of targetPlan) {
        if (action !== 'move') continue;
        await client.query(
          'UPDATE sales_targets SET salesperson_user_id = $1, updated_by_user_id = NULL WHERE id = $2',
          [replacement.id, target.id]);
        await logActivity(client, {
          actor, action: ACTIONS.TARGET_UPDATED, entityType: 'sales_targets', entityId: target.id,
          metadata: {
            moved_from_user_id: userId, moved_to_user_id: replacement.id,
            calendar_year: target.calendar_year, metric: target.metric, reason: `${user.name} was deleted`,
          },
        });
      }

      const { rowCount: tokensRevoked } = await client.query(
        `UPDATE api_tokens SET revoked_at = now() WHERE id IN (SELECT id ${LIVE_TOKENS})`, [user.name]);

      const summary = {
        rows: counts,
        records_moved: moved,
        targets_moved: targetPlan.filter((p) => p.action === 'move').length,
        targets_kept: targetPlan.filter((p) => p.action === 'keep').length,
        api_tokens_revoked: tokensRevoked,
        business_year: year,
      };
      const { rows: [record] } = await client.query(
        `INSERT INTO deleted_users (user_id, deleted_by, email, replacement_user_id, backup_document_id,
                                    backup_sha256, summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [user.id, actor.name, user.email, replacement?.id ?? null, documentId, sha, summary]
      );

      await logActivity(client, {
        actor, action: ACTIONS.USER_BACKUP_CREATED, entityType: 'user', entityId: user.id,
        metadata: { deleted_user_record_id: record.id, backup_document_id: documentId, sha256: sha, size_bytes: buffer.length, rows: counts },
      });

      // Archived: switched off with nothing left to sign in with, every
      // session it holds ended by the raised counter, and its email freed
      // for a new account (it is kept on the deleted_users row above).
      await client.query(
        `UPDATE users SET active = false, password_hash = NULL, email = NULL,
                          session_version = session_version + 1
          WHERE id = $1`, [userId]);
      await client.query('DELETE FROM auth_identities WHERE user_id = $1', [userId]);
      await refuseIfNoAdminLeft(client);

      await logActivity(client, {
        actor, action: ACTIONS.USER_DELETED, entityType: 'user', entityId: user.id,
        // The only record left of who this account was, beside deleted_users.
        metadata: {
          name: user.name, email: user.email, role: user.role, active: user.active,
          deleted_user_record_id: record.id, backup_document_id: documentId,
          replacement_user_id: replacement?.id ?? null, ...summary,
        },
      });

      await client.query('COMMIT');
      result = { record, summary };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    documentId = null; // attached now; nothing to clean up
    return result;
  } catch (err) {
    // The backup was stored but nothing was deleted: take it away again,
    // and say what happened where an admin will look.
    // Awaited, so the answer is given only once the file is gone.
    if (documentId !== null) await Promise.resolve(backupStore.discard(documentId)).catch(() => {});
    // A request turned away before any work (locked, not found, a missing
    // or wrong replacement) is an answer, not a failed deletion.
    const turnedAway = err instanceof ApiError
      && (err.status === 422 || (['starting', 'planning'].includes(stage) && [404, 409].includes(err.status)));
    if (!turnedAway) {
      await logActivity(pool, {
        actor, action: ACTIONS.USER_DELETION_FAILED, entityType: 'user', entityId: userId,
        metadata: { stage, error: String(err.message).slice(0, 500) },
      }).catch(() => {});
    }
    if (err instanceof ApiError) throw err;
    const lastAdmin = /no active admin/.test(err.message);
    throw fail(lastAdmin ? 409 : 502, lastAdmin ? err.message : `The deletion stopped at the ${stage} step and nothing was deleted: ${err.message}`);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1, $2)', [DELETION_LOCK_KEY, userId]).catch(() => {});
    client.release();
  }
}

// ------------------------------------------------------------------ reading

export async function listDeletedUsers(db = pool) {
  const { rows } = await db.query(
    `SELECT du.id, du.user_id, u.name, du.email, u.role, u.created_at AS account_created_at,
            du.deleted_at, du.deleted_by, du.replacement_user_id, r.name AS replacement_name,
            d.size_bytes AS backup_size_bytes, du.summary, d.file_name AS backup_file_name
       FROM deleted_users du
       JOIN users u ON u.id = du.user_id
       JOIN documents d ON d.id = du.backup_document_id
       LEFT JOIN users r ON r.id = du.replacement_user_id
      ORDER BY du.deleted_at DESC, du.id DESC`
  );
  return rows;
}

/** The backup's bytes, checked against the fingerprint taken when it was made. */
export async function readBackup(id, db = pool) {
  const { rows: [row] } = await db.query(
    `SELECT du.*, d.file_name FROM deleted_users du JOIN documents d ON d.id = du.backup_document_id WHERE du.id = $1`, [id]);
  if (!row) return null;
  const { body } = await backupStore.fetch(row.backup_document_id);
  if (sha256(body) !== row.backup_sha256) {
    throw fail(502, 'The stored backup does not match the one that was made. It has not been sent.');
  }
  return { row, body, contentType: XLSX_TYPE };
}
