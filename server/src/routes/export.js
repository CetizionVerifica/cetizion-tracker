import { Router } from 'express';
import XLSX from 'xlsx';
import { query } from '../db.js';
import { buildWhere } from '../lib/crud.js';
import { resources } from '../lib/resources.js';
import {
  customerCsvRows, customerReport, fxCsvRows, fxReport, reportPeriod, sectorCsvRows, sectorReport,
} from '../lib/salesReport.js';
import {
  invoicingCsvRows, ordersCsvRows, overdueCsvRows, paymentStatusCsvRows, revenueReport,
} from '../lib/revenueReport.js';
import { reportTimeZone, salesReportPdf } from '../lib/salesReportPdf.js';
import { dataGaps, exchangeRates, salesReviewSections } from '../lib/salesReviewData.js';
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

const SALES_REPORTS = {
  sectors: { build: sectorReport, toRows: sectorCsvRows },
  customers: { build: customerReport, toRows: customerCsvRows },
  fx: { build: fxReport, toRows: fxCsvRows },
  orders: { build: revenueReport, toRows: ordersCsvRows },
  invoicing: { build: revenueReport, toRows: invoicingCsvRows },
  'payment-status': { build: revenueReport, toRows: paymentStatusCsvRows },
  overdue: { build: revenueReport, toRows: overdueCsvRows },
};

// Report builders started at once for the PDF. The two that fan out the
// most are revenueReport (4 queries) and salesReviewSections (3), so at
// most 7 of the pool's 10 connections are in use at a time.
const REPORT_CONCURRENCY = 2;

/**
 * Run tasks a few at a time, results in the order they were given. Several
 * report builders fan out into queries of their own, so the limit is well
 * under the database pool size and the rest of the app keeps its connections.
 */
async function runWithLimit(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < tasks.length && !failure) {
      const index = next;
      next += 1;
      try {
        results[index] = await tasks[index]();
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure) throw failure;
  return results;
}

/** The whole sales report as one PDF: ?from=&to=, exactly as on screen — every section, revenue included, covers the same period. */
exportRouter.get('/sales-report.pdf', async (req, res) => {
  const period = reportPeriod(req.query);

  const [sectors, customers, fx, revenue, review, gaps, rates] = await runWithLimit([
    () => sectorReport(period),
    () => customerReport(period),
    () => fxReport(period),
    // The PDF has no year picker, so the query behind it is skipped.
    () => revenueReport(period, { includeYears: false }),
    () => salesReviewSections(period),
    () => dataGaps(period),
    () => exchangeRates(),
  ], REPORT_CONCURRENCY);
  const pdf = await salesReportPdf({
    period,
    sectors, customers, fx, revenue, gaps, rates,
    enquiries: review.enquiries, quotationStatus: review.quotationStatus, services: review.services, contracts: review.contracts,
    generatedAt: new Date(),
    timeZone: reportTimeZone(req.query.tz),
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
  const rows = report.toRows(await report.build(period));

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
  const where = buildWhere(def, req.query, params);
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
