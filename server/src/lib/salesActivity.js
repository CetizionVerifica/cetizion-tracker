import { ACTIONS, logActivity } from './activity.js';

/**
 * The sales workflow, written to the activity log (#18 §3).
 *
 * §3 asks for the log to be "written by the save hooks and workflow routes
 * (create, update, status change, owner change, convert, invoice,
 * payment)". Phase 1.5 delivered the table and the admin events; ownership
 * added the owner-change events. This is the rest — the acts that move a
 * deal through the pipeline, which are the ones a salesperson's timeline is
 * actually made of.
 *
 * Written at the two shared writers in lib/crud.js rather than at each
 * route. There are a dozen routes that can save a quotation and one
 * insertRecord they all go through; an audit trail assembled route by route
 * is one that is missing wherever somebody added a route and forgot.
 *
 * What is deliberately NOT recorded:
 *
 *   every column        a diff of all 40-odd columns on a quotation buries
 *                       the status change that matters under a reformatted
 *                       phone number. MEANINGFUL below is the short list,
 *                       and adding to it is a decision.
 *   the values of money and free text
 *                       amounts and notes are recorded, because "who
 *                       dropped the price by 40%" is the question this is
 *                       for. Client contact details are not: the log is
 *                       retained indefinitely and is admin-readable, so it
 *                       should not quietly become a second copy of the
 *                       address book.
 *   no-op saves         a PATCH that changes nothing writes nothing. A
 *                       timeline of "Ramesh saved this" fifty times is
 *                       noise that hides the one save that mattered.
 */

/** The tables whose saves are worth recording, and how a row is named. */
export const AUDITED_TABLES = Object.freeze({
  enquiries: { entityType: 'enquiry', key: 'enquiry_no', statusColumn: 'status' },
  quotations: { entityType: 'quotation', key: 'quotation_no', statusColumn: 'status' },
  projects: { entityType: 'project', key: 'project_id', statusColumn: 'project_stage' },
});

export const isAudited = (table) => Object.hasOwn(AUDITED_TABLES, table);

/**
 * The columns a change to is worth a row in the log.
 *
 * Money, dates that drive a KPI, and the fields that decide who is
 * responsible. Not the client's contact details — see the header.
 */
const MEANINGFUL = Object.freeze({
  enquiries: ['status', 'estimated_value', 'currency', 'sector', 'service', 'enquiry_date'],
  quotations: [
    'status', 'quotation_value', 'currency', 'quotation_date', 'valid_until',
    'discount_percent', 'approval_status', 'probability', 'expected_close_date',
    'lost_reason_id', 'competitor',
  ],
  projects: ['project_stage', 'percent_complete', 'planned_delivery_date', 'payment_status'],
});

/** Only what actually differs, and only from the short list. */
function changedFields(table, before, after) {
  const out = {};
  for (const col of MEANINGFUL[table] ?? []) {
    if (!Object.hasOwn(after, col)) continue;
    const from = before?.[col] ?? null;
    const to = after[col] ?? null;
    // Dates arrive as Date objects and as strings depending on the path;
    // compare what they mean, not how pg happened to hand them over.
    const same = from instanceof Date || to instanceof Date
      ? String(from?.valueOf?.() ?? from) === String(to?.valueOf?.() ?? to)
      : String(from) === String(to);
    if (!same) out[col] = { from, to };
  }
  return out;
}

const nameOf = (spec, row) => row?.[spec.key] ?? (row?.id != null ? String(row.id) : null);

/**
 * One save, recorded.
 *
 * A status change and an edit are separate rows on purpose. "Moved to Won"
 * is the event a timeline, a KPI and a handover argument all care about,
 * and burying it inside a generic "updated" row with eight other fields
 * means every reader has to parse metadata to find it.
 *
 * Throws if the log cannot be written, like logActivity itself: this runs
 * inside the same transaction as the save, so a failed audit row rolls the
 * change back rather than letting it happen unrecorded.
 */
export async function logRecordSaved(client, { table, before, after, actor }) {
  const spec = AUDITED_TABLES[table];
  if (!spec || !actor || !after) return;

  const entityId = nameOf(spec, after);
  const base = { entityType: spec.entityType, entityId };

  if (!before) {
    await logActivity(client, {
      ...base,
      actor,
      action: ACTIONS[`${spec.entityType.toUpperCase()}_CREATED`],
      metadata: {
        status: after[spec.statusColumn] ?? null,
        owner_user_id: after.owner_user_id ?? null,
      },
    });
    return;
  }

  const changes = changedFields(table, before, after);
  const status = changes[spec.statusColumn];

  if (status) {
    await logActivity(client, {
      ...base,
      actor,
      action: ACTIONS[`${spec.entityType.toUpperCase()}_STATUS_CHANGED`],
      metadata: {
        from: status.from,
        to: status.to,
        // The derived date this transition just produced (064), so the
        // timeline and the KPI agree about when it happened without the
        // reader joining two tables to find out.
        won_at: after.won_at ?? undefined,
        lost_at: after.lost_at ?? undefined,
        decided_at: after.decided_at ?? undefined,
      },
    });
  }

  const rest = Object.fromEntries(Object.entries(changes).filter(([c]) => c !== spec.statusColumn));
  if (Object.keys(rest).length) {
    await logActivity(client, {
      ...base,
      actor,
      action: ACTIONS[`${spec.entityType.toUpperCase()}_UPDATED`],
      metadata: { changes: rest },
    });
  }
}

/**
 * The workflow acts that are not a column changing on one row.
 *
 * Converting a won quotation creates a project; invoicing and receipting a
 * payment stage move money. Each is recorded against the record a person
 * would look at to find it, which is not always the row that changed —
 * a receipt is filed under the payment stage, but a timeline reader is
 * looking at the project.
 */
export async function logWorkflowEvent(client, { actor, action, entityType, entityId, metadata = {} }) {
  if (!actor) return;
  await logActivity(client, { actor, action, entityType, entityId, metadata });
}
