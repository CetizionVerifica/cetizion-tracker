/**
 * The Daily Sales Briefing and the Weekly Sales MIS, as figures
 * (docs/mis-reports-plan.md §3.1–§3.3).
 *
 * Both reports used to be made outside the tracker by reading raw email
 * again, so their numbers could disagree with the Reports page. Everything
 * here is read from the tracker's own records — the enquiries, quotations,
 * POs, invoices and payments the readers and people have entered — through
 * the same definitions those pages use (reportDefinitions.js, insights.js,
 * followUps.js). The AI (misAi.js, step 4) words what is computed here; it
 * cannot change a figure.
 *
 *   periodFor(kind, today)      yesterday, or the previous Monday to Sunday
 *   dailyBriefing({ today })    §3.1: at a glance, the three pending tables,
 *                               the top 5 actions, the readers' day
 *   weeklyMis({ today })        §3.2: the eight management questions
 *
 * Every amount is in INR at the rate on the record's own date (RATES /
 * rateOn, as the Reports page converts). An amount with no rate is listed
 * as not converted, never guessed. All queries are unrestricted: these are
 * management reports.
 *
 * The pure functions (periods, topActions, firstResponseTat, pendingRow)
 * take rows and return figures, so the rules are tested without a database.
 */
import { UNRESTRICTED } from '../auth/ownership.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { addressesIn, recipientLists } from './mail.js';
import { OPEN_ENQUIRY_STATUSES, OPEN_QUOTATION_STATUSES, keyOf, lastActivity, recordLink, dateOf } from './followUps.js';
import { insightsContext, loadConverter, overdueFollowUps, receivablesSection } from './insights.js';
import { pipelineCards, summarisePipeline } from './pipeline.js';
import { salesReport } from './reportDefinitions.js';
import { r2 } from './reportMath.ts';
import { RATES, inPeriod, poCountsAsSale, poQuotationNo, rateOn } from './salesReport.js';
import { QUOTATION_STATUS } from './statuses.js';
import { LIST_MAX_AGE_DAYS, shortDay } from './misBriefing.js';

export const KINDS = ['daily_briefing', 'weekly_mis'];

const DAY_MS = 86_400_000;
const toDay = (date) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const addDays = (date, n) => fromDay(toDay(date) + n);
/** Calendar days from `from` to `to`; negative when `to` is earlier. */
export const daysBetween = (from, to) => toDay(to) - toDay(from);

// ---------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------

/** Yesterday, as a one-day period. `today` is the IST business date. */
export const yesterdayOf = (today) => ({ from: addDays(today, -1), to: addDays(today, -1) });

/**
 * The previous Monday to Sunday. Run on Monday 5 October it covers 28
 * September to 4 October — the window the routine it replaces used. Run on
 * any other weekday it still covers the last whole week.
 */
export function previousWeekOf(today) {
  const day = toDay(today);
  const weekday = (((day + 4) % 7) + 7) % 7; // Sunday 0 … Saturday 6
  const thisMonday = day - ((weekday + 6) % 7);
  return { from: fromDay(thisMonday - 7), to: fromDay(thisMonday - 1) };
}

export function periodFor(kind, today = businessToday()) {
  if (kind === 'daily_briefing') return yesterdayOf(today);
  if (kind === 'weekly_mis') return previousWeekOf(today);
  throw new Error(`Unknown report kind: ${kind}`);
}

/** The first of the month a date is in, up to that date. */
export const monthToDate = (date) => ({ from: `${date.slice(0, 7)}-01`, to: date });

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

export const SETTING_KEYS = ['mis_daily_enabled', 'mis_weekly_enabled', 'mis_to', 'mis_cc', 'mis_sender_account_id', 'mis_overdue_days', 'public_app_url'];
const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };
// Only things that are addresses, each once whatever its case (#195): a
// setting cannot be saved blank, so "none" clears a list.
const addresses = (v) => addressesIn(v).filter((a) => a.includes('@'));
const recipientsOf = (to, cc) => { const l = recipientLists(addresses(to), addresses(cc)); return { to: l.to, cc: l.cc }; };

export async function misSettings(db = { query }) {
  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const on = (v) => String(v ?? 'false').trim().toLowerCase() === 'true';
  return {
    dailyEnabled: on(s.mis_daily_enabled),
    weeklyEnabled: on(s.mis_weekly_enabled),
    // Nobody is copied who is already a recipient (#195).
    ...recipientsOf(s.mis_to, s.mis_cc),
    senderAccountId: num(s.mis_sender_account_id, null),
    overdueDays: Math.max(1, Math.trunc(num(s.mis_overdue_days, 7))),
    appUrl: String(s.public_app_url || '').replace(/\/$/, ''),
  };
}

// ---------------------------------------------------------------------
// Pending rows (§3.1): one shape for the three tables
// ---------------------------------------------------------------------

/**
 * A row of a pending table. `days` is how long it has waited; `overdue`
 * when that passes the threshold. `score` ranks it for the top actions:
 * days × INR value, so an old small item and a young large one both
 * surface, and a row with no value still ranks by its age.
 */
export function pendingRow({ kind, key, client, reference, amount_inr: amountInr = null, currency = null, amount = null, since, days, owner = null, next_action: nextAction, link, record = null, mail = null }, overdueDays) {
  const waited = Math.max(0, Math.trunc(days ?? 0));
  return {
    kind, key, client: client || 'Unknown client', reference, amount_inr: amountInr == null ? null : r2(Number(amountInr)), currency, amount,
    since: since || null, days: waited, overdue: waited > overdueDays, owner: owner || null, next_action: nextAction, link, record,
    // Where the row's email is (§3 "Last activity" and "Email"): { entity, id } for a record's threads, or { thread_id }.
    mail, last_activity: null, email_link: null,
    score: waited * Math.max(Number(amountInr) || 0, 1),
  };
}

/**
 * The top actions for today, picked in code so the AI cannot pick others:
 * the pending rows by days overdue × value, at most one per client.
 */
export function topActions(rows, { limit = 5 } = {}) {
  const seen = new Set();
  const out = [];
  for (const row of [...rows].sort((a, b) => b.score - a.score || b.days - a.days || (a.client || '').localeCompare(b.client || ''))) {
    const client = (row.client || '').toLowerCase();
    if (seen.has(client)) continue;
    seen.add(client);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

const clientName = (row) => row.company_name || row.client_name || row.client || null;

/**
 * Invoices to raise, invoices due or overdue, and the invoice review queue.
 * Each stage is converted at the rate on its invoice date, or its PO date
 * while it has none.
 */
export async function pendingInvoices(db, { today, overdueDays }) {
  const { rows } = await db.query(
    `WITH ${RATES}
     SELECT ps.id, ps.po_number, ps.stage_name, ps.stage_status, ps.invoice_no, ps.invoice_date, ps.invoice_due_date,
            ps.currency, ps.stage_amount, ps.amount_received, ps.due_now_amount,
            ps.milestone_reached_on, ps.delivery_date, ps.po_date, ps.on_hold, ps.hold_reason, ps.promise_to_pay_date,
            ps.reminder_sent_on, ps.reminder_level, ps.payment_received_date,
            COALESCE(c.name, ps.client_name) AS client_name, COALESCE(u.name, NULLIF(btrim(pr.project_manager), '')) AS owner,
            r.rate
       FROM v_payment_stages ps
       JOIN projects pr ON pr.project_id = ps.project_id
       LEFT JOIN companies c ON c.id = pr.company_id
       LEFT JOIN users u ON u.id = pr.owner_user_id
       ${rateOn('r', 'ps.currency', 'COALESCE(ps.invoice_date, ps.po_date)')}
      WHERE ps.stage_status IN ('To Invoice', 'Due', 'Overdue', 'Partially Paid')
      ORDER BY ps.po_number, ps.stage_no`);
  const out = [];
  for (const s of rows) {
    const rate = s.rate == null ? null : Number(s.rate);
    if (s.stage_status === 'To Invoice') {
      // Counted from the day its trigger was reached: the milestone, the
      // delivery, or the PO itself.
      const since = dateOf(s.milestone_reached_on || s.delivery_date || s.po_date);
      out.push(pendingRow({
        kind: 'to_invoice', key: `stage:${s.id}`, client: clientName(s), reference: `${s.po_number} · ${s.stage_name}`,
        amount: Number(s.stage_amount), currency: s.currency, amount_inr: rate == null ? null : Number(s.stage_amount) * rate,
        since, days: since ? daysBetween(since, today) : 0, owner: s.owner,
        next_action: `Raise the ${s.stage_name} invoice`, link: `/payment-stages?status=To%20Invoice&q=${encodeURIComponent(s.po_number)}`,
        mail: { entity: 'purchase_order', id: s.po_number },
      }, overdueDays));
      continue;
    }
    const owed = Number(s.stage_amount) - Number(s.amount_received || 0);
    const due = dateOf(s.invoice_due_date);
    const late = due ? daysBetween(due, today) : 0;
    // The last chase or payment, as the receivables table shows it (docs/mis-briefing-fix-plan.md §3a).
    const chased = [
      s.reminder_sent_on ? `reminder ${s.reminder_level || 1} sent ${shortDay(dateOf(s.reminder_sent_on))}` : null,
      Number(s.amount_received) > 0 && s.payment_received_date ? `part paid ${shortDay(dateOf(s.payment_received_date))}` : null,
      s.promise_to_pay_date ? `promised for ${shortDay(dateOf(s.promise_to_pay_date))}` : null,
      s.on_hold ? `on hold${s.hold_reason ? `: ${s.hold_reason}` : ''}` : null,
    ].filter(Boolean);
    const row = pendingRow({
      kind: 'invoice_due', key: `stage:${s.id}`, client: clientName(s), reference: `Invoice ${s.invoice_no || '—'} · ${s.po_number}`,
      amount: owed, currency: s.currency, amount_inr: rate == null ? null : owed * rate,
      since: due, days: late, owner: s.owner,
      next_action: `${late > 0 ? `Chase payment, ${late} day${late === 1 ? '' : 's'} overdue` : `Due ${due ? `on ${due}` : 'soon'}`}${chased.length ? `; ${chased.join('; ')}` : ''}`,
      link: recordLink('payment_stage', s.id), mail: { entity: 'purchase_order', id: s.po_number },
    }, overdueDays);
    // Days since the invoice date, as Finance ages a debt; `days` stays the days past due, which marks Overdue.
    row.age = s.invoice_date ? daysBetween(dateOf(s.invoice_date), today) : null;
    out.push(row);
  }
  const { rows: review } = await db.query(
    `SELECT d.id, d.sent_at, d.to_emails, d.invoice_no, d.po_number, d.review_reason, d.thread_id, a.email AS mailbox
       FROM email_invoice_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'review' ORDER BY d.sent_at`);
  for (const d of review) {
    const since = dateOf(d.sent_at);
    out.push(pendingRow({
      kind: 'invoice_review', key: `invoice-review:${d.id}`, client: d.to_emails?.[0] || d.mailbox, reference: `Invoice ${d.invoice_no || '(unread)'}${d.po_number ? ` · ${d.po_number}` : ''}`,
      since, days: since ? daysBetween(since, today) : 0,
      next_action: 'Check the invoice read from email', link: '/payment-stages?tab=invoice-review', mail: d.thread_id ? { thread_id: d.thread_id } : null,
    }, overdueDays));
  }
  return out;
}

/**
 * The last open stage before Won — "Verbal yes, awaiting PO" — the way
 * Insights finds it: the open stages in order, the last of them.
 */
async function awaitingPoStage(db) {
  const { rows } = await db.query(`SELECT id, name FROM pipeline_stages WHERE active AND type = 'open' AND maps_to_status <> 'Draft' ORDER BY sort_order`);
  return rows.at(-1) ?? null;
}

/**
 * Quotations the client has said yes to but sent no PO for, quotations
 * marked Won with no PO registered, and the PO review queue.
 */
export async function pendingPos(db, { today, overdueDays }) {
  const stage = await awaitingPoStage(db);
  const { rows } = await db.query(
    `WITH ${RATES}
     SELECT q.quotation_no, q.client_name, q.status, q.stage_id, q.stage_changed_at, q.accepted_at, q.closed_at, q.quotation_date,
            COALESCE(q.total, q.quotation_value) AS amount, q.currency, q.expected_close_date, q.next_step, COALESCE(u.name, NULLIF(btrim(q.sales_person), '')) AS owner, r.rate,
            EXISTS (SELECT 1 FROM purchase_orders po WHERE ${poQuotationNo('po')} = q.quotation_no AND ${poCountsAsSale('po')}) AS has_po
       FROM quotations q
       LEFT JOIN users u ON u.id = q.owner_user_id
       ${rateOn('r', 'q.currency', 'q.quotation_date')}
      WHERE (q.stage_id = $1 AND q.status <> '${QUOTATION_STATUS.lost}') OR q.status = '${QUOTATION_STATUS.won}'
      ORDER BY q.quotation_no`, [stage?.id ?? null]);
  const out = [];
  for (const q of rows) {
    if (q.has_po) continue;
    const rate = q.rate == null ? null : Number(q.rate);
    const won = q.status === QUOTATION_STATUS.won;
    const since = dateOf((won ? (q.accepted_at || q.closed_at) : null) || q.stage_changed_at || q.quotation_date);
    out.push(pendingRow({
      kind: won ? 'won_without_po' : 'awaiting_po', key: `quotation:${q.quotation_no}`, client: q.client_name, reference: q.quotation_no,
      amount: q.amount == null ? null : Number(q.amount), currency: q.currency, amount_inr: rate == null || q.amount == null ? null : Number(q.amount) * rate,
      since, days: since ? daysBetween(since, today) : 0, owner: q.owner,
      next_action: won ? 'Register the PO the client sent' : (q.next_step || 'Ask the client for the PO'),
      link: recordLink('quotation', q.quotation_no), mail: { entity: 'quotation', id: q.quotation_no },
    }, overdueDays));
  }
  const { rows: review } = await db.query(
    `SELECT d.id, d.received_at, d.from_email, d.review_reason, d.suggested_quotations, d.thread_id, a.email AS mailbox,
            (SELECT c.name FROM companies c JOIN contacts ct ON ct.company_id = c.id WHERE lower(ct.email) = lower(d.from_email) LIMIT 1) AS company_name
       FROM email_po_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'review' ORDER BY d.received_at`);
  for (const d of review) {
    const since = dateOf(d.received_at);
    out.push(pendingRow({
      kind: 'po_review', key: `po-review:${d.id}`, client: d.company_name || d.from_email || d.mailbox, reference: `PO received by email${d.suggested_quotations?.length ? ` (${d.suggested_quotations.join(', ')}?)` : ''}`,
      since, days: since ? daysBetween(since, today) : 0,
      next_action: 'PO received, not registered: check it', link: '/purchase-orders?tab=review', mail: d.thread_id ? { thread_id: d.thread_id } : null,
    }, overdueDays));
  }
  return out;
}

/**
 * Open enquiries with no quotation, and sent quotations the client has not
 * answered — days since the enquiry, or since we last did anything on the
 * quotation (followUps.js lastActivity).
 */
export async function pendingQuotations(db, { today, overdueDays }) {
  // A quotation the client has said yes to is waiting for its PO, not for
  // an answer: it is in pendingPos, so it is left out here.
  const awaiting = await awaitingPoStage(db);
  const [{ rows: enquiries }, { rows: quotations }] = await Promise.all([
    db.query(
      `WITH ${RATES}
       SELECT e.enquiry_no, e.client_name, e.status, e.service, e.estimated_value, e.currency, e.next_follow_up_at, COALESCE(u.name, NULLIF(btrim(e.sales_person), '')) AS owner, r.rate,
              COALESCE(e.enquiry_date, (e.created_at AT TIME ZONE $2)::date) AS since
         FROM enquiries e LEFT JOIN users u ON u.id = e.owner_user_id
         ${rateOn('r', 'e.currency', 'e.enquiry_date')}
        WHERE e.status = ANY($1::text[]) AND e.quotation_no IS NULL
        ORDER BY since, e.enquiry_no`, [OPEN_ENQUIRY_STATUSES, config.businessTimeZone]),
    db.query(
      `WITH ${RATES}
       SELECT q.quotation_no, q.client_name, q.status, q.sent_at, q.quotation_date, q.next_step,
              COALESCE(q.total, q.quotation_value) AS amount, q.currency, COALESCE(u.name, NULLIF(btrim(q.sales_person), '')) AS owner, r.rate
         FROM quotations q LEFT JOIN users u ON u.id = q.owner_user_id
         ${rateOn('r', 'q.currency', 'q.quotation_date')}
        WHERE q.status = ANY($1::text[]) AND q.accepted_at IS NULL AND q.closed_at IS NULL AND q.stage_id IS DISTINCT FROM $2
        ORDER BY q.quotation_no`, [OPEN_QUOTATION_STATUSES, awaiting?.id ?? null]),
  ]);
  const out = [];
  for (const e of enquiries) {
    const since = dateOf(e.since);
    const rate = e.rate == null ? null : Number(e.rate);
    out.push(pendingRow({
      kind: 'enquiry_unquoted', key: `enquiry:${e.enquiry_no}`, client: e.client_name, reference: `${e.enquiry_no}${e.service ? ` · ${e.service}` : ''}`,
      amount: e.estimated_value == null ? null : Number(e.estimated_value), currency: e.currency,
      amount_inr: rate == null || e.estimated_value == null ? null : Number(e.estimated_value) * rate,
      since, days: since ? daysBetween(since, today) : 0, owner: e.owner,
      next_action: 'Send the quotation', link: recordLink('enquiry', e.enquiry_no), mail: { entity: 'enquiry', id: e.enquiry_no },
    }, overdueDays));
  }
  const activity = await lastActivity(db, quotations.map((q) => keyOf({ entity: 'quotation', entity_id: q.quotation_no })));
  for (const q of quotations) {
    const sent = dateOf(q.sent_at || q.quotation_date);
    const last = dateOf(activity.get(`quotation:${q.quotation_no}`) ?? null);
    const since = last && sent && last > sent ? last : sent;
    const rate = q.rate == null ? null : Number(q.rate);
    out.push(pendingRow({
      kind: 'quotation_open', key: `quotation:${q.quotation_no}`, client: q.client_name, reference: `${q.quotation_no} · ${q.status}`,
      amount: q.amount == null ? null : Number(q.amount), currency: q.currency, amount_inr: rate == null || q.amount == null ? null : Number(q.amount) * rate,
      since, days: since ? daysBetween(since, today) : 0, owner: q.owner,
      next_action: q.next_step || 'Follow up with the client', link: recordLink('quotation', q.quotation_no), mail: { entity: 'quotation', id: q.quotation_no },
    }, overdueDays));
  }
  return out;
}

// ---------------------------------------------------------------------
// Daily briefing (§3.1)
// ---------------------------------------------------------------------

const ENQUIRY_DAY = (alias, tzParam) => `COALESCE(${alias}.enquiry_date, (${alias}.created_at AT TIME ZONE ${tzParam})::date)`;

/** Yesterday's counts, each the figure the matching page shows. */
async function atAGlance(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows: [r] } = await db.query(
    `WITH ${RATES}
     SELECT
       (SELECT count(*) FROM enquiries e WHERE ${ENQUIRY_DAY('e', '$3')} BETWEEN $1 AND $2
          -- An enquiry the email reader made from mail it did not call a new enquiry is not one (docs/mis-briefing-fix-plan.md §2).
          AND NOT EXISTS (SELECT 1 FROM email_enquiry_decisions d WHERE d.enquiry_no = e.enquiry_no AND d.outcome = 'created' AND d.kind <> 'new_enquiry'))::int AS new_enquiries,
       (SELECT count(DISTINCT no) FROM (
          SELECT q.quotation_no AS no FROM quotations q WHERE (q.sent_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
          UNION
          SELECT d.quotation_no FROM email_enquiry_decisions d
           WHERE d.kind = 'quotation_sent' AND d.quotation_no IS NOT NULL AND d.outcome IN ('created','linked')
             AND (d.received_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
        ) x)::int AS quotations_sent,
       (SELECT count(*) FROM purchase_orders po WHERE po.po_date BETWEEN $1 AND $2 AND ${poCountsAsSale('po')})::int AS pos_received,
       (SELECT COALESCE(sum(po.po_value * r.rate), 0) FROM purchase_orders po ${rateOn('r', 'po.currency', 'po.po_date')}
         WHERE po.po_date BETWEEN $1 AND $2 AND ${poCountsAsSale('po')})::float8 AS pos_received_inr,
       (SELECT count(*) FROM purchase_orders po WHERE (po.created_at AT TIME ZONE $3)::date BETWEEN $1 AND $2 AND po.po_date < $1 AND ${poCountsAsSale('po')})::int AS pos_registered_late,
       (SELECT count(*) FROM payment_stages ps WHERE ps.invoice_date BETWEEN $1 AND $2)::int AS invoices_raised,
       (SELECT COALESCE(sum(s.invoiced_amount * r.rate), 0) FROM v_payment_stages s ${rateOn('r', 's.currency', 's.invoice_date')}
         WHERE s.invoice_date BETWEEN $1 AND $2)::float8 AS invoices_raised_inr,
       (SELECT count(*) FROM payments p WHERE p.received_on BETWEEN $1 AND $2)::int AS payments_received,
       (SELECT COALESCE(sum(p.amount * r.rate), 0) FROM payments p JOIN v_payment_stages s ON s.id = p.stage_id
          ${rateOn('r', 's.currency', 'p.received_on')} WHERE p.received_on BETWEEN $1 AND $2)::float8 AS payments_received_inr`,
    [from, to, tz]);
  return {
    new_enquiries: r.new_enquiries,
    quotations_sent: r.quotations_sent,
    pos_received: r.pos_received,
    pos_received_inr: r2(r.pos_received_inr),
    pos_registered_late: r.pos_registered_late,
    invoices_raised: r.invoices_raised,
    invoices_raised_inr: r2(r.invoices_raised_inr),
    payments_received: r.payments_received,
    payments_received_inr: r2(r.payments_received_inr),
  };
}

/** What the email readers did in the period: records made or linked, items sent to review. */
async function readersDay(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows: [r] } = await db.query(
    `SELECT
       (SELECT count(*) FROM email_enquiry_decisions WHERE outcome = 'created' AND (decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS enquiries_created,
       (SELECT count(*) FROM email_enquiry_decisions WHERE quotation_extraction IN ('created','revised') AND (decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS quotations_read,
       (SELECT count(*) FROM email_po_decisions WHERE outcome IN ('registered','registered_by_hand') AND (decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS pos_registered,
       (SELECT count(*) FROM email_po_decisions WHERE outcome = 'review' AND (decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS pos_to_review,
       (SELECT count(*) FROM email_invoice_decisions WHERE outcome IN ('recorded','recorded_by_hand') AND (decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS invoices_recorded,
       (SELECT count(*) FROM email_invoice_decisions WHERE outcome = 'review' AND (decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS invoices_to_review`,
    [from, to, tz]);
  return r;
}

/**
 * The records the readers made or changed in the period, with the thread
 * each came from: the raw material of the highlights (§3.4), and the
 * highlights themselves when there is no AI.
 */
export async function readerEvents(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows } = await db.query(
    `SELECT 'enquiry' AS kind, d.enquiry_no AS number, e.client_name AS client, d.thread_id, d.decided_at AS at,
            COALESCE(e.service, '') AS detail, a.email AS mailbox
       FROM email_enquiry_decisions d JOIN enquiries e ON e.enquiry_no = d.enquiry_no JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'created' AND d.kind <> 'quotation_sent' AND (d.decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
     UNION ALL
     SELECT 'quotation', d.quotation_no, q.client_name, d.thread_id, d.decided_at, COALESCE(q.service_quoted, ''), a.email
       FROM email_enquiry_decisions d JOIN quotations q ON q.quotation_no = d.quotation_no JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.quotation_extraction IN ('created','revised') AND (d.decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
     UNION ALL
     SELECT 'purchase_order', d.po_number, pr.client_name, d.thread_id, d.decided_at, COALESCE(po.currency || ' ' || po.po_value::text, ''), a.email
       FROM email_po_decisions d JOIN purchase_orders po ON po.po_number = d.po_number JOIN projects pr ON pr.project_id = po.project_id
       JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome IN ('registered','registered_by_hand') AND (d.decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
     UNION ALL
     SELECT 'invoice', d.invoice_no, s.client_name, d.thread_id, d.decided_at, d.po_number, a.email
       FROM email_invoice_decisions d JOIN v_payment_stages s ON s.id = d.stage_id JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome IN ('recorded','recorded_by_hand') AND (d.decided_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
     ORDER BY at`, [from, to, tz]);
  return rows;
}

/** Where a record of any kind an email thread can sit on opens in the app. */
export function linkFor(entity, id) {
  if (entity === 'purchase_order') return `/purchase-orders?q=${encodeURIComponent(String(id))}`;
  if (entity === 'project') return `/projects?q=${encodeURIComponent(String(id))}`;
  if (entity === 'invoice') return '/payment-stages';
  return recordLink(entity, id);
}

/** A highlight from a reader event, worded in code: used when there is no AI. */
export function eventHighlight(ev) {
  const client = ev.client || 'a client';
  const text = {
    enquiry: `New enquiry ${ev.number} from ${client}${ev.detail ? ` for ${ev.detail}` : ''}, created from email`,
    quotation: `Quotation ${ev.number} to ${client} read from the PDF we emailed`,
    purchase_order: `PO ${ev.number} from ${client}${ev.detail ? ` (${ev.detail})` : ''} registered from email`,
    invoice: `Invoice ${ev.number} to ${client}${ev.detail ? ` on ${ev.detail}` : ''} recorded from the email we sent`,
  }[ev.kind];
  const link = linkFor(ev.kind, ev.number);
  return { thread_id: ev.thread_id ?? null, client, summary: text, action: null, owner: null, link, source: 'records' };
}

// ---------------------------------------------------------------------
// What the reference briefing adds (docs/mis-briefing-fix-plan.md §3)
// ---------------------------------------------------------------------

/**
 * A thread in the Inbox: its mailbox, the folder its latest message is in,
 * and the thread (the Inbox's ?mb=&f=&t=). The mailbox alone when the
 * folder is not known.
 */
export function threadLink({ account_id: mb, folder_id: f, thread_id: t }) {
  if (!mb) return '/inbox';
  return f ? `/inbox?mb=${mb}&f=${encodeURIComponent(f)}&t=${t}` : `/inbox?mb=${mb}`;
}

/** Outlook's link to the message when the provider gave one, else the thread in the Inbox. */
const emailLink = (m) => m.web_link || threadLink(m);

/**
 * "Last activity" and "Email" on each pending row (§3): the latest message
 * on its record's threads, or on its own thread for a review item. Only
 * the shared mailboxes' mail, the mail the briefing may show.
 */
export async function attachMail(db, rows) {
  const keys = [...new Set(rows.filter((r) => r.mail?.entity).map((r) => `${r.mail.entity}:${r.mail.id}`))];
  const threadIds = [...new Set(rows.filter((r) => r.mail?.thread_id).map((r) => r.mail.thread_id))];
  if (!keys.length && !threadIds.length) return rows;
  const { rows: found } = await db.query(
    `WITH mail AS (
       SELECT t.id AS thread_id, t.entity, t.entity_id, (m.sent_at AT TIME ZONE $3)::date::text AS day, m.sent_at, m.web_link, m.account_id, m.folder_id
         FROM email_threads t
         JOIN connected_accounts a ON a.id = t.account_id AND a.is_shared
         JOIN email_messages m ON m.thread_id = t.id AND m.removed_at IS NULL
        WHERE t.id = ANY($2) OR (t.entity IS NOT NULL AND t.entity || ':' || t.entity_id = ANY($1)))
     SELECT DISTINCT ON (k) * FROM (
       SELECT 'thread:' || thread_id AS k, * FROM mail WHERE thread_id = ANY($2)
       UNION ALL
       SELECT entity || ':' || entity_id, * FROM mail WHERE entity IS NOT NULL AND entity || ':' || entity_id = ANY($1)
     ) x ORDER BY k, sent_at DESC`, [keys, threadIds, config.businessTimeZone]);
  const latest = new Map(found.map((r) => [r.k, r]));
  for (const row of rows) {
    const hit = row.mail?.thread_id ? latest.get(`thread:${row.mail.thread_id}`) : row.mail?.entity ? latest.get(`${row.mail.entity}:${row.mail.id}`) : null;
    if (!hit) continue;
    row.last_activity = hit.day;
    row.email_link = emailLink(hit);
  }
  return rows;
}

/**
 * Up to three earlier messages on each highlight's thread or record
 * (§3 "Related earlier emails"), from the shared mailboxes the briefing
 * reads. Changes the highlights in place.
 */
export async function attachRelated(db, highlights, { from }) {
  const ids = [...new Set(highlights.map((h) => h.thread_id).filter((id) => id != null))];
  if (!ids.length) return highlights;
  const { rows } = await db.query(
    `SELECT h.id AS for_thread, r.*
       FROM email_threads h
       JOIN LATERAL (
         SELECT m.subject, COALESCE(m.from_name, m.from_email) AS sender, (m.sent_at AT TIME ZONE $3)::date::text AS day,
                m.web_link, m.account_id, m.folder_id, m.thread_id
           FROM email_messages m
           JOIN email_threads t ON t.id = m.thread_id AND m.removed_at IS NULL
           JOIN connected_accounts a ON a.id = t.account_id AND a.is_shared AND a.visibility = 'share_everything'
          WHERE (m.sent_at AT TIME ZONE $3)::date < $2
            AND (t.id = h.id OR (h.entity IS NOT NULL AND t.entity = h.entity AND t.entity_id = h.entity_id))
          ORDER BY m.sent_at DESC LIMIT 3) r ON true
      WHERE h.id = ANY($1)`, [ids, from, config.businessTimeZone]);
  // The source email of a highlight worded from a record, which has none yet.
  const { rows: source } = await db.query(
    `SELECT DISTINCT ON (m.thread_id) m.thread_id, m.web_link, m.account_id, m.folder_id
       FROM email_messages m JOIN email_threads t ON t.id = m.thread_id JOIN connected_accounts a ON a.id = t.account_id AND a.is_shared
      WHERE m.thread_id = ANY($1) AND m.removed_at IS NULL ORDER BY m.thread_id, m.sent_at DESC`, [ids]);
  const sourceOf = new Map(source.map((m) => [m.thread_id, m]));
  for (const h of highlights) {
    if (!h.web_link && sourceOf.has(h.thread_id)) h.web_link = emailLink(sourceOf.get(h.thread_id));
    h.related = rows.filter((r) => r.for_thread === h.thread_id)
      .map((r) => ({ day: r.day, from: r.sender, subject: r.subject || '(no subject)', link: emailLink(r) }));
  }
  return highlights;
}

/** The clients and numbers behind each at-a-glance count: the Detail column. */
async function glanceDetail(db, { from, to }) {
  const tz = config.businessTimeZone;
  // The time zone only for the queries that use it: Postgres refuses a parameter a query does not use.
  const list = async (sql) => (await db.query(sql, sql.includes('$3') ? [from, to, tz] : [from, to])).rows.map((r) => r.label).filter(Boolean);
  const [newEnquiries, quotationsSent, posReceived, invoicesRaised, paymentsReceived] = await Promise.all([
    list(`SELECT e.client_name AS label FROM enquiries e WHERE ${ENQUIRY_DAY('e', '$3')} BETWEEN $1 AND $2
            AND NOT EXISTS (SELECT 1 FROM email_enquiry_decisions d WHERE d.enquiry_no = e.enquiry_no AND d.outcome = 'created' AND d.kind <> 'new_enquiry')
          ORDER BY e.enquiry_no`),
    list(`SELECT q.client_name || ' (' || q.quotation_no || ')' AS label FROM quotations q
           WHERE q.quotation_no IN (
             SELECT x.quotation_no FROM quotations x WHERE (x.sent_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
             UNION
             SELECT d.quotation_no FROM email_enquiry_decisions d
              WHERE d.kind = 'quotation_sent' AND d.quotation_no IS NOT NULL AND d.outcome IN ('created','linked')
                AND (d.received_at AT TIME ZONE $3)::date BETWEEN $1 AND $2)
           ORDER BY q.quotation_no`),
    list(`SELECT COALESCE(pr.client_name, '') || ' (' || po.po_number || ')' AS label
            FROM purchase_orders po LEFT JOIN projects pr ON pr.project_id = po.project_id
           WHERE po.po_date BETWEEN $1 AND $2 AND ${poCountsAsSale('po')} ORDER BY po.po_number`),
    list(`SELECT COALESCE(s.client_name, '') || ' (' || COALESCE(s.invoice_no, s.po_number) || ')' AS label
            FROM v_payment_stages s WHERE s.invoice_date BETWEEN $1 AND $2 ORDER BY s.invoice_no`),
    list(`SELECT COALESCE(s.client_name, '') || ' (' || COALESCE(s.invoice_no, s.po_number) || ')' AS label
            FROM payments p JOIN v_payment_stages s ON s.id = p.stage_id WHERE p.received_on BETWEEN $1 AND $2 ORDER BY p.id`),
  ]);
  return { new_enquiries: newEnquiries, quotations_sent: quotationsSent, pos_received: posReceived, invoices_raised: invoicesRaised, payments_received: paymentsReceived };
}

/**
 * Reminders carried forward (§3): visits and meetings in the next three
 * days, and POs that came by email and are still not registered. The
 * tracker has no "PO acknowledged" mark; a PO still in review is the
 * nearest thing to one not acknowledged.
 */
async function remindersAhead(db, { today, pos }) {
  const tz = config.businessTimeZone;
  const { rows: visits } = await db.query(
    `SELECT v.id, v.title, v.type, v.status, v.city, (v.starts_at AT TIME ZONE $3)::date::text AS day, COALESCE(c.name, pr.client_name) AS client
       FROM visits v LEFT JOIN companies c ON c.id = v.company_id LEFT JOIN projects pr ON pr.project_id = v.project_id
      WHERE v.status IN ('planned','confirmed') AND (v.starts_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
      ORDER BY v.starts_at, v.id`, [today, addDays(today, 3), tz]);
  return [
    ...visits.map((v) => ({
      kind: 'visit',
      text: `${v.type === 'meeting' ? 'Meeting' : 'Visit'}: ${v.title}${v.client && !v.title.includes(v.client) ? `, ${v.client}` : ''}, ${shortDay(v.day)}${v.city ? `, ${v.city}` : ''} (${v.status})`,
      link: `/schedule?visit=${v.id}`,
    })),
    ...pos.filter((r) => r.kind === 'po_review').map((r) => ({
      kind: 'po_not_registered',
      text: `PO from ${r.client}, received ${r.since ? shortDay(r.since) : 'by email'}, is still not registered`,
      link: r.link,
    })),
  ];
}

/** The shared mailboxes the briefing reads (decision 3), with their folders, and the ones it cannot read. */
async function briefingMailboxes(db) {
  const { rows } = await db.query(`SELECT email, visibility, read_scope FROM connected_accounts WHERE is_shared AND status <> 'disconnected' ORDER BY email`);
  return {
    read: rows.filter((r) => r.visibility === 'share_everything').map((r) => ({ email: r.email, folders: r.read_scope === 'inbox_sent' ? 'Inbox + Sent Items' : 'all folders' })),
    not_read: rows.filter((r) => r.visibility !== 'share_everything').map((r) => ({ email: r.email, shared_as: r.visibility })),
  };
}

/**
 * Finance's newest debtors list from the 14 days up to `today`, with its
 * lines and its email (§3a). A newest list that was not used comes back as
 * { rejected, reason }: the receivables are then the tracker's alone, not
 * an older list's.
 */
export async function latestList(db, { today }) {
  const { rows: [l] } = await db.query(
    `SELECT l.id, l.list_date::text AS list_date, l.file_name, l.grand_total::float8 AS grand_total, l.status, l.reason,
            m.web_link, m.account_id, m.folder_id, m.thread_id
       FROM receivable_lists l LEFT JOIN email_messages m ON m.id = l.message_id
      WHERE (l.received_at AT TIME ZONE $2)::date BETWEEN $1::date - $3::int AND $1::date
      ORDER BY l.received_at DESC, l.id DESC LIMIT 1`, [today, config.businessTimeZone, LIST_MAX_AGE_DAYS]);
  if (!l) return null;
  const list = { id: l.id, date: l.list_date, file_name: l.file_name, grand_total: l.grand_total, link: l.thread_id ? emailLink(l) : null };
  if (l.status !== 'used') return { ...list, rejected: true, reason: l.reason };
  const { rows: lines } = await db.query(
    'SELECT line_no, client, invoice_no, amount::float8 AS amount, days, pending_for_invoicing FROM receivable_list_lines WHERE list_id = $1 ORDER BY line_no', [l.id]);
  return { ...list, lines };
}

/** A client's name as the list and the tracker may both spell it: no punctuation, no "Pvt Ltd". */
export const clientKey = (name) => String(name ?? '').toLowerCase().replace(/^\s*m\s*\/\s*s\b\.?/, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(private|pvt|limited|ltd|llp|inc|incorporated|co|company|corporation|corp|india|the)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** Equal within ₹1 or 0.5%, as the readers compare amounts. */
const same = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1, 0.005 * Math.max(Math.abs(a), Math.abs(b)));
const lakhs = (v) => Math.round(v).toLocaleString('en-IN');

/**
 * Finance's list against the tracker's rows (§3a), client by client: equal
 * amounts pair first; what is left of a client on both sides is one match
 * showing both figures ("list: 2,44,530; tracker: 2,10,000"); a list line
 * left over is on the list only, for Finance to record in the tracker; a
 * tracker row left over is not on the list.
 */
export function reconcile(rows, lines, { list, overdueDays, kind }) {
  const out = rows.map((r) => ({ ...r, source: 'tracker', list_amount: null, note: null }));
  const group = (items) => {
    const by = new Map();
    for (const x of items) { const k = clientKey(x.client); by.set(k, [...(by.get(k) || []), x]); }
    return by;
  };
  const tracker = group(out);
  const listOnly = [];
  for (const [key, ls] of group(lines)) {
    const open = [...(tracker.get(key) || [])];
    const left = [];
    for (const l of ls) {
      const i = open.findIndex((t) => same(t.amount_inr, l.amount));
      if (i < 0) { left.push(l); continue; }
      Object.assign(open[i], { source: 'both', list_amount: l.amount });
      open.splice(i, 1);
    }
    if (left.length && open.length) {
      const onList = left.reduce((n, l) => n + l.amount, 0);
      const inTracker = open.reduce((n, t) => n + (t.amount_inr || 0), 0);
      // A tracker amount with no exchange rate for its date is not ₹0: say so.
      const unconverted = open.some((t) => t.amount_inr === null || t.amount_inr === undefined);
      for (const t of open) t.source = 'both';
      Object.assign(open[0], { list_amount: onList, note: `list: ${lakhs(onList)}; tracker: ${unconverted ? 'not converted to ₹' : lakhs(inTracker)}` });
      continue;
    }
    listOnly.push(...left);
  }
  for (const t of out) if (t.source === 'tracker') t.note = `not on Finance's list of ${shortDay(list.date)}`;
  const fromList = listOnly.map((l) => ({
    ...pendingRow({
      kind: kind === 'to_raise' ? 'list_to_invoice' : 'list_receivable', key: `list:${list.id}:${l.line_no}`, client: l.client,
      reference: l.invoice_no ? `Invoice ${l.invoice_no}` : "On Finance's list", amount_inr: l.amount, amount: l.amount, currency: 'INR',
      days: l.days ?? 0, next_action: 'Finance: record in tracker', link: '/payment-stages',
    }, overdueDays),
    // A Finance action, not a chase: never counted Overdue.
    overdue: false, source: 'list', list_amount: l.amount, email_link: list.link, age: l.days ?? null,
  }));
  return { rows: out, fromList };
}

/**
 * The invoices in the reference's three tables: to check (review), to
 * raise, receivables. With Finance's list, the last two are reconciled
 * with it; their value is the tracker's, the list's total beside it.
 */
export function invoiceTables(rows, { list = null, overdueDays = 7 } = {}) {
  const pick = (kind) => rows.filter((r) => r.kind === kind);
  const actions = summarise(pick('invoice_review'));
  if (!list || list.rejected) {
    return { actions, to_raise: summarise(pick('to_invoice')), receivables: summarise(pick('invoice_due')), list: list ? { ...list, lines: undefined } : null };
  }
  const table = (kind, pending) => {
    const lines = list.lines.filter((l) => l.pending_for_invoicing === pending);
    const r = reconcile(pick(kind), lines, { list, overdueDays, kind: pending ? 'to_raise' : 'receivables' });
    return { ...summarise([...r.rows, ...r.fromList]), value_inr: r2(r.rows.reduce((n, x) => n + (x.amount_inr || 0), 0)), list_total: r2(lines.reduce((n, l) => n + l.amount, 0)) };
  };
  const toRaise = table('to_invoice', true);
  const receivables = table('invoice_due', false);
  const both = [...toRaise.rows, ...receivables.rows];
  const count = (source) => both.filter((x) => x.source === source).length;
  return {
    actions,
    to_raise: toRaise,
    receivables,
    list: { id: list.id, date: list.date, file_name: list.file_name, link: list.link, grand_total: list.grand_total, matched: count('both'), list_only: count('list'), tracker_only: count('tracker') },
  };
}

const summarise = (rows) => ({
  count: rows.length,
  overdue: rows.filter((r) => r.overdue).length,
  value_inr: r2(rows.reduce((n, r) => n + (r.amount_inr || 0), 0)),
  unconverted: rows.filter((r) => r.amount != null && r.amount_inr == null).length,
  rows: [...rows].sort((a, b) => b.days - a.days || (b.amount_inr || 0) - (a.amount_inr || 0)),
});

/**
 * The Daily Sales Briefing's figures for the day before `today`.
 * `settings` is misSettings(); the threshold marks rows Overdue.
 */
export async function dailyBriefing({ today = businessToday(), db = { query }, settings = null } = {}) {
  const s = settings || await misSettings(db);
  const period = yesterdayOf(today);
  const ctx = { today, overdueDays: s.overdueDays };
  const [glance, invoices, pos, quotations, readers, events, detail, mailboxes, list] = await Promise.all([
    atAGlance(db, period), pendingInvoices(db, ctx), pendingPos(db, ctx), pendingQuotations(db, ctx), readersDay(db, period), readerEvents(db, period),
    glanceDetail(db, period), briefingMailboxes(db), latestList(db, { today }),
  ]);
  await attachMail(db, [...invoices, ...pos, ...quotations]);
  const reminders = await remindersAhead(db, { today, pos });
  const pending = { invoices: summarise(invoices), pos: summarise(pos), quotations: summarise(quotations) };
  const all = [...invoices, ...pos, ...quotations];
  return {
    kind: 'daily_briefing',
    period,
    today,
    overdue_days: s.overdueDays,
    at_a_glance: {
      ...glance,
      pending_invoices: pending.invoices.count, pending_pos: pending.pos.count, pending_quotations: pending.quotations.count,
      overdue: all.filter((r) => r.overdue).length,
    },
    pending,
    // The reference's pieces (§3): what is behind each count, the invoices
    // in three tables, what is coming up, and where the mail was read.
    glance_detail: detail,
    invoice_tables: invoiceTables(invoices, { list, overdueDays: s.overdueDays }),
    reminders,
    mailboxes,
    app_url: s.appUrl,
    top_actions: topActions(all),
    readers,
    events,
    // Replaced by the AI's highlights when it is on (misAi.js); these are the fallback.
    highlights: events.slice(0, 8).map(eventHighlight),
    quiet: !glance.new_enquiries && !glance.quotations_sent && !glance.pos_received && !glance.invoices_raised && !glance.payments_received && !events.length,
  };
}

// ---------------------------------------------------------------------
// Weekly MIS (§3.2)
// ---------------------------------------------------------------------

/**
 * The first-response TAT rule, in one place (§3.2). Hours from the enquiry
 * to our first response, or null:
 *
 *   - from an inbox conversation: first_response_at − the first inbound
 *     message;
 *   - otherwise first_responded_at − the enquiry date;
 *   - never for an enquiry the readers made from our own quotation or PO
 *     email (kind quotation_sent, or the PO reader): their first_responded_at
 *     is stamped artificially, so it would show a false TAT.
 */
export function firstResponseTat(row) {
  if (row.from_our_email) return null;
  const hours = (a, b) => (a && b ? r2((new Date(b).getTime() - new Date(a).getTime()) / 3_600_000) : null);
  if (row.conversation_first_inbound_at && row.conversation_first_response_at) {
    const h = hours(row.conversation_first_inbound_at, row.conversation_first_response_at);
    return h == null || h < 0 ? null : h;
  }
  if (row.first_responded_at && row.enquiry_date) {
    const h = hours(`${String(row.enquiry_date).slice(0, 10)}T00:00:00+05:30`, row.first_responded_at);
    return h == null || h < 0 ? null : h;
  }
  return null;
}

export function median(values) {
  const list = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : r2((list[mid - 1] + list[mid]) / 2);
}

/** The enquiries of a period with client, country, sector, service, source and TAT (question 1). */
export async function enquiryRows(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows } = await db.query(
    `SELECT e.enquiry_no, to_char(${ENQUIRY_DAY('e', '$3')}, 'YYYY-MM-DD') AS date, e.enquiry_date, e.client_name AS client, e.country, e.sector, e.service,
            COALESCE(ls.name, NULLIF(btrim(e.source), '')) AS source, e.status, e.first_responded_at, COALESCE(u.name, NULLIF(btrim(e.sales_person), '')) AS owner,
            conv.first_response_at AS conversation_first_response_at, conv.first_message_at AS conversation_first_inbound_at,
            EXISTS (SELECT 1 FROM email_enquiry_decisions d WHERE d.enquiry_no = e.enquiry_no AND d.outcome = 'created' AND d.kind = 'quotation_sent') AS from_our_email_q,
            EXISTS (SELECT 1 FROM email_po_decisions d WHERE d.outcome IN ('registered','registered_by_hand') AND d.created_quotation
                      AND EXISTS (SELECT 1 FROM quotations q WHERE q.quotation_no = d.quotation_no AND q.quotation_no = e.quotation_no)) AS from_our_email_po
       FROM enquiries e
       LEFT JOIN lead_sources ls ON ls.id = e.source_id
       LEFT JOIN users u ON u.id = e.owner_user_id
       LEFT JOIN LATERAL (SELECT c.first_response_at, t.first_message_at FROM inbox_conversations c JOIN email_threads t ON t.id = c.thread_id
                           WHERE c.enquiry_no = e.enquiry_no ORDER BY c.id LIMIT 1) conv ON true
      WHERE ${ENQUIRY_DAY('e', '$3')} BETWEEN $1 AND $2
      ORDER BY date, e.enquiry_no`, [from, to, tz]);
  return rows.map((r) => {
    const row = { ...r, from_our_email: r.from_our_email_q || r.from_our_email_po };
    const tat = firstResponseTat(row);
    delete row.from_our_email_q; delete row.from_our_email_po;
    return { ...row, first_response_hours: tat };
  });
}

/** Invoiced and received in a period, in INR at each event's own date (question 6). */
export async function billingTotals(db, { from, to }) {
  const params = [from, to];
  const { rows: [r] } = await db.query(
    `WITH ${RATES}
     SELECT (SELECT count(*) FROM v_payment_stages s WHERE s.invoiced_amount > 0 AND ${inPeriod('s.invoice_date')})::int AS invoices,
            (SELECT COALESCE(sum(s.invoiced_amount * r.rate), 0) FROM v_payment_stages s ${rateOn('r', 's.currency', 's.invoice_date')}
              WHERE s.invoiced_amount > 0 AND ${inPeriod('s.invoice_date')})::float8 AS invoiced_inr,
            (SELECT count(*) FROM v_payment_stages s WHERE s.invoiced_amount > 0 AND ${inPeriod('s.invoice_date')} AND NOT EXISTS (
               SELECT 1 FROM rates x WHERE x.currency = s.currency AND x.effective_from <= s.invoice_date))::int AS invoiced_unconverted,
            (SELECT count(*) FROM payments p WHERE ${inPeriod('p.received_on')})::int AS payments,
            (SELECT COALESCE(sum(p.amount * r.rate), 0) FROM payments p JOIN v_payment_stages s ON s.id = p.stage_id
              ${rateOn('r', 's.currency', 'p.received_on')} WHERE ${inPeriod('p.received_on')})::float8 AS received_inr,
            (SELECT count(*) FROM payments p JOIN v_payment_stages s ON s.id = p.stage_id WHERE ${inPeriod('p.received_on')} AND NOT EXISTS (
               SELECT 1 FROM rates x WHERE x.currency = s.currency AND x.effective_from <= p.received_on))::int AS received_unconverted`,
    params);
  return { invoices: r.invoices, invoiced_inr: r2(r.invoiced_inr), invoiced_unconverted: r.invoiced_unconverted, payments: r.payments, received_inr: r2(r.received_inr), received_unconverted: r.received_unconverted };
}

/** Quotations sent in the period, with the detail the routine listed (service, sector, country, value, TAT from the enquiry). */
async function quotationsSent(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows } = await db.query(
    `WITH ${RATES}
     SELECT q.quotation_no, q.client_name AS client, q.service_quoted AS service, q.sector, q.country, q.status,
            COALESCE(q.total, q.quotation_value) AS amount, q.currency, ROUND(COALESCE(q.total, q.quotation_value) * r.rate, 2)::float8 AS amount_inr,
            to_char((q.sent_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS sent_on, COALESCE(u.name, NULLIF(btrim(q.sales_person), '')) AS owner,
            e.enquiry_no, ROUND(EXTRACT(EPOCH FROM (q.sent_at - (${ENQUIRY_DAY('e', '$3')})::timestamp AT TIME ZONE $3)) / 86400)::int AS days_from_enquiry
       FROM quotations q
       LEFT JOIN users u ON u.id = q.owner_user_id
       LEFT JOIN enquiries e ON e.quotation_no = q.quotation_no
       ${rateOn('r', 'q.currency', 'q.quotation_date')}
      WHERE (q.sent_at AT TIME ZONE $3)::date BETWEEN $1 AND $2
      ORDER BY q.sent_at`, [from, to, tz]);
  return rows;
}

/** The country of each PO in the period, from its quotation (the only record that carries one). Not on the revenue rows, so read here. */
async function poCountries(db, { from, to }) {
  const { rows } = await db.query(
    `SELECT po.po_number, NULLIF(btrim(q.country), '') AS country
       FROM purchase_orders po
       LEFT JOIN quotations q ON q.quotation_no = ${poQuotationNo('po')}
      WHERE po.po_date BETWEEN $1 AND $2`, [from, to]);
  return new Map(rows.map((r) => [r.po_number, r.country]));
}

/** Won ÷ (won + lost) among quotations decided in the period, and the quote-to-PO days of the period's POs (question 8). */
async function conversion(db, { from, to }) {
  const tz = config.businessTimeZone;
  const { rows: [c] } = await db.query(
    `SELECT (SELECT count(DISTINCT ${poQuotationNo('po')}) FROM purchase_orders po
              WHERE po.po_date BETWEEN $1 AND $2 AND ${poCountsAsSale('po')} AND ${poQuotationNo('po')} IS NOT NULL)::int AS won,
            (SELECT count(*) FROM quotations q LEFT JOIN pipeline_stages st ON st.id = q.stage_id
              WHERE (q.status = '${QUOTATION_STATUS.lost}' OR st.type = 'lost')
                AND (COALESCE(q.closed_at, q.stage_changed_at) AT TIME ZONE $3)::date BETWEEN $1 AND $2)::int AS lost`, [from, to, tz]);
  const { rows: tats } = await db.query(
    `SELECT po.po_number, (po.po_date - (q.sent_at AT TIME ZONE $3)::date)::int AS days
       FROM purchase_orders po JOIN quotations q ON q.quotation_no = ${poQuotationNo('po')}
      WHERE po.po_date BETWEEN $1 AND $2 AND ${poCountsAsSale('po')} AND q.sent_at IS NOT NULL`, [from, to, tz]);
  const decided = c.won + c.lost;
  return { won: c.won, lost: c.lost, quote_to_contract_pct: decided ? Math.round((c.won / decided) * 100) : null, quote_to_po_days_median: median(tats.map((t) => t.days)), quote_to_po_sample: tats.length };
}

/** The open pipeline: every sent, open quotation, unweighted and weighted, in INR. */
async function openPipeline(db) {
  const [{ rows: stages }, cards] = await Promise.all([
    db.query('SELECT * FROM pipeline_stages WHERE active ORDER BY sort_order'),
    pipelineCards(db, UNRESTRICTED),
  ]);
  const summary = summarisePipeline(stages, cards);
  const open = cards.filter((c) => c.status !== 'Draft' && c.value_inr != null && Number(c.quotation_value));
  const value = r2(open.reduce((n, c) => n + Number(c.value_inr), 0));
  return {
    count: open.length,
    value_inr: value,
    weighted_inr: r2(open.reduce((n, c) => n + Number(c.weighted_inr || 0), 0)),
    average_ticket_inr: open.length ? r2(value / open.length) : null,
    without_rate: summary.without_rate,
  };
}

/**
 * The Weekly Sales MIS's figures for the week before `today`: the eight
 * management questions, each from the definition the Reports page uses.
 */
export async function weeklyMis({ today = businessToday(), db = { query }, settings = null } = {}) {
  const s = settings || await misSettings(db);
  const period = previousWeekOf(today);
  const mtd = monthToDate(period.to);
  const ctx = { today, overdueDays: s.overdueDays };
  const [report, enquiries, mtdEnquiries, billing, mtdBilling, sent, conv, pipeline, insightsCtx, invoices, pos, quotations, countries] = await Promise.all([
    salesReport(period, { grain: 'day', today }),
    enquiryRows(db, period),
    db.query(`SELECT count(*)::int AS n FROM enquiries e WHERE ${ENQUIRY_DAY('e', '$3')} BETWEEN $1 AND $2`, [mtd.from, mtd.to, config.businessTimeZone]).then((r) => r.rows[0].n),
    billingTotals(db, period),
    billingTotals(db, mtd),
    quotationsSent(db, period),
    conversion(db, period),
    openPipeline(db),
    insightsContext(db, today),
    pendingInvoices(db, ctx), pendingPos(db, ctx), pendingQuotations(db, ctx),
    poCountries(db, period),
  ]);
  const [receivables, followUps] = await Promise.all([
    receivablesSection(db, UNRESTRICTED, insightsCtx),
    overdueFollowUps(db, UNRESTRICTED, insightsCtx),
  ]);
  const over90 = receivables.buckets.find((b) => b.key === '90+') || receivables.buckets.at(-1);
  const over90Rows = [];
  const tats = enquiries.map((e) => e.first_response_hours);
  const converted = report.outcomes.slices.find((x) => x.key === 'converted');

  return {
    kind: 'weekly_mis',
    period,
    month_to_date: mtd,
    today,
    overdue_days: s.overdueDays,
    // 1. Enquiries per day, the week, month to date; the table.
    enquiries: {
      total: report.enquiries.total,
      per_day: report.enquiries.buckets.filter((b) => b.key).map((b) => ({ date: b.key, label: b.label, enquiries: b.enquiries })),
      month_to_date: mtdEnquiries,
      sources: report.enquiries.sources,
      rows: enquiries,
      tat: { median_hours: median(tats), with_tat: tats.filter((t) => t != null).length, without_tat: tats.filter((t) => t == null).length },
    },
    // 2. Status: converted, pipeline, lost, with names.
    outcomes: report.outcomes,
    // 3 and 4.
    sectors: report.sectors,
    services: report.services,
    // 5.
    customers: report.customers,
    // The week's POs with date, client, country, service, value and new/repeat (question 5).
    pos: report.revenue.months.flatMap((m) => m.detail).map((po) => ({ ...po, country: countries.get(po.po_number) ?? null, repeat: report.customers.repeat_orders.some((r) => r.po_number === po.po_number) })),
    revenue: report.revenue,
    quotations_sent: sent,
    // 6.
    billing: { week: billing, month_to_date: mtdBilling },
    // 7.
    receivables: {
      outstanding_inr: receivables.outstanding, overdue_inr: receivables.overdue, overdue_count: receivables.overdue_count,
      over_90: over90 ? { amount_inr: over90.amount, count: over90.count } : { amount_inr: 0, count: 0 },
      oldest_days: receivables.top[0]?.days_overdue ?? null, largest: receivables.top_clients[0] ?? null,
      top: receivables.top, top_clients: receivables.top_clients, unconverted: receivables.unconverted.length, rows: over90Rows,
    },
    pending: { invoices: summarise(invoices), pos: summarise(pos), quotations: summarise(quotations) },
    follow_ups_overdue: { count: followUps.length, value_inr: r2(followUps.reduce((n, f) => n + Number(f.value_inr || 0), 0)), top: followUps.slice(0, 5) },
    // 8.
    speed: {
      enquiry_to_po_pct: converted?.pct ?? null,
      ...conv,
      average_po_ticket_inr: report.revenue.total.pos ? r2(report.revenue.total.po_value_inr / report.revenue.total.pos) : null,
      pipeline,
      enquiry_tat_median_hours: median(tats),
    },
    notes: report.notes,
    stale_rates: report.stale_rates,
    narrative: report.narrative,
  };
}
