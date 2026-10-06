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
 *
 * The pipeline itself — reading the sheet, planning, and loading a batch
 * back — is in ../import/batches.js, because the MCP server plans and
 * commits the same batches from a conversation (#135).
 */
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { requireAdmin } from '../auth/middleware.js';
import { reviewFlags, DEFAULT_RULES, IMPORT_AUTHOR, SHEET_FIELDS, rulesSchema, sanitizeRules, flagRepeatedPoNumbers } from '../import/rules.js';
import { commitBatch } from '../import/commit.js';
import { fileCache, loadBatch, planBatch, recallFile, rememberFile } from '../import/batches.js';

export const importRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Whoever may run an import is whoever administers the tracker, and that
// is a different person in each sign-in mode: the one shared account, or a
// users row whose role is admin. requireAdmin answers it for both, so this
// gate keeps meaning the same thing after the cutover.
importRouter.use(requireAdmin);

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
  if (req.body.rules) {
    let sent;
    try { sent = JSON.parse(req.body.rules); } catch { throw new ApiError(422, 'rules must be JSON'); }
    const parsed = rulesSchema.safeParse(sent);
    if (!parsed.success) {
      const said = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ApiError(422, `Please check the import settings — ${said}`);
    }
    rules = parsed.data;
  }
  const { rows } = await query(
    `INSERT INTO import_batches (filename, uploaded_by, rules) VALUES ($1, $2, $3) RETURNING *`,
    [req.file.originalname, req.user.username, JSON.stringify({ ...DEFAULT_RULES, ...rules })]
  );
  const batch = rows[0];
  rememberFile(batch.id, req.file.buffer);
  try {
    await planBatch({ batchId: batch.id, buffer: req.file.buffer, sheet: req.body.sheet || null, rules });
  } catch (err) {
    await query(`UPDATE import_batches SET status = 'failed', error = $2 WHERE id = $1`, [batch.id, err.message]);
    throw err instanceof ApiError ? err : new ApiError(422, `Could not read this file: ${err.message}`);
  }
  res.status(201).json({ data: await loadBatch(batch.id) });
});

importRouter.get('/batches', async (req, res) => {
  const { rows } = await query(`SELECT id, filename, sheet_name, status, uploaded_by, row_count, summary, ai_model, error, created_at, committed_at FROM import_batches WHERE kind = 'sales' ORDER BY id DESC LIMIT 100`);
  res.json({ data: rows });
});

importRouter.get('/batches/:id', async (req, res) => {
  res.json({ data: await loadBatch(Number(req.params.id)) });
});

importRouter.post('/batches/:id/replan', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await query('SELECT * FROM import_batches WHERE id = $1', [id]);
  if (!rows.length) throw new ApiError(404, 'Import batch not found');
  if (rows[0].status === 'committed') throw new ApiError(409, 'This batch is already committed');
  const buffer = recallFile(id);
  if (!buffer) throw new ApiError(410, 'The uploaded file is no longer held in memory; upload it again');
  // Same gate as the upload: a replan takes rules from the client too.
  const sent = rulesSchema.safeParse(req.body?.rules || {});
  if (!sent.success) {
    const said = sent.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError(422, `Please check the import settings — ${said}`);
  }
  // Stored rules are sanitized, not refused: a batch saved before the schema
  // existed must still be re-plannable. Anything the request sends is checked
  // whole, as on upload.
  const stored = sanitizeRules(rows[0].rules);
  const rules = { ...stored.rules, ...sent.data };
  await planBatch({ batchId: id, buffer, sheet: req.body?.sheet || rows[0].sheet_name, rules });
  const data = await loadBatch(id);
  res.json({ data, ...(stored.dropped.length ? { meta: { dropped_rules: stored.dropped } } : {}) });
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
    // The planner's own bookkeeping is not the client's to set. __parent_seq
    // is the linkage the tree is walked by — two items pointed at each other
    // would spin `while (p)` in loadBatch forever, and the bad state is
    // stored, so every later read of the batch hangs the process again.
    // __update_fields decides which columns a commit may write. Both are
    // hidden from the client on the way out; they have to be refused on the
    // way in too.
    const sent = Object.fromEntries(Object.entries(body.payload).filter(([k]) => !k.startsWith('__')));
    const merged = { ...rows[0].payload, ...sent };
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
  // A repeated PO number is a question about the whole batch, not one row:
  // correcting a number, unticking a row or keeping an existing PO can settle
  // it for the others too, so it is asked again across the batch.
  if (rows[0].step === 'purchase_order') await recheckRepeatedPos(rows[0].batch_id);
  res.json({ data: await loadBatch(rows[0].batch_id) });
});

/**
 * Settle "the same PO number on several rows" afresh for a batch, after a
 * reviewer's change. The planner flags it once (flagRepeatedPoNumbers); without
 * this, correcting the number, or unticking the row that creates the PO, left
 * the error in place and the commit blocked for good. Only rows still ticked
 * count: an unticked row creates nothing, so it cannot collide.
 */
async function recheckRepeatedPos(batchId) {
  const { rows } = await query(
    `SELECT id, step, action, included, source_row, payload, flags FROM import_items
      WHERE batch_id = $1 AND step = 'purchase_order' ORDER BY seq`,
    [batchId]
  );
  const items = rows.map((r) => ({
    ...r,
    source_label: r.payload?.__source_label ?? null,
    before: JSON.stringify(r.flags || []),
    flags: (r.flags || []).filter((f) => f.code !== 'duplicate_po_in_sheet'),
  }));
  flagRepeatedPoNumbers(items.filter((it) => it.included));
  for (const it of items) {
    const after = JSON.stringify(it.flags);
    if (after !== it.before) await query('UPDATE import_items SET flags = $1, updated_at = now() WHERE id = $2', [after, it.id]);
  }
}

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
    // Committed, so the bytes are not wanted again.
    fileCache.delete(batch.id);
    res.json({ data: { ...(await loadBatch(batch.id)), written: result.written } });
  } catch (err) {
    if (err.status === 422) throw new ApiError(422, err.message, { item_seq: err.item_seq });
    throw err;
  }
});
