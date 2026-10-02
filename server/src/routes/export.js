import { Router } from 'express';
import XLSX from 'xlsx';
import { query } from '../db.js';
import { listWhere } from '../lib/crud.js';
import { resources } from '../lib/resources.js';
import { scopeOf } from '../auth/ownership.js';
import {
  customerCsvRows, customerReport, fxCsvRows, fxReport, reportPeriod, sectorCsvRows, sectorReport,
} from '../lib/salesReport.js';
import {
  invoicingCsvRows, ordersCsvRows, overdueCsvRows, paymentStatusCsvRows, revenueReport,
} from '../lib/revenueReport.js';
import { reportTimeZone } from '../lib/pdfBlocks.js';
import { reportPdf } from '../lib/reportPdf.js';
import { reportGrain, reportScope, salesReport } from '../lib/reportDefinitions.js';
import {
  enquiriesCsvRows, newCustomersCsvRows, outcomesCsvRows, repeatOrdersCsvRows, revenueCsvRows, revenuePosCsvRows,
  sectorCsvRows as sectorPosCsvRows, servicesCsvRows,
} from '../lib/reportCsv.js';
import { payablesRows } from '../lib/payables.js';
import { ApiError } from '../middleware/error.js';

export const exportRouter = Router();

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(',')),
  ].join('\n');
}

function sendCsv(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send(toCsv(rows));
}

// Every builder here takes (period, scope) so the map can call them the same
// way. revenueReport takes its scope in an options object, so it is adapted.
const buildRevenue = (period, scope) => revenueReport(period, { scope });

/**
 * The Reports section's report for a request: its period, its grain, and the
 * owner an admin narrowed it to (a sales user's own records, whatever they
 * asked). The screen, every section CSV and the PDF build it the same way.
 */
const buildSections = (period, scope, reqQuery = {}) =>
  salesReport(period, { grain: reportGrain(reqQuery, period), scope: reportScope(scope, reqQuery) });

const SALES_REPORTS = {
  // The Reports section, one CSV per question (docs/sales-report-rework-plan.md §5.1).
  enquiries: { build: buildSections, toRows: enquiriesCsvRows },
  outcomes: { build: buildSections, toRows: outcomesCsvRows },
  'sector-pos': { build: buildSections, toRows: sectorPosCsvRows },
  services: { build: buildSections, toRows: servicesCsvRows },
  'new-customers': { build: buildSections, toRows: newCustomersCsvRows },
  'repeat-orders': { build: buildSections, toRows: repeatOrdersCsvRows },
  revenue: { build: buildSections, toRows: revenueCsvRows },
  'revenue-pos': { build: buildSections, toRows: revenuePosCsvRows },
  // Detailed tables the old Sales reports page showed, linked under More analysis.
  sectors: { build: sectorReport, toRows: sectorCsvRows },
  customers: { build: customerReport, toRows: customerCsvRows },
  fx: { build: fxReport, toRows: fxCsvRows },
  orders: { build: buildRevenue, toRows: ordersCsvRows },
  invoicing: { build: buildRevenue, toRows: invoicingCsvRows },
  'payment-status': { build: buildRevenue, toRows: paymentStatusCsvRows },
  overdue: { build: buildRevenue, toRows: overdueCsvRows },
};

/**
 * The Reports section as one PDF, for ?from=&to=&grain=&owner= exactly as on
 * screen: the same salesReport() the page reads, so the two always agree. A
 * report of whatever the reader may see (#18 Phase 2C).
 */
exportRouter.get('/sales-report.pdf', async (req, res) => {
  const period = reportPeriod(req.query);
  const scope = reportScope(scopeOf(req), req.query);
  const [report, names] = await Promise.all([
    salesReport(period, { grain: reportGrain(req.query, period), scope }),
    query(
      `SELECT (SELECT value FROM settings WHERE key = 'company_name') AS company,
              (SELECT name FROM users WHERE id = $1) AS owner`,
      [scope.unrestricted ? null : scope.ownerId]
    ),
  ]);
  const { company, owner } = names.rows[0];
  const pdf = await reportPdf(report, {
    company: company?.trim() || 'Cetizion Verifica',
    // A sales user's PDF is their own; only an admin's narrowed one names the owner.
    owner: scopeOf(req).unrestricted ? owner : null,
    generatedAt: new Date(),
    timeZone: reportTimeZone(req.query.tz || 'Asia/Kolkata'),
  });

  const span = period.from || period.to ? `-${period.from ?? 'start'}-to-${period.to ?? 'today'}` : '';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="cetizion-sales-report${span}.pdf"`);
  res.send(pdf);
});

/** The sales reports, for the same ?from=&to= range (and filters) the report page shows. */
exportRouter.get('/sales-report/:report.csv', async (req, res) => {
  const name = req.params.report;
  if (!Object.hasOwn(SALES_REPORTS, name)) throw new ApiError(404, 'Unknown report');

  const period = reportPeriod(req.query);
  const report = SALES_REPORTS[name];
  const rows = report.toRows(await report.build(period, scopeOf(req), req.query));

  const span = period.from || period.to
    ? `-${period.from ?? 'start'}-to-${period.to ?? 'today'}`
    : '';
  sendCsv(res, `cetizion-sales-${name}${span}`, rows);
});

/** A list as rows, with the same search and filters the page applies (#45). */
async function listRows(req) {
  const def = resources[req.params.resource];
  if (!def) throw new ApiError(404, 'Unknown export');
  const params = [];
  // The same rows the page would show this person, and no others.
  //
  // main found this door open from its side too: a sales user got a 404 on a
  // colleague's note through /api/notes/:id and then downloaded every note in
  // the company through /api/export/notes.csv. A control with a second door
  // beside it is not a control. Ours was half-open the same way — it asked
  // only about `ownerScoped`, so the parent-derived resources (notes, tasks,
  // attachments, POs, stages, lines, payments, costs) walked straight out.
  // resourceClause answers for every ownership shape, so both doors close.
  const relation = def.view || def.table;
  const where = await listWhere(def, req.query, params, scopeOf(req), relation);
  const { rows } = await query(
    `SELECT * FROM "${def.view || def.table}" ${where} ORDER BY ${def.defaultSort}`,
    params
  );
  // Documents are opened from the app's tables; the spreadsheet leaves them out.
  for (const row of rows) {
    delete row.document_id;
    delete row.document_name;
  }
  return rows;
}

/**
 * The payables page as a spreadsheet (#76): the same rows, in the same
 * order, as /api/dashboard/payables. Registered before /:resource.csv,
 * which would otherwise take "payables" for a resource and 404.
 */
exportRouter.get('/payables.csv', async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  sendCsv(res, `cetizion-payables-${stamp}`, await payablesRows());
});

/**
 * Any list can still leave as a spreadsheet — the point is that the
 * spreadsheet is now an export, not the system of record. What leaves is
 * what the page shows: the same search and filters apply.
 */
exportRouter.get('/:resource.csv', async (req, res) => {
  const rows = await listRows(req);
  const stamp = new Date().toISOString().slice(0, 10);
  sendCsv(res, `cetizion-${req.params.resource}-${stamp}`, rows);
});

exportRouter.get('/:resource.xlsx', async (req, res) => {
  const rows = await listRows(req);
  const sheet = XLSX.utils.json_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, req.params.resource.slice(0, 31));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="cetizion-${req.params.resource}-${stamp}.xlsx"`);
  res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
});
