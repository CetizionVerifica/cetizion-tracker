/**
 * The Journey board and its step drawer, the pure half
 * (docs/specs/sales-journey §4 B; web/src/components/journey/CLAUDE.md §3):
 * which filters sit in the address bar, what the board asks the server for,
 * the funnel's conversion chips, and the few words the board puts round what
 * the server sends. No React, so test/journeyBoard.test.js reads it directly.
 *
 * Nothing here decides where a sale is. The step, the small step, days in
 * step, the flag and the next action all arrive from the server
 * (server/src/lib/journey/CLAUDE.md §3). This divides two of its counts,
 * sorts its cards into columns and says them in words, and that is all.
 */
import { JOURNEY_STEPS, daysText, railProps, stepBadge } from '../../lib/journey.js';
import { date, money, number } from '../../lib/format.js';
import { presetPeriod } from '../../lib/reportPeriods.js';

/* ---------------------------------------------------------------- period */

/**
 * The funnel's period, as the toolbar offers it. Last 90 days is the
 * default, and the server's too, so it is the one period the address bar
 * never has to carry.
 */
export const PERIODS = [
  { key: 'last-30', label: 'Last 30 days', days: 30 },
  { key: 'last-90', label: 'Last 90 days', days: 90 },
  { key: 'last-365', label: 'Last 365 days', days: 365 },
  { key: 'this-fy', label: 'This financial year' },
];
export const DEFAULT_PERIOD = 'last-90';

const DAY_MS = 86_400_000;

/** `n` days before a YYYY-MM-DD date, on the calendar, as the server counts them. */
function daysBefore(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

/** { from, to } for a period as of `today`. The financial year runs April to March. */
export function periodRange(key, today) {
  const period = PERIODS.find((p) => p.key === key);
  if (!period) return null;
  if (period.days) return { from: daysBefore(today, period.days), to: today };
  return presetPeriod('this-fy', today);
}

/** Which of the toolbar's periods a from/to pair is, or "custom". */
function periodOf(from, to, today) {
  const match = PERIODS.find((p) => {
    const range = periodRange(p.key, today);
    return range.from === from && range.to === to;
  });
  return match?.key ?? 'custom';
}

/**
 * The period in words, to follow a verb: "in the last 90 days", "in this
 * financial year", or "between 1 Aug 2026 and 25 Oct 2026" for dates a link
 * brought that are none of the toolbar's.
 */
export function periodPhrase(filters) {
  const period = PERIODS.find((p) => p.key === filters?.period);
  if (period?.days) return `in the last ${number(period.days)} days`;
  if (period) return 'in this financial year';
  return `between ${date(filters?.from)} and ${date(filters?.to)}`;
}

/* --------------------------------------------------------------- filters */

/** The funnel's four figures, in order, and how each reads after a percentage. */
export const FUNNEL = [
  { key: 'started', label: 'Started', word: 'started' },
  { key: 'quoted', label: 'Quoted', word: 'quoted' },
  { key: 'won', label: 'Won', word: 'won' },
  { key: 'with_po', label: 'With PO', word: 'with a PO' },
];
const COHORTS = FUNNEL.map((f) => f.key);

/** Every key the board keeps in the address bar (web layer §2, JourneyBoard). */
export const BOARD_KEYS = ['sales_person', 'service', 'stuck', 'closed', 'from', 'to', 'cohort'];

/** A real YYYY-MM-DD day: 30 Feb parses, as 2 Mar, so it is read back to be sure. */
const isDay = (v) => {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? Date.parse(`${v}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const isOn = (v) => v === '1' || v === 'true';

/**
 * The board's filters read off the address bar, with anything unreadable
 * left at its default, so a link or a bookmark is the board it was.
 *
 * The period travels as its dates (`from`, `to`), the way the server takes
 * it; `period` names which of the toolbar's choices those dates are. No
 * dates is the default period, worked out by the server.
 */
export function readBoardQuery(params, today) {
  const get = (key) => (params.get(key) || '').trim();
  let from = get('from');
  let to = get('to');
  let period = DEFAULT_PERIOD;
  if (isDay(from) && isDay(to) && from <= to) period = periodOf(from, to, today);
  if (period === DEFAULT_PERIOD) { from = ''; to = ''; }
  return {
    sales_person: get('sales_person'),
    service: get('service'),
    stuck: isOn(get('stuck')),
    closed: isOn(get('closed')),
    period,
    from,
    to,
    cohort: COHORTS.includes(get('cohort')) ? get('cohort') : '',
  };
}

/**
 * The filters written back into an address, with defaults left out. Keys
 * that are not the board's (the page's own, a follow-up link's) stay as
 * they were.
 */
export function writeBoardQuery(filters, base = new URLSearchParams()) {
  const next = new URLSearchParams(base);
  for (const key of BOARD_KEYS) next.delete(key);
  if (filters.sales_person) next.set('sales_person', filters.sales_person);
  if (filters.service) next.set('service', filters.service);
  if (filters.stuck) next.set('stuck', '1');
  if (filters.closed) next.set('closed', '1');
  if (filters.period !== DEFAULT_PERIOD && filters.from && filters.to) {
    next.set('from', filters.from);
    next.set('to', filters.to);
  }
  if (filters.cohort) next.set('cohort', filters.cohort);
  return next;
}

/**
 * The address after one change on the toolbar. A new `period` brings its
 * own dates; anything else is taken as given.
 */
export function withFilters(params, changes, today) {
  const filters = { ...readBoardQuery(params, today), ...changes };
  if (changes.period && changes.period !== 'custom') {
    const range = changes.period === DEFAULT_PERIOD ? { from: '', to: '' } : periodRange(changes.period, today);
    Object.assign(filters, range);
  }
  return writeBoardQuery(filters, params);
}

/** What GET /api/journey is asked for. journeyBoard() leaves the blanks out. */
export function boardRequest(filters) {
  return {
    sales_person: filters.sales_person,
    service: filters.service,
    stuck: filters.stuck ? '1' : '',
    closed: filters.closed ? '1' : '',
    from: filters.from,
    to: filters.to,
    cohort: filters.cohort,
  };
}

/** Whether anything narrows the board, so an empty one can say so and offer to clear it. */
export function isFiltered(filters) {
  return Boolean(filters.sales_person || filters.service || filters.stuck || filters.closed || filters.cohort);
}

/* ---------------------------------------------------------------- funnel */

/**
 * One figure as a share of the one before it, as a whole percentage, or
 * null when there is nothing to divide by. The server sends counts only
 * (server §3.7), so this division is the one sum the board does.
 */
export function conversion(n, of) {
  const top = Number(n);
  const bottom = Number(of);
  if (n === null || n === undefined || !Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) return null;
  return Math.round((top / bottom) * 100);
}

/** "74% quoted", or null when the figure before it is nought. */
export function conversionText(n, of, word) {
  const pct = conversion(n, of);
  return pct === null ? null : `${pct}% ${word}`;
}

/** The four figures with their counts, each after the first carrying its chip. */
export function funnelFigures(funnel) {
  return FUNNEL.map((figure, i) => {
    const count = Number(funnel?.[figure.key] ?? 0);
    const before = i ? Number(funnel?.[FUNNEL[i - 1].key] ?? 0) : null;
    return { ...figure, count, conversion: i ? conversionText(count, before, figure.word) : null };
  });
}

/** The chip an active cohort shows: "Showing: quoted in the last 90 days". */
export function cohortChipText(filters) {
  const figure = FUNNEL.find((f) => f.key === filters?.cohort);
  return figure ? `Showing: ${figure.word} ${periodPhrase(filters)}` : null;
}

/* --------------------------------------------------------------- columns */

/** The three columns, each with the server's summary and its own cards, in the server's order. */
export function boardColumns(data) {
  return JOURNEY_STEPS.map((step) => {
    const summary = data?.steps?.find((s) => s.key === step.key) || {};
    const cards = (data?.cards || []).filter((card) => card.step === step.key);
    return {
      ...step,
      count: Number(summary.count ?? 0),
      value_inr: summary.value_inr ?? null,
      without_rate: Number(summary.without_rate ?? 0),
      median_days: summary.median_days ?? null,
      // Values the server leaves out because their records are someone else's (server §6).
      hidden: cards.filter((card) => card.value_hidden).length,
      cards,
    };
  });
}

/**
 * A column's value in rupees. With none to add up, it says why: every card
 * is someone else's ("Owner only", as the cards say), or there is no value.
 */
export function columnValueText(column) {
  if (column?.value_inr) return money(column.value_inr, 'INR', { compact: true });
  return column?.hidden && column.hidden === column.count ? 'Owner only' : 'No value';
}

/** The note when some, not all, of a column's values are someone else's and left out of its total. */
export function hiddenText(column) {
  const n = column?.hidden || 0;
  if (!n || n === column.count) return null;
  return n === 1
    ? '1 sale is left out of the value: its record is another owner\'s.'
    : `${number(n)} sales are left out of the value: their records are other owners'.`;
}

/** "median 4 days here", or nothing when the column is empty. */
export function medianText(days) {
  if (days === null || days === undefined || days === '' || Number.isNaN(Number(days))) return null;
  const n = Math.round(Number(days));
  return `median ${number(n)} ${n === 1 ? 'day' : 'days'} here`;
}

/** Why a column's value leaves some sales out, and where to put that right. */
export function withoutRateText(n) {
  if (!n) return null;
  return n === 1
    ? '1 sale is left out of the value: no exchange rate for its currency on its date. Add it under Settings, Exchange rates.'
    : `${number(n)} sales are left out of the value: no exchange rate for their currency on their date. Add it under Settings, Exchange rates.`;
}

/* ----------------------------------------------------------------- cards */

/**
 * A card's value in its own currency. A missing one says so rather than
 * reading ₹0 (web/CLAUDE.md §6); POs in two currencies have no one figure,
 * and none is made up.
 */
export function cardValue(card) {
  // The record is someone else's (server §6): it has a value, just not one to show here.
  if (card?.value_hidden) return 'Owner only';
  const missing = card?.value === null || card?.value === undefined || card?.value === '';
  // POs in several currencies have no one figure in theirs; the server's
  // rupees, each PO at its own date's rate, when every one has a rate.
  if (card?.step === 'po' && missing && !card.currency) {
    return card.value_inr != null ? `${money(card.value_inr, 'INR')} across currencies` : 'Several currencies';
  }
  if (missing) return card?.step === 'enquiry' ? 'No estimate' : 'No value';
  return money(card.value, card.currency || 'INR');
}

const EXITS = {
  lost: { label: 'Lost', tone: 'late' },
  unqualified: { label: 'Unqualified', tone: 'late' },
  paid: { label: 'Paid', tone: 'settled' },
};

/** The chip on a sale that has left the journey, or null for one still on it. */
export function exitChip(exit) {
  return EXITS[exit] ?? null;
}

/**
 * What sits beside a card's value: where it stopped, else its flag, else
 * plain days in step. Exactly one, so the card says one thing about time.
 */
export function cardStatus(card) {
  const exit = exitChip(card?.exit);
  if (exit) return { chip: exit };
  if (card?.flag) return { chip: { label: card.flag.label, tone: card.flag.tone } };
  const days = daysText(card?.days_in_step);
  return days ? { days } : {};
}

/* ---------------------------------------------------------------- drawer */

/**
 * The record the drawer asks the server about, by the number its page uses.
 * The quotation first: when a sale has one it is what the journey hangs on
 * (server §2), and an enquiry or PO alone is the whole sale otherwise.
 */
export function journeyLookup(card) {
  const records = card?.records || {};
  if (records.quotation_no) return { quotation: records.quotation_no };
  if (records.enquiry_no) return { enquiry: records.enquiry_no };
  if (records.po_number) return { po: records.po_number };
  return null;
}

/** The step the drawer opens on: where the sale is, or where it stopped. */
export function openingStep(card) {
  const at = (card?.progress || []).findIndex((state) => state === 'current' || state === 'exit');
  if (at >= 0 && JOURNEY_STEPS[at]) return JOURNEY_STEPS[at].key;
  return JOURNEY_STEPS.some((s) => s.key === card?.step) ? card.step : JOURNEY_STEPS[0].key;
}

/** The step `delta` along from `key`, stopping at either end rather than wrapping. */
export function stepAfter(key, delta) {
  const at = JOURNEY_STEPS.findIndex((s) => s.key === key);
  const next = Math.min(JOURNEY_STEPS.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta));
  return JOURNEY_STEPS[next].key;
}

/**
 * The lines under a step in the drawer's rail: the record's number, then
 * its date and how many more. Two lines rather than the record rail's one,
 * because the drawer's rail is narrow and a number like CTZ/ENQ/2026/004
 * broken across lines reads as two numbers.
 */
function recordLines(step) {
  const record = step.record;
  if (!record) return step.state === 'skipped' ? ['Not recorded'] : [];
  const more = Number(record.count) > 1 ? `+${number(record.count - 1)} more` : null;
  const rest = [record.date && date(record.date), more].filter(Boolean).join(' · ');
  return [record.no, rest].filter(Boolean);
}

/**
 * The drawer's three steps, from the full journey once it has arrived and
 * from the card's progress until then, so the rail is there at once and
 * fills in. The eyebrow is the record rail's (railProps), so the drawer and
 * the page say where a sale is the same way.
 */
export function drawerView(card, detail) {
  const journey = detail?.steps?.length
    ? detail
    : { ...card, steps: JOURNEY_STEPS.map((step, i) => ({ ...step, state: card?.progress?.[i] ?? 'future' })) };
  const steps = journey.steps.map((step) => ({
    key: step.key,
    label: step.label,
    state: step.state,
    lines: recordLines(step),
    record: step.record ?? null,
    // Unknown until the journey arrives; only the server's false closes a record.
    reachable: step.reachable !== false,
    since: step.since ?? null,
    small: step.small ?? [],
    facts: step.facts ?? [],
  }));
  return { steps, nowLabel: railProps(journey).nowLabel, badge: stepBadge(journey) };
}

/** What a step is, in words, for a screen reader and for the drawer's chip. */
export const STATE_WORDS = {
  done: 'Done',
  current: 'Now',
  exit: 'Stopped here',
  skipped: 'Not recorded',
  future: 'To come',
};

const TIMELINE_ENTITIES = { enquiry: 'enquiry', quotation: 'quotation', po: 'purchase_order' };

/** The `<Timeline>` of a step's record: `{ entity, id }`, or null without one. */
export function timelineOf(record) {
  const entity = TIMELINE_ENTITIES[record?.kind];
  return entity && record.no ? { entity, id: record.no } : null;
}
