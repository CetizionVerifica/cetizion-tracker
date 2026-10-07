import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { purgeAfterCommit } from '../lib/documents.js';
import { recordInvoice } from '../lib/invoices.js';
import { emailNewInvoice } from '../lib/portalNotices.js';
import { settleInvoiceReview } from './invoiceReview.js';
import { claimNextId } from '../lib/sequences.js';
import { ApiError } from '../middleware/error.js';
import { requireAdmin } from '../auth/middleware.js';
import { ownerClause, parentClause, purchaseOrderClause, scopeOf } from '../auth/ownership.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { ONBOARDING_TEMPLATE } from '../lib/resources.js';
import { normalizeName } from '../lib/names.ts';
import { onboardingProgress, withDerivedSteps } from '../lib/onboarding.js';

export const projectRouter = Router();
export const poRouter = Router();
export const quotationRouter = Router();
export const stageRouter = Router();
export const vendorInvoiceRouter = Router();
export const claimRouter = Router();
export const travelRouter = Router();

const parse = (schema, body) => {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        result.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return result.data;
};

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

// An absent or blank amount must stay absent — coercing it would produce
// NaN and reject a request that was perfectly valid.
const toNumber = (v) => {
  const cleaned = blank(v);
  if (cleaned === null || cleaned === undefined) return cleaned;
  const n = typeof cleaned === 'string' ? Number(cleaned.replace(/,/g, '')) : Number(cleaned);
  return Number.isNaN(n) ? cleaned : n;
};

const dateStr = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional());
const money = z.preprocess(toNumber, z.number({ error: 'Enter an amount' }).min(0).nullable().optional());
const requiredMoney = z.preprocess(
  toNumber,
  z.number({ error: 'Enter an amount' }).min(0)
);

// ---------------------------------------------------------------------
// Project — everything about one project on a single screen
// ---------------------------------------------------------------------

projectRouter.get('/:projectId/full', async (req, res) => {
  const id = req.params.projectId;
  const scope = scopeOf(req);
  // Gate on the project itself (#18 Phase 2C). Everything below hangs off it,
  // so a project this user may not open yields nothing rather than a header
  // they are refused and a body they are not. 404, so the answer is the same
  // as for a project that does not exist.
  const headParams = [id];
  const headMine = ownerClause(scope, headParams, { alias: 'p' });
  const project = await query(
    `SELECT p.* FROM v_projects p WHERE p.project_id = $1 ${headMine ? `AND ${headMine}` : ''}`,
    headParams
  );
  if (!project.rows.length) throw new ApiError(404, 'Project not found');

  // A quotation linked to this project may still belong to somebody else, so
  // that one list carries its own restriction rather than inheriting the
  // project's.
  const qParams = [id];
  const qMine = ownerClause(scope, qParams, { alias: 'q' });

  const [pos, services, stages, onboarding, travel, quotations, milestones] = await Promise.all([
    query('SELECT * FROM v_purchase_orders WHERE project_id = $1 ORDER BY po_date NULLS LAST, po_number', [id]),
    query(`SELECT s.* FROM po_services s
             JOIN purchase_orders p ON p.po_number = s.po_number
            WHERE p.project_id = $1 ORDER BY s.po_number, s.id`, [id]),
    query('SELECT * FROM v_payment_stages WHERE project_id = $1 ORDER BY po_number, stage_no', [id]),
    query('SELECT * FROM onboarding_tasks WHERE project_id = $1 ORDER BY step_no', [id]),
    query('SELECT * FROM v_travel_logs WHERE project_id = $1 ORDER BY travel_start_date NULLS LAST', [id]),
    query(`SELECT q.* FROM v_quotations q WHERE q.project_id = $1 ${qMine ? `AND ${qMine}` : ''}
            ORDER BY q.quotation_date`, qParams),
    // Each milestone with the stages it triggers and what they are worth (#26).
    // No predicate of its own: the project was gated at the top of this
    // handler, and a milestone belongs to its project.
    query(`SELECT m.*, COALESCE((SELECT json_agg(json_build_object('id', s.id, 'po_number', s.po_number, 'stage_name', s.stage_name,
                   'stage_amount', s.stage_amount, 'currency', s.currency, 'invoice_no', s.invoice_no) ORDER BY s.po_number, s.stage_no)
              FROM v_payment_stages s WHERE s.milestone_id = m.id), '[]'::json) AS stages
             FROM project_milestones m WHERE m.project_id = $1 ORDER BY m.sort_order, m.target_date NULLS LAST, m.id`, [id]),
  ]);

  // The checklist steps that another record owns answer for themselves,
  // and they are worked out here rather than in the client: a derived
  // figure belongs next to the rows it is derived from, like every other
  // rollup in this codebase.
  const context = {
    project: project.rows[0],
    purchase_orders: pos.rows,
    services: services.rows,
    payment_stages: stages.rows,
    travel: travel.rows,
  };
  const checklist = withDerivedSteps(onboarding.rows, context);

  res.json({
    data: {
      project: project.rows[0],
      purchase_orders: pos.rows,
      services: services.rows,
      payment_stages: stages.rows,
      onboarding: checklist,
      onboarding_progress: onboardingProgress(checklist),
      travel: travel.rows,
      quotations: quotations.rows,
      milestones: milestones.rows,
    },
  });
});

projectRouter.post('/:projectId/onboarding/apply-template', async (req, res) => {
  const id = req.params.projectId;
  const { owner = null, owner_email = null } = req.body || {};

  const scope = scopeOf(req);

  const rows = await transaction(async (client) => {
    // The ownership predicate is part of the existence check, so a project
    // this user cannot reach is indistinguishable from one that is not there
    // (#18 Phase 2C).
    const params = [id];
    const mine = ownerClause(scope, params, { alias: 'p' });
    const exists = await client.query(
      `SELECT 1 FROM projects p WHERE p.project_id = $1 ${mine ? `AND ${mine}` : ''}`, params);
    if (!exists.rowCount) throw new ApiError(404, 'Project not found');

    const current = await client.query(
      'SELECT COALESCE(MAX(step_no), 0) AS max FROM onboarding_tasks WHERE project_id = $1',
      [id]
    );
    let step = Number(current.rows[0].max);

    const inserted = [];
    for (const [stage, text] of ONBOARDING_TEMPLATE) {
      // Adding the checklist twice would be a data-entry accident, not intent.
      const dup = await client.query(
        'SELECT 1 FROM onboarding_tasks WHERE project_id = $1 AND step = $2',
        [id, text]
      );
      if (dup.rowCount) continue;
      step += 1;
      const { rows: r } = await client.query(
        `INSERT INTO onboarding_tasks (project_id, step_no, stage, step, owner, owner_email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, step, stage, text, blank(owner), blank(owner_email)]
      );
      inserted.push(r[0]);
    }
    return inserted;
  });

  res.status(201).json({ data: rows, added: rows.length });
});

// ---------------------------------------------------------------------
// Quotation → project.  The workbook's step 1→2 handoff, in one action.
//
// Two modes are supported:
//
//   New project (project_id absent / null / blank):
//     Assigns the next project number, inserts a new project, links the
//     quotation, and optionally applies the onboarding template.
//
//   Existing project (project_id is a non-empty string):
//     Validates the project exists and belongs to the same client as the
//     quotation, then links the quotation to it.  No new project is
//     created, no project-number sequence is consumed, no onboarding
//     rows are added, and no existing project data is modified.
// ---------------------------------------------------------------------

const convertSchema = z.object({
  // Present → link to existing project.  Absent/blank → create new project.
  project_id: z.preprocess(blank, z.string().trim().max(40).nullable().optional()),
  // Fields for the "create new project" path only:
  project_manager: z.preprocess(blank, z.string().trim().max(120).nullable().optional()),
  project_manager_email: z.preprocess(blank, z.string().trim().max(160).nullable().optional()),
  planned_start_date: dateStr,
  planned_delivery_date: dateStr,
  apply_onboarding_template: z.boolean().optional().default(true),
});

quotationRouter.post('/:id/convert', async (req, res) => {
  const body = parse(convertSchema, req.body || {});

  const scope = scopeOf(req);

  const data = await transaction(async (client) => {
    // The ownership predicate rides along in the locking read, so a sales
    // user cannot register somebody else's quotation — and cannot learn that
    // it exists either (#18 Phase 2C).
    const qParams = [req.params.id];
    const qMine = ownerClause(scope, qParams, { alias: 'q' });
    const { rows: qrows } = await client.query(
      // Locked, so two "Register" clicks on the same quotation cannot both create a project:
      // the second waits, then sees the project the first one linked.
      `SELECT q.* FROM quotations q
        WHERE (q.id = $1 OR q.quotation_no = $1::text) ${qMine ? `AND ${qMine}` : ''}
        FOR UPDATE`,
      qParams
    );
    if (!qrows.length) throw new ApiError(404, 'Quotation not found');
    const quotation = qrows[0];

    if (quotation.project_id) {
      throw new ApiError(422, `This quotation is already registered as project ${quotation.project_id}`);
    }

    // ------------------------------------------------------------------
    // Path A — link to an existing project
    // ------------------------------------------------------------------
    if (body.project_id) {
      // Confirm the project exists.  FOR SHARE prevents concurrent deletion.
      const pParams = [body.project_id];
      const pMine = ownerClause(scope, pParams, { alias: 'p' });
      const { rows: prows } = await client.query(
        `SELECT p.project_id, p.client_name FROM projects p
          WHERE p.project_id = $1 ${pMine ? `AND ${pMine}` : ''} FOR SHARE`,
        pParams
      );
      if (!prows.length) {
        throw new ApiError(422, `Project ${body.project_id} not found`);
      }
      const existingProject = prows[0];

      // Cross-client safety: use the application's canonical normalizeName() which collapses
      // repeated interior spaces in addition to trimming and lowercasing, so "Hindalco  Ltd"
      // and "Hindalco Ltd" are treated as the same client (consistent with sales-report grouping).
      if (normalizeName(existingProject.client_name) !== normalizeName(quotation.client_name)) {
        throw new ApiError(
          422,
          `Project ${body.project_id} belongs to a different client ` +
          `(${existingProject.client_name}) — cannot link a quotation for ${quotation.client_name}`
        );
      }

      // Link the quotation only.  Nothing else is changed.
      // claimNextId is NOT called.  No row is inserted into projects.
      // No onboarding rows are created.  Existing project data is untouched.
      await client.query(
        `UPDATE quotations
            SET project_id = $1, po_received = true, status = 'Won - PO Received'
          WHERE id = $2`,
        [existingProject.project_id, quotation.id]
      );

      return { project: existingProject, onboarding_steps_added: 0 };
    }

    // ------------------------------------------------------------------
    // Path B — create a brand-new project (original behaviour, unchanged)
    // ------------------------------------------------------------------
    // The project ID year comes from planned_start_date so historical projects
    // land in the correct series (e.g. PRJ-2025-... for a 2025 project imported today).
    // Falls back to the current business year when no start date is supplied.
    const projectYear = body.planned_start_date
      ? String(body.planned_start_date).slice(0, 4)
      : undefined;
    const projectId = await claimNextId('project', client, projectYear);
    const { rows: [project] } = await client.query(
      // owner_user_id is inherited from the quotation, not taken from the
      // session and not guessed from sales_person (#18 Phase 2C). The project
      // is the same piece of work one step later; whoever was responsible for
      // winning it is responsible for delivering it, and an admin registering
      // somebody else's win must not become its owner. An unowned quotation
      // produces an unowned project, which is the honest answer.
      //
      // Originating salesperson (#18 Phase 4): preserved only when the quotation
      // has a verified originating salesperson.
      `INSERT INTO projects (project_id, client_name, primary_service, project_manager,
                             project_manager_email, sales_person, planned_start_date,
                             planned_delivery_date, remarks, owner_user_id,
                             originating_user_id, originating_user_snapshot_id, originating_user_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        projectId, quotation.client_name, quotation.service_quoted,
        body.project_manager, body.project_manager_email, quotation.sales_person,
        body.planned_start_date ?? null, body.planned_delivery_date ?? null,
        `Won from quotation ${quotation.quotation_no}`, quotation.owner_user_id,
        quotation.originating_user_id ?? null,
        quotation.originating_user_id ? (quotation.originating_user_snapshot_id ?? quotation.originating_user_id) : null,
        quotation.originating_user_id ? (quotation.originating_user_name ?? null) : null,
      ]
    );

    await client.query(
      `UPDATE quotations
          SET project_id = $1, po_received = true, status = 'Won - PO Received'
        WHERE id = $2`,
      [project.project_id, quotation.id]
    );

    let steps = 0;
    if (body.apply_onboarding_template) {
      const dup = await client.query(
        'SELECT COUNT(*)::int AS n FROM onboarding_tasks WHERE project_id = $1',
        [project.project_id]
      );
      if (dup.rows[0].n === 0) {
        for (const [i, [stage, text]] of ONBOARDING_TEMPLATE.entries()) {
          await client.query(
            `INSERT INTO onboarding_tasks (project_id, step_no, stage, step, owner, owner_email)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [project.project_id, i + 1, stage, text, body.project_manager, body.project_manager_email]
          );
        }
        steps = ONBOARDING_TEMPLATE.length;
      }
    }

    return { project, onboarding_steps_added: steps };
  });

  res.status(201).json({ data });
});

// ---------------------------------------------------------------------
// Purchase order — services and stages on one screen
// ---------------------------------------------------------------------

poRouter.get('/:poNumber/full', async (req, res) => {
  const po = decodeURIComponent(req.params.poNumber);
  // A purchase order has no owner; it belongs to whoever owns the quotation
  // it fulfils or the project it sits under (#18 Phase 2C).
  const headParams = [po];
  const mine = purchaseOrderClause(scopeOf(req), headParams, { alias: 'po' });
  const header = await query(
    `SELECT po.* FROM v_purchase_orders po WHERE po.po_number = $1 ${mine ? `AND ${mine}` : ''}`,
    headParams
  );
  if (!header.rows.length) throw new ApiError(404, 'Purchase order not found');

  const [services, stages, travel] = await Promise.all([
    query('SELECT * FROM po_services WHERE po_number = $1 ORDER BY id', [po]),
    query('SELECT * FROM v_payment_stages WHERE po_number = $1 ORDER BY stage_no', [po]),
    query('SELECT * FROM v_travel_logs WHERE po_number = $1 ORDER BY travel_start_date NULLS LAST', [po]),
  ]);

  const { poFromEmail } = await import('../lib/mailbox/autoPurchaseOrder.js');
  res.json({
    data: {
      purchase_order: header.rows[0],
      // Registered automatically from the client's email: the banner (docs/email-po-plan.md).
      from_email: await poFromEmail(po),
      services: services.rows,
      payment_stages: stages.rows,
      travel: travel.rows,
    },
  });
});

const splitSchema = z.object({
  stages: z
    .array(
      z.object({
        stage_name: z.string().trim().min(1),
        trigger_event: z.enum(['On PO Registration', 'On Delivery', 'On Milestone', 'Manual']),
        stage_percent: z.number().min(0.0001).max(1),
        credit_days: z.number().int().min(0).max(365).nullable().optional(),
        milestone_name: z.string().trim().max(200).nullable().optional(),
      })
    )
    .min(1, 'Add at least one stage'),
  replace: z.boolean().optional().default(false),
});

/** Create a whole payment split in one go — the usual 50/50 or 30/70. */
poRouter.post('/:poNumber/stages', async (req, res) => {
  const po = decodeURIComponent(req.params.poNumber);
  const body = parse(splitSchema, req.body || {});

  const total = body.stages.reduce((sum, s) => sum + s.stage_percent, 0);

  const scope = scopeOf(req);

  const { createdIds, removedDocuments } = await transaction(async (client) => {
    // A purchase order takes its access from the quotation it fulfils or the
    // project it sits under, so the check is on the parent, in the same
    // statement that proves the PO exists (#18 Phase 2C).
    const params = [po];
    const mine = parentClause(scope, params, { kind: 'purchase_order', alias: 'po' });
    const exists = await client.query(
      `SELECT 1 FROM purchase_orders po WHERE po.po_number = $1 ${mine ? `AND ${mine}` : ''}`, params);
    if (!exists.rowCount) throw new ApiError(404, 'Purchase order not found');

    let removedDocuments = [];
    if (body.replace) {
      const { rows: removed } = await client.query(
        `DELETE FROM payment_stages
          WHERE po_number = $1 AND invoice_no IS NULL AND amount_received = 0
          RETURNING document_id`,
        [po]
      );
      removedDocuments = removed.map((row) => row.document_id).filter(Boolean);
    }

    // A stage that has been invoiced or paid is never deleted, so what is left
    // still accounts for part of the PO. Checking only the incoming stages let
    // a 50/50 split land beside a paid 50% stage and schedule 150% of the PO.
    const { rows: [kept] } = await client.query(
      `SELECT COALESCE(SUM(stage_percent), 0)::float8 AS percent,
              COALESCE(SUM(stage_percent) FILTER (
                WHERE invoice_no IS NOT NULL OR amount_received > 0), 0)::float8 AS billed
         FROM payment_stages WHERE po_number = $1`,
      [po]
    );
    const remaining = 1 - kept.percent;
    if (Math.abs(total - remaining) > 0.0001) {
      const pc = (n) => `${(n * 100).toFixed(1)}%`;
      const why = kept.billed > 0
        ? `${pc(kept.billed)} of this PO is already invoiced or paid`
        : `stages already on this PO account for ${pc(kept.percent)}`;
      throw new ApiError(422, kept.percent > 0
        ? `${why[0].toUpperCase()}${why.slice(1)}, so the new stages must add up to ${pc(remaining)} — they total ${pc(total)}.`
        : `Stages must add up to 100% — they currently total ${pc(total)}.`);
    }

    const start = await client.query(
      'SELECT COALESCE(MAX(stage_no), 0) AS max FROM payment_stages WHERE po_number = $1',
      [po]
    );
    let n = Number(start.rows[0].max);
    const created = [];
    for (const stage of body.stages) {
      n += 1;
      const { rows: r } = await client.query(
        `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, credit_days, milestone_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [po, n, stage.stage_name, stage.trigger_event, stage.stage_percent, stage.credit_days ?? null, stage.milestone_name || null]
      );
      created.push(r[0].id);
    }
    return { createdIds: created, removedDocuments };
  });

  // Files of the stages that were replaced leave Cloudinary once the change is committed.
  for (const documentId of removedDocuments) await purgeAfterCommit(documentId);

  const { rows } = await query(
    'SELECT * FROM v_payment_stages WHERE id = ANY($1) ORDER BY stage_no',
    [createdIds]
  );
  res.status(201).json({ data: rows });
});

// ---------------------------------------------------------------------
// Finance actions — the two things finance actually does to a stage
// ---------------------------------------------------------------------

/**
 * `invoice_no` is optional, and leaving it out is the better path.
 *
 * A GST invoice series has to be unbroken and unrepeated, and a number the
 * client read a moment ago is not that: two people raising invoices at the
 * same time both preview the same next number and both send it back.
 * Omitted, the number is claimed inside the transaction below — the same
 * guarantee quotation numbers have had since #14 — and two concurrent
 * callers queue for it rather than colliding.
 *
 * It stays accepted because an invoice raised outside the tracker, or one
 * being recorded after the fact, has a number of its own that must be
 * kept.
 */
const invoiceSchema = z.object({
  invoice_no: z.preprocess(blank, z.string().trim().min(1).max(60).nullable().optional()),
  invoice_date: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')),
  document_id: z.number().int().positive().nullable().optional(),
  review_id: z.number().int().positive().optional(),
});

stageRouter.post('/:id/invoice', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Payment stage not found');
  const body = parse(invoiceSchema, req.body || {});
  const scope = scopeOf(req);
  const { id, replaced } = await transaction(async (client) => {
    const recorded = await recordInvoice(client, {
      stageId: Number(req.params.id), invoiceNo: body.invoice_no ?? null, invoiceDate: body.invoice_date, documentId: body.document_id, scope,
    });
    // An invoice email from the review queue (invoiceReview.js), settled by this.
    if (body.review_id) await settleInvoiceReview(client, req, body.review_id, { stageId: recorded.id, invoiceNo: recorded.invoice_no });
    return recorded;
  });

  // The replaced file leaves Cloudinary only once the new one is committed.
  if (replaced) await purgeAfterCommit(replaced);
  // The client's portal contacts hear the invoice is in the portal (#198
  // phase 3), once; the invoice is recorded whatever happens to the email.
  await emailNewInvoice(id, { base: req.get('origin') || `${req.protocol}://${req.get('host')}`, sentBy: req.user?.username || 'system' })
    .catch((err) => console.error('[portal] new-invoice email', err));

  const { rows: full } = await query('SELECT * FROM v_payment_stages WHERE id = $1', [id]);
  res.json({ data: full[0] });
});

const receiptSchema = z.object({
  amount_received: requiredMoney,
  payment_received_date: dateStr,
  mode: z.enum(['set', 'add']).optional().default('set'),
  tds_amount: z.preprocess(blank, z.coerce.number().min(0).optional()),
  payment_mode: z.preprocess(blank, z.enum(['bank_transfer', 'cheque', 'upi', 'cash', 'other']).optional()),
  reference: z.preprocess(blank, z.string().trim().max(120).nullable().optional()),
  notes: z.preprocess(blank, z.string().trim().max(1000).nullable().optional()),
  // The client's payment advice from the portal this receipt matches (#198 §4).
  portal_action_id: z.preprocess(blank, z.coerce.number().int().positive().optional()),
});

stageRouter.post('/:id/payment', async (req, res) => {
  const body = parse(receiptSchema, req.body || {});
  // Since #27 every receipt is its own row; the stage total follows by trigger.
  // mode 'add' (or a receipt object) records a delta; 'set' records what brings the total to the figure.
  //
  // A payment stage has no owner of its own: it belongs to whoever owns the
  // quotation or the project above the purchase order it sits under (#18
  // Phase 2C). The predicate rides in this read, and every insert below
  // takes its stage_id from the row it returned — so a stage this caller
  // cannot reach is indistinguishable from one that does not exist, and
  // nothing is ever written against it.
  const params = [req.params.id];
  const mine = parentClause(scopeOf(req), params, { kind: 'via_po', alias: 'ps' });
  const { rows: [stage] } = await query(
    `SELECT ps.id, ps.amount_received FROM payment_stages ps
      WHERE ps.id = $1 ${mine ? `AND ${mine}` : ''}`,
    params
  );
  if (!stage) throw new ApiError(404, 'Payment stage not found');
  // A payment advice is matched only by a receipt on an invoice it is about.
  if (body.portal_action_id) {
    const { rowCount } = await query(
      `SELECT 1 FROM portal_client_actions a JOIN portal_client_action_stages x ON x.action_id = a.id
        WHERE a.id = $1 AND x.stage_id = $2 AND a.kind = 'payment_advice' AND a.status IN ('open','matched')`,
      [body.portal_action_id, stage.id]);
    if (!rowCount) throw new ApiError(422, 'Please check the highlighted fields', { fields: { portal_action_id: 'That payment advice is not about this invoice, or is already settled' } });
  }
  const delta = body.mode === 'set' ? Number(body.amount_received) - Number(stage.amount_received) : Number(body.amount_received);
  if (delta > 0 || Number(body.tds_amount || 0) > 0) {
    // The receipt and the advice it settles, in one transaction (#198).
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO payments (stage_id, amount, tds_amount, received_on, mode, reference, notes, recorded_by, portal_action_id)
         VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9)`,
        [stage.id, Math.max(delta, 0), Number(body.tds_amount || 0), body.payment_received_date ?? null, body.payment_mode || 'bank_transfer', body.reference ?? null, body.notes ?? null, req.user?.username || null, body.portal_action_id ?? null]
      );
      // Matched once every invoice the advice covers has its receipt.
      if (body.portal_action_id) {
        await client.query(
          `UPDATE portal_client_actions a SET status = 'matched', resolved_by = $2, resolved_at = now()
            WHERE a.id = $1 AND a.status = 'open'
              AND NOT EXISTS (SELECT 1 FROM portal_client_action_stages x WHERE x.action_id = a.id
                                 AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.portal_action_id = a.id AND p.stage_id = x.stage_id))`,
          [body.portal_action_id, req.user?.username || null]);
      }
    });
  } else if (body.mode === 'set' && delta !== 0) {
    // Bringing the total down is a negative row in the ledger, not a figure
    // written over the top of it: the stage total is computed from the rows,
    // so anything written by hand is undone by the next receipt.
    await query(
      `INSERT INTO payments (stage_id, amount, received_on, mode, notes, recorded_by)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), 'other', $4, $5)`,
      [stage.id, delta, body.payment_received_date ?? null,
        `Adjusted: total set to ${body.amount_received}`, req.user?.username || null]
    );
  }
  const rows = [stage];
  const { rows: full } = await query('SELECT * FROM v_payment_stages WHERE id = $1', [rows[0].id]);
  res.json({ data: full[0] });
});

// ---------------------------------------------------------------------
// Travel finance actions
// ---------------------------------------------------------------------

const vendorPaySchema = z.object({
  amount_paid: requiredMoney,
  payment_date: dateStr,
});

/**
 * Record what a travel vendor has been paid.
 *
 * Open to both roles, deliberately: arranging travel and settling the
 * vendor's invoice is ordinary work, and there is no finance role for it to
 * belong to. What changed in #85 is not who may do it but what is left
 * behind — the figure now arrives with the account that recorded it, in the
 * same transaction, and the two columns are no longer reachable through the
 * ordinary edit form (see protectedFields on the resource).
 *
 * The total is set, not added to, exactly as before.
 */
vendorInvoiceRouter.post('/:id/pay', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Vendor invoice not found');
  const body = parse(vendorPaySchema, req.body || {});
  const id = Number(req.params.id);

  const paid = await transaction(async (client) => {
    const { rows: [before] } = await client.query(
      'SELECT id, vendor_invoice_id, amount_paid, payment_date FROM travel_vendor_invoices WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!before) throw new ApiError(404, 'Vendor invoice not found');

    const { rows: [after] } = await client.query(
      `UPDATE travel_vendor_invoices
          SET amount_paid = $1, payment_date = COALESCE($2, CURRENT_DATE)
        WHERE id = $3 RETURNING id, amount_paid, payment_date`,
      [body.amount_paid, body.payment_date ?? null, id]
    );

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.VENDOR_INVOICE_PAID,
      entityType: 'vendor_invoice',
      entityId: before.vendor_invoice_id ?? String(before.id),
      metadata: {
        amount_paid_before: Number(before.amount_paid),
        amount_paid_after: Number(after.amount_paid),
        payment_date: after.payment_date,
      },
    });
    return after;
  });

  const { rows: full } = await query('SELECT * FROM v_travel_vendor_invoices WHERE id = $1', [paid.id]);
  res.json({ data: full[0] });
});

// ---------------------------------------------------------------------
// Expense claims — deciding one, and paying it (#85)
//
// Submitting a claim is ordinary work; both of the routes below are the
// administrator's. Until #85 neither carried a role check at all, so any
// signed-in person could approve a claim — their own included, since a
// claim carries no owner to compare against — and then reimburse it, and
// name whoever they liked as the approver. Three separate things fixed
// together, because any one of them left alone still lets money out:
//
//   requireAdmin      who may decide and who may pay
//   approved_by       taken from the session, never from the body
//   protectedFields   the same columns, closed on the generic form
//
// A claim still has no link to the person who made it, so "an admin may not
// approve their own claim" is not a rule this can enforce; that needs a
// column the table does not have, and is deliberately left to its own
// change. What is enforced is that only an admin decides, and that whoever
// did is recorded where it cannot be edited.
// ---------------------------------------------------------------------

const claimDecisionSchema = z.object({
  approval_status: z.enum(['Submitted', 'Approved', 'Rejected', 'On Hold']),
});

claimRouter.post('/:id/decide', requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Claim not found');
  const body = parse(claimDecisionSchema, req.body || {});
  const id = Number(req.params.id);
  // Whoever is signed in decided it. The body is not asked, so there is
  // nothing to disagree with: the name on the record and the account in the
  // audit row are the same person by construction.
  const decidedBy = req.user?.name || req.user?.username || null;

  const decided = await transaction(async (client) => {
    const { rows: [before] } = await client.query(
      `SELECT id, claim_id, approval_status, approved_by, amount_claimed, amount_reimbursed
         FROM employee_expense_claims WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!before) throw new ApiError(404, 'Claim not found');

    // Money already paid against this claim is why the approval cannot
    // simply be taken back. Rejecting a claim that has been part-reimbursed
    // would leave the payment recorded and invisible — the claim's status is
    // derived from approval_status first, so the reimbursement stops being
    // counted anywhere while the money stays gone. Put the figure right
    // first, through /correct, which says plainly that is what happened.
    if (Number(before.amount_reimbursed) > 0
        && before.approval_status === 'Approved'
        && body.approval_status !== 'Approved') {
      throw new ApiError(
        409,
        `${before.claim_id} has already been reimbursed ${Number(before.amount_reimbursed)}. `
        + 'Correct the reimbursement first, then change the decision.'
      );
    }

    const { rows: [after] } = await client.query(
      `UPDATE employee_expense_claims
          SET approval_status = $1, approved_by = COALESCE($2, approved_by)
        WHERE id = $3 RETURNING id, approval_status, approved_by`,
      [body.approval_status, decidedBy, id]
    );

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.CLAIM_DECIDED,
      entityType: 'expense_claim',
      entityId: before.claim_id ?? String(before.id),
      metadata: {
        approval_status_before: before.approval_status,
        approval_status_after: after.approval_status,
        approved_by: after.approved_by,
        amount_claimed: Number(before.amount_claimed),
      },
    });
    return after;
  });

  const { rows: full } = await query('SELECT * FROM v_employee_expense_claims WHERE id = $1', [decided.id]);
  res.json({ data: full[0] });
});

const reimburseSchema = z.object({
  amount_reimbursed: money,
  reimbursement_date: dateStr,
});

/**
 * Record a reimbursement.
 *
 * `amount_reimbursed` is a running total, not the size of one payment, and
 * it stays that way: the client sends what the total now comes to, and a
 * part-payment is a smaller total followed later by a larger one. The view
 * reads "Partly reimbursed" from that figure against amount_claimed, and
 * the dialog adds this payment to what is already recorded before sending.
 * Left exactly as it was — the only changes here are who may call it and
 * what it writes down afterwards.
 */
claimRouter.post('/:id/reimburse', requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Claim not found');
  const body = parse(reimburseSchema, req.body || {});
  const id = Number(req.params.id);

  const paid = await transaction(async (client) => {
    const { rows: [before] } = await client.query(
      `SELECT id, claim_id, amount_claimed, amount_reimbursed
         FROM employee_expense_claims WHERE id = $1 FOR UPDATE`,
      [id]
    );

    const { rows } = await client.query(
      `UPDATE employee_expense_claims
          SET amount_reimbursed = COALESCE($1, amount_claimed),
              reimbursement_date = COALESCE($2, CURRENT_DATE)
        WHERE id = $3 AND approval_status = 'Approved'
        RETURNING id, amount_reimbursed, reimbursement_date`,
      [body.amount_reimbursed ?? null, body.reimbursement_date ?? null, id]
    );
    // One message for "no such claim" and for "not approved yet", as before.
    if (!rows.length) throw new ApiError(409, 'Claim not found, or it has not been approved yet');
    const after = rows[0];

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.CLAIM_REIMBURSED,
      entityType: 'expense_claim',
      entityId: before?.claim_id ?? String(after.id),
      metadata: {
        amount_claimed: Number(before?.amount_claimed ?? 0),
        amount_reimbursed_before: Number(before?.amount_reimbursed ?? 0),
        amount_reimbursed_after: Number(after.amount_reimbursed),
        reimbursement_date: after.reimbursement_date,
      },
    });
    return after;
  });

  const { rows: full } = await query('SELECT * FROM v_employee_expense_claims WHERE id = $1', [paid.id]);
  res.json({ data: full[0] });
});

const claimCorrectionSchema = z.object({
  amount_reimbursed: money,
  reimbursement_date: dateStr,
  approval_status: z.enum(['Submitted', 'Approved', 'Rejected', 'On Hold']).optional(),
  reason: z.preprocess(blank, z.string().trim().min(1, 'Say what is being corrected').max(500)),
});

/**
 * Put a wrong figure right.
 *
 * The reimbursement dialog can only ever move the total up — it adds this
 * payment to what is already there — so a mistyped amount has no way back
 * through the ordinary route, and the ordinary form is closed to these
 * columns on purpose. This is the way back: administrator only, bounded by
 * what was claimed, and refused without a reason, which is recorded.
 *
 * It is not a second reimbursement route. Reimbursing is /reimburse; this
 * says "the record is wrong" and is meant to be rare enough that every use
 * is worth reading in the log.
 */
claimRouter.post('/:id/correct', requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Claim not found');
  const body = parse(claimCorrectionSchema, req.body || {});
  const id = Number(req.params.id);

  // A blank field is preprocessed to null, so "absent" and "sent empty" both
  // arrive as nothing to do — treat them the same rather than accepting a
  // request that would quietly change nothing and report success.
  const given = (v) => v !== undefined && v !== null;
  if (!given(body.amount_reimbursed) && !given(body.reimbursement_date) && !given(body.approval_status)) {
    throw new ApiError(422, 'Nothing to correct');
  }

  const corrected = await transaction(async (client) => {
    const { rows: [before] } = await client.query(
      `SELECT id, claim_id, approval_status, approved_by, amount_claimed, amount_reimbursed, reimbursement_date
         FROM employee_expense_claims WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (!before) throw new ApiError(404, 'Claim not found');

    const amount = body.amount_reimbursed ?? null;
    // A correction may not invent a reimbursement larger than the claim. The
    // ordinary route has never checked this; the difference is that this one
    // exists to fix figures, so accepting an impossible one would defeat it.
    if (amount !== null && amount > Number(before.amount_claimed)) {
      throw new ApiError(422, 'Please check the highlighted fields', {
        fields: { amount_reimbursed: `More than the ${Number(before.amount_claimed)} claimed` },
      });
    }

    // What the claim would look like afterwards, field by field, matching the
    // COALESCE below: anything not sent keeps the value it already had.
    const resultingAmount = amount !== null ? amount : Number(before.amount_reimbursed);
    const resultingStatus = body.approval_status ?? before.approval_status;

    // The same invariant /decide enforces, judged on the result rather than on
    // the field that happens to be in the request.
    //
    // Money recorded against a claim that is not approved is money the tracker
    // has stopped counting: the view reads the status from approval_status
    // first, so the reimbursement disappears from every figure while the
    // payment itself does not. /decide refuses to create that state; a
    // correction that arrived at it by another route would be the same hole
    // with a reason attached.
    //
    // Both fields can be sent together, so this costs no legitimate
    // correction — rejecting a part-reimbursed claim is one call that says
    // what happened to the money as well as what happened to the claim.
    if (resultingStatus !== 'Approved' && resultingAmount > 0) {
      throw new ApiError(422, 'Please check the highlighted fields', {
        fields: {
          approval_status: `${resultingAmount} is still recorded as reimbursed`,
          amount_reimbursed: `Set this to 0 in the same correction to leave the claim ${resultingStatus}`,
        },
      });
    }

    const { rows: [after] } = await client.query(
      `UPDATE employee_expense_claims
          SET amount_reimbursed  = COALESCE($1, amount_reimbursed),
              reimbursement_date = COALESCE($2, reimbursement_date),
              approval_status    = COALESCE($3, approval_status)
        WHERE id = $4
        RETURNING id, approval_status, amount_reimbursed, reimbursement_date`,
      [amount, body.reimbursement_date ?? null, body.approval_status ?? null, id]
    );

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.CLAIM_CORRECTED,
      entityType: 'expense_claim',
      entityId: before.claim_id ?? String(before.id),
      metadata: {
        reason: body.reason,
        amount_claimed: Number(before.amount_claimed),
        amount_reimbursed_before: Number(before.amount_reimbursed),
        amount_reimbursed_after: Number(after.amount_reimbursed),
        // There is no reimbursement ledger on a claim — amount_reimbursed is
        // one column, so lowering it overwrites the old figure rather than
        // recording a reversal against it. This row is the only surviving
        // record that the larger figure was ever there, and the flag makes
        // the case worth reading greppable. Accounting for an actual refund,
        // as opposed to fixing a typo, is not something this endpoint can
        // claim to have done.
        lowers_recorded_total: Number(after.amount_reimbursed) < Number(before.amount_reimbursed),
        approval_status_before: before.approval_status,
        approval_status_after: after.approval_status,
        reimbursement_date_before: before.reimbursement_date,
        reimbursement_date_after: after.reimbursement_date,
      },
    });
    return after;
  });

  const { rows: full } = await query('SELECT * FROM v_employee_expense_claims WHERE id = $1', [corrected.id]);
  res.json({ data: full[0] });
});

// ---------------------------------------------------------------------
// Trip detail — the trip plus both cost sides
// ---------------------------------------------------------------------

travelRouter.get('/:travelId/full', async (req, res) => {
  const id = decodeURIComponent(req.params.travelId);
  const trip = await query('SELECT * FROM v_travel_logs WHERE travel_id = $1', [id]);
  if (!trip.rows.length) throw new ApiError(404, 'Trip not found');

  // An invoice is this trip's when one of its lines is (#196): one agency
  // bill covers several trips and people.
  const mine = 'SELECT vendor_invoice_id FROM travel_vendor_invoice_lines WHERE travel_id = $1';
  const [invoices, claims, legs, lines, credits, files] = await Promise.all([
    query(`SELECT * FROM v_travel_vendor_invoices WHERE id IN (${mine}) OR travel_id = $1 ORDER BY id`, [id]),
    query('SELECT * FROM v_employee_expense_claims WHERE travel_id = $1 ORDER BY id', [id]),
    query('SELECT * FROM v_travel_segments WHERE travel_id = $1 ORDER BY seq, start_date NULLS LAST, id', [id]),
    query('SELECT * FROM v_travel_invoice_lines WHERE travel_id = $1 ORDER BY vendor_invoice_id, id', [id]),
    query(`SELECT c.*, d.file_name AS document_name FROM travel_vendor_credit_notes c LEFT JOIN documents d ON d.id = c.document_id
            WHERE c.against_invoice_id IN (${mine}) ORDER BY c.credit_note_date NULLS LAST, c.id`, [id]),
    query(`SELECT a.*, d.file_name, d.content_type, d.size_bytes FROM attachments a JOIN documents d ON d.id = a.document_id
            WHERE a.entity = 'travel_log' AND a.entity_id = $1 ORDER BY a.created_at DESC`, [id]),
  ]);

  res.json({
    data: {
      trip: trip.rows[0], vendor_invoices: invoices.rows, expense_claims: claims.rows,
      legs: legs.rows, invoice_lines: lines.rows, credit_notes: credits.rows, documents: files.rows,
    },
  });
});

// ---------------------------------------------------------------------
// Vendor invoice detail (#196) — the header, its lines and their trips,
// its credit notes and its files
// ---------------------------------------------------------------------

vendorInvoiceRouter.get('/:id/full', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) throw new ApiError(404, 'Vendor invoice not found');
  const { rows: [invoice] } = await query('SELECT * FROM v_travel_vendor_invoices WHERE id = $1', [id]);
  if (!invoice) throw new ApiError(404, 'Vendor invoice not found');
  const [lines, credits, files] = await Promise.all([
    query(`SELECT l.*, t.employee_name, t.destination, t.travel_start_date, t.travel_end_date,
                  s.mode, s.from_place, s.to_place, s.start_date AS leg_date, s.status AS leg_status
             FROM v_travel_invoice_lines l
             JOIN travel_logs t ON t.travel_id = l.travel_id
             LEFT JOIN travel_segments s ON s.id = l.segment_id
            WHERE l.vendor_invoice_id = $1 ORDER BY l.id`, [id]),
    query(`SELECT c.*, d.file_name AS document_name FROM travel_vendor_credit_notes c LEFT JOIN documents d ON d.id = c.document_id
            WHERE c.against_invoice_id = $1 ORDER BY c.credit_note_date NULLS LAST, c.id`, [id]),
    query(`SELECT a.*, d.file_name, d.content_type, d.size_bytes FROM attachments a JOIN documents d ON d.id = a.document_id
            WHERE a.entity = 'travel_vendor_invoice' AND a.entity_id = $1 ORDER BY a.created_at DESC`, [String(id)]),
  ]);
  res.json({ data: { invoice, lines: lines.rows, credit_notes: credits.rows, documents: files.rows } });
});
