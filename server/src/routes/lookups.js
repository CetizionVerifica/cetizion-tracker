import { Router } from 'express';
import { query } from '../db.js';
import { STATUS } from '../lib/resources.js';

export const lookupRouter = Router();

/**
 * Everything the forms need to offer a dropdown instead of a free-text
 * box — one request, cached by the client for the session.
 */
lookupRouter.get('/', async (req, res) => {
  const [services, vendors, categories, projects, pos, trips, people, clients, settings] =
    await Promise.all([
      query('SELECT name FROM services WHERE active ORDER BY sort_order, name'),
      query('SELECT name FROM travel_vendors WHERE active ORDER BY name'),
      query('SELECT name FROM expense_categories WHERE active ORDER BY name'),
      query('SELECT project_id, client_name FROM projects ORDER BY project_id DESC'),
      query(`SELECT po_number, project_id, client_name, po_value, currency
               FROM v_purchase_orders ORDER BY po_number DESC`),
      query('SELECT travel_id, employee_name, destination FROM travel_logs ORDER BY travel_id DESC'),
      query(`SELECT DISTINCT sales_person AS name FROM quotations
              WHERE sales_person IS NOT NULL ORDER BY 1`),
      query(`SELECT DISTINCT client_name AS name FROM quotations
              WHERE client_name IS NOT NULL ORDER BY 1`),
      query('SELECT key, value, notes FROM settings ORDER BY key'),
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
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      enums: STATUS,
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
  if (typeof value !== 'string' || value.trim() === '') {
    return res.status(422).json({
      error: { message: 'Enter a value', fields: { value: 'Required' } },
    });
  }
  const { rows } = await query(
    'UPDATE settings SET value = $1 WHERE key = $2 RETURNING key, value, notes',
    [value.trim(), req.params.key]
  );
  if (!rows.length) return res.status(404).json({ error: { message: 'Unknown setting' } });
  res.json({ data: rows[0] });
});

const SEQUENCES = {
  quotation: { table: 'quotations', column: 'quotation_no', pattern: 'CTZ/QT/{year}/{n:3}' },
  project: { table: 'projects', column: 'project_id', pattern: 'PRJ-{year}-{n:3}' },
  travel: { table: 'travel_logs', column: 'travel_id', pattern: 'TRV-{year}-{n:3}' },
  claim: { table: 'employee_expense_claims', column: 'claim_id', pattern: 'CLM-{year}-{n:3}' },
  vendor_invoice: {
    table: 'travel_vendor_invoices',
    column: 'vendor_invoice_id',
    pattern: 'VINV-{year}-{n:3}',
  },
};

/**
 * Suggest the next reference in a series (CTZ/QT/2026/063, PRJ-2026-008).
 * Only a suggestion — the field stays editable, and uniqueness is still
 * enforced by the database.
 */
lookupRouter.get('/next-id/:kind', async (req, res) => {
  const spec = SEQUENCES[req.params.kind];
  if (!spec) return res.status(404).json({ error: { message: 'Unknown id series' } });

  const year = String(new Date().getFullYear());
  const prefix = spec.pattern.replace('{year}', year).replace(/\{n:\d+\}$/, '');
  const width = Number(/\{n:(\d+)\}/.exec(spec.pattern)?.[1] || 3);

  const { rows } = await query(
    `SELECT ${spec.column} AS value FROM ${spec.table} WHERE ${spec.column} LIKE $1`,
    [`${prefix}%`]
  );

  const highest = rows.reduce((max, r) => {
    const tail = String(r.value).slice(prefix.length);
    const n = /^\d+$/.test(tail) ? Number(tail) : 0;
    return Math.max(max, n);
  }, 0);

  res.json({ data: { next: `${prefix}${String(highest + 1).padStart(width, '0')}` } });
});
