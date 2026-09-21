/**
 * The books side of the accounting integration (#48): read entries in,
 * match them to the tracker, list the differences, and apply what the
 * books say about payments.
 */
import XLSX from 'xlsx';
import { query, transaction } from '../../db.js';
import { normaliseNumber } from './gst.js';

// Column names used by Zoho Books and Tally exports, and common hand-made sheets.
const COLUMNS = {
  number: ['invoice number', 'invoice no', 'invoice#', 'voucher no', 'voucher number', 'bill no', 'number', 'payment number', 'receipt no'],
  date: ['invoice date', 'date', 'voucher date', 'payment date', 'receipt date'],
  due_date: ['due date'],
  customer_name: ['customer name', 'party name', 'particulars', 'customer', 'ledger name', 'party'],
  customer_gstin: ['gst identification number (gstin)', 'gstin', 'gstin/uin', 'customer gstin', 'gstin of party'],
  taxable_amount: ['subtotal', 'sub total', 'taxable value', 'taxable amount', 'item total'],
  tax_amount: ['tax amount', 'total tax', 'gst amount', 'tax'],
  total_amount: ['total', 'invoice total', 'amount', 'credit amount', 'debit amount', 'gross total', 'amount received'],
  tds_amount: ['tds', 'tds amount', 'tax deducted at source', 'withholding tax'],
  currency: ['currency code', 'currency'],
  reference: ['reference number', 'reference', 'invoice number(s)', 'against invoice', 'applied invoice', 'bill ref'],
  status: ['invoice status', 'status'],
  books_id: ['invoice id', 'payment id', 'voucher key', 'guid', 'id'],
  voucher_type: ['voucher type', 'type'],
};

const excelDate = (v) => {
  if (v == null || v === '') return null;
  // Spreadsheet dates come back at local midnight; read them the same way.
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/. ](\d{1,2}|[A-Za-z]{3})[-/. ](\d{2,4})$/);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mon = /\d/.test(m[2]) ? Number(m[2]) : months.indexOf(m[2].toLowerCase()) + 1;
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (mon >= 1 && mon <= 12) return `${year}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
};
const amount = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[₹,\s]|INR|Rs\.?/gi, '').replace(/\((.*)\)/, '-$1'));
  return Number.isFinite(n) ? Math.abs(n) : null;
};

/**
 * Rows of an export file as books entries. `kind` is invoice or payment;
 * a Tally day book with a Voucher Type column sorts itself.
 */
export function parseBooksFile(buffer, { kind = 'invoice' } = {}) {
  // raw: CSV cells stay text, so 01/06/2026 is read day-first as Indian exports mean it, not guessed as US.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  // The header is the first row naming at least two known columns (exports often start with a title).
  const known = new Set(Object.values(COLUMNS).flat());
  const headerAt = grid.findIndex((r) => r.filter((c) => known.has(String(c).trim().toLowerCase())).length >= 2);
  if (headerAt < 0) return { entries: [], problems: ['No header row with invoice or payment columns was found'] };
  const header = grid[headerAt].map((c) => String(c).trim().toLowerCase());
  // Every column that can hold a field, in order; the first one filled wins (Tally splits debit and credit).
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, names]) => [k, names.map((n) => header.indexOf(n)).filter((i) => i >= 0)]));
  const get = (row, k) => col[k].map((i) => row[i]).find((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const entries = []; const problems = [];
  grid.slice(headerAt + 1).forEach((row, i) => {
    if (!row.some((c) => String(c).trim() !== '')) return;
    const vt = String(get(row, 'voucher_type') || '').toLowerCase();
    const rowKind = vt ? (vt.includes('receipt') || vt.includes('payment') ? 'payment' : vt.includes('credit') ? 'credit_note' : vt.includes('sales') || vt.includes('invoice') ? 'invoice' : null) : kind;
    if (!rowKind) return;
    const number = String(get(row, 'number') ?? '').trim();
    const e = {
      kind: rowKind, number: number || null,
      entry_date: excelDate(get(row, 'date')), due_date: excelDate(get(row, 'due_date')),
      customer_name: String(get(row, 'customer_name') ?? '').trim() || null,
      customer_gstin: String(get(row, 'customer_gstin') ?? '').trim().toUpperCase() || null,
      taxable_amount: amount(get(row, 'taxable_amount')), tax_amount: amount(get(row, 'tax_amount')),
      total_amount: amount(get(row, 'total_amount')), tds_amount: amount(get(row, 'tds_amount')),
      currency: String(get(row, 'currency') || 'INR').trim().toUpperCase().slice(0, 3) || 'INR',
      reference: String(get(row, 'reference') ?? '').trim() || null,
      status: String(get(row, 'status') ?? '').trim() || null,
    };
    e.books_id = String(get(row, 'books_id') || '').trim() || `${rowKind}:${number || `${e.entry_date}:${e.customer_name}:${e.total_amount}`}`;
    if (!e.number && rowKind === 'invoice') { problems.push(`Row ${headerAt + i + 2}: no invoice number`); return; }
    if (e.total_amount == null && e.taxable_amount == null) { problems.push(`Row ${headerAt + i + 2}: no amount`); return; }
    entries.push(e);
  });
  return { entries, problems };
}

export async function log(action, detail, by, db = { query }) {
  await db.query('INSERT INTO accounting_log (action, detail, done_by) VALUES ($1,$2,$3)', [action, JSON.stringify(detail), by || 'system']);
}

/** Store entries; the books win, so an entry seen again replaces the old copy. */
export async function saveEntries(entries, { source, by }) {
  let saved = 0;
  await transaction(async (db) => {
    for (const e of entries) {
      const { rows: [co] } = await db.query(
        `SELECT c.id FROM companies c
          LEFT JOIN accounting_mappings m ON m.kind = 'customer' AND m.tracker_ref = c.id::text
          WHERE ($1::text IS NOT NULL AND upper(c.gstin) = $1) OR (m.books_name IS NOT NULL AND lower(m.books_name) = lower($2)) OR c.name_key = name_key($2)
          ORDER BY (upper(c.gstin) = $1) DESC NULLS LAST LIMIT 1`, [e.customer_gstin, e.customer_name || '']);
      await db.query(
        `INSERT INTO books_entries (source, kind, books_id, number, customer_name, customer_gstin, company_id, entry_date, due_date, taxable_amount, tax_amount, total_amount, tds_amount, currency, reference, status, raw, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (source, kind, books_id) DO UPDATE SET number = EXCLUDED.number, customer_name = EXCLUDED.customer_name, customer_gstin = EXCLUDED.customer_gstin,
           company_id = EXCLUDED.company_id, entry_date = EXCLUDED.entry_date, due_date = EXCLUDED.due_date, taxable_amount = EXCLUDED.taxable_amount,
           tax_amount = EXCLUDED.tax_amount, total_amount = EXCLUDED.total_amount, tds_amount = EXCLUDED.tds_amount, currency = EXCLUDED.currency,
           reference = EXCLUDED.reference, status = EXCLUDED.status, raw = EXCLUDED.raw, imported_at = now(), imported_by = EXCLUDED.imported_by`,
        [source, e.kind, e.books_id, e.number, e.customer_name, e.customer_gstin, co?.id ?? null, e.entry_date, e.due_date, e.taxable_amount, e.tax_amount, e.total_amount, e.tds_amount, e.currency, e.reference, e.status, JSON.stringify(e.raw ?? e), by]);
      saved += 1;
    }
    await log('import', { source, entries: saved }, by, db);
  });
  return saved;
}

const near = (a, b, tol = 1) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;

/**
 * Compare every tracker invoice and payment with the books. Decisions
 * already taken (resolved items) are kept unless the numbers change again.
 */
export async function reconcile({ by = 'system' } = {}) {
  const { rows: stages } = await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.invoice_due_date, s.stage_amount, s.amount_received, s.currency, s.client_name, s.po_number, s.stage_name
       FROM v_payment_stages s WHERE s.invoice_no IS NOT NULL`);
  const { rows: invoices } = await query(`SELECT * FROM books_entries WHERE kind = 'invoice'`);
  const { rows: payments } = await query(`SELECT p.*, s.invoice_no FROM payments p JOIN payment_stages s ON s.id = p.stage_id`);
  const { rows: bookPayments } = await query(`SELECT * FROM books_entries WHERE kind = 'payment'`);
  const byNumber = new Map(invoices.map((b) => [normaliseNumber(b.number), b]));
  const items = [];

  for (const s of stages) {
    const b = byNumber.get(normaliseNumber(s.invoice_no));
    if (!b) { items.push({ kind: 'invoice', match_key: `inv:${normaliseNumber(s.invoice_no)}`, stage_id: s.id, status: 'missing_in_books', differences: [] }); continue; }
    byNumber.delete(normaliseNumber(s.invoice_no));
    const diffs = [];
    // The tracker's stage amount is before GST; compare with the taxable value, else the total less tax.
    const booksTaxable = b.taxable_amount ?? (b.total_amount != null && b.tax_amount != null ? Number(b.total_amount) - Number(b.tax_amount) : null);
    if (booksTaxable != null && !near(booksTaxable, s.stage_amount)) diffs.push({ field: 'amount', tracker: Number(s.stage_amount), books: Number(booksTaxable) });
    if (booksTaxable == null && b.total_amount != null && !near(b.total_amount, s.stage_amount) && !near(Number(b.total_amount) / 1.18, s.stage_amount, 2)) diffs.push({ field: 'amount', tracker: Number(s.stage_amount), books: Number(b.total_amount), note: 'books total, tax not given' });
    if (b.entry_date && s.invoice_date && String(b.entry_date) !== String(s.invoice_date)) diffs.push({ field: 'invoice_date', tracker: s.invoice_date, books: b.entry_date });
    if (b.due_date && s.invoice_due_date && String(b.due_date) !== String(s.invoice_due_date)) diffs.push({ field: 'due_date', tracker: s.invoice_due_date, books: b.due_date });
    if (b.currency && s.currency && b.currency !== s.currency) diffs.push({ field: 'currency', tracker: s.currency, books: b.currency });
    const status = !diffs.length ? 'matched' : diffs.some((d) => d.field === 'amount' || d.field === 'currency') ? 'amount_differs' : 'date_differs';
    items.push({ kind: 'invoice', match_key: `inv:${normaliseNumber(s.invoice_no)}`, stage_id: s.id, books_entry_id: b.id, status, differences: diffs });
  }
  for (const b of byNumber.values()) {
    items.push({ kind: 'invoice', match_key: `inv:${normaliseNumber(b.number)}`, books_entry_id: b.id, status: 'missing_in_tracker', differences: [] });
  }

  // Payments: a books receipt against an invoice we know, matched to a tracker payment of the same amount.
  const stageByNumber = new Map(stages.map((s) => [normaliseNumber(s.invoice_no), s]));
  const usedPayments = new Set();
  for (const b of bookPayments) {
    const refs = String(b.reference || b.number || '').split(/[,;]+/).map(normaliseNumber).filter(Boolean);
    const stage = refs.map((r) => stageByNumber.get(r)).find(Boolean);
    const key = `pay:${b.source}:${b.books_id}`;
    if (!stage) { items.push({ kind: 'payment', match_key: key, books_entry_id: b.id, status: 'missing_in_tracker', differences: [{ field: 'invoice', books: b.reference || null, note: 'no tracker invoice with this reference' }] }); continue; }
    const p = payments.find((x) => x.stage_id === stage.id && !usedPayments.has(x.id) && near(Number(x.amount) + Number(x.tds_amount || 0), Number(b.total_amount) + Number(b.tds_amount || 0)));
    if (!p) { items.push({ kind: 'payment', match_key: key, stage_id: stage.id, books_entry_id: b.id, status: 'missing_in_tracker', differences: [{ field: 'payment', books: Number(b.total_amount), tds: Number(b.tds_amount || 0), date: b.entry_date }] }); continue; }
    usedPayments.add(p.id);
    const diffs = [];
    if (b.entry_date && String(b.entry_date) !== String(p.received_on)) diffs.push({ field: 'received_on', tracker: p.received_on, books: b.entry_date });
    if (b.tds_amount != null && !near(b.tds_amount, p.tds_amount)) diffs.push({ field: 'tds_amount', tracker: Number(p.tds_amount), books: Number(b.tds_amount) });
    items.push({ kind: 'payment', match_key: key, stage_id: stage.id, payment_id: p.id, books_entry_id: b.id, status: diffs.length ? 'date_differs' : 'matched', differences: diffs });
  }
  if (bookPayments.length) {
    for (const p of payments.filter((x) => !usedPayments.has(x.id) && x.notes !== 'Opening balance from the stage')) {
      items.push({ kind: 'payment', match_key: `trk-pay:${p.id}`, stage_id: p.stage_id, payment_id: p.id, status: 'missing_in_books', differences: [] });
    }
  }

  await transaction(async (db) => {
    const { rows: prior } = await db.query(`SELECT match_key, status, differences FROM reconciliation_items WHERE status = 'resolved'`);
    const kept = new Map(prior.map((r) => [r.match_key, r]));
    await db.query(`DELETE FROM reconciliation_items WHERE status <> 'resolved' OR NOT (match_key = ANY($1))`, [items.map((i) => i.match_key)]);
    for (const i of items) {
      const was = kept.get(i.match_key);
      // A resolved item stays resolved while the differences are the ones someone accepted.
      if (was && JSON.stringify(was.differences) === JSON.stringify(i.differences)) { await db.query('UPDATE reconciliation_items SET checked_at = now() WHERE match_key = $1', [i.match_key]); continue; }
      await db.query(
        `INSERT INTO reconciliation_items (kind, match_key, stage_id, payment_id, books_entry_id, status, differences)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (match_key) DO UPDATE SET stage_id = EXCLUDED.stage_id, payment_id = EXCLUDED.payment_id, books_entry_id = EXCLUDED.books_entry_id,
           status = EXCLUDED.status, differences = EXCLUDED.differences, note = NULL, resolved_by = NULL, resolved_at = NULL, checked_at = now()`,
        [i.kind, i.match_key, i.stage_id ?? null, i.payment_id ?? null, i.books_entry_id ?? null, i.status, JSON.stringify(i.differences)]);
    }
    await log('reconcile', { items: items.length, open: items.filter((i) => i.status !== 'matched').length }, by, db);
  });
  const counts = items.reduce((c, i) => ({ ...c, [i.status]: (c[i.status] || 0) + 1 }), {});
  return { items: items.length, counts };
}

/** The books win: take their value into the tracker for one difference. */
export async function acceptBooks(itemId, by) {
  return transaction(async (db) => {
    const { rows: [i] } = await db.query('SELECT r.*, row_to_json(b) AS books FROM reconciliation_items r LEFT JOIN books_entries b ON b.id = r.books_entry_id WHERE r.id = $1 FOR UPDATE OF r', [itemId]);
    if (!i) throw Object.assign(new Error('Not found'), { status: 404 });
    const b = i.books;
    const applied = [];
    if (i.kind === 'payment' && i.status === 'missing_in_tracker' && i.stage_id && b) {
      // The books entry carries its own currency and the stage carries the
      // PO's. Taking the number without reading the currency writes 10,000
      // rupees for a payment of 10,000 dollars. Converting it here would be
      // worse -- at which rate, on which day? -- so this stops and says so.
      const { rows: [s] } = await db.query('SELECT currency FROM v_payment_stages WHERE id = $1', [i.stage_id]);
      const stageCurrency = String(s?.currency || 'INR').toUpperCase();
      const booksCurrency = String(b.currency || stageCurrency).toUpperCase();
      if (booksCurrency !== stageCurrency) {
        throw Object.assign(new Error(`The books entry is in ${booksCurrency} and the invoice stage is in ${stageCurrency}. Record this receipt by hand, with the amount actually received.`), { status: 422 });
      }
      const { rows: [p] } = await db.query(
        `INSERT INTO payments (stage_id, amount, tds_amount, received_on, mode, reference, notes, recorded_by)
         VALUES ($1,$2,$3,$4,'bank_transfer',$5,'From the books',$6) RETURNING id`,
        [i.stage_id, Number(b.total_amount), Number(b.tds_amount || 0), b.entry_date || new Date().toISOString().slice(0, 10), b.number || b.reference, by]);
      applied.push({ payment_id: p.id });
    } else if (i.kind === 'invoice' && i.stage_id && b) {
      for (const d of i.differences) {
        if (d.field === 'invoice_date') { await db.query('UPDATE payment_stages SET invoice_date = $2 WHERE id = $1', [i.stage_id, d.books]); applied.push(d); }
        if (d.field === 'due_date') { await db.query(`UPDATE payment_stages SET credit_days = ($2::date - invoice_date) WHERE id = $1`, [i.stage_id, d.books]); applied.push(d); }
      }
    } else if (i.kind === 'payment' && i.payment_id && b) {
      for (const d of i.differences) {
        if (d.field === 'received_on') { await db.query('UPDATE payments SET received_on = $2 WHERE id = $1', [i.payment_id, d.books]); applied.push(d); }
        if (d.field === 'tds_amount') { await db.query('UPDATE payments SET tds_amount = $2 WHERE id = $1', [i.payment_id, d.books]); applied.push(d); }
      }
    }
    if (!applied.length) throw Object.assign(new Error('Nothing here can be taken from the books automatically; fix it by hand and mark it resolved'), { status: 422 });
    await db.query(`UPDATE reconciliation_items SET status = 'resolved', note = 'Books value applied', resolved_by = $2, resolved_at = now() WHERE id = $1`, [itemId, by]);
    await log('apply_books', { item: itemId, applied }, by, db);
    return { applied };
  });
}

/** Payments in the books that the tracker lacks, recorded on their invoice (when switched on). */
export async function applyBookPayments(by = 'system') {
  const { rows } = await query(`SELECT id FROM reconciliation_items WHERE kind = 'payment' AND status = 'missing_in_tracker' AND stage_id IS NOT NULL`);
  const done = [];
  for (const r of rows) done.push(await acceptBooks(r.id, by).catch((e) => ({ error: e.message })));
  return done.filter((d) => !d.error).length;
}
