import { Router } from 'express';
import { requireAdmin, requireRole } from '../auth/middleware.js';
import {
  OWNER_COLUMN, isUnrestricted, ownerForNewRecord, parentClause, recordReachableSql,
  resourceClause, scopeOf,
} from '../auth/ownership.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { claimAttachment, purgeAfterCommit } from './documents.js';
import { nameKey, normalizeName } from './names.ts';
import { actAs, logCrudCreate, logCrudUpdate } from './recordActs.js';
import { reportPeriod } from './salesReport.js';
import { claimNextId, sequenceColumn } from './sequences.js';

const MAX_LIMIT = 1000;

/** Identifiers are only ever taken from a resource definition, never a client. */
const ident = (name) => `"${String(name).replace(/"/g, '')}"`;

/**
 * Build the WHERE clause for a list request from the resource's declared
 * search and filter columns. Anything the client asks for that is not in
 * those lists is ignored rather than interpolated.
 */
export function buildWhere(def, reqQuery, params, extra = []) {
  // Clauses the caller has already built and parameterised — the ownership
  // predicate. First in the list so a scoped read reads as scoped.
  const clauses = [...extra];

  const search = (reqQuery.q || '').trim();
  if (search && def.search?.length) {
    params.push(`%${search}%`);
    const idx = params.length;
    clauses.push(
      `(${def.search.map((c) => `${ident(c)}::text ILIKE $${idx}`).join(' OR ')})`
    );
  }

  for (const col of def.filters || []) {
    const raw = reqQuery[col];
    if (raw === undefined || raw === '') continue;
    // Old names for a value (e.g. enquiry statuses renamed by #24) still
    // filter, the same way the schema accepts them on a write.
    const aliases = def.filterAliases?.[col] || {};
    const values = String(raw).split(',').map((v) => v.trim()).filter(Boolean).map((v) => aliases[v] ?? v);
    if (!values.length) continue;
    // Free-text names match the way the sales reports group them: case and
    // extra spaces ignored, and a blank value counts as not set.
    const normalized = def.normalizedFilters?.includes(col);
    if (values.length === 1 && values[0] === '__none__') {
      clauses.push(normalized ? `NULLIF(btrim(${ident(col)}), '') IS NULL` : `${ident(col)} IS NULL`);
      continue;
    }
    // The other half of __none__: any value at all. The data-quality page
    // needs it to say "invoiced" (?invoice_no=__any__) without a status list.
    if (values.length === 1 && values[0] === '__any__') {
      clauses.push(normalized ? `NULLIF(btrim(${ident(col)}), '') IS NOT NULL` : `${ident(col)} IS NOT NULL`);
      continue;
    }
    if (normalized) {
      params.push(values.map(normalizeName));
      clauses.push(`${nameKey(ident(col))} = ANY($${params.length})`);
    } else {
      params.push(values);
      clauses.push(`${ident(col)}::text = ANY($${params.length})`);
    }
  }

  // ?from=&to= on the resource's date column, so a list opened from a
  // report covers the same period as the figure it came from.
  if (def.dateFilter && (reqQuery.from || reqQuery.to)) {
    const { from, to } = reportPeriod(reqQuery);
    if (from) {
      params.push(from);
      clauses.push(`${ident(def.dateFilter)} >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      clauses.push(`${ident(def.dateFilter)} <= $${params.length}::date`);
    }
  }

  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * The whole WHERE for a list read: the ownership predicate, the filters a
 * resource works out itself (`listClauses`: the quotations "follow-up
 * overdue" filter, which runs the follow-up rules, or the records behind a
 * Reports chart, which runs the report's), then the column filters.
 *
 * The list, its CSV/Excel export and a saved view's count all come through
 * here, so the rows downloaded or counted are the rows the page shows.
 */
export async function listWhere(def, reqQuery, params, scope, alias) {
  const scoped = resourceClause(def, scope, params, { alias });
  const computed = def.listClauses ? await def.listClauses(reqQuery, { scope, params }) : [];
  return buildWhere(def, reqQuery, params, [...(scoped ? [scoped] : []), ...computed]);
}

function buildOrder(def, sortParam) {
  if (!sortParam) return `ORDER BY ${def.defaultSort}`;
  const [rawCol, rawDir] = String(sortParam).split(':');
  const allowed = new Set([...(def.columns || []), ...(def.search || []), ...(def.filters || []), 'id']);
  if (!allowed.has(rawCol)) return `ORDER BY ${def.defaultSort}`;
  const dir = String(rawDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return `ORDER BY ${ident(rawCol)} ${dir} NULLS LAST`;
}

/**
 * Refuse a generic write that touches a field the workflow owns (#85).
 *
 * Some columns are not the form's to set. An expense claim's approval and
 * its reimbursement, a vendor invoice's payment: each has a route of its
 * own that checks who is asking, checks the record is in a state where the
 * change makes sense, and writes an audit row in the same transaction.
 * Reaching the same column through POST or PATCH on the resource would do
 * none of that, and the column would be none the wiser.
 *
 * Refused rather than quietly dropped. A silent drop returns 200 with the
 * field unchanged, which reads to the caller exactly like success — and to
 * anyone probing, exactly like a field that does not exist. It also hides
 * the honest case: a form still sending a field it should no longer send is
 * a bug worth seeing. The message names the route to use instead.
 *
 * The rule does not ask who is asking. An administrator writing these
 * columns through the ordinary form skips the same checks and leaves the
 * same blank in the audit trail; being allowed to make the change is not
 * the same as being allowed to make it invisibly.
 *
 * Called from validate(), which is the one place every generic write passes
 * through: POST and PATCH on the resource, and the MCP record import, which
 * reaches insertRecord/updateRecordRow without going near a route. Guarding
 * the two route handlers instead left that third door open — the MCP import
 * arrived after #85 was written and writes the same columns through the same
 * functions. insertRecord and updateRecordRow are not the choke point either:
 * PATCH builds its own UPDATE and never calls updateRecordRow.
 *
 * It must see the **request body**, not the parsed record. zod applies
 * .default() inside .partial() as well as on a create, so approval_status and
 * amount_reimbursed are present on parsed.data whether or not anybody sent
 * them — checking that object would refuse every legitimate write. The test
 * is "was this field in what the caller sent", which is Object.hasOwn on the
 * raw body, and `{"approval_status": null}` is an attempt like any other.
 */
function assertWorkflowFields(def, body) {
  if (!def.protectedFields?.length || !body || typeof body !== 'object') return;
  const attempted = def.protectedFields.filter((col) => Object.hasOwn(body, col));
  if (!attempted.length) return;
  throw new ApiError(
    403,
    `${def.label}: ${attempted.join(', ')} ${attempted.length > 1 ? 'are' : 'is'} set by its own action, not by this form.`,
    { fields: Object.fromEntries(attempted.map((col) => [col, 'Use the action for this, not the form'])) }
  );
}

/** Reject unknown keys early so typos surface instead of silently vanishing. */
/**
 * The by-id predicate, narrowed to what this request may reach.
 *
 * Every path that addresses one row goes through here — detail, patch, its
 * reference-number guard, its FOR UPDATE read, and both delete paths — so a
 * sales user asking for somebody else's record gets the same "not found"
 * from all of them, and the UPDATE and DELETE carry the restriction
 * themselves rather than trusting a SELECT that happened earlier.
 *
 * That last part is the point: checking ownership in one statement and
 * writing in the next is a window, however small, in which the row can
 * change hands. There is no window if the write cannot match the row.
 */
function scopedIdPredicate(def, rawId, params, scope, relation) {
  const pred = idPredicate(def, rawId, params);
  // Qualified with the relation the statement actually reads or writes: a
  // detail read comes from the view, an UPDATE goes to the table, and a
  // parent-derived predicate names columns on whichever one it is.
  const mine = resourceClause(def, scope, params, { alias: relation });
  return mine ? `${pred} AND ${mine}` : pred;
}

/**
 * Refuse a new row whose parent this request cannot reach.
 *
 * Only for the resources that take their ownership from above — a purchase
 * order, a payment stage, a PO service line. Without this a sales user could
 * add a stage to somebody else's purchase order, or a purchase order to a
 * project that is not theirs, and the row would be invisible to them the
 * moment it existed. 404, like every other ownership refusal, so the attempt
 * does not confirm the parent exists.
 */

// The columns each parent-derived kind reads off the row being written, with
// the type the one-row relation below has to hand them so the predicate sees
// the same shape it would on the real table.
const PARENT_KEYS = {
  purchase_order: [['quotation_no', 'text'], ['project_id', 'text']],
  via_po: [['po_number', 'text']],
  via_stage: [['stage_id', 'int']],
  quotation: [['quotation_id', 'int']],
  project: [['project_id', 'text']],
  entity: [['entity', 'text'], ['entity_id', 'text']],
  // A task is written with one primary parent; the rest of its records
  // arrive as `targets` and are checked one by one below.
  task_entity: [['entity', 'text'], ['entity_id', 'text']],
};

async function assertParentReachable(client, def, values, scope, input = null) {
  const kind = def.ownerScopedBy;
  if (!kind || scope.unrestricted) return;

  // A task may be put on several records at once (#22). Each is a record
  // this caller has to be able to reach, or a task could be filed onto
  // somebody else's deal by listing it as a secondary target.
  for (const t of (kind === 'task_entity' && Array.isArray(input?.targets)) ? input.targets : []) {
    const probe = recordReachableSql(scope, t.entity, t.entity_id);
    if (!probe) continue;
    const { rowCount } = await client.query(probe.sql, probe.params);
    if (!rowCount) throw new ApiError(404, `${def.label} not found`);
  }
  const keys = PARENT_KEYS[kind];
  // A kind with no key list here would otherwise be checked against the
  // wrong column, which reads as "reachable" — the one failure this whole
  // function exists to prevent. Louder is safer.
  if (!keys) throw new Error(`Unknown ownership parent: ${kind}`);

  const params = keys.map(([col]) => values[col] ?? null);
  const columns = keys.map(([col, type], i) => `$${i + 1}::${type} AS ${col}`).join(', ');
  // The one-row relation has the parent keys and nothing else, so the task
  // variant — which reaches into task_targets by the row's own id — cannot
  // be asked here. Its extra records are the `targets` checked above; the
  // primary parent is an ordinary entity pair.
  const where = parentClause(scope, params, { kind: kind === 'task_entity' ? 'entity' : kind, alias: 'parent' });
  const { rowCount } = await client.query(
    `SELECT 1 FROM (SELECT ${columns}) parent WHERE ${where}`,
    params
  );
  if (!rowCount) throw new ApiError(404, `${def.label} not found`);
}

/**
 * The same check for an update that moves a row from one parent to another.
 *
 * Reads only the parent keys, and reads them through the scoped predicate,
 * so a row the caller cannot reach is "not found" here exactly as it is
 * everywhere else. Locked, so the row cannot be moved out from under the
 * check by a concurrent save — for the resources that run in a transaction;
 * for the others the UPDATE's own predicate is still the thing that decides.
 */
async function assertDestinationReachable(client, def, id, values, scope, input = null) {
  const kind = def.ownerScopedBy;
  if (!kind || scope.unrestricted) return;
  const keys = PARENT_KEYS[kind];
  if (!keys) throw new Error(`Unknown ownership parent: ${kind}`);
  const movesTargets = def.ownerScopedBy === 'task_entity' && Array.isArray(input?.targets);
  if (!movesTargets && !keys.some(([col]) => Object.hasOwn(values, col))) return;

  const params = [];
  const pred = scopedIdPredicate(def, id, params, scope, def.table);
  const { rows: [current] } = await client.query(
    `SELECT ${keys.map(([col]) => ident(col)).join(', ')} FROM ${ident(def.table)}
      WHERE ${pred} FOR UPDATE`,
    params
  );
  if (!current) throw new ApiError(404, `${def.label} not found`);
  await assertParentReachable(client, def, { ...current, ...values }, scope, input);
}

function pickWritable(def, body) {
  const out = {};
  for (const col of def.columns) {
    if (Object.prototype.hasOwnProperty.call(body, col)) out[col] = body[col];
  }
  return out;
}

function validate(def, body, { partial }) {
  assertWorkflowFields(def, body);
  const schema = partial ? def.schema.partial() : def.schema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  // values: only the resource's own columns, for the INSERT/UPDATE.
  // input:  everything the schema accepted, including fields that belong to a
  //         related table — a project's won quotation lives on quotations, so
  //         onSave needs it even though projects has no such column.
  const values = pickWritable(def, parsed.data);
  if (!partial) return { values, input: parsed.data };
  // An update writes only what it was sent. zod 4 applies .default() inside
  // .partial() too, so without this an edit to a PO's remarks resets its value to 0.
  const sent = Object.fromEntries(Object.entries(values).filter(([col]) => Object.hasOwn(body, col)));
  return { values: sent, input: parsed.data };
}

/**
 * Where a resource has a human key (PRJ-2026-001) accept it in the URL too.
 *
 * A human key can itself be all digits — clients issue PO numbers like
 * 4530056073 — so digits alone do not mean "internal id". The human key
 * wins whenever a row carries it; the numeric id is only tried when it
 * fits Postgres' integer type and no row has that human key.
 */
const MAX_INT = 2147483647;

export function idPredicate(def, id, params) {
  const key = decodeURIComponent(id);
  const numeric = /^\d+$/.test(key) && Number(key) <= MAX_INT;

  if (!def.naturalKey) {
    if (!numeric) throw new ApiError(400, 'Invalid id');
    params.push(Number(key));
    return `id = $${params.length}`;
  }
  params.push(key);
  const byKey = `${ident(def.naturalKey)} = $${params.length}`;
  if (!numeric) return byKey;

  params.push(Number(key));
  return `(${byKey} OR (id = $${params.length} AND NOT EXISTS (
            SELECT 1 FROM ${ident(def.table)} WHERE ${byKey})))`;
}

/**
 * Quotations, POs and payment stages may carry one document. A blank value never clears one
 * already attached. A new one must be an upload no record uses, and it stays
 * locked until the save commits, so two saves cannot both attach it and a
 * purge cannot remove it underneath the record. Returns the document being
 * replaced, if any, so it can be removed once the record is committed.
 */
async function claimDocument(client, def, values, id, scope) {
  // Keeping the current document means not writing the column at all, so an
  // update that never mentions it cannot blank it.
  if (values.document_id === null || values.document_id === undefined) {
    delete values.document_id;
    return null;
  }

  let current = null;
  if (id !== undefined) {
    const params = [];
    // Scoped like every other read of one row. Unscoped, this read ran
    // before the UPDATE that carries the predicate and answered "found" or
    // "not found" about a record the caller may not reach — and the file it
    // named would be released for replacement on the way past.
    const pred = scope
      ? scopedIdPredicate(def, id, params, scope, def.table)
      : idPredicate(def, id, params);
    const { rows } = await client.query(
      `SELECT document_id FROM ${ident(def.table)} WHERE ${pred} FOR UPDATE`,
      params
    );
    if (!rows.length) throw new ApiError(404, `${def.label} not found`);
    current = rows[0].document_id;
  }

  const { replaced } = await claimAttachment(client, { current, requested: values.document_id });
  return replaced;
}

/**
 * Note for anyone diffing against main: `assertVisible` and the
 * `def.visibleTo` hook it read are deliberately absent. They were main's
 * second answer to "whose record is this?", keyed on the free-text
 * sales_person. Ownership is owner_user_id and only owner_user_id, applied
 * through resourceClause / scopedIdPredicate below.
 */

/**
 * Write one new row of a resource: its auto-id, its document claim, its
 * INSERT and its onSave hook, in that order, on the client it is given.
 *
 * Lifted out of the POST route so bulk import over MCP writes records the
 * same way a form does (#138). Two writers of one table must share the code
 * that writes it, or the day somebody adds a hook only one of them runs it.
 * Takes a client rather than opening its own transaction, so a caller
 * writing many rows can put them all in one.
 */
export async function insertRecord(client, def, { values, input, scope }) {
  if (def.hasDocument) await claimDocument(client, def, values);

  if (def.autoId) {
    const col = sequenceColumn(def.autoId);
    if (values[col] == null) {
      // Reference field is blank — auto-generate using the record's own date for the year.
      // This ensures a quotation dated 2025-11-15 gets a CTZ/QT/2025/... number even when
      // today is 2026.
      const rawDate = def.autoIdDateField ? values[def.autoIdDateField] : null;
      const year = (typeof rawDate === 'string' && rawDate.length >= 4)
        ? rawDate.slice(0, 4)
        : undefined; // undefined → claimNextId falls back to current business year
      values[col] = await claimNextId(def.autoId, client, year);
    }
    // else: user supplied an explicit reference number — preserve it exactly.
    // The DB UNIQUE constraint returns HTTP 409 on a duplicate (already handled in error.js).
  }
  const cols = Object.keys(values);
  if (!cols.length) throw new ApiError(422, 'Nothing to save');

  const { rows } = await client.query(
    `INSERT INTO ${ident(def.table)} (${cols.map(ident).join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING *`,
    cols.map((c) => values[c])
  );
  // `scope` reaches onSave because a hook may itself read another table —
  // linkProjectQuotation only links a quotation the caller can reach. The
  // staff route passes it; MCP's bulk import does not, which leaves that
  // hook exactly as unrestricted as it is on main.
  const extra = await def.onSave?.(client, { before: null, after: rows[0], input, scope });
  return { row: rows[0], extra };
}

/** The same for an existing row, by id or natural key. Returns null if gone. */
export async function updateRecordRow(client, def, id, { values, input }) {
  const cols = Object.keys(values);
  let before = null;
  if (def.onSave) {
    const keyParams = [];
    const keyPred = idPredicate(def, String(id), keyParams);
    ({ rows: [before] } = await client.query(
      `SELECT * FROM ${ident(def.table)} WHERE ${keyPred} FOR UPDATE`, keyParams));
  }
  let rows;
  if (cols.length) {
    const params = cols.map((c) => values[c]);
    const pred = idPredicate(def, String(id), params);
    const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
    ({ rows } = await client.query(
      `UPDATE ${ident(def.table)} SET ${sets} WHERE ${pred} RETURNING *`, params));
  } else {
    rows = before ? [before] : [];
  }
  if (!rows.length) return null;
  const extra = await def.onSave?.(client, { before, after: rows[0], input });
  return { row: rows[0], extra };
}

/** One row against the resource's own schema — the form's rules, exactly. */
export const validateRecord = (def, body, opts = { partial: false }) => validate(def, body, opts);

export function crudRouter(name, def) {
  const router = Router();
  const readFrom = def.view || def.table;

  // A resource may declare that only an admin changes it — the reference
  // lists behind the forms, where one edit re-labels every record that used
  // the old value. Reading is left open, because the same lists fill the
  // dropdowns everybody works in. Resources without the flag are unchanged.
  // hrWrites opens an admin-curated list to the HR role too: the travel
  // agencies and trip types are the travel desk's to keep (#196).
  const adminGate = def.hrWrites ? requireRole('admin', 'hr') : requireAdmin;
  const mayWrite = def.adminOnlyWrites ? [adminGate] : [];

  // And a resource may declare the narrower thing: anybody may add to it and
  // correct it, but only an admin may destroy a row.
  //
  // That split exists because creating and deleting are not the same risk on
  // shared and financial data. A sales user enters purchase orders and their
  // payment stages as ordinary work, and companies and contacts appear on
  // their own — the link trigger creates one the moment a quotation names a
  // client nobody has typed before. Requiring an admin for any of that would
  // stop the job. Deleting is the other direction: a company or contact is
  // referenced by every record that ever named it, and a PO, its services and
  // its stages are what the invoicing and Due-now figures are computed from.
  // Those rows are not the deleter's alone to remove.
  //
  // Until Phase 2 gives records an owner, "whose record is this?" has no
  // answer, so the conservative one is used for deletes on shared and
  // financial data and the permissive one everywhere else. adminOnlyWrites
  // implies this — a resource only an admin may write is one only an admin
  // may delete.
  const mayDelete = def.adminOnlyWrites ? [adminGate] : def.adminOnlyDeletes ? [requireAdmin] : [];

  // A save with follow-on work runs in one transaction: whatever an
  // onSave(client, { before, after, input }) hook writes, a document attached under
  // lock, and a reference number taken from its series commit together with
  // the record or not at all.
  //
  // A resource that declares `audit` writes who did it (recordActs.js) in the
  // same transaction, and every transaction tells the database who is acting,
  // for the triggers that stamp a completed task and a stage move.
  const write = (req, fn) => (def.onSave || def.hasDocument || def.autoId || def.audit
    ? transaction(async (client) => { await actAs(client, req.user); return fn(client); })
    : fn({ query }));

  router.get('/', async (req, res) => {
    const params = [];
    // Built before the rest of the WHERE so it lands in the same statement:
    // the count has to be the count of what this user may see, or a sales
    // user's pagination would advertise how many records they cannot open.
    //
    // main reached the same need through a per-resource `visibleTo` hook
    // keyed on the free-text sales_person; ownership is owner_user_id and
    // only owner_user_id, so the predicate comes from the resource's
    // declared ownership instead. One engine, one truth.
    const where = await listWhere(def, req.query, params, scopeOf(req), readFrom);
    const order = buildOrder(def, req.query.sort);
    const limit = Math.min(Number(req.query.limit) || 500, MAX_LIMIT);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const [rows, count] = await Promise.all([
      query(
        `SELECT * FROM ${ident(readFrom)} ${where} ${order} LIMIT ${limit} OFFSET ${offset}`,
        params
      ),
      query(`SELECT COUNT(*)::int AS total FROM ${ident(readFrom)} ${where}`, params),
    ]);

    res.json({ data: rows.rows, total: count.rows[0].total, limit, offset });
  });

  router.get('/:id', async (req, res) => {
    const params = [];
    const pred = scopedIdPredicate(def, req.params.id, params, scopeOf(req), readFrom);
    const { rows } = await query(`SELECT * FROM ${ident(readFrom)} WHERE ${pred}`, params);
    // 404 rather than 403, deliberately: a sales user asking after a record
    // that is not theirs learns nothing about whether it exists.
    if (!rows.length) throw new ApiError(404, `${def.label} not found`);
    res.json({ data: rows[0] });
  });

  router.post('/', ...mayWrite, async (req, res) => {
    const { values, input } = validate(def, req.body, { partial: false });
    // Who wrote it, taken from the session rather than the request body: a
    // note or a file with nobody's name on it is the timeline saying an
    // anonymous someone did this, which #22 asks it not to do. Only filled
    // when the caller left it blank, so an import can still carry its own.
    //
    // Only an admin may set it to someone else (an import carrying its own
    // author); for everybody else the session decides, whatever was sent.
    if (def.stampActor && (!values[def.stampActor] || !isUnrestricted(req.user))) {
      const actor = req.user?.name || req.user?.username;
      if (actor) values[def.stampActor] = actor;
    }
    await def.authorize?.(req, input);

    // A sales user owns what they enter. Taken from the session, never from
    // the body — owner_user_id is in no resource's writable columns, so a
    // client cannot propose one, and this is the only thing that writes it.
    // An admin or the shared login creates an unowned record: guessing which
    // salesperson they meant is the mistake Phase 2B refused to make.
    if (def.ownerScoped) {
      const owner = ownerForNewRecord(req.user);
      if (owner !== null) {
        values[OWNER_COLUMN] = owner;
        values.originating_user_id = req.user.id;
        values.originating_user_snapshot_id = req.user.id;
        values.originating_user_name = req.user.name ?? null;
      }
    }

    const { id, extra } = await write(req, async (client) => {
      // A row that inherits its ownership may only be filed under a parent
      // this request can reach. It stays here, in front of the shared
      // writer, rather than inside it: the check is about who is asking,
      // and insertRecord is also called by MCP, which has no such caller.
      await assertParentReachable(client, def, values, scopeOf(req), input);
      const written = await insertRecord(client, def, { values, input, scope: scopeOf(req) });
      await logCrudCreate(client, req.user, def, written.row);
      return { id: written.row.id, extra: written.extra };
    });

    const { rows: full } = await query(
      `SELECT * FROM ${ident(readFrom)} WHERE id = $1`,
      [id]
    );
    // A hook may report what it did, e.g. the quotation a won enquiry created.
    res.status(201).json({ data: { ...full[0], ...extra } });
  });

  router.patch('/:id', ...mayWrite, async (req, res) => {
    const { values, input } = validate(def, req.body, { partial: true });
    if (def.stampActor && !isUnrestricted(req.user)) delete values[def.stampActor];
    await def.authorize?.(req, input);

    // Reference-number guard: the field is immutable after creation.
    // Rules:
    //   - field absent from payload     → nothing to do (normal update proceeds)
    //   - field present, same as stored → no-op, drop it silently
    //   - field present, ANY other value (null, blank→null, different string) → 422
    if (def.autoId) {
      const col = sequenceColumn(def.autoId);
      if (Object.prototype.hasOwnProperty.call(values, col)) {
        // Client sent the reference column — fetch the current stored value.
        // This runs before the transaction so a plain query() is always correct here.
        const keyParams = [];
        const keyPred = scopedIdPredicate(def, req.params.id, keyParams, scopeOf(req), def.table);
        const { rows: existing } = await query(
          `SELECT ${ident(col)} FROM ${ident(def.table)} WHERE ${keyPred}`,
          keyParams
        );
        const currentValue = existing[0]?.[col] ?? null;
        if (values[col] !== currentValue) {
          throw new ApiError(422, 'Please check the highlighted fields', {
            fields: { [col]: 'This reference number is assigned on create and cannot be changed' },
          });
        }
        // Same value echoed back — harmless no-op, drop it from the payload.
        delete values[col];
      }
    }

    const { id, extra, replacedDocument } = await write(req, async (client) => {
      // Re-pointing a row at another parent is a write into that parent's
      // record — a task moved onto somebody else's quotation appears on
      // their timeline. The UPDATE below carries the predicate for where the
      // row is now; this is the other half, for where it is going. Only the
      // keys actually sent are taken from the payload, so a partial move
      // (entity_id without entity) is judged against the row as it will be,
      // not against half of it.
      await assertDestinationReachable(client, def, req.params.id, values, scopeOf(req), input);

      const replacedDocument = def.hasDocument ? await claimDocument(client, def, values, req.params.id, scopeOf(req)) : null;
      const cols = Object.keys(values);
      // A resource may accept a field that lives on a related table (a
      // project's won quotation), so a save with no column of its own is still
      // work — but only if something was actually sent. An empty body is not.
      //
      // With no columns to write, onSave gets the unchanged row as BOTH before
      // and after: a hook comparing the two correctly sees no change, but it
      // must not assume they are distinct objects.
      const linksOnly = def.onSave && Object.keys(input).length > 0;
      if (!cols.length && !linksOnly) throw new ApiError(422, 'Nothing to update');

      let before = null;
      if (def.onSave || def.audit) {
        const keyParams = [];
        const keyPred = scopedIdPredicate(def, req.params.id, keyParams, scopeOf(req), def.table);
        ({ rows: [before] } = await client.query(
          `SELECT * FROM ${ident(def.table)} WHERE ${keyPred} FOR UPDATE`,
          keyParams
        ));
      }

      // Nothing of this resource's own to write — only a related table, such
      // as the quotation a project registers. `UPDATE ... SET WHERE` is not
      // valid SQL, so use the row onSave already locked above.
      let rows;
      if (cols.length) {
        const params = cols.map((c) => values[c]);
        const pred = scopedIdPredicate(def, req.params.id, params, scopeOf(req), def.table);
        const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`).join(', ');
        ({ rows } = await client.query(
          `UPDATE ${ident(def.table)} SET ${sets} WHERE ${pred} RETURNING *`,
          params
        ));
      } else {
        rows = before ? [before] : [];
      }
      if (!rows.length) throw new ApiError(404, `${def.label} not found`);
      const extra = await def.onSave?.(client, { before, after: rows[0], input, scope: scopeOf(req) });
      await logCrudUpdate(client, req.user, def, before, rows[0], cols);
      return { id: rows[0].id, extra, replacedDocument };
    });

    // The replaced file leaves storage only once the new one is committed.
    if (replacedDocument) await purgeAfterCommit(replacedDocument);

    const { rows: full } = await query(
      `SELECT * FROM ${ident(readFrom)} WHERE id = $1`,
      [id]
    );
    res.json({ data: { ...full[0], ...extra } });
  });

  router.delete('/:id', ...mayDelete, async (req, res) => {
    const remove = async (client) => {
      const params = [];
      const pred = scopedIdPredicate(def, req.params.id, params, scopeOf(req), def.table);
      const { rows: [target] } = await client.query(
        `SELECT * FROM ${ident(def.table)} WHERE ${pred} FOR UPDATE`,
        params
      );
      if (!target) throw new ApiError(404, `${def.label} not found`);

      // Rows the delete cascades to (a PO's payment stages) may carry documents of their own.
      const cascaded = def.cascadeDocuments
        ? (await client.query(def.cascadeDocuments.sql, [target[def.cascadeDocuments.key]])).rows.map((row) => row.document_id)
        : [];
      await client.query(`DELETE FROM ${ident(def.table)} WHERE id = $1`, [target.id]);
      return [def.hasDocument ? target.document_id : null, ...cascaded].filter(Boolean);
    };
    let documents = [];
    if (def.hasDocument || def.cascadeDocuments) {
      documents = await transaction(remove);
    } else {
      const params = [];
      const pred = scopedIdPredicate(def, req.params.id, params, scopeOf(req), def.table);
      const { rows } = await query(
        `DELETE FROM ${ident(def.table)} WHERE ${pred} RETURNING id`,
        params
      );
      if (!rows.length) throw new ApiError(404, `${def.label} not found`);
    }

    // Files leave Cloudinary only once the delete is committed.
    for (const documentId of documents) await purgeAfterCommit(documentId);
    res.status(204).end();
  });

  return router;
}
