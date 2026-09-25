/**
 * Bulk import — upload a sheet, review what the importer derived from it
 * step by step, then commit it to the live tables in one go.
 *
 *   POST   /api/import/batches               multipart: file, [sheet], [rules]
 *   GET    /api/import/batches               list, newest first
 *   GET    /api/import/batches/:id           batch + items grouped by step
 *   POST   /api/import/batches/:id/replan    rebuild the plan (after a rule change)
 *   DELETE /api/import/batches/:id           drafts only
 *   PATCH  /api/import/items/:id             edit payload / include / action
 *   POST   /api/import/batches/:id/commit    write everything included
 *
 * Only the admin account may use any of these.
 */
import { Router } from 'express';
import multer from 'multer';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { requireAdmin } from '../auth/middleware.js';
import { readWorkbook } from '../import/parse.js';
import { mapColumns, readStages, reviewRows, aiConfig, usage, resetUsage } from '../import/ai.js';
import { buildPlan, reviewFlags, extractRow, summarise, DEFAULT_RULES } from '../import/rules.js';
import { stageKey, needsReading } from '../import/stages.js';
import { commitBatch } from '../import/commit.js';
import { businessYear } from '../lib/businessDate.ts';

export const importRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Whoever may run an import is whoever administers the tracker, and that
// is a different person in each sign-in mode: the one shared account, or a
// users row whose role is admin. requireAdmin answers it for both, so this
// gate keeps meaning the same thing after the cutover.
importRouter.use(requireAdmin);

/** What the plan needs to know about the live data, in one round trip. */
async function liveSnapshot() {
  const [q, po, pr, sv, st, nq, np] = await Promise.all([
    query('SELECT id, quotation_no, client_name, service_quoted, quotation_date::text AS quotation_date, status, project_id, quotation_value, contact_person FROM quotations'),
    query('SELECT po_number, project_id, po_date::text AS po_date, po_value, currency FROM purchase_orders'),
    query('SELECT project_id, client_name, primary_service FROM projects'),
    query('SELECT po_number, service, service_value FROM po_services ORDER BY id'),
    query('SELECT po_number, stage_no, stage_name, stage_percent, invoice_no, invoice_date::text AS invoice_date, amount_received FROM payment_stages'),
    query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(quotation_no, '^.*/', ''), '')::int), 0) AS n FROM quotations WHERE quotation_no ~ '^CTZ/QT/\\d{4}/\\d+$'`),
    query(`SELECT COALESCE(MAX(NULLIF(regexp_replace(project_id, '^.*-', ''), '')::int), 0) AS n FROM projects WHERE project_id ~ '^PRJ-\\d{4}-\\d+$'`),
  ]);
  return {
    quotations: q.rows, purchase_orders: po.rows, projects: pr.rows, services: sv.rows, stages: st.rows,
    next_quotation_no: Number(nq.rows[0].n) + 1,
    next_project_no: Number(np.rows[0].n) + 1,
    year: businessYear(),
  };
}

/** Parse, map, review, plan — and store the result as draft items. */
async function planBatch({ batchId, buffer, sheet, rules }) {
  const wb = readWorkbook(buffer, sheet);
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

// Keep uploaded bytes for re-planning within the process lifetime.
const fileCache = new Map();

/** A CSV template with the columns the importer understands and one example row. */
importRouter.get('/template.csv', (req, res) => {
  const headers = ['S.No', 'Client Name', 'Industry Type', 'Lead Name', 'Deal Stage', 'Proposal Name', 'Proposal Sent Date', 'Quotation No',
    'PO Received On', 'PO Number', 'PO Amount', 'Invoice Number', 'Ammount received', 'Pending', 'Follow up Comments', 'Remarks', 'Sales Person'];
  const example = ['1', 'Laurus Labs', 'Pharma', 'Ravi Kumar', 'Closed Won (100%)', 'EcoVadis', '12.03.2026', '',
    '19.03.2026', '4530056073', '7,96,500/-', '118', '1,59,300/-', '', '', 'Invoice shared for 20% adv', 'Vishnu'];
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cetizion-sales-sheet-template.csv"');
  res.send(`${headers.map(cell).join(',')}\n${example.map(cell).join(',')}\n`);
});

importRouter.post('/batches', upload.single('file'), async (req, res) => {
  if (!req.file) throw new ApiError(422, 'Choose a file to upload');
  let rules = {};
  if (req.body.rules) { try { rules = JSON.parse(req.body.rules); } catch { throw new ApiError(422, 'rules must be JSON'); } }
  const { rows } = await query(
    `INSERT INTO import_batches (filename, uploaded_by, rules) VALUES ($1, $2, $3) RETURNING *`,
    [req.file.originalname, req.user.username, JSON.stringify({ ...DEFAULT_RULES, ...rules })]
  );
  const batch = rows[0];
  fileCache.set(batch.id, req.file.buffer);
  try {
    await planBatch({ batchId: batch.id, buffer: req.file.buffer, sheet: req.body.sheet || null, rules });
  } catch (err) {
    await query(`UPDATE import_batches SET status = 'failed', error = $2 WHERE id = $1`, [batch.id, err.message]);
    throw err instanceof ApiError ? err : new ApiError(422, `Could not read this file: ${err.message}`);
  }
  res.status(201).json({ data: await loadBatch(batch.id) });
});

importRouter.get('/batches', async (req, res) => {
  const { rows } = await query('SELECT id, filename, sheet_name, status, uploaded_by, row_count, summary, ai_model, error, created_at, committed_at FROM import_batches ORDER BY id DESC LIMIT 100');
  res.json({ data: rows });
});

async function loadBatch(id) {
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
function rootSeq(it, bySeq) { let cur = it; while (cur.parent_seq && bySeq.get(cur.parent_seq)) cur = bySeq.get(cur.parent_seq); return cur.seq; }

importRouter.get('/batches/:id', async (req, res) => {
  res.json({ data: await loadBatch(Number(req.params.id)) });
});

importRouter.post('/batches/:id/replan', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT * FROM import_batches WHERE id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Import batch not found');
  if (rows[0].status === 'committed') throw new ApiError(409, 'This batch is already committed');
  const buffer = fileCache.get(id);
  if (!buffer) throw new ApiError(410, 'The uploaded file is no longer held in memory; upload it again');
  const rules = { ...(rows[0].rules || {}), ...(req.body?.rules || {}) };
  await planBatch({ batchId: id, buffer, sheet: req.body?.sheet || rows[0].sheet_name, rules });
  res.json({ data: await loadBatch(id) });
});

importRouter.delete('/batches/:id', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM import_batches WHERE id = $1 AND status <> 'committed'`, [Number(req.params.id)]);
  if (!rowCount) throw new ApiError(409, 'Committed batches are kept as a record and cannot be deleted');
  fileCache.delete(Number(req.params.id));
  res.status(204).end();
});

importRouter.patch('/items/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT i.*, b.status AS batch_status FROM import_items i JOIN import_batches b ON b.id = i.batch_id WHERE i.id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Item not found');
  if (rows[0].batch_status === 'committed') throw new ApiError(409, 'This batch is already committed');
  const body = req.body || {};
  const sets = []; const vals = [];
  if (typeof body.included === 'boolean') { vals.push(body.included); sets.push(`included = $${vals.length}`); }
  if (body.action && ['create', 'update', 'skip'].includes(body.action)) {
    if (body.action !== 'create' && !rows[0].existing_ref) throw new ApiError(422, 'Only a duplicate can be kept or replaced');
    // An exact match (PO or quotation number) cannot be created again; a
    // quotation matched only by client and service may be a different deal.
    if (body.action === 'create' && rows[0].existing_ref && !uncertainMatch(rows[0])) throw new ApiError(422, 'This record already exists on the site: keep the original or replace it');
    vals.push(body.action); sets.push(`action = $${vals.length}`);
  }
  if (body.payload && typeof body.payload === 'object') {
    const merged = { ...rows[0].payload, ...body.payload };
    vals.push(JSON.stringify(merged)); sets.push(`payload = $${vals.length}`);
    // An edit by a reviewer clears the "assumed" note for fields they touched.
    const touched = Object.keys(body.payload).filter((k) => body.payload[k] !== null && body.payload[k] !== '');
    const assumptions = (rows[0].assumptions || []).filter((a) => !touched.some((t) => a.toLowerCase().includes(t.replace(/_/g, ' '))));
    vals.push(JSON.stringify(assumptions)); sets.push(`assumptions = $${vals.length}`);
    // "No proposal date in the sheet" stops being useful once a date is typed in.
    const clears = { quotation_date: ['no_date'], contact_person: ['no_contact'], po_date: ['no_po_date'], invoice_date: ['no_invoice_date'] };
    const dropCodes = touched.flatMap((t) => clears[t] || []);
    const flags = reviewFlags(rows[0].step, merged, (rows[0].flags || []).filter((f) => !dropCodes.includes(f.code)));
    vals.push(JSON.stringify(flags)); sets.push(`flags = $${vals.length}`);
  }
  if (!sets.length) throw new ApiError(422, 'Nothing to update');
  vals.push(id);
  await query(`UPDATE import_items SET ${sets.join(', ')}, updated_at = now(), error = NULL WHERE id = $${vals.length}`, vals);
  // Importing an uncertain quotation as new makes its project new too, and
  // switching back to keep/replace takes the project with it.
  if (body.action && rows[0].step === 'quotation' && uncertainMatch(rows[0])) {
    await query(
      `UPDATE import_items SET action = $1, updated_at = now() WHERE batch_id = $2 AND step = 'project' AND existing_ref IS NOT NULL AND seq = ANY($3::int[])`,
      [body.action, rows[0].batch_id, await descendantSeqs(rows[0].batch_id, rows[0].seq)]
    );
  }
  // Keep/replace on a PO carries to its service line, stages, invoice and receipt.
  if (body.action && body.action !== 'create' && rows[0].step === 'purchase_order') {
    await query(
      `UPDATE import_items SET action = $1, updated_at = now() WHERE batch_id = $2 AND existing_ref IS NOT NULL AND seq = ANY($3::int[])`,
      [body.action, rows[0].batch_id, await descendantSeqs(rows[0].batch_id, rows[0].seq)]
    );
  }
  res.json({ data: await loadBatch(rows[0].batch_id) });
});

const uncertainMatch = (item) => item.step === 'quotation' && (item.flags || []).some((f) => f.code === 'duplicate' && f.certain === false);

async function descendantSeqs(batchId, seq) {
  const { rows } = await query(`SELECT seq, (payload->>'__parent_seq')::int AS parent_seq FROM import_items WHERE batch_id = $1`, [batchId]);
  const out = []; let frontier = [seq];
  while (frontier.length) {
    const next = rows.filter((r) => frontier.includes(r.parent_seq)).map((r) => r.seq);
    out.push(...next); frontier = next;
  }
  return out;
}

/** Keep or replace every duplicate at once, in one step or the whole batch. */
importRouter.post('/batches/:id/duplicates', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT status FROM import_batches WHERE id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Import batch not found');
  if (rows[0].status === 'committed') throw new ApiError(409, 'This batch is already committed');
  const action = req.body?.action;
  if (!['skip', 'update'].includes(action)) throw new ApiError(422, 'action must be skip (keep original) or update (replace with sheet)');
  const steps = req.body?.step === 'money' ? ['invoice', 'receipt'] : req.body?.step === 'purchase_order' ? ['purchase_order', 'service'] : req.body?.step ? [req.body.step] : null;
  await query(
    `UPDATE import_items SET action = $1, updated_at = now() WHERE batch_id = $2 AND existing_ref IS NOT NULL AND action <> 'create' ${steps ? 'AND step = ANY($3::text[])' : ''}`,
    steps ? [action, id, steps] : [action, id]
  );
  res.json({ data: await loadBatch(id) });
});

importRouter.post('/batches/:id/commit', async (req, res) => {
  const batch = await loadBatch(Number(req.params.id));
  if (batch.status === 'committed') throw new ApiError(409, 'This batch is already committed');
  const items = batch.items.map((it) => ({ ...it, included: it.included && it.parent_included }));
  const blocking = items.filter((it) => it.included && it.flags.some((f) => f.level === 'error'));
  if (blocking.length) throw new ApiError(422, `${blocking.length} included item(s) still have errors. Fix or untick them first.`, { items: blocking.map((b) => b.id) });
  try {
    const result = await commitBatch(batch, items, { user: req.user.username });
    res.json({ data: { ...(await loadBatch(batch.id)), written: result.written } });
  } catch (err) {
    if (err.status === 422) throw new ApiError(422, err.message, { item_seq: err.item_seq });
    throw err;
  }
});
