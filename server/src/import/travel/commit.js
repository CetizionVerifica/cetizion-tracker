/**
 * Write a reviewed travel batch (#196 §5.1 step 4), in one transaction,
 * step by step: travellers, trips, legs, the agency's invoices, their
 * lines, credit notes. Items name each other by seq; each one written
 * records what it became (committed_ref), and anything that fails names
 * its row and rolls the whole batch back.
 *
 * An item marked skip is a record already in the tracker: it is used as
 * it is — a new leg can still join a trip from an earlier upload, a new
 * line an invoice already recorded. Update writes the sheet's values over
 * it; an updated invoice takes the sheet's lines in place of its own.
 */
import { transaction } from '../../db.js';
import { ApiError } from '../../middleware/error.js';
import { claimNextId, yearFor } from '../../lib/sequences.js';
import { emit } from '../../lib/webhooks.js';
import { TRAVEL_STEPS } from './batches.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const withAssumptions = (remarks, assumptions) =>
  [remarks, ...(assumptions || []).map((a) => `Import assumed: ${a}`)].filter(Boolean).join('\n') || null;

export async function commitTravelBatch(batch, { user }) {
  const live = batch.items.filter((it) => it.included && it.parent_included);
  const bySeq = new Map(batch.items.map((it) => [it.seq, it]));
  const refs = new Map();
  const names = new Map();
  const written = Object.fromEntries(TRAVEL_STEPS.map((s) => [s, 0]));
  const memory = { columns: {}, staff: {}, tripTypes: {}, ...(batch.mapping?.memory || {}) };
  const replaced = new Set();
  const created = { trips: [], invoices: [] };

  await transaction(async (client) => {
    const { rows: [vendor] } = await client.query('SELECT id, name, payment_terms_days FROM travel_vendors WHERE id = $1', [batch.vendor_id]);

    // ---------------------------------------------------------------- each step
    async function traveller(c, it, p) {
      let id = p.staff_id;
      if (!id) {
        const { rows: [s] } = await c.query(
          `INSERT INTO staff (name, email) VALUES ($1, $2)
           ON CONFLICT ((lower(btrim(name)))) DO UPDATE SET name = staff.name RETURNING id, name, email, (xmax = 0) AS inserted`, [p.name.trim(), p.email || null]);
        id = s.id;
        names.set(it.seq, { name: s.name, email: s.email });
        if (s.inserted) written.traveller += 1;
      } else {
        const { rows: [s] } = await c.query('SELECT id, name, email FROM staff WHERE id = $1', [id]);
        if (!s) throw new Error(`staff member ${id} is not in the tracker`);
        names.set(it.seq, { name: s.name, email: s.email });
      }
      for (const sp of p.spellings || []) memory.staff[norm(sp)] = id;
      return id;
    }

    const travellerOf = (p) => (p.traveller_seq && names.get(p.traveller_seq)) || { name: p.employee_name, email: null };
    const TRIP_COLS = ['po_number', 'project_id', 'employee_name', 'employee_email', 'staff_id', 'vendor_id', 'trip_type_id', 'origin', 'destination',
      'travel_start_date', 'travel_end_date', 'booking_date', 'cancelled', 'client_label', 'remarks'];
    async function trip(c, it, p) {
      const who = travellerOf(p);
      const row = {
        ...p, employee_name: who.name, employee_email: who.email, staff_id: p.traveller_seq ? refs.get(p.traveller_seq) ?? null : null,
        vendor_id: vendor.id, po_number: p.po_number || null, project_id: p.po_number ? null : p.project_id || null,
        remarks: withAssumptions(p.remarks, it.assumptions),
      };
      if (p.trip_type_wording && p.trip_type_id) memory.tripTypes[norm(p.trip_type_wording)] = p.trip_type_id;
      if (it.action === 'skip') return it.existing_ref;
      if (it.action === 'update') {
        await c.query(`UPDATE travel_logs SET ${TRIP_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE travel_id = $1`,
          [it.existing_ref, ...TRIP_COLS.map((k) => row[k] ?? null)]);
        written.trip += 1;
        return it.existing_ref;
      }
      let travelId = p.travel_id;
      if (travelId) {
        const { rowCount } = await c.query('SELECT 1 FROM travel_logs WHERE travel_id = $1', [travelId]);
        if (rowCount) throw new Error(`trip ${travelId} is already in the tracker: mark it as a duplicate or clear the Travel ID`);
      } else travelId = await claimNextId('travel', c, yearFor('travel', p.travel_start_date));
      await c.query(`INSERT INTO travel_logs (travel_id, ${TRIP_COLS.join(', ')}) VALUES ($1, ${TRIP_COLS.map((_, i) => `$${i + 2}`).join(', ')})`,
        [travelId, ...TRIP_COLS.map((k) => row[k] ?? null)]);
      written.trip += 1;
      created.trips.push({ travel_id: travelId, po_number: row.po_number, project_id: row.project_id, employee_name: row.employee_name, destination: row.destination });
      return travelId;
    }

    const SEG_COLS = ['mode', 'from_place', 'to_place', 'start_date', 'end_date', 'provider', 'pnr_or_ref', 'status', 'remarks'];
    async function segment(c, it, p) {
      const travelId = refs.get(p.trip_seq);
      if (!travelId) throw new Error('its trip is not being imported');
      if (it.action === 'skip') return it.existing_ref ? Number(it.existing_ref) : null;
      if (it.action === 'update') {
        await c.query(`UPDATE travel_segments SET ${SEG_COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [Number(it.existing_ref), ...SEG_COLS.map((k) => p[k] ?? null)]);
        written.segment += 1;
        return Number(it.existing_ref);
      }
      // A leg joining a trip already in the tracker goes after its legs.
      const trip = bySeq.get(p.trip_seq);
      const { rows: [{ next }] } = trip?.action === 'create'
        ? { rows: [{ next: p.seq }] }
        : await c.query('SELECT COALESCE(max(seq), 0) + 1 AS next FROM travel_segments WHERE travel_id = $1', [travelId]);
      const { rows: [s] } = await c.query(
        `INSERT INTO travel_segments (travel_id, seq, ${SEG_COLS.join(', ')}) VALUES ($1, $2, ${SEG_COLS.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
        [travelId, next, ...SEG_COLS.map((k) => (k === 'status' ? p.status || 'booked' : p[k] ?? null))]);
      written.segment += 1;
      return s.id;
    }

    async function vendorInvoice(c, it, p) {
      if (it.action === 'skip') return Number(it.existing_ref);
      if (it.action === 'update') {
        await c.query('UPDATE travel_vendor_invoices SET invoice_date = COALESCE($2, invoice_date) WHERE id = $1', [Number(it.existing_ref), p.invoice_date || null]);
        // The sheet's lines take the place of the invoice's own; its total follows them.
        await c.query('DELETE FROM travel_vendor_invoice_lines WHERE vendor_invoice_id = $1', [Number(it.existing_ref)]);
        replaced.add(it.seq);
        written.vendor_invoice += 1;
        return Number(it.existing_ref);
      }
      const vid = await claimNextId('vendor_invoice', c, yearFor('vendor_invoice', p.invoice_date));
      const { rows: [inv] } = await c.query(
        `INSERT INTO travel_vendor_invoices (vendor_invoice_id, vendor_id, vendor_invoice_no, invoice_date, payment_terms_days, remarks)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [vid, vendor.id, p.vendor_invoice_no, p.invoice_date || null, vendor.payment_terms_days, withAssumptions(p.remarks, it.assumptions)]);
      written.vendor_invoice += 1;
      created.invoices.push({ id: inv.id, vendor_invoice_id: vid, vendor_invoice_no: p.vendor_invoice_no });
      return inv.id;
    }

    const LINE_COLS = ['base_fare', 'service_charge', 'gst_amount', 'gst_rate', 'line_total', 'remarks'];
    async function invoiceLine(c, it, p) {
      const invoiceId = refs.get(p.invoice_seq);
      if (!invoiceId) return null;
      if (it.action === 'skip' && !replaced.has(p.invoice_seq)) return null;
      const travelId = refs.get(p.trip_seq);
      if (!travelId) throw new Error('its trip is not being imported');
      const { rows: [l] } = await c.query(
        `INSERT INTO travel_vendor_invoice_lines (vendor_invoice_id, travel_id, segment_id, ${LINE_COLS.join(', ')})
         VALUES ($1, $2, $3, ${LINE_COLS.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING id`,
        [invoiceId, travelId, p.segment_seq ? refs.get(p.segment_seq) ?? null : null, ...LINE_COLS.map((k) => p[k] ?? null)]);
      written.invoice_line += 1;
      return l.id;
    }

    async function creditNote(c, it, p) {
      if (it.action === 'skip') return null;
      let against = p.against_invoice_seq ? refs.get(p.against_invoice_seq) ?? null : null;
      if (!against && p.against_invoice_no) {
        const { rows } = await c.query('SELECT id FROM travel_vendor_invoices WHERE vendor_id = $1 AND upper(vendor_invoice_no) = upper($2)', [vendor.id, p.against_invoice_no]);
        against = rows[0]?.id ?? null;
      }
      const values = [vendor.id, p.credit_note_no, p.credit_note_date || null, against, p.segment_seq ? refs.get(p.segment_seq) ?? null : null,
        p.kind, p.refund_amount ?? 0, p.cancellation_charges ?? null, withAssumptions(p.remarks, it.assumptions)];
      const { rows: [n] } = await c.query(
        `INSERT INTO travel_vendor_credit_notes (vendor_id, credit_note_no, credit_note_date, against_invoice_id, segment_id, kind, refund_amount, cancellation_charges, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (vendor_id, credit_note_no) DO UPDATE SET credit_note_date = EXCLUDED.credit_note_date, against_invoice_id = EXCLUDED.against_invoice_id,
           segment_id = EXCLUDED.segment_id, kind = EXCLUDED.kind, refund_amount = EXCLUDED.refund_amount,
           cancellation_charges = EXCLUDED.cancellation_charges, remarks = EXCLUDED.remarks
         RETURNING id`, values);
      written.credit_note += 1;
      return n.id;
    }

    const WRITE = { traveller, trip, segment, vendor_invoice: vendorInvoice, invoice_line: invoiceLine, credit_note: creditNote };
    for (const step of TRAVEL_STEPS) {
      for (const it of live.filter((i) => i.step === step)) {
        const p = it.payload;
        try {
          const ref = await WRITE[step](client, it, p);
          if (ref !== undefined && ref !== null) {
            refs.set(it.seq, ref);
            await client.query('UPDATE import_items SET committed_ref = $1, error = NULL WHERE id = $2', [String(ref), it.id]);
          }
        } catch (err) {
          const where = it.source_row ? `${it.tab ? `${it.tab}, ` : ''}row ${it.source_row}` : `item ${it.seq}`;
          const e = new ApiError(422, `${where} (${step.replace('_', ' ')}): ${err.message}`);
          e.item_seq = it.seq;
          throw e;
        }
      }
    }


    for (const t of created.trips) {
      await emit('trip.created', { entity: 'travel_log', entityId: t.travel_id, data: { ...t, source: 'travel_import', batch_id: batch.id } }, client);
    }
    for (const inv of created.invoices) {
      const { rows: [v] } = await client.query('SELECT invoice_amount FROM travel_vendor_invoices WHERE id = $1', [inv.id]);
      await emit('vendor_invoice.created', { entity: 'travel_vendor_invoice', entityId: inv.vendor_invoice_id, value: v?.invoice_amount ?? null,
        data: { ...inv, vendor: vendor.name, invoice_amount: v?.invoice_amount ?? null, source: 'travel_import', batch_id: batch.id } }, client);
    }
    await client.query(
      `UPDATE import_batches SET status = 'committed', committed_at = now(), source_file = NULL,
              mapping = jsonb_set(COALESCE(mapping, '{}'::jsonb), '{memory}', $2::jsonb),
              summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('written', $3::jsonb, 'committed_by', $4::text)
        WHERE id = $1`,
      [batch.id, JSON.stringify(memory), JSON.stringify(written), user || null]);
  });
  return { written };
}
