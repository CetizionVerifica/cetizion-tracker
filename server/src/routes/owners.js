/**
 * Owners written more than once, and folding them into one:
 *
 *   GET  /api/owners/duplicates   groups of Owner spellings that look like one person
 *   POST /api/owners/merge        { from: [spelling], into: spelling } — admin only
 *
 * The Owner is the free-text sales_person on enquiries, quotations and
 * projects, so there is no owner row to address by id; a merge names the
 * spellings themselves. The work is in lib/owners.js.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { ApiError } from '../middleware/error.js';
import { actorFrom } from '../lib/activity.js';
import { duplicateOwners, mergeOwners } from '../lib/owners.js';

export const ownerRouter = Router();

/**
 * Admin only, unlike the company suggestions: the groups count every
 * record each spelling carries across the whole book, which a sales user,
 * who sees only their own records, has no business reading.
 */
ownerRouter.get('/duplicates', requireAdmin, async (req, res) => {
  res.json({ data: await duplicateOwners() });
});

const name = z.string().trim().min(1).max(120);
const mergeSchema = z.object({ from: z.array(name).min(1).max(50), into: name });

/**
 * Rewrites the Owner on every record carrying one of the spellings, with
 * no undo, and fills in the record owner where the kept spelling names a
 * sales user. Admin only, as the company merge is.
 */
ownerRouter.post('/merge', requireAdmin, async (req, res) => {
  const parsed = mergeSchema.safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Pick the owner to keep and the spellings to merge into it');
  res.json({ data: await mergeOwners({ ...parsed.data, actor: actorFrom(req.user) }) });
});
