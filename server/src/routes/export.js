import { Router } from 'express';
import { query } from '../db.js';
import { resources } from '../lib/resources.js';
import {
  customerCsvRows, customerReport, reportPeriod, sectorCsvRows, sectorReport,
} from '../lib/salesReport.js';
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
};

/** The sales reports, for the same ?from=&to= range the report page shows. */
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

  const stamp = new Date().toISOString().slice(0, 10);
  sendCsv(res, `cetizion-${req.params.resource}-${stamp}`, rows);
});
