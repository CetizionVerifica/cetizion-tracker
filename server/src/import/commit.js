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
import { IMPORT_AUTHOR } from './rules.js';
import { isAudited, logRecordSaved } from '../lib/salesActivity.js';

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

/**
 * The audit trail for a committed sheet (#18 §3).
 *
 * Hooked into these two writers rather than added at each of the ten call
 * sites below, for the same reason lib/crud.js logs at insertRecord and
 * updateRecordRow rather than at every route: a step added to commitBatch
 * later is audited without anybody remembering to audit it. Only the
 * ownership-scoped tables produce a row — see AUDITED_TABLES.
 *
 * The actor is the caller's credential, passed down from commitBatch. It is
 * never read from the sheet: `sales_person` is a column the sheet may
 * legitimately fill, and #18 keeps it precisely so historical attribution
 * survives, but it does not decide who the trail says acted.
 *
 * Nothing is caught. logRecordSaved throws if the log cannot be written,
 * and this runs on the batch's own client inside its transaction, so a
 * failed audit row rolls the whole commit back rather than leaving records
 * written with no record of who wrote them.
 */
async function insert(client, table, values, actor = null) {
  const cols = Object.keys(values).filter((k) => values[k] !== undefined);
  const params = cols.map((c) => values[c]);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    params
  );
  if (actor && isAudited(table)) {
    await logRecordSaved(client, { table, before: null, after: rows[0], actor });
  }
  return rows[0];
}

async function update(client, table, values, whereSql, whereParams, actor = null) {
  const cols = Object.keys(values);
  if (!cols.length) return 0;
  const params = cols.map((c) => values[c]);
  const where = whereSql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + cols.length}`);
  const audited = Boolean(actor) && isAudited(table);

  // Read first, so the log can say what each value changed from rather than
  // only that it changed — the gap #83's review called out on user emails.
  // The original whereSql is used here because its placeholders still match
  // whereParams; only the UPDATE below has to renumber them past the SET.
  const was = audited
    ? new Map((await client.query(`SELECT * FROM ${table} WHERE ${whereSql}`, whereParams)).rows.map((r) => [r.id, r]))
    : null;

  const { rows, rowCount } = await client.query(
    `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE ${where}${audited ? ' RETURNING *' : ''}`,
    [...params, ...whereParams]
  );

  if (audited) {
    for (const after of rows) {
      await logRecordSaved(client, { table, before: was.get(after.id) ?? null, after, actor });
    }
  }
  return rowCount;
}

/**
 * The sheet's history for one deal: its new remarks and follow-up comments
 * as timeline notes, the last follow-up as the last contact, the follow-up
 * comment as the next step, and the next follow-up as a reminder (moved,
 * not doubled, when a later sheet changes the date). Returns what it did.
 */
async function applyTracking(client, quotationNo, t) {
  if (!t) return [];
  const did = [];
  let notes = 0;
  for (const body of t.notes || []) {
    const seen = await client.query(`SELECT 1 FROM notes WHERE entity = 'quotation' AND entity_id = $1 AND body = $2`, [quotationNo, body]);
    if (seen.rowCount) continue;
    await client.query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ('quotation', $1, $2, $3)`, [quotationNo, body, IMPORT_AUTHOR]);
    notes += 1;
  }
  if (notes) did.push(`${notes} note${notes === 1 ? '' : 's'}`);
  if (t.last_contacted) {
    const { rowCount } = await client.query(
      // Midday, so the date reads the same in any time zone.
      `UPDATE quotations SET last_contacted_at = $2::date + interval '12 hours' WHERE quotation_no = $1 AND (last_contacted_at IS NULL OR last_contacted_at::date < $2::date)`,
      [quotationNo, t.last_contacted]);
    if (rowCount) did.push(`last contact ${t.last_contacted}`);
  }
  if (t.next_step) await client.query('UPDATE quotations SET next_step = $2 WHERE quotation_no = $1', [quotationNo, t.next_step]);
  const openTask = `entity = 'quotation' AND entity_id = $1 AND type = 'follow_up' AND created_by = '${IMPORT_AUTHOR}' AND status <> 'done'`;
  if (t.close_follow_up) {
    const { rowCount } = await client.query(`UPDATE tasks SET status = 'done', completed_at = now(), updated_at = now() WHERE ${openTask}`, [quotationNo]);
    if (rowCount) did.push('reminder closed');
  }
  if (t.follow_up) {
    const f = t.follow_up;
    const { rowCount } = await client.query(
      `UPDATE tasks SET due_at = $2, title = $3, description = $4, assignee = COALESCE($5, assignee), updated_at = now() WHERE ${openTask}`,
      [quotationNo, f.due, f.title, f.description, f.assignee]);
    if (!rowCount) {
      await client.query(
        `INSERT INTO tasks (entity, entity_id, title, description, due_at, type, assignee, created_by) VALUES ('quotation', $1, $2, $3, $4, 'follow_up', $5, $6)`,
        [quotationNo, f.title, f.description, f.due, f.assignee, IMPORT_AUTHOR]);
    }
    did.push(`reminder ${f.due}`);
  }
  return did;
}

export async function commitBatch(batch, items, { user, actor = null }) {
  const included = items.filter((it) => it.included).sort((a, b) => ORDER.indexOf(a.step) - ORDER.indexOf(b.step) || a.seq - b.seq);
  const results = new Map(); // seq -> { ref, id, ... }
  const written = [];

  await transaction(async (client) => {
    // The status was read before this transaction opened, so two commits
    // that overlap both passed that check — a double-click, or a client
    // retrying after a proxy gave up on a slow batch. Both then wrote:
    // every quotation created twice under different claimed numbers, and
    // the PO inserts either duplicated or tripped a unique constraint
    // half way through. The row lock is what makes the check mean
    // something, and it has to be the first statement inside.
    const { rows: [locked] } = await client.query('SELECT status FROM import_batches WHERE id = $1 FOR UPDATE', [batch.id]);
    if (!locked) throw new Error(`import batch ${batch.id} not found`);
    if (locked.status === 'committed') {
      const already = new Error('This batch is already committed');
      already.status = 422;
      throw already;
    }

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
                // Remarks someone wrote in the tracker itself are kept on the
                // timeline before the sheet's remarks take their place.
                const own = q.remarks && q.remarks !== p.remarks && q.remarks !== p.tracking?.prior_remarks;
                if (own) await client.query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ('quotation', $1, $2, $3)`, [q.quotation_no, `Remarks before this upload: ${q.remarks}`, IMPORT_AUTHOR]);
                // Only what the planner judged the sheet's to change.
                //
                // This wrote all ten columns whenever anything differed, so
                // one moved cell dragged nine untouched ones back to
                // whatever the sheet happened to hold. update_fields is the
                // three-way merge's verdict (rules.js, sheetChanges); the
                // four outside it are not compared field-by-field —
                // client_name identifies the row, remarks are archived to
                // the timeline just above, and po_received is derived.
                const always = ['client_name', 'po_received', 'remarks'];
                const cols = Array.isArray(p.__update_fields)
                  ? [...new Set([...p.__update_fields, ...always])]
                  : ['quotation_date', 'client_name', 'contact_person', 'service_quoted', 'sales_person', 'quotation_value', 'currency', 'status', 'po_received', 'remarks'];
                n = await update(client, 'quotations', changes('quotations', p, cols), 'id = $1', [q.id], actor);
              } else {
                // Keep the original: fill blanks only.
                const fill = {};
                if (!q.contact_person && p.contact_person) fill.contact_person = p.contact_person;
                if (q.quotation_value === null && p.quotation_value !== null && p.quotation_value !== undefined) fill.quotation_value = p.quotation_value;
                n = await update(client, 'quotations', fill, 'id = $1', [q.id], actor);
              }
              results.set(item.seq, { id: q.id, ref: q.quotation_no, project_id: q.project_id, client_name: q.client_name, service: q.service_quoted, sales_person: q.sales_person });
              const tracked = await applyTracking(client, q.quotation_no, p.tracking);
              written.push({ seq: item.seq, ref: q.quotation_no, action: [replacing ? 'updated' : n ? 'kept, blanks filled' : 'kept', ...tracked].join(', ') });
              break;
            }
            // The planned number may have been taken since the plan was made:
            // then take the next in the series, the way the Quotations page does.
            let no = p.quotation_no;
            if ((await client.query('SELECT 1 FROM quotations WHERE quotation_no = $1', [no])).rowCount) no = await claimNextId('quotation', client);
            const { tracking, ...record } = p;
            const data = validate('quotations', { ...record, quotation_no: no, project_id: null });
            const q = await insert(client, 'quotations', data, actor);
            results.set(item.seq, { id: q.id, ref: q.quotation_no, project_id: null, client_name: q.client_name, service: q.service_quoted, sales_person: q.sales_person });
            const tracked = await applyTracking(client, q.quotation_no, tracking);
            const how = no === p.quotation_no ? 'created' : item.existing_ref ? `created as ${no} (imported as new, not ${item.existing_ref})` : `created as ${no} (planned number was taken)`;
            written.push({ seq: item.seq, ref: q.quotation_no, action: [how, ...tracked].join(', ') });
            break;
          }

          case 'project': {
            if (!parent) throw new Error('project has no quotation');
            if ((item.action === 'skip' || replacing) && item.existing_ref) {
              const { rows } = await client.query('SELECT * FROM projects WHERE project_id = $1', [item.existing_ref]);
              if (!rows.length) throw new Error(`existing project ${item.existing_ref} not found`);
              if (replacing) await update(client, 'projects', changes('projects', p, ['primary_service']), 'project_id = $1', [item.existing_ref], actor);
              if (!parent.project_id) await update(client, 'quotations', { project_id: item.existing_ref, po_received: true, status: 'Won - PO Received' }, 'id = $1', [parent.id], actor);
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
            await insert(client, 'projects', data, actor);
            await update(client, 'quotations', { project_id: pid, po_received: true, status: 'Won - PO Received' }, 'id = $1', [parent.id], actor);
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
              if (replacing) await update(client, 'purchase_orders', changes('purchase-orders', p, ['po_date', 'po_value', 'currency', 'payment_terms_days', 'actual_delivery_date', 'remarks']), 'po_number = $1', [p.po_number], actor);
              // An older PO with no quotation link gets one from the sheet's row.
              if (parent?.quotation_no) await client.query('UPDATE purchase_orders SET quotation_no = COALESCE(quotation_no, $1) WHERE po_number = $2', [parent.quotation_no, p.po_number]);
              results.set(item.seq, { ref: p.po_number, po_number: p.po_number });
              written.push({ seq: item.seq, ref: p.po_number, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            const projectId = parent?.project_id || p.project_id;
            // Name the won quotation this PO fulfils, so revenue counts it once.
            const data = validate('purchase-orders', { ...p, project_id: projectId, quotation_no: parent?.quotation_no || null });
            const po = await insert(client, 'purchase_orders', data, actor);
            results.set(item.seq, { ref: po.po_number, po_number: po.po_number });
            written.push({ seq: item.seq, ref: po.po_number, action: 'created' });
            break;
          }

          case 'service': {
            const poNumber = parent?.po_number || p.po_number;
            if (item.action === 'skip' || replacing) {
              const { rows } = await client.query('SELECT id, service FROM po_services WHERE po_number = $1 ORDER BY id LIMIT 1', [poNumber]);
              if (!rows.length) throw new Error(`no service line on ${poNumber} to keep or replace`);
              if (replacing) await update(client, 'po_services', changes('po-services', p, ['service', 'service_value']), 'id = $1', [rows[0].id], actor);
              results.set(item.seq, { ref: `${poNumber} / ${replacing ? p.service : rows[0].service}` });
              written.push({ seq: item.seq, ref: replacing ? p.service : rows[0].service, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            const data = validate('po-services', { ...p, po_number: poNumber });
            await insert(client, 'po_services', data, actor);
            results.set(item.seq, { ref: `${data.po_number} / ${data.service}` });
            written.push({ seq: item.seq, ref: data.service, action: 'created' });
            break;
          }

          case 'stage': {
            const poNumber = parent?.po_number || p.po_number;
            if (item.action === 'skip' || replacing) {
              const { rows } = await client.query('SELECT id FROM payment_stages WHERE po_number = $1 AND stage_no = $2', [poNumber, p.stage_no]);
              if (!rows.length) throw new Error(`stage ${p.stage_no} of ${poNumber} not found on the site`);
              if (replacing) await update(client, 'payment_stages', changes('payment-stages', p, ['stage_name', 'trigger_event', 'stage_percent']), 'id = $1', [rows[0].id], actor);
              results.set(item.seq, { ref: `${poNumber} stage ${p.stage_no}`, stage_id: rows[0].id });
              written.push({ seq: item.seq, ref: `${poNumber} stage ${p.stage_no}`, action: replacing ? 'replaced' : 'kept' });
              break;
            }
            const data = validate('payment-stages', { ...p, po_number: poNumber });
            const s = await insert(client, 'payment_stages', data, actor);
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
