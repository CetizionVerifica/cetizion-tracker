/**
 * The travel importer (#196 §5, §7): HR's monthly workbook from a travel
 * agency, uploaded, reviewed step by step, and committed.
 *
 *   POST   /api/import/travel                     multipart: file, [vendor_id], [tabs]
 *   GET    /api/import/travel                     travel batches, newest first
 *   GET    /api/import/travel/template.xlsx       the workbook with the columns it reads
 *   GET    /api/import/travel/:id                 a batch and its items
 *   PATCH  /api/import/travel/:id                 tabs, a column's meaning, the vendor: plans again
 *   DELETE /api/import/travel/:id                 drafts only
 *   PATCH  /api/import/travel/:id/items/:itemId   include, keep / update, edit, move a leg to another trip
 *   POST   /api/import/travel/:id/items/:itemId/split   a leg out into a trip of its own
 *   POST   /api/import/travel/:id/duplicates      keep or update every duplicate at once
 *   POST   /api/import/travel/:id/commit          write everything included
 *   POST   /api/import/travel/:id/documents       many files, matched to records by name
 *   POST   /api/import/travel/documents           the same, from the trips list
 *
 * Admin and HR only. Mounted before the sales importer, whose router is
 * administrator-only from its first line.
 */
import { Router } from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { requireRole } from '../auth/middleware.js';
import { readTravelWorkbook } from '../import/travel/parse.js';
import { TRAVEL_FIELDS, fieldFor, normHeader } from '../import/travel/fields.js';
import { loadTravelBatch, planTravelBatch } from '../import/travel/batches.js';
import { commitTravelBatch } from '../import/travel/commit.js';
import { attachTravelDocuments } from '../import/travel/documents.js';

export const travelImportRouter = Router();
travelImportRouter.use(requireRole('admin', 'hr'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const MAX_DOCUMENTS = 50;
const documentUpload = multer({ storage: multer.memoryStorage(), limits: { files: MAX_DOCUMENTS, fileSize: 15 * 1024 * 1024 } });

/** The workbook HR fills in: every column the importer reads, one tab, one example row of made-up data. */
travelImportRouter.get('/template.xlsx', (req, res) => {
  const headers = ['Date of Journey', 'Name of the person', 'Mode', 'From', 'To', 'Check-in', 'Check-out', 'Provider', 'PNR / booking ref',
    'Amount', 'Admin charges', 'GST', 'Total Amt', 'Dt of Booking', 'Trip type', 'Client Name', 'PO No.', 'Project ID', 'Service Request No.',
    'Invoice No', 'Credit note No.', 'Against Invoice', 'Travel ID', 'Remarks'];
  const example = ['2026-07-08', 'Asha Example', 'flight', 'Pune', 'Hyderabad', '', '', 'IndiGo', 'ABC123',
    5000, 200, 936, 6136, '2026-07-06', 'Chargeable', 'Example Client Ltd', '', '', 'CV101',
    'AG/2627/0001', '', '', '', ''];
  const sheet = XLSX.utils.aoa_to_sheet([headers, example]);
  sheet['!cols'] = headers.map((h) => ({ wch: Math.max(12, h.length + 2) }));
  const notes = XLSX.utils.aoa_to_sheet([
    ['One workbook per travel agency. One row per leg: a flight, train, bus, cab or hotel stay.'],
    ['Mode: flight, train, bus, cab or hotel. A hotel row fills Check-in and Check-out, and the city in To.'],
    ['Rows of one person within a week that chain (A to B, then B to A) become one trip.'],
    ['Rows sharing an Invoice No are one agency invoice. A cancellation: a Credit note No. and the Against Invoice it reverses.'],
    ['Trip type: a name from Settings, Trip types. PO No., Project ID or Service Request No. links the trip.'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Travel');
  XLSX.utils.book_append_sheet(wb, notes, 'How to fill');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="cetizion-travel-template.xlsx"');
  res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

/** The vendor whose invoice prefixes the workbook's invoice numbers carry, when exactly one does. */
async function vendorFromPrefixes(buffer) {
  let tabs;
  try { ({ tabs } = readTravelWorkbook(buffer)); } catch { return null; }
  const numbers = tabs.flatMap((t) => t.rows.flatMap((r) => Object.entries(r.cells)
    .filter(([h]) => ['invoice_no', 'credit_note_no', 'against_invoice'].includes(fieldFor(h)))
    .map(([, v]) => String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')).filter(Boolean)));
  if (!numbers.length) return null;
  const { rows } = await query(`SELECT id, invoice_prefixes FROM travel_vendors WHERE active AND cardinality(invoice_prefixes) > 0`);
  const hits = rows.filter((v) => v.invoice_prefixes.some((p) => {
    const key = p.toUpperCase().replace(/[^0-9A-Z]/g, '');
    return key && numbers.some((n) => n.startsWith(key));
  }));
  return hits.length === 1 ? hits[0].id : null;
}

travelImportRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw new ApiError(422, 'Choose the travel workbook to upload');
  let vendorId = Number(req.body.vendor_id) || null;
  if (!vendorId) vendorId = await vendorFromPrefixes(req.file.buffer);
  if (!vendorId) throw new ApiError(422, 'Choose the travel vendor this workbook is from: its invoice numbers match no vendor\'s invoice prefixes');
  let tabs = null;
  if (req.body.tabs) {
    try { tabs = JSON.parse(req.body.tabs); } catch { throw new ApiError(422, 'tabs must be a JSON list of tab names'); }
    if (!Array.isArray(tabs) || !tabs.every((t) => typeof t === 'string')) throw new ApiError(422, 'tabs must be a JSON list of tab names');
  }
  const { rows: [batch] } = await query(
    `INSERT INTO import_batches (kind, filename, uploaded_by, vendor_id, source_file, rules)
     VALUES ('travel', $1, $2, $3, $4, $5) RETURNING id`,
    [req.file.originalname, req.user.username, vendorId, req.file.buffer, JSON.stringify({ tabs })]);
  try {
    await planTravelBatch(batch.id);
  } catch (err) {
    await query(`UPDATE import_batches SET status = 'failed', error = $2, source_file = NULL WHERE id = $1`, [batch.id, err.message]);
    throw err instanceof ApiError ? err : new ApiError(422, `Could not read this workbook: ${err.message}`);
  }
  res.status(201).json({ data: await loadTravelBatch(batch.id) });
});

travelImportRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT b.id, b.filename, b.status, b.uploaded_by, b.row_count, b.summary, b.error, b.created_at, b.committed_at, v.name AS vendor_name
       FROM import_batches b LEFT JOIN travel_vendors v ON v.id = b.vendor_id
      WHERE b.kind = 'travel' ORDER BY b.id DESC LIMIT 100`);
  res.json({ data: rows });
});

const batchId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(404, 'Travel import not found');
  return id;
};

async function draft(id) {
  const batch = await loadTravelBatch(id);
  if (batch.status === 'committed') throw new ApiError(409, 'This import is already committed');
  return batch;
}

travelImportRouter.get('/:id', async (req, res) => {
  res.json({ data: await loadTravelBatch(batchId(req)) });
});

const FIELD_CHOICES = [...Object.keys(TRAVEL_FIELDS), 'ignore'];
const batchEdit = z.object({
  tabs: z.array(z.string()).nullable().optional(),
  column: z.object({ header: z.string().min(1), field: z.enum(FIELD_CHOICES).nullable() }).optional(),
  vendor_id: z.coerce.number().int().positive().optional(),
}).strict();

/** Choose tabs, correct what a column means, or change the vendor: the workbook is planned again. */
travelImportRouter.patch('/:id', async (req, res) => {
  const id = batchId(req);
  const batch = await draft(id);
  const sent = batchEdit.safeParse(req.body || {});
  if (!sent.success) throw new ApiError(422, sent.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const { tabs, column, vendor_id: vendorId } = sent.data;
  const mapping = batch.mapping || {};
  const memory = { columns: {}, staff: {}, tripTypes: {}, ...(mapping.memory || {}) };
  // A column's meaning is remembered by its header, for this vendor: "ignore" or null both mean not read.
  if (column) memory.columns[normHeader(column.header)] = column.field ?? 'ignore';
  await query(
    `UPDATE import_batches SET rules = $2, mapping = $3, vendor_id = COALESCE($4, vendor_id) WHERE id = $1`,
    [id, JSON.stringify({ ...(batch.rules || {}), ...(tabs !== undefined ? { tabs } : {}) }), JSON.stringify({ ...mapping, memory }), vendorId ?? null]);
  await planTravelBatch(id);
  res.json({ data: await loadTravelBatch(id) });
});

travelImportRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await query(`DELETE FROM import_batches WHERE id = $1 AND kind = 'travel' AND status <> 'committed'`, [batchId(req)]);
  if (!rowCount) throw new ApiError(409, 'A committed import is kept as a record and cannot be deleted');
  res.status(204).end();
});

// ---------------------------------------------------------------- items

const blank = (v) => (v === '' ? null : v);
const text = () => z.preprocess(blank, z.string().trim().max(500).nullable().optional());
const day = () => z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional());
const money = () => z.preprocess((v) => (blank(v) === null ? null : typeof v === 'string' ? Number(v.replace(/,/g, '')) : v), z.number().finite().nullable().optional());
const id = () => z.preprocess(blank, z.coerce.number().int().positive().nullable().optional());
const PAYLOADS = {
  traveller: z.object({ name: text(), staff_id: id() }),
  trip: z.object({
    po_number: text(), project_id: text(), client_label: text(), trip_type_id: id(), origin: text(), destination: text(),
    travel_start_date: day(), travel_end_date: day(), booking_date: day(), cancelled: z.boolean().optional(), remarks: text(),
  }),
  segment: z.object({
    mode: z.enum(['flight', 'train', 'bus', 'cab', 'hotel', 'other']).optional(), from_place: text(), to_place: text(),
    start_date: day(), end_date: day(), provider: text(), pnr_or_ref: text(),
    status: z.enum(['booked', 'cancelled', 'partly_refunded']).optional(), remarks: text(), trip_seq: z.number().int().positive().optional(),
  }),
  vendor_invoice: z.object({ vendor_invoice_no: text(), invoice_date: day(), remarks: text() }),
  invoice_line: z.object({ base_fare: money(), service_charge: money(), gst_amount: money(), gst_rate: money(), line_total: money(), remarks: text() }),
  credit_note: z.object({
    credit_note_no: text(), credit_note_date: day(), kind: z.enum(['credit_note', 'cancellation_note']).optional(),
    refund_amount: money(), cancellation_charges: money(), against_invoice_no: text(), remarks: text(),
  }),
};

/** The flags an edit settles, by the field edited; what is still wrong is flagged again by recheck. */
const CLEARS = {
  trip_type_id: ['trip_type_unknown', 'chargeable_unlinked'],
  po_number: ['po_not_found', 'no_po_or_project', 'linked_by_client', 'chargeable_unlinked', 'service_request_not_found', 'project_by_service_request', 'po_holds_client'],
  project_id: ['po_not_found', 'no_po_or_project', 'linked_by_client', 'chargeable_unlinked', 'service_request_not_found', 'project_by_service_request'],
  client_label: ['no_po_or_project'],
  start_date: ['no_date', 'unreadable_date', 'text_date', 'hotel_dates'],
  end_date: ['hotel_dates'],
  travel_start_date: ['journey_before_booking'],
  booking_date: ['journey_before_booking', 'unreadable_date', 'text_date'],
  line_total: ['no_amount', 'unreadable_amount', 'total_blank', 'total_mismatch'],
  base_fare: ['no_amount', 'unreadable_amount', 'total_mismatch'],
  service_charge: ['unreadable_amount', 'total_mismatch'],
  gst_amount: ['gst_blank', 'unreadable_amount', 'total_mismatch'],
  staff_id: ['new_staff', 'matched_first_name'],
  name: ['no_traveller'],
};

function recheck(step, p, flags, tripTypes) {
  const out = [...flags];
  const has = (code) => out.some((f) => f.code === code);
  const red = (code, message) => { if (!has(code)) out.push({ level: 'red', code, message }); };
  if (step === 'trip') {
    if (!p.trip_type_id) red('trip_type_unknown', 'choose a trip type');
    const type = tripTypes.find((t) => t.id === p.trip_type_id);
    if (type?.chargeable && !p.po_number && !p.project_id && !has('chargeable_unlinked')) out.push({ level: 'amber', code: 'chargeable_unlinked', message: 'a chargeable trip with no PO or project' });
  }
  if (step === 'segment') {
    if (!p.start_date) red('no_date', p.mode === 'hotel' ? 'no check-in date' : 'no date of journey');
    if (p.mode === 'hotel' && !(p.start_date && p.end_date && p.end_date > p.start_date)) red('hotel_dates', 'a hotel stay needs a check-out after its check-in');
  }
  if (step === 'invoice_line' && p.line_total == null && p.base_fare == null) red('no_amount', 'no amount');
  if (step === 'traveller' && !p.name && !p.staff_id) red('no_traveller', 'no traveller');
  return out;
}

/** Check what an edit points at exists, and settle the PO-or-project rule the way the trip trigger will. */
async function checkReferences(step, sent, merged) {
  const exists = async (sql, v, what) => { if (v && !(await query(sql, [v])).rowCount) throw new ApiError(422, `${what} ${v} is not in the tracker`); };
  if (step === 'trip') {
    await exists('SELECT 1 FROM purchase_orders WHERE po_number = $1', sent.po_number, 'PO');
    await exists('SELECT 1 FROM projects WHERE project_id = $1', sent.project_id, 'Project');
    await exists('SELECT 1 FROM trip_types WHERE id = $1 AND active', sent.trip_type_id, 'Trip type');
    // The PO names the project; a project typed beside it is the PO's or nothing.
    if (sent.po_number) merged.project_id = null;
    if (sent.project_id) merged.po_number = null;
  }
  if (step === 'traveller' && sent.staff_id) {
    const { rows } = await query('SELECT name, email FROM staff WHERE id = $1', [sent.staff_id]);
    if (!rows.length) throw new ApiError(422, 'That staff member is not in the tracker');
    Object.assign(merged, { name: rows[0].name, email: rows[0].email, create: false });
  }
  if (step === 'traveller' && sent.staff_id === null) merged.create = true;
}

/** A trip's dates and places follow its legs after a leg moves in or out. */
async function refreshTrip(client, batch, tripSeq) {
  const { rows: legs } = await client.query(
    `SELECT payload FROM import_items WHERE batch_id = $1 AND step = 'segment' AND (payload->>'trip_seq')::int = $2 ORDER BY (payload->>'start_date'), seq`,
    [batch, tripSeq]);
  const ps = legs.map((l) => l.payload);
  const moving = ps.filter((p) => p.mode !== 'hotel' && p.mode !== 'cab');
  const dates = ps.flatMap((p) => [p.start_date, p.end_date]).filter(Boolean).sort();
  const patch = {
    origin: moving[0]?.from_place ?? null, destination: moving[0]?.to_place ?? ps[0]?.to_place ?? null,
    travel_start_date: dates[0] ?? null, travel_end_date: dates[dates.length - 1] ?? null,
    cancelled: ps.length > 0 && ps.every((p) => p.status === 'cancelled'),
  };
  await client.query(
    `UPDATE import_items SET payload = payload || $3::jsonb, included = CASE WHEN $4 THEN included ELSE false END, updated_at = now()
      WHERE batch_id = $1 AND step = 'trip' AND seq = $2`,
    [batch, tripSeq, JSON.stringify(patch), ps.length > 0]);
}

/** Move a leg, and the invoice lines for it, to another trip of the batch. */
async function moveLeg(client, batch, leg, toSeq) {
  const from = leg.payload.trip_seq;
  await client.query(
    `UPDATE import_items SET payload = payload || jsonb_build_object('trip_seq', $3::int, '__parent_seq', $3::int), updated_at = now() WHERE batch_id = $1 AND seq = $2`,
    [batch, leg.seq, toSeq]);
  await client.query(
    `UPDATE import_items SET payload = payload || jsonb_build_object('trip_seq', $3::int), updated_at = now()
      WHERE batch_id = $1 AND step = 'invoice_line' AND (payload->>'segment_seq')::int = $2`,
    [batch, leg.seq, toSeq]);
  await refreshTrip(client, batch, from);
  await refreshTrip(client, batch, toSeq);
}

async function itemOf(req) {
  const id = batchId(req);
  const batch = await draft(id);
  const item = batch.items.find((it) => it.id === Number(req.params.itemId));
  if (!item) throw new ApiError(404, 'Item not found');
  return { batch, item };
}

travelImportRouter.patch('/:id/items/:itemId', async (req, res) => {
  const { batch, item } = await itemOf(req);
  const body = req.body || {};
  const sets = []; const vals = [];
  if (typeof body.included === 'boolean') { vals.push(body.included); sets.push(`included = $${vals.length}`); }
  if (body.action !== undefined) {
    if (!['create', 'update', 'skip'].includes(body.action)) throw new ApiError(422, 'action must be create, update or skip');
    if (!item.existing_ref) throw new ApiError(422, 'Only a record already in the tracker can be kept or updated');
    if (body.action === 'create') throw new ApiError(422, 'This record is already in the tracker: keep it or update it from the sheet');
    vals.push(body.action); sets.push(`action = $${vals.length}`);
  }
  let moveTo = null;
  if (body.payload && typeof body.payload === 'object') {
    const parsed = PAYLOADS[item.step].strict().safeParse(Object.fromEntries(Object.entries(body.payload).filter(([k]) => !k.startsWith('__'))));
    if (!parsed.success) throw new ApiError(422, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const sent = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    if (sent.trip_seq !== undefined && sent.trip_seq !== item.payload.trip_seq) {
      const target = batch.items.find((it) => it.step === 'trip' && it.seq === sent.trip_seq);
      if (!target) throw new ApiError(422, 'Move the leg to a trip of this import');
      moveTo = sent.trip_seq;
    }
    delete sent.trip_seq;
    const merged = { ...item.payload, ...sent };
    await checkReferences(item.step, sent, merged);
    const touched = Object.keys(sent);
    const cleared = new Set(touched.flatMap((k) => CLEARS[k] || []));
    const { rows: types } = await query('SELECT id, chargeable FROM trip_types');
    const flags = recheck(item.step, merged, item.flags.filter((f) => !cleared.has(f.code)), types);
    const assumptions = item.assumptions.filter((a) => !touched.some((t) => a.toLowerCase().includes(t.replace(/_/g, ' ').replace(/ id$/, ''))));
    vals.push(JSON.stringify({ ...merged, __parent_seq: item.parent_seq, __tab: item.tab })); sets.push(`payload = $${vals.length}`);
    vals.push(JSON.stringify(flags)); sets.push(`flags = $${vals.length}`);
    vals.push(JSON.stringify(assumptions)); sets.push(`assumptions = $${vals.length}`);
  }
  if (!sets.length && moveTo === null) throw new ApiError(422, 'Nothing to change');
  await transaction(async (client) => {
    if (sets.length) {
      vals.push(item.id);
      await client.query(`UPDATE import_items SET ${sets.join(', ')}, updated_at = now(), error = NULL WHERE id = $${vals.length}`, vals);
    }
    if (moveTo !== null) await moveLeg(client, batch.id, item, moveTo);
    // Keeping or updating a trip carries to its legs that are in the tracker too.
    if (body.action && item.step === 'trip') {
      await client.query(
        `UPDATE import_items SET action = $1, updated_at = now() WHERE batch_id = $2 AND step = 'segment' AND existing_ref IS NOT NULL AND (payload->>'trip_seq')::int = $3`,
        [body.action, batch.id, item.seq]);
    }
  });
  res.json({ data: await loadTravelBatch(batch.id) });
});

/** A leg out of its trip into a trip of its own, which starts as a copy of the one it left. */
travelImportRouter.post('/:id/items/:itemId/split', async (req, res) => {
  const { batch, item } = await itemOf(req);
  if (item.step !== 'segment') throw new ApiError(422, 'Only a leg can be split off into a trip of its own');
  const trip = batch.items.find((it) => it.step === 'trip' && it.seq === item.payload.trip_seq);
  if (!trip) throw new ApiError(422, 'This leg has no trip');
  if (batch.items.filter((it) => it.step === 'segment' && it.payload.trip_seq === trip.seq).length < 2) throw new ApiError(422, 'This is the trip\'s only leg');
  await transaction(async (client) => {
    const { rows: [{ next }] } = await client.query('SELECT max(seq) + 1 AS next FROM import_items WHERE batch_id = $1', [batch.id]);
    const flags = trip.flags.filter((f) => !['legs_grouped', 'trip_exists'].includes(f.code))
      .concat([{ level: 'blue', code: 'split', message: `split off from the trip of row ${trip.source_row}` }]);
    await client.query(
      `INSERT INTO import_items (batch_id, step, seq, source_row, action, included, payload, flags, assumptions)
       VALUES ($1, 'trip', $2, $3, 'create', true, $4, $5, $6)`,
      [batch.id, next, item.source_row, JSON.stringify({ ...trip.payload, travel_id: null, __parent_seq: trip.parent_seq, __tab: item.tab }),
        JSON.stringify(flags), JSON.stringify(trip.assumptions)]);
    await moveLeg(client, batch.id, item, next);
  });
  res.status(201).json({ data: await loadTravelBatch(batch.id) });
});

travelImportRouter.post('/:id/duplicates', async (req, res) => {
  const batch = await draft(batchId(req));
  const action = req.body?.action;
  if (!['skip', 'update'].includes(action)) throw new ApiError(422, 'action must be skip (keep the original) or update (from the sheet)');
  const step = req.body?.step || null;
  if (step && !['trip', 'segment', 'vendor_invoice', 'invoice_line', 'credit_note'].includes(step)) throw new ApiError(422, 'Unknown step');
  await query(
    `UPDATE import_items SET action = $1, updated_at = now()
      WHERE batch_id = $2 AND existing_ref IS NOT NULL AND action <> 'create' ${step ? 'AND step = $3' : ''}`,
    step ? [action, batch.id, step] : [action, batch.id]);
  res.json({ data: await loadTravelBatch(batch.id) });
});

travelImportRouter.post('/:id/commit', async (req, res) => {
  const batch = await draft(batchId(req));
  const blocking = batch.items.filter((it) => it.included && it.parent_included && it.flags.some((f) => f.level === 'red'));
  if (blocking.length) throw new ApiError(422, `${blocking.length} item(s) still have a red flag. Fix them or untick them first.`, { items: blocking.map((b) => b.id) });
  try {
    const result = await commitTravelBatch(batch, { user: req.user.username });
    res.json({ data: { ...(await loadTravelBatch(batch.id)), written: result.written } });
  } catch (err) {
    if (err.status === 422) throw new ApiError(422, err.message, { item_seq: err.item_seq });
    throw err;
  }
});

/**
 * Tickets, invoice PDFs, boarding passes: each attached to the record its
 * file name names, from the batch's review or from the trips list.
 */
async function documents(req, res) {
  if (!req.files?.length) throw new ApiError(422, 'Choose the files to upload');
  res.json({ data: await attachTravelDocuments(req.files, { user: req.user }) });
}
travelImportRouter.post('/documents', documentUpload.array('files', MAX_DOCUMENTS), documents);
travelImportRouter.post('/:id/documents', documentUpload.array('files', MAX_DOCUMENTS), async (req, res) => {
  const { rowCount } = await query(`SELECT 1 FROM import_batches WHERE id = $1 AND kind = 'travel'`, [batchId(req)]);
  if (!rowCount) throw new ApiError(404, 'Travel import not found');
  await documents(req, res);
});
