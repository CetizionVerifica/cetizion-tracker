/**
 * Insights (docs/insights-dashboard-plan.md): five questions on one screen.
 *
 *   follow_ups    quotations past their follow-up date
 *   receivables   what clients owe us, and how late it is
 *   enquiry_risk  enquiries that need handling before it is too late
 *   po_pipeline   deals about to become POs, and POs not fully billed
 *   revenue       money expected per month, quarter or financial year
 *
 * Every figure is narrowed to the reader's records (auth/ownership.js) and
 * is in INR at the rate on the record's own date. A record with no rate for
 * that date is counted as unconverted, never guessed. Nothing is stored:
 * each section is worked out on read from the same rules the rest of the
 * app uses (follow-ups, collections, pipeline, cash flow), so the same number
 * on two screens agrees.
 *
 * Each section runs on its own; one that fails returns `{ error }` and the
 * other four still answer.
 */
import { UNRESTRICTED, ownershipScope, scopedSources } from '../auth/ownership.js';
import { AGEING_BUCKETS, FOLLOW_UP_BANDS, ageingBucketOf, followUpBandOf } from './ageing.js';
import { cashflow } from './cashflow.js';
import { RISK_LABELS, RISK_REASONS, compareRisk, enquiryRisk, readRiskSettings } from './enquiryRisk.js';
import { closedReason, dateOf, dueInfo, keyOf, lastActivity, loadRecords } from './followUps.js';
import { logger } from './ops/logger.js';
import { GRANULARITIES, addMonths, periodOf, rollUp } from './periods.js';
import { pipelineCards, summarisePipeline } from './pipeline.js';
import { RATES, rateOn } from './salesReport.js';

export const HORIZONS = Object.freeze([3, 6, 12]);
export const BASES = Object.freeze(['cash', 'order']);
const TOP = 5;

const DAY_MS = 86_400_000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * The scope Insights reads with. A sales user is always narrowed to their
 * own records; an admin sees everything, or one owner's records when they
 * pick one. `owner` from anyone else is ignored.
 */
export function insightsScope(user, owner) {
  const base = ownershipScope(user);
  const id = Number(owner);
  if (base.unrestricted && owner !== undefined && owner !== '' && Number.isInteger(id) && id > 0) {
    return { unrestricted: false, ownerId: id };
  }
  return base;
}

/** The query string, checked and defaulted. */
export function readOptions(q = {}) {
  const granularity = GRANULARITIES.includes(q.granularity) ? q.granularity : 'month';
  const horizon = HORIZONS.includes(Number(q.horizon)) ? Number(q.horizon) : 6;
  const basis = BASES.includes(q.basis) ? q.basis : 'cash';
  return { granularity, horizon, basis };
}

/**
 * Exchange rates to INR as a lookup: `toInr(amount, currency, date)` is the
 * amount at the latest rate on or before that date, or null without one.
 */
export async function loadConverter(db, today) {
  const { rows } = await db.query(
    `SELECT from_currency AS currency, rate, effective_from FROM exchange_rates
      WHERE to_currency = 'INR' ORDER BY from_currency, effective_from DESC`
  );
  const byCurrency = new Map();
  for (const r of rows) {
    if (!byCurrency.has(r.currency)) byCurrency.set(r.currency, []);
    byCurrency.get(r.currency).push({ on: r.effective_from, rate: Number(r.rate) });
  }
  return (amount, currency, date) => {
    if (amount === null || amount === undefined || amount === '') return null;
    if (!currency || currency === 'INR') return Number(amount);
    const on = String(date || today).slice(0, 10);
    const hit = byCurrency.get(currency)?.find((r) => r.on <= on);
    return hit ? Number(amount) * hit.rate : null;
  };
}

/** Holidays, the rule settings and the rate lookup, read once per request. */
export async function insightsContext(db, today) {
  const [{ rows: hol }, { rows: settingRows }, toInr] = await Promise.all([
    db.query('SELECT holiday_on FROM holidays'),
    db.query(`SELECT key, value FROM settings WHERE key LIKE 'followup\\_%' OR key LIKE 'enquiry\\_%'`),
    loadConverter(db, today),
  ]);
  const settings = readRiskSettings(Object.fromEntries(settingRows.map((r) => [r.key, r.value])));
  return { today, holidays: hol.map((h) => h.holiday_on), settings, toInr };
}

/* ------------------------------------------------------------ 1. follow-ups */

/**
 * Every open quotation in the scope whose follow-up is overdue today, worst
 * first. The same dueInfo() the daily job uses, but read from the records
 * themselves rather than from follow_up_cycles, so it works with the job
 * switched off.
 */
export async function overdueFollowUps(db, scope, ctx) {
  const { today, settings, holidays, toInr } = ctx;
  const records = (await loadRecords(db, [], { scope, kinds: ['quotation'] }))
    .filter((r) => !closedReason(r, today));
  const activity = await lastActivity(db, records.map(keyOf));
  const items = [];
  for (const rec of records) {
    const lastOn = dateOf(activity.get(keyOf(rec)) ?? null);
    const due = dueInfo(rec, lastOn, { today, settings, holidays });
    if (!due) continue;
    const days = Math.max(0, daysBetween(due.due_on, today));
    items.push({
      number: rec.number, client: rec.client, detail: rec.detail, link: rec.link,
      owner_user_id: rec.owner_user_id, owner_name: rec.owner_name,
      amount: rec.amount, currency: rec.currency,
      value_inr: toInr(rec.amount, rec.currency, rec.quotation_date ?? dateOf(rec.created_at)),
      due_on: due.due_on, why: due.why, last_activity_on: lastOn,
      days_overdue: days, band: followUpBandOf(days),
    });
  }
  return items.sort((a, b) => b.days_overdue - a.days_overdue || (Number(b.value_inr) || 0) - (Number(a.value_inr) || 0));
}

async function followUpsSection(db, scope, ctx) {
  const items = await overdueFollowUps(db, scope, ctx);
  const buckets = FOLLOW_UP_BANDS.map(({ key, label }) => ({ key, label, count: 0, value: 0 }));
  const owners = new Map();
  let value = 0;
  for (const it of items) {
    const b = buckets.find((x) => x.key === it.band);
    b.count += 1; b.value += Number(it.value_inr || 0);
    value += Number(it.value_inr || 0);
    const ok = it.owner_user_id ?? 'none';
    if (!owners.has(ok)) owners.set(ok, { owner_user_id: it.owner_user_id ?? null, owner_name: it.owner_name ?? 'No owner', count: 0, value: 0 });
    const o = owners.get(ok); o.count += 1; o.value += Number(it.value_inr || 0);
  }
  return {
    count: items.length,
    value_inr: round2(value),
    oldest_days: items[0]?.days_overdue ?? null,
    unconverted: items.filter((i) => i.amount != null && i.value_inr == null).length,
    buckets: buckets.map((b) => ({ ...b, value: round2(b.value) })),
    by_owner: [...owners.values()].map((o) => ({ ...o, value: round2(o.value) })).sort((a, b) => b.count - a.count || b.value - a.value),
    top: items.slice(0, TOP),
  };
}

/* ---------------------------------------------------------- 2. receivables */

async function receivablesSection(db, scope, ctx) {
  const params = [];
  const src = scopedSources(scope, params);
  // The same rows /collections ages — invoiced, not paid — narrowed to the
  // reader and converted on the invoice's own date.
  const { rows } = await db.query(
    `WITH ${RATES}
     SELECT ps.id, ps.po_number, ps.stage_name, ps.invoice_no, ps.invoice_date, ps.invoice_due_date, ps.days_overdue,
            ps.currency, ps.amount_received, pr.company_id, COALESCE(c.name, ps.client_name) AS company_name,
            ROUND(ps.stage_amount - ps.amount_received, 2) AS outstanding, r.rate
       FROM ${src.vPaymentStages} ps
       JOIN projects pr ON pr.project_id = ps.project_id
       LEFT JOIN companies c ON c.id = pr.company_id
       ${rateOn('r', 'ps.currency', 'ps.invoice_date')}
      WHERE ps.invoice_no IS NOT NULL AND ps.stage_status IN ('Due', 'Overdue', 'Partially Paid')`,
    params
  );
  const buckets = AGEING_BUCKETS.map(({ key, label }) => ({ key, label, count: 0, amount: 0, invoiced: 0, part_paid: 0 }));
  const clients = new Map();
  const unconverted = [];
  const open = [];
  let outstanding = 0; let overdue = 0;
  for (const s of rows) {
    // Days late against the business date, not the database clock (the
    // view counts from CURRENT_DATE, which is still yesterday in the early
    // IST morning).
    const days = s.invoice_due_date ? daysBetween(s.invoice_due_date, ctx.today) : Number(s.days_overdue || 0);
    const owed = Number(s.outstanding);
    const row = { stage_id: s.id, invoice_no: s.invoice_no, ref: `${s.po_number} · ${s.stage_name}`, company_id: s.company_id, company: s.company_name, currency: s.currency, amount: owed, days_overdue: days, due_on: s.invoice_due_date };
    if (s.rate === null || s.rate === undefined) { unconverted.push(row); continue; }
    const inr = round2(owed * Number(s.rate));
    open.push({ ...row, amount_inr: inr });
    const b = buckets.find((x) => x.key === ageingBucketOf(days));
    b.count += 1; b.amount += inr;
    if (Number(s.amount_received || 0) > 0) b.part_paid += inr; else b.invoiced += inr;
    outstanding += inr;
    const key = s.company_id ?? s.company_name;
    if (!clients.has(key)) clients.set(key, { company_id: s.company_id, company: s.company_name, outstanding: 0, overdue: 0, oldest_days: 0, invoices: 0 });
    const cl = clients.get(key);
    cl.outstanding += inr; cl.invoices += 1; cl.oldest_days = Math.max(cl.oldest_days, days);
    if (days > 0) { overdue += inr; cl.overdue += inr; }
  }
  return {
    outstanding: round2(outstanding),
    overdue: round2(overdue),
    overdue_count: open.filter((o) => o.days_overdue > 0).length,
    buckets: buckets.map((b) => ({ ...b, amount: round2(b.amount), invoiced: round2(b.invoiced), part_paid: round2(b.part_paid) })),
    top_clients: [...clients.values()].filter((c) => c.overdue > 0)
      .map((c) => ({ ...c, outstanding: round2(c.outstanding), overdue: round2(c.overdue) }))
      .sort((a, b) => b.overdue - a.overdue).slice(0, 10),
    top: open.filter((o) => o.days_overdue > 0).sort((a, b) => b.days_overdue - a.days_overdue || b.amount_inr - a.amount_inr).slice(0, TOP),
    unconverted,
  };
}

/* --------------------------------------------------------- 3. enquiry risk */

/**
 * The business date of the first thing we sent or did on each enquiry: an
 * outbound touch, an outbound email on a linked thread, or a completed task.
 * Map enquiry_no -> YYYY-MM-DD. Derived, not stored.
 */
export async function firstOutbound(db, enquiryNos) {
  if (!enquiryNos.length) return new Map();
  const { rows } = await db.query(
    `WITH k AS (SELECT unnest($1::text[]) AS id),
     acts AS (
       SELECT c.entity_id, c.started_at AS ts
         FROM communications c JOIN k ON c.entity = 'enquiry' AND c.entity_id = k.id
        WHERE c.direction = 'outbound'
       UNION ALL
       SELECT t.entity_id, m.sent_at
         FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
         JOIN k ON t.entity = 'enquiry' AND t.entity_id = k.id
        WHERE m.direction = 'outbound'
       UNION ALL
       SELECT t.entity_id, t.completed_at
         FROM tasks t JOIN k ON t.entity = 'enquiry' AND t.entity_id = k.id
        WHERE t.completed_at IS NOT NULL
       UNION ALL
       SELECT tt.entity_id, t.completed_at
         FROM task_targets tt JOIN tasks t ON t.id = tt.task_id
         JOIN k ON tt.entity = 'enquiry' AND tt.entity_id = k.id
        WHERE t.completed_at IS NOT NULL
     )
     SELECT entity_id, min(ts) AS first_at FROM acts GROUP BY 1`,
    [enquiryNos]
  );
  return new Map(rows.map((r) => [r.entity_id, dateOf(r.first_at)]));
}

/** Every open enquiry in the scope that is at risk today, worst first. */
export async function enquiriesAtRisk(db, scope, ctx) {
  const { today, settings, holidays, toInr } = ctx;
  const records = await loadRecords(db, [], { scope, kinds: ['enquiry'] });
  const [activity, first] = await Promise.all([
    lastActivity(db, records.map(keyOf)),
    firstOutbound(db, records.map((r) => r.entity_id)),
  ]);
  const items = [];
  for (const rec of records) {
    const risk = enquiryRisk(rec, {
      lastActivityOn: dateOf(activity.get(keyOf(rec)) ?? null),
      firstOutboundOn: first.get(rec.entity_id) ?? null,
      today, settings, holidays,
    });
    if (!risk) continue;
    items.push({
      number: rec.number, client: rec.client, detail: rec.detail, link: rec.link,
      owner_user_id: rec.owner_user_id, owner_name: rec.owner_name,
      amount: rec.amount, currency: rec.currency,
      value_inr: toInr(rec.amount, rec.currency, rec.enquiry_date ?? dateOf(rec.created_at)),
      expected_decision_date: rec.expected_decision_date,
      ...risk,
    });
  }
  return items.sort(compareRisk);
}

async function enquiryRiskSection(db, scope, ctx) {
  const items = await enquiriesAtRisk(db, scope, ctx);
  return {
    count: items.length,
    value_inr: round2(items.reduce((sum, i) => sum + Number(i.value_inr || 0), 0)),
    by_reason: RISK_REASONS.map((reason) => ({ reason, label: RISK_LABELS[reason], count: items.filter((i) => i.reasons.some((r) => r.reason === reason)).length })),
    top: items.slice(0, TOP),
  };
}

/* ---------------------------------------------------------- 4. PO pipeline */

async function poPipelineSection(db, scope, ctx) {
  const poParams = []; const poSrc = scopedSources(scope, poParams);
  const [{ rows: stageRows }, cards, { rows: poRows }] = await Promise.all([
    db.query('SELECT * FROM pipeline_stages WHERE active ORDER BY sort_order'),
    pipelineCards(db, scope),
    // Live POs only: a revised PO is counted once, as its revision, and a
    // cancelled one not at all — the sales figures' rule. Fully paid POs
    // have left the pipeline.
    db.query(
      `WITH ${RATES}
       SELECT po.po_number, po.payment_status, po.po_value, po.currency, po.balance_to_bill, po.total_invoiced, po.total_received, r.rate
         FROM ${poSrc.vPurchaseOrders} po ${rateOn('r', 'po.currency', 'po.po_date')}
        WHERE NOT po.cancelled AND po.replaced_by_po_number IS NULL AND po.payment_status <> 'Fully Paid'`,
      poParams
    ),
  ]);
  const summary = summarisePipeline(stageRows, cards);
  // Drafts have not gone to the client; the funnel starts at Sent.
  const open = summary.stages.filter((s) => s.type === 'open' && s.maps_to_status !== 'Draft');
  // The last open stage is the one before Won: "Verbal yes, awaiting PO".
  const awaiting = open[open.length - 1] ?? null;

  const po = { to_bill: { count: 0, value: 0 }, billed: { count: 0, value: 0 } };
  const status = new Map();
  let withoutRate = 0;
  for (const p of poRows) {
    const s = status.get(p.payment_status) ?? { status: p.payment_status, count: 0, value: 0, to_bill: 0 };
    status.set(p.payment_status, s);
    s.count += 1;
    if (p.rate === null || p.rate === undefined) { withoutRate += 1; continue; }
    const rate = Number(p.rate);
    // A PO with no payment stages has billed nothing yet: all of it is to
    // bill. Worked out once, so the funnel and the status chart agree.
    const toBill = Math.max(0, p.payment_status === 'No stages' ? Number(p.po_value || 0) : Number(p.balance_to_bill || 0));
    s.value += Number(p.po_value || 0) * rate;
    s.to_bill += toBill * rate;
    if (toBill > 0) { po.to_bill.count += 1; po.to_bill.value += toBill * rate; }
    else { po.billed.count += 1; po.billed.value += Math.max(0, Number(p.total_invoiced || 0) - Number(p.total_received || 0)) * rate; }
  }

  const byMonth = new Map();
  if (awaiting) {
    for (const c of cards) {
      if (c.stage_id !== awaiting.id || c.value_inr == null) continue;
      const month = c.expected_close_date ? String(c.expected_close_date).slice(0, 7) : 'undated';
      const m = byMonth.get(month) ?? { month, label: month === 'undated' ? 'No date' : periodOf(month).label, count: 0, value: 0, weighted: 0 };
      byMonth.set(month, m);
      m.count += 1; m.value += Number(c.value_inr); m.weighted += Number(c.weighted_inr || 0);
    }
  }

  return {
    awaiting_stage_id: awaiting?.id ?? null,
    awaiting_po: awaiting ? { count: awaiting.count, value: round2(awaiting.value), weighted: round2(awaiting.weighted) } : { count: 0, value: 0, weighted: 0 },
    stages: [
      ...open.map((s) => ({ key: `stage-${s.id}`, stage_id: s.id, label: s.name, probability: s.probability, count: s.count, value: round2(s.value), weighted: round2(s.weighted) })),
      { key: 'po-to-bill', label: 'PO received, still to bill', count: po.to_bill.count, value: round2(po.to_bill.value), weighted: round2(po.to_bill.value) },
      { key: 'po-billed', label: 'Billed, awaiting payment', count: po.billed.count, value: round2(po.billed.value), weighted: round2(po.billed.value) },
    ],
    awaiting_po_by_month: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ ...m, value: round2(m.value), weighted: round2(m.weighted) })),
    po_status: [...status.values()].map((s) => ({ ...s, value: round2(s.value), to_bill: round2(s.to_bill) })).sort((a, b) => b.count - a.count),
    without_rate: summary.without_rate + withoutRate,
  };
}

/* ------------------------------------------------------------- 5. revenue */

/**
 * How many months to show: the horizon, stretched so the last period is
 * whole (six months from November in quarters runs to the end of June).
 */
export function windowMonths(first, horizon, granularity) {
  let n = horizon;
  const lastKey = (k) => periodOf(addMonths(first, k - 1), granularity).key;
  while (n < 36 && periodOf(addMonths(first, n), granularity).key === lastKey(n)) n += 1;
  return n;
}

/** Annual INR order-intake targets as a monthly figure per calendar year. */
async function monthlyTargets(db, scope, years) {
  const params = [years];
  let who = '';
  if (!scope.unrestricted) { params.push(scope.ownerId); who = `AND salesperson_user_id = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT calendar_year, SUM(target_value)::numeric AS total FROM sales_targets
      WHERE metric = 'order_intake_value' AND unit = 'currency' AND currency = 'INR'
        AND calendar_year = ANY($1::int[]) ${who}
      GROUP BY calendar_year`,
    params
  );
  return new Map(rows.map((r) => [Number(r.calendar_year), Number(r.total) / 12]));
}

async function revenueSection(db, scope, ctx, { granularity, horizon, basis }) {
  const first = ctx.today.slice(0, 7);
  if (basis === 'order') return orderBasis(db, scope, ctx, { granularity, horizon, first });
  const months = Math.max(windowMonths(first, horizon, granularity), 3);
  const cf = await cashflow({ months, scope, convert: true, db, today: ctx.today });
  const dated = cf.months.filter((m) => /^\d{4}-\d{2}$/.test(m.month));
  const extra = (key) => cf.months.find((m) => m.month === key);
  const pick = (m) => m && { received: round2(m.received), invoiced: round2(m.invoiced), scheduled: round2(m.scheduled), pipeline: round2(m.pipeline) };
  return {
    basis: 'cash',
    periods: rollUp(dated, granularity, ['received', 'invoiced', 'scheduled', 'pipeline'])
      .map((p) => ({ ...p, received: round2(p.received), invoiced: round2(p.invoiced), scheduled: round2(p.scheduled), pipeline: round2(p.pipeline), target: null })),
    // Firm money in the first three months, for the tile, whatever the period.
    next_three_months: round2(dated.slice(0, 3).reduce((n, m) => n + m.received + m.invoiced + m.scheduled, 0)),
    later: pick(extra('later')),
    unscheduled: pick(extra('unscheduled')),
    unconverted: cf.foreign.length,
  };
}

/**
 * Order basis: POs dated in each period (won), and open quotations weighted
 * by their stage, by expected close. Looks back `horizon` months for what was
 * won and forward `horizon` months for what may be.
 */
async function orderBasis(db, scope, ctx, { granularity, horizon, first }) {
  const start = addMonths(first, -(horizon - 1));
  const months = Array.from({ length: 2 * horizon - 1 }, (_, i) => addMonths(start, i));
  const params = []; const src = scopedSources(scope, params);
  params.push(`${start}-01`);
  const [{ rows: won }, cards] = await Promise.all([
    db.query(
      `WITH ${RATES}
       SELECT to_char(po.po_date, 'YYYY-MM') AS month, SUM(po.po_value * r.rate) AS value,
              COUNT(*) FILTER (WHERE r.rate IS NULL)::int AS without_rate
         FROM ${src.vPurchaseOrders} po ${rateOn('r', 'po.currency', 'po.po_date')}
        WHERE NOT po.cancelled AND po.replaced_by_po_number IS NULL AND po.po_date >= $${params.length}::date
        GROUP BY 1`,
      params
    ),
    pipelineCards(db, scope),
  ]);
  const rows = new Map(months.map((m) => [m, { month: m, won: 0, pipeline: 0 }]));
  for (const w of won) if (rows.has(w.month)) rows.get(w.month).won += Number(w.value || 0);
  // A deal whose close date has passed is still open: it is expected now.
  for (const f of summarisePipeline([], cards).forecast) {
    if (f.month === 'undated') continue;
    const m = f.month < first ? first : f.month;
    if (rows.has(m)) rows.get(m).pipeline += f.weighted;
  }
  const targets = await monthlyTargets(db, scope, [...new Set(months.map((m) => Number(m.slice(0, 4))))]);
  for (const r of rows.values()) r.target = targets.has(Number(r.month.slice(0, 4))) ? targets.get(Number(r.month.slice(0, 4))) : null;
  const periods = rollUp([...rows.values()], granularity, ['won', 'pipeline', 'target']).map((p) => {
    const anyTarget = p.months.some((m) => rows.get(m).target !== null);
    return { ...p, won: round2(p.won), pipeline: round2(p.pipeline), target: anyTarget ? round2(p.target) : null, past: p.months.every((m) => m < first) };
  });
  return {
    basis: 'order',
    periods,
    unconverted: won.reduce((n, w) => n + Number(w.without_rate || 0), 0) + cards.filter((c) => c.quotation_value != null && c.value_inr == null).length,
  };
}

/* ---------------------------------------------------------------- whole */

/** One section, or `{ error }` if it failed: the rest of the page still answers. */
async function section(name, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, section: name }, 'insights section failed');
    return { error: 'This section could not be worked out just now.' };
  }
}

/**
 * The whole dashboard. `scope` is the reader's (insightsScope), `today` the
 * business date; the options come from readOptions().
 */
export async function insights(db, { scope = UNRESTRICTED, today, granularity = 'month', horizon = 6, basis = 'cash', viewerUnrestricted = scope.unrestricted } = {}) {
  const ctx = await insightsContext(db, today);
  const [follow_ups, receivables, enquiry_risk, po_pipeline, revenue, owners] = await Promise.all([
    section('follow_ups', () => followUpsSection(db, scope, ctx)),
    section('receivables', () => receivablesSection(db, scope, ctx)),
    section('enquiry_risk', () => enquiryRiskSection(db, scope, ctx)),
    section('po_pipeline', () => poPipelineSection(db, scope, ctx)),
    section('revenue', () => revenueSection(db, scope, ctx, { granularity, horizon, basis })),
    // The owner picker is an admin's; a sales user's list would be a staff directory.
    viewerUnrestricted ? db.query('SELECT id, name FROM users WHERE active ORDER BY name').then((r) => r.rows) : [],
  ]);
  const s = ctx.settings;
  return {
    today,
    granularity, horizon, basis,
    scope: { unrestricted: scope.unrestricted, owner_user_id: scope.unrestricted ? null : scope.ownerId },
    owners,
    follow_ups, receivables, enquiry_risk, po_pipeline, revenue,
    // The ⓘ text on each card reads the live rules, not a copy of them.
    settings: {
      followup_enabled: s.followup_enabled,
      quotation_idle_days: s.followup_quotation_idle_days,
      enquiry_idle_days: s.followup_enquiry_idle_days,
      enquiry_reply_days: s.enquiry_reply_days,
      enquiry_decision_warn_days: s.enquiry_decision_warn_days,
    },
  };
}
