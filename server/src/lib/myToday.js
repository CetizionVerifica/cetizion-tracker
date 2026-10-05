/**
 * My Today (docs/my-today-plan.md): one person's own list for the day.
 *
 * Four kinds of work the tracker already records, each given a due date,
 * then sorted by one rule into Due today or Late:
 *
 *   task          an open task assigned to the person, or unassigned on a
 *                 record they own                              due: due_at
 *   follow_up     an open enquiry they own                     due: next_follow_up_at
 *   invoice       a stage of theirs ready to raise             due: the day it became ready
 *   payment       an invoice of theirs more than 7 days past
 *                 due, still owed, not on hold                 due: the payment rule below
 *
 * The rules are pure functions over rows, tested without a database, the
 * way planReminders() in reminders.js is. The loader below reads the rows
 * and applies them.
 *
 * "Theirs" is owner_user_id, the one ownership truth (auth/ownership.js).
 * The plan was written when ownership was still the free-text sales_person;
 * that rule now survives only for MCP, and a second name-matching answer to
 * "whose is this?" is exactly what the plan warns against. Only a task's
 * assignee is still a typed name, so that one comparison folds both sides
 * the same way the Inbox does (namedIn).
 */
import { config } from '../config.js';
import { OWNER_COLUMN, namedIn, parentClause } from '../auth/ownership.js';
import { businessToday, workingDaysBetween } from './businessDate.ts';

export const KINDS = ['task', 'follow_up', 'invoice', 'payment'];

/** The settings, their defaults, and what each means (schema.sql). */
export const DEFAULTS = Object.freeze({
  grace_working_days: 2,
  chase_after_days: 7,
  rechase_days: 7,
});

/** Anything later than this many calendar days is folded into one "older" row. */
export const OLDER_THAN_DAYS = 30;

/** Open enquiry stages: a follow-up on anything else is not work. */
export const OPEN_ENQUIRY_STATUSES = ['New', 'Contacted', 'Qualified', 'Nurture'];

const DAY_MS = 86_400_000;
const toDay = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / DAY_MS;
const iso = (d) => (d == null || d === '' ? null : String(d).slice(0, 10));

/** Calendar days from a to b; negative when b is earlier. */
export const daysBetween = (a, b) => Math.round(toDay(b) - toDay(a));

/** `date` plus n calendar days. */
export const addDays = (date, n) => new Date((toDay(date) + n) * DAY_MS).toISOString().slice(0, 10);

const later = (a, b) => (a && b ? (a > b ? a : b) : a || b);

/** Settings rows `{ key: value }` → the three numbers, defaulted when blank or nonsense. */
export function readSettings(raw = {}) {
  const num = (key, fallback) => {
    const n = Number(raw[`my_today_${key}`]);
    return raw[`my_today_${key}`] !== undefined && raw[`my_today_${key}`] !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    grace_working_days: num('grace_working_days', DEFAULTS.grace_working_days),
    chase_after_days: num('chase_after_days', DEFAULTS.chase_after_days),
    rechase_days: num('rechase_days', DEFAULTS.rechase_days),
  };
}

/**
 * The day a payment stage became ready to raise — the day its trigger fired.
 * The same rule the Invoice Run shows (billableSince in InvoiceRun.jsx), with
 * the one case it leaves blank filled: a Manual stage has no trigger date,
 * so it counts from the day the stage was entered.
 */
export function invoiceReadySince(stage) {
  if (stage.trigger_event === 'On PO Registration') return iso(stage.po_date) ?? iso(stage.created_on);
  if (stage.trigger_event === 'On Delivery') return iso(stage.delivery_date) ?? iso(stage.created_on);
  if (stage.trigger_event === 'On Milestone') return iso(stage.milestone_reached_on) ?? iso(stage.created_on);
  return iso(stage.created_on);
}

/**
 * The day a payment needs chasing, or null when it does not today.
 *
 * stage: { invoice_due_date, on_hold, promise_to_pay_date }
 * chase: the latest chase a person logged, { on, next_action_on }, or null.
 *        Rows the reminder job wrote are not chases (collection_log.automated)
 *        and must not be passed in: an email nobody sent cannot clear the item.
 *
 *  - on hold (in dispute): never.
 *  - not yet more than chase_after_days past due: not yet.
 *  - a promise to pay today or later: not until it passes.
 *  - otherwise the latest of these to happen decides:
 *      a promise that has passed       due the day after the promise
 *      a chase                         due on its next action date, or
 *                                      rechase_days after the chase
 *      neither                         due the first day it is more than
 *                                      chase_after_days past due
 *    A chase logged after a broken promise is the newer word, so it wins;
 *    a chase that only recorded the promise is older than it, so it does not.
 *
 * The answer is never earlier than that first day: an item cannot have been
 * on the list before it was eligible to be, so one chased early arrives
 * under Due today like any other rather than straight into Late.
 */
export function paymentDueOn(stage, chase, { today, chase_after_days = DEFAULTS.chase_after_days, rechase_days = DEFAULTS.rechase_days } = {}) {
  const due = iso(stage.invoice_due_date);
  if (!due || stage.on_hold) return null;
  if (daysBetween(due, today) <= chase_after_days) return null;
  const first = addDays(due, chase_after_days + 1);
  const promise = iso(stage.promise_to_pay_date);
  if (promise && promise >= today) return null;

  const chasedOn = iso(chase?.on);
  let rule = null;
  if (chasedOn && (!promise || chasedOn > promise)) {
    rule = iso(chase.next_action_on) ?? addDays(chasedOn, rechase_days);
  } else if (promise) {
    rule = addDays(promise, 1);
  }
  return later(rule, first);
}

/**
 * Due today, Late, or not shown.
 *
 *   due date after today            null
 *   0..grace working days late      'due_today' (1 or 2 days late carry a label)
 *   more than grace                 'late'
 *
 * Working days, so Friday's work is not late on Monday morning; weekends and
 * the holidays table are skipped.
 */
export function bucket(dueOn, today, holidays = [], grace = DEFAULTS.grace_working_days) {
  const due = iso(dueOn);
  if (!due || due > today) return null;
  const workingDaysLate = workingDaysBetween(due, today, holidays);
  return {
    section: workingDaysLate > grace ? 'late' : 'due_today',
    working_days_late: workingDaysLate,
    days_late: daysBetween(due, today),
  };
}

/** The label a row carries under Due today when it has slipped. */
export function lateLabel(workingDaysLate) {
  if (!workingDaysLate) return null;
  return `${workingDaysLate} day${workingDaysLate === 1 ? '' : 's'} late`;
}

/* ------------------------------------------------------------- the items */

const money = (v) => (v == null ? null : Number(v));

export function taskItem(t) {
  return {
    kind: 'task', entity: 'task', entity_id: String(t.id),
    title: t.title,
    client_name: t.client_name ?? null, company_id: t.company_id ?? null,
    due_on: iso(t.due_at), amount: null, currency: null,
    context: { record: t.entity, record_id: t.entity_id, type: t.type, priority: t.priority, assignee: t.assignee ?? null },
    link: '/tasks',
  };
}

export function followUpItem(e) {
  return {
    kind: 'follow_up', entity: 'enquiry', entity_id: e.enquiry_no,
    title: `Follow up ${e.client_name}`,
    client_name: e.client_name, company_id: e.company_id ?? null,
    due_on: iso(e.next_follow_up_at),
    amount: money(e.estimated_value), currency: e.estimated_value == null ? null : e.currency,
    context: { enquiry_id: e.id, enquiry_no: e.enquiry_no, status: e.status, service: e.service ?? null, contact_person: e.contact_person ?? null },
    link: `/enquiries?q=${encodeURIComponent(e.enquiry_no)}`,
  };
}

export function invoiceItem(s) {
  return {
    kind: 'invoice', entity: 'payment_stage', entity_id: String(s.id),
    title: `Raise ${s.stage_name} invoice — ${s.project_id}`,
    client_name: s.client_name, company_id: s.company_id ?? null,
    due_on: invoiceReadySince(s),
    amount: money(s.stage_amount), currency: s.currency,
    context: { po_number: s.po_number, project_id: s.project_id, stage_no: s.stage_no, stage_name: s.stage_name, trigger_event: s.trigger_event, terms_days: s.terms_days ?? null, document_id: s.document_id ?? null },
    link: '/money/invoice-run',
  };
}

export function paymentItem(s, chase, rules) {
  return {
    kind: 'payment', entity: 'payment_stage', entity_id: String(s.id),
    title: `Chase ${s.invoice_no} — ${s.stage_name}`,
    client_name: s.client_name, company_id: s.company_id ?? null,
    due_on: paymentDueOn(s, chase, rules),
    amount: money(s.due_now_amount), currency: s.currency,
    context: {
      invoice_no: s.invoice_no, po_number: s.po_number, stage_name: s.stage_name,
      invoice_due_date: iso(s.invoice_due_date),
      days_overdue: s.invoice_due_date ? Math.max(0, daysBetween(s.invoice_due_date, rules.today)) : null,
      last_chase: iso(chase?.on), promise_to_pay_date: iso(s.promise_to_pay_date),
    },
    link: s.company_id ? `/collections?company_id=${s.company_id}` : '/collections',
  };
}

/**
 * Items with due dates → the page: Late oldest first, Due today most late
 * first and then the largest amount, and the counts the sidebar shows.
 *
 * Anything more than OLDER_THAN_DAYS calendar days late is folded into one
 * `older` summary unless `unfold` is set, so a first day with years of
 * imported follow-ups behind it is still a page somebody can use. The counts
 * include them: they are still late, the page just does not list them.
 */
export function arrange(items, { today, holidays = [], grace = DEFAULTS.grace_working_days, unfold = false } = {}) {
  const late = []; const dueToday = []; const older = [];
  for (const item of items) {
    const b = bucket(item.due_on, today, holidays, grace);
    if (!b) continue;
    const placed = { ...item, ...b, late_label: b.section === 'due_today' ? lateLabel(b.working_days_late) : null };
    if (b.section === 'due_today') dueToday.push(placed);
    else if (!unfold && b.days_late > OLDER_THAN_DAYS) older.push(placed);
    else late.push(placed);
  }
  const amount = (x) => Number(x.amount) || 0;
  late.sort((a, b) => a.due_on.localeCompare(b.due_on) || amount(b) - amount(a));
  dueToday.sort((a, b) => b.working_days_late - a.working_days_late || amount(b) - amount(a));
  const byKind = Object.fromEntries(KINDS.map((k) => [k, older.filter((o) => o.kind === k).length]));
  return {
    counts: { late: late.length + older.length, due_today: dueToday.length },
    late,
    due_today: dueToday,
    older: older.length ? { count: older.length, by_kind: byKind, oldest_due_on: older.reduce((m, o) => (o.due_on < m ? o.due_on : m), older[0].due_on) } : null,
  };
}

/* ------------------------------------------------------------- the loader */

/**
 * The person whose day it is, for the queries: `{ id, name, email, role }`.
 *
 * `subject` is the scope that person works under. A sales user's tasks
 * assigned to them still have to sit on a record they may reach, the rule
 * /api/tasks lists by: an assignment is not a door into somebody else's deal.
 */
async function rowsFor(db, person, rules) {
  const subject = person.role === 'admin' ? { unrestricted: true, ownerId: null } : { unrestricted: false, ownerId: person.id };

  // Tasks. Assigned to the person by name or address (communications.js
  // writes the signed-in username, which is the email; people type names),
  // or unassigned and on a record they own. "Own" here excludes shared
  // master data: an unassigned task on a company is not everybody's.
  const tParams = [person.id];
  const owned = parentClause({ unrestricted: false, ownerId: person.id }, tParams, { kind: 'task_owned', alias: 't' });
  const reachable = parentClause(subject, tParams, { kind: 'task_entity', alias: 't' });
  const tasks = db.query(
    `SELECT t.id, t.entity, t.entity_id, t.title, t.due_at, t.type, t.priority, t.assignee
       FROM tasks t JOIN users me ON me.id = $1
      WHERE t.status <> 'done' AND t.due_at IS NOT NULL AND t.due_at <= $${tParams.push(rules.today)}::date
        AND ((NULLIF(btrim(t.assignee), '') IS NOT NULL AND ${namedIn('t.assignee', ['me.email', 'me.name'])}${reachable ? ` AND ${reachable}` : ''})
          OR (NULLIF(btrim(t.assignee), '') IS NULL AND ${owned}))`,
    tParams
  );

  const enquiries = db.query(
    `SELECT id, enquiry_no, client_name, company_id, status, service, contact_person,
            next_follow_up_at, estimated_value, currency
       FROM enquiries
      WHERE ${OWNER_COLUMN} = $1 AND status = ANY($2::text[])
        AND next_follow_up_at IS NOT NULL AND next_follow_up_at <= $3::date`,
    [person.id, OPEN_ENQUIRY_STATUSES, rules.today]
  );

  // A stage is the project's; one with no project owner falls back to the
  // quotation its purchase order fulfils. Direct ownership only, so a stage
  // is on one person's list, not on both of two people's.
  const stageOwner = `COALESCE(pr.${OWNER_COLUMN}, q.${OWNER_COLUMN}) = $1`;
  const stageFrom = `FROM v_payment_stages s
       JOIN payment_stages ps ON ps.id = s.id
       JOIN purchase_orders po ON po.po_number = s.po_number
       JOIN projects pr ON pr.project_id = s.project_id
       LEFT JOIN quotations q ON q.quotation_no = po.quotation_no`;

  // The stage's created_at is a moment; the day it was entered is the
  // business date of that moment, not the server's.
  const invoices = db.query(
    `SELECT s.id, s.po_number, s.project_id, s.client_name, pr.company_id, s.stage_no, s.stage_name,
            s.trigger_event, s.po_date, s.delivery_date, s.milestone_reached_on, s.stage_amount, s.currency, s.terms_days, s.document_id,
            (ps.created_at AT TIME ZONE $2)::date AS created_on
       ${stageFrom}
      WHERE ${stageOwner} AND s.stage_status = 'To Invoice'`,
    [person.id, config.businessTimeZone]
  );

  // Payments: invoiced, still owed and past due, compared against the
  // business date passed in — never the view's stage_status or days_overdue,
  // which count from the database's UTC CURRENT_DATE. A part-paid stage past
  // its due date is still one to chase.
  //
  // The latest chase a person logged: on the stage, or on the whole client
  // (Collections' client row), which covers every invoice of theirs — the
  // same reading lastActivity() in followUps.js takes.
  const payments = db.query(
    `SELECT s.id, s.po_number, s.project_id, s.client_name, pr.company_id, s.stage_name, s.invoice_no,
            s.invoice_due_date, s.on_hold, s.promise_to_pay_date, s.due_now_amount, s.currency,
            ch.on_date AS chased_on, ch.next_action_on
       ${stageFrom}
       LEFT JOIN LATERAL (
         SELECT (l.happened_at AT TIME ZONE $3)::date AS on_date, l.next_action_on
           FROM collection_log l
          WHERE NOT l.automated
            AND (l.stage_id = s.id OR (l.stage_id IS NULL AND l.company_id = pr.company_id))
          ORDER BY l.happened_at DESC, l.id DESC
          LIMIT 1
       ) ch ON true
      WHERE ${stageOwner} AND s.invoice_no IS NOT NULL AND s.due_now_amount > 0
        AND NOT s.on_hold AND s.invoice_due_date IS NOT NULL
        AND s.invoice_due_date < $2::date - $4::int`,
    [person.id, rules.today, config.businessTimeZone, rules.chase_after_days]
  );

  // A task names its record, not its client; the client's name is on the
  // record, looked up for the ones that are left.
  const [t, e, i, p] = await Promise.all([tasks, enquiries, invoices, payments]);
  return { tasks: await withClients(db, t.rows), enquiries: e.rows, invoices: i.rows, payments: p.rows };
}

/** Each task's client name and company, from the record it is filed against. */
async function withClients(db, tasks) {
  if (!tasks.length) return tasks;
  const { rows } = await db.query(
    `SELECT k.entity, k.entity_id,
            COALESCE(c.name, e.client_name, q.client_name, pr.client_name, popr.client_name, spr.client_name) AS client_name,
            COALESCE(c.id, ct.company_id, e.company_id, q.company_id, pr.company_id, popr.company_id, spr.company_id) AS company_id
       FROM unnest($1::text[], $2::text[]) AS k(entity, entity_id)
       LEFT JOIN contacts ct ON k.entity = 'contact' AND ct.id::text = k.entity_id
       LEFT JOIN companies c ON (k.entity = 'company' AND c.id::text = k.entity_id) OR (k.entity = 'contact' AND c.id = ct.company_id)
       LEFT JOIN enquiries e ON k.entity = 'enquiry' AND e.enquiry_no = k.entity_id
       LEFT JOIN quotations q ON k.entity = 'quotation' AND q.quotation_no = k.entity_id
       LEFT JOIN projects pr ON k.entity = 'project' AND pr.project_id = k.entity_id
       LEFT JOIN purchase_orders po ON k.entity = 'purchase_order' AND po.po_number = k.entity_id
       LEFT JOIN projects popr ON popr.project_id = po.project_id
       LEFT JOIN payment_stages ps ON k.entity = 'payment_stage' AND ps.id::text = k.entity_id
       LEFT JOIN purchase_orders spo ON spo.po_number = ps.po_number
       LEFT JOIN projects spr ON spr.project_id = spo.project_id`,
    [tasks.map((t) => t.entity), tasks.map((t) => t.entity_id)]
  );
  const byKey = new Map(rows.map((r) => [`${r.entity}:${r.entity_id}`, r]));
  return tasks.map((t) => ({ ...t, ...pick(byKey.get(`${t.entity}:${t.entity_id}`)) }));
}

const pick = (r) => (r ? { client_name: r.client_name, company_id: r.company_id } : {});

/** Holidays and the three settings, read once per request. */
export async function myTodayContext(db, today) {
  const [{ rows: hol }, { rows: settingRows }] = await Promise.all([
    db.query('SELECT holiday_on FROM holidays'),
    db.query(`SELECT key, value FROM settings WHERE key LIKE 'my\\_today\\_%'`),
  ]);
  return {
    today,
    holidays: hol.map((h) => iso(h.holiday_on)),
    settings: readSettings(Object.fromEntries(settingRows.map((r) => [r.key, r.value]))),
  };
}

/**
 * One person's day.
 *
 * `person` is a users row ({ id, name, email, role }). `now` is the moment
 * to work "today" out from, in business time; it is an argument so the
 * test at 00:30 IST can pass one in.
 */
export async function myToday(db, person, { now = new Date(), unfold = false } = {}) {
  const today = businessToday(now);
  const ctx = await myTodayContext(db, today);
  const rules = { today, ...ctx.settings };
  const rows = await rowsFor(db, person, rules);
  const items = [
    ...rows.tasks.map(taskItem),
    ...rows.enquiries.map(followUpItem),
    ...rows.invoices.map(invoiceItem),
    ...rows.payments.map((s) => paymentItem(s, s.chased_on ? { on: s.chased_on, next_action_on: s.next_action_on } : null, rules)),
  ];
  return {
    today,
    person: { id: person.id, name: person.name },
    rules: {
      grace_working_days: ctx.settings.grace_working_days,
      chase_after_days: ctx.settings.chase_after_days,
      rechase_days: ctx.settings.rechase_days,
      older_than_days: OLDER_THAN_DAYS,
    },
    ...arrange(items, { today, holidays: ctx.holidays, grace: ctx.settings.grace_working_days, unfold }),
  };
}
