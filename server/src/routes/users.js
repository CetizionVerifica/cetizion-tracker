import { Router } from 'express';

import { requireAdmin } from '../auth/middleware.js';
import { MIN_PASSWORD_LENGTH } from '../lib/passwords.js';
import { listUsers } from '../lib/users.js';

/**
 * The accounts that sign in, read only (#18 Phase 1B-B).
 *
 * Accounts are created, edited, given passwords, switched off and deleted
 * in one place only: the super admin portal (routes/superAdmin.js). What is
 * left here is the list the admin screens read to name people — the owner
 * filter on Reports, who a mailbox belongs to — so an admin of the tracker
 * can see who is who but cannot hand out or change a key.
 *
 * Admin only, at the router. requireAdmin reads the role off the request
 * user, which requireAuth has just re-read from the database. No hash ever
 * leaves here: listUsers selects by column list, and the password column is
 * not in it.
 */

export const userRouter = Router();

userRouter.use(requireAdmin);

userRouter.get('/', async (req, res) => {
  res.json({ data: await listUsers(), limits: { min_password_length: MIN_PASSWORD_LENGTH } });
});
