/**
 * Bulk import over MCP (#135): plan a sales sheet from a conversation,
 * look at what it would do, change your mind, then commit it.
 *
 * It is the same pipeline the upload screen uses — import/batches.js plans,
 * import/commit.js writes — so the duplicate matching, the three-way merge
 * and every assumption are the ones already argued over in rules.js. What
 * is new here is only the way in: rows arrive as JSON instead of as a file,
 * and the review happens in sentences instead of on a screen.
 *
 * Two properties this leans on, both from the existing pipeline:
 *
 *   planning writes nothing to the tracker. A plan lives in import_batches
 *   and import_items, and until somebody commits it, no quotation, project,
 *   PO, stage or invoice has moved. So a model may plan freely.
 *
 *   committing is the one irreversible step, and it is its own tool, with
 *   its own confirmation, that no planning call can perform.
 */
import { query } from '../../db.js';
import { ApiError } from '../../middleware/error.js';
import { loadBatch, planBatch, recallFile, rememberFile, fileCache } from '../../import/batches.js';
import { commitBatch } from '../../import/commit.js';
import { DEFAULT_RULES, rulesSchema } from '../../import/rules.js';

/**
 * How many rows one conversation may send.
 *
 * The upload path allows 3,000, bounded by how long a request may run. This
 * is bounded by something smaller: the rows arrive inside a tool call and
 * the plan goes back inside a tool result, so both ends are somebody's
 * context window. Five hundred rows of a sales sheet is already a large
 * message; beyond that the sheet wants the upload screen, which is also
 * where the review is easier to read.
 */
export const MCP_MAX_ROWS = 500;

/** Only whole batches this server planned; it never touches an upload. */
const MCP_FILENAME = /^mcp:/;

const isAdmin = (scope) => scope.role === 'admin';

/**
 * Importing is an admin's job on the upload screen (`requireAdmin`), and
 * changing the way in does not change whose job it is. A sales token could
 * otherwise create quotations, projects and POs across the whole company
 * from a chat window — every record the rest of this server carefully
 * scopes away from it.
 */
function assertMayImport(scope) {
  if (!isAdmin(scope)) throw new ApiError(403, 'Only an admin token may import. Ask for an admin token, or use the Import screen.');
}

/** A batch this server planned, drafts only, or a sentence saying why not. */
async function ownDraft(batchId) {
  const { rows } = await query("SELECT id, filename, status FROM import_batches WHERE id = $1 AND kind = 'sales'", [batchId]);
  if (!rows.length) throw new ApiError(404, `Import batch ${batchId} was not found.`);
  const b = rows[0];
  // An upload's review screen is where its own reviewer is working. Two
  // people changing one plan from two places is how a row gets committed
  // that neither of them chose.
  if (!MCP_FILENAME.test(b.filename || '')) throw new ApiError(409, `Import batch ${batchId} came from the Import screen. Review and commit it there.`);
  if (b.status === 'committed') throw new ApiError(409, `Import batch ${batchId} is already committed. Plan a new one to import more.`);
  return b;
}

// ------------------------------------------------------------------ input

const CELL = /[",\n\r]/;
const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return CELL.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Rows as JSON into the bytes the reader expects.
 *
 * Going in through CSV rather than handing the planner objects directly is
 * deliberate. A real sheet arrives as text — "7,96,500/-", "12.03.2026",
 * "Closed Won (100%)" — and every rule in parse.js is written to read that
 * text. Feeding this path the same shape means a row sent from a chat is
 * read by exactly the code that reads it from a file, including the
 * header cleaning and the dropping of credential columns. A JSON row that
 * arrived with a real number or a Date would otherwise take a different
 * road through the parser and could land differently.
 */
export function rowsToCsv(rows) {
  const headers = [];
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) { seen.add(key); headers.push(key); }
    }
  }
  if (!headers.length) throw new ApiError(422, 'Every row was empty. Send rows as objects whose keys are the sheet\'s column headings.');
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => cell(row[h])).join(','));
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

// ------------------------------------------------------------------ plan

/** An item worth a sentence: it failed, or it is about to change something. */
const notable = (it) => it.flags.some((f) => f.level === 'error' || f.level === 'warn');

const say = (it) => ({
  seq: it.seq,
  step: it.step,
  row: it.source_row,
  client: it.source_client,
  action: it.action,
  included: it.included && it.parent_included,
  existing: it.existing_ref,
  // The flag text is the whole point: these sentences are what the review
  // screen shows a person, already written for somebody to act on.
  says: it.flags.map((f) => `${f.level}: ${f.message}`),
  assumptions: it.assumptions,
});

/**
 * What a plan says, small enough to read.
 *
 * A 47-row sheet plans about 150 items, and returning all of them is most
 * of a context window spent on rows that are going in cleanly and need no
 * decision. So: the counts in full, and then only the items somebody has to
 * look at. The rest are there through get_import_plan when wanted.
 */
const NOTABLE_SHOWN = 25;

/** How many of the committed records to name back. See commitSheetImport. */
const WRITTEN_SHOWN = 25;

function digest(batch) {
  const items = batch.items;
  const flagged = items.filter(notable);
  return {
    batch_id: batch.id,
    status: batch.status,
    sheet: batch.sheet_name,
    rows_read: batch.row_count,
    steps: batch.summary?.steps || {},
    duplicates: batch.summary?.duplicates ?? 0,
    assumptions: batch.summary?.assumptions ?? 0,
    left_out: batch.summary?.skipped ?? 0,
    left_out_reasons: batch.summary?.skipped_reasons || {},
    errors: items.filter((it) => (it.included && it.parent_included) && it.flags.some((f) => f.level === 'error')).length,
    needs_attention: flagged.slice(0, NOTABLE_SHOWN).map(say),
    needs_attention_total: flagged.length,
    committed: batch.status === 'committed',
    next: batch.status === 'committed' ? 'Committed; nothing further to do.'
      : 'Nothing has been written yet. Read more with get_import_plan, change what goes in with update_import_plan, then commit_sheet_import.',
  };
}

/**
 * Read the rows, plan the import, write nothing to the tracker.
 *
 * The plan is stored as a draft batch, so it can be looked at, changed and
 * committed across several messages, and it shows up in the Import screen's
 * history beside the uploads.
 */
export async function planSheetImport(scope, token, { rows, sheet_name: sheetName, rules: sent }) {
  assertMayImport(scope);
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(422, 'Send at least one row.');
  if (rows.length > MCP_MAX_ROWS) {
    throw new ApiError(422, `That is ${rows.length.toLocaleString('en-IN')} rows; this reads up to ${MCP_MAX_ROWS.toLocaleString('en-IN')} in one go. Send it in parts — each keeps its own plan — or upload the sheet on the Import screen, which takes 3,000.`);
  }
  const parsed = rulesSchema.safeParse(sent || {});
  if (!parsed.success) {
    throw new ApiError(422, `Please check the import settings — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const rules = parsed.data;
  const buffer = rowsToCsv(rows);

  const { rows: [batch] } = await query(
    `INSERT INTO import_batches (filename, uploaded_by, rules) VALUES ($1, $2, $3) RETURNING *`,
    // mcp: is how ownDraft tells a planned batch from an upload, and it is
    // what the Import screen's history shows this one came in as.
    [`mcp:${sheetName || 'rows from a conversation'}`, `${token.person || token.name} (via MCP)`, JSON.stringify({ ...DEFAULT_RULES, ...rules })]
  );
  rememberFile(batch.id, buffer);
  try {
    await planBatch({ batchId: batch.id, buffer, sheet: null, rules });
  } catch (err) {
    await query(`UPDATE import_batches SET status = 'failed', error = $2 WHERE id = $1`, [batch.id, err.message]);
    fileCache.delete(batch.id);
    throw err instanceof ApiError ? err : new ApiError(422, `Could not read those rows: ${err.message}`);
  }
  return digest(await loadBatch(batch.id));
}

/** Plan it again with different rules, on the rows already sent. */
export async function replanSheetImport(scope, token, { batch_id: batchId, rules: sent }) {
  assertMayImport(scope);
  await ownDraft(batchId);
  const buffer = recallFile(batchId);
  if (!buffer) throw new ApiError(410, `The rows for batch ${batchId} are no longer held. Send them again with plan_sheet_import.`);
  const parsed = rulesSchema.safeParse(sent || {});
  if (!parsed.success) {
    throw new ApiError(422, `Please check the import settings — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const { rows: [before] } = await query('SELECT rules FROM import_batches WHERE id = $1', [batchId]);
  await planBatch({ batchId, buffer, sheet: null, rules: { ...(before.rules || {}), ...parsed.data } });
  return digest(await loadBatch(batchId));
}

// ------------------------------------------------------------------ read

const PAGE = { default: 25, max: 100 };

/** The plan in detail, a page at a time, filtered to what is being asked about. */
export async function getImportPlan(scope, { batch_id: batchId, step, only, limit, offset }) {
  assertMayImport(scope);
  const batch = await loadBatch(batchId);
  const win = { limit: Math.min(Math.max(Number(limit) || PAGE.default, 1), PAGE.max), offset: Math.max(Number(offset) || 0, 0) };
  let items = batch.items;
  if (step) items = items.filter((it) => it.step === step);
  if (only === 'flagged') items = items.filter(notable);
  else if (only === 'errors') items = items.filter((it) => it.flags.some((f) => f.level === 'error'));
  else if (only === 'duplicates') items = items.filter((it) => it.existing_ref);
  else if (only === 'excluded') items = items.filter((it) => !(it.included && it.parent_included));
  const page = items.slice(win.offset, win.offset + win.limit);
  return {
    ...digest(batch),
    // The page replaces the digest's sample: a caller that asked for detail
    // wants these rows, not the first 25 flagged ones over again.
    needs_attention: undefined,
    needs_attention_total: undefined,
    items: page.map(say),
    total: items.length,
    offset: win.offset,
    limit: win.limit,
    has_more: win.offset + page.length < items.length,
  };
}

// ---------------------------------------------------------------- change

const ACTIONS = ['create', 'update', 'skip'];

/**
 * Change what the commit will do, before it does it.
 *
 * Two decisions, the same two the review screen offers. `included` ticks
 * and unticks rows. `action` decides a duplicate: `skip` keeps what the
 * tracker already has, `update` replaces it from the sheet. Either can be
 * aimed at named rows (`seqs`) or at a whole step, which is how a reviewer
 * answers "keep all the existing POs" in one go.
 */
export async function updateImportPlan(scope, { batch_id: batchId, seqs, step, included, action, duplicates_only: duplicatesOnly = false }) {
  assertMayImport(scope);
  await ownDraft(batchId);
  if (included === undefined && !action) throw new ApiError(422, 'Say what to change: included (tick or untick), or action (skip keeps the original, update replaces it).');
  if (action && !ACTIONS.includes(action)) throw new ApiError(422, `action must be one of ${ACTIONS.join(', ')}.`);
  if (!seqs?.length && !step) throw new ApiError(422, 'Say which rows: seqs from the plan, or a step.');

  const where = ['batch_id = $1'];
  const params = [batchId];
  if (seqs?.length) { params.push(seqs); where.push(`seq = ANY($${params.length}::int[])`); }
  if (step) { params.push(step); where.push(`step = $${params.length}`); }
  // Only a duplicate can be kept or replaced; a fresh row has nothing to
  // keep. The route says the same thing one item at a time.
  if (action && action !== 'create') where.push('existing_ref IS NOT NULL');
  else if (duplicatesOnly) where.push('existing_ref IS NOT NULL');

  const sets = [];
  if (included !== undefined) { params.push(Boolean(included)); sets.push(`included = $${params.length}`); }
  if (action) { params.push(action); sets.push(`action = $${params.length}`); }
  const { rowCount } = await query(
    `UPDATE import_items SET ${sets.join(', ')}, updated_at = now() WHERE ${where.join(' AND ')}`, params);
  return { ...digest(await loadBatch(batchId)), changed: rowCount };
}

// ---------------------------------------------------------------- commit

/**
 * Write the plan to the tracker. The only step here that cannot be undone.
 *
 * `confirm` is required and defaults to nothing: a model that means to look
 * at a plan cannot commit it by leaving an argument out. The error check is
 * the upload screen's — an included row that would fail stops the whole
 * batch rather than committing the rest around it.
 */
export async function commitSheetImport(scope, token, { batch_id: batchId, confirm }) {
  assertMayImport(scope);
  await ownDraft(batchId);
  if (confirm !== true) throw new ApiError(422, 'Pass confirm: true to write this plan to the tracker. Nothing is written without it.');
  const batch = await loadBatch(batchId);
  const items = batch.items.map((it) => ({ ...it, included: it.included && it.parent_included }));
  const blocking = items.filter((it) => it.included && it.flags.some((f) => f.level === 'error'));
  if (blocking.length) {
    throw new ApiError(422, `${blocking.length} row(s) still have errors, so nothing was written. Fix them or untick them with update_import_plan, then commit again. Rows: ${blocking.slice(0, 10).map((b) => b.seq).join(', ')}${blocking.length > 10 ? '…' : ''}`);
  }
  const result = await commitBatch(batch, items, { user: `${token.person || token.name} (via MCP)` });
  fileCache.delete(batchId);
  // commitBatch reports every record it touched, one line each — the full
  // list of a 500-row sheet is tens of thousands of characters and would
  // arrive as the reply to "commit it". The counts say what happened; the
  // lines are on the Import screen, which keeps committed batches for good.
  const written = result.written;
  const by = {};
  for (const w of written) by[w.action] = (by[w.action] || 0) + 1;
  return {
    ...digest(await loadBatch(batchId)),
    written_count: written.length,
    written_by_action: by,
    written: written.slice(0, WRITTEN_SHOWN),
    written_shown: Math.min(written.length, WRITTEN_SHOWN),
  };
}
