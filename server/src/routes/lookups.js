import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { STATUS } from '../lib/resources.js';
import { nameKey } from '../lib/salesReport.js';
import { isSequence, nextId } from '../lib/sequences.js';

export const lookupRouter = Router();

// Offered before any quotation carries a sector. Whatever is typed on a
// quotation joins the list, so this is a starting point, not a limit.
const SECTOR_SUGGESTIONS = ['Agriculture', 'Metal Industry', 'Pharmaceutical', 'Other'];

/** Sectors in use, plus the starting suggestions not already among them. */
function sectorOptions(used) {
  const seen = new Set(used.map((name) => name.toLowerCase()));
  return [...used, ...SECTOR_SUGGESTIONS.filter((name) => !seen.has(name.toLowerCase()))]
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Everything the forms need to offer a dropdown instead of a free-text
 * box — one request, cached by the client for the session.
 */
lookupRouter.get('/', async (req, res) => {
  const [services, vendors, categories, projects, pos, trips, people, clients, sectors, settings, quotations] =
    await Promise.all([
      query('SELECT name FROM services WHERE active ORDER BY sort_order, name'),
      query('SELECT name FROM travel_vendors WHERE active ORDER BY name'),
      query('SELECT name FROM expense_categories WHERE active ORDER BY name'),
      query('SELECT project_id, client_name FROM projects ORDER BY project_id DESC'),
      query(`SELECT po_number, project_id, client_name, po_value, currency
               FROM v_purchase_orders ORDER BY po_number DESC`),
      query('SELECT travel_id, employee_name, destination FROM travel_logs ORDER BY travel_id DESC'),
      // Enquiries come first in the pipeline, so their names are offered too.
      query(`SELECT sales_person AS name FROM quotations WHERE sales_person IS NOT NULL
             UNION
             SELECT sales_person FROM enquiries WHERE sales_person IS NOT NULL
             ORDER BY 1`),
      query(`SELECT client_name AS name FROM quotations
             UNION
             SELECT client_name FROM enquiries
             ORDER BY 1`),
      // One suggestion per sector as the reports group them, in its most
      // used spelling, so the list nudges people towards that spelling.
      query(`SELECT mode() WITHIN GROUP (ORDER BY btrim(sector)) AS name
               FROM (SELECT sector FROM quotations
                     UNION ALL
                     SELECT sector FROM enquiries) s
              WHERE btrim(sector) <> ''
              GROUP BY ${nameKey('sector')}
              ORDER BY 1`),
      query('SELECT key, value, notes FROM settings ORDER BY key'),
      // For linking an enquiry to an existing quotation, and a PO to its won one.
      query(`SELECT quotation_no, client_name, status, project_id
               FROM quotations ORDER BY quotation_date DESC NULLS LAST, quotation_no DESC`),
    ]);

  res.json({
    data: {
      services: services.rows.map((r) => r.name),
      travel_vendors: vendors.rows.map((r) => r.name),
      expense_categories: categories.rows.map((r) => r.name),
      projects: projects.rows,
      purchase_orders: pos.rows,
      trips: trips.rows,
      sales_people: people.rows.map((r) => r.name),
      clients: clients.rows.map((r) => r.name),
      sectors: sectorOptions(sectors.rows.map((r) => r.name)),
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      quotations: quotations.rows,
      won_quotations: quotations.rows.filter((q) => q.status === 'Won - PO Received' && q.project_id),
      enums: STATUS,
      limits: { document_max_bytes: config.documentMaxBytes },
    },
  });
});

/**
 * Settings are keyed by name rather than a serial id, so they get their
 * own tiny router instead of going through the generic CRUD factory.
 */
export const settingsRouter = Router();

settingsRouter.get('/', async (req, res) => {
  const { rows } = await query('SELECT key, value, notes, updated_at FROM settings ORDER BY key');
  res.json({ data: rows });
});

settingsRouter.patch('/:key', async (req, res) => {
  const value = req.body?.value;
  const isRate = req.params.key.startsWith('fx_rate_');
  // A blank rate is how the report knows a currency is not set, so a rate
  // can be cleared; every other setting needs a value.
  if (typeof value !== 'string' || (value.trim() === '' && !isRate)) {
    return res.status(422).json({
      error: { message: 'Enter a value', fields: { value: 'Required' } },
    });
  }
  // A rate the report cannot multiply by would silently drop deals from the INR totals.
  if (isRate && value.trim() !== '' && !(/^\d+(\.\d+)?$/.test(value.trim()) && Number(value) > 0)) {
    return res.status(422).json({
      error: { message: 'Enter the INR value of 1 unit, e.g. 90.25', fields: { value: 'Enter a number above 0' } },
    });
  }
  const { rows } = await query(
    'UPDATE settings SET value = $1 WHERE key = $2 RETURNING key, value, notes',
    [value.trim(), req.params.key]
  );
  if (!rows.length) return res.status(404).json({ error: { message: 'Unknown setting' } });
  res.json({ data: rows[0] });
});

/**
 * Suggest the next reference in a series (CTZ/QT/2026/063, PRJ-2026-008).
 * Only a suggestion — the field stays editable, and uniqueness is still
 * enforced by the database.
 */
lookupRouter.get('/next-id/:kind', async (req, res) => {
  if (!isSequence(req.params.kind)) {
    return res.status(404).json({ error: { message: 'Unknown id series' } });
  }
  res.json({ data: { next: await nextId(req.params.kind) } });
});
