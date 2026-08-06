import { Router } from 'express';
import { query } from '../db.js';
import { resources } from '../lib/resources.js';
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
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="cetizion-${req.params.resource}-${stamp}.csv"`
  );
  res.send(toCsv(rows));
});
