/**
 * Companies beyond plain CRUD (#20):
 *
 *   GET  /api/companies/duplicates      groups that look like one client spelt twice
 *   GET  /api/companies/:id/full        the company with its contacts and records
 *   POST /api/companies/:id/merge       { into } fold this company into another
 *                                       — admin only, see below
 *
 * Mounted ahead of the generic router so the two-segment paths win.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { actorFrom } from '../lib/activity.js';
import { duplicateCompanies, mergeCompanies } from '../lib/companies.js';

export const companyRouter = Router();

/**
 * Groups of companies that look like one client spelt more than once.
 * A suggestion only; merging is a person's call, and the grouping is
 * deliberately not a claim that every member is the same company.
 */
companyRouter.get('/duplicates', async (req, res) => {
  res.json({ data: await duplicateCompanies() });
});

companyRouter.get('/:id/full', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ApiError(404, 'Company not found');
  const { rows: [company] } = await query('SELECT * FROM v_companies WHERE id = $1', [id]);
  if (!company) throw new ApiError(404, 'Company not found');
  const [contacts, enquiries, quotations, projects, pos] = await Promise.all([
    query('SELECT * FROM contacts WHERE company_id = $1 ORDER BY is_billing DESC, name', [id]),
    query('SELECT * FROM enquiries WHERE company_id = $1 ORDER BY enquiry_date DESC NULLS LAST, id DESC', [id]),
    query('SELECT * FROM v_quotations WHERE company_id = $1 ORDER BY quotation_date DESC NULLS LAST, id DESC', [id]),
    query('SELECT * FROM v_projects WHERE company_id = $1 ORDER BY project_id DESC', [id]),
    query('SELECT * FROM v_purchase_orders WHERE company_id = $1 ORDER BY po_date DESC NULLS LAST, id DESC', [id]),
  ]);
  res.json({ data: { ...company, contacts: contacts.rows, enquiries: enquiries.rows, quotations: quotations.rows, projects: projects.rows, purchase_orders: pos.rows } });
});

const mergeSchema = z.object({ into: z.coerce.number().int().positive() });

/**
 * Fold one company into another: every record and contact moves across and
 * takes the surviving company's name; a contact that exists on both sides
 * is kept once. The merged company is deleted. One transaction.
 *
 * Admin only. This is the most destructive thing the API does: it rewrites
 * the client name on every quotation, enquiry and project belonging to one
 * company, drops the duplicate contacts, and deletes a company row — with
 * no undo, and consequences across records the caller never sees. The
 * /duplicates suggestion above stays open to everybody, because spotting a
 * duplicate is useful and costs nothing; acting on one is the admin's.
 */
companyRouter.post('/:id/merge', requireAdmin, async (req, res) => {
  const source = Number(req.params.id);
  const parsed = mergeSchema.safeParse(req.body || {});
  if (!Number.isInteger(source) || !parsed.success) throw new ApiError(422, 'Pick the company to merge into');
  res.json({ data: await mergeCompanies({ source, target: parsed.data.into, actor: actorFrom(req.user) }) });
});

