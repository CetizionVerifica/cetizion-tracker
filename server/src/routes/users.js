import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin } from '../auth/middleware.js';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/passwords.js';
import {
  DuplicateEmailError, LastAdminError, ROLES,
  createUserAsAdmin, listUsers, setUserPassword, updateUser,
} from '../lib/users.js';
import { ApiError } from '../middleware/error.js';

/**
 * Managing the accounts that sign in (#18 Phase 1B-B).
 *
 * Admin only, at the router, so a route added here later is guarded because
 * of where it lives rather than because somebody remembered. requireAdmin
 * reads the role off the request user, which requireAuth has just re-read
 * from the database — so an admin demoted a second ago is already out.
 *
 * Available in both sign-in modes on purpose. The point of the dual-mode
 * transition is that the shared admin can come in here first, create the
 * real accounts, check an active admin exists, and only then switch
 * AUTH_MODE to database. Requiring database mode in order to prepare for
 * database mode would be a circle nobody could step into.
 *
 * No hash ever leaves here: every row is selected by column list, and the
 * password column is not in any of them.
 */

export const userRouter = Router();

userRouter.use(requireAdmin);

const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

const name = z.string().trim().min(1, 'Enter a name').max(160);
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);
const role = z.enum(ROLES, { message: `Role must be ${ROLES.join(' or ')}` });
const password = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  // The helper's own words, so the policy is stated in exactly one place.
  if (problem) ctx.addIssue({ code: 'custom', message: `Password is not usable: ${problem}` });
});

const newUser = z.object({
  name,
  email,
  role: role.default('sales'),
  password,
  active: z.boolean().default(true),
});

/**
 * Every field optional, and `password` deliberately absent: a name change
 * must not be able to carry a new password along with it. That is its own
 * request, below.
 */
const userChanges = z
  .object({
    name: name.optional(),
    email: z.preprocess(blankToNull, email.nullable()).optional(),
    role: role.optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

const newPassword = z.object({ password });

const parse = (schema, body) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return parsed.data;
};

const userId = (raw) => {
  if (!/^\d+$/.test(raw)) throw new ApiError(404, 'User not found');
  return Number(raw);
};

/** Turn the data layer's refusals into the answers the API gives. */
function asApiError(err) {
  if (err instanceof LastAdminError) return new ApiError(409, err.message);
  if (err instanceof DuplicateEmailError) {
    return new ApiError(422, 'Please check the highlighted fields', { fields: { email: err.message } });
  }
  return err;
}

userRouter.get('/', async (req, res) => {
  res.json({ data: await listUsers(), limits: { min_password_length: MIN_PASSWORD_LENGTH } });
});

userRouter.post('/', async (req, res) => {
  const body = parse(newUser, req.body);

  let created;
  try {
    created = await createUserAsAdmin(body);
  } catch (err) {
    throw asApiError(err);
  }

  // createUser returns the row whole; the hash is not ours to pass on.
  const { password_hash: _hash, ...user } = created;
  res.status(201).json({ data: user });
});

userRouter.patch('/:id', async (req, res) => {
  const id = userId(req.params.id);
  const changes = parse(userChanges, req.body);

  let updated;
  try {
    updated = await updateUser(id, changes);
  } catch (err) {
    throw asApiError(err);
  }
  if (!updated) throw new ApiError(404, 'User not found');

  res.json({ data: updated });
});

/**
 * Give somebody a new password, and nothing else.
 *
 * A switched-off account stays switched off: it gains a password it cannot
 * yet use, which is the honest outcome — deciding somebody may sign in is
 * the `active` flag's job, and doing it as a side effect of a password
 * reset is how people get let back in by accident.
 *
 * Known limitation: sessions already signed carry no password version, so
 * this does not end them. Whoever is signed in stays signed in until the
 * cookie expires or the account is switched off. Deactivate to cut somebody
 * off now — that takes effect on their next request.
 */
userRouter.post('/:id/password', async (req, res) => {
  const id = userId(req.params.id);
  const { password: plain } = parse(newPassword, req.body);

  const updated = await setUserPassword(id, plain);
  if (!updated) throw new ApiError(404, 'User not found');

  res.json({ data: updated });
});
