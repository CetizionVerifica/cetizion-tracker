import { Router } from 'express';
import { config } from '../config.js';
import { requireAdmin } from '../auth/middleware.js';
import { ownerClause, purchaseOrderClause, scopeOf } from '../auth/ownership.js';
import { query } from '../db.js';
import { STATUS } from '../lib/resources.js';
import { nameKey } from '../lib/salesReport.js';
import { isSequence, nextId, yearFor } from '../lib/sequences.js';

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
  // Dropdowns are a read of the sales tables wearing a different hat. A
  // project id, a quotation number and a client name are exactly the
  // identifiers Phase 2C restricts, so the lists built from scoped tables
  // carry the same predicate; the master lists below (services, vendors,
  // expense categories, travel, companies, settings) are not derived from
  // anybody's records and are unchanged.
  const scope = scopeOf(req);

  /**
   * A builder bound to ONE statement's parameter list. Several of the
   * queries below restrict two tables at once (the salesperson and sector
   * lists union quotations with enquiries), and each restriction has to take
   * the next placeholder in that statement — two builders with separate
   * arrays would both emit $1 and the statement would not run.
   */
  const statement = () => {
    const params = [];
    const clause = (build, alias) => build(scope, params, { alias });
    return {
      params,
      owner: (alias) => clause(ownerClause, alias),
      po: (alias) => clause(purchaseOrderClause, alias),
    };
  };
  const only = (c) => (c ? `WHERE ${c}` : '');
  const also = (c) => (c ? `AND ${c}` : '');

  const pj = statement(); const pjWhere = only(pj.owner('p'));
  const poS = statement(); const poWhere = only(poS.po('po'));
  const qt = statement(); const qtWhere = only(qt.owner('q'));
  const ppl = statement(); const pplQ = also(ppl.owner('q')); const pplE = also(ppl.owner('e'));
  const sec = statement(); const secQ = only(sec.owner('q')); const secE = only(sec.owner('e'));
  const cur = statement(); const curQ = only(cur.owner('q')); const curPo = only(cur.po('po'));

  const [services, vendors, categories, projects, pos, trips, people, clients, sectors, settings, quotations,
         currenciesInUse, stages, lostReasons, leadSources, ptt, pttLines, obt] =
    await Promise.all([
      query('SELECT id, name, code, default_rate, currency, gst_rate, unit, sac_code, renewal_interval_months FROM services WHERE active ORDER BY sort_order, name'),
      query('SELECT name FROM travel_vendors WHERE active ORDER BY name'),
      query('SELECT name FROM expense_categories WHERE active ORDER BY name'),
      query(`SELECT p.project_id, p.client_name FROM projects p ${pjWhere}
              ORDER BY p.project_id DESC`, pj.params),
      // replaced_by_po_number so the form can show a PO that was superseded (#26).
      query(`SELECT po.po_number, po.project_id, po.client_name, po.po_value, po.currency, po.replaced_by_po_number
               FROM v_purchase_orders po ${poWhere} ORDER BY po.po_number DESC`, poS.params),
      query('SELECT travel_id, employee_name, destination FROM travel_logs ORDER BY travel_id DESC'),
      // Enquiries come first in the pipeline, so their names are offered too.
      query(`SELECT q.sales_person AS name FROM quotations q
              WHERE q.sales_person IS NOT NULL ${pplQ}
             UNION
             SELECT e.sales_person FROM enquiries e
              WHERE e.sales_person IS NOT NULL ${pplE}
             ORDER BY 1`, ppl.params),
      // One spelling per client: the companies table (#20).
      query('SELECT id, name, sector FROM companies ORDER BY name'),
      // One suggestion per sector as the reports group them, in its most
      // used spelling, so the list nudges people towards that spelling.
      query(`SELECT mode() WITHIN GROUP (ORDER BY btrim(sector)) AS name
               FROM (SELECT q.sector FROM quotations q ${secQ}
                     UNION ALL
                     SELECT e.sector FROM enquiries e ${secE}) s
              WHERE btrim(sector) <> ''
              GROUP BY ${nameKey('sector')}
              ORDER BY 1`, sec.params),
      query('SELECT key, value, notes FROM settings ORDER BY key'),
      // For linking an enquiry to an existing quotation, and a PO to its won
      // one — currency so the PO form can default to it and flag a mismatch.
      query(`SELECT q.quotation_no, q.client_name, q.status, q.project_id, q.currency
               FROM quotations q ${qtWhere}
              ORDER BY q.quotation_date DESC NULLS LAST, q.quotation_no DESC`, qt.params),
      // Currencies actually recorded against something, so Settings can ask
      // for the rates that are really needed instead of every currency the
      // dropdown offers.
      query(`SELECT DISTINCT currency FROM (
               SELECT q.currency FROM quotations q ${curQ}
               UNION ALL
               SELECT po.currency FROM purchase_orders po ${curPo}
             ) c
              WHERE currency IS NOT NULL AND currency <> 'INR'
              ORDER BY 1`, cur.params),
      // Master lists below: pipeline stages, lost reasons, lead sources and
      // the payment-terms / onboarding templates are configuration, not
      // anybody's records, so ownership does not narrow them.
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
 *
 * `?on=YYYY-MM-DD` asks for the number the record's own date would take,
 * rather than today's. It matters for the invoice series, which counts by
 * financial year: an invoice dated 28 March belongs to the year that is
 * ending, so a preview taken on 2 April would otherwise show a number the
 * save will not use. Without it, today's year is assumed, which is right
 * for every other series and for most of the year in this one.
 */
lookupRouter.get('/next-id/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!isSequence(kind)) {
    return res.status(404).json({ error: { message: 'Unknown id series' } });
  }
  const on = req.query.on ? String(req.query.on) : null;
  if (on && !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return res.status(422).json({ error: { message: 'Use YYYY-MM-DD for `on`', fields: { on: 'A date, as YYYY-MM-DD' } } });
  }
  res.json({ data: { next: await nextId(kind, undefined, yearFor(kind, on)) } });
});
