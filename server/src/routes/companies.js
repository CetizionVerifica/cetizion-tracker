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
// Ownership is still read here, and only here in this file: the company and
// its contacts are shared master data, but the enquiries, quotations,
// projects and purchase orders listed beneath it are the same rows the
// direct endpoints serve, so they carry the same restriction (#18 Phase 2C).
import { ownerClause, purchaseOrderClause, scopeOf } from '../auth/ownership.js';
// Finding look-alikes and folding two companies together moved into
// lib/companies.js (#139) so MCP can offer the same two things. similarName,
// the merge transaction and its COMPANY_MERGED activity row all live in
// there now, which is why this file no longer imports them.
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
  // The company itself stays readable to anyone signed in — a client's name
  // and sector are not one salesperson's secret. What hangs off it is: the
  // lists below are the same rows the direct endpoints serve, so they carry
  // the same restriction (#18 Phase 2C). Scoping /api/quotations while this
  // response handed the same rows over would be scoping nothing.
  const scope = scopeOf(req);
  // A fresh params array per statement, each starting with the company id.
  const mine = (build, alias) => {
    const params = [id];
    const clause = build(scope, params, { alias });
    return { and: clause ? `AND ${clause}` : '', params };
  };
  const e = mine(ownerClause, 'e');
  const q = mine(ownerClause, 'q');
  const pr = mine(ownerClause, 'p');
  const po = mine(purchaseOrderClause, 'po');

  const [contacts, enquiries, quotations, projects, pos] = await Promise.all([
    query('SELECT * FROM contacts WHERE company_id = $1 ORDER BY is_billing DESC, name', [id]),
    query(`SELECT e.* FROM enquiries e WHERE e.company_id = $1 ${e.and}
            ORDER BY e.enquiry_date DESC NULLS LAST, e.id DESC`, e.params),
    query(`SELECT q.* FROM v_quotations q WHERE q.company_id = $1 ${q.and}
            ORDER BY q.quotation_date DESC NULLS LAST, q.id DESC`, q.params),
    query(`SELECT p.* FROM v_projects p WHERE p.company_id = $1 ${pr.and}
            ORDER BY p.project_id DESC`, pr.params),
    query(`SELECT po.* FROM v_purchase_orders po WHERE po.company_id = $1 ${po.and}
            ORDER BY po.po_date DESC NULLS LAST, po.id DESC`, po.params),
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

