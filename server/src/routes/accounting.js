/**
 * Accounting integration and tax reports (#48).
 *
 *   GET  /api/accounting/status                   provider, what is configured, last runs, open differences
 *   POST /api/accounting/import?kind=invoice|payment&source=zoho|tally|file   (multipart "file")
 *   POST /api/accounting/sync                     pull from Zoho (when set up), then reconcile
 *   POST /api/accounting/reconcile
 *   GET  /api/accounting/items?status=
 *   POST /api/accounting/items/:id/accept         take the books' values
 *   POST /api/accounting/items/:id/resolve        { note }  fixed by hand or explained
 *   GET  /api/accounting/entries?kind=
 *   GET/POST /api/accounting/mappings · DELETE /api/accounting/mappings/:id
 *   GET  /api/accounting/stages/:id/draft         what the invoice should say
 *   POST /api/accounting/stages/:id/draft         create it in the books (Zoho, Tally) or get the Tally XML
 *   GET  /api/accounting/reports/tds.csv?from=&to=
 *   GET  /api/accounting/reports/gstr1-b2b.csv?from=&to=
 *   GET  /api/accounting/reports/summary?from=&to=   the same numbers, for the page
 *   GET  /api/accounting/log
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { acceptBooks, applyBookPayments, log, parseBooksFile, reconcile, saveEntries } from '../lib/accounting/books.js';
import { draftForStage, tallyConfigured, tallyPush, tallyVoucherXml, zohoConfigured, zohoCreateDraft, zohoPull } from '../lib/accounting/providers.js';
import { checkGstin, fyQuarter, gstDate } from '../lib/accounting/gst.js';

export const accountingRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const who = (req) => req.user?.username || 'admin';
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const setting = async (key, fallback) => (await query('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value ?? fallback;
const csv = (rows) => rows.map((r) => r.map((c) => { const s = c == null ? '' : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');

accountingRouter.get('/status', async (req, res) => {
  const [provider, apply, { rows: counts }, { rows: entries }, { rows: last }] = await Promise.all([
    setting('accounting_provider', 'none'), setting('accounting_apply_payments', 'false'),
    query('SELECT status, COUNT(*)::int AS n FROM reconciliation_items GROUP BY status'),
    query('SELECT source, kind, COUNT(*)::int AS n, MAX(imported_at) AS last FROM books_entries GROUP BY source, kind'),
    query(`SELECT action, detail, done_by, created_at FROM accounting_log ORDER BY id DESC LIMIT 1`),
  ]);
  res.json({ data: { provider, apply_payments: apply === 'true', zoho: zohoConfigured(), tally: tallyConfigured(), counts: Object.fromEntries(counts.map((r) => [r.status, r.n])), entries, last: last[0] || null } });
});

accountingRouter.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) throw new ApiError(422, 'Choose an export file (CSV or Excel)');
  const kind = ['invoice', 'payment'].includes(req.query.kind) ? req.query.kind : 'invoice';
  const source = ['zoho', 'tally', 'file'].includes(req.query.source) ? req.query.source : 'file';
  const { entries, problems } = parseBooksFile(req.file.buffer, { kind });
  if (!entries.length) throw new ApiError(422, problems[0] || 'No invoices or payments were found in that file', { problems });
  const saved = await saveEntries(entries, { source, by: who(req) });
  const result = await reconcile({ by: who(req) });
  res.json({ data: { saved, problems, reconcile: result } });
});

accountingRouter.post('/sync', async (req, res) => {
  res.json({ data: await runAccountingSync({ by: who(req) }) });
});

/** The daily job, and the button: pull when there is an API, reconcile, apply payments if allowed. */
export async function runAccountingSync({ by = 'schedule' } = {}) {
  const provider = await setting('accounting_provider', 'none');
  if (provider === 'none') return { skipped: 'accounting_provider is none' };
  let pulled = 0;
  if (provider === 'zoho') {
    if (!zohoConfigured()) throw new Error('Zoho Books is not set up (ZOHO_* variables)');
    const { rows: [lastPull] } = await query(`SELECT created_at FROM accounting_log WHERE action = 'pull' ORDER BY id DESC LIMIT 1`);
    const since = lastPull ? new Date(new Date(lastPull.created_at).getTime() - 2 * 864e5).toISOString().slice(0, 10) : null;
    const entries = await zohoPull(since);
    pulled = await saveEntries(entries, { source: 'zoho', by });
    await log('pull', { source: 'zoho', since, entries: pulled }, by);
  }
  const result = await reconcile({ by });
  let applied = 0;
  if ((await setting('accounting_apply_payments', 'false')) === 'true') applied = await applyBookPayments(by);
  return { provider, pulled, ...result, payments_applied: applied };
}

accountingRouter.post('/reconcile', async (req, res) => {
  res.json({ data: await reconcile({ by: who(req) }) });
});

accountingRouter.get('/items', async (req, res) => {
  const params = []; const where = [];
  if (req.query.status) { params.push(String(req.query.status).split(',')); where.push(`r.status = ANY($${params.length})`); }
  else where.push(`r.status <> 'matched'`);
  const { rows } = await query(
    `SELECT r.*, s.invoice_no, s.po_number, s.stage_name, s.client_name, s.stage_amount, s.invoice_date,
            b.number AS books_number, b.customer_name AS books_customer, b.total_amount AS books_total, b.taxable_amount AS books_taxable, b.entry_date AS books_date, b.source,
            p.amount AS payment_amount, p.received_on
       FROM reconciliation_items r
       LEFT JOIN v_payment_stages s ON s.id = r.stage_id
       LEFT JOIN books_entries b ON b.id = r.books_entry_id
       LEFT JOIN payments p ON p.id = r.payment_id
      WHERE ${where.join(' AND ')} ORDER BY r.kind, r.status, r.id LIMIT 1000`, params);
  res.json({ data: rows });
});

accountingRouter.post('/items/:id/accept', async (req, res) => {
  try { res.json({ data: await acceptBooks(Number(req.params.id), who(req)) }); }
  catch (err) { if (err.status) throw new ApiError(err.status, err.message); throw err; }
});

accountingRouter.post('/items/:id/resolve', async (req, res) => {
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!note) throw new ApiError(422, 'Please check the highlighted fields', { fields: { note: 'Say what was done or why it differs' } });
  const { rows: [r] } = await query(`UPDATE reconciliation_items SET status = 'resolved', note = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 RETURNING id, status`, [Number(req.params.id), note, who(req)]);
  if (!r) throw new ApiError(404, 'Not found');
  await log('resolve', { item: r.id, note }, who(req));
  res.json({ data: r });
});

accountingRouter.get('/entries', async (req, res) => {
  const kind = ['invoice', 'payment', 'credit_note'].includes(req.query.kind) ? req.query.kind : 'invoice';
  const { rows } = await query(`SELECT b.id, b.source, b.kind, b.number, b.customer_name, b.customer_gstin, c.name AS company_name, b.entry_date, b.due_date, b.taxable_amount, b.tax_amount, b.total_amount, b.tds_amount, b.currency, b.reference, b.status, b.imported_at
                                  FROM books_entries b LEFT JOIN companies c ON c.id = b.company_id WHERE b.kind = $1 ORDER BY b.entry_date DESC NULLS LAST LIMIT 1000`, [kind]);
  res.json({ data: rows });
});

// ------------------------------------------------------------ mappings

accountingRouter.get('/mappings', async (req, res) => {
  const { rows } = await query(
    `SELECT m.*, CASE WHEN m.kind = 'customer' THEN (SELECT name FROM companies WHERE id::text = m.tracker_ref) ELSE m.tracker_ref END AS tracker_name
       FROM accounting_mappings m ORDER BY m.kind, tracker_name`);
  // Customers in the books with no company matched yet, to map by hand.
  const { rows: unmatched } = await query(`SELECT DISTINCT customer_name, customer_gstin FROM books_entries WHERE company_id IS NULL AND customer_name IS NOT NULL ORDER BY customer_name LIMIT 200`);
  res.json({ data: rows, unmatched });
});

accountingRouter.post('/mappings', async (req, res) => {
  const parsed = z.object({ kind: z.enum(['customer', 'service', 'ledger', 'tax']), tracker_ref: z.string().trim().min(1).max(200), books_ref: z.string().trim().min(1).max(200), books_name: z.string().trim().max(200).optional() }).safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const v = parsed.data;
  const { rows: [m] } = await query(
    `INSERT INTO accounting_mappings (kind, tracker_ref, books_ref, books_name, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (kind, tracker_ref) DO UPDATE SET books_ref = EXCLUDED.books_ref, books_name = EXCLUDED.books_name RETURNING *`,
    [v.kind, v.tracker_ref, v.books_ref, v.books_name || null, who(req)]);
  if (v.kind === 'customer' && v.books_name) {
    await query('UPDATE books_entries SET company_id = $1 WHERE company_id IS NULL AND lower(customer_name) = lower($2)', [Number(v.tracker_ref), v.books_name]);
  }
  await log('mapping', v, who(req));
  res.status(201).json({ data: m });
});

accountingRouter.delete('/mappings/:id', async (req, res) => {
  await query('DELETE FROM accounting_mappings WHERE id = $1', [Number(req.params.id)]);
  res.status(204).end();
});

// ------------------------------------------------------------ draft invoices

accountingRouter.get('/stages/:id/draft', async (req, res) => {
  try { res.json({ data: await draftForStage(Number(req.params.id)) }); }
  catch (err) { if (err.status) throw new ApiError(err.status, err.message); throw err; }
});

accountingRouter.post('/stages/:id/draft', async (req, res) => {
  const draft = await draftForStage(Number(req.params.id)).catch((err) => { throw err.status ? new ApiError(err.status, err.message) : err; });
  if (draft.invoice_no) throw new ApiError(409, `This stage already has invoice ${draft.invoice_no}`);
  const provider = await setting('accounting_provider', 'none');
  const target = req.body?.target || provider;
  let result;
  try {
    if (target === 'zoho') result = await zohoCreateDraft(draft);
    else if (target === 'tally' && tallyConfigured() && req.body?.push) result = await tallyPush(tallyVoucherXml(draft));
    else if (target === 'tally' || target === 'tally_xml') {
      await log('draft', { stage_id: draft.stage_id, target: 'tally_xml' }, who(req));
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="tally-voucher-stage-${draft.stage_id}.xml"`);
      return res.send(tallyVoucherXml(draft));
    } else throw new ApiError(422, 'Choose where the draft goes: set accounting_provider to zoho or tally');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.status) throw new ApiError(err.status, err.message);
    throw new ApiError(502, err.message);
  }
  await log('draft', { stage_id: draft.stage_id, ...result }, who(req));
  res.status(201).json({ data: { draft, result } });
});

// ------------------------------------------------------------ reports

function period(req) {
  const from = day(req.query.from); const to = day(req.query.to);
  if (!from || !to) throw new ApiError(422, 'from and to dates are required');
  return { from, to };
}

async function tdsRows(from, to) {
  const { rows } = await query(
    `SELECT p.received_on, p.amount, p.tds_amount, p.reference, s.invoice_no, s.po_number, c.name AS client, c.gstin
       FROM payments p JOIN payment_stages s ON s.id = p.stage_id JOIN purchase_orders po ON po.po_number = s.po_number
       JOIN projects pr ON pr.project_id = po.project_id LEFT JOIN companies c ON c.id = pr.company_id
      WHERE p.tds_amount > 0 AND p.received_on BETWEEN $1 AND $2 ORDER BY c.name, p.received_on`, [from, to]);
  return rows.map((r) => ({ ...r, ...fyQuarter(r.received_on), pan: checkGstin(r.gstin).pan || null }));
}

async function salesRows(from, to) {
  const { rows } = await query(
    `SELECT s.id, s.invoice_no, s.invoice_date, s.stage_amount, s.currency, c.name AS client, c.gstin, q.place_of_supply_state, q.id AS quotation_id,
            (SELECT json_agg(m) FROM (SELECT COALESCE(gst_rate, 0) AS rate, SUM(amount) AS amount FROM quotation_lines
                                         WHERE quotation_id = q.id AND amount > 0 GROUP BY COALESCE(gst_rate, 0)) m) AS rate_mix
       FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects pr ON pr.project_id = po.project_id
       LEFT JOIN companies c ON c.id = pr.company_id LEFT JOIN quotations q ON q.quotation_no = po.quotation_no
      WHERE s.invoice_no IS NOT NULL AND s.invoice_date BETWEEN $1 AND $2 ORDER BY s.invoice_date, s.invoice_no`, [from, to]);
  const defaultRate = Number(await setting('gst_rate_default', '18'));
  return rows.map((r) => {
    const g = checkGstin(r.gstin);
    const taxable = Number(r.stage_amount);
    // One line per GST rate on the quotation, not one line at the average of
    // them. An invoice for 100,000 at 18% and 10,000 at 5% is two lines; a
    // single line at 16.82% is a rate that does not exist and the GST
    // offline tool rejects it. The stage is split in the proportions the
    // quotation used, with the rounding paisa on the last line.
    const mix = (r.rate_mix || []).map((m) => ({ rate: Number(m.rate), amount: Number(m.amount) })).filter((m) => m.amount > 0).sort((x, y) => y.amount - x.amount);
    const base = mix.reduce((n, m) => n + m.amount, 0);
    const parts = mix.length && base > 0
      ? mix.map((m) => ({ rate: m.rate, taxable: Math.round(taxable * (m.amount / base) * 100) / 100 }))
      : [{ rate: defaultRate, taxable }];
    const gap = Math.round((taxable - parts.reduce((n, p) => n + p.taxable, 0)) * 100) / 100;
    parts[parts.length - 1].taxable = Math.round((parts[parts.length - 1].taxable + gap) * 100) / 100;
    const invoiceValue = Math.round(parts.reduce((n, p) => n + p.taxable * (100 + p.rate) / 100, 0) * 100) / 100;
    return {
      ...r, gstin_valid: g.valid, state_code: g.valid ? g.state_code : (r.place_of_supply_state || '').match(/^\d{2}/)?.[0] || null,
      parts, rate: parts.length === 1 ? parts[0].rate : null, taxable, invoice_value: invoiceValue,
    };
  });
}

accountingRouter.get('/reports/summary', async (req, res) => {
  const { from, to } = period(req);
  const [tds, sales] = await Promise.all([tdsRows(from, to), salesRows(from, to)]);
  const tdsByClient = {};
  for (const r of tds) {
    const k = `${r.client || 'Unknown'}|${r.label}`;
    tdsByClient[k] ||= { client: r.client || 'Unknown', pan: r.pan, quarter: r.label, payments: 0, received: 0, tds: 0 };
    Object.assign(tdsByClient[k], { payments: tdsByClient[k].payments + 1, received: tdsByClient[k].received + Number(r.amount), tds: tdsByClient[k].tds + Number(r.tds_amount) });
  }
  const b2b = sales.filter((s) => s.gstin_valid && s.currency === 'INR');
  const b2c = sales.filter((s) => !s.gstin_valid && s.currency === 'INR');
  const exports = sales.filter((s) => s.currency !== 'INR');
  const sum = (list, k) => Math.round(list.reduce((t, x) => t + Number(x[k]), 0) * 100) / 100;
  // Books totals for the same period, to compare.
  const { rows: [books] } = await query(`SELECT COALESCE(SUM(taxable_amount), 0) AS taxable, COALESCE(SUM(total_amount), 0) AS total, COUNT(*)::int AS invoices FROM books_entries WHERE kind = 'invoice' AND entry_date BETWEEN $1 AND $2`, [from, to]);
  const { rows: [booksTds] } = await query(`SELECT COALESCE(SUM(tds_amount), 0) AS tds FROM books_entries WHERE kind = 'payment' AND entry_date BETWEEN $1 AND $2`, [from, to]);
  res.json({
    data: {
      from, to,
      tds: { by_client: Object.values(tdsByClient), total: sum(tds, 'tds_amount'), books_total: Number(booksTds.tds) },
      gst: {
        b2b: { invoices: b2b.length, taxable: sum(b2b, 'taxable'), value: sum(b2b, 'invoice_value') },
        b2c: { invoices: b2c.length, taxable: sum(b2c, 'taxable'), value: sum(b2c, 'invoice_value') },
        foreign_currency: { invoices: exports.length },
        missing_gstin: b2c.map((s) => ({ invoice_no: s.invoice_no, client: s.client, gstin: s.gstin })),
        books: { invoices: books.invoices, taxable: Number(books.taxable), total: Number(books.total) },
      },
    },
  });
});

accountingRouter.get('/reports/tds.csv', async (req, res) => {
  const { from, to } = period(req);
  const rows = await tdsRows(from, to);
  await log('report', { report: 'tds', from, to }, who(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tds-${from}-to-${to}.csv"`);
  res.send(`﻿${csv([['Quarter', 'Client', 'PAN (from GSTIN)', 'Received on', 'Invoice', 'PO', 'Amount received', 'TDS deducted', 'Gross (received + TDS)', 'Reference'],
    ...rows.map((r) => [r.label, r.client, r.pan, r.received_on, r.invoice_no, r.po_number, r.amount, r.tds_amount, (Number(r.amount) + Number(r.tds_amount)).toFixed(2), r.reference])])}`);
});

accountingRouter.get('/reports/gstr1-b2b.csv', async (req, res) => {
  const { from, to } = period(req);
  const rows = (await salesRows(from, to)).filter((s) => s.gstin_valid && s.currency === 'INR');
  const { STATES } = await import('../lib/accounting/gst.js');
  await log('report', { report: 'gstr1-b2b', from, to }, who(req));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gstr1-b2b-${from}-to-${to}.csv"`);
  // The column order of the GST offline tool's B2B sheet.
  res.send(`﻿${csv([['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
    // A mixed-rate invoice is several lines sharing one invoice number and
    // one invoice value, which is what the B2B sheet expects.
    ...rows.flatMap((r) => r.parts.map((p) => [r.gstin.toUpperCase(), r.client, r.invoice_no, gstDate(r.invoice_date), r.invoice_value.toFixed(2), `${r.state_code}-${STATES[r.state_code] || STATES[Number(r.state_code)] || ''}`, 'N', '', 'Regular B2B', '', p.rate, p.taxable.toFixed(2), '0']))])}`);
});

accountingRouter.get('/log', async (req, res) => {
  const { rows } = await query('SELECT * FROM accounting_log ORDER BY id DESC LIMIT 200');
  res.json({ data: rows });
});
