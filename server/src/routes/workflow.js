import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { purgeAfterCommit } from '../lib/documents.js';
import { recordInvoice } from '../lib/invoices.js';
import { emailNewInvoice } from '../lib/portalNotices.js';
import { settleInvoiceReview } from './invoiceReview.js';
import { claimNextId } from '../lib/sequences.js';
import { ApiError } from '../middleware/error.js';
import { requireAdmin, requireRole } from '../auth/middleware.js';
import { ownerClause, parentClause, purchaseOrderClause, scopeOf } from '../auth/ownership.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { actAs, logCreated, logInvoiceRaised, logPaymentRecorded, logStageMoves } from '../lib/recordActs.js';
import { ONBOARDING_TEMPLATE } from '../lib/resources.js';
import { normalizeName } from '../lib/names.ts';
import { onboardingProgress, withDerivedSteps } from '../lib/onboarding.js';

export const projectRouter = Router();
export const poRouter = Router();
export const quotationRouter = Router();
export const stageRouter = Router();
export const vendorInvoiceRouter = Router();
// One transfer across several of an agency's bills (#214 §2.6). Its own
// mount because a batch belongs to no single invoice: /api/vendor-invoices/:id
// is one bill, and this request is a bank transfer that closed several.
export const vendorPaymentRouter = Router();
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
    await actAs(client, req.user);
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
      await logStageMoves(client, req.user, [quotation.id]);

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
    await logCreated(client, req.user, { entity: 'project', ref: project.project_id, row: project, extra: { quotation_no: quotation.quotation_no } });
    await logStageMoves(client, req.user, [quotation.id]);

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
    await actAs(client, req.user);
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
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [po, n, stage.stage_name, stage.trigger_event, stage.stage_percent, stage.credit_days ?? null, stage.milestone_name || null]
      );
      await logCreated(client, req.user, { entity: 'payment_stage', ref: String(r[0].id), row: r[0] });
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
    await actAs(client, req.user);
    const recorded = await recordInvoice(client, {
      stageId: Number(req.params.id), invoiceNo: body.invoice_no ?? null, invoiceDate: body.invoice_date, documentId: body.document_id, scope,
    });
    const { rows: [stage] } = await client.query('SELECT * FROM payment_stages WHERE id = $1', [recorded.id]);
    await logInvoiceRaised(client, req.user, stage);
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
    `SELECT ps.id, ps.amount_received, ps.po_number, ps.stage_no, ps.invoice_no FROM payment_stages ps
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
      const { rows: [payment] } = await client.query(
        `INSERT INTO payments (stage_id, amount, tds_amount, received_on, mode, reference, notes, recorded_by, portal_action_id)
         VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8,$9) RETURNING id, amount, tds_amount, received_on, mode`,
        [stage.id, Math.max(delta, 0), Number(body.tds_amount || 0), body.payment_received_date ?? null, body.payment_mode || 'bank_transfer', body.reference ?? null, body.notes ?? null, req.user?.username || null, body.portal_action_id ?? null]
      );
      await logPaymentRecorded(client, req.user, {
        stage, amount: payment.amount, tds: payment.tds_amount, receivedOn: payment.received_on, mode: payment.mode, paymentId: payment.id,
      });
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
    await transaction(async (client) => {
      const { rows: [payment] } = await client.query(
        `INSERT INTO payments (stage_id, amount, received_on, mode, notes, recorded_by)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), 'other', $4, $5) RETURNING id, amount, received_on, mode`,
        [stage.id, delta, body.payment_received_date ?? null,
          `Adjusted: total set to ${body.amount_received}`, req.user?.username || null]
      );
      await logPaymentRecorded(client, req.user, {
        stage, amount: payment.amount, receivedOn: payment.received_on, mode: payment.mode, paymentId: payment.id, adjustment: true,
      });
    });
  }
  const rows = [stage];
  const { rows: full } = await query('SELECT * FROM v_payment_stages WHERE id = $1', [rows[0].id]);
  res.json({ data: full[0] });
});

// ---------------------------------------------------------------------
// Travel finance actions
// ---------------------------------------------------------------------

const VENDOR_PAYMENT_MODES = ['bank_transfer', 'upi', 'cheque', 'cash', 'card', 'other'];

/** A payment is something that happened; a date ahead of today is a plan. */
const notFuture = (field) => (value, ctx) => {
  if (value && value > new Date().toISOString().slice(0, 10)) {
    ctx.addIssue({ code: 'custom', message: 'A payment cannot be dated in the future', path: [field] });
  }
};

const vendorPaySchema = z.object({
  // Still the absolute total settled, as every caller before this change
  // sent it. `mode` switches that, exactly as the stage receipt route does.
  amount_paid: requiredMoney,
  payment_date: dateStr,
  mode: z.enum(['set', 'add']).optional().default('set'),
  tds_amount: z.preprocess(blank, z.coerce.number().min(0).optional()),
  payment_mode: z.preprocess(blank, z.enum(VENDOR_PAYMENT_MODES).optional()),
  reference: z.preprocess(blank, z.string().trim().max(120).nullable().optional()),
  document_id: z.preprocess(blank, z.coerce.number().int().positive().optional()),
  remarks: z.preprocess(blank, z.string().trim().max(1000).nullable().optional()),
}).superRefine((v, ctx) => notFuture('payment_date')(v.payment_date, ctx));

const vendorCorrectSchema = z.object({
  // Signed on purpose: this is the one route that may take money back off
  // an invoice, and it may move either leg of the settlement.
  amount: z.preprocess(blank, z.coerce.number().optional()),
  tds_amount: z.preprocess(blank, z.coerce.number().optional()),
  reason: z.string().trim().min(1, 'Say why this is being corrected').max(1000),
  paid_on: dateStr,
  payment_mode: z.preprocess(blank, z.enum(VENDOR_PAYMENT_MODES).optional()),
  reference: z.preprocess(blank, z.string().trim().max(120).nullable().optional()),
  document_id: z.preprocess(blank, z.coerce.number().int().positive().optional()),
}).superRefine((v, ctx) => notFuture('paid_on')(v.paid_on, ctx));

/**
 * The invoice, locked, with what its ledger already settles.
 *
 * The total is read from the ledger rather than from the cached column,
 * because the ledger is the record and the column is derived from it. The
 * lock is on the invoice row, so two payments on one bill cannot each
 * compute their delta from the same starting figure.
 */
async function lockVendorInvoice(client, id) {
  const { rows: [invoice] } = await client.query(
    'SELECT id, vendor_invoice_id, invoice_amount, amount_paid FROM travel_vendor_invoices WHERE id = $1 FOR UPDATE',
    [id]
  );
  if (!invoice) throw new ApiError(404, 'Vendor invoice not found');
  const { rows: [sum] } = await client.query(
    `SELECT COALESCE(SUM(amount + tds_amount), 0) AS settled, COALESCE(SUM(amount), 0) AS cash,
            COALESCE(SUM(tds_amount), 0) AS tds
       FROM travel_vendor_payments WHERE vendor_invoice_id = $1`,
    [id]
  );
  return { invoice, settled: Number(sum.settled), cash: Number(sum.cash), tds: Number(sum.tds) };
}

/** What the invoice owes after its credit notes, for the overpayment figure. */
async function vendorInvoiceView(id) {
  const { rows: [row] } = await query('SELECT * FROM v_travel_vendor_invoices WHERE id = $1', [id]);
  return row;
}

/**
 * The reply every vendor payment route sends: the invoice as the screens
 * read it, plus what the ledger now settles.
 *
 * `over_payable` is the figure a warning would quote. Paying more than the
 * bill is allowed — an advance, a rounding, a currency difference — so the
 * number is reported rather than refused, and nothing here clamps it.
 */
function vendorPaymentReply(row, settled) {
  const payable = row?.net_payable === null || row?.net_payable === undefined ? null : Number(row.net_payable);
  return {
    data: row,
    meta: {
      settled,
      net_payable: payable,
      over_payable: payable === null ? null : Math.max(settled - payable, 0),
    },
  };
}

/**
 * Record what a travel agency has been paid (#85, re-made as a ledger in #214).
 *
 * ## Who
 *
 * The travel desk and an administrator. Until #214 this route was open to
 * every signed-in role, so a sales user could pay an agency — not a decision
 * anybody took, just the consequence of an open gate. Paying the agency is
 * the travel desk's work, so HR and admin keep it and sales is refused here,
 * in the handler, because the policy's three levels cannot say "admin and HR
 * but not sales" on their own.
 *
 * ## What the figure means
 *
 * `amount_paid` is still the **absolute total settled**, which is what both
 * existing callers send: the Pay dialog adds what is already paid before
 * posting, and the ⌘K command asks for the total. So the row written here is
 * the difference, and `mode: 'add'` is available for a caller that would
 * rather send the transfer itself — the same switch, with the same default,
 * as the stage receipt route.
 *
 * Settlement is `amount + tds_amount`: tax deducted at source settles the
 * bill without the money reaching the agency, so a 100,000 bill paid by a
 * 90,000 transfer with 10,000 deducted is paid in full, and 90,000 is what
 * left the bank.
 *
 * ## What it refuses
 *
 * A total *lower* than the ledger already settles. That is a correction, and
 * corrections are an administrator's with a reason recorded (/pay/correct).
 * Letting this route quietly write the negative row instead would hand HR the
 * correction it is not supposed to have, with no reason and under the wrong
 * audit action — so the refusal names the route to use instead.
 */
vendorInvoiceRouter.post('/:id/pay', requireRole('admin', 'hr'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Vendor invoice not found');
  const body = parse(vendorPaySchema, req.body || {});
  const id = Number(req.params.id);
  const tds = Number(body.tds_amount || 0);

  const settledAfter = await transaction(async (client) => {
    const { invoice, settled } = await lockVendorInvoice(client, id);
    const delta = body.mode === 'set' ? Number(body.amount_paid) - settled : Number(body.amount_paid);

    // Asking for the total it already is, with nothing else to record: the
    // honest answer is that there is nothing to do. Writing a zero row would
    // put a payment in the history that never happened.
    if (delta === 0 && tds === 0) return settled;

    if (delta < 0) {
      throw new ApiError(422, `This invoice has already been paid ${settled}. Lowering that is a correction: use POST /api/vendor-invoices/${id}/pay/correct, which records who did it and why.`);
    }
    if (tds > delta) {
      throw new ApiError(422, 'Please check the highlighted fields', {
        fields: { tds_amount: `The tax deducted cannot be more than the ${delta} this payment settles` },
      });
    }
    // delta === 0 with TDS would mean moving the cash and TDS legs against
    // each other without changing the total, which is a re-statement of a
    // payment already recorded rather than a new one.
    if (delta === 0) {
      throw new ApiError(422, `This invoice already settles ${settled}. Changing how that splits between cash and tax deducted is a correction: use POST /api/vendor-invoices/${id}/pay/correct.`);
    }

    const { rows: [payment] } = await client.query(
      `INSERT INTO travel_vendor_payments
         (vendor_invoice_id, amount, tds_amount, paid_on, mode, reference, document_id, remarks, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, amount, tds_amount, paid_on, mode`,
      [id, delta - tds, tds, body.payment_date ?? null, body.payment_mode || 'bank_transfer',
        body.reference ?? null, body.document_id ?? null, body.remarks ?? null, req.user?.username || null]
    );

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.VENDOR_INVOICE_PAID,
      entityType: 'vendor_invoice',
      entityId: invoice.vendor_invoice_id ?? String(invoice.id),
      metadata: {
        payment_id: payment.id,
        amount: Number(payment.amount),
        tds_amount: Number(payment.tds_amount),
        paid_on: payment.paid_on,
        mode: payment.mode,
        reference: body.reference ?? null,
        has_proof: Boolean(body.document_id),
        // The figures the old audit row carried, so the trail reads the same
        // way either side of this change.
        amount_paid_before: settled,
        amount_paid_after: settled + delta,
      },
    });
    return settled + delta;
  });

  res.json(vendorPaymentReply(await vendorInvoiceView(id), settledAfter));
});

/**
 * Take a vendor payment back off the invoice, or put its split right (#214).
 *
 * The administrator's, as the expense-claim correction is and for the same
 * reason: this is the one route that can move a figure already booked
 * against a bill *down*. The travel desk may pay an agency; deciding that a
 * payment it recorded was wrong is a different act, and it is recorded as
 * one — a row of its own, a reason that cannot be left out, and the account
 * that made it.
 *
 * Nothing historical is touched. The original row and the bank advice
 * attached to it stay exactly as they were: the ledger is appended to, so
 * what the invoice settles changes while the record of what was actually
 * sent does not.
 *
 * Either leg may move, and they may move in opposite directions — correcting
 * a 90,000 + 10,000 payment to 92,000 + 8,000 is `amount: 2000,
 * tds_amount: -2000`, which leaves the total alone and puts the split right.
 */
vendorInvoiceRouter.post('/:id/pay/correct', requireAdmin, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Vendor invoice not found');
  const body = parse(vendorCorrectSchema, req.body || {});
  const id = Number(req.params.id);
  const amount = Number(body.amount || 0);
  const tds = Number(body.tds_amount || 0);

  if (amount === 0 && tds === 0) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: { amount: 'Give the amount, the tax deducted, or both to correct' },
    });
  }

  const settledAfter = await transaction(async (client) => {
    const { invoice, settled, cash, tds: tdsSoFar } = await lockVendorInvoice(client, id);

    const { rows: [correction] } = await client.query(
      `INSERT INTO travel_vendor_payments
         (vendor_invoice_id, amount, tds_amount, paid_on, mode, reference, document_id, correction_reason, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, amount, tds_amount, paid_on`,
      [id, amount, tds, body.paid_on ?? null, body.payment_mode || 'other',
        body.reference ?? null, body.document_id ?? null, body.reason, req.user?.username || null]
    );

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.VENDOR_INVOICE_PAY_CORRECTED,
      entityType: 'vendor_invoice',
      entityId: invoice.vendor_invoice_id ?? String(invoice.id),
      metadata: {
        payment_id: correction.id,
        reason: body.reason,
        amount: Number(correction.amount),
        tds_amount: Number(correction.tds_amount),
        paid_on: correction.paid_on,
        settled_before: settled,
        settled_after: settled + amount + tds,
        cash_before: cash,
        cash_after: cash + amount,
        tds_before: tdsSoFar,
        tds_after: tdsSoFar + tds,
        // Greppable, as the expense-claim correction's own flag is: this is
        // the case where a figure the business had booked goes down.
        lowers_recorded_total: amount + tds < 0,
      },
    });
    return settled + amount + tds;
  });

  res.json(vendorPaymentReply(await vendorInvoiceView(id), settledAfter));
});

// ---------------------------------------------------------------------
// One transfer, several agency bills (#214 §2.6)
// ---------------------------------------------------------------------

/**
 * How many bills one transfer may settle in one request.
 *
 * The agency is usually paid monthly, so a month's bills from one agency is
 * the real shape of this: tens, not thousands. The repo has no batch limit
 * to copy — this is its first batch write — so the figure is chosen rather
 * than inherited, and chosen to be the largest number a person could
 * plausibly have checked by eye before pressing the button. Past that, the
 * honest answer is that the allocations were not reviewed, and a second
 * transfer is the right way to record them.
 *
 * It is also what bounds the work this route does: every allocation takes a
 * row lock and an insert inside one transaction, and an unbounded array
 * would hold locks on every bill a vendor has ever raised.
 *
 * The dialog enforces the same number, from the same constant on the web
 * side, so the limit is a message before the request rather than after it.
 */
export const MAX_BATCH_ALLOCATIONS = 50;

/**
 * The body of a bulk transfer.
 *
 * ## The figures, and how they differ from /pay
 *
 * An allocation's `amount` is **the cash that left the bank for that bill**
 * and `tds_amount` is what was deducted, which is exactly what the two
 * ledger columns hold. Settlement is their sum, as everywhere else.
 *
 * `POST /api/vendor-invoices/:id/pay` is the odd one out, and deliberately
 * so: its `amount_paid` is the absolute *settlement total* because that is
 * what its callers were already sending before #214 made payments a ledger,
 * and changing the meaning of a field under existing callers is how figures
 * get counted twice. A new route has no such history, so it takes the two
 * things a person actually knows and adds them itself. The Pay dialog has
 * always asked for those same two things and converted; the bulk dialog
 * sends them as they are.
 *
 * Nothing here may be negative. Taking money back off a bill is a
 * correction, corrections are an administrator's with a reason recorded, and
 * there is no bulk correction (#214 §8) — so a batch cannot become one by
 * carrying a negative allocation.
 */
const vendorBatchSchema = z.object({
  // Shared by every row the transfer writes: one bank transfer, one date,
  // one method, one UTR, one advice.
  payment_date: dateStr,
  payment_mode: z.preprocess(blank, z.enum(VENDOR_PAYMENT_MODES).optional()),
  reference: z.preprocess(blank, z.string().trim().max(120).nullable().optional()),
  document_id: z.preprocess(blank, z.coerce.number().int().positive().optional()),
  remarks: z.preprocess(blank, z.string().trim().max(1000).nullable().optional()),
  allocations: z.array(z.object({
    // The invoice's row id, as POST /vendor-invoices/:id/pay takes it and as
    // travel_vendor_payments.vendor_invoice_id stores it. The agency's own
    // printed number is not unique across agencies and is not an id.
    vendor_invoice_id: z.preprocess(toNumber, z.number({ error: 'Which bill this settles' }).int().positive()),
    amount: money,
    tds_amount: money,
  }))
    .min(1, 'Choose at least one bill for this transfer to settle')
    .max(MAX_BATCH_ALLOCATIONS, `One transfer may settle at most ${MAX_BATCH_ALLOCATIONS} bills. Record the rest as a second transfer.`),
}).superRefine((v, ctx) => {
  notFuture('payment_date')(v.payment_date, ctx);
  const seen = new Set();
  v.allocations.forEach((a, i) => {
    if (seen.has(a.vendor_invoice_id)) {
      ctx.addIssue({ code: 'custom', message: 'This bill is in the transfer twice', path: ['allocations', i, 'vendor_invoice_id'] });
    }
    seen.add(a.vendor_invoice_id);
    // A row that settles nothing is not an allocation. Writing it would put
    // a payment that never happened on the bill's history.
    if (Number(a.amount || 0) + Number(a.tds_amount || 0) <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Give what was transferred to this bill, or the tax deducted',
        path: ['allocations', i, 'amount'],
      });
    }
  });
});

/**
 * Settle several of one agency's bills with one transfer (#214 §2.6).
 *
 * An agency is paid monthly: one transfer, one UTR, one bank advice, and a
 * dozen bills closed by it. Recorded one bill at a time that becomes a dozen
 * payments that only look related, each needing the reference typed again.
 * So the transfer is the request, and the allocations are what it settles.
 *
 * ## Still one ledger row per bill
 *
 * Nothing new is stored. Each allocation becomes an ordinary
 * `travel_vendor_payments` row on its own invoice, carrying the transfer's
 * shared date, method, reference and advice, and the trigger brings each
 * invoice's `amount_paid` and `payment_date` cache along with it. Every
 * reader of those columns — Payables, the ageing, the travel dashboard, the
 * per-trip agency status — sees a batch exactly as it sees a dozen separate
 * payments, because that is what it is.
 *
 * There is no batch row and no batch id. The shared reference is what ties
 * the rows together for a person reading the history, and it is the thing
 * the bank statement will also say.
 *
 * ## One agency, proved here
 *
 * Every bill in the request must belong to the same `vendor_id`. The dialog
 * stops a mixed selection being made, but a request is not a dialog: the
 * rule is checked against the locked rows, before a single insert, because
 * a transfer that paid two agencies at once would be a reference that
 * reconciles against nothing and an overpayment nobody can trace.
 *
 * ## All of it or none of it
 *
 * One transaction, and every invoice locked before any figure is validated.
 * A bad allocation anywhere — a bill that does not exist, another agency's,
 * a negative figure, a date in the future — throws, and the transaction
 * takes back the rows already inserted along with the cache updates their
 * triggers made. There is no partial batch to explain to anybody.
 *
 * ## Overpayment
 *
 * Allowed, per bill, and never clamped — an advance, a rounding, a currency
 * difference. It is computed against what the ledger settles *under the
 * lock*, so a single payment landing on one of these bills at the same
 * moment cannot leave the figure stale, and reported back per allocation so
 * the screen can say which bills went past their payable amount.
 */
vendorPaymentRouter.post('/batch', requireRole('admin', 'hr'), async (req, res) => {
  const body = parse(vendorBatchSchema, req.body || {});
  // Ascending, so two batches that overlap take their locks in the same
  // order and wait for each other instead of deadlocking. `ORDER BY id`
  // below says the same thing to the planner; this says it to the array.
  const ids = [...new Set(body.allocations.map((a) => a.vendor_invoice_id))].sort((a, b) => a - b);

  const settled = await transaction(async (client) => {
    // The lock comes first and covers every bill in the request. Nothing is
    // validated against a figure that another request could still be moving.
    const { rows: locked } = await client.query(
      `SELECT id, vendor_invoice_id, vendor_id
         FROM travel_vendor_invoices
        WHERE id = ANY($1::int[])
        ORDER BY id
          FOR UPDATE`,
      [ids]
    );

    const found = new Map(locked.map((row) => [row.id, row]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) {
      throw new ApiError(404, `No vendor invoice with id ${missing.join(', ')}. Nothing has been recorded.`);
    }

    const vendors = [...new Set(locked.map((row) => row.vendor_id))];
    if (vendors.length > 1) {
      const { rows: names } = await client.query(
        'SELECT id, name FROM travel_vendors WHERE id = ANY($1::int[]) ORDER BY name',
        [vendors]
      );
      const listed = names.map((v) => v.name).filter(Boolean).join(' and ');
      throw new ApiError(422, `One transfer settles one agency's bills. These belong to ${listed || `${vendors.length} different agencies`} — record a transfer for each. Nothing has been recorded.`);
    }

    // Read through the view, under the lock, so `net_payable` already has the
    // credit notes in it and the overpayment figure is the one the screens
    // will show.
    const before = new Map((await client.query(
      `SELECT id, vendor_invoice_id, vendor_invoice_no, travel_vendor, invoice_amount, net_payable, amount_paid
         FROM v_travel_vendor_invoices WHERE id = ANY($1::int[])`,
      [ids]
    )).rows.map((row) => [row.id, row]));

    const allocations = [];
    for (const [index, allocation] of body.allocations.entries()) {
      const invoice = found.get(allocation.vendor_invoice_id);
      const view = before.get(allocation.vendor_invoice_id);
      const amount = Number(allocation.amount || 0);
      const tds = Number(allocation.tds_amount || 0);
      const settles = amount + tds;
      // The ledger is the record; the cached column is derived from it. Both
      // agree under this lock, and the ledger is what is read.
      const settledBefore = Number((await client.query(
        'SELECT COALESCE(SUM(amount + tds_amount), 0) AS settled FROM travel_vendor_payments WHERE vendor_invoice_id = $1',
        [allocation.vendor_invoice_id]
      )).rows[0].settled);
      const payable = view?.net_payable === null || view?.net_payable === undefined ? null : Number(view.net_payable);

      const { rows: [payment] } = await client.query(
        `INSERT INTO travel_vendor_payments
           (vendor_invoice_id, amount, tds_amount, paid_on, mode, reference, document_id, remarks, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, amount, tds_amount, paid_on, mode`,
        [allocation.vendor_invoice_id, amount, tds, body.payment_date ?? null, body.payment_mode || 'bank_transfer',
          body.reference ?? null, body.document_id ?? null, body.remarks ?? null, req.user?.username || null]
      );

      // Per invoice, under the same action as a single payment, because for
      // the bill being paid that is exactly what happened. `batch` says the
      // transfer it was part of, so the dozen rows one UTR settled can be
      // read back together without a batch table to join.
      await logActivity(client, {
        actor: actorFrom(req.user),
        action: ACTIONS.VENDOR_INVOICE_PAID,
        entityType: 'vendor_invoice',
        entityId: invoice.vendor_invoice_id ?? String(invoice.id),
        metadata: {
          payment_id: payment.id,
          amount: Number(payment.amount),
          tds_amount: Number(payment.tds_amount),
          settles,
          paid_on: payment.paid_on,
          mode: payment.mode,
          reference: body.reference ?? null,
          // The file itself is never logged, only that there is one.
          has_proof: Boolean(body.document_id),
          amount_paid_before: settledBefore,
          amount_paid_after: settledBefore + settles,
          batch: { size: body.allocations.length, index, reference: body.reference ?? null },
        },
      });

      allocations.push({
        vendor_invoice_id: invoice.id,
        invoice_ref: invoice.vendor_invoice_id,
        vendor_invoice_no: view?.vendor_invoice_no ?? null,
        payment_id: payment.id,
        amount,
        tds_amount: tds,
        settles,
        settled_before: settledBefore,
        settled_after: settledBefore + settles,
        net_payable: payable,
        // Allowed and reported, never refused and never clamped — the same
        // figure `/pay` returns, per bill.
        over_payable: payable === null ? null : Math.max(settledBefore + settles - payable, 0),
      });
    }

    // After the inserts, so each invoice reads as the screens will read it:
    // the trigger has already brought amount_paid and payment_date along.
    const { rows: invoices } = await client.query(
      'SELECT * FROM v_travel_vendor_invoices WHERE id = ANY($1::int[]) ORDER BY id',
      [ids]
    );

    return { vendorId: vendors[0], allocations, invoices };
  });

  const totals = settled.allocations.reduce(
    (sum, a) => ({
      transferred: sum.transferred + a.amount,
      tds: sum.tds + a.tds_amount,
      settled: sum.settled + a.settles,
      overpaid: sum.overpaid + (Number(a.over_payable) > 0 ? 1 : 0),
      over_payable: sum.over_payable + Math.max(Number(a.over_payable) || 0, 0),
    }),
    { transferred: 0, tds: 0, settled: 0, overpaid: 0, over_payable: 0 }
  );

  res.json({
    data: {
      vendor_id: settled.vendorId,
      vendor: settled.invoices[0]?.travel_vendor ?? null,
      payment_date: body.payment_date ?? null,
      payment_mode: body.payment_mode || 'bank_transfer',
      reference: body.reference ?? null,
      document_id: body.document_id ?? null,
      allocations: settled.allocations,
      invoices: settled.invoices,
    },
    // What the success line quotes. Worked out here, from the rows actually
    // written, so the screen never recomputes a financial total of its own.
    meta: { count: settled.allocations.length, ...totals },
  });
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
// Which client invoice billed a trip (#214)
//
// `billed_stage_id` says that this trip's cost was recovered from the client
// on that payment stage's invoice. It used to be an ordinary column on the
// travel-log resource, so it could be set by anyone allowed to edit a trip —
// HR included, which runs the travel desk and has full write access there
// (#196 §3). The Trip screen hid the selector from HR, and that hiding was
// the whole of the restriction: the API accepted a PATCH naming the field
// from any signed-in caller.
//
// Hence this route. `protectedFields` on the resource closes the generic
// door; this is the one that is open, and the policy keeps it to the roles
// that own the PO side of a trip. HR is not one of them: the route is absent
// from HR_ROUTES, so hrGate answers 403 before the handler is reached.
//
// What it deliberately does not do yet: check that the stage belongs to the
// trip's own PO, project or client. The database's rule — only a chargeable
// trip may name a billing stage — is unchanged, and the rest of that
// validation belongs with the travel-invoice work this is a prerequisite for.
// This change is about who may write the link, not what the link may say.
// ---------------------------------------------------------------------

const billedStageSchema = z.object({
  // Null clears it: a trip marked as billed on the wrong invoice has to be
  // able to stop being marked at all, which the Trip screen's "Not billed
  // yet" option has always done.
  billed_stage_id: z.union([z.number().int().positive(), z.null()]),
});

travelRouter.post('/:travelId/billed-stage', async (req, res) => {
  const travelId = decodeURIComponent(req.params.travelId);
  const body = parse(billedStageSchema, req.body || {});

  const after = await transaction(async (client) => {
    const { rows: [before] } = await client.query(
      'SELECT id, travel_id, billed_stage_id FROM travel_logs WHERE travel_id = $1 FOR UPDATE',
      [travelId]
    );
    if (!before) throw new ApiError(404, 'Trip not found');

    // The trigger travel_log_rules() refuses a billing stage on a trip that
    // is not chargeable, and the foreign key refuses a stage that is not
    // there; both answer through the ordinary error translation.
    const { rows: [row] } = await client.query(
      'UPDATE travel_logs SET billed_stage_id = $1 WHERE id = $2 RETURNING id, billed_stage_id',
      [body.billed_stage_id, before.id]
    );

    await logActivity(client, {
      actor: actorFrom(req.user),
      action: ACTIONS.TRIP_BILLED_STAGE_SET,
      entityType: 'travel_log',
      entityId: before.travel_id,
      metadata: {
        billed_stage_id_before: before.billed_stage_id,
        billed_stage_id_after: row.billed_stage_id,
      },
    });
    return row;
  });

  const { rows: [trip] } = await query('SELECT * FROM v_travel_logs WHERE id = $1', [after.id]);
  res.json({ data: trip });
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
  // The agency's payment history, for the roles that settle the agency
  // (#214). This route is open to sales as the invoice itself is, so the
  // ledger is gated here rather than by the route: how the business paid a
  // vendor — the UTR, the method, the bank advice, any correction — is the
  // travel desk's and the administrator's, and a sales user reading the
  // invoice has no business in it. Scoped to this one invoice; there is no
  // route that lists the ledger across invoices.
  const maySeePayments = ['admin', 'hr'].includes(req.user?.role);
  const payments = maySeePayments
    ? (await query(
      `SELECT p.id, p.amount, p.tds_amount, p.amount + p.tds_amount AS settles, p.paid_on, p.mode,
              p.reference, p.remarks, p.correction_reason, p.recorded_by, p.created_at,
              p.document_id, d.file_name AS document_name
         FROM travel_vendor_payments p
         LEFT JOIN documents d ON d.id = p.document_id
        WHERE p.vendor_invoice_id = $1
        ORDER BY p.paid_on NULLS FIRST, p.id`,
      [id]
    )).rows
    : undefined;

  res.json({
    data: {
      invoice, lines: lines.rows, credit_notes: credits.rows, documents: files.rows,
      ...(payments ? { payments } : {}),
    },
  });
});
