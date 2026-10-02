import { UNRESTRICTED, scopedSources } from '../auth/ownership.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { ApiError } from '../middleware/error.js';
import { nameKey, normalizeName } from './names.ts';
import { MONTH_NAMES } from './reportFormat.js';
import { r2 } from './reportMath.ts';
import { RATES, inPeriod, poCountsAsSale, poQuotationNo, rateOn, staleAmong } from './salesReport.js';
import { monthLabel } from './revenueReport.js';
import { SERVICE_LINES, serviceLinesFor } from './serviceLines.js';
import { ENQUIRY_STATUS, QUOTATION_STATUS } from './statuses.js';

/**
 * The Reports section's six questions, each defined once (see
 * docs/sales-report-rework-plan.md §4). The screen, the CSVs and the PDF all
 * call these, so the three can never disagree about what a number means.
 *
 * Built in steps. This file so far answers:
 *
 *   1. How many enquiries did we receive, per day, week or month?   §4.1
 *   2. What happened to them: converted, pipeline, lost, quoted–not–won? §4.2
 *   3. Which sectors gave us POs?                                   §4.3
 *   4. Which services sell best?                                    §4.4
 *   6. What is the revenue each month, and which sales make it up?  §4.6
 *
 * The pure functions at the top take rows and return figures, so the rules
 * can be tested without a database. The queries below them fetch exactly the
 * rows those functions read.
 */

// ---------------------------------------------------------------------
// Periods and buckets
// ---------------------------------------------------------------------

export const GRAINS = ['day', 'week', 'month'];

const DAY_MS = 86_400_000;
const toDay = (date) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDay = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Calendar days from `from` to `to`, both included. */
export const daysIn = (from, to) => toDay(to) - toDay(from) + 1;

/**
 * The bucket size a period reads best in: a month or less by day, up to six
 * months by week, anything longer by month. With no period there is no
 * telling how long it is, so month.
 */
export function defaultGrain({ from, to } = {}) {
  if (!from || !to) return 'month';
  const days = daysIn(from, to);
  if (days <= 31) return 'day';
  if (days <= 186) return 'week';
  return 'month';
}

/** ?grain= off a request, or the default for the period when absent or unknown. */
export function reportGrain(reqQuery, period) {
  const asked = String(reqQuery.grain ?? '').trim();
  return GRAINS.includes(asked) ? asked : defaultGrain(period);
}

/** The Monday on or before a date: ISO weeks start on Monday. */
export function weekStart(date) {
  const day = toDay(date);
  // 1 January 1970 was a Thursday, so day 0 is weekday 4 (Sunday 0).
  const weekday = (((day + 4) % 7) + 7) % 7;
  return fromDay(day - ((weekday + 6) % 7));
}

/** The bucket a YYYY-MM-DD date falls in: the date, its week's Monday, or YYYY-MM. */
export function bucketOf(date, grain) {
  if (!date) return null;
  if (grain === 'day') return date;
  if (grain === 'week') return weekStart(date);
  return date.slice(0, 7);
}

const dayMonth = (date) => `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`;

/** "6 Oct", "w/c 6 Oct" or "Oct 2026"; "No date" for the undated row. */
export function bucketLabel(key, grain) {
  if (!key) return monthLabel(null);
  if (grain === 'day') return dayMonth(key);
  if (grain === 'week') return `w/c ${dayMonth(key)}`;
  return monthLabel(key);
}

/** Every bucket key from the one holding `first` to the one holding `last`. */
export function bucketsBetween(first, last, grain) {
  const keys = [];
  if (grain === 'month') {
    let [year, month] = first.slice(0, 7).split('-').map(Number);
    const [lastYear, lastMonth] = last.slice(0, 7).split('-').map(Number);
    while (year < lastYear || (year === lastYear && month <= lastMonth)) {
      keys.push(`${year}-${String(month).padStart(2, '0')}`);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    return keys;
  }
  const step = grain === 'week' ? 7 : 1;
  const end = toDay(bucketOf(last, grain));
  for (let day = toDay(bucketOf(first, grain)); day <= end; day += step) keys.push(fromDay(day));
  return keys;
}

/**
 * More buckets than a chart can show, or a person can read. A whole
 * financial year by day (366) still fits; ten years by day does not, and
 * falls back to a coarser grain (see fitGrain).
 */
export const MAX_BUCKETS = 400;

/**
 * The grain actually used: the one asked for, or the next coarser one when it
 * would make more than MAX_BUCKETS buckets. Months always fit in practice.
 */
export function fitGrain(first, last, grain) {
  if (!first || !last) return grain;
  for (const g of GRAINS.slice(GRAINS.indexOf(grain))) {
    if (g === 'month' || bucketsBetween(first, last, g).length <= MAX_BUCKETS) return g;
  }
  return 'month';
}

/**
 * monthRows (revenueReport.js) for any grain. One row per bucket from the
 * period's start to its end (or the first to the last dated row when the
 * period is open), quiet buckets included, then a "No date" row for rows with
 * no date. The rows always add up to the total.
 *
 * `rows` carry their date as `date` (YYYY-MM-DD).
 */
export function periodRows(rows, { from, to } = {}, grain, summarise) {
  const dated = rows.filter((row) => row.date).map((row) => row.date).sort();
  const first = from || dated[0] || to;
  const last = to || dated.at(-1) || from;
  const buckets = new Map((first && last ? bucketsBetween(first, last, grain) : []).map((key) => [key, []]));
  const undated = [];
  for (const row of rows) {
    if (!row.date) { undated.push(row); continue; }
    const key = bucketOf(row.date, grain);
    // Outside an explicit period only if the caller passed rows it should
    // not have; kept rather than silently dropped.
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const result = [...buckets.keys()].sort().map((key) => ({ key, label: bucketLabel(key, grain), ...summarise(buckets.get(key)) }));
  if (undated.length) result.push({ key: null, label: bucketLabel(null, grain), ...summarise(undated) });
  return result;
}

/**
 * Whole-number percentages of `counts` that add up to exactly 100 (largest
 * remainder), or nulls when there is nothing to divide. share() alone would
 * print 33 + 33 + 33 and leave the reader to wonder where 1% went.
 */
export function percentages(counts) {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (!total) return counts.map(() => null);
  const exact = counts.map((n) => (n * 100) / total);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((sum, n) => sum + n, 0);
  const order = exact
    .map((value, i) => ({ i, remainder: value - floors[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

// ---------------------------------------------------------------------
// 1. Enquiries received (§4.1)
// ---------------------------------------------------------------------

const NO_SOURCE = 'Not set';

/**
 * Enquiries per bucket, split by lead source.
 *
 * `rows`: { enquiry_no, date, dated_by_creation, source } — `date` is the
 * enquiry date, or the day the record was created when that is blank
 * (dated_by_creation says which, so the report can count them).
 */
export function enquiriesReceived(rows, period, grain) {
  const counts = new Map();
  for (const row of rows) {
    const source = row.source || NO_SOURCE;
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  // Most enquiries first; "Not set" last whatever its size.
  const sources = [...counts.keys()]
    .sort((a, b) => (a === NO_SOURCE) - (b === NO_SOURCE) || counts.get(b) - counts.get(a) || a.localeCompare(b));
  const summarise = (list) => {
    const bySource = Object.fromEntries(sources.map((s) => [s, 0]));
    for (const row of list) bySource[row.source || NO_SOURCE] += 1;
    return { enquiries: list.length, by_source: bySource };
  };
  const buckets = periodRows(rows, period, grain, summarise);
  const dated = buckets.filter((b) => b.key);
  const busiest = dated.reduce((best, b) => (b.enquiries > (best?.enquiries ?? 0) ? b : best), null);
  return {
    grain,
    buckets,
    sources: sources.map((name) => ({ name, enquiries: counts.get(name) })),
    total: rows.length,
    average_per_bucket: dated.length ? r2(rows.filter((row) => row.date).length / dated.length) : null,
    busiest: busiest ? { key: busiest.key, label: busiest.label, enquiries: busiest.enquiries } : null,
    dated_by_creation: rows.filter((row) => row.dated_by_creation).length,
  };
}

// ---------------------------------------------------------------------
// 2. Enquiry outcome (§4.2)
// ---------------------------------------------------------------------

export const OUTCOMES = [
  { key: 'converted', label: 'Converted to PO' },
  { key: 'pipeline', label: 'In pipeline' },
  { key: 'quoted_not_won', label: 'Quoted, not won' },
  { key: 'lost', label: 'Lost' },
];

const OPEN_QUOTATION = [QUOTATION_STATUS.draft, QUOTATION_STATUS.submitted, QUOTATION_STATUS.negotiating, QUOTATION_STATUS.onHold];

/**
 * The one outcome an enquiry has at the end of the period. First match wins:
 *
 *   converted       a PO that counts as a sale, dated by the period's end, on
 *                   the quotation the enquiry led to
 *   (no quotation)  Unqualified → lost; anything else → pipeline, not quoted
 *   quoted_not_won  its quotation was lost by the period's end, or ran past
 *                   its validity while still open
 *   pipeline        its quotation is still open (or marked won with no PO yet)
 *
 * "Lost" is reserved for an enquiry that never became a quotation: a quotation
 * that did not win is a different story, told by quoted_not_won, so it
 * neither swells the pipeline nor counts as a lost lead.
 *
 * `row` is what outcomeRows fetches: status, quotation_no, has_po,
 * quotation_status, quotation_lost, quotation_expired — the last three
 * already judged as of the period's end.
 *
 * Returns { outcome, stage, notes } where stage splits the pipeline into
 * not_quoted / quoted, and notes name data worth fixing.
 */
export function enquiryOutcome(row) {
  const notes = [];
  if (row.status === ENQUIRY_STATUS.declined && row.quotation_no) notes.push('unqualified_with_quotation');
  if (row.has_po) return { outcome: 'converted', stage: null, notes };
  if (!row.quotation_no) {
    if (row.status === ENQUIRY_STATUS.declined) return { outcome: 'lost', stage: null, notes };
    if (row.status === ENQUIRY_STATUS.quoted) notes.push('converted_without_quotation');
    return { outcome: 'pipeline', stage: 'not_quoted', notes };
  }
  if (row.quotation_lost || row.quotation_expired) return { outcome: 'quoted_not_won', stage: null, notes };
  if (row.quotation_status === QUOTATION_STATUS.won) notes.push('won_without_po');
  else if (row.quotation_status && !OPEN_QUOTATION.includes(row.quotation_status)) notes.push('unknown_quotation_status');
  return { outcome: 'pipeline', stage: 'quoted', notes };
}

const NOTE_TEXT = {
  unqualified_with_quotation: (n) => `${n} enquir${n === 1 ? 'y is' : 'ies are'} marked Unqualified but already quoted; ${n === 1 ? 'it follows' : 'they follow'} the quotation.`,
  converted_without_quotation: (n) => `${n} enquir${n === 1 ? 'y is' : 'ies are'} marked Converted with no quotation linked, so ${n === 1 ? 'it is' : 'they are'} counted as not yet quoted.`,
  won_without_po: (n) => `${n} enquir${n === 1 ? 'y has' : 'ies have'} a quotation marked won with no PO registered by the period's end; counted in the pipeline.`,
  unknown_quotation_status: (n) => `${n} linked quotation${n === 1 ? ' has' : 's have'} a status this report does not know; counted in the pipeline.`,
};

/** Counts and % for each outcome. Percentages add up to 100. */
function outcomeCounts(classified) {
  const counts = OUTCOMES.map(({ key }) => classified.filter((c) => c.outcome === key).length);
  const pct = percentages(counts);
  return Object.fromEntries(OUTCOMES.map(({ key }, i) => [key, { count: counts[i], pct: pct[i] }]));
}

/**
 * The outcome section: the four slices with n and %, the pipeline's two
 * sub-rows, why quoted enquiries did not win, the split per month, the
 * enquiries behind each slice, and notes on data worth fixing.
 *
 * `rows` are outcomeRows' rows: the enquiry fields enquiryOutcome reads, plus
 * enquiry_no, client, date and lost_reason.
 */
export function outcomeSummary(rows, period) {
  const classified = rows.map((row) => ({ ...row, ...enquiryOutcome(row) }));
  const totals = outcomeCounts(classified);
  const reasons = new Map();
  for (const row of classified.filter((c) => c.outcome === 'quoted_not_won')) {
    const reason = row.quotation_lost ? row.lost_reason || 'No reason recorded' : 'Expired without a decision';
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  const noteCounts = new Map();
  for (const row of classified) for (const note of row.notes) noteCounts.set(note, (noteCounts.get(note) || 0) + 1);

  return {
    total: rows.length,
    slices: OUTCOMES.map(({ key, label }) => ({ key, label, ...totals[key] })),
    pipeline: {
      not_quoted: classified.filter((c) => c.stage === 'not_quoted').length,
      quoted: classified.filter((c) => c.stage === 'quoted').length,
    },
    quoted_not_won_reasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    // Month by month, whatever grain the enquiry chart uses: a 100% bar per
    // day would be unreadable, and outcome is a slow-moving thing.
    months: periodRows(classified, period, 'month', (list) => {
      const slice = outcomeCounts(list);
      return { enquiries: list.length, ...Object.fromEntries(OUTCOMES.map(({ key }) => [key, slice[key]])) };
    }),
    detail: classified.map((c) => ({
      enquiry_no: c.enquiry_no,
      client: c.client,
      date: c.date,
      status: c.status,
      quotation_no: c.quotation_no,
      outcome: c.outcome,
      stage: c.stage,
    })),
    notes: [...noteCounts].map(([key, count]) => ({ key, count, text: NOTE_TEXT[key](count) })),
  };
}

// ---------------------------------------------------------------------
// 3 and 4. Categories: sectors and service lines (§4.3, §4.4)
// ---------------------------------------------------------------------

export const OTHER = 'Other';
export const NOT_SET = 'Not set';

/** The settings rows that hold the headline categories, and what they start as. */
export const CATEGORY_SETTINGS = {
  report_sectors: ['Metal Industry', 'Agriculture', 'Pharmaceutical'],
  report_service_lines: SERVICE_LINES.map((line) => line.name),
};

const MAX_CATEGORIES = 20;

/**
 * A category list as an admin saves it: a JSON array of distinct, non-blank
 * names. "Other" is never in it — it is whatever the list does not name.
 * Returns the cleaned list, or throws a 422 saying what is wrong.
 */
export function parseCategoryList(value) {
  let list;
  try { list = JSON.parse(value); } catch { list = null; }
  if (!Array.isArray(list) || !list.every((name) => typeof name === 'string')) {
    throw new ApiError(422, 'Send the categories as a list of names', { fields: { value: 'A JSON list of names' } });
  }
  const names = list.map((name) => name.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (!names.length) throw new ApiError(422, 'Name at least one category', { fields: { value: 'Required' } });
  if (names.length > MAX_CATEGORIES) throw new ApiError(422, `At most ${MAX_CATEGORIES} categories`, { fields: { value: 'Too many' } });
  if (names.some((name) => name.length > 120)) throw new ApiError(422, 'A category name is too long', { fields: { value: 'At most 120 characters' } });
  const keys = names.map(normalizeName);
  if (new Set(keys).size !== keys.length) throw new ApiError(422, 'A category is listed twice', { fields: { value: 'Each name once' } });
  if (keys.includes(normalizeName(OTHER)) || keys.includes(normalizeName(NOT_SET))) {
    throw new ApiError(422, `"${OTHER}" and "${NOT_SET}" are added by the report itself`, { fields: { value: 'Leave them out' } });
  }
  return names;
}

/** A stored category list, or the default when it is missing or unreadable. */
export function readCategoryList(value, fallback) {
  try { return parseCategoryList(value); } catch { return fallback; }
}

/**
 * The headline sector a free-text sector counts under: the category of that
 * name, or the one an alias points to, ignoring case and spacing; anything
 * else is Other, and a blank is Not set. An alias pointing at a sector the
 * list no longer names counts as Other, not as a category of its own.
 */
export function sectorMapper(categories, aliases = []) {
  const byKey = new Map(categories.map((name) => [normalizeName(name), name]));
  for (const { alias, sector } of aliases) {
    const target = byKey.get(normalizeName(sector));
    const key = normalizeName(alias);
    if (target && key && !byKey.has(key)) byKey.set(key, target);
  }
  return (raw) => {
    const key = normalizeName(raw);
    if (!key) return NOT_SET;
    return byKey.get(key) ?? OTHER;
  };
}

/**
 * POs per headline sector: how many, and their value in INR. Other lists the
 * spellings behind it so nothing is hidden. Every category is listed, even at
 * zero, then Other, then Not set; so the rows add up to the revenue total.
 *
 * `pos`: { sector (raw), po_value_inr } — the revenue section's PO rows.
 */
export function sectorSection(pos, categories, mapSector) {
  const rows = new Map([...categories, OTHER, NOT_SET].map((name) => [name, { sector: name, pos: 0, value_inr: 0, raw: new Map() }]));
  for (const po of pos) {
    const row = rows.get(mapSector(po.sector));
    row.pos += 1;
    row.value_inr += po.po_value_inr ?? 0;
    if (row.sector === OTHER) {
      const key = normalizeName(po.sector);
      const raw = row.raw.get(key) ?? { name: po.sector.trim(), pos: 0, value_inr: 0 };
      raw.pos += 1;
      raw.value_inr += po.po_value_inr ?? 0;
      row.raw.set(key, raw);
    }
  }
  const list = [...rows.values()]
    .filter((row) => row.sector !== NOT_SET || row.pos)
    .map((row) => ({
      sector: row.sector,
      other: row.sector === OTHER || row.sector === NOT_SET,
      pos: row.pos,
      value_inr: r2(row.value_inr),
      raw: [...row.raw.values()]
        .map((r) => ({ ...r, value_inr: r2(r.value_inr) }))
        .sort((a, b) => b.pos - a.pos || b.value_inr - a.value_inr || a.name.localeCompare(b.name)),
    }));
  const pct = percentages(list.map((row) => row.pos));
  return {
    rows: list.map((row, i) => ({ ...row, pct: pct[i] })),
    total: { pos: pos.length, value_inr: r2(pos.reduce((n, po) => n + (po.po_value_inr ?? 0), 0)) },
    not_set: rows.get(NOT_SET).pos,
  };
}

/**
 * The service lines a piece of service text counts under: the catalogue
 * entry of that name and its report_line when an admin has set one, else the
 * keyword rules (lib/serviceLines.js). A line the report does not list, and
 * text matching none, is Other. Never empty.
 */
export function serviceMapper(categories, catalogue = []) {
  const listed = new Map(categories.map((name) => [normalizeName(name), name]));
  const byName = new Map(catalogue.filter((s) => s.report_line).map((s) => [normalizeName(s.name), s.report_line]));
  const cache = new Map();
  const linesOf = (text) => {
    const key = normalizeName(text);
    if (cache.has(key)) return cache.get(key);
    let lines;
    const assigned = byName.get(key);
    if (assigned) lines = [listed.get(normalizeName(assigned)) ?? OTHER];
    else {
      lines = [...new Set(serviceLinesFor(text).map((name) => listed.get(normalizeName(name)) ?? OTHER))];
      // "Other" beside a real line adds nothing: the value goes to the line.
      if (lines.length > 1) lines = lines.filter((name) => name !== OTHER);
    }
    cache.set(key, lines);
    return lines;
  };
  return linesOf;
}

/**
 * How one PO's value splits across service lines, in order of preference:
 *
 *   1. po_services — the split recorded when the PO was registered
 *   2. its quotation's lines, by line value (incl. GST), each by its
 *      catalogue service where it has one
 *   3. the quotation's service text, by keywords
 *
 * A piece naming several lines is split equally between them, never counted
 * in full in each, so the lines add up to the PO. Returns
 * { source, shares: [{ line, value_inr }] } — value_inr null when the PO has
 * no INR value.
 *
 * `po`: { po_value_inr, services: [{ service, value }],
 *         lines: [{ text, value }], service }
 */
export function serviceSplit(po, linesOf) {
  let source;
  let pieces;
  if (po.services?.length) {
    source = 'po_services';
    pieces = po.services.map((s) => ({ text: s.service, weight: s.value }));
  } else if (po.lines?.length) {
    source = 'quotation_lines';
    pieces = po.lines.map((l) => ({ text: l.text, weight: l.value }));
  } else {
    source = 'keywords';
    pieces = [{ text: po.service, weight: 1 }];
  }
  // A piece with no value of its own (or all at zero) weighs the same as the rest.
  const valued = pieces.every((p) => Number(p.weight) > 0);
  const weights = pieces.map((p) => (valued ? Number(p.weight) : 1));
  const whole = weights.reduce((n, w) => n + w, 0);

  const totals = new Map();
  for (const [i, piece] of pieces.entries()) {
    const lines = linesOf(piece.text);
    for (const line of lines) totals.set(line, (totals.get(line) || 0) + weights[i] / whole / lines.length);
  }
  return {
    source,
    shares: [...totals].map(([line, fraction]) => ({
      line,
      fraction,
      value_inr: po.po_value_inr == null ? null : po.po_value_inr * fraction,
    })),
  };
}

/**
 * PO value per service line, ranked by value. A PO counts once in each line
 * it touches (so the PO counts can add up to more than the POs), while its
 * value is split (so the values add up to the revenue total). Every listed
 * line appears, even at zero; Other last.
 */
export function serviceSection(pos, categories, linesOf) {
  const rows = new Map([...categories, OTHER].map((name) => [name, { line: name, pos: 0, value_inr: 0 }]));
  const sources = { po_services: 0, quotation_lines: 0, keywords: 0 };
  let bundled = 0;
  for (const po of pos) {
    const split = serviceSplit(po, linesOf);
    sources[split.source] += 1;
    if (split.shares.length > 1) bundled += 1;
    for (const share of split.shares) {
      const row = rows.get(share.line);
      row.pos += 1;
      row.value_inr += share.value_inr ?? 0;
    }
  }
  const list = [...rows.values()]
    .map((row) => ({ ...row, other: row.line === OTHER, value_inr: r2(row.value_inr) }))
    .sort((a, b) => a.other - b.other || b.value_inr - a.value_inr || b.pos - a.pos || categories.indexOf(a.line) - categories.indexOf(b.line));
  const pct = percentages(list.map((row) => row.value_inr));
  return {
    rows: list.map((row, i) => ({ ...row, pct: pct[i] })),
    total: { pos: pos.length, value_inr: r2(pos.reduce((n, po) => n + (po.po_value_inr ?? 0), 0)) },
    sources,
    bundled,
  };
}

// ---------------------------------------------------------------------
// 6. Monthly revenue (§4.6)
// ---------------------------------------------------------------------

/**
 * Revenue is the value of the POs that count as a sale, including GST
 * (po_value as entered), by PO date, in INR at the rate on the PO date. Not a
 * won quotation, not an invoice: the order basis, so it is the same money the
 * sector, service and customer sections split up.
 *
 * Invoiced and received run beside it as the billing and the cash view of the
 * same months: invoiced by invoice date at the invoice date's rate, received
 * by payment date at the payment date's rate. They are not a split of the PO
 * value — a PO from March may be invoiced in May.
 *
 * `pos`: { po_number, date, client, sector, service, owner, currency,
 *          po_value, rate, po_value_inr, invoiced_inr, received_inr }
 * `billing`: { date, invoiced_inr, received_inr, unconverted } per stage event
 */
export function monthlyRevenue(pos, billing, period) {
  const sumOf = (list, field) => r2(list.reduce((sum, row) => sum + (row[field] ?? 0), 0));
  const unconverted = (list) => {
    const amounts = new Map();
    for (const row of list) {
      if (row.po_value == null || row.rate != null) continue;
      amounts.set(row.currency, r2((amounts.get(row.currency) || 0) + row.po_value));
    }
    return [...amounts].map(([currency, amount]) => ({ currency, amount }));
  };
  const summarisePos = (list) => ({
    pos: list.length,
    po_value_inr: sumOf(list, 'po_value_inr'),
    without_value: list.filter((row) => row.po_value == null).length,
    unconverted: unconverted(list),
  });

  const orders = periodRows(pos, period, 'month', (list) => ({ ...summarisePos(list), detail: list }));
  const money = new Map(periodRows(billing, period, 'month', (list) => ({
    invoiced_inr: sumOf(list.filter((e) => e.kind === 'invoiced'), 'amount_inr'),
    received_inr: sumOf(list.filter((e) => e.kind === 'received'), 'amount_inr'),
    unconverted: list.filter((e) => e.amount_inr == null).length,
  })).map((m) => [m.key, m]));

  const months = orders.map((m) => {
    const cash = money.get(m.key) ?? { invoiced_inr: 0, received_inr: 0, unconverted: 0 };
    money.delete(m.key);
    return {
      key: m.key,
      label: m.label,
      pos: m.pos,
      po_value_inr: m.po_value_inr,
      without_value: m.without_value,
      unconverted: m.unconverted,
      invoiced_inr: cash.invoiced_inr,
      received_inr: cash.received_inr,
      billing_unconverted: cash.unconverted,
      detail: m.detail.map((row) => ({
        po_number: row.po_number,
        po_date: row.date,
        client: row.client,
        sector: row.sector,
        service: row.service,
        owner: row.owner,
        currency: row.currency,
        po_value: row.po_value,
        po_value_inr: row.po_value_inr,
        invoiced_inr: row.invoiced_inr,
        received_inr: row.received_inr,
      })),
    };
  });
  // Billing in a month with no PO dated in it (an open period, or a stage
  // with no date of its own) still belongs on the chart.
  for (const m of money.values()) {
    months.push({
      key: m.key, label: m.label, pos: 0, po_value_inr: 0, without_value: 0, unconverted: [],
      invoiced_inr: m.invoiced_inr, received_inr: m.received_inr, billing_unconverted: m.unconverted, detail: [],
    });
  }
  months.sort((a, b) => (a.key === null) - (b.key === null) || String(a.key).localeCompare(String(b.key)));

  return {
    basis: 'PO value incl. GST, by PO date',
    months,
    total: {
      ...summarisePos(pos),
      invoiced_inr: sumOf(months, 'invoiced_inr'),
      received_inr: sumOf(months, 'received_inr'),
      billing_unconverted: months.reduce((n, m) => n + m.billing_unconverted, 0),
    },
  };
}

// ---------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------

/**
 * The scope a report runs in. A sales user always gets their own; an admin
 * gets everything, or one salesperson's book with ?owner=<user id>. A sales
 * user's ?owner= is ignored, never an error: the link they followed may have
 * been an admin's.
 */
export function reportScope(scope, reqQuery = {}) {
  if (!scope.unrestricted) return scope;
  const owner = Number(reqQuery.owner);
  return Number.isInteger(owner) && owner > 0 ? { unrestricted: false, ownerId: owner } : scope;
}

/**
 * The day an enquiry counts on: its enquiry date, or the day the record was
 * created where the business is, when that was left blank. $3 is the time zone.
 */
const ENQUIRY_DAY = `COALESCE(e.enquiry_date, (e.created_at AT TIME ZONE $3)::date)`;

/**
 * Enquiries received in the period, each with what had become of it by the
 * period's end ($2, or today ($4) for an open period):
 *
 * - has_po: a PO that counts as a sale, dated by then, on the enquiry's
 *   quotation (the same PO-to-quotation rule as every other figure).
 * - quotation_lost: the quotation is lost and was closed by then. One lost
 *   after the period was still open at its end.
 * - quotation_expired: still open, and its validity ran out before then.
 *
 * The enquiry's own status is read as it is now: nothing records when it
 * changed.
 */
function outcomeRows({ from, to }, scope = UNRESTRICTED, today = businessToday()) {
  const params = [from, to, config.businessTimeZone, today];
  const src = scopedSources(scope, params);
  const asOf = `LEAST(COALESCE($2::date, $4::date), $4::date)`;
  return query(
    `SELECT e.enquiry_no,
            btrim(e.client_name)                         AS client,
            to_char(${ENQUIRY_DAY}, 'YYYY-MM-DD')        AS date,
            e.enquiry_date IS NULL                       AS dated_by_creation,
            COALESCE(ls.name, NULLIF(btrim(e.source), '')) AS source,
            e.status,
            e.quotation_no,
            q.status                                     AS quotation_status,
            EXISTS (SELECT 1 FROM purchase_orders po
                     WHERE ${poQuotationNo('po')} = e.quotation_no
                       AND ${poCountsAsSale('po')}
                       AND po.po_date <= ${asOf})        AS has_po,
            COALESCE(st.type = 'lost' OR q.status = '${QUOTATION_STATUS.lost}', false)
              AND COALESCE(((COALESCE(q.closed_at, q.stage_changed_at)) AT TIME ZONE $3)::date,
                           q.quotation_date, '-infinity'::date) <= ${asOf} AS quotation_lost,
            COALESCE(q.status IN ('${QUOTATION_STATUS.submitted}', '${QUOTATION_STATUS.negotiating}')
                     AND q.valid_until < ${asOf}, false) AS quotation_expired,
            lr.name                                      AS lost_reason
       FROM ${src.enquiries} e
       LEFT JOIN lead_sources ls ON ls.id = e.source_id
       LEFT JOIN quotations q ON q.quotation_no = e.quotation_no
       LEFT JOIN pipeline_stages st ON st.id = q.stage_id
       LEFT JOIN lost_reasons lr ON lr.id = q.lost_reason_id
      WHERE ${inPeriod(ENQUIRY_DAY)}
      ORDER BY ${ENQUIRY_DAY}, e.enquiry_no`,
    params
  );
}

/**
 * POs that count as a sale, dated in the period, with what each was worth in
 * INR on its PO date and what has been invoiced and received against it
 * (each stage converted on its own invoice or payment date). Client comes
 * from the project, sector and service from the quotation it fulfils (sector
 * falling back to the company's), the owner from that quotation or else the
 * project. The sector and service sections split these same rows, so their
 * totals are the revenue total.
 */
function revenueRows({ from, to }, scope = UNRESTRICTED) {
  const params = [from, to];
  const src = scopedSources(scope, params);
  return query(
    `WITH ${RATES}
     SELECT po.po_number,
            to_char(po.po_date, 'YYYY-MM-DD')        AS date,
            btrim(pr.client_name)                    AS client,
            q.id                                     AS quotation_id,
            -- The quotation's sector, else the company's (§4.3).
            COALESCE(NULLIF(btrim(q.sector), ''), NULLIF(btrim(c.sector), '')) AS sector,
            NULLIF(btrim(q.service_quoted), '')      AS service,
            COALESCE(u.name, NULLIF(btrim(q.sales_person), ''), NULLIF(btrim(pr.sales_person), '')) AS owner,
            po.currency,
            NULLIF(po.po_value, 0)::float8           AS po_value,
            r.rate::float8                           AS rate,
            ROUND(NULLIF(po.po_value, 0) * r.rate, 2)::float8 AS po_value_inr,
            st.invoiced_inr::float8                  AS invoiced_inr,
            st.received_inr::float8                  AS received_inr
       FROM ${src.purchaseOrders} po
       JOIN projects pr ON pr.project_id = po.project_id
       LEFT JOIN quotations q ON q.quotation_no = ${poQuotationNo('po')}
       LEFT JOIN companies c ON c.id = COALESCE(pr.company_id, q.company_id)
       LEFT JOIN users u ON u.id = COALESCE(q.owner_user_id, pr.owner_user_id)
       ${rateOn('r', 'po.currency', 'po.po_date')}
       CROSS JOIN LATERAL (
         SELECT ROUND(COALESCE(SUM(s.invoiced_amount * ir.rate), 0), 2) AS invoiced_inr,
                ROUND(COALESCE(SUM(s.amount_received * rr.rate), 0), 2) AS received_inr
           FROM v_payment_stages s
           ${rateOn('ir', 's.currency', 'COALESCE(s.invoice_date, po.po_date)')}
           ${rateOn('rr', 's.currency', 'COALESCE(s.payment_received_date, s.invoice_date, po.po_date)')}
          WHERE s.po_number = po.po_number
       ) st
      WHERE ${inPeriod('po.po_date')} AND ${poCountsAsSale('po')}
      ORDER BY po.po_date, po.po_number`,
    params
  );
}

/**
 * Money invoiced and received in the period, one row per stage event, dated
 * by the invoice or the payment itself and converted at that date's rate.
 * Every PO counts here, cancelled or replaced: billing on one is still real.
 */
function billingRows({ from, to }, scope = UNRESTRICTED) {
  const params = [from, to];
  const src = scopedSources(scope, params);
  return query(
    `WITH ${RATES}
     SELECT 'invoiced' AS kind,
            to_char(s.invoice_date, 'YYYY-MM-DD') AS date,
            ROUND(s.invoiced_amount * r.rate, 2)::float8 AS amount_inr
       FROM ${src.vPaymentStages} s
       ${rateOn('r', 's.currency', 's.invoice_date')}
      WHERE s.invoiced_amount > 0 AND ${inPeriod('s.invoice_date')}
     UNION ALL
     SELECT 'received',
            to_char(s.payment_received_date, 'YYYY-MM-DD'),
            ROUND(s.amount_received * r.rate, 2)::float8
       FROM ${src.vPaymentStages} s
       ${rateOn('r', 's.currency', 's.payment_received_date')}
      WHERE s.amount_received > 0 AND ${inPeriod('s.payment_received_date')}`,
    params
  );
}

/**
 * What each PO's value is made of, for the service split: its po_services
 * rows, and its quotation's lines (by value incl. GST, named by their
 * catalogue service where they have one). Keyed by the rows' own PO numbers
 * and quotation ids, which are already only the ones the reader may see.
 */
async function servicePieces(poRows) {
  const poNumbers = poRows.map((row) => row.po_number);
  const quotationIds = [...new Set(poRows.map((row) => row.quotation_id).filter(Boolean))];
  const [services, lines] = await Promise.all([
    query(
      `SELECT po_number, service, service_value::float8 AS value
         FROM po_services WHERE po_number = ANY($1::text[]) ORDER BY po_number, id`,
      [poNumbers]
    ),
    query(
      `SELECT ql.quotation_id, COALESCE(s.name, ql.description) AS text,
              (ql.amount * (1 + ql.gst_rate / 100))::float8 AS value
         FROM quotation_lines ql
         LEFT JOIN services s ON s.id = ql.service_id
        WHERE ql.quotation_id = ANY($1::int[])
        ORDER BY ql.quotation_id, ql.sort_order, ql.id`,
      [quotationIds]
    ),
  ]);
  const group = (rows, key) => {
    const map = new Map();
    for (const row of rows) map.set(row[key], [...(map.get(row[key]) ?? []), row]);
    return map;
  };
  return { services: group(services.rows, 'po_number'), lines: group(lines.rows, 'quotation_id') };
}

/** The headline sectors and service lines, the sector aliases and the catalogue's assignments. */
export async function reportCategories() {
  const [settings, aliases, catalogue] = await Promise.all([
    query(`SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [Object.keys(CATEGORY_SETTINGS)]),
    query('SELECT id, alias, sector FROM sector_aliases ORDER BY sector, alias'),
    query('SELECT id, name, active, report_line FROM services ORDER BY sort_order, name'),
  ]);
  const stored = Object.fromEntries(settings.rows.map((row) => [row.key, row.value]));
  return {
    sectors: readCategoryList(stored.report_sectors, CATEGORY_SETTINGS.report_sectors),
    service_lines: readCategoryList(stored.report_service_lines, CATEGORY_SETTINGS.report_service_lines),
    aliases: aliases.rows,
    services: catalogue.rows,
  };
}

/**
 * What the Settings → Reports pane shows beside the lists: every sector
 * spelling in use and the category it counts under now (so an admin can see
 * what lands in Other and alias it), and every catalogue service with the
 * line it counts under and whether that is assigned or matched by keyword.
 * Reads every record, unscoped: it is an admin's view of the whole book.
 */
export async function categoryUsage() {
  const categories = await reportCategories();
  const { rows } = await query(
    `SELECT mode() WITHIN GROUP (ORDER BY name) AS name, COUNT(*)::int AS records
       FROM (SELECT btrim(sector) AS name FROM quotations
             UNION ALL SELECT btrim(sector) FROM enquiries
             UNION ALL SELECT btrim(sector) FROM companies) s
      WHERE NULLIF(name, '') IS NOT NULL
      GROUP BY ${nameKey('name')}
      ORDER BY records DESC, 1`
  );
  const mapSector = sectorMapper(categories.sectors, categories.aliases);
  const linesOf = serviceMapper(categories.service_lines, categories.services);
  return {
    ...categories,
    sector_usage: rows.map((row) => ({ ...row, category: mapSector(row.name) })),
    services: categories.services.map((service) => ({
      ...service,
      lines: linesOf(service.name),
      assigned: Boolean(service.report_line),
    })),
  };
}

/** POs with no PO date: in no month once a period is chosen, so named. */
async function undatedPos({ from, to }, scope) {
  if (!from && !to) return [];
  const params = [];
  const src = scopedSources(scope, params);
  const { rows } = await query(
    `SELECT po_number FROM ${src.purchaseOrders} upo WHERE po_date IS NULL AND ${poCountsAsSale('upo')} ORDER BY po_number`,
    params
  );
  return rows.map((row) => row.po_number);
}

// ---------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------

const fmtInr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** One plain sentence per section, from the figures alone. */
export function narrate({ enquiries, outcomes, sectors, services, revenue }) {
  const out = {};
  if (!enquiries.total) out.enquiries = 'No enquiries in this period.';
  else {
    const top = enquiries.sources[0];
    out.enquiries = `${enquiries.total} enquir${enquiries.total === 1 ? 'y' : 'ies'} received`
      + (enquiries.busiest && enquiries.buckets.length > 1 ? `, the most in ${enquiries.busiest.label} (${enquiries.busiest.enquiries})` : '')
      + (top && top.name !== NO_SOURCE ? `. ${top.name} brought the most (${top.enquiries}).` : '.');
  }
  if (!outcomes.total) out.outcomes = 'No enquiries in this period.';
  else {
    const slice = Object.fromEntries(outcomes.slices.map((s) => [s.key, s]));
    out.outcomes = `${slice.converted.count} of ${outcomes.total} (${slice.converted.pct}%) converted to a PO; `
      + `${slice.pipeline.count} still in the pipeline, ${slice.quoted_not_won.count} quoted but not won, `
      + `${slice.lost.count} lost before a quotation.`;
  }
  const named = (rows) => rows.filter((row) => !row.other && row.pos);
  if (!sectors.total.pos) out.sectors = 'No POs in this period.';
  else {
    const best = named(sectors.rows).sort((a, b) => b.pos - a.pos || b.value_inr - a.value_inr)[0];
    out.sectors = best
      ? `${best.sector} gave the most POs (${best.pos} of ${sectors.total.pos}, ${fmtInr(best.value_inr)}).`
      : `None of the ${sectors.total.pos} POs came from a headline sector.`;
  }
  if (!services.total.pos) out.services = 'No POs in this period.';
  else {
    const best = named(services.rows)[0];
    out.services = best && best.value_inr > 0
      ? `${best.line} sold the most: ${fmtInr(best.value_inr)} (${best.pct}% of PO value) across ${best.pos} PO${best.pos === 1 ? '' : 's'}.`
      : 'No PO value fell in a listed service line.';
  }
  if (!revenue.total.pos) out.revenue = 'No POs in this period.';
  else {
    const best = revenue.months.filter((m) => m.key).reduce((a, m) => (m.po_value_inr > (a?.po_value_inr ?? 0) ? m : a), null);
    out.revenue = `${fmtInr(revenue.total.po_value_inr)} from ${revenue.total.pos} PO${revenue.total.pos === 1 ? '' : 's'} (incl. GST)`
      + (best && revenue.months.length > 1 ? `; ${best.label} was the biggest month at ${fmtInr(best.po_value_inr)}.` : '.');
  }
  return out;
}

/**
 * Every section built so far, for one period and scope, in one call: the
 * screen, the CSV export and the PDF all read this.
 */
export async function salesReport(period, { grain, scope = UNRESTRICTED, today = businessToday() } = {}) {
  const [enquiryRows, poRows, billing, undated, categories] = await Promise.all([
    outcomeRows(period, scope, today), revenueRows(period, scope), billingRows(period, scope), undatedPos(period, scope),
    reportCategories(),
  ]);
  const pieces = await servicePieces(poRows.rows);
  const mapSector = sectorMapper(categories.sectors, categories.aliases);
  const linesOf = serviceMapper(categories.service_lines, categories.services);
  const pos = poRows.rows.map((row) => ({
    ...row,
    services: pieces.services.get(row.po_number) ?? [],
    lines: pieces.lines.get(row.quotation_id) ?? [],
  }));
  const dates = enquiryRows.rows.map((row) => row.date).filter(Boolean);
  const wanted = grain || defaultGrain(period);
  const used = fitGrain(period.from || dates[0], period.to || dates.at(-1), wanted);

  const enquiries = enquiriesReceived(enquiryRows.rows, period, used);
  const outcomes = outcomeSummary(enquiryRows.rows, period);
  const sectors = sectorSection(pos, categories.sectors, mapSector);
  const services = serviceSection(pos, categories.service_lines, linesOf);
  // The PO list behind each month says which category each PO counted in.
  const revenue = monthlyRevenue(pos.map((row) => ({
    ...row,
    sector: mapSector(row.sector),
    service: serviceSplit(row, linesOf).shares.map((share) => share.line).join(', '),
  })), billing.rows, period);

  const notes = [];
  if (used !== wanted) notes.push({ key: 'grain', text: `Too many ${wanted}s to chart; shown by ${used}.` });
  if (enquiries.dated_by_creation) {
    const n = enquiries.dated_by_creation;
    notes.push({ key: 'enquiries_dated_by_creation', count: n, href: '/enquiries', text: `${n} enquir${n === 1 ? 'y has' : 'ies have'} no enquiry date and ${n === 1 ? 'is' : 'are'} counted on the day ${n === 1 ? 'it was' : 'they were'} created.` });
  }
  for (const note of outcomes.notes) notes.push({ ...note, href: '/enquiries' });
  if (revenue.total.unconverted.length) {
    const list = revenue.total.unconverted.map((u) => `${u.currency} ${u.amount.toLocaleString('en-IN')}`).join(', ');
    notes.push({ key: 'po_unconverted', text: `${list} of PO value has no exchange rate for its PO date and is not in the INR totals.` });
  }
  if (revenue.total.without_value) {
    const n = revenue.total.without_value;
    notes.push({ key: 'po_without_value', count: n, href: '/purchase-orders', text: `${n} PO${n === 1 ? ' has' : 's have'} no value entered.` });
  }
  if (revenue.total.billing_unconverted) {
    const n = revenue.total.billing_unconverted;
    notes.push({ key: 'billing_unconverted', count: n, text: `${n} invoice or payment amount${n === 1 ? '' : 's'} could not be converted to INR and ${n === 1 ? 'is' : 'are'} left out of invoiced / received.` });
  }
  if (sectors.not_set) {
    const n = sectors.not_set;
    notes.push({ key: 'po_without_sector', count: n, href: '/quotations?sector=__none__', text: `${n} PO${n === 1 ? ' has' : 's have'} no sector on its quotation or company.` });
  }
  if (services.sources.keywords) {
    const n = services.sources.keywords;
    notes.push({ key: 'services_by_keywords', count: n, text: `${n} PO${n === 1 ? ' has' : 's have'} no service lines recorded; ${n === 1 ? 'its' : 'their'} service was read from the quotation's service text${services.bundled ? ', and a PO naming several services is split equally between them' : ''}.` });
  }
  if (undated.length) {
    notes.push({ key: 'undated_pos', count: undated.length, href: '/purchase-orders', text: `${undated.length} PO${undated.length === 1 ? ' has' : 's have'} no PO date and ${undated.length === 1 ? 'is' : 'are'} in no month: ${undated.join(', ')}.` });
  }
  const currencies = poRows.rows.map((row) => ({ currency: row.currency }));
  const stale = await staleAmong(currencies, { period, today });

  const sections = { enquiries, outcomes, sectors, services, revenue };
  return { period, grain: used, ...sections, notes, stale_rates: stale, narrative: narrate(sections) };
}
