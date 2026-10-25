/**
 * The sales journey's rules (docs/specs/sales-journey, server layer §3).
 *
 * A row of v_sales_journey holds facts only: dates, statuses, counts and
 * sums. Everything a screen shows about where a sale has got to — its step,
 * the small step inside it, days in step, the one flag, the next action, the
 * funnel — is worked out here, on every read, from those facts and the five
 * thresholds in Settings. Nothing here touches a database, so every rule can
 * be pinned by a test with a made-up row and a fixed today.
 *
 * Dates are `YYYY-MM-DD` strings, the form the database hands back for a
 * date. A timestamp is read as the business day it fell on (businessDate.ts),
 * so a quotation created at 01:00 in Mumbai is not a day old on the board.
 */
import { businessToday } from '../businessDate.ts';
import { money } from '../reportFormat.js';

export const STEPS = [
  { key: 'enquiry', label: 'Enquiry' },
  { key: 'quotation', label: 'Quotation' },
  { key: 'po', label: 'PO' },
];
const ORDER = STEPS.map((s) => s.key);

/**
 * The five thresholds (spec D4): the key each is read from in Settings, and
 * the value it falls back to when that row is missing, blank or not a number.
 */
export const JOURNEY_SETTINGS = {
  enquiry_days: { key: 'journey_stuck_enquiry_days', fallback: 7 },
  quotation_days: { key: 'journey_stuck_quotation_days', fallback: 21 },
  unsent_days: { key: 'journey_unsent_days', fallback: 5 },
  po_days: { key: 'journey_stuck_po_days', fallback: 30 },
  paid_visible_days: { key: 'journey_paid_visible_days', fallback: 30 },
};
export const DEFAULT_SETTINGS = Object.fromEntries(Object.entries(JOURNEY_SETTINGS).map(([name, s]) => [name, s.fallback]));

/** The flags the board's "Stuck only" switch keeps: the ones about time and money, not a missing price. */
export const STUCK_KINDS = ['stuck', 'slow', 'overdue', 'unsent'];
export const COHORTS = ['started', 'quoted', 'won', 'with_po'];

const DAY_MS = 86_400_000;
const WON_STATUS = 'Won - PO Received';

// ---------------------------------------------------------------- dates

/** The business day a date or timestamp fell on, as `YYYY-MM-DD`; null for none. */
export function dayOf(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : businessToday(date);
}

/** Whole days from one `YYYY-MM-DD` to another, on the UTC calendar so no clock can move a day. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The day `n` days before a `YYYY-MM-DD`. */
export function daysBefore(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- facts read once

const num = (v) => Number(v ?? 0);
const hasPo = (row) => num(row.po_count) > 0;
const hasRecord = {
  enquiry: (row) => row.enquiry_id != null,
  quotation: (row) => row.quotation_id != null,
  po: hasPo,
};
const wonReached = (row) => row.quotation_status === WON_STATUS || row.stage_type === 'won';
// The Expired stage is a loss too: its type is 'lost' while the status may still read otherwise.
const quotationLost = (row) => row.stage_type === 'lost' || row.quotation_status === 'Lost';

// ---------------------------------------------------------------- §3.1 step and exit

/** Where the sale is, and whether it stopped there. A PO beats a lost quotation: money ordered is the fact that matters. */
export function stepAndExit(row) {
  if (hasPo(row)) return { step: 'po', exit: row.fully_paid ? 'paid' : null };
  if (hasRecord.quotation(row)) return { step: 'quotation', exit: quotationLost(row) ? 'lost' : null };
  return { step: 'enquiry', exit: row.enquiry_status === 'Unqualified' ? 'unqualified' : null };
}

// ---------------------------------------------------------------- §3.2 big steps

/**
 * The three big steps' states. A step the sale passed with no record behind
 * it is `skipped` (drawn hollow, "Not recorded"), never `done`: a sale that
 * started at a quotation never had an enquiry.
 */
export function bigStates(row, { step, exit }) {
  const at = ORDER.indexOf(step);
  return ORDER.map((key, i) => {
    if (i < at) return hasRecord[key](row) ? 'done' : 'skipped';
    if (i > at) return 'future';
    if (!exit) return 'current';
    return exit === 'paid' ? 'done' : 'exit';
  });
}

// ---------------------------------------------------------------- §3.3 small steps

const CONTACTED_STATUSES = ['Contacted', 'Qualified', 'Nurture', 'Converted'];
const QUALIFIED_STATUSES = ['Qualified', 'Converted'];

/** Each step's small steps, in order, with whether the sale has reached it and its date when one is known. */
const SMALL = {
  enquiry: (row) => [
    { label: 'New', reached: true, date: null },
    {
      label: 'Contacted',
      reached: Boolean(row.enquiry_first_responded_at || row.enquiry_last_contacted_at || CONTACTED_STATUSES.includes(row.enquiry_status)),
      date: dayOf(row.enquiry_first_responded_at),
    },
    { label: 'Qualified', reached: QUALIFIED_STATUSES.includes(row.enquiry_status), date: null },
  ],
  quotation: (row) => {
    const won = wonReached(row);
    const accepted = Boolean(row.accepted_at) || won;
    return [
      { label: 'Priced', reached: num(row.line_count) > 0 || num(row.quotation_value) > 0, date: null },
      { label: 'Sent', reached: Boolean(row.sent_at) || (row.quotation_status != null && row.quotation_status !== 'Draft'), date: dayOf(row.sent_at) },
      { label: 'Negotiating', reached: row.quotation_status === 'Under Negotiation' || accepted, date: null },
      { label: 'Accepted', reached: accepted, date: dayOf(row.accepted_at) },
      { label: 'Won', reached: won, date: won ? dayOf(row.closed_at) : null },
    ];
  },
  po: (row) => [
    { label: 'Registered', reached: true, date: dayOf(row.first_po_date ?? row.first_po_created_at) },
    { label: 'Split set', reached: num(row.pos_without_stages) === 0, date: null },
    { label: 'Billable', reached: num(row.billable_stages) > 0 || num(row.invoiced_total) > 0, date: null },
    { label: 'Invoiced', reached: num(row.invoiced_total) > 0, date: null },
    { label: 'Paid', reached: Boolean(row.fully_paid), date: row.fully_paid ? dayOf(row.last_paid_on) : null },
  ],
};

/** What a quotation with nothing reached is called. Enquiry and PO always reach their first small step. */
const NOTHING_REACHED = { enquiry: 'New', quotation: 'Draft', po: 'Registered' };

/**
 * The small steps of one big step with their states. The sale is *at* the
 * furthest one reached: that one is current, reached ones before it done,
 * unreached ones before it skipped, and everything after it future.
 */
export function smallSteps(key, row) {
  const list = SMALL[key](row);
  const at = list.findLastIndex((s) => s.reached);
  const steps = list.map((s, i) => ({
    label: s.label,
    state: i === at ? 'current' : i > at ? 'future' : s.reached ? 'done' : 'skipped',
    date: s.date,
  }));
  return { steps, label: at >= 0 ? list[at].label : NOTHING_REACHED[key] };
}

const reached = (key, row, label) => SMALL[key](row).find((s) => s.label === label)?.reached ?? false;

// ---------------------------------------------------------------- §3.4 days in step

/**
 * When the sale entered a step; null when that step has no record. Each
 * record's own date first, the day it was keyed in only when that is blank:
 * a sheet imported today holds enquiries that arrived months ago.
 */
export function stepSince(key, row) {
  if (!hasRecord[key](row)) return null;
  if (key === 'enquiry') return dayOf(row.enquiry_date ?? row.enquiry_created_at);
  if (key === 'quotation') return dayOf(row.quotation_date ?? row.quotation_created_at);
  return dayOf(row.first_po_date ?? row.first_po_created_at);
}

/** Whole days since, never negative: a PO dated next week has been here for none. */
export function daysSince(since, today) {
  return since ? Math.max(0, daysBetween(since, today)) : null;
}

// ---------------------------------------------------------------- §3.5 the flag

/** How long a step may run before it is slow; the PO's clock stops at the first invoice. */
function limitFor(step, row, settings) {
  if (step === 'enquiry') return settings.enquiry_days;
  if (step === 'quotation') return settings.quotation_days;
  return num(row.invoiced_total) === 0 ? settings.po_days : null;
}

/**
 * At most one flag, the first that applies. "Over" a limit is strictly
 * greater: seven days on a seven-day limit is still on time. A sale that
 * stopped carries none.
 */
export function flagOf(row, { step, exit, days }, settings) {
  if (exit) return null;
  if (step === 'po' && num(row.overdue_stages) > 0) {
    // In one currency the amount says it; across several a sum would not.
    const label = row.po_currency
      ? `${money(row.overdue_amount, row.po_currency)} overdue`
      : `${plural(num(row.overdue_stages), 'stage')} overdue`;
    return { kind: 'overdue', label, tone: 'late' };
  }
  if (step === 'quotation' && row.approval_status === 'pending') {
    return { kind: 'approval', label: 'Discount needs approval', tone: 'waiting' };
  }
  if (step === 'quotation' && num(row.price_needed_count) > 0 && !wonReached(row)) {
    const n = num(row.price_needed_count);
    return { kind: 'price', label: `${plural(n, 'line')} ${n === 1 ? 'needs' : 'need'} a price`, tone: 'waiting' };
  }
  if (days != null) {
    if (step === 'quotation' && !reached('quotation', row, 'Sent') && days > settings.unsent_days) {
      return { kind: 'unsent', label: `Unsent ${plural(days, 'day')}`, tone: 'waiting' };
    }
    const limit = limitFor(step, row, settings);
    if (limit != null && days > limit * 2) return { kind: 'stuck', label: `Stuck ${plural(days, 'day')}`, tone: 'late' };
    if (limit != null && days > limit) return { kind: 'slow', label: `Slow ${plural(days, 'day')}`, tone: 'waiting' };
  }
  if (step === 'enquiry' && row.enquiry_status === 'Nurture') return { kind: 'nurture', label: 'Nurturing', tone: 'info' };
  return null;
}

// ---------------------------------------------------------------- §3.6 next action

/** The one thing to do next on the current step; the web opens that step's record for it (spec C4). */
export function nextAction(row, { step, exit }) {
  if (exit) return null;
  if (step === 'enquiry') {
    // "Status New" read as the journey still being at New: an enquiry still
    // marked New that has had a call logged is past contacting.
    if (!reached('enquiry', row, 'Contacted')) return { verb: 'contact', label: 'Contact them' };
    // Only a Qualified enquiry converts, as its page offers (spec §4 E). One
    // marked Converted with no quotation linked is followed up and edited.
    if (row.enquiry_status === 'Qualified') return { verb: 'convert', label: 'Convert to quotation' };
    return { verb: 'follow_up', label: 'Log a call' };
  }
  if (step === 'quotation') {
    if (row.approval_status === 'pending') return { verb: 'approve', label: 'Review the discount' };
    if (num(row.price_needed_count) > 0) return { verb: 'price', label: 'Price the lines' };
    if (!reached('quotation', row, 'Sent')) return { verb: 'send', label: 'Send to the client' };
    if (reached('quotation', row, 'Accepted')) return { verb: 'register_po', label: 'Register the PO' };
    return { verb: 'follow_up', label: 'Follow up' };
  }
  if (!reached('po', row, 'Split set')) return { verb: 'set_split', label: 'Set the payment split' };
  if (num(row.overdue_stages) > 0) return { verb: 'chase', label: 'Chase payment' };
  if (num(row.stages_to_invoice) > 0) return { verb: 'raise_invoice', label: 'Raise the invoice' };
  return { verb: 'open', label: 'Open the order' };
}

// ---------------------------------------------------------------- one journey

/**
 * Everything the API adds to a row: step and exit, the big steps' states,
 * the small step it is at, days in step, the flag and the next action.
 * `today` is passed in, so a test pins it and a route passes the business date.
 */
export function journeyState(row, settings = DEFAULT_SETTINGS, today = businessToday()) {
  const { step, exit } = stepAndExit(row);
  const since = stepSince(step, row);
  const days = daysSince(since, today);
  return {
    step,
    exit,
    small_step: smallSteps(step, row).label,
    progress: bigStates(row, { step, exit }),
    days_in_step: days,
    step_since: since,
    flag: flagOf(row, { step, exit, days }, settings),
    next: nextAction(row, { step, exit }),
  };
}

/** The value a card shows: the current step's own, in its own currency, and in rupees when there is a rate. */
function valueAt(step, row) {
  if (step === 'enquiry') return { value: row.enquiry_estimated_value ?? null, currency: row.enquiry_currency ?? null, value_inr: row.enquiry_value_inr ?? null };
  if (step === 'quotation') return { value: row.quotation_value ?? null, currency: row.quotation_currency ?? null, value_inr: row.quotation_value_inr ?? null };
  return { value: row.po_value_total ?? null, currency: row.po_currency ?? null, value_inr: row.po_value_inr ?? null };
}

/**
 * The business day the sale began: the first of its records' dates that is
 * set, in this order, each date before the day its record was keyed in.
 */
export function startedOn(row) {
  return dayOf(row.enquiry_date ?? row.enquiry_created_at ?? row.quotation_date ?? row.quotation_created_at
    ?? row.first_po_date ?? row.first_po_created_at ?? null);
}

/** The board's card for a row (server layer §5). `state` is journeyState(row, …). */
export function toCard(row, state) {
  return {
    key: row.journey_key,
    step: state.step,
    exit: state.exit,
    small_step: state.small_step,
    progress: state.progress,
    days_in_step: state.days_in_step,
    step_since: state.step_since,
    flag: state.flag,
    next: state.next,
    client_name: row.client_name ?? null,
    company_id: row.company_id ?? null,
    service: row.service ?? null,
    sales_person: row.sales_person ?? null,
    ...valueAt(state.step, row),
    value_hidden: false,
    records: {
      enquiry_no: row.enquiry_no ?? null,
      quotation_no: row.quotation_no ?? null,
      po_number: row.first_po_number ?? null,
      project_id: row.project_id ?? null,
    },
    started_on: startedOn(row),
  };
}

// ---------------------------------------------------------------- the drawer and the rail

const text = (label, value) => ({ label, value: value ?? null, kind: 'text' });
const date = (label, value) => ({ label, value: dayOf(value), kind: 'date' });
const amount = (label, value, currency) => ({ label, value: value ?? null, kind: 'money', currency: currency ?? null });

/** A step's facts, raw (numbers, ISO dates) for the web to format; up to six. */
export function stepFacts(key, row) {
  if (!hasRecord[key](row)) return [];
  if (key === 'enquiry') {
    return [
      date('Received', row.enquiry_date ?? row.enquiry_created_at),
      text('Source', row.enquiry_source),
      text('Owner', row.enquiry_sales_person),
      amount('Estimate', row.enquiry_estimated_value, row.enquiry_currency),
      text('Status', row.enquiry_status),
      ...(row.enquiry_unqualified_reason ? [text('Unqualified because', row.enquiry_unqualified_reason)] : []),
    ];
  }
  if (key === 'quotation') {
    const lost = quotationLost(row);
    // "No answer yet" is only true while the quotation is open.
    const answer = row.accepted_at
      ? [date('Accepted on', row.accepted_at)]
      : wonReached(row) || lost ? [] : [text('Client said', 'No answer yet')];
    return [
      text('Quotation no.', row.quotation_no),
      date('Date', row.quotation_date),
      amount('Value', row.quotation_value, row.quotation_currency),
      date('Sent', row.sent_at),
      ...answer,
      // Once lost, why it was lost is what is worth knowing, not when it might have closed.
      lost ? text('Lost because', row.lost_reason) : date('Expected close', row.expected_close_date),
    ];
  }
  const count = num(row.po_count);
  // Across currencies there is no one figure to show, and none is made up.
  const several = !row.po_currency;
  const sum = (label, value) => (several ? text(label, 'In several currencies') : amount(label, value, row.po_currency));
  return [
    text('PO no.', count > 1 ? `${row.first_po_number} +${count - 1} more` : row.first_po_number),
    date('Registered', row.first_po_date ?? row.first_po_created_at),
    sum('Value', row.po_value_total),
    sum('Invoiced', row.invoiced_total),
    sum('Received', row.received_total),
    // When something is overdue that is the date that matters, and the next due is the overdue one anyway.
    num(row.overdue_stages) > 0 ? sum('Overdue', row.overdue_amount) : date('Next stage due', row.next_stage_due),
  ];
}

/** The record behind a step, as the rail labels it; null for a step with none. */
export function stepRecord(key, row) {
  if (!hasRecord[key](row)) return null;
  if (key === 'enquiry') return { kind: 'enquiry', no: row.enquiry_no, date: dayOf(row.enquiry_date ?? row.enquiry_created_at) };
  if (key === 'quotation') return { kind: 'quotation', no: row.quotation_no, date: dayOf(row.quotation_date ?? row.quotation_created_at) };
  return { kind: 'po', no: row.first_po_number, date: dayOf(row.first_po_date ?? row.first_po_created_at), count: num(row.po_count) };
}

/**
 * One journey in full, for GET /api/journey/of: the card, and each of the
 * three steps with its state, record, facts and small steps. Small steps are
 * filled for every step with a record, so the drawer can open any of them.
 */
export function journeyDetail(row, settings = DEFAULT_SETTINGS, today = businessToday()) {
  const state = journeyState(row, settings, today);
  return {
    ...toCard(row, state),
    steps: STEPS.map(({ key, label }, i) => ({
      key,
      label,
      state: state.progress[i],
      record: stepRecord(key, row),
      since: stepSince(key, row),
      small: hasRecord[key](row) ? smallSteps(key, row).steps : [],
      facts: stepFacts(key, row),
    })),
  };
}

// ---------------------------------------------------------------- §3.7 funnel

/**
 * Is this row in the named cohort? Membership asks only what has happened, so
 * exited sales count. Each cohort holds the next: a sale ordered with no
 * quotation on record still got past quoting, so the funnel never widens.
 */
export function inCohort(row, cohort) {
  if (cohort === 'started') return true;
  if (cohort === 'quoted') return hasRecord.quotation(row) || hasPo(row);
  if (cohort === 'won') return wonReached(row) || hasPo(row);
  if (cohort === 'with_po') return hasPo(row);
  return false;
}

const startedIn = (row, from, to) => {
  const started = startedOn(row);
  return started != null && started >= from && started <= to;
};

/** The funnel for sales started in [from, to]: counts only, the web divides. */
export function funnel(rows, from, to) {
  const cohort = rows.filter((r) => startedIn(r, from, to));
  return Object.fromEntries(COHORTS.map((name) => [name, cohort.filter((r) => inCohort(r, name)).length]));
}

// ---------------------------------------------------------------- §3.8 the board

/**
 * Whether a card is on the board. By default the open sales, and paid ones
 * for `paid_visible_days` after their last payment. `closed` shows them all;
 * a cohort shows exactly its members, closed ones included, so the funnel
 * figure opens the records behind it (spec D9).
 */
export function visibleOnBoard(row, state, settings, today, { closed = false, cohort = null, period = null } = {}) {
  if (cohort) return startedIn(row, period.from, period.to) && inCohort(row, cohort);
  if (closed) return true;
  if (!state.exit) return true;
  if (state.exit !== 'paid') return false;
  const paid = dayOf(row.last_paid_on);
  return paid != null && daysBetween(paid, today) <= settings.paid_visible_days;
}

const TONE_ORDER = { late: 0, waiting: 1, info: 2 };
const toneRank = (card) => TONE_ORDER[card.flag?.tone] ?? 3;

/** By step, then the flags that need someone first, then the longest waiting. */
export function compareCards(a, b) {
  return ORDER.indexOf(a.step) - ORDER.indexOf(b.step)
    || toneRank(a) - toneRank(b)
    || (b.days_in_step ?? -1) - (a.days_in_step ?? -1)
    || String(a.key).localeCompare(String(b.key));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The three columns' figures, counted from the cards returned, so scoping
 * and filtering narrow the cards and change no arithmetic. Every card with a
 * value in rupees adds it, POs in several currencies included (each PO is
 * converted at its own date). A value with no rate for its date is left out
 * of the rupees and counted as such; a value hidden from this caller is in
 * neither.
 */
export function summariseSteps(cards) {
  // A PO card with no value of its own and none hidden is one in several currencies.
  const toConvert = (c) => !c.value_hidden && (c.value != null || (c.step === 'po' && !c.currency));
  return STEPS.map(({ key, label }) => {
    const here = cards.filter((c) => c.step === key);
    const converted = here.filter((c) => c.value_inr != null);
    return {
      key,
      label,
      count: here.length,
      value_inr: Math.round(converted.reduce((t, c) => t + Number(c.value_inr), 0) * 100) / 100,
      without_rate: here.filter((c) => c.value_inr == null && toConvert(c)).length,
      median_days: median(here.map((c) => c.days_in_step).filter((d) => d != null)),
    };
  });
}

/**
 * GET /api/journey from the rows this caller may see, already narrowed by
 * owner and service. The funnel is counted before the board's own switches
 * (stuck, closed, cohort), so pressing a figure shows the same number of cards.
 * `stuck_count` is counted before the Stuck only switch, so the switch can
 * say how many it would keep whether it is on or off. `shown` lets a caller
 * (the route, for a restricted scope) narrow what a card says about records
 * it does not own.
 */
export function journeyBoard(rows, settings, today, { period, stuck = false, closed = false, cohort = null, shown = (card) => card } = {}) {
  const cards = [];
  let stuckCount = 0;
  for (const row of rows) {
    const state = journeyState(row, settings, today);
    if (!visibleOnBoard(row, state, settings, today, { closed, cohort, period })) continue;
    const isStuck = STUCK_KINDS.includes(state.flag?.kind);
    if (isStuck) stuckCount += 1;
    if (stuck && !isStuck) continue;
    cards.push(shown(toCard(row, state), row));
  }
  cards.sort(compareCards);
  return {
    period,
    funnel: funnel(rows, period.from, period.to),
    steps: summariseSteps(cards),
    stuck_count: stuckCount,
    cards,
    settings,
  };
}

// ---------------------------------------------------------------- §6 records the caller does not own

/**
 * Which steps' records this scope may open, by the same reach each record's
 * own page gives (auth/ownership.js): an enquiry and a quotation by their
 * owner; the PO step only when every live PO it adds up opens, each by the
 * owner of the quotation it names or of its project, which queries.js asks
 * the database (`po_reachable`, poReachColumn). An admin reaches every step.
 */
export function reachableSteps(row, scope) {
  if (scope.unrestricted) return { enquiry: true, quotation: true, po: true };
  const me = Number(scope.ownerId);
  const owns = (id) => id != null && Number(id) === me;
  return {
    enquiry: owns(row.enquiry_owner_id),
    quotation: owns(row.quotation_owner_id),
    po: row.po_reachable === true,
  };
}

/**
 * A card as a caller sees it: when the current step's record is someone
 * else's, its value and the amount in an overdue flag are left out (spec D7,
 * §9 question 1: the number only), and so is the next action, which opens a
 * record they cannot. Where the sale is still shows.
 */
export function cardFor(card, row, scope) {
  if (reachableSteps(row, scope)[card.step]) return card;
  const flag = card.flag?.kind === 'overdue'
    ? { ...card.flag, label: `${plural(num(row.overdue_stages), 'stage')} overdue` }
    : card.flag;
  return { ...card, value: null, currency: null, value_inr: null, value_hidden: true, flag, next: null };
}

/**
 * One journey as a caller sees it: each step says whether its record can be
 * opened, and a step whose record is someone else's keeps its number, state
 * and small steps (the card says as much) but not its facts.
 */
export function detailFor(detail, row, scope) {
  const reach = reachableSteps(row, scope);
  return {
    ...cardFor(detail, row, scope),
    steps: detail.steps.map((s) => (reach[s.key] || !s.record
      ? { ...s, reachable: Boolean(s.record) }
      : { ...s, reachable: false, facts: [] })),
  };
}
