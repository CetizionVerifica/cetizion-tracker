/**
 * Companies beyond plain CRUD (#20):
 *
 *   GET  /api/companies/duplicates      pairs that look like one client spelt twice
 *   GET  /api/companies/:id/full        the company with its contacts and records
 *   POST /api/companies/:id/merge       { into } fold this company into another
 *                                       — admin only, see below
 *
 * Mounted ahead of the generic router so the two-segment paths win.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, actorFrom, logActivity } from '../lib/activity.js';
import { similarName } from '../lib/names.ts';

export const companyRouter = Router();

/** Look-alike pairs, most similar first. A suggestion only; merging is a person's call. */
companyRouter.get('/duplicates', async (req, res) => {
  const { rows } = await query('SELECT id, name, sector, quotations, projects, enquiries FROM v_companies ORDER BY name');
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (similarName(rows[i].name, rows[j].name)) pairs.push({ a: rows[i], b: rows[j] });
    }
  }
  // The one with more records is the natural survivor; offer it first.
  const weight = (c) => c.quotations + c.projects + c.enquiries;
  for (const p of pairs) if (weight(p.b) > weight(p.a)) [p.a, p.b] = [p.b, p.a];
  res.json({ data: pairs });
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
  const actor = actorFrom(req.user);
  const source = Number(req.params.id);
  const parsed = mergeSchema.safeParse(req.body || {});
  if (!Number.isInteger(source) || !parsed.success) throw new ApiError(422, 'Pick the company to merge into');
  const target = parsed.data.into;
  if (target === source) throw new ApiError(422, 'A company cannot be merged into itself');

  const result = await transaction(async (client) => {
    const { rows: [a] } = await client.query('SELECT id, name FROM companies WHERE id = $1 FOR UPDATE', [source]);
    const { rows: [b] } = await client.query('SELECT id, name FROM companies WHERE id = $1 FOR UPDATE', [target]);
    if (!a || !b) throw new ApiError(404, 'Company not found');

    // Contacts that exist on both sides: point records at the survivor's copy, then drop the duplicate.
    await client.query(
      `UPDATE quotations q SET contact_id = t.id
         FROM contacts s JOIN contacts t
           ON t.company_id = $2 AND name_key(t.name) = name_key(s.name)
        WHERE s.company_id = $1 AND q.contact_id = s.id`, [source, target]);
    await client.query(
      `UPDATE enquiries e SET contact_id = t.id
         FROM contacts s JOIN contacts t
           ON t.company_id = $2 AND name_key(t.name) = name_key(s.name)
        WHERE s.company_id = $1 AND e.contact_id = s.id`, [source, target]);
    await client.query(
      `DELETE FROM contacts s WHERE s.company_id = $1
          AND EXISTS (SELECT 1 FROM contacts t WHERE t.company_id = $2 AND name_key(t.name) = name_key(s.name))`, [source, target]);
    await client.query('UPDATE contacts SET company_id = $2 WHERE company_id = $1', [source, target]);

    // Records move and take the survivor's spelling; the link trigger sees the new name and keeps the link.
    const counts = {};
    for (const table of ['quotations', 'enquiries', 'projects']) {
      const { rowCount } = await client.query(`UPDATE ${table} SET company_id = $2, client_name = $3 WHERE company_id = $1`, [source, target, b.name]);
      counts[table] = rowCount;
    }
    await client.query('DELETE FROM companies WHERE id = $1', [source]);

    // In the same transaction as the merge. This is the most destructive
    // thing the API does and the source company is gone at the end of it,
    // so the only remaining answer to "where did this client go?" is this
    // row — it had better not be able to go missing on its own.
    //
    // Filed against the surviving company, because that is the one somebody
    // can still look up; the company that was folded in survives only as
    // its id and name in the metadata.
    await logActivity(client, {
      actor,
      action: ACTIONS.COMPANY_MERGED,
      entityType: 'company',
      entityId: b.id,
      metadata: {
        source_company_id: a.id,
        source_company_name: a.name,
        target_company_id: b.id,
        target_company_name: b.name,
        moved: counts,
      },
    });

    return { merged: a.name, into: b.name, moved: counts };
  });
  res.json({ data: result });
});
