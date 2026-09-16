/**
 * PO received → project in one step (#26):
 *
 *   POST /api/quotations/:key/register
 *     {
 *       project_id?             join an existing project instead of creating one
 *       project_manager?, project_manager_email?, planned_start_date?, planned_delivery_date?
 *       po_number, po_date?, po_value?, currency?, payment_terms_days?, document_id?
 *       payment_terms_template_id?   the schedule; blank = the default template
 *       onboarding_template_id?      the checklist; blank = the service's, else the default; 0 = none
 *     }
 *
 * One transaction: the quotation is marked won and linked, the project is
 * created or reused, the PO registered against the quotation, its service
 * lines taken from the quotation's lines (or its subject), the payment
 * stages built from the template, and the onboarding checklist added.
 */
import { Router } from 'express';
import { z } from 'zod';
import { transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { lockAttachableDocument } from '../lib/documents.js';
import { claimNextId } from '../lib/sequences.js';

export const registerRouter = Router();

const blank = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const dateStr = z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional());
const optStr = (max) => z.preprocess(blank, z.string().trim().max(max).optional());
const optInt = z.preprocess(blank, z.coerce.number().int().optional());

const schema = z.object({
  project_id: optStr(40),
  project_manager: optStr(120),
  project_manager_email: optStr(160),
  planned_start_date: dateStr,
  planned_delivery_date: dateStr,
  po_number: z.preprocess(blank, z.string({ required_error: 'PO number is required' }).trim().min(1, 'PO number is required').max(60)),
  po_date: dateStr,
  po_value: z.preprocess(blank, z.coerce.number().min(0).optional()),
  currency: optStr(3),
  payment_terms_days: z.preprocess(blank, z.coerce.number().int().min(0).max(365).optional()),
  document_id: optInt,
  payment_terms_template_id: optInt,
  onboarding_template_id: optInt,
});

registerRouter.post('/:key/register', async (req, res) => {
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])) });
  }
  const b = parsed.data;

  const data = await transaction(async (client) => {
    const key = decodeURIComponent(req.params.key);
    const { rows: qrows } = await client.query(
      'SELECT * FROM quotations WHERE quotation_no = $1 OR (id::text = $1 AND NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_no = $1)) FOR UPDATE', [key]);
    if (!qrows.length) throw new ApiError(404, 'Quotation not found');
    const q = qrows[0];

    if ((await client.query('SELECT 1 FROM purchase_orders WHERE po_number = $1', [b.po_number])).rowCount) {
      throw new ApiError(422, 'Please check the highlighted fields', { fields: { po_number: `PO ${b.po_number} is already registered` } });
    }

    // ---- project: reuse, or the quotation's own, or a new one
    let projectId = b.project_id || q.project_id || null;
    let projectCreated = false;
    if (projectId) {
      const { rows } = await client.query('SELECT project_id, company_id FROM projects WHERE project_id = $1', [projectId]);
      if (!rows.length) throw new ApiError(422, 'Please check the highlighted fields', { fields: { project_id: 'No such project' } });
      if (rows[0].company_id && q.company_id && rows[0].company_id !== q.company_id) {
        throw new ApiError(422, 'Please check the highlighted fields', { fields: { project_id: 'That project belongs to a different client' } });
      }
    } else {
      projectId = await claimNextId('project', client);
      await client.query(
        `INSERT INTO projects (project_id, client_name, primary_service, project_manager, project_manager_email, sales_person,
                               planned_start_date, planned_delivery_date, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, q.client_name, q.service_quoted, b.project_manager ?? null, b.project_manager_email ?? null, q.sales_person,
         b.planned_start_date ?? null, b.planned_delivery_date ?? null, `Won from quotation ${q.quotation_no}`]
      );
      projectCreated = true;
    }

    // ---- the quotation is won
    await client.query(`UPDATE quotations SET project_id = $1, po_received = true, status = 'Won - PO Received' WHERE id = $2`, [projectId, q.id]);

    // ---- the PO, named after its quotation
    if (b.document_id !== undefined && !(await lockAttachableDocument(client, b.document_id))) {
      throw new ApiError(422, 'Please check the highlighted fields', { fields: { document_id: 'That upload has expired or is already in use — choose the file again' } });
    }
    const poValue = b.po_value ?? q.total ?? q.quotation_value ?? 0;
    const currency = b.currency || q.currency || 'INR';
    const terms = b.payment_terms_days ?? 30;
    const { rows: [po] } = await client.query(
      `INSERT INTO purchase_orders (po_number, project_id, quotation_no, po_date, po_value, currency, payment_terms_days, document_id, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.po_number, projectId, q.quotation_no, b.po_date ?? null, poValue, currency, terms, b.document_id ?? null, `Registered from quotation ${q.quotation_no}`]
    );

    // ---- service lines: the quotation's lines, else its subject at the PO value
    const { rows: lines } = await client.query('SELECT description, amount FROM quotation_lines WHERE quotation_id = $1 ORDER BY sort_order, id', [q.id]);
    const lineSum = lines.reduce((n, l) => n + Number(l.amount), 0);
    if (lines.length) {
      // Scale the lines to the PO value (the PO may carry GST or a negotiated figure).
      const factor = lineSum > 0 ? Number(poValue) / lineSum : 1;
      for (const l of lines) {
        await client.query('INSERT INTO po_services (po_number, service, service_value) VALUES ($1,$2,$3)', [po.po_number, l.description, Math.round(Number(l.amount) * factor * 100) / 100]);
      }
    } else {
      await client.query('INSERT INTO po_services (po_number, service, service_value) VALUES ($1,$2,$3)', [po.po_number, q.service_quoted || 'Services as quoted', poValue]);
    }

    // ---- payment stages from the template
    let template = null;
    if (b.payment_terms_template_id) {
      ({ rows: [template] } = await client.query('SELECT * FROM payment_terms_templates WHERE id = $1 AND active', [b.payment_terms_template_id]));
      if (!template) throw new ApiError(422, 'Please check the highlighted fields', { fields: { payment_terms_template_id: 'No such template' } });
    } else {
      ({ rows: [template] } = await client.query(
        `SELECT t.* FROM payment_terms_templates t
          WHERE t.active AND (t.id = (SELECT payment_terms_template_id FROM services WHERE name = $1) OR t.is_default)
          ORDER BY (t.id = (SELECT payment_terms_template_id FROM services WHERE name = $1)) DESC, t.is_default DESC LIMIT 1`, [q.service_quoted]));
    }
    const stages = [];
    if (template) {
      const { rows: tl } = await client.query('SELECT * FROM payment_terms_template_lines WHERE template_id = $1 ORDER BY sort_order, id', [template.id]);
      const total = tl.reduce((n, l) => n + Number(l.percent), 0);
      if (Math.abs(total - 100) > 0.01) throw new ApiError(422, `Template "${template.name}" adds up to ${total}%, not 100%`);
      for (const [i, l] of tl.entries()) {
        const { rows: [s] } = await client.query(
          `INSERT INTO payment_stages (po_number, stage_no, stage_name, trigger_event, stage_percent, credit_days, milestone_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, stage_no, stage_name, stage_percent`,
          [po.po_number, i + 1, l.stage_name, l.trigger_event, Number(l.percent) / 100, l.credit_days ?? null, l.milestone_name ?? null]);
        stages.push(s);
      }
    }

    // ---- onboarding checklist from the template
    let checklist = 0;
    if (b.onboarding_template_id !== 0) {
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

    return { quotation_no: q.quotation_no, project_id: projectId, project_created: projectCreated, po_number: po.po_number, po_value: poValue, currency, stages, service_lines: lines.length || 1, checklist_steps: checklist, template: template?.name || null };
  });

  res.status(201).json({ data });
});
