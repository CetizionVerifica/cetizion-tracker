/**
 * The sheet-import pipeline, without the HTTP around it.
 *
 * This lived inside routes/import.js, which was fine while an upload was
 * the only way in. The MCP server now plans and commits the same batches
 * from a conversation (#135), and two callers sharing a pipeline must
 * share the code that is the pipeline — a second planBatch would be a
 * second set of rules, drifting from the first the day either changed.
 *
 * Nothing here knows about requests, files or tokens. The callers bring
 * the bytes and say who is asking.
 */
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { readWorkbook } from './parse.js';
import { mapColumns, readStages, reviewRows, aiConfig, usage, resetUsage } from './ai.js';
import { buildPlan, extractRow, summarise, IMPORT_AUTHOR, SHEET_FIELDS } from './rules.js';
import { stageKey, needsReading } from './stages.js';
import { businessToday, businessYear } from '../lib/businessDate.ts';


/** What the plan needs to know about the live data, in one round trip. */
export async function liveSnapshot() {
  const [q, po, pr, sv, st, nq, np, trail, tasks, notes] = await Promise.all([
    query(`SELECT id, quotation_no, client_name, service_quoted, quotation_date::text AS quotation_date, status, project_id, quotation_value, contact_person,
      sales_person, currency, remarks, next_step, last_contacted_at::date::text AS last_contacted_at FROM quotations`),
    query('SELECT po_number, project_id, po_date::text AS po_date, po_value, currency FROM purchase_orders'),
    query('SELECT project_id, client_name, primary_service FROM projects'),
    query('SELECT po_number, service, service_value FROM po_services ORDER BY id'),
    query('SELECT po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date::text AS invoice_date, amount_received FROM payment_stages'),
    query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(quotation_no, '^.*/', ''), '')::int), 0) AS n FROM quotations WHERE quotation_no ~ '^CTZ/QT/\\d{4}/\\d+$'`),
    query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(project_id, '^.*-', ''), '')::int), 0) AS n FROM projects WHERE project_id ~ '^PRJ-\\d{4}-\\d+$'`),
    // What the last committed upload said about each deal, to tell what is new.
    query(`SELECT DISTINCT ON (ref) ref, payload FROM (
        SELECT substring(i.committed_ref from '.*: (.*)$') AS ref, i.payload, b.committed_at
          FROM import_items i JOIN import_batches b ON b.id = i.batch_id
         WHERE b.status = 'committed' AND i.step = 'quotation' AND i.included AND i.committed_ref IS NOT NULL) x
      WHERE ref IS NOT NULL ORDER BY ref, committed_at DESC`),
    query(`SELECT DISTINCT ON (entity_id) entity_id, id, due_at::text AS due_at FROM tasks
      WHERE entity = 'quotation' AND type = 'follow_up' AND created_by = $1 AND status <> 'done' ORDER BY entity_id, due_at`, [IMPORT_AUTHOR]),
    query(`SELECT entity_id, body FROM notes WHERE entity = 'quotation' AND author = $1`, [IMPORT_AUTHOR]),
  ]);
  const sheetNotes = {};
  for (const n of notes.rows) (sheetNotes[n.entity_id] ||= []).push(n.body);
  return {
    quotations: q.rows, purchase_orders: po.rows, projects: pr.rows, services: sv.rows, stages: st.rows,
    next_quotation_no: Number(nq.rows[0].n) + 1,
    next_project_no: Number(np.rows[0].n) + 1,
    year: businessYear(),
    today: businessToday(),
    // What the last committed upload said about each deal.
    //
    // `was` is the half that was missing: without it the planner could see
    // that the sheet and the tracker disagree but not which of the two had
    // moved, so a re-upload of an unchanged sheet reverted whatever a human
    // had corrected in between. Keeping the previous sheet values makes it
    // a three-way merge (rules.js, sheetChanges).
    trail: Object.fromEntries(trail.rows.map((t) => [t.ref, {
      ...(t.payload.tracking?.sheet || {}),
      legacy: t.payload.remarks || null,
      remarks_field: t.payload.remarks || null,
      was: Object.fromEntries(SHEET_FIELDS.map((col) => [col, t.payload[col] ?? null])),
    }])),
    follow_up_tasks: Object.fromEntries(tasks.rows.map((t) => [t.entity_id, { id: t.id, due_at: t.due_at }])),
    sheet_notes: sheetNotes,
  };
}

/**
 * The most rows one upload may carry.
 *
 * The 15 MB multer limit was the only bound, and an xlsx is a zip, so it
 * decompresses to far more sheet than that suggests. Nothing here scales
 * gently: matching is rows × quotations of fuzzy comparison on the event
 * loop, the row is extracted four times over, the plan inserts about seven
 * database round trips per row, and the AI review is one call per fifteen
 * rows — all inside the HTTP request, which means the whole process stops
 * serving anybody while it runs. Refusing a sheet is a sentence someone
 * can act on; a request that never returns is not.
 */
export const MAX_IMPORT_ROWS = 3000;

/** Parse, map, review, plan — and store the result as draft items. */
export async function planBatch({ batchId, buffer, sheet, rules }) {
  const wb = readWorkbook(buffer, sheet);
  if (wb.rows.length > MAX_IMPORT_ROWS) {
    throw new ApiError(422, `Sheet "${wb.sheet}" has ${wb.rows.length.toLocaleString('en-IN')} rows; this reads up to ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} at a time. Split it and upload the parts — each one keeps its own review.`);
  }
  resetUsage();
  const { mapping, source: mapSource, ai_error: mapErr } = await mapColumns(wb.headers, wb.rows.slice(0, 5));
  if (!mapping.client || !mapping.stage) {
    throw new ApiError(422, `Could not find the client and deal-stage columns on sheet "${wb.sheet}". Headers seen: ${wb.headers.join(', ')}`);
  }
  // A project status report or a contact list has a client and a status but
  // nothing about a deal: importing it would invent quotations.
  const DEAL_FIELDS = ['proposal_date', 'quotation_no', 'quoted_price', 'po_number', 'po_amount', 'po_date', 'invoice_number'];
  if (!DEAL_FIELDS.some((f) => mapping[f])) {
    throw new ApiError(422, `Sheet "${wb.sheet}" does not look like a sales sheet: it has no proposal date, quotation number, quoted value, PO number or PO amount column, so there is nothing to import as a deal. Headers seen: ${wb.headers.join(', ')}`);
  }
  // Stage wordings the rules are unsure of go to the model once; its readings are
  // kept with the batch's rules, so reading the sheet again does not ask twice.
  const stageMap = rules?.stage_map || null;
  const known = rules?.ai_stage_map || {};
  const unread = wb.rows.map((r) => extractRow(r, mapping, { stageMap }))
    .filter((r) => r.stage_by === 'rule' && needsReading(r.stage_raw) && !(stageKey(r.stage_raw) in known)).map((r) => r.stage_raw);
  const { map: aiStages, ai_error: stageErr } = await readStages(unread);
  // A wording the model could not read either is remembered as such (null).
  const asked = stageErr || !aiConfig.enabled ? {} : Object.fromEntries(unread.map((w) => [stageKey(w), null]));
  rules = { ...(rules || {}), ai_stage_map: { ...known, ...asked, ...aiStages } };
  const extracted = wb.rows.map((r) => extractRow(r, mapping, { stageMap, aiStageMap: rules.ai_stage_map }));
  const { hints, source: reviewSource, ai_error: reviewErr, ai_rows, ai_sent, ai_ms } = await reviewRows(extracted.filter((r) => r.client && r.stage));
  const live = await liveSnapshot();
  const plan = buildPlan({ rows: wb.rows, mapping, live, hints, rules });

  await transaction(async (client) => {
    await client.query('DELETE FROM import_items WHERE batch_id = $1', [batchId]);
    for (const it of plan.items) {
      await client.query(
        `INSERT INTO import_items (batch_id, step, seq, source_row, parent_item_id, action, included, payload, flags, assumptions, existing_ref)
         VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8,$9,$10)`,
        [batchId, it.step, it.seq, it.source_row, it.action, it.included, JSON.stringify({ ...it.payload, __parent_seq: it.parent_seq ?? null }), JSON.stringify(it.flags), JSON.stringify(it.assumptions), it.existing_ref || null]
      );
    }
    await client.query(
      `UPDATE import_batches SET sheet_name = $2, row_count = $3, mapping = $4, rules = $5, summary = $6, ai_model = $7, error = NULL WHERE id = $1`,
      [batchId, wb.sheet, wb.rows.length, JSON.stringify({ mapping, source: mapSource, review_source: reviewSource, sheets: wb.sheets, headers: wb.headers, dropped_columns: wb.dropped_columns, ai_errors: [mapErr, stageErr, reviewErr].filter(Boolean), ai_rows, ai_sent, ai_ms, ai_usage: { ...usage } }),
        JSON.stringify(plan.rules), JSON.stringify({ ...plan.summary, skipped_rows: plan.skipped }), aiConfig.enabled ? aiConfig.model : 'no AI key: rules only']
    );
  });
  return plan;
}

/**
 * Uploaded bytes, kept only long enough to re-plan.
 *
 * This was an unbounded Map holding every upload for the process lifetime,
 * and only a draft delete ever removed one — so a committed batch leaked
 * its buffer for good. A weekly 10 MB sheet is half a gigabyte of retained
 * client data a year in a container nothing restarts between deploys, and
 * the raw sheet sitting in heap long after the import is a retention
 * problem as much as a memory one.
 *
 * Evicted on commit, on delete, past its age, and oldest-first past the
 * count. Losing one only costs a re-upload: `replan` already 410s when the
 * bytes are gone, which is also what happens when a second worker serves
 * the request.
 */
const FILE_CACHE_MAX = 8;
const FILE_CACHE_TTL_MS = 60 * 60 * 1000;
export const fileCache = new Map();

export function rememberFile(id, buffer) {
  const now = Date.now();
  for (const [key, held] of fileCache) {
    if (now - held.at > FILE_CACHE_TTL_MS) fileCache.delete(key);
  }
  fileCache.set(id, { buffer, at: now });
  // Map iterates in insertion order, so the first key is the oldest.
  while (fileCache.size > FILE_CACHE_MAX) fileCache.delete(fileCache.keys().next().value);
}

export function recallFile(id) {
  const held = fileCache.get(id);
  if (!held) return null;
  if (Date.now() - held.at > FILE_CACHE_TTL_MS) { fileCache.delete(id); return null; }
  return held.buffer;
}

export async function loadBatch(id) {
  const { rows } = await query('SELECT * FROM import_batches WHERE id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Import batch not found');
  const items = (await query('SELECT * FROM import_items WHERE batch_id = $1 ORDER BY seq', [id])).rows.map((it) => {
    const { __parent_seq, ...payload } = it.payload;
    return { ...it, payload, parent_seq: __parent_seq ?? null };
  });
  const bySeq = new Map(items.map((it) => [it.seq, it]));
  for (const it of items) {
    // A child is only committed if its parent is; show that on the child.
    let p = it.parent_seq ? bySeq.get(it.parent_seq) : null;
    it.parent_included = true;
    while (p) { if (!p.included) { it.parent_included = false; break; } p = p.parent_seq ? bySeq.get(p.parent_seq) : null; }
    it.source_client = it.payload.client_name || bySeq.get(rootSeq(it, bySeq))?.payload.client_name || null;
  }
  const summary = summarise(items.map((it) => ({ ...it, included: it.included && it.parent_included })), rows[0].summary?.skipped_rows || []);
  return { ...rows[0], summary: { ...rows[0].summary, ...summary }, items };
}
export function rootSeq(it, bySeq) { let cur = it; while (cur.parent_seq && bySeq.get(cur.parent_seq)) cur = bySeq.get(cur.parent_seq); return cur.seq; }
