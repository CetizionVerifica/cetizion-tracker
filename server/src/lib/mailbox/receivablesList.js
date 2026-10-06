/**
 * Finance's Sundry Debtors list, from a shared mailbox
 * (docs/mis-briefing-fix-plan.md §3a).
 *
 *   listSettings(db)                    the phrases and senders that find it
 *   findListEmail(db, { now })          the newest such email in the last 14 days
 *   readSheet(buffer)                   an Excel list, read in code
 *   parseListVerdict(raw)               a PDF list, as the AI read it
 *   checkList(list)                     every amount in the file, and the rows add up to the grand total
 *   refreshReceivableList(db, opts)     find it, read it once, store it
 *
 * Each list email is read once: its row in receivable_lists says so, used
 * or rejected, and the next day's run spends nothing on it again. A list
 * that does not add up is stored as rejected with the reason, and the
 * briefing builds the receivables from the tracker alone.
 *
 * Only a shared mailbox that stores everything is read, as for the
 * briefing's highlights: a personal mailbox never is.
 */
import XLSX from 'xlsx';
import { config } from '../../config.js';
import { query } from '../../db.js';
import { aiConfig, chatJSON } from '../ai.js';
import { aiCallsToday, enquirySettings } from './autoEnquiry.js';
import { SCANNED_BELOW, amountInText, isPdf, near, parseAmount, pdfText } from './pdfQuotation.js';
import { LIST_MAX_AGE_DAYS } from '../misBriefing.js';
import { RULES } from './promptRules.js';
import { providerFor } from './sync.js';

export const deps = { chat: null };
const chatFn = () => deps.chat || (aiConfig.enabled ? (system, user) => chatJSON(system, user, { title: 'Cetizion Tracker receivables list', maxTokens: 4000 }) : null);


const list = (v) => String(v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => x && x !== 'none');

export async function listSettings(db = { query }) {
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key IN ('receivables_list_phrases', 'receivables_list_senders', 'internal_email_domains')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    phrases: list(s.receivables_list_phrases ?? 'sundry debtors,debtors,outstanding,receivable'),
    senders: list(s.receivables_list_senders),
    internalDomains: list(s.internal_email_domains),
  };
}

/**
 * The newest email in a shared mailbox, in the last 14 days, from Finance
 * (the senders set, else anyone at our own domains), whose subject or an
 * attachment's name has one of the phrases. Only mail received with a
 * spreadsheet or PDF attached counts: a reply ("noted") or our own mail to
 * a client about an outstanding invoice is not Finance's list.
 */
export async function findListEmail(db = { query }, { now = new Date(), settings = null } = {}) {
  const s = settings || await listSettings(db);
  if (!s.phrases.length || (!s.senders.length && !s.internalDomains.length)) return null;
  const since = new Date(now.getTime() - LIST_MAX_AGE_DAYS * 86_400_000);
  const { rows: [m] } = await db.query(
    `SELECT m.id, m.account_id, m.provider_id, m.subject, m.sent_at, m.from_email
       FROM email_messages m JOIN connected_accounts a ON a.id = m.account_id
      WHERE a.is_shared AND a.visibility = 'share_everything' AND a.status <> 'disconnected'
        AND m.removed_at IS NULL AND m.sent_at >= $1 AND m.sent_at <= $2
        AND m.direction = 'inbound' AND m.has_attachments
        AND (m.attachments_listed_at IS NULL OR EXISTS (SELECT 1 FROM email_attachments x WHERE x.message_id = m.id AND NOT x.is_inline
              AND (x.name ~* '\\.(xlsx|xlsm|xls|csv|pdf)$' OR x.content_type ~* 'spreadsheet|ms-excel|text/csv|pdf')))
        AND (lower(m.from_email) = ANY($3) OR (cardinality($3) = 0 AND split_part(lower(m.from_email), '@', 2) = ANY($4)))
        AND (m.subject ILIKE ANY($5) OR EXISTS (SELECT 1 FROM email_attachments x WHERE x.message_id = m.id AND x.name ILIKE ANY($5)))
      ORDER BY m.sent_at DESC, m.id DESC LIMIT 1`,
    [since, now, s.senders, s.internalDomains, s.phrases.map((p) => `%${p}%`)]);
  return m || null;
}

// ---------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------

const NAME_HEAD = /particulars|party|name|customer|client|debtor|ledger/i;
const BALANCE_HEAD = /closing|balance|outstanding|receivable|pending amount|due amount/i;
const AMOUNT_HEAD = /amount|debit|value/i;
const DAYS_HEAD = /days|age(ing)?|aging|overdue by/i;
const BILL_HEAD = /bill|invoice|\bref/i;
const PENDING = /pending\s*(for)?\s*invoic|to be invoiced|unbilled|not (yet )?invoiced/i;
const RECEIVABLE = /receivable|debtors|outstanding/i;
const TOTAL = /^\s*(grand\s+)?(sub\s*)?total\b/i;

/**
 * A balance as Tally prints it: "2,44,530.00 Dr" is owed to us, "15,000.00 Cr"
 * is the client's credit (an advance), so negative. A plain figure is owed.
 */
export function balanceOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').trim();
  const credit = /\bcr\.?$/i.test(s);
  const n = parseAmount(s.replace(/\s*\b(dr|cr)\.?$/i, ''));
  return n === null ? null : credit ? -n : n;
}

const cell = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const wholeDays = (v) => { const n = parseAmount(v); return n === null ? null : Math.round(n); };

/**
 * The rows of one sheet as Finance's list: the header row names a client
 * column and an amount column; a heading row ("Pending for invoicing")
 * marks the rows under it; the grand total is the "Grand Total" row, else
 * the one "Total" row, else the section totals together.
 */
export function linesFromRows(rows) {
  const h = rows.findIndex((r) => r.some((c) => NAME_HEAD.test(cell(c))) && r.some((c) => BALANCE_HEAD.test(cell(c)) || AMOUNT_HEAD.test(cell(c))));
  if (h < 0) return null;
  const head = rows[h].map(cell);
  const col = (re, not = null) => head.findIndex((c) => re.test(c) && !(not && not.test(c)));
  const nameCol = col(NAME_HEAD);
  let amountCol = col(BALANCE_HEAD, /date|days|credit/i);
  if (amountCol < 0) amountCol = col(AMOUNT_HEAD, /date|days|credit/i);
  if (nameCol < 0 || amountCol < 0) return null;
  const daysCol = col(DAYS_HEAD, /date/i);
  const billCol = col(BILL_HEAD, /date|amount|days/i);
  const flagCol = col(PENDING);
  const lines = [];
  const totals = [];
  let grand = null;
  let pending = false;
  for (const r of rows.slice(h + 1)) {
    const name = cell(r[nameCol]);
    const amount = balanceOf(r[amountCol]);
    if (TOTAL.test(name)) {
      if (amount !== null) { if (/grand/i.test(name)) grand = amount; else totals.push(amount); }
      continue;
    }
    if (name && amount === null) {
      // A heading row: the section the next rows are in.
      if (PENDING.test(name)) pending = true;
      else if (RECEIVABLE.test(name)) pending = false;
      continue;
    }
    if (!name || amount === null || amount === 0) continue;
    const flag = flagCol >= 0 && /^(y|yes|true|1|pending)$/i.test(cell(r[flagCol]));
    lines.push({
      client: name, invoice_no: billCol >= 0 ? cell(r[billCol]) || null : null, amount,
      days: daysCol >= 0 ? wholeDays(r[daysCol]) : null, pending_for_invoicing: pending || flag,
    });
  }
  const total = grand ?? (totals.length ? totals.reduce((n, t) => n + t, 0) : null);
  return { lines, grand_total: total };
}

/** An Excel (or CSV) list: the first sheet with a client and an amount column. `text` is every cell, for the amount check. */
export function readSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    const found = linesFromRows(rows);
    if (found?.lines.length) return { ...found, list_date: null, text: rows.flat().filter((v) => v !== null).join(' ') };
  }
  return { lines: [], grand_total: null, list_date: null, text: '' };
}

/** The AI's prompt for a PDF list. */
export function listPrompt(pdfText) {
  const system = [
    'You read a Sundry Debtors (receivables) list that our own Finance team emailed. It lists, per client, the amount the client owes us; it may have a section of work pending for invoicing.',
    'Return JSON only: {"list_date": "YYYY-MM-DD" or null, "grand_total": "amount", "lines": [{"client": "name as printed", "invoice_no": "or null", "amount": "amount", "days": whole number or null, "pending_for_invoicing": true or false}]}.',
    'Copy every row of the list, in order. A row under a heading like "Pending for invoicing" or "To be invoiced" has pending_for_invoicing true. Leave out subtotal and total rows; give the grand total as grand_total. Never invent a row, a client or a figure.',
    RULES.dates,
    RULES.amounts,
  ].join('\n');
  return { system, user: `The list:\n\n${pdfText}` };
}

const clean = (v, max = 200) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max); return s && !/^(null|none|n\/a)$/i.test(s) ? s : null; };
const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);

/** The AI's answer in its fixed shape; anything else is no rows. */
export function parseListVerdict(raw) {
  const lines = (Array.isArray(raw?.lines) ? raw.lines : []).map((l) => ({
    client: clean(l?.client), invoice_no: clean(l?.invoice_no, 60), amount: balanceOf(l?.amount),
    days: Number.isFinite(Number(l?.days)) && l?.days !== null && l?.days !== '' ? Math.round(Number(l.days)) : null,
    pending_for_invoicing: l?.pending_for_invoicing === true,
  })).filter((l) => l.client && l.amount !== null && l.amount !== 0);
  return { lines, grand_total: balanceOf(raw?.grand_total), list_date: isoDate(raw?.list_date) };
}

const sum = (lines) => Math.round(lines.reduce((n, l) => n + l.amount, 0) * 100) / 100;

/**
 * Why a list may not be used, or null. The checks the readers make
 * elsewhere: every amount is in the file, and the rows add up to the
 * grand total.
 */
export function checkList({ lines, grand_total: grand, text, method = null }) {
  if (!lines.length) return 'no rows of clients and amounts could be read';
  if (grand === null || grand === undefined) return 'the list has no grand total to check the rows against';
  // A spreadsheet's amounts are its own cells, so only the AI's reading of a PDF needs checking against the file.
  const missing = method === 'xlsx' ? [] : [...lines.map((l) => l.amount), grand].filter((a) => !amountInText(Math.abs(a), text));
  if (missing.length) return `${missing.length} amount${missing.length === 1 ? ' is' : 's are'} not in the file`;
  if (!near(sum(lines), grand)) return `the rows add up to ${sum(lines)}, not the grand total ${grand}`;
  return null;
}

// ---------------------------------------------------------------------
// Find, read once, store
// ---------------------------------------------------------------------

const isSheet = (a) => /\.(xlsx|xlsm|xls|csv)$/i.test(a.name || '') || /spreadsheet|ms-excel|text\/csv/i.test(a.contentType || '');

/** The attachment that is the list: a name with a phrase first, a spreadsheet before a PDF. */
function pickFile(files, phrases) {
  const named = (f) => phrases.some((p) => String(f.name || '').toLowerCase().includes(p));
  const usable = files.filter((f) => f.content && (isSheet(f) || isPdf(f)));
  return [...usable].sort((a, b) => Number(named(b)) - Number(named(a)) || Number(isSheet(b)) - Number(isSheet(a)))[0] || null;
}

async function store(db, m, read) {
  const { rows: [l] } = await db.query(
    `INSERT INTO receivable_lists (account_id, message_id, provider_id, received_at, list_date, file_name, method, status, reason, grand_total)
     VALUES ($1, $2, $3, $4, COALESCE($5::date, ($4::timestamptz AT TIME ZONE $11)::date), $6, $7, $8, $9, $10)
     ON CONFLICT (account_id, provider_id) DO NOTHING RETURNING *`,
    [m.account_id, m.id, m.provider_id, m.sent_at, read.list_date || null, read.file || null, read.method || null, read.reason ? 'rejected' : 'used', read.reason || null, read.grand_total ?? null, config.businessTimeZone]);
  if (l && !read.reason) {
    for (const [i, line] of read.lines.entries()) {
      await db.query(
        `INSERT INTO receivable_list_lines (list_id, line_no, client, invoice_no, amount, days, pending_for_invoicing) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [l.id, i + 1, line.client, line.invoice_no, line.amount, line.days, line.pending_for_invoicing]);
    }
  }
  return l;
}

/**
 * Find Finance's newest list and read it, once. `ai` lets a PDF list use
 * an AI call (the scheduled send does, a preview does not unless asked);
 * a spreadsheet needs none. Returns what happened, for the run's log:
 *   { found: false } | { already } | { stored } | { waiting: why } | { error }
 * A list that cannot be read now (the mailbox did not answer, no AI) is
 * not stored, so a later run reads it.
 */
export async function refreshReceivableList(db = { query }, { now = new Date(), ai = false, provider = null } = {}) {
  const settings = await listSettings(db);
  const m = await findListEmail(db, { now, settings });
  if (!m) return { found: false };
  const { rows: [done] } = await db.query('SELECT id, status, reason FROM receivable_lists WHERE account_id = $1 AND provider_id = $2', [m.account_id, m.provider_id]);
  if (done) return { already: done };

  let files;
  try {
    const { rows: [account] } = await db.query('SELECT * FROM connected_accounts WHERE id = $1', [m.account_id]);
    files = await (provider || providerFor(account)).attachments(m.provider_id);
  } catch (err) {
    return { error: err.message };
  }
  const file = pickFile(files, settings.phrases);
  if (!file) return { stored: await store(db, m, { reason: 'no spreadsheet or PDF attached' }) };

  let read;
  if (isSheet(file)) {
    // A protected or broken file is recorded as not used, so it is not fetched again every run.
    try { read = { method: 'xlsx', file: file.name, ...readSheet(file.content) }; } catch { return { stored: await store(db, m, { file: file.name, reason: 'the spreadsheet could not be opened (protected or damaged)' }) }; }
  } else {
    const chat = chatFn();
    if (!ai || !chat) return { waiting: 'a PDF list is read by the AI, which this run may not use' };
    const limits = await enquirySettings(db);
    if (await aiCallsToday(db) >= limits.dailyAiLimit) return { waiting: `the daily AI ceiling (${limits.dailyAiLimit}) is reached` };
    let pages;
    try { pages = await pdfText(file.content); } catch { return { stored: await store(db, m, { file: file.name, reason: 'the PDF could not be read' }) }; }
    const text = pages.join('\n\n');
    if (text.replace(/\s+/g, '').length < SCANNED_BELOW) return { stored: await store(db, m, { file: file.name, reason: 'a scanned PDF, with no text to check the amounts against' }) };
    const { system, user } = listPrompt(text);
    await db.query(`INSERT INTO email_ai_calls (purpose) VALUES ('receivables_list')`);
    let raw;
    try { raw = await chat(system, user); } catch (err) { return { error: `AI failed: ${err.message}` }; }
    read = { method: 'ai', file: file.name, ...parseListVerdict(raw), text };
  }
  const reason = checkList(read);
  return { stored: await store(db, m, { ...read, reason }) };
}
