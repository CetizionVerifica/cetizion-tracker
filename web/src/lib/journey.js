/**
 * The sales journey, the browser's half (docs/specs/sales-journey): the two
 * calls that read it, where each of its records lives, and how the rail on a
 * record page turns one journey into steps.
 *
 * Nothing here decides where a sale is. The server works out the step, the
 * small steps, days in step, the flag and the next action
 * (server/src/lib/journey/CLAUDE.md §3); this file only says it. No React,
 * so test/journey.test.js reads it directly.
 */
import { api } from './api.js';
import { date, money, number } from './format.js';

/** The three big steps, in order, labelled the same everywhere. */
export const JOURNEY_STEPS = [
  { key: 'enquiry', label: 'Enquiry' },
  { key: 'quotation', label: 'Quotation' },
  { key: 'po', label: 'PO' },
];

/** `?a=b&c=d` from an object, leaving out blanks the way api.js does for lists. */
function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

/** Every open sale by step, with the funnel for a period: GET /api/journey. */
export async function journeyBoard(params) {
  const { data } = await api.raw(`/journey${query(params)}`);
  return data;
}

/**
 * The one journey that holds a record: `{ enquiry }`, `{ quotation }`,
 * `{ po }` or `{ project }`, each the number or id the record's own page
 * uses. Enquiry numbers carry slashes, which travel encoded in the query.
 */
export async function journeyOf(of) {
  const { data } = await api.raw(`/journey/of${query(of)}`);
  return data;
}

const RECORD_PATHS = {
  enquiry: '/enquiries',
  quotation: '/quotations',
  po: '/purchase-orders',
  project: '/projects',
};

/**
 * Where a record's page is, or null when there is no number to go to.
 *
 * Every link to a journey record goes through here, because the numbers
 * are not path-safe: `CTZ/ENQ/2026/004` has slashes and `PO 4500183` a
 * space, and a link built by hand breaks on the first of them.
 */
export function recordPath(kind, no) {
  const base = RECORD_PATHS[kind];
  if (!base || no === null || no === undefined || String(no).trim() === '') return null;
  return `${base}/${encodeURIComponent(no)}`;
}

/** Which of a card's records belongs to each big step. */
const STEP_RECORDS = {
  enquiry: ['enquiry', 'enquiry_no'],
  quotation: ['quotation', 'quotation_no'],
  po: ['po', 'po_number'],
};

/**
 * The record of the step the sale is on, which is where its next action
 * lives (spec C4): a card's button opens that page rather than acting on
 * the board.
 */
export function currentRecordPath(card) {
  const [kind, field] = STEP_RECORDS[card?.step] || [];
  return kind && field ? recordPath(kind, card.records?.[field]) : null;
}

/**
 * Whether two paths are the same page, however each was encoded. A link
 * built with recordPath reads `%2F` where the address bar may hold either.
 */
export function samePath(a, b) {
  const clean = (path) => {
    let text = String(path || '');
    try { text = decodeURIComponent(text); } catch { /* a stray % stays as typed */ }
    return text.replace(/\/+$/, '');
  };
  return clean(a) === clean(b);
}

/**
 * One of a step's facts as it reads on screen. The server sends values raw
 * (numbers and ISO dates) with their kind; a missing amount says so rather
 * than showing ₹0 (web/CLAUDE.md §6).
 */
export function factValue(fact) {
  const value = fact?.value;
  if (value === null || value === undefined || value === '') return fact?.kind === 'money' ? 'No value' : '—';
  if (fact.kind === 'money') return money(value, fact.currency || 'INR');
  if (fact.kind === 'date') return date(value);
  if (fact.kind === 'number') return number(value);
  return String(value);
}

/** "Today", "1 day", "12 days": how long the sale has been on its step. */
export function daysText(days) {
  if (days === null || days === undefined || days === '' || Number.isNaN(Number(days))) return null;
  const n = Number(days);
  if (n <= 0) return 'Today';
  return `${number(n)} ${n === 1 ? 'day' : 'days'}`;
}

/**
 * The chip on the current step: days in step, in the flag's tone.
 *
 * Stuck and slow are flags *about* days in step, so their label is the
 * same figure in the server's words ("Stuck 48 days"). Any other flag (a
 * discount waiting, an overdue stage) lends only its tone: what it is
 * about is the page's sentence, right under the rail.
 */
export function stepBadge(journey) {
  const flag = journey?.flag;
  if (flag && (flag.kind === 'stuck' || flag.kind === 'slow')) return { label: flag.label, tone: flag.tone };
  const label = daysText(journey?.days_in_step);
  return label ? { label, tone: flag?.tone || 'plain' } : null;
}

const EXIT_WORDS = { lost: 'Lost', unqualified: 'Unqualified' };

/** The record line under a step: its number and date, and how many more. */
function recordLine(record) {
  const more = Number(record.count) > 1 ? `+${number(record.count - 1)} more` : null;
  return [record.no, record.date && date(record.date), more].filter(Boolean).join(' · ');
}

/**
 * One journey, as the rail on a record page draws it.
 *
 * A step with a record links to it and shows its number and date, and its
 * first three facts are the preview on hover. The record whose page this
 * is (`pathname`) is one exception: a link to the page you are on is a
 * dead end, so it shows its number and nothing to press. A record the
 * caller does not own (`reachable: false`) is the other. The current step
 * carries days in step and its small steps; a sale that stopped says where.
 *
 * `facts` rides along on each step for the component to turn into the
 * preview; everything else is a FlowStep prop as it stands.
 */
export function railProps(journey, pathname = '') {
  const given = journey?.steps || [];
  const steps = given.map((step) => {
    // A record someone else owns shows its number but is not a link: its page would refuse.
    const path = step.record && step.reachable !== false ? recordPath(step.record.kind, step.record.no) : null;
    const elsewhere = Boolean(path) && !samePath(path, pathname);
    return {
      label: step.label,
      state: step.state,
      to: elsewhere ? path : undefined,
      meta: step.record ? recordLine(step.record) : undefined,
      badge: step.state === 'current' ? stepBadge(journey) || undefined : undefined,
      facts: elsewhere ? (step.facts || []).slice(0, 3) : [],
    };
  });

  const now = given.find((step) => step.state === 'current');
  const stopped = given.find((step) => step.state === 'exit') || given.find((step) => step.key === journey?.step);
  let nowLabel;
  if (journey?.exit === 'paid') nowLabel = 'Complete · paid';
  else if (journey?.exit) nowLabel = `${EXIT_WORDS[journey.exit] || 'Stopped'} at ${stopped?.label || 'this step'}`;
  else if (now) nowLabel = `Now · ${now.label}${journey.small_step ? ` · ${journey.small_step}` : ''}`;

  return {
    steps,
    nowLabel,
    substeps: now?.small?.length ? { label: `Inside ${now.label}`, steps: now.small } : undefined,
  };
}
