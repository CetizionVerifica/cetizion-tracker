import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db.js';
import { claimAttachment, purgeAfterCommit } from '../lib/documents.js';
import { claimNextId } from '../lib/sequences.js';
import { ApiError } from '../middleware/error.js';
import { ONBOARDING_TEMPLATE } from '../lib/resources.js';
import { normalizeName } from '../lib/names.js';

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
const money = z.preprocess(toNumber, z.number({ invalid_type_error: 'Enter an amount' }).min(0).nullable().optional());
const requiredMoney = z.preprocess(
  toNumber,
  z.number({ required_error: 'Enter an amount', invalid_type_error: 'Enter an amount' }).min(0)
);

// ---------------------------------------------------------------------
// Project — everything about one project on a single screen
// ---------------------------------------------------------------------

projectRouter.get('/:projectId/full', async (req, res) => {
  const id = req.params.projectId;
  const project = await query('SELECT * FROM v_projects WHERE project_id = $1', [id]);
  if (!project.rows.length) throw new ApiError(404, 'Project not found');

  const [pos, services, stages, onboarding, travel, quotations] = await Promise.all([
    query('SELECT * FROM v_purchase_orders WHERE project_id = $1 ORDER BY po_date NULLS LAST, po_number', [id]),
    query(`SELECT s.* FROM po_services s
             JOIN purchase_orders p ON p.po_number = s.po_number
            WHERE p.project_id = $1 ORDER BY s.po_number, s.id`, [id]),
    query('SELECT * FROM v_payment_stages WHERE project_id = $1 ORDER BY po_number, stage_no', [id]),
    query('SELECT * FROM onboarding_tasks WHERE project_id = $1 ORDER BY step_no', [id]),
    query('SELECT * FROM v_travel_logs WHERE project_id = $1 ORDER BY travel_start_date NULLS LAST', [id]),
    query('SELECT * FROM v_quotations WHERE project_id = $1 ORDER BY quotation_date', [id]),
  ]);

  res.json({
    data: {
      project: project.rows[0],
      purchase_orders: pos.rows,
      services: services.rows,
      payment_stages: stages.rows,
      onboarding: onboarding.rows,
      travel: travel.rows,
      quotations: quotations.rows,
    },
  });
});

projectRouter.post('/:projectId/onboarding/apply-template', async (req, res) => {
  const id = req.params.projectId;
  const { owner = null, owner_email = null } = req.body || {};

  const rows = await transaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM projects WHERE project_id = $1', [id]);
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

  const data = await transaction(async (client) => {
    const { rows: qrows } = await client.query(
      // Locked, so two "Register" clicks on the same quotation cannot both create a project:
      // the second waits, then sees the project the first one linked.
      'SELECT * FROM quotations WHERE id = $1 OR quotation_no = $1::text FOR UPDATE',
      [req.params.id]
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
      const { rows: prows } = await client.query(
        'SELECT project_id, client_name FROM projects WHERE project_id = $1 FOR SHARE',
        [body.project_id]
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
      `INSERT INTO projects (project_id, client_name, primary_service, project_manager,
                             project_manager_email, sales_person, planned_start_date,
                             planned_delivery_date, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        projectId, quotation.client_name, quotation.service_quoted,
        body.project_manager, body.project_manager_email, quotation.sales_person,
        body.planned_start_date ?? null, body.planned_delivery_date ?? null,
        `Won from quotation ${quotation.quotation_no}`,
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
  const header = await query('SELECT * FROM v_purchase_orders WHERE po_number = $1', [po]);
  if (!header.rows.length) throw new ApiError(404, 'Purchase order not found');

  const [services, stages, travel] = await Promise.all([
    query('SELECT * FROM po_services WHERE po_number = $1 ORDER BY id', [po]),
    query('SELECT * FROM v_payment_stages WHERE po_number = $1 ORDER BY stage_no', [po]),
    query('SELECT * FROM v_travel_logs WHERE po_number = $1 ORDER BY travel_start_date NULLS LAST', [po]),
  ]);

  res.json({
    data: {
      purchase_order: header.rows[0],
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
        trigger_event: z.enum(['On PO Registration', 'On Delivery', 'Manual']),
        stage_percent: z.number().min(0.0001).max(1),
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
  if (Math.abs(total - 1) > 0.0001) {
    throw new ApiError(422, `Stages must add up to 100% — they currently total ${(total * 100).toFixed(1)}%`);
  }

  const { createdIds, removedDocuments } = await transaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM purchase_orders WHERE po_number = $1', [po]);
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

    const start = await client.query(
      'SELECT COALESCE(MAX(stage_no), 0) AS max FROM payment_stages WHERE po_number = $1',
      [po]
    );
    let n = Number(start.rows[0].max);
    const created = [];
    for (const stage of body.stages) {
      n += 1;
      const { rows: r } = await client.query(
        `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [po, n, stage.stage_name, stage.trigger_event, stage.stage_percent]
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

const invoiceSchema = z.object({
  invoice_no: z.preprocess(blank, z.string().trim().min(1, 'Invoice number is required').max(60)),
  invoice_date: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')),
  document_id: z.number().int().positive().nullable().optional(),
});

stageRouter.post('/:id/invoice', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) throw new ApiError(404, 'Payment stage not found');
  const body = parse(invoiceSchema, req.body || {});
  const { id, replaced } = await transaction(async (client) => {
    const { rows: [stage] } = await client.query(
      'SELECT id, document_id FROM payment_stages WHERE id = $1 FOR UPDATE',
      [Number(req.params.id)]
    );
    if (!stage) throw new ApiError(404, 'Payment stage not found');

    // No file chosen keeps the invoice document already attached; a new one replaces it.
    const { documentId, replaced } = await claimAttachment(client, {
      current: stage.document_id,
      requested: body.document_id,
    });
    await client.query(
      'UPDATE payment_stages SET invoice_no = $1, invoice_date = $2, document_id = $3 WHERE id = $4',
      [body.invoice_no, body.invoice_date, documentId, stage.id]
    );
    return { id: stage.id, replaced };
  });

  // The replaced file leaves Cloudinary only once the new one is committed.
  if (replaced) await purgeAfterCommit(replaced);

  const { rows: full } = await query('SELECT * FROM v_payment_stages WHERE id = $1', [id]);
  res.json({ data: full[0] });
});

const receiptSchema = z.object({
  amount_received: requiredMoney,
  payment_received_date: dateStr,
  mode: z.enum(['set', 'add']).optional().default('set'),
});

stageRouter.post('/:id/payment', async (req, res) => {
  const body = parse(receiptSchema, req.body || {});
  const { rows } = await query(
    `UPDATE payment_stages
        SET amount_received = CASE WHEN $3 = 'add'
                                   THEN amount_received + $1 ELSE $1 END,
            payment_received_date = COALESCE($2, payment_received_date)
      WHERE id = $4 RETURNING id`,
    [body.amount_received, body.payment_received_date ?? null, body.mode, req.params.id]
  );
  if (!rows.length) throw new ApiError(404, 'Payment stage not found');
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

vendorInvoiceRouter.post('/:id/pay', async (req, res) => {
  const body = parse(vendorPaySchema, req.body || {});
  const { rows } = await query(
    `UPDATE travel_vendor_invoices
        SET amount_paid = $1, payment_date = COALESCE($2, CURRENT_DATE)
      WHERE id = $3 RETURNING id`,
    [body.amount_paid, body.payment_date ?? null, req.params.id]
  );
  if (!rows.length) throw new ApiError(404, 'Vendor invoice not found');
  const { rows: full } = await query('SELECT * FROM v_travel_vendor_invoices WHERE id = $1', [rows[0].id]);
  res.json({ data: full[0] });
});

const claimDecisionSchema = z.object({
  approval_status: z.enum(['Submitted', 'Approved', 'Rejected', 'On Hold']),
  approved_by: z.preprocess(blank, z.string().trim().max(120).nullable().optional()),
});

claimRouter.post('/:id/decide', async (req, res) => {
  const body = parse(claimDecisionSchema, req.body || {});
  const { rows } = await query(
    `UPDATE employee_expense_claims
        SET approval_status = $1, approved_by = COALESCE($2, approved_by)
      WHERE id = $3 RETURNING id`,
    [body.approval_status, body.approved_by ?? null, req.params.id]
  );
  if (!rows.length) throw new ApiError(404, 'Claim not found');
  const { rows: full } = await query('SELECT * FROM v_employee_expense_claims WHERE id = $1', [rows[0].id]);
  res.json({ data: full[0] });
});

const reimburseSchema = z.object({
  amount_reimbursed: money,
  reimbursement_date: dateStr,
});

claimRouter.post('/:id/reimburse', async (req, res) => {
  const body = parse(reimburseSchema, req.body || {});
  const { rows } = await query(
    `UPDATE employee_expense_claims
        SET amount_reimbursed = COALESCE($1, amount_claimed),
            reimbursement_date = COALESCE($2, CURRENT_DATE)
      WHERE id = $3 AND approval_status = 'Approved'
      RETURNING id`,
    [body.amount_reimbursed ?? null, body.reimbursement_date ?? null, req.params.id]
  );
  if (!rows.length) {
    throw new ApiError(409, 'Claim not found, or it has not been approved yet');
  }
  const { rows: full } = await query('SELECT * FROM v_employee_expense_claims WHERE id = $1', [rows[0].id]);
  res.json({ data: full[0] });
});

// ---------------------------------------------------------------------
// Trip detail — the trip plus both cost sides
// ---------------------------------------------------------------------

travelRouter.get('/:travelId/full', async (req, res) => {
  const id = decodeURIComponent(req.params.travelId);
  const trip = await query('SELECT * FROM v_travel_logs WHERE travel_id = $1', [id]);
  if (!trip.rows.length) throw new ApiError(404, 'Trip not found');

  const [invoices, claims] = await Promise.all([
    query('SELECT * FROM v_travel_vendor_invoices WHERE travel_id = $1 ORDER BY id', [id]),
    query('SELECT * FROM v_employee_expense_claims WHERE travel_id = $1 ORDER BY id', [id]),
  ]);

  res.json({
    data: { trip: trip.rows[0], vendor_invoices: invoices.rows, expense_claims: claims.rows },
  });
});
