/**
 * Write a reviewed batch to the live tables.
 *
 * One transaction for the whole batch: either every included item lands,
 * or none does and the batch reports exactly which item failed and why.
 * Records are validated with the same Zod schemas the forms use.
 *
 * Each item carries the reviewer's decision in `action`:
 *   create  a new record;
 *   skip    a duplicate, keep the original untouched (a quotation only
 *           gets its blank fields filled); anything new planned under it
 *           is attached to the original;
 *   update  a duplicate, replace the original's fields with the sheet's
 *           values (fields the sheet lacks are left as they were).
 */
import { transaction } from '../db.js';
import { resources, ONBOARDING_TEMPLATE } from '../lib/resources.js';
import { claimNextId } from '../lib/sequences.js';

const ORDER = ['quotation', 'project', 'purchase_order', 'service', 'stage', 'invoice', 'receipt'];

class ItemError extends Error {
  constructor(item, message) { super(message); this.item = item; }
}

function validate(resourceName, payload) {
  const parsed = resources[resourceName].schema.safeParse(payload);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid ${resourceName}: ${fields}`);
  }
  return parsed.data;
}

/** The sheet's non-blank values for the given columns, validated as a partial record. */
function changes(resourceName, payload, cols) {
  const subset = {};
  for (const c of cols) if (payload[c] !== null && payload[c] !== undefined && payload[c] !== '') subset[c] = payload[c];
  const parsed = resources[resourceName].schema.partial().safeParse(subset);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid ${resourceName}: ${fields}`);
  }
  // Only the sheet's own values: zod 4 fills .default() inside .partial(),
  // which would overwrite a stored PO's terms with 30 days.
  return Object.fromEntries(Object.entries(parsed.data).filter(([col]) => Object.hasOwn(subset, col)));
}

async function insert(client, table, values) {
  const cols = Object.keys(values).filter((k) => values[k] !== undefined);
  const params = cols.map((c) => values[c]);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    params
  );
  return rows[0];
}

async function update(client, table, values, whereSql, whereParams) {
  const cols = Object.keys(values);
  if (!cols.length) return 0;
  const params = cols.map((c) => values[c]);
  const { rowCount } = await client.query(
    `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE ${whereSql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + cols.length}`)}`,
    [...params, ...whereParams]
  );
  return rowCount;
}

export async function commitBatch(batch, items, { user }) {
  const included = items.filter((it) => it.included).sort((a, b) => ORDER.indexOf(a.step) - ORDER.indexOf(b.step) || a.seq - b.seq);
  const results = new Map(); // seq -> { ref, id, ... }
  const written = [];

  await transaction(async (client) => {
    for (const item of included) {
      const p = item.payload;
      const parent = item.parent_seq ? results.get(item.parent_seq) : null;
      const replacing = item.action === 'update';
      try {
        switch (item.step) {
          case 'quotation': {
            if (item.action === 'skip' || replacing) {
              const { rows } = await client.query('SELECT * FROM quotations WHERE quotation_no = $1', [item.existing_ref]);
              if (!rows.length) throw new Error(`existing quotation ${item.existing_ref} not found`);
              const q = rows[0];
              let n;
              if (replacing) {
                n = await update(client, 'quotations', changes('quotations', p, ['quotation_date', 'client_name', 'contact_person', 'service_quoted', 'sales_person', 'quotation_value', 'currency', 'status', 'po_received', 'remarks']), 'id = $1', [q.id]);
              } else {
                // Keep the original: fill blanks only.
                const fill = {};
                if (!q.contact_person && p.contact_person) fill.contact_person = p.contact_person;
                if (q.quotation_value === null && p.quotation_value !== null && p.quotation_value !== undefined) fill.quotation_value = p.quotation_value;
                n = await update(client, 'quotations', fill, 'id = $1', [q.id]);
              }
              results.set(item.seq, { id: q.id, ref: q.quotation_no, project_id: q.project_id, client_name: q.client_name, service: q.service_quoted, sales_person: q.sales_person });
              written.push({ seq: item.seq, ref: q.quotation_no, action: replacing ? 'replaced' : n ? 'kept, blanks filled' : 'kept' });
              break;
            }
            // The planned number may have been taken since the plan was made:
            // then take the next in the series, the way the Quotations page does.
            let no = p.quotation_no;
            if ((await client.query('SELECT 1 FROM quotations WHERE quotation_no = $1', [no])).rowCount) no = await claimNextId('quotation', client);
            const data = validate('quotations', { ...p, quotation_no: no, project_id: null });
            const q = await insert(client, 'quotations', data);
            results.set(item.seq, { id: q.id, ref: q.quotation_no, project_id: null, client_name: q.client_name, service: q.service_quoted, sales_person: q.sales_person });
            written.push({ seq: item.seq, ref: q.quotation_no, action: no === p.quotation_no ? 'created' : item.existing_ref ? `created as ${no} (imported as new, not ${item.existing_ref})` : `created as ${no} (planned number was taken)` });
            break;
          }

          case 'project': {
            if (!parent) throw new Error('project has no quotation');
            if ((item.action === 'skip' || replacing) && item.existing_ref) {
              const { rows } = await client.query('SELECT * FROM projects WHERE project_id = $1', [item.existing_ref]);
              if (!rows.length) throw new Error(`existing project ${item.existing_ref} not found`);
              if (replacing) await update(client, 'projects', changes('projects', p, ['primary_service']), 'project_id = $1', [item.existing_ref]);
              if (!parent.project_id) await client.query(`UPDATE quotations SET project_id = $1, po_received = true, status = 'Won - PO Received' WHERE id = $2`, [item.existing_ref, parent.id]);
              results.set(item.seq, { ref: item.existing_ref, project_id: item.existing_ref, quotation_no: parent.ref });
              written.push({ seq: item.seq, ref: item.existing_ref, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            let pid = p.project_id;
            if ((await client.query('SELECT 1 FROM projects WHERE project_id = $1', [pid])).rowCount) pid = await claimNextId('project', client);
            const data = validate('projects', {
              project_id: pid, client_name: parent.client_name || p.client_name, primary_service: p.primary_service || parent.service,
              sales_person: parent.sales_person || null, remarks: `Won from quotation ${parent.ref}`,
            });
            await insert(client, 'projects', data);
            await client.query(`UPDATE quotations SET project_id = $1, po_received = true, status = 'Won - PO Received' WHERE id = $2`, [pid, parent.id]);
            if (p.apply_onboarding_template) {
              for (const [i, [stage, text]] of ONBOARDING_TEMPLATE.entries()) {
                await client.query(`INSERT INTO onboarding_tasks (project_id, step_no, stage, step) VALUES ($1,$2,$3,$4)`, [pid, i + 1, stage, text]);
              }
            }
            results.set(item.seq, { ref: pid, project_id: pid, quotation_no: parent.ref });
            written.push({ seq: item.seq, ref: pid, action: pid === p.project_id ? 'created' : item.existing_ref ? `created as ${pid} (new, with its quotation; not ${item.existing_ref})` : `created as ${pid} (planned id was taken)` });
            break;
          }

          case 'purchase_order': {
            if (item.action === 'skip' || replacing) {
              const { rowCount } = await client.query('SELECT 1 FROM purchase_orders WHERE po_number = $1', [p.po_number]);
              if (!rowCount) throw new Error(`existing PO ${p.po_number} not found`);
              if (replacing) await update(client, 'purchase_orders', changes('purchase-orders', p, ['po_date', 'po_value', 'currency', 'payment_terms_days', 'actual_delivery_date', 'remarks']), 'po_number = $1', [p.po_number]);
              // An older PO with no quotation link gets one from the sheet's row.
              if (parent?.quotation_no) await client.query('UPDATE purchase_orders SET quotation_no = COALESCE(quotation_no, $1) WHERE po_number = $2', [parent.quotation_no, p.po_number]);
              results.set(item.seq, { ref: p.po_number, po_number: p.po_number });
              written.push({ seq: item.seq, ref: p.po_number, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            const projectId = parent?.project_id || p.project_id;
            // Name the won quotation this PO fulfils, so revenue counts it once.
            const data = validate('purchase-orders', { ...p, project_id: projectId, quotation_no: parent?.quotation_no || null });
            const po = await insert(client, 'purchase_orders', data);
            results.set(item.seq, { ref: po.po_number, po_number: po.po_number });
            written.push({ seq: item.seq, ref: po.po_number, action: 'created' });
            break;
          }

          case 'service': {
            const poNumber = parent?.po_number || p.po_number;
            if (item.action === 'skip' || replacing) {
              const { rows } = await client.query('SELECT id, service FROM po_services WHERE po_number = $1 ORDER BY id LIMIT 1', [poNumber]);
              if (!rows.length) throw new Error(`no service line on ${poNumber} to keep or replace`);
              if (replacing) await update(client, 'po_services', changes('po-services', p, ['service', 'service_value']), 'id = $1', [rows[0].id]);
              results.set(item.seq, { ref: `${poNumber} / ${replacing ? p.service : rows[0].service}` });
              written.push({ seq: item.seq, ref: replacing ? p.service : rows[0].service, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            const data = validate('po-services', { ...p, po_number: poNumber });
            await insert(client, 'po_services', data);
            results.set(item.seq, { ref: `${data.po_number} / ${data.service}` });
            written.push({ seq: item.seq, ref: data.service, action: 'created' });
            break;
          }

          case 'stage': {
            const poNumber = parent?.po_number || p.po_number;
            if (item.action === 'skip' || replacing) {
              const { rows } = await client.query('SELECT id FROM payment_stages WHERE po_number = $1 AND stage_no = $2', [poNumber, p.stage_no]);
              if (!rows.length) throw new Error(`stage ${p.stage_no} of ${poNumber} not found on the site`);
              if (replacing) await update(client, 'payment_stages', changes('payment-stages', p, ['stage_name', 'trigger_event', 'stage_percent']), 'id = $1', [rows[0].id]);
              results.set(item.seq, { ref: `${poNumber} stage ${p.stage_no}`, stage_id: rows[0].id });
              written.push({ seq: item.seq, ref: `${poNumber} stage ${p.stage_no}`, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            const data = validate('payment-stages', { ...p, po_number: poNumber });
            const s = await insert(client, 'payment_stages', data);
            results.set(item.seq, { ref: `${s.po_number} stage ${s.stage_no}`, stage_id: s.id });
            written.push({ seq: item.seq, ref: `${s.po_number} stage ${s.stage_no}`, action: 'created' });
            break;
          }

          case 'invoice': {
            if (!parent?.stage_id) throw new Error('invoice has no stage');
            if (item.action === 'skip') { results.set(item.seq, { ref: item.existing_ref }); written.push({ seq: item.seq, ref: item.existing_ref, action: 'kept' }); break; }
            if (!p.invoice_no || !p.invoice_date) throw new Error('invoice needs a number and a date');
            await client.query('UPDATE payment_stages SET invoice_no = $1, invoice_date = $2 WHERE id = $3', [String(p.invoice_no), p.invoice_date, parent.stage_id]);
            results.set(item.seq, { ref: p.invoice_no });
            written.push({ seq: item.seq, ref: p.invoice_no, action: replacing ? 'replaced' : 'recorded' });
            break;
          }

          case 'receipt': {
            if (!parent?.stage_id) throw new Error('receipt has no stage');
            if (item.action === 'skip') { results.set(item.seq, { ref: item.existing_ref }); written.push({ seq: item.seq, ref: item.existing_ref, action: 'kept' }); break; }
            const amt = Number(p.amount_received);
            if (!Number.isFinite(amt) || amt < 0) throw new Error('receipt amount must be a number');
            // A receipt row (#27); the stage total follows by trigger. Replacing removes what was there first.
            if (replacing) await client.query('DELETE FROM payments WHERE stage_id = $1', [parent.stage_id]);
            await client.query(
              `INSERT INTO payments (stage_id, amount, received_on, mode, notes, recorded_by) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), 'other', $4, $5)`,
              [parent.stage_id, amt, p.payment_received_date || null, `Imported from ${batch.filename}`, user]
            );
            results.set(item.seq, { ref: String(amt) });
            written.push({ seq: item.seq, ref: String(amt), action: replacing ? 'replaced' : 'recorded' });
            break;
          }

          default:
            throw new Error(`unknown step ${item.step}`);
        }
      } catch (err) {
        throw new ItemError(item, err.message);
      }
    }

    // Record what was written, inside the same transaction.
    for (const w of written) {
      await client.query('UPDATE import_items SET committed_ref = $1, error = NULL, updated_at = now() WHERE batch_id = $2 AND seq = $3', [`${w.action}: ${w.ref}`, batch.id, w.seq]);
    }
    await client.query(`UPDATE import_batches SET status = 'committed', committed_at = now(), error = NULL, uploaded_by = COALESCE(uploaded_by, $2) WHERE id = $1`, [batch.id, user]);
  }).catch(async (err) => {
    if (err instanceof ItemError) {
      // Outside the rolled-back transaction: note the failure on the batch.
      const { query } = await import('../db.js');
      await query('UPDATE import_items SET error = $1, updated_at = now() WHERE batch_id = $2 AND seq = $3', [err.message, batch.id, err.item.seq]);
      await query(`UPDATE import_batches SET status = 'draft', error = $2 WHERE id = $1`, [batch.id, `Stopped at ${err.item.step} (S.No ${err.item.source_row}): ${err.message}. Nothing was written.`]);
      const e = new Error(`Stopped at ${err.item.step} for S.No ${err.item.source_row}: ${err.message}. Nothing was written; fix the item and commit again.`);
      e.status = 422; e.item_seq = err.item.seq;
      throw e;
    }
    throw err;
  });

  return { written };
}
