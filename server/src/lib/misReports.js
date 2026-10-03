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
import { OPEN_ENQUIRY_STATUSES, OPEN_QUOTATION_STATUSES, keyOf, lastActivity, recordLink, dateOf } from './followUps.js';
import { insightsContext, loadConverter, overdueFollowUps, receivablesSection } from './insights.js';
import { pipelineCards, summarisePipeline } from './pipeline.js';
import { salesReport } from './reportDefinitions.js';
import { r2 } from './reportMath.ts';
import { RATES, inPeriod, poCountsAsSale, poQuotationNo, rateOn } from './salesReport.js';
import { QUOTATION_STATUS } from './statuses.js';

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
const addresses = (v) => String(v ?? '').split(/[,;]/).map((a) => a.trim()).filter(Boolean);

export async function misSettings(db = { query }) {
  const { rows } = await db.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const on = (v) => String(v ?? 'false').trim().toLowerCase() === 'true';
  return {
    dailyEnabled: on(s.mis_daily_enabled),
    weeklyEnabled: on(s.mis_weekly_enabled),
    to: addresses(s.mis_to),
    cc: addresses(s.mis_cc),
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
export function pendingRow({ kind, key, client, reference, amount_inr: amountInr = null, currency = null, amount = null, since, days, owner = null, next_action: nextAction, link, record = null }, overdueDays) {
  const waited = Math.max(0, Math.trunc(days ?? 0));
  return {
    kind, key, client: client || 'Unknown client', reference, amount_inr: amountInr == null ? null : r2(Number(amountInr)), currency, amount,
    since: since || null, days: waited, overdue: waited > overdueDays, owner: owner || null, next_action: nextAction, link, record,
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
            ps.milestone_reached_on, ps.delivery_date, ps.po_date, ps.on_hold, ps.promise_to_pay_date,
            COALESCE(c.name, ps.client_name) AS client_name, u.name AS owner,
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
      }, overdueDays));
      continue;
    }
    const owed = Number(s.stage_amount) - Number(s.amount_received || 0);
    const due = dateOf(s.invoice_due_date);
    const late = due ? daysBetween(due, today) : 0;
    out.push(pendingRow({
      kind: 'invoice_due', key: `stage:${s.id}`, client: clientName(s), reference: `Invoice ${s.invoice_no || '—'} · ${s.po_number}`,
      amount: owed, currency: s.currency, amount_inr: rate == null ? null : owed * rate,
      since: due, days: late, owner: s.owner,
      next_action: late > 0 ? `Chase payment, ${late} day${late === 1 ? '' : 's'} overdue` : `Due ${due ? `on ${due}` : 'soon'}`,
      link: recordLink('payment_stage', s.id),
    }, overdueDays));
  }
  const { rows: review } = await db.query(
    `SELECT d.id, d.sent_at, d.to_emails, d.invoice_no, d.po_number, d.review_reason, a.email AS mailbox
       FROM email_invoice_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'review' ORDER BY d.sent_at`);
  for (const d of review) {
    const since = dateOf(d.sent_at);
    out.push(pendingRow({
      kind: 'invoice_review', key: `invoice-review:${d.id}`, client: d.to_emails?.[0] || d.mailbox, reference: `Invoice ${d.invoice_no || '(unread)'}${d.po_number ? ` · ${d.po_number}` : ''}`,
      since, days: since ? daysBetween(since, today) : 0,
      next_action: 'Check the invoice read from email', link: '/payment-stages?tab=invoice-review',
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
            COALESCE(q.total, q.quotation_value) AS amount, q.currency, q.expected_close_date, q.next_step, u.name AS owner, r.rate,
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
      link: recordLink('quotation', q.quotation_no),
    }, overdueDays));
  }
  const { rows: review } = await db.query(
    `SELECT d.id, d.received_at, d.from_email, d.review_reason, d.suggested_quotations, a.email AS mailbox,
            (SELECT c.name FROM companies c JOIN contacts ct ON ct.company_id = c.id WHERE lower(ct.email) = lower(d.from_email) LIMIT 1) AS company_name
       FROM email_po_decisions d JOIN connected_accounts a ON a.id = d.account_id
      WHERE d.outcome = 'review' ORDER BY d.received_at`);
  for (const d of review) {
    const since = dateOf(d.received_at);
    out.push(pendingRow({
      kind: 'po_review', key: `po-review:${d.id}`, client: d.company_name || d.from_email || d.mailbox, reference: `PO received by email${d.suggested_quotations?.length ? ` (${d.suggested_quotations.join(', ')}?)` : ''}`,
      since, days: since ? daysBetween(since, today) : 0,
      next_action: 'PO received, not registered: check it', link: '/purchase-orders?tab=review',
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
       SELECT e.enquiry_no, e.client_name, e.status, e.service, e.estimated_value, e.currency, e.next_follow_up_at, u.name AS owner, r.rate,
              COALESCE(e.enquiry_date, (e.created_at AT TIME ZONE $2)::date) AS since
         FROM enquiries e LEFT JOIN users u ON u.id = e.owner_user_id
         ${rateOn('r', 'e.currency', 'e.enquiry_date')}
        WHERE e.status = ANY($1::text[]) AND e.quotation_no IS NULL
        ORDER BY since, e.enquiry_no`, [OPEN_ENQUIRY_STATUSES, config.businessTimeZone]),
    db.query(
      `WITH ${RATES}
       SELECT q.quotation_no, q.client_name, q.status, q.sent_at, q.quotation_date, q.next_step,
              COALESCE(q.total, q.quotation_value) AS amount, q.currency, u.name AS owner, r.rate
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
      next_action: 'Send the quotation', link: recordLink('enquiry', e.enquiry_no),
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
      next_action: q.next_step || 'Follow up with the client', link: recordLink('quotation', q.quotation_no),
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
       (SELECT count(*) FROM enquiries e WHERE ${ENQUIRY_DAY('e', '$3')} BETWEEN $1 AND $2)::int AS new_enquiries,
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

/** A highlight from a reader event, worded in code: used when there is no AI. */
export function eventHighlight(ev) {
  const client = ev.client || 'a client';
  const text = {
    enquiry: `New enquiry ${ev.number} from ${client}${ev.detail ? ` for ${ev.detail}` : ''}, created from email`,
    quotation: `Quotation ${ev.number} to ${client} read from the PDF we emailed`,
    purchase_order: `PO ${ev.number} from ${client}${ev.detail ? ` (${ev.detail})` : ''} registered from email`,
    invoice: `Invoice ${ev.number} to ${client}${ev.detail ? ` on ${ev.detail}` : ''} recorded from the email we sent`,
  }[ev.kind];
  const link = { enquiry: recordLink('enquiry', ev.number), quotation: recordLink('quotation', ev.number), purchase_order: `/purchase-orders?q=${encodeURIComponent(ev.number)}`, invoice: '/payment-stages' }[ev.kind];
  return { thread_id: ev.thread_id ?? null, client, summary: text, action: null, owner: null, link, source: 'records' };
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
  const [glance, invoices, pos, quotations, readers, events] = await Promise.all([
    atAGlance(db, period), pendingInvoices(db, ctx), pendingPos(db, ctx), pendingQuotations(db, ctx), readersDay(db, period), readerEvents(db, period),
  ]);
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
            COALESCE(ls.name, NULLIF(btrim(e.source), '')) AS source, e.status, e.first_responded_at, u.name AS owner,
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
            to_char((q.sent_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS sent_on, u.name AS owner,
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
