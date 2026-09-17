import { pool, withTransaction } from '../db.js';
import { passwordProblem } from '../lib/passwords.js';
import { ADMIN_INVARIANT_LOCK_KEY, createUser, findActiveAdmin, findUserByEmail, normalizeEmail } from '../lib/users.js';

/**
 * The FIRST admin in the users table, and only ever the first.
 *
 * A fresh deployment has no accounts, and nothing in the app can create the
 * first one — so it comes from the environment, once:
 *
 *   BOOTSTRAP_ADMIN_NAME
 *   BOOTSTRAP_ADMIN_EMAIL
 *   BOOTSTRAP_ADMIN_PASSWORD
 *
 * All three together, or none at all. Half of them set is a deployment that
 * went wrong — a renamed variable, a secret that did not reach the
 * container — and it stops the start rather than quietly creating nothing,
 * because the failure people actually hit is believing an admin exists when
 * it does not. None of them set is the normal state today.
 *
 * What governs everything here: **if the tracker already has an admin who
 * can sign in, this does nothing at all.** Not "an admin with that email" —
 * any of them. An environment variable that quietly changes, or is edited
 * by the wrong hand, must never be able to mint a second administrator; the
 * only thing it can ever do is fill an empty seat.
 *
 * Where it will not act, it will not improvise either: an account already
 * holding the configured address is never reactivated, never promoted and
 * never given a new password. Those are deliberate acts for a person. It
 * says so loudly and lets the API start: a stale variable pointing at an
 * account that already exists is a problem with a facility nobody is using
 * yet, and taking the tracker down over it would cost real availability to
 * protect nothing. A configuration that cannot be read at all is different
 * — see readBootstrapConfig — because that is a broken deployment.
 *
 * None of this is a way in. Signing in still checks AUTH_USERNAME /
 * AUTH_PASSWORD and does not read this table at all.
 *
 * ---------------------------------------------------------------------
 * PHASE 1B NOTE — the guard that is deliberately NOT here yet.
 *
 * Because a conflict above is only a warning, a deployment can reach the
 * end of Phase 1A with no active admin at all. That is harmless while
 * AUTH_USERNAME / AUTH_PASSWORD is the real lock, and fatal the moment it
 * is not.
 *
 * So before the shared credentials are removed, Phase 1B must refuse to
 * make the database the sole authentication: at least one active admin has
 * to exist, or there is no way back into the tracker. findActiveAdmin() is
 * the check; the cutover is where it becomes fatal, not here.
 * ---------------------------------------------------------------------
 */

const VARS = ['BOOTSTRAP_ADMIN_NAME', 'BOOTSTRAP_ADMIN_EMAIL', 'BOOTSTRAP_ADMIN_PASSWORD'];

// Enough to catch a variable holding something that is not an address.
// Whether it can receive mail is not ours to decide.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const UNIQUE_VIOLATION = '23505';

// Serialises every change to "how many active admins exist" — this, and
// the Users API's last-admin guard. Reading "is there an admin?" and then
// writing one is two steps, and two containers starting together would
// otherwise both read "no" and both write; because their configured
// addresses can differ, no unique index would catch the second.

/**
 * A configuration that cannot be used — the only fatal kind of problem
 * here, because it means the deployment itself is wrong.
 */
export class BootstrapConfigError extends Error {}

/**
 * Why bootstrapping stood down rather than acting. The configuration was
 * readable; the database was simply not in a state it may resolve alone.
 */
export const CONFLICT = {
  inactive: 'inactive-account',
  nonAdmin: 'non-admin-account',
};

const isSet = (value) => String(value ?? '').trim() !== '';

/**
 * @returns the admin to create, or null when bootstrapping is not configured.
 * @throws {BootstrapConfigError} for a half-set or unusable configuration.
 *
 * Messages name variables, never their contents.
 */
export function readBootstrapConfig(env = process.env) {
  const present = VARS.filter((name) => isSet(env[name]));
  if (present.length === 0) return null;

  if (present.length !== VARS.length) {
    const missing = VARS.filter((name) => !present.includes(name));
    throw new BootstrapConfigError(
      `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, but ` +
        `${present.join(' and ')} ${present.length === 1 ? 'is' : 'are'}. ` +
        'Set all three to create the first admin, or none of them to skip it.'
    );
  }

  const email = normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL);
  if (!EMAIL_SHAPE.test(email ?? '')) {
    throw new BootstrapConfigError('BOOTSTRAP_ADMIN_EMAIL is not an email address.');
  }

  const problem = passwordProblem(env.BOOTSTRAP_ADMIN_PASSWORD);
  if (problem) {
    throw new BootstrapConfigError(`BOOTSTRAP_ADMIN_PASSWORD cannot be used: ${problem}.`);
  }

  return {
    name: String(env.BOOTSTRAP_ADMIN_NAME).trim().replace(/\s+/g, ' '),
    email,
    password: String(env.BOOTSTRAP_ADMIN_PASSWORD),
  };
}

/**
 * Create the first admin, if one is configured and the tracker has none.
 *
 * @returns {{status: 'skipped'|'exists'|'created'|'conflict', reason?: string, id?: number}}
 *   'conflict' is a warning, not a failure: nothing was written and the
 *   caller should carry on starting.
 * @throws {BootstrapConfigError} a half-set or unusable configuration —
 *   the one case a caller should treat as fatal.
 */
export async function bootstrapAdmin({
  db = pool,
  env = process.env,
  log = console.log,
  warn = console.warn,
} = {}) {
  const wanted = readBootstrapConfig(env);
  if (!wanted) {
    log('BOOTSTRAP_ADMIN_* is not set — no database admin was created.');
    return { status: 'skipped' };
  }

  return withTransaction(db, async (client) => {
    // Everything below reads and then writes; hold the lock across both.
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_INVARIANT_LOCK_KEY]);

    const [admin, holder] = await Promise.all([
      findActiveAdmin(client),
      findUserByEmail(wanted.email, client),
    ]);

    // The seat is taken. Whose it is does not matter: a changed
    // BOOTSTRAP_ADMIN_EMAIL is not a reason to appoint anybody.
    if (admin) {
      const configuredIsAdmin = holder?.active && holder.role === 'admin';
      log(
        configuredIsAdmin
          ? 'the configured account is already an active admin — left exactly as it is.'
          : 'an active admin already exists, so BOOTSTRAP_ADMIN_EMAIL was not used. ' +
            'Bootstrapping only ever creates the first admin.'
      );
      return { status: 'exists', id: configuredIsAdmin ? holder.id : admin.id };
    }

    // Nobody can administer the tracker, and somebody already holds the
    // address we were told to use. Reactivating or promoting them would be
    // a privilege grant nobody asked for in so many words — so say so, take
    // the hands off, and let the API start. Nothing has been written.
    if (holder) {
      const reason = holder.active ? CONFLICT.nonAdmin : CONFLICT.inactive;
      warn(
        `BOOTSTRAP_ADMIN_EMAIL already belongs to ${
          holder.active ? 'an active account that is not an admin' : 'an account that is not active'
        }.\n` +
          `  Nothing was created, ${holder.active ? 'promoted' : 'reactivated'} or given a password — ` +
          'bootstrapping never does that to an account that already exists.\n' +
          '  This tracker therefore has no database admin. Sign-in is unaffected: it still uses ' +
          'AUTH_USERNAME / AUTH_PASSWORD.\n' +
          `  To fix it, ${
            holder.active ? "change that account's role" : 'activate that account'
          } deliberately, or point BOOTSTRAP_ADMIN_EMAIL at an address nobody holds.`
      );
      return { status: 'conflict', reason, id: holder.id };
    }

    let created;
    try {
      created = await createUser(
        { name: wanted.name, email: wanted.email, password: wanted.password, role: 'admin', active: true },
        client
      );
    } catch (err) {
      // The lock makes this unreachable between two bootstraps. It stays
      // for anything else that may write this table later without taking it.
      if (err?.code === UNIQUE_VIOLATION) {
        log('that address was taken while this was running — nothing was created.');
        return { status: 'exists' };
      }
      throw err;
    }

    log(
      `created the first admin ${created.email}. ` +
        'Signing in still uses AUTH_USERNAME / AUTH_PASSWORD — this account cannot be used yet.'
    );
    return { status: 'created', id: created.id };
  });
}
