/**
 * Who did what to the sales records (mis-report-sender-plan.md §B3.2).
 *
 * The tables say when a record was created and whose it is, but not who
 * typed it: owner_user_id is the owner, and a stage move, an invoice or a
 * changed PO value had no actor at all. A person's daily MIS reads their
 * Actions taken from here, so an act left unrecorded would read as nothing
 * done.
 *
 * Every helper takes the client of the transaction the change runs in, so
 * the row commits with the change or neither does (activity.js). They only
 * record acts by a signed-in user or the shared admin: a job or an email
 * reader is nobody in particular, and is not counted as anyone's work.
 */
import { ACTIONS, actorFrom, logActivity } from './activity.js';

/** The request's actor, or null when there is no signed-in user to name. */
function actorOf(user) {
  try {
    return actorFrom(user);
  } catch {
    return null;
  }
}

/** The name the tracker writes for a person, as tasks.created_by and notes.author do. */
export const actorName = (user) => user?.name || user?.username || null;

/**
 * Tell the database who is acting, for this transaction only. The triggers
 * that stamp tasks.completed_by and quotation_stage_history.changed_by_user_id
 * read it (migration 091). Local to the transaction, so a pooled connection
 * never carries one request's actor into the next.
 */
export async function actAs(client, user) {
  const actor = actorOf(user);
  if (!actor) return null;
  await client.query(
    `SELECT set_config('app.actor_user_id', $1, true), set_config('app.actor_name', $2, true)`,
    [actor.type === 'user' ? String(actor.userId) : '', actorName(user) ?? '']
  );
  return actor;
}

// Columns that are bookkeeping, not an act.
const SKIP = new Set(['id', 'created_at', 'updated_at']);
// What names a new record in a sentence: its number, its client, its value.
const SUMMARY = [
  'name', 'client_name', 'company_id', 'enquiry_no', 'quotation_no', 'project_id', 'po_number',
  'stage_no', 'stage_name', 'invoice_no', 'service', 'service_quoted', 'primary_service',
  'estimated_value', 'quotation_value', 'po_value', 'stage_percent', 'currency', 'status',
];
const MAX_TEXT = 200;

/** A value as the log keeps it: short text, a date as ISO, no nested objects. */
function plain(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (typeof value === 'object') return '(changed)';
  return value;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Which of `fields` differ between the two rows, as { field: { from, to } }. */
export function changesBetween(before, after, fields) {
  const out = {};
  for (const f of fields) {
    if (SKIP.has(f) || !(f in after)) continue;
    if (same(before?.[f], after[f])) continue;
    out[f] = { from: plain(before?.[f]), to: plain(after[f]) };
  }
  return out;
}

/** The id the rest of the tracker names a record by: its number when it has one. */
const refOf = (def, row) => String(def.naturalKey ? row[def.naturalKey] ?? row.id : row.id);

function summaryOf(row) {
  const out = {};
  for (const f of SUMMARY) if (row[f] !== null && row[f] !== undefined && row[f] !== '') out[f] = plain(row[f]);
  return out;
}

/** A record created through a form (crud POST) or a route that makes one. */
export async function logCreated(client, user, { entity, ref, row, extra = {} }) {
  const actor = actorOf(user);
  if (!actor) return null;
  return logActivity(client, {
    actor, action: ACTIONS.RECORD_CREATED, entityType: entity, entityId: ref,
    metadata: { ...summaryOf(row), ...extra },
  });
}

/**
 * A record changed. Only the fields that actually changed are kept, with
 * their old and new values; a save that changed nothing records nothing.
 */
export async function logUpdated(client, user, { entity, ref, changes, extra = {} }) {
  const actor = actorOf(user);
  if (!actor || (!Object.keys(changes).length && !extra.event)) return null;
  return logActivity(client, {
    actor, action: ACTIONS.RECORD_UPDATED, entityType: entity, entityId: ref,
    metadata: { ...extra, changes },
  });
}

/**
 * Every stage move this transaction made on these quotations, one row
 * each. The moves are read back from quotation_stage_history, which the
 * stage trigger writes whichever column caused the move (a stage picked, a
 * status set, a send or an acceptance). Rows of this transaction are the
 * ones stamped now(): Postgres' now() is the transaction's start time.
 */
export async function logStageMoves(client, user, quotationIds) {
  const actor = actorOf(user);
  const ids = quotationIds.filter((id) => id !== null && id !== undefined).map(Number);
  if (!actor || !ids.length) return [];
  const { rows } = await client.query(
    `SELECT h.quotation_id, q.quotation_no, q.client_name, f.name AS from_stage, t.name AS to_stage,
            t.type AS to_type, lr.name AS lost_reason, h.competitor
       FROM quotation_stage_history h
       JOIN quotations q ON q.id = h.quotation_id
       LEFT JOIN pipeline_stages f ON f.id = h.from_stage_id
       LEFT JOIN pipeline_stages t ON t.id = h.to_stage_id
       LEFT JOIN lost_reasons lr ON lr.id = h.lost_reason_id AND t.type = 'lost'
      WHERE h.quotation_id = ANY($1::int[]) AND h.changed_at = now()
      ORDER BY h.id`,
    [ids]
  );
  const logged = [];
  for (const m of rows) {
    logged.push(await logActivity(client, {
      actor, action: ACTIONS.QUOTATION_STAGE_CHANGED, entityType: 'quotation', entityId: m.quotation_no,
      metadata: {
        client_name: m.client_name, from: m.from_stage, to: m.to_stage,
        ...(m.to_type === 'lost' ? { lost_reason: m.lost_reason, competitor: m.competitor } : {}),
      },
    }));
  }
  return logged;
}

/** An invoice raised against a payment stage: its number, date and stage. */
export async function logInvoiceRaised(client, user, stage) {
  const actor = actorOf(user);
  if (!actor) return null;
  return logActivity(client, {
    actor, action: ACTIONS.INVOICE_RAISED, entityType: 'payment_stage', entityId: String(stage.id),
    metadata: {
      po_number: stage.po_number, stage_no: stage.stage_no, stage_name: stage.stage_name,
      invoice_no: stage.invoice_no, invoice_date: plain(stage.invoice_date),
    },
  });
}

/**
 * Money received against a payment stage. An adjustment is a correction
 * that brought the stage's total down (a negative ledger row), not money in.
 */
export async function logPaymentRecorded(client, user, { stage, amount, tds = 0, receivedOn = null, mode = null, paymentId = null, adjustment = false }) {
  const actor = actorOf(user);
  if (!actor) return null;
  return logActivity(client, {
    actor, action: ACTIONS.PAYMENT_RECORDED, entityType: 'payment_stage', entityId: String(stage.id),
    metadata: {
      po_number: stage.po_number, stage_no: stage.stage_no, invoice_no: stage.invoice_no,
      amount: Number(amount), tds_amount: Number(tds) || 0, received_on: plain(receivedOn), mode, payment_id: paymentId,
      ...(adjustment ? { adjustment: true } : {}),
    },
  });
}

/**
 * A PO registered against a quotation (registerPurchaseOrder): the PO, the
 * project when one was made for it, and the quotation's move to won. The
 * stages it built are part of the PO's row, not acts of their own.
 */
export async function logRegistration(client, user, r) {
  if (!actorOf(user)) return;
  if (r.project_created) {
    await logCreated(client, user, { entity: 'project', ref: r.project_id, row: { project_id: r.project_id, quotation_no: r.quotation_no } });
  }
  await logCreated(client, user, {
    entity: 'purchase_order', ref: r.po_number,
    row: { po_number: r.po_number, quotation_no: r.quotation_no, project_id: r.project_id, po_value: r.po_value, currency: r.currency },
    extra: { stages: (r.stages || []).map((st) => ({ stage_no: st.stage_no, stage_name: st.stage_name, stage_percent: st.stage_percent })) },
  });
  const { rows } = await client.query('SELECT id FROM quotations WHERE quotation_no = $1', [r.quotation_no]);
  await logStageMoves(client, user, rows.map((q) => q.id));
}

/**
 * The crud routes' share: one row for a record created or changed through
 * a form, for the resources that declare `audit` (resources.js). A quotation
 * whose stage moved gets its stage row instead of the stage fields; a
 * payment stage given its invoice gets invoice.raised for those fields.
 */
const STAGE_FIELDS = ['stage_id', 'status', 'probability', 'lost_reason_id', 'lost_notes', 'competitor'];
const INVOICE_FIELDS = ['invoice_no', 'invoice_date', 'document_id'];

export async function logCrudCreate(client, user, def, row) {
  if (!def.audit) return;
  await logCreated(client, user, { entity: def.audit, ref: refOf(def, row), row });
}

export async function logCrudUpdate(client, user, def, before, after, fields) {
  if (!def.audit) return;
  let changes = changesBetween(before, after, fields);
  if (def.audit === 'quotation') {
    const moves = await logStageMoves(client, user, [after.id]);
    if (moves.length) changes = omit(changes, STAGE_FIELDS);
  }
  if (def.audit === 'payment_stage' && !before?.invoice_no && after.invoice_no) {
    await logInvoiceRaised(client, user, after);
    changes = omit(changes, INVOICE_FIELDS);
  }
  await logUpdated(client, user, { entity: def.audit, ref: refOf(def, after), changes });
}

function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
