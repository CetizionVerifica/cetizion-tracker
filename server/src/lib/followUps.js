/**
 * Follow-up reminders to owners, and escalation to management
 * (docs/follow-up-escalation-plan.md).
 *
 * The owner of an open enquiry, a sent quotation or an overdue invoice is
 * emailed when it needs a follow-up. If nobody logs any activity on it within
 * the grace period, management is emailed instead.
 *
 * The rules are pure functions over rows (tested without a database), in the
 * style of planReminders() in reminders.js; the runner reads the rows, applies
 * the plan, sends through lib/mail.js and writes follow_up_cycles.
 */
import pg from 'pg';
import { pool } from '../db.js';
import { authConfig } from '../auth/config.js';
import { addWorkingDays, businessToday, isWorkingDay, workingDaysBetween } from './businessDate.ts';
import { followUpEscalatedNotice, followUpEscalation, followUpReminder } from './emailTemplates.js';
import { sendMail } from './mail.js';
import { notify } from './notify.js';
import { emit } from './webhooks.js';
import { raiseAlert } from './ops/alerts.js';
import { UNRESTRICTED, scopedSources } from '../auth/ownership.js';
// Invoices read from past mail are not chased until a person has touched them (docs/email-po-plan.md §3.8).
import { UNTOUCHED_HISTORY_INVOICE } from './invoices.js';

export const OPEN_ENQUIRY_STATUSES = ['New', 'Contacted', 'Qualified', 'Nurture'];
export const OPEN_QUOTATION_STATUSES = ['Submitted', 'Under Negotiation'];

export const DEFAULTS = {
  followup_enquiry_idle_days: 3,
  followup_quotation_idle_days: 5,
  followup_invoice_overdue_days: 1,
  followup_invoice_idle_days: 5,
  followup_grace_days: 2,
  followup_reescalate_days: 5,
};

/**
 * Values below these fall back to the default. Re-escalating after 0 days
 * would make the "switched off and on again" sweep in planFollowUps match on
 * the very day escalation is due, so nothing would ever reach management.
 */
const MINIMUMS = { followup_reescalate_days: 1 };

/** An owner digest lists at most this many new items (pitfall 6). */
export const DIGEST_CAP = 50;

/**
 * The settings as numbers and switches. A blank, non-numeric or negative
 * number falls back to its default, so a typo in Settings can never make
 * everything due at once or nothing due ever.
 */
export function readSettings(raw = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const v = String(raw[key] ?? '').trim();
    const n = Number(v);
    out[key] = v !== '' && Number.isInteger(n) && n >= (MINIMUMS[key] ?? 0) ? n : fallback;
  }
  out.followup_enabled = String(raw.followup_enabled ?? '').trim().toLowerCase() === 'true';
  out.followup_cc_owner_on_escalation = String(raw.followup_cc_owner_on_escalation ?? 'true').trim().toLowerCase() !== 'false';
  out.followup_escalation_emails = splitAddresses(raw.followup_escalation_emails);
  return out;
}

/** Comma- or semicolon-separated addresses, trimmed, without blanks. */
export const splitAddresses = (v) => String(v ?? '').split(/[,;]/).map((a) => a.trim()).filter(Boolean);

/** Addresses de-duplicated without regard to case, first spelling kept. */
export function uniqueAddresses(list) {
  const seen = new Map();
  for (const a of list) if (a && !seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
  return [...seen.values()];
}

export const keyOf = (r) => `${r.entity}:${r.entity_id}`;

/**
 * Where a record opens in the app, the paths notify.js already uses. Encoded:
 * a quotation number like CTZ/QT/2026/005 is otherwise four path segments.
 */
export function recordLink(entity, id) {
  const enc = encodeURIComponent(String(id));
  if (entity === 'enquiry') return `/enquiries?q=${enc}`;
  if (entity === 'quotation') return `/quotations/${enc}`;
  return `/collections?stage=${enc}`;
}

/** A timestamp (Date or ISO) as the business date it happened on; a plain date as itself. */
export function dateOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : businessToday(d);
}

const ms = (v) => (v === null || v === undefined ? null : (v instanceof Date ? v : new Date(v)).getTime());
const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Why a record is no longer open, or null while it is (§4.1). A record that
 * is not open is never due, and any open cycle on it resolves with this reason.
 */
export function closedReason(rec, today) {
  if (!rec) return 'closed';
  if (rec.entity === 'enquiry') return OPEN_ENQUIRY_STATUSES.includes(rec.status) ? null : 'closed';
  if (rec.entity === 'quotation') {
    if (rec.status === 'On Hold') return 'on_hold';
    // Not sent from the tracker is still open: Submitted or Under
    // Negotiation says it went to the client (see quotationStart).
    if (!OPEN_QUOTATION_STATUSES.includes(rec.status) || rec.accepted_at || rec.closed_at) return 'closed';
    return null;
  }
  if (rec.entity === 'payment_stage') {
    if (rec.stage_status === 'Paid') return 'paid';
    if (rec.on_hold) return 'on_hold';
    if (rec.promise_to_pay_date && rec.promise_to_pay_date >= today) return 'promised';
    // To Invoice is finance's job, not the owner's (decision D3).
    if (!rec.invoice_no) return 'closed';
    if (!['Overdue', 'Partially Paid'].includes(rec.stage_status)) return 'closed';
    if (!rec.invoice_due_date || rec.invoice_due_date >= today) return 'closed';
    if (rec.amount !== undefined && rec.amount !== null && Number(rec.amount) <= 0) return 'paid';
    return null;
  }
  return 'closed';
}

/**
 * The follow-up dates a person has set on a record: an enquiry's own
 * next_follow_up_at, and the earliest open task with a due date on the record
 * (the "Next step … by" of Log a touch creates one). Earliest first.
 */
export const scheduledDates = (rec) => [rec.entity === 'enquiry' ? rec.next_follow_up_at : null, rec.next_task_due ?? null]
  .filter(Boolean).sort();

/**
 * Where a record's schedule stands today: `missed`, the earliest date that has
 * come with nothing logged on or after it; or `planned`, a date still ahead;
 * or neither, when nobody set one.
 */
export function scheduleState(rec, lastActivityOn, today) {
  const dates = scheduledDates(rec);
  const missed = dates.find((d) => d <= today && !(lastActivityOn && lastActivityOn >= d)) ?? null;
  return { missed, planned: !missed && dates.some((d) => d > today) };
}

/**
 * When an open record became due, or null if it is not due today (§4.1).
 * Returns { due_on, since_on, why } where since_on is the day the quiet
 * spell being counted began.
 *
 * lastActivityOn is the business date of the latest activity, or null.
 */
export function dueInfo(rec, lastActivityOn, { today, settings, holidays = [] }) {
  const s = settings;
  const idleFrom = (start, days, why) => {
    const since = later(start, lastActivityOn);
    if (!since) return null;
    const dueOn = addWorkingDays(since, days, holidays);
    return dueOn <= today ? { due_on: dueOn, since_on: since, why } : null;
  };
  // An invoice is never the owner's to chase before it is overdue enough.
  if (rec.entity === 'payment_stage' && Number(rec.days_overdue || 0) < s.followup_invoice_overdue_days) return null;
  const overdueOn = rec.entity === 'payment_stage' ? addDays(rec.invoice_due_date, s.followup_invoice_overdue_days) : null;

  // A date the owner set comes first: due on it if nothing was logged on or
  // after it, and left alone while it is still ahead.
  const { missed, planned } = scheduleState(rec, lastActivityOn, today);
  if (missed) {
    const why = missed === rec.next_task_due ? 'task' : 'follow_up_date';
    return { due_on: later(missed, overdueOn), since_on: missed, why };
  }
  if (planned) return null;

  // Nobody set a date, or every date was acted on: due once the record has
  // gone quiet for its idle limit.
  if (rec.entity === 'enquiry') return idleFrom(later(rec.enquiry_date, dateOf(rec.created_at)), s.followup_enquiry_idle_days, 'idle');
  if (rec.entity === 'quotation') return idleFrom(quotationStart(rec).on, s.followup_quotation_idle_days, 'idle');
  if (rec.entity === 'payment_stage') {
    const idle = idleFrom(rec.invoice_due_date, s.followup_invoice_idle_days, 'overdue');
    return idle ? { ...idle, due_on: later(idle.due_on, overdueOn) } : null;
  }
  return null;
}

/**
 * When a quotation went to the client, for the quiet-period count: the day it
 * was sent from the tracker, else its quotation date, else the day it was
 * entered. Imported and hand-typed quotations are never "sent" from the
 * tracker, and their status is the evidence that they went out.
 */
export function quotationStart(rec) {
  if (rec.sent_at) return { on: dateOf(rec.sent_at), basis: 'sent' };
  if (rec.quotation_date) return { on: rec.quotation_date, basis: 'dated' };
  return { on: dateOf(rec.created_at), basis: 'entered' };
}

/** The person a reminder can go to: an active user with an email, or null. */
export const effectiveOwner = (rec) => (rec?.owner_user_id && rec.owner_active !== false && rec.owner_email ? rec.owner_user_id : null);

const byOwnerThenKey = (a, b) => String(a.owner_name ?? '').localeCompare(String(b.owner_name ?? ''))
  || String(a.owner_user_id ?? '').localeCompare(String(b.owner_user_id ?? ''))
  || a.key.localeCompare(b.key);

/**
 * Decide today's transitions (§4.3).
 *
 *   records   candidate rows: every open enquiry, quotation and overdue
 *             stage, plus every record an open cycle points at
 *   open      follow_up_cycles rows with resolved_at IS NULL
 *   activity  Map `${entity}:${entity_id}` -> last activity (Date or ISO)
 *
 * Returns { remind, escalate, reescalate, unowned, resolve, skipped }:
 *   remind      [{ owner_user_id, owner_email, owner_name, items, waiting }]
 *   escalate    [{ cycle, item }]       grace passed, nothing logged
 *   reescalate  [{ cycle, item }]       escalated, still nothing, listed again
 *   unowned     [item]                  due, nobody to remind: straight to management
 *   resolve     [{ id, key, reason }]
 */
export function planFollowUps({ records = [], open = [], activity = new Map(), today, settings: raw = {}, holidays = [] }) {
  const settings = typeof raw.followup_enabled === 'boolean' ? raw : readSettings(raw);
  const plan = { today, remind: [], escalate: [], reescalate: [], unowned: [], resolve: [], skipped: [] };
  if (!isWorkingDay(today, holidays)) return { ...plan, skipped_reason: 'not a working day' };

  const grace = settings.followup_grace_days;
  const reesc = settings.followup_reescalate_days;
  const recordByKey = new Map(records.map((r) => [keyOf(r), r]));
  const cycleByKey = new Map(open.map((c) => [keyOf(c), c]));
  const lastAt = (key) => activity.get(key) ?? null;

  const itemOf = (rec, due) => {
    const key = keyOf(rec);
    const lastOn = dateOf(lastAt(key));
    const since = due?.since_on ?? lastOn;
    return {
      ...rec,
      key,
      owner_user_id: effectiveOwner(rec),
      record_owner_user_id: rec.owner_user_id ?? null,
      due_on: due?.due_on ?? null,
      why: due?.why ?? null,
      since_on: since,
      last_activity_on: lastOn,
      sent_on: rec.entity === 'quotation' ? quotationStart(rec).on : undefined,
      sent_basis: rec.entity === 'quotation' ? quotationStart(rec).basis : undefined,
      task_title: due?.why === 'task' ? rec.next_task_title ?? null : undefined,
      idle_days: since ? workingDaysBetween(since, today, holidays) : null,
    };
  };

  const remindByOwner = new Map();
  const ownerBucket = (item) => {
    if (!remindByOwner.has(item.owner_user_id)) {
      remindByOwner.set(item.owner_user_id, { owner_user_id: item.owner_user_id, owner_email: item.owner_email, owner_name: item.owner_name, items: [], waiting: [] });
    }
    return remindByOwner.get(item.owner_user_id);
  };

  const keys = [...new Set([...recordByKey.keys(), ...cycleByKey.keys()])].sort();
  for (const key of keys) {
    const rec = recordByKey.get(key) ?? null;
    let cycle = cycleByKey.get(key) ?? null;

    if (cycle) {
      const closed = closedReason(rec, today);
      if (closed) { plan.resolve.push({ id: cycle.id, key, reason: closed }); continue; }
      if ((cycle.reminded_user_id ?? null) !== effectiveOwner(rec)) {
        // Reassigned (or the owner left, or came back): the old owner's
        // cycle ends, and the record is judged afresh below for the new one.
        plan.resolve.push({ id: cycle.id, key, reason: 'reassigned' });
        cycle = null;
      }
    }

    if (cycle) {
      const ref = ms(cycle.reminded_at ?? cycle.escalated_at ?? cycle.created_at);
      const act = ms(lastAt(key));
      if (act !== null && ref !== null && act > ref) { plan.resolve.push({ id: cycle.id, key, reason: 'activity' }); continue; }
      if (scheduleState(rec, dateOf(lastAt(key)), today).planned) {
        // Moved to a later date (the enquiry's, or a task's) with no contact
        // logged (decision D2).
        plan.resolve.push({ id: cycle.id, key, reason: 'rescheduled' }); continue;
      }
      const since = dateOf(lastAt(key)) ?? cycle.due_on;
      const item = {
        ...itemOf(rec, { due_on: cycle.due_on, since_on: since, why: null }),
        cycle_id: cycle.id, reminded_at: cycle.reminded_at, reminded_on: dateOf(cycle.reminded_at), respond_by: cycle.respond_by,
        escalated_at: cycle.escalated_at, escalation_count: cycle.escalation_count,
      };
      if (!cycle.escalated_at) {
        // Switched off and on again: weeks-old reminders are not escalated in
        // one burst; the record starts a fresh cycle if it is still due.
        if (cycle.respond_by && today > addWorkingDays(cycle.respond_by, reesc, holidays)) {
          plan.resolve.push({ id: cycle.id, key, reason: 'disabled' });
          cycle = null;
        } else if (cycle.respond_by && today > cycle.respond_by) {
          plan.escalate.push({ cycle, item }); continue;
        } else {
          if (item.owner_user_id) ownerBucket(item).waiting.push(item);
          continue;
        }
      } else {
        const last = cycle.last_escalated_on ?? dateOf(cycle.escalated_at);
        if (workingDaysBetween(last, today, holidays) >= reesc) plan.reescalate.push({ cycle, item });
        continue;
      }
    }

    // No open cycle: is the record due today?
    if (!rec || closedReason(rec, today)) continue;
    const due = dueInfo(rec, dateOf(lastAt(key)), { today, settings, holidays });
    if (!due) continue;
    const item = itemOf(rec, due);
    if (item.owner_user_id) ownerBucket(item).items.push(item);
    else plan.unowned.push(item);
  }

  // Only owners with something new get a digest; one with only waiting
  // items already has yesterday's email.
  plan.remind = [...remindByOwner.values()].filter((g) => g.items.length)
    .sort((a, b) => byOwnerThenKey({ ...a, key: '' }, { ...b, key: '' }));
  for (const g of plan.remind) { g.items.sort(byOwnerThenKey); g.waiting.sort(byOwnerThenKey); }
  plan.escalate.sort((a, b) => byOwnerThenKey(a.item, b.item));
  plan.reescalate.sort((a, b) => byOwnerThenKey(a.item, b.item));
  plan.unowned.sort(byOwnerThenKey);
  plan.resolve.sort((a, b) => a.key.localeCompare(b.key));
  return plan;
}

// ----------------------------------------------------------------- database

/**
 * The latest activity per record (§4.2), for `entity:entity_id` keys.
 * Returns a Map key -> Date. Nothing is stored (design rule 1).
 *
 * Counts: touches (any outcome), human chases on a stage, outbound mail on a
 * thread linked to the record, notes, completed tasks, and a quotation's
 * stage changes and revisions. Not: rows a job wrote, or edits to the record.
 */
export async function lastActivity(db, keys) {
  const list = [...new Set(keys)];
  if (!list.length) return new Map();
  const { rows } = await db.query(
    `WITH k AS (
       SELECT split_part(x, ':', 1) AS entity, substr(x, length(split_part(x, ':', 1)) + 2) AS entity_id
         FROM unnest($1::text[]) AS x
     ),
     acts AS (
       SELECT c.entity, c.entity_id, c.started_at AS ts
         FROM communications c JOIN k ON k.entity = c.entity AND k.entity_id = c.entity_id
       UNION ALL
       SELECT 'payment_stage', l.stage_id::text, l.happened_at
         FROM collection_log l JOIN k ON k.entity = 'payment_stage' AND k.entity_id = l.stage_id::text
        WHERE NOT l.automated
       UNION ALL
       -- A chase logged against the whole client (Collections, client row)
       -- covers every invoice of that client.
       SELECT 'payment_stage', ps.id::text, l.happened_at
         FROM collection_log l
         JOIN projects pr ON pr.company_id = l.company_id
         JOIN purchase_orders po ON po.project_id = pr.project_id
         JOIN payment_stages ps ON ps.po_number = po.po_number
         JOIN k ON k.entity = 'payment_stage' AND k.entity_id = ps.id::text
        WHERE l.stage_id IS NULL AND NOT l.automated
       UNION ALL
       SELECT t.entity, t.entity_id, m.sent_at
         FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
         JOIN k ON k.entity = t.entity AND k.entity_id = t.entity_id
        WHERE m.direction = 'outbound'
       UNION ALL
       SELECT n.entity, n.entity_id, n.created_at
         FROM notes n JOIN k ON k.entity = n.entity AND k.entity_id = n.entity_id
       UNION ALL
       SELECT t.entity, t.entity_id, t.completed_at
         FROM tasks t JOIN k ON k.entity = t.entity AND k.entity_id = t.entity_id
        WHERE t.completed_at IS NOT NULL
       UNION ALL
       -- A task can stand on several records at once (task_targets).
       SELECT tt.entity, tt.entity_id, t.completed_at
         FROM task_targets tt JOIN tasks t ON t.id = tt.task_id
         JOIN k ON k.entity = tt.entity AND k.entity_id = tt.entity_id
        WHERE t.completed_at IS NOT NULL
       UNION ALL
       SELECT 'quotation', q.quotation_no, h.changed_at
         FROM quotation_stage_history h JOIN quotations q ON q.id = h.quotation_id
         JOIN k ON k.entity = 'quotation' AND k.entity_id = q.quotation_no
       UNION ALL
       SELECT 'quotation', q.quotation_no, r.created_at
         FROM quotation_revisions r JOIN quotations q ON q.id = r.quotation_id
         JOIN k ON k.entity = 'quotation' AND k.entity_id = q.quotation_no
     )
     SELECT entity || ':' || entity_id AS key, max(ts) AS last_activity_at FROM acts GROUP BY 1`,
    [list]
  );
  return new Map(rows.map((r) => [r.key, r.last_activity_at]));
}

const OWNER = `u.name AS owner_name, u.email AS owner_email, u.active AS owner_active`;

/**
 * The earliest open task with a due date on one record, as a LATERAL join
 * aliased `nt` (next_task_due, next_task_title). A task counts on its own
 * record and on every record in task_targets.
 */
const NEXT_TASK = (entity, idExpr) => `
  LEFT JOIN LATERAL (
    SELECT t.due_at AS next_task_due, t.title AS next_task_title
      FROM tasks t
     WHERE t.completed_at IS NULL AND t.due_at IS NOT NULL
       AND ((t.entity = '${entity}' AND t.entity_id = ${idExpr})
         OR EXISTS (SELECT 1 FROM task_targets tt WHERE tt.task_id = t.id AND tt.entity = '${entity}' AND tt.entity_id = ${idExpr}))
     ORDER BY t.due_at, t.id LIMIT 1
  ) nt ON true`;

/** The next follow-up task on one record, or null; for the record banner. */
export async function nextTask(db, entity, id) {
  const { rows: [row] } = await db.query(`SELECT nt.* FROM (SELECT $1::text AS id) r ${NEXT_TASK(entity, 'r.id')} WHERE nt.next_task_due IS NOT NULL`, [String(id)]);
  return row ? { due_at: row.next_task_due, title: row.next_task_title } : null;
}

/**
 * Every open record of the three kinds, plus the records named in `keys`
 * (those with an open cycle) whatever their state, so the plan can tell why
 * a cycle should close.
 *
 * `scope` narrows the rows to one owner's, the way every list is narrowed
 * (auth/ownership.js). The daily run passes nothing and sees everything;
 * Insights passes the reader's scope. `kinds` limits the read to the record
 * types asked for, so a caller wanting only quotations does not read every
 * open enquiry and invoice too.
 */
export async function loadRecords(db, keys = [], { scope = UNRESTRICTED, kinds = ['enquiry', 'quotation', 'payment_stage'] } = {}) {
  const none = Promise.resolve({ rows: [] });
  const wants = (kind) => kinds.includes(kind);
  const ids = (entity) => keys.filter((k) => k.startsWith(`${entity}:`)).map((k) => k.slice(entity.length + 1));
  const eParams = []; const eSrc = scopedSources(scope, eParams);
  const qParams = []; const qSrc = scopedSources(scope, qParams);
  const sParams = []; const sSrc = scopedSources(scope, sParams);
  const p = (params, v) => { params.push(v); return `$${params.length}`; };
  const [enquiries, quotations, stages] = await Promise.all([
    !wants('enquiry') ? none : db.query(
      `SELECT 'enquiry' AS entity, e.enquiry_no AS entity_id, e.enquiry_no AS number, e.status, e.next_follow_up_at,
              e.enquiry_date, e.created_at, e.client_name AS client, e.service AS detail,
              e.estimated_value AS amount, e.currency, e.company_id, e.owner_user_id,
              e.first_responded_at, e.expected_decision_date, e.quotation_no, ${OWNER}, nt.*
         FROM ${eSrc.enquiries} e LEFT JOIN users u ON u.id = e.owner_user_id ${NEXT_TASK('enquiry', 'e.enquiry_no')}
        WHERE e.status = ANY(${p(eParams, OPEN_ENQUIRY_STATUSES)}::text[]) OR e.enquiry_no = ANY(${p(eParams, ids('enquiry'))}::text[])`,
      eParams
    ),
    !wants('quotation') ? none : db.query(
      `SELECT 'quotation' AS entity, q.quotation_no AS entity_id, q.quotation_no AS number, q.status,
              q.sent_at, q.quotation_date, q.created_at, q.accepted_at, q.closed_at, q.client_name AS client, q.service_quoted AS detail,
              COALESCE(q.total, q.quotation_value) AS amount, q.currency, q.company_id, q.owner_user_id, ${OWNER}, nt.*
         FROM ${qSrc.quotations} q LEFT JOIN users u ON u.id = q.owner_user_id ${NEXT_TASK('quotation', 'q.quotation_no')}
        WHERE (q.status = ANY(${p(qParams, OPEN_QUOTATION_STATUSES)}::text[]) AND q.accepted_at IS NULL AND q.closed_at IS NULL)
           OR q.quotation_no = ANY(${p(qParams, ids('quotation'))}::text[])`,
      qParams
    ),
    !wants('payment_stage') ? none : db.query(
      `SELECT 'payment_stage' AS entity, ps.id::text AS entity_id, ps.invoice_no AS number, ps.stage_status,
              ps.invoice_no, ps.invoice_due_date, ps.days_overdue, ps.on_hold, ps.promise_to_pay_date,
              ps.client_name AS client, ps.po_number || ' · ' || ps.stage_name AS detail,
              ps.due_now_amount AS amount, ps.currency, pr.company_id, pr.owner_user_id, ${OWNER}, nt.*
         FROM ${sSrc.vPaymentStages} ps
         JOIN projects pr ON pr.project_id = ps.project_id
         LEFT JOIN users u ON u.id = pr.owner_user_id ${NEXT_TASK('payment_stage', 'ps.id::text')}
        WHERE (ps.stage_status IN ('Overdue', 'Partially Paid') AND NOT ${UNTOUCHED_HISTORY_INVOICE('ps')})
           OR ps.id::text = ANY(${p(sParams, ids('payment_stage'))}::text[])`,
      sParams
    ),
  ]);
  return [...enquiries.rows, ...quotations.rows, ...stages.rows].map((r) => ({ ...r, link: recordLink(r.entity, r.entity_id) }));
}

async function readAll(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key LIKE 'followup\\_%' OR key IN ('public_app_url', 'digest_email')`
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const LOCK = 'followups.daily';

/**
 * Today's follow-up run (§5.3). Returns a summary for job_runs.
 *
 * `send` is lib/mail.js in every real run; a test passes its own. `now` is
 * the moment written on the cycles, so a test can walk a calendar.
 */
export async function runFollowUps({
  db = pool, today = businessToday(), startedBy = 'schedule', send = sendMail, now = new Date(),
  authMode = authConfig.mode, alert = raiseAlert,
} = {}) {
  // A pool hands out a different connection per query; the lock must be held
  // and released on one.
  const conn = db instanceof pg.Pool ? await db.connect() : db;
  try {
    const raw = await readAll(conn);
    const settings = readSettings(raw);
    if (!settings.followup_enabled) return { today, skipped: 'followup_enabled is false' };
    const { rows: [lock] } = await conn.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [LOCK]);
    if (!lock?.locked) return { today, skipped: 'already running' };
    try {
      return await run(conn, { raw, settings, today, startedBy, send, now, authMode, alert });
    } finally {
      await conn.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK]);
    }
  } finally {
    if (conn !== db) conn.release();
  }
}

async function run(db, { raw, settings, today, startedBy, send, now, authMode, alert }) {
  const { rows: hol } = await db.query('SELECT holiday_on FROM holidays');
  const holidays = hol.map((h) => h.holiday_on);
  if (!isWorkingDay(today, holidays)) return { today, skipped: 'not a working day' };

  const { rows: open } = await db.query('SELECT * FROM follow_up_cycles WHERE resolved_at IS NULL');
  let records = await loadRecords(db, open.map(keyOf));
  // Shared sign-in has no people to remind: every due item goes to
  // management as unowned (§4.4).
  if (authMode === 'shared') records = records.map((r) => ({ ...r, owner_user_id: null }));
  const activity = await lastActivity(db, [...records.map(keyOf), ...open.map(keyOf)]);
  const plan = planFollowUps({ records, open, activity, today, settings, holidays });

  const appUrl = String(raw.public_app_url || '').replace(/\/+$/, '');
  const respondBy = addWorkingDays(today, settings.followup_grace_days, holidays);
  const summary = {
    today,
    records: countBy(records.filter((r) => !closedReason(r, today)), (r) => r.entity),
    reminded: [], not_reminded: [], escalated: 0, reescalated: 0, unowned: 0,
    resolved: {}, escalation: null, notices: [],
  };

  // 1. Resolve first, so a reassigned record can start a new cycle today.
  for (const r of plan.resolve) {
    await db.query(
      `UPDATE follow_up_cycles SET resolved_at = $2, resolved_reason = $3 WHERE id = $1 AND resolved_at IS NULL`,
      [r.id, now, r.reason]
    );
    summary.resolved[r.reason] = (summary.resolved[r.reason] || 0) + 1;
  }

  // 2. One reminder digest per owner. Only a mail that left starts the grace
  //    clock; anything else is retried on the next run, so nobody is
  //    escalated over a reminder they never got.
  for (const g of plan.remind) {
    // A long list is capped, and only what the owner was shown starts a grace
    // period; the rest are still due and lead the next reminder.
    const shown = g.items.slice(0, DIGEST_CAP);
    const more = g.items.length - shown.length;
    const email = followUpReminder({ ownerName: g.owner_name, today, items: shown, more, waiting: g.waiting, respondBy, appUrl, cap: DIGEST_CAP });
    const log = await send({ ...email, to: g.owner_email, template: 'follow_up_reminder', entity: 'user', entityId: g.owner_user_id, sentBy: startedBy }, db);
    const entry = { owner_user_id: g.owner_user_id, items: shown.map((i) => i.key), deferred: more, waiting: g.waiting.length, status: log.status, email_id: log.id ?? null };
    if (log.status === 'sent') {
      for (const i of shown) {
        await db.query(
          `INSERT INTO follow_up_cycles (entity, entity_id, due_on, reminded_user_id, owner_name, reminded_at, reminder_email_id, respond_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (entity, entity_id) WHERE resolved_at IS NULL DO NOTHING`,
          [i.entity, i.entity_id, i.due_on, i.owner_user_id, i.owner_name, now, log.id ?? null, respondBy]
        );
      }
      summary.reminded.push(entry);
    } else {
      summary.not_reminded.push({ ...entry, reason: log.reason ?? null });
    }
  }

  // 3. One escalation digest a day to management.
  if (plan.escalate.length || plan.reescalate.length || plan.unowned.length) {
    summary.escalation = await escalate(db, { plan, raw, settings, today, startedBy, send, now, authMode, alert, appUrl, summary });
  }

  summary.skipped = plan.skipped;
  return summary;
}

async function escalate(db, { plan, raw, settings, today, startedBy, send, now, authMode, alert, appUrl, summary }) {
  const { rows: admins } = authMode === 'shared'
    ? { rows: [] }
    : await db.query(`SELECT id, name, email FROM users WHERE role = 'admin' AND active AND email IS NOT NULL ORDER BY id`);
  let recipients = uniqueAddresses([...admins.map((a) => a.email), ...settings.followup_escalation_emails]);
  if (!recipients.length && authMode === 'shared') recipients = uniqueAddresses(splitAddresses(raw.digest_email));

  const escalated = plan.escalate.map((e) => e.item);
  const stillOpen = plan.reescalate.filter((e) => e.item.owner_user_id).map((e) => e.item);
  const unowned = [...plan.unowned, ...plan.reescalate.filter((e) => !e.item.owner_user_id).map((e) => e.item)];
  const counts = { escalated: escalated.length, still_open: stillOpen.length, unowned: unowned.length };

  if (!recipients.length) {
    // Escalating to nobody is a misconfiguration, not a quiet success:
    // nothing is marked, so it all goes out once someone can receive it.
    await alert('followups', 'Follow-up escalations have no recipient',
      `${escalated.length + stillOpen.length + unowned.length} follow-ups are waiting for management, but there is no active admin with an email and followup_escalation_emails is blank.`,
      { every: 'day' });
    return { ...counts, recipients: [], marked: false, reason: 'no recipients' };
  }

  const email = followUpEscalation({ today, escalated, stillOpen, unowned, appUrl });
  const sends = [];
  for (const to of recipients) {
    // One recipient's error must not stop the others, or leave a digest that
    // did go out unrecorded and sent again tomorrow.
    try {
      const log = await send({ ...email, to, template: 'follow_up_escalation', entity: 'digest', entityId: today, sentBy: startedBy }, db);
      sends.push({ to, status: log.status, email_id: log.id ?? null });
    } catch (err) {
      sends.push({ to, status: 'error', email_id: null, error: String(err?.message || err) });
    }
  }
  const first = sends.find((s) => s.status === 'sent');
  // One recipient is enough: management has been told. A failure to the
  // others stays visible in email_log.
  if (!first) return { ...counts, recipients: sends, marked: false, reason: 'no escalation email was sent' };

  const marked = [];
  for (const { cycle, item } of [...plan.escalate, ...plan.reescalate]) {
    await db.query(
      `UPDATE follow_up_cycles
          SET escalated_at = COALESCE(escalated_at, $2), last_escalated_on = $3,
              escalation_count = escalation_count + 1, escalation_email_id = $4
        WHERE id = $1 AND resolved_at IS NULL`,
      [cycle.id, now, today, first.email_id]
    );
    marked.push({ id: cycle.id, item, fresh: !cycle.escalated_at });
  }
  for (const i of plan.unowned) {
    const { rows: [row] } = await db.query(
      `INSERT INTO follow_up_cycles (entity, entity_id, due_on, reminded_user_id, owner_name, escalated_at, last_escalated_on, escalation_count, escalation_email_id)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,1,$7)
       ON CONFLICT (entity, entity_id) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
      [i.entity, i.entity_id, i.due_on, i.owner_name ?? null, now, today, first.email_id]
    );
    if (row) marked.push({ id: row.id, item: i, fresh: true });
  }
  summary.escalated = escalated.length;
  summary.reescalated = plan.reescalate.length;
  summary.unowned = plan.unowned.length;

  // The bell, for each admin (or everyone, in shared sign-in), and n8n.
  const audience = admins.length ? admins.map((a) => a.email) : [null];
  for (const { id, item, fresh } of marked) {
    for (const username of audience) {
      await notify({
        username, kind: 'follow_up_escalated',
        title: `Follow-up missed: ${item.number || item.entity_id}`,
        body: `${item.client || ''}${item.owner_name ? ` · ${item.owner_name}` : ' · no owner'}`,
        entity: item.entity, entityId: item.entity_id, link: '/follow-ups?tab=escalated',
        dedupeKey: `fu-esc:${id}:${today}${username ? `:${username.toLowerCase()}` : ''}`,
      }, db);
    }
    if (fresh) {
      await emit('follow_up.escalated', {
        // The company is what a sector-filtered endpoint matches on.
        entity: item.entity, entityId: item.entity_id, value: item.amount ?? null, companyId: item.company_id ?? null,
        data: { cycle_id: id, owner_user_id: item.owner_user_id ?? null, due_on: item.due_on, unowned: !item.owner_user_id },
      }, db);
    }
  }

  // Tell each owner, privately, which of their own items went up.
  if (settings.followup_cc_owner_on_escalation) {
    const byOwner = new Map();
    for (const i of escalated) {
      if (!byOwner.has(i.owner_user_id)) byOwner.set(i.owner_user_id, []);
      byOwner.get(i.owner_user_id).push(i);
    }
    for (const items of byOwner.values()) {
      const { owner_email: to, owner_name: ownerName, owner_user_id: ownerId } = items[0];
      const notice = followUpEscalatedNotice({ ownerName, items, appUrl });
      const log = await send({ ...notice, to, template: 'follow_up_escalated_notice', entity: 'user', entityId: ownerId, sentBy: startedBy }, db);
      summary.notices.push({ owner_user_id: ownerId, items: items.length, status: log.status });
    }
  }
  return { ...counts, recipients: sends, marked: true };
}

function countBy(list, fn) {
  const out = {};
  for (const x of list) out[fn(x)] = (out[fn(x)] || 0) + 1;
  return out;
}
