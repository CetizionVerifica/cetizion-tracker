import { ownerClause } from '../auth/ownership.js';
import { ApiError } from '../middleware/error.js';
import { lockAttachableDocument } from './documents.js';
import { notify } from './notify.js';
import { claimNextId, yearFor } from './sequences.js';
import { STATUS } from './statuses.js';

const WON = 'Won - PO Received';

/**
 * The warning for a PO whose currency differs from the quotation it fulfils,
 * or null when they agree. Only the currency is compared, never the amount:
 * a quotation billed 50/50 or 30/70 has POs worth part of it, and that is
 * normal. A different currency is allowed — a client can order in another
 * one — but it is usually the currency dropdown left at its INR default, and
 * then every report reads the amount as rupees.
 */
export function currencyMismatch(poCurrency, quotation) {
  if (!quotation?.currency || !poCurrency || poCurrency === quotation.currency) return null;
  return `Quotation ${quotation.quotation_no} is in ${quotation.currency}, but this PO is in ${poCurrency}. ` +
    'Check the currency: the reports convert the PO value from the currency saved here.';
}

const replacesError = (message) =>
  new ApiError(422, 'Please check the highlighted fields', { fields: { replaces_po_number: message } });

/**
 * A revision names the PO it takes the place of. That PO must be another one
 * on the same project, not already replaced by a different revision, and not
 * one that — following its own "replaces" back — leads to this PO again,
 * which would leave neither counted. Only a new or changed link is checked,
 * like the quotation link below.
 */
async function checkReplaces(client, { before, after }) {
  const target = after.replaces_po_number;
  if (!target || (before && before.replaces_po_number === target && before.project_id === after.project_id)) return;
  if (target === after.po_number) throw replacesError('A purchase order cannot replace itself');

  const { rows: [replaced] } = await client.query(
    'SELECT po_number, project_id FROM purchase_orders WHERE po_number = $1',
    [target]
  );
  if (!replaced) throw replacesError(`There is no purchase order ${target}`);
  if (replaced.project_id !== after.project_id) {
    throw replacesError(`${target} is on project ${replaced.project_id}: pick a purchase order of project ${after.project_id}`);
  }
  const { rows: [other] } = await client.query(
    'SELECT po_number FROM purchase_orders WHERE replaces_po_number = $1 AND po_number <> $2',
    [target, after.po_number]
  );
  if (other) throw replacesError(`${target} is already replaced by ${other.po_number}: pick ${other.po_number} instead`);

  // Walk back from the target; reaching this PO means a loop.
  let current = target;
  for (let hops = 0; current && hops < 100; hops += 1) {
    const { rows: [row] } = await client.query('SELECT replaces_po_number FROM purchase_orders WHERE po_number = $1', [current]);
    current = row?.replaces_po_number;
    if (current === after.po_number) throw replacesError(`${target} already leads back to this purchase order`);
  }
}

/**
 * A purchase order counts, in revenue, towards the won quotation it names.
 * That quotation must be a won one on the PO's own project. A new PO saved
 * without one is linked automatically when its project has exactly one won
 * quotation; otherwise it stays unlinked until someone picks the quotation,
 * and the revenue report flags it.
 *
 * Returns { save_warning } when the PO's currency differs from its
 * quotation's. The save still goes through; the form shows the warning.
 */
export async function linkPurchaseOrder(client, { before, after }) {
  await checkReplaces(client, { before, after });

  let quotationNo = after.quotation_no;
  if (quotationNo) {
    // Forms send every field back, so an unchanged link arrives on every
    // edit. Its quotation may since have moved project or stopped being won;
    // that must not block saving a delivery date. Only a new or re-pointed
    // link is checked.
    const unchanged = before && before.quotation_no === after.quotation_no && before.project_id === after.project_id;
    if (!unchanged) {
      const { rows } = await client.query(
        'SELECT project_id, status FROM quotations WHERE quotation_no = $1',
        [after.quotation_no]
      );
      if (!rows.length || rows[0].project_id !== after.project_id || rows[0].status !== WON) {
        throw new ApiError(422, 'Please check the highlighted fields', {
          fields: { quotation_no: `Pick a won quotation of project ${after.project_id}` },
        });
      }
    }
  } else if (!before) {
    // Only a new PO is linked for you; clearing the link on an existing one is left alone.
    const { rows } = await client.query(
      'SELECT quotation_no FROM quotations WHERE project_id = $1 AND status = $2',
      [after.project_id, WON]
    );
    if (rows.length === 1) {
      quotationNo = rows[0].quotation_no;
      await client.query('UPDATE purchase_orders SET quotation_no = $1 WHERE id = $2', [quotationNo, after.id]);
    }
  }

  // Checked on every save, not only when the link changes: the currency is
  // the field most likely to be edited on its own.
  if (!quotationNo) return undefined;
  const { rows: [quotation] } = await client.query(
    'SELECT quotation_no, currency FROM quotations WHERE quotation_no = $1',
    [quotationNo]
  );
  const warning = currencyMismatch(after.currency, quotation);
  return warning ? { save_warning: warning } : undefined;
}

const fieldError = (field, message) => new ApiError(422, 'Please check the highlighted fields', { fields: { [field]: message } });

/** A PO number as compared: lowercase letters and digits only. */
export const normalisePoNumber = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** SQL for the same comparison on a column, matching purchase_orders_po_number_norm_idx. */
const NORMALISED_PO = `lower(regexp_replace(po_number, '[^a-zA-Z0-9]', '', 'g'))`;

/**
 * A date as a moment: noon in India, so the day reads the same in any
 * report that takes the date back out of it.
 */
const istNoon = (isoDate) => (isoDate ? `${isoDate}T12:00:00+05:30` : null);

/**
 * PO received → project, in one step (#26). The body of
 * POST /api/quotations/:key/register, shared with the email reader
 * (docs/email-po-plan.md §3.5) so both register a PO the same way.
 *
 * Runs inside the caller's transaction. In one go: the quotation is marked
 * won and linked, its enquiry converted, the project created or reused, the
 * PO registered against the quotation, its service lines taken from the
 * quotation's lines (or its subject), the payment stages built from the
 * stages given or the template, and the onboarding checklist added.
 *
 * input: the route's fields (see register.js), plus
 *   quotation   the quotation's number, or its id
 *   stages      explicit stages instead of a template:
 *               [{ stage_name, trigger_event, percent, credit_days?, milestone_name? }], adding up to 100
 *   remarks     the PO's remarks; omitted, "Registered from quotation …"
 * options:
 *   scope       the caller's reach (scopeOf); omitted, every quotation
 *   mode        'live', or 'history' for a PO read from past mail: no
 *               notifications, no onboarding checklist, no webhooks (§3.8)
 *
 * Refuses (ApiError) a quotation that already has a PO, a PO number already
 * registered in any spelling, and a currency the tracker does not know.
 */
export async function registerPurchaseOrder(client, b, { scope = { unrestricted: true }, mode = 'live' } = {}) {
  if (mode === 'history') {
    // For this transaction only: webhook_emit() stays quiet (067).
    await client.query(`SELECT set_config('app.suppress_webhooks', 'on', true)`);
  }

  const key = String(b.quotation);
  // Registering a PO marks the quotation won, creates or joins a project
  // and builds the invoicing schedule, so it has to be a quotation this
  // caller may reach (#18 Phase 2C). Scoped in the locking read, so the
  // whole transaction works from a row they own. The key predicate is
  // parenthesised first: an AND against the tail of that OR would have
  // left the by-number path open.
  const qParams = [key];
  const qMine = ownerClause(scope, qParams, { alias: 'q' });
  const { rows: qrows } = await client.query(
    `SELECT q.*, (SELECT type FROM pipeline_stages WHERE id = q.stage_id) AS stage_type FROM quotations q
      WHERE (q.quotation_no = $1 OR (q.id::text = $1 AND NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_no = $1)))
        ${qMine ? `AND ${qMine}` : ''} FOR UPDATE`, qParams);
  if (!qrows.length) throw new ApiError(404, 'Quotation not found');
  const q = qrows[0];

  // One PO per quotation through here. Another PO on the same won work —
  // a revision, a second order — goes on the project, where it can say
  // what it replaces. The form only hid the button; the email reader has
  // no form.
  const { rows: [held] } = await client.query('SELECT po_number FROM purchase_orders WHERE quotation_no = $1 LIMIT 1', [q.quotation_no]);
  if (held) throw new ApiError(409, `Quotation ${q.quotation_no} already has PO ${held.po_number}. Add another PO from its project.`);

  // "PO-123" and "po 123" are one PO, however it was typed or printed.
  const { rows: [same] } = await client.query(
    `SELECT po_number FROM purchase_orders WHERE ${NORMALISED_PO} = $1 LIMIT 1`, [normalisePoNumber(b.po_number)]);
  if (same) {
    throw fieldError('po_number', same.po_number === b.po_number
      ? `PO ${b.po_number} is already registered`
      : `PO ${b.po_number} is already registered as ${same.po_number}`);
  }

  const currency = b.currency || q.currency || 'INR';
  if (!STATUS.currency.includes(currency)) throw fieldError('currency', `Use one of ${STATUS.currency.join(', ')}`);

  if (b.stages) {
    const total = b.stages.reduce((n, s) => n + Number(s.percent), 0);
    if (!b.stages.length || Math.abs(total - 100) > 0.01) throw fieldError('stages', `The stages add up to ${total}%, not 100%`);
  }

  // ---- project: reuse, or the quotation's own, or a new one
  let projectId = b.project_id || q.project_id || null;
  let projectCreated = false;
  if (projectId) {
    // Joining an existing project needs the same reach as opening it, or a
    // sales user could hang their PO off somebody else's project — and
    // learn from the refusals below whose client it is. The same check
    // /api/quotations/:id/convert already makes.
    const pParams = [projectId];
    const pMine = ownerClause(scope, pParams, { alias: 'p' });
    const { rows } = await client.query(
      `SELECT p.project_id, p.company_id FROM projects p WHERE p.project_id = $1 ${pMine ? `AND ${pMine}` : ''}`, pParams);
    if (!rows.length) throw fieldError('project_id', 'No such project');
    if (rows[0].company_id && q.company_id && rows[0].company_id !== q.company_id) {
      throw fieldError('project_id', 'That project belongs to a different client');
    }
  } else {
    // Numbered by the year of the PO, not of the day it was typed: a PO
    // from last December read in January is last year's project.
    projectId = await claimNextId('project', client, yearFor('project', b.po_date));
    await client.query(
      // Responsibility carries from the quotation to the project it
      // becomes, exactly as /api/quotations/:id/convert does it (#18
      // Phase 2C/4): taken from the quotation, never from whoever
      // happened to click Register, and an unowned quotation makes an
      // unowned project rather than a guessed one. Without this the
      // project came out unowned and the salesperson who registered their
      // own PO could not see the project it created.
      `INSERT INTO projects (project_id, client_name, primary_service, project_manager, project_manager_email, sales_person,
                             planned_start_date, planned_delivery_date, remarks, owner_user_id,
                             originating_user_id, originating_user_snapshot_id, originating_user_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [projectId, q.client_name, q.service_quoted, b.project_manager ?? null, b.project_manager_email ?? null, q.sales_person,
       b.planned_start_date ?? null, b.planned_delivery_date ?? null, `Won from quotation ${q.quotation_no}`,
       q.owner_user_id ?? null,
       q.originating_user_id ?? null,
       q.originating_user_id ? (q.originating_user_snapshot_id ?? q.originating_user_id) : null,
       q.originating_user_id ? (q.originating_user_name ?? null) : null]
    );
    projectCreated = true;
  }

  // ---- the quotation is won, on the day the PO is dated
  // The stage trigger only fills closed_at when it is blank, and a
  // quotation lost before keeps the day it was lost; so it is set here. A
  // quotation already won keeps the day it was won. Without a PO date the
  // trigger's "now" stands.
  await client.query(
    `UPDATE quotations SET project_id = $1, po_received = true, status = $3,
            closed_at = CASE WHEN $5 = 'won' AND closed_at IS NOT NULL THEN closed_at ELSE $4::timestamptz END
      WHERE id = $2`,
    [projectId, q.id, WON, istNoon(b.po_date), q.stage_type]);

  // ---- its enquiry is converted: the reports count "converted to PO" from it
  await client.query(
    `UPDATE enquiries SET status = 'Converted', converted_at = COALESCE(converted_at, $2::timestamptz)
      WHERE quotation_no = $1 AND status <> 'Converted'`,
    [q.quotation_no, istNoon(b.po_date)]);

  // ---- the PO, named after its quotation
  if (b.document_id !== undefined && b.document_id !== null && !(await lockAttachableDocument(client, b.document_id))) {
    throw fieldError('document_id', 'That upload has expired or is already in use — choose the file again');
  }
  const poValue = b.po_value ?? q.total ?? q.quotation_value ?? 0;
  const terms = b.payment_terms_days ?? 30;
  const { rows: [po] } = await client.query(
    `INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency, payment_terms_days, document_id, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [b.po_number, projectId, q.quotation_no, b.po_date ?? null, poValue, currency, terms, b.document_id ?? null,
     b.remarks ?? `Registered from quotation ${q.quotation_no}`]
  );

  // ---- service lines: the quotation's lines, else its subject at the PO value
  const { rows: lines } = await client.query('SELECT description, amount, gst_rate FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
  if (lines.length) {
    // A PO value includes GST; a quotation line does not. Comparing the two
    // directly left every set of service lines short by exactly the tax, so
    // each line is grossed up by its own rate first and then scaled by what
    // the PO is worth against the quotation. A PO for the full quoted total
    // keeps each line's own value, and a negotiated PO scales them down.
    const gross = lines.map((l) => Number(l.amount) * (1 + Number(l.gst_rate || 0) / 100));
    const grossSum = gross.reduce((n, v) => n + v, 0);
    const factor = grossSum > 0 ? Number(poValue) / grossSum : 1;
    const values = gross.map((v) => Math.round(v * factor * 100) / 100);
    // Rounding leaves a paisa or two; it belongs on the last line, so the
    // service lines add up to the PO exactly, as the form promises.
    const residual = Math.round((Number(poValue) - values.reduce((n, v) => n + v, 0)) * 100) / 100;
    values[values.length - 1] = Math.round((values[values.length - 1] + residual) * 100) / 100;
    for (const [i, l] of lines.entries()) {
      await client.query('INSERT INTO po_services (po_number, service, service_value) VALUES ($1,$2,$3)', [po.po_number, l.description, values[i]]);
    }
  } else {
    await client.query('INSERT INTO po_services (po_number, service, service_value) VALUES ($1,$2,$3)', [po.po_number, q.service_quoted || 'Services as quoted', poValue]);
  }

  // ---- payment stages: the ones given, else the template
  let template = null;
  // 0 is the caller saying "no stages now", which is not the same as not
  // saying anything: blank still falls through to the default template.
  const noSchedule = Number(b.payment_terms_template_id) === 0;
  if (b.stages || noSchedule) {
    template = null;
  } else if (b.payment_terms_template_id) {
    ({ rows: [template] } = await client.query('SELECT * FROM payment_terms_templates WHERE id = $1 AND active', [b.payment_terms_template_id]));
    if (!template) throw fieldError('payment_terms_template_id', 'No such template');
  } else {
    ({ rows: [template] } = await client.query(
      `SELECT t.* FROM payment_terms_templates t
        WHERE t.active AND (t.id = (SELECT payment_terms_template_id FROM services WHERE name = $1) OR t.is_default)
        ORDER BY (t.id = (SELECT payment_terms_template_id FROM services WHERE name = $1)) DESC, t.is_default DESC LIMIT 1`, [q.service_quoted]));
  }
  let schedule = b.stages || [];
  if (template) {
    const { rows: tl } = await client.query('SELECT * FROM payment_terms_template_lines WHERE template_id = $1 ORDER BY sort_order, id', [template.id]);
    const total = tl.reduce((n, l) => n + Number(l.percent), 0);
    if (Math.abs(total - 100) > 0.01) throw new ApiError(422, `Template "${template.name}" adds up to ${total}%, not 100%`);
    schedule = tl;
  }
  const stages = [];
  // A stage triggered On Milestone points at the project's milestone of that
  // name (#26), made here if the project does not have it yet.
  const milestoneFor = async (name) => {
    if (!name || !String(name).trim()) return null;
    const { rows: [m] } = await client.query(
      `INSERT INTO project_milestones (project_id, name) VALUES ($1, btrim($2))
       ON CONFLICT (project_id, lower(name)) DO UPDATE SET name = project_milestones.name
       RETURNING id, reached_on`, [projectId, name]);
    return m;
  };
  for (const [i, l] of schedule.entries()) {
    const milestone = l.trigger_event === 'On Milestone' ? await milestoneFor(l.milestone_name) : null;
    const { rows: [s] } = await client.query(
      `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, credit_days, milestone_name, milestone_id, milestone_reached_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, stage_no, stage_name, stage_percent`,
      [po.po_number, i + 1, l.stage_name, l.trigger_event, Number(l.percent) / 100, l.credit_days ?? null, l.milestone_name ?? null,
       milestone?.id ?? null, milestone?.reached_on ?? null]);
    stages.push(s);
  }

  // The PO against what was quoted (#26): the dialog warns before, this says after.
  const quoted = q.total ?? q.quotation_value;
  const poDiffers = quoted != null && Math.abs(Number(poValue) - Number(quoted)) > 0.005;

  // The deal's owner and the project manager hear of it (#26): by email
  // when it is known (the sign-in the bell matches), else by name. A PO
  // from months ago is not news to them.
  if (mode === 'live') {
    const { rows: [pr] } = await client.query('SELECT project_manager, project_manager_email, sales_person FROM projects WHERE project_id = $1', [projectId]);
    const people = [
      pr?.project_manager_email || pr?.project_manager,
      q.sales_person_email || pr?.sales_person || q.sales_person,
    ].map((p) => (p ? String(p).trim() : '')).filter(Boolean);
    for (const who of [...new Set(people.map((p) => p.toLowerCase()))]) {
      await notify({
        username: people.find((p) => p.toLowerCase() === who), kind: 'po_registered',
        title: `PO ${po.po_number} registered · ${projectId}`,
        body: `${q.client_name}: ${currency} ${poValue}${poDiffers ? ` (quoted ${q.currency || currency} ${quoted})` : ''}${stages.length ? `, ${stages.length} payment stage${stages.length === 1 ? '' : 's'}` : ''}.`,
        entity: 'project', entityId: projectId, link: `/projects/${encodeURIComponent(projectId)}`,
        dedupeKey: `po-registered:${po.po_number}:${who}`,
      }, client);
    }
  }

  // ---- onboarding checklist from the template; a past PO's work is long started
  let checklist = 0;
  if (mode === 'live' && b.onboarding_template_id !== 0) {
    let ot = null;
    if (b.onboarding_template_id) {
      ({ rows: [ot] } = await client.query('SELECT * FROM onboarding_templates WHERE id = $1 AND active', [b.onboarding_template_id]));
    } else {
      ({ rows: [ot] } = await client.query(
        `SELECT t.* FROM onboarding_templates t
          WHERE t.active AND (t.id = (SELECT onboarding_template_id FROM services WHERE name = $1) OR t.is_default)
          ORDER BY (t.id = (SELECT onboarding_template_id FROM services WHERE name = $1)) DESC, t.is_default DESC LIMIT 1`, [q.service_quoted]));
    }
    const { rows: [{ n: existing }] } = await client.query('SELECT COUNT(*)::int AS n FROM onboarding_tasks WHERE project_id = $1', [projectId]);
    if (ot && existing === 0) {
      const { rows: steps } = await client.query('SELECT * FROM onboarding_template_lines WHERE template_id = $1 ORDER BY step_no', [ot.id]);
      const start = b.planned_start_date ?? b.po_date ?? null;
      for (const st of steps) {
        await client.query(
          `INSERT INTO onboarding_tasks (project_id, step_no, stage, step, owner, owner_email, target_date)
           VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $7::date IS NULL OR $8::int IS NULL THEN NULL ELSE $7::date + $8::int END)`,
          [projectId, st.step_no, st.stage, st.step, b.project_manager ?? null, b.project_manager_email ?? null, start, st.days_after_start]);
        checklist += 1;
      }
    }
  }

  return {
    quotation_no: q.quotation_no, project_id: projectId, project_created: projectCreated, po_number: po.po_number, po_value: poValue, currency,
    stages, service_lines: lines.length || 1, checklist_steps: checklist, template: template?.name || null,
    // The currency defaults to the quotation's; one changed by hand is saved, and flagged.
    save_warning: currencyMismatch(currency, q),
    // What the registration found worth saying (#26).
    quoted_total: quoted ?? null, po_value_differs: poDiffers,
  };
}
