import { Router } from 'express';
import { config } from '../config.js';
import { requireAdmin } from '../auth/middleware.js';
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
  const [services, vendors, categories, projects, pos, trips, people, clients, sectors, settings, quotations,
         currenciesInUse, stages, lostReasons, leadSources, ptt, pttLines, obt] =
    await Promise.all([
      query('SELECT id, name, code, default_rate, currency, gst_rate, unit, sac_code, renewal_interval_months FROM services WHERE active ORDER BY sort_order, name'),
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
      // One spelling per client: the companies table (#20).
      query('SELECT id, name, sector FROM companies ORDER BY name'),
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
      // Currencies actually recorded against something, so Settings can ask
      // for the rates that are really needed instead of every currency the
      // dropdown offers.
      query(`SELECT DISTINCT currency FROM (
               SELECT currency FROM quotations
               UNION ALL
               SELECT currency FROM purchase_orders
             ) c
              WHERE currency IS NOT NULL AND currency <> 'INR'
              ORDER BY 1`),
      query('SELECT id, name, probability, type, maps_to_status, color FROM pipeline_stages WHERE active ORDER BY sort_order'),
      query('SELECT id, name FROM lost_reasons WHERE active ORDER BY sort_order, name'),
      query('SELECT id, name FROM lead_sources WHERE active ORDER BY sort_order, name'),
      query('SELECT id, name, is_default FROM payment_terms_templates WHERE active ORDER BY sort_order, name'),
      query('SELECT template_id, stage_name, percent, trigger_event, credit_days, milestone_name FROM payment_terms_template_lines ORDER BY template_id, sort_order, id'),
      query('SELECT id, name, is_default FROM onboarding_templates WHERE active ORDER BY sort_order, name'),
    ]);

  res.json({
    data: {
      services: services.rows.map((r) => r.name),
      catalogue: services.rows,
      travel_vendors: vendors.rows.map((r) => r.name),
      expense_categories: categories.rows.map((r) => r.name),
      projects: projects.rows,
      purchase_orders: pos.rows,
      trips: trips.rows,
      sales_people: people.rows.map((r) => r.name),
      staff: (await query('SELECT id, name, role FROM staff WHERE active ORDER BY name')).rows,
      clients: clients.rows.map((r) => r.name),
      companies: clients.rows,
      sectors: sectorOptions(sectors.rows.map((r) => r.name)),
      settings: Object.fromEntries(settings.rows.map((r) => [r.key, r.value])),
      quotations: quotations.rows,
      won_quotations: quotations.rows.filter((q) => q.status === 'Won - PO Received' && q.project_id),
      // Won, but not registered as a project yet — what the Projects form can
      // still claim. won_quotations is the opposite set: already registered,
      // for linking a PO to its project's order.
      unregistered_quotations: quotations.rows.filter((q) => q.status === 'Won - PO Received' && !q.project_id),
      pipeline_stages: stages.rows,
      lost_reasons: lostReasons.rows,
      lead_sources: leadSources.rows,
      payment_terms_templates: ptt.rows.map((t) => ({ ...t, lines: pttLines.rows.filter((l) => l.template_id === t.id) })),
      onboarding_templates: obt.rows,
      enums: STATUS,
      currencies_in_use: currenciesInUse.rows.map((r) => r.currency),
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

// Changing a setting changes what the whole tracker computes — an FX rate
// re-values every historical deal in every report — so it is an admin act.
// Reading them stays open: the lists and rates drive forms sales users need.
settingsRouter.patch('/:key', requireAdmin, async (req, res) => {
  const value = req.body?.value;
  // Rates moved to Settings -> Exchange rates, where each one carries the date
  // it took effect. The old single-value settings are kept for reference only:
  // editing one here would change nothing and mislead about which rate applied.
  if (req.params.key.startsWith('fx_rate_')) {
    return res.status(422).json({
      error: { message: 'Exchange rates are now set under Settings → Exchange rates, with the date each rate took effect.' },
    });
  }
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
