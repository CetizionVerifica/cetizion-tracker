import { Router } from 'express';
import { query } from '../db.js';
import { resources } from '../lib/resources.js';
import {
  customerCsvRows, customerReport, fxCsvRows, fxReport, reportPeriod, sectorCsvRows, sectorReport,
} from '../lib/salesReport.js';
import {
  invoicingCsvRows, ordersCsvRows, paymentStatusCsvRows, revenueReport,
} from '../lib/revenueReport.js';
import { reportTimeZone, salesReportPdf } from '../lib/salesReportPdf.js';
import { dataGaps, enquiryReport, exchangeRates, quotationStatusReport, serviceReport } from '../lib/salesReviewData.js';
import { businessYear } from '../lib/businessDate.js';
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
};

/** Days in a month, leap years included (Date.UTC would misread years below 100). */
function daysInMonth(year, month) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * The whole sales report as one PDF: ?from=&to= for the sales sections, and
 * ?year=&month= (01–12, optional) for the revenue section, exactly as on screen.
 */
exportRouter.get('/sales-report.pdf', async (req, res) => {
  const period = reportPeriod(req.query);
  const rawYear = String(req.query.year ?? '').trim();
  // Postgres has no year 0, so 0000 would fail as a date deep inside a query.
  if (rawYear && !(/^\d{4}$/.test(rawYear) && Number(rawYear) >= 1)) {
    throw new ApiError(422, 'Use a four-digit year from 0001');
  }
  const year = rawYear || String(businessYear());
  const month = String(req.query.month ?? '').trim() || null;
  if (month && !/^(0[1-9]|1[0-2])$/.test(month)) throw new ApiError(422, 'Use a month from 01 to 12');
  const revenuePeriod = month
    ? { from: `${year}-${month}-01`, to: `${year}-${month}-${String(daysInMonth(Number(year), Number(month))).padStart(2, '0')}` }
    : { from: `${year}-01-01`, to: `${year}-12-31` };

  const [sectors, customers, fx, revenue, enquiries, quotationStatus, services, gaps, rates] = await Promise.all([
    sectorReport(period),
    customerReport(period),
    fxReport(period),
    revenueReport(revenuePeriod),
    enquiryReport(period),
    quotationStatusReport(period),
    serviceReport(period),
    dataGaps(period),
    exchangeRates(),
  ]);
  const pdf = await salesReportPdf({
    period, year: Number(year), month, sectors, customers, fx, revenue, enquiries, quotationStatus, services, gaps, rates,
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

/**
 * Any list can still leave as a spreadsheet — the point is that the
 * spreadsheet is now an export, not the system of record.
 */
exportRouter.get('/:resource.csv', async (req, res) => {
  const def = resources[req.params.resource];
  if (!def) throw new ApiError(404, 'Unknown export');

  const { rows } = await query(
    `SELECT * FROM "${def.view || def.table}" ORDER BY ${def.defaultSort}`
  );
  // Documents are opened from the app's tables; the spreadsheet leaves them out.
  for (const row of rows) {
    delete row.document_id;
    delete row.document_name;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  sendCsv(res, `cetizion-${req.params.resource}-${stamp}`, rows);
});
