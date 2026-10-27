/**
 * The travel importer's pipeline (#196 §5), without the HTTP around it:
 * read the workbook, plan it against what the tracker has, keep the plan
 * as draft items, and load a batch back for review.
 *
 * The workbook is kept on the batch (import_batches.source_file) rather
 * than in memory like the sales importer's, because a corrected column or
 * an unticked tab plans it again, and HR may come back to a review the
 * next day. It is dropped once the batch is committed.
 *
 * What HR corrects is remembered for the vendor — a column's meaning, which
 * staff member a spelling is, which trip type a wording is — in the
 * batch's mapping.memory, and the next upload from that vendor starts from
 * the latest one.
 */
import { query, transaction } from '../../db.js';
import { ApiError } from '../../middleware/error.js';
import { businessToday } from '../../lib/businessDate.ts';
import { MAX_IMPORT_ROWS } from '../batches.js';
import { readTravelWorkbook } from './parse.js';
import { planTravel } from './plan.js';

export const TRAVEL_STEPS = ['traveller', 'trip', 'segment', 'vendor_invoice', 'invoice_line', 'credit_note'];

/** What the plan needs from the tracker, for one vendor. */
export async function travelSnapshot(vendorId) {
  const [vendor, gap, staff, types, pos, projects, invoices, others, legs, credits] = await Promise.all([
    query('SELECT id, name, invoice_prefixes, payment_terms_days FROM travel_vendors WHERE id = $1', [vendorId]),
    query(`SELECT value FROM settings WHERE key = 'travel_import_trip_gap_days'`),
    query('SELECT id, name, email FROM staff WHERE active ORDER BY id'),
    query('SELECT id, name, chargeable, active, sort_order FROM trip_types ORDER BY sort_order, id'),
    query('SELECT po_number, project_id FROM purchase_orders'),
    query(`SELECT p.project_id, p.client_name, c.name AS company_name, p.service_request_no, p.percent_complete < 1 AS open
             FROM projects p LEFT JOIN companies c ON c.id = p.company_id`),
    query('SELECT id, vendor_invoice_id, vendor_invoice_no FROM travel_vendor_invoices WHERE vendor_id = $1 AND vendor_invoice_no IS NOT NULL', [vendorId]),
    query('SELECT vendor_invoice_no FROM travel_vendor_invoices WHERE vendor_id <> $1 AND vendor_invoice_no IS NOT NULL', [vendorId]),
    query(`SELECT s.id AS segment_id, s.travel_id, t.employee_name, s.start_date::text AS start_date, s.from_place, s.to_place
             FROM travel_segments s JOIN travel_logs t ON t.travel_id = s.travel_id WHERE t.vendor_id = $1`, [vendorId]),
    query('SELECT credit_note_no FROM travel_vendor_credit_notes WHERE vendor_id = $1', [vendorId]),
  ]);
  if (!vendor.rows.length) throw new ApiError(422, 'Choose the travel vendor this workbook is from');
  const gapDays = Number(gap.rows[0]?.value);
  return {
    vendor: vendor.rows[0], gapDays: Number.isFinite(gapDays) && gapDays >= 0 ? gapDays : 7,
    staff: staff.rows, tripTypes: types.rows, pos: pos.rows, projects: projects.rows,
    existing: { invoices: invoices.rows, otherVendorInvoices: others.rows.map((r) => r.vendor_invoice_no), legs: legs.rows, credits: credits.rows.map((r) => r.credit_note_no) },
    today: businessToday(),
  };
}

/** The corrections remembered for a vendor: the latest batch's, merged over older ones. */
export async function vendorMemory(vendorId, exceptBatch = 0) {
  const { rows } = await query(
    `SELECT mapping->'memory' AS memory FROM import_batches
      WHERE kind = 'travel' AND vendor_id = $1 AND id <> $2 AND mapping ? 'memory' ORDER BY id`,
    [vendorId, exceptBatch]);
  const memory = { columns: {}, staff: {}, tripTypes: {} };
  for (const r of rows) for (const k of Object.keys(memory)) Object.assign(memory[k], r.memory?.[k] || {});
  return memory;
}

/**
 * Plan a batch from its stored workbook and keep the items as drafts.
 * `memory` is this batch's own corrections, laid over the vendor's.
 */
export async function planTravelBatch(batchId) {
  const { rows: [batch] } = await query('SELECT * FROM import_batches WHERE id = $1', [batchId]);
  if (!batch) throw new ApiError(404, 'Import batch not found');
  if (!batch.source_file) throw new ApiError(410, 'The workbook is no longer held for this batch; upload it again');
  const workbook = readTravelWorkbook(batch.source_file);
  if (!workbook.tabs.length) {
    throw new ApiError(422, 'No tab in this workbook looks like a travel list: none has a header row with at least two of Date of Journey, Name of the person, From, To, Amount, Total or Invoice No.');
  }
  const rows = workbook.tabs.reduce((n, t) => n + t.rows.length, 0);
  if (rows > MAX_IMPORT_ROWS) throw new ApiError(422, `This workbook has ${rows.toLocaleString('en-IN')} rows; the importer reads up to ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} at a time. Split it and upload the parts.`);
  const own = batch.mapping?.memory || {};
  const vendorMem = await vendorMemory(batch.vendor_id, batchId);
  const memory = Object.fromEntries(Object.keys(vendorMem).map((k) => [k, { ...vendorMem[k], ...(own[k] || {}) }]));
  const ctx = { ...(await travelSnapshot(batch.vendor_id)), memory, tabs: batch.rules?.tabs || null };
  const plan = planTravel(workbook, ctx);

  await transaction(async (client) => {
    await client.query('DELETE FROM import_items WHERE batch_id = $1', [batchId]);
    for (const it of plan.items) {
      await client.query(
        `INSERT INTO import_items (batch_id, step, seq, source_row, action, included, payload, flags, assumptions, existing_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [batchId, it.step, it.seq, it.source_row, it.action, it.included,
          JSON.stringify({ ...it.payload, __parent_seq: it.parent_seq ?? null, __tab: it.tab }),
          JSON.stringify(it.flags), JSON.stringify(it.assumptions), it.existing_ref]);
    }
    await client.query(
      'UPDATE import_batches SET row_count = $2, mapping = $3, summary = $4, error = NULL WHERE id = $1',
      [batchId, plan.summary.rows, JSON.stringify({ tabs: plan.tabs, memory: own }), JSON.stringify(plan.summary)]);
  });
  return plan;
}


/** A batch with its items, and whether each one will be written. */
export async function loadTravelBatch(id) {
  const { rows } = await query(
    `SELECT b.id, b.kind, b.filename, b.status, b.uploaded_by, b.row_count, b.mapping, b.rules, b.summary, b.error,
            b.created_at, b.committed_at, b.vendor_id, v.name AS vendor_name
       FROM import_batches b LEFT JOIN travel_vendors v ON v.id = b.vendor_id WHERE b.id = $1 AND b.kind = 'travel'`, [id]);
  if (!rows.length) throw new ApiError(404, 'Travel import not found');
  const items = (await query('SELECT * FROM import_items WHERE batch_id = $1 ORDER BY seq', [id])).rows.map((it) => {
    const { __parent_seq, __tab, ...payload } = it.payload;
    return { ...it, payload, parent_seq: __parent_seq ?? null, tab: __tab ?? null };
  });
  const bySeq = new Map(items.map((it) => [it.seq, it]));
  const chainIn = (seq) => { let p = seq ? bySeq.get(seq) : null; while (p) { if (!p.included) return false; p = p.parent_seq ? bySeq.get(p.parent_seq) : null; } return true; };
  for (const it of items) {
    it.parent_included = chainIn(it.parent_seq);
    // A line is written to a trip, so it needs its trip too.
    if (it.step === 'invoice_line' && it.payload.trip_seq) it.parent_included &&= bySeq.get(it.payload.trip_seq)?.included !== false && chainIn(it.payload.trip_seq);
  }
  const live = items.filter((it) => it.included && it.parent_included);
  const count = (step, f = () => true) => live.filter((it) => it.step === step && f(it)).length;
  const summary = {
    ...rows[0].summary,
    will_create: Object.fromEntries(TRAVEL_STEPS.map((s) => [s, count(s, (it) => it.action === 'create')])),
    will_update: Object.fromEntries(TRAVEL_STEPS.map((s) => [s, count(s, (it) => it.action === 'update')])),
    blocking: live.filter((it) => it.flags.some((f) => f.level === 'red')).length,
  };
  return { ...rows[0], summary, items };
}
