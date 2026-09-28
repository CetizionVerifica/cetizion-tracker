/**
 * Read an uploaded workbook (xlsx / xls / csv) into plain rows.
 *
 * Nothing here knows what the columns mean — that is the mapper's job.
 * This module only finds the header row, names the columns, and turns
 * cell values into strings, numbers and YYYY-MM-DD dates.
 *
 * Sheets arrive in many layouts (#45): a title and a note above the
 * header, a summary tab before the data tab, the header repeated every
 * page, a totals row at the bottom, two columns both called "Remarks".
 * The header row is the row that looks most like known column names, and
 * the sheet is the one whose header does.
 */
import XLSX from 'xlsx';
import { headerRowScore, SECRET_HEADER, normHeader } from './fields.js';

/** Pick the sheet whose header row looks most like a sales sheet. */
export function readWorkbook(buffer, preferredSheet) {
  const wb = openWorkbook(buffer);
  const candidates = wb.SheetNames.map((name) => {
    const grid = sheetToGrid(wb.Sheets[name]);
    const { index, score } = findHeaderRow(grid);
    return { name, grid, headerIdx: index, score, dataRows: index < 0 ? 0 : grid.length - index - 1 };
  });

  let pick = preferredSheet ? candidates.find((c) => c.name === preferredSheet && c.headerIdx >= 0) : null;
  if (!pick) {
    pick = candidates.filter((c) => c.headerIdx >= 0 && c.dataRows > 0)
      .sort((a, b) => b.score - a.score || b.dataRows - a.dataRows)[0];
  }
  if (!pick) throw new Error('No sheet with a header row was found in this file');

  const named = dedupeHeaders(pick.grid[pick.headerIdx].map((h, i) => cleanHeader(h, i)));
  // Credentials in a sheet (portal logins, passwords) go no further than here.
  const dropped = named.filter((h) => SECRET_HEADER.test(h));
  const keep = named.map((h) => !SECRET_HEADER.test(h));
  const headers = named.filter((_, i) => keep[i]);

  const rows = [];
  const headerKeys = named.map(normHeader);
  const body = pick.grid.slice(pick.headerIdx + 1);
  const monthFirst = named.map((_, i) => monthFirstColumn(body.map((row) => row?.[i])));
  for (let r = pick.headerIdx + 1; r < pick.grid.length; r++) {
    const raw = pick.grid[r];
    if (!raw || raw.every((v) => v === null || v === '')) continue;
    if (repeatsHeader(raw, headerKeys)) continue;
    // The Excel row number, even when the sheet starts below row 1.
    const row = { __row: r + 1 + (pick.grid.firstRow || 0) };
    named.forEach((h, i) => { if (keep[i]) row[h] = normaliseCell(raw[i], monthFirst[i]); });
    rows.push(row);
  }

  return {
    sheet: pick.name,
    sheets: wb.SheetNames,
    headers,
    dropped_columns: dropped,
    rows,
  };
}

/**
 * An Excel workbook as it is; a CSV as the text people typed. A CSV is
 * decoded as UTF-8 (with or without the byte-order mark Excel adds), or as
 * Windows-1252 when it is not valid UTF-8 — Excel's plain "CSV" save — so
 * "Northwind – Kochi" keeps its dash. Its cells stay text: left to
 * itself the reader would turn 03/04/2026 into 4 March, the US way.
 */
function openWorkbook(buffer) {
  const zip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const ole = buffer[0] === 0xd0 && buffer[1] === 0xcf;
  if (zip || ole || looksBinary(buffer)) return XLSX.read(buffer, { type: 'buffer', cellDates: false, cellNF: true });
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { text = new TextDecoder('windows-1252').decode(buffer); }
  return XLSX.read(text.replace(/^﻿/, ''), { type: 'string', raw: true, cellNF: true });
}
const looksBinary = (buffer) => buffer.subarray(0, 512).some((b) => b === 0);

/**
 * Which of a column's typed date styles write the month first (1/20/26),
 * judged separately per separator: one column can hold Excel's US display
 * "3/12/26" beside a typed Indian "24.02.2026". Month first only shows when
 * some day is over 12; without that evidence dates are read day first, the
 * Indian way. Returns the separators that are month first, e.g. ['/'].
 */
function monthFirstColumn(values) {
  const seen = {};
  for (const v of values) {
    const m = typeof v === 'string' ? /^\s*(\d{1,2})([./-])(\d{1,2})\2(\d{2}|\d{4})\s*$/.exec(v) : null;
    if (!m) continue;
    const s = (seen[m[2]] ||= { dayFirst: false, monthFirst: false });
    if (Number(m[1]) > 12) s.dayFirst = true;
    if (Number(m[3]) > 12) s.monthFirst = true;
  }
  return Object.entries(seen).filter(([, s]) => s.monthFirst && !s.dayFirst).map(([sep]) => sep);
}

/**
 * Cell grid with dates resolved from their Excel serial number, so a date
 * typed as 22 Jan comes out as 2026-01-22 regardless of the machine's time
 * zone. A numeric cell is a date when its number format says so, or when
 * Excel rendered it like 1/7/26.
 *
 * A number whose format carries a currency ("USD "#,##0, [$€-2] #,##0)
 * keeps it: the sheet shows "USD 8,111" and the value must not arrive as a
 * bare 8111 that would be read as rupees.
 */
function sheetToGrid(ws) {
  const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!range) return [];
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell || cell.v === null || cell.v === undefined) { row.push(null); continue; }
      if (cell.t === 'n' && ((cell.z && XLSX.SSF.is_date(cell.z)) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(cell.w || '')))) {
        const d = XLSX.SSF.parse_date_code(cell.v);
        row.push(d ? `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null);
        continue;
      }
      if (cell.t === 'n' && (cell.z || cell.w)) {
        // The format says it, or — for a CSV "$9600" read as a number — the text shown.
        const code = formatCurrency(cell.z) || (!cell.z && /[$€£]|[A-Z]{3}/.test(String(cell.w)) ? readCurrency(cell.w) : null);
        if (code && code !== 'INR') { row.push(`${code} ${cell.v}`); continue; }
      }
      row.push(cell.t === 'd' && cell.v instanceof Date ? toISODate(cell.v) : cell.v);
    }
    grid.push(row);
  }
  grid.firstRow = range.s.r;
  return grid;
}

/** The currency a number format displays, if any. */
export function formatCurrency(z) {
  const f = String(z || '');
  const quoted = /"\s*([A-Z]{3})\s*"/.exec(f);
  if (quoted) return quoted[1];
  const bracket = /\[\$([^\]-]*)-?[^\]]*\]/.exec(f);
  if (bracket && bracket[1]) return symbolCurrency(bracket[1]) || (/^[A-Z]{3}$/.test(bracket[1]) ? bracket[1] : null);
  const bare = /(?:^|[^A-Za-z"\\])([$€£₹])/.exec(f.replace(/"[^"]*"/g, ''));
  return bare ? symbolCurrency(bare[1]) : null;
}

const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
const symbolCurrency = (s) => SYMBOLS[String(s).trim()] || null;

/**
 * The header row is the one among the first 30 whose cells name the most
 * known fields; a title, a note or a row of totals above it scores lower.
 * With no recognisable names at all, fall back to the first row with at
 * least three short text cells.
 */
function findHeaderRow(grid) {
  let best = { index: -1, score: 0 };
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const score = headerRowScore(grid[r] || []);
    if (score > best.score) best = { index: r, score };
  }
  if (best.score >= 2) return best;
  for (let r = 0; r < Math.min(grid.length, 25); r++) {
    const cells = (grid[r] || []).filter((v) => typeof v === 'string' && v.trim() && v.trim().length < 60);
    if (cells.length >= 3) return { index: r, score: 0 };
  }
  return { index: -1, score: 0 };
}

function cleanHeader(h, i) {
  const s = h === null || h === undefined ? '' : String(h).replace(/\s+/g, ' ').trim();
  return s || `column_${i + 1}`;
}

/** "Remarks", "Remarks" → "Remarks", "Remarks (2)": both keep their values. */
function dedupeHeaders(headers) {
  const seen = {};
  return headers.map((h) => {
    const k = h.toLowerCase();
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] === 1 ? h : `${h} (${seen[k]})`;
  });
}

/** A sheet printed in pages repeats its header: that row is not a record. */
function repeatsHeader(raw, headerKeys) {
  const cells = raw.map((v, i) => [v, headerKeys[i]]).filter(([v]) => v !== null && v !== '');
  if (cells.length < 3) return false;
  const same = cells.filter(([v, h]) => typeof v === 'string' && normHeader(v) === h).length;
  return same / cells.length >= 0.6;
}

function normaliseCell(v, monthFirstSeparators = []) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return isNaN(v) ? null : toISODate(v);
  if (typeof v === 'number') return v;
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s === '' || /^(n\/?a|na|-+|—|–|not sent|nil|none|tbc|tbd)$/i.test(s)) return null;
  const sep = /^\d{1,2}([./-])\d{1,2}\1\d{2,4}$/.exec(s)?.[1];
  const d = parseDate(s, { monthFirst: Boolean(sep && monthFirstSeparators.includes(sep)) });
  if (d) return d;
  // A CSV keeps every cell as text; a plain number is still a number.
  if (/^-?\d+(\.\d+)?$/.test(s) && s.length <= 15 && !/^0\d/.test(s)) return Number(s);
  return s;
}

function toISODate(d) {
  // Sheets store dates without a time zone; use the local calendar date.
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/* ------------------------------------------------------------------ */
/* Dates                                                                */
/* ------------------------------------------------------------------ */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// Each pattern: the regex source and how to read its groups into y, m, d.
const DATE_PATTERNS = [
  // 2026-09-22
  [String.raw`(\d{4})-(\d{1,2})-(\d{1,2})`, (g) => [g[1], g[2], g[3]]],
  // 22.09.2026, 22/09/2026, 22-09-2026, 22.09.26
  [String.raw`(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})`, (g) => [g[3], g[2], g[1], 'dm']],
  // Two days of one month, "14/15-Sep-2026", "10 & 12-Aug-2026": the first one.
  [String.raw`(\d{1,2})(?:st|nd|rd|th)?\s*(?:/|&|and|,|to|–|-)\s*\d{1,2}(?:st|nd|rd|th)?[\s.-]*${MON}[\s.,-]*('?\d{4}|'?\d{2})(?!\d)`, (g) => [g[3], g[2], g[1]]],
  // 22-Sep-2026, 22 Sep 2026, 22nd September, 2026, 22-Sep-26
  [String.raw`(\d{1,2})(?:st|nd|rd|th)?[\s.-]*${MON}[\s.,-]*('?\d{4}|'?\d{2})(?!\d)`, (g) => [g[3], g[2], g[1]]],
  // Sep 22, 2026 / September 22 2026
  [String.raw`${MON}[\s.-]*(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})`, (g) => [g[3], g[1], g[2]]],
];

function toISO(y, m, d, order, monthFirst = false) {
  let year = Number(String(y).replace("'", ''));
  if (year < 100) year += 2000;
  let month = /^\d+$/.test(String(m)) ? Number(m) : MONTHS[String(m).toLowerCase().slice(0, 4)] ?? MONTHS[String(m).toLowerCase().slice(0, 3)];
  let day = Number(d);
  // Day first (the Indian way) unless the column writes months first, or the
  // date cannot be read day first: 1/20/26 is 20 Jan.
  if (order === 'dm' && (monthFirst || (month > 12 && day <= 12))) [month, day] = [day, month];
  if (!month || month > 12 || !day || year < 1990 || year > 2100) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * A cell that IS a date → ISO. Anything else → null. Only the whole text
 * counts: this runs on every cell, and a PO number with a date in its note
 * must stay a PO number.
 */
export function parseDate(s, { monthFirst = false } = {}) {
  const text = String(s ?? '').trim();
  for (const [src, read] of DATE_PATTERNS) {
    const m = new RegExp(`^${src}$`, 'i').exec(text);
    if (m) { const [y, mo, d, order] = read(m); const iso = toISO(y, mo, d, order, monthFirst); if (iso) return iso; }
  }
  // An ISO timestamp from a CSV export.
  const stamp = /^(\d{4})-(\d{2})-(\d{2})T/.exec(text);
  return stamp ? toISO(stamp[1], stamp[2], stamp[3]) : null;
}

/**
 * The first date anywhere in a text, for date columns only:
 * "25-Aug-2026 (revised 11-Sep)" → 2026-08-25, "On/before 16-Sep-2026" →
 * 2026-09-16.
 */
export function findDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  let best = null;
  for (const [src, read] of DATE_PATTERNS) {
    const re = new RegExp(`(?<![\\d.])${src}`, 'gi');
    let m;
    while ((m = re.exec(v))) {
      const [y, mo, d, order] = read(m);
      const iso = toISO(y, mo, d, order);
      if (iso && (!best || m.index < best.index)) best = { index: m.index, iso };
    }
  }
  return best ? best.iso : null;
}

/* ------------------------------------------------------------------ */
/* Money                                                                */
/* ------------------------------------------------------------------ */

const CODES = 'INR|USD|EUR|GBP|AED|SGD|CAD|AUD|CHF|JPY|CNY|SAR|QAR|ZAR|MYR|THB|NZD|HKD';

/** A currency named in a text or a currency column. */
export function readCurrency(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const code = new RegExp(`\\b(${CODES})\\b`, 'i').exec(s);
  if (code) return code[1].toUpperCase();
  if (/₹|\brs\.?(?=\s|\d|$)|\brupees?\b/i.test(s)) return 'INR';
  if (s.includes('$')) return 'USD';
  if (s.includes('€') || /\beuros?\b/i.test(s)) return 'EUR';
  if (s.includes('£')) return 'GBP';
  return null;
}

/**
 * "7,96,500/-"      → {amount: 796500,  currency: null}
 * "$8640"           → {amount: 8640,    currency: 'USD'}
 * "₹ 2,000,000"     → {amount: 2000000, currency: 'INR'}
 * "20 Lac"          → {amount: 2000000, currency: null, reinterpreted}
 * "USD 8,111 + GST" → {amount: 8111,    currency: 'USD', reinterpreted}
 * 33000             → {amount: 33000,   currency: null}
 *
 * When the cell says more than an amount, the first amount is taken and
 * `reinterpreted` holds the original text, so the review shows what was
 * read and from what.
 */
export function parseMoney(v) {
  if (v === null || v === undefined || v === '') return { amount: null, currency: null };
  if (typeof v === 'number') return { amount: v, currency: null };
  let s = String(v).trim();
  const currency = readCurrency(s);
  // "23,36.400/-": a comma-grouped amount with a dot before exactly three
  // digits is a mistyped comma (Indian grouping), not a decimal point.
  let reinterpreted = null;
  if (/\d,\d{2}\.\d{3}\b/.test(s)) { reinterpreted = s; s = s.replace(/(\d,\d{2})\.(\d{3})\b/, '$1,$2'); }
  // "5.26,750/-": the same slip one group earlier, a dot for the first comma.
  if (/^\D*\d{1,2}\.\d{2},\d{3}\b/.test(s)) { reinterpreted = s; s = s.replace(/(\d{1,2})\.(\d{2},\d{3})\b/, '$1,$2'); }
  const plain = s.replace(/\/-/g, '').replace(/[$€£₹,]/g, '').replace(new RegExp(`\\b(${CODES})\\b`, 'gi'), '')
    .replace(/\brs\.?/gi, '').trim();
  const whole = Number(plain);
  if (plain !== '' && Number.isFinite(whole)) return { amount: whole, currency, reinterpreted };

  // More than a number: take the first amount, with a lakh / crore / thousand after it.
  const m = /(-?\d+(?:\.\d+)?)\s*(crores?|cr\b|lakhs?|lacs?|lac\b|lk\b|l\b|mn\b|million|k\b|thousand)?/i.exec(plain);
  if (!m) return { amount: null, currency, reinterpreted };
  const unit = (m[2] || '').toLowerCase();
  const factor = /^cr/.test(unit) ? 1e7 : /^(lakh|lac|lk|l$)/.test(unit) ? 1e5 : /^(mn|million)/.test(unit) ? 1e6 : /^(k|thousand)/.test(unit) ? 1e3 : 1;
  const amount = Math.round(Number(m[1]) * factor * 100) / 100;
  return { amount, currency, reinterpreted: reinterpreted || String(v).trim() };
}

/* ------------------------------------------------------------------ */
/* PO and invoice numbers with a note attached                          */
/* ------------------------------------------------------------------ */

/**
 * "4501234567 (dtd 22.09.2026)"     → {number: '4501234567', date: '2026-09-22'}
 * "CVPL/2026-27/017 (22-Sep-26)"    → {number: 'CVPL/2026-27/017', date: '2026-09-22'}
 * "Per PO file H26-27QWERTYAB1"    → {number: 'H26-27QWERTYAB1'}
 * "Awaited", "Verbal", "Email"      → {number: null}: there is no number yet
 *
 * `note` holds the original text whenever anything was taken off it.
 */
export function splitReference(v) {
  if (v === null || v === undefined || v === '') return { number: null, date: null, note: null };
  const original = String(v).replace(/\s+/g, ' ').trim();
  if (typeof v === 'number') return { number: original, date: null, note: null };
  if (!/\d/.test(original)) return { number: null, date: null, note: original };

  let s = original;
  let date = null;
  // A note in brackets, or after "dtd"/"dated"/"date": the date lives there.
  const notes = [];
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => { notes.push(inner); return ' '; });
  s = s.replace(/\s+(?:dtd\.?|dated|date[d:]?|on)\s+(.*)$/i, (_, rest) => { notes.push(rest); return ''; });
  for (const n of notes) { date = date || findDate(n); }
  s = s.replace(/^(?:as )?per (?:po|wo|the po|po file|invoice)(?: file)?\s*/i, '')
    .replace(/^(?:p\.?\s?o\.?|w\.?o\.?|invoice|inv\.?|bill)\s*(?:no\.?|number|#|:)\s*/i, '')
    .replace(/[\s,;:–—-]+$/, '')
    .trim();
  if (!looksLikeReference(s)) return { number: null, date: date || findDate(original), note: original };
  return { number: s, date, note: s === original ? null : original };
}

// Words that make a cell a sentence about a document, not its number:
// "Advance invoice sent 15-Sep", "Acceptance 03-Sep-2026", "Email confirmation".
const NARRATIVE = /\b(?:sent|shared|requested|raised|issued|pending|awaited|advance|balance|invoices?|travel|project|acceptance|accepted|confirmation|confirmed|email|mail|signed|verbal|received|final|partial|payment|to be|will)\b/i;

/**
 * Whether a cell reads as a reference number: short, with a digit in it,
 * and not a sentence. "4500067890", "SO 5721000001", "WO-X9-25-26-0001",
 * "CVPL/2026-27/017", "026 & 081" are; "Advance invoice sent 15-Sep" is not.
 */
export function looksLikeReference(s) {
  const text = String(s ?? '').trim();
  if (!text || text.length > 40 || !/\d/.test(text)) return false;
  if (NARRATIVE.test(text)) return false;
  const words = text.split(/\s+/).filter((w) => /^[a-z]{3,}$/i.test(w));
  return words.length <= 1;
}
