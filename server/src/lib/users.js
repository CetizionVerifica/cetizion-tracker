import { pool, withTransaction } from '../db.js';
import { hashPassword } from './passwords.js';

/**
 * The smallest way to read and write the users table — what the bootstrap
 * needs now, and what signing in against the database will need next.
 *
 * Rows come back whole, password_hash included, because verifying a sign-in
 * needs it. This module is internal: nothing here is shaped for a response
 * body, and a row must never be handed to a client as it stands.
 *
 * Every statement is parameterised. Email is matched the way the unique
 * index groups it — lower(email) — so a lookup can never disagree with what
 * the database would allow to be inserted.
 */

export const ROLES = ['admin', 'sales'];

const COLUMNS = 'id, name, email, password_hash, role, active, session_version, last_login_at, created_at, updated_at';

/** Trimmed as typed, or null when there is nothing there. Case is kept: it is the reader's, not the index's. */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim();
  return trimmed === '' ? null : trimmed;
}

/** Collapses the stray spaces a pasted name arrives with. */
const normalizeName = (name) => (typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '');

/**
 * The longest-standing admin who can sign in, or null when nobody can
 * administer the tracker yet. "Active" is the whole question: an admin row
 * that cannot sign in administers nothing.
 */
export async function findActiveAdmin(db = pool) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM users WHERE role = 'admin' AND active ORDER BY id LIMIT 1`
  );
  return rows[0] ?? null;
}

/**
 * The row a signed cookie names. Read on every authenticated request in
 * database mode, so it is the one query standing between a demoted or
 * switched-off account and the powers it had when it signed in.
 */
export async function findUserById(id, db = pool) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * The same row with the hash taken out — the only shape that may leave this
 * module for a response body or a request context.
 */
export function withoutSecrets(row) {
  if (!row) return null;
  const { password_hash: _hash, ...rest } = row;
  return rest;
}

/**
 * Stamp a successful sign-in. Only ever called once a password has actually
 * been verified: a failed attempt leaves no trace here, or the column would
 * record guesses rather than sign-ins.
 */
export async function recordLogin(id, db = pool) {
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

/** @returns the row whose email matches, ignoring case, or null. */
export async function findUserByEmail(email, db = pool) {
  const normalized = normalizeEmail(email);
  if (normalized === null) return null;

  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [normalized]
  );
  return rows[0] ?? null;
}

/**
 * Add a user. `password` is hashed here and never stored or logged as given;
 * pass null for someone who cannot sign in.
 *
 * The checks below only turn the table's constraints into readable errors —
 * the database enforces the same rules whatever writes to it.
 */
export async function createUser(
  { name, email = null, password = null, role = 'sales', active = true },
  db = pool
) {
  const cleanName = normalizeName(name);
  if (cleanName === '') throw new Error('A user needs a name.');
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);

  const cleanEmail = normalizeEmail(email);
  const passwordHash = password === null || password === undefined ? null : await hashPassword(password);

  if (active && (cleanEmail === null || passwordHash === null)) {
    throw new Error('A user who signs in needs both an email address and a password.');
  }

  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${COLUMNS}`,
    [cleanName, cleanEmail, passwordHash, role, active]
  );
  return rows[0];
}

/**
 * Serialises every change to "how many active admins exist": the first-admin
 * bootstrap, and every edit below that could take the last one away.
 *
 * Any fixed number, and deliberately the same one for all of them — two
 * operations that each leave an admin behind can still leave none between
 * them if they run at once. It only has to differ from the migration
 * runner's (72_910_001).
 */
export const ADMIN_INVARIANT_LOCK_KEY = 72_910_018;

/** An edit that would leave the tracker with nobody able to administer it. */
export class LastAdminError extends Error {}

/** Somebody already holds that address. */
export class DuplicateEmailError extends Error {}

/**
 * Switching on an account that has nothing to sign in with. The database
 * refuses it through users_active_needs_login; this is that refusal in
 * words a person can act on, raised before the constraint name reaches
 * anybody outside this module.
 */
export class ActiveNeedsLoginError extends Error {}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const ACTIVE_NEEDS_LOGIN = 'users_active_needs_login';

/**
 * Turn the two constraint violations this module can provoke into errors
 * the API layer knows how to answer. Anything else is somebody else's
 * problem and is rethrown untouched.
 */
function asDomainError(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    return new DuplicateEmailError('Somebody already uses that email address.');
  }
  if (err?.code === CHECK_VIOLATION && err?.constraint === ACTIVE_NEEDS_LOGIN) {
    return new ActiveNeedsLoginError(
      'An active user needs an email address and a password. Give this account both, ' +
        'or leave it switched off.'
    );
  }
  return err;
}

/**
 * Every user, newest account last, without their hashes. Attribution-only
 * rows come back exactly as they are — no invented address, no pretending
 * they could sign in.
 */
export async function listUsers(db = pool) {
  const { rows } = await db.query(
    `SELECT id, name, email, role, active, last_login_at, created_at, updated_at
       FROM users ORDER BY active DESC, lower(name), id`
  );
  return rows;
}

/**
 * Make the change, then refuse to keep it if the tracker is left with
 * nobody who can administer it.
 *
 * Checking first and writing after is the version that does not work: two
 * admins deactivating each other at the same moment both see a colleague
 * still standing, and both are right until they commit. Writing first and
 * asking afterwards — inside the transaction, under the lock — asks the
 * question about the state that will actually exist.
 */
async function refuseIfNoAdminLeft(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS admins FROM users WHERE role = 'admin' AND active`
  );
  if (rows[0].admins === 0) {
    throw new LastAdminError(
      'That would leave the tracker with no active admin, and nobody could then ' +
        'restore one. Give somebody else the admin role first.'
    );
  }
}

/** Run `fn` where it may change who can administer, and hold the invariant. */
function guardingAdmins(db, fn) {
  return withTransaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_INVARIANT_LOCK_KEY]);
    const result = await fn(client);
    await refuseIfNoAdminLeft(client);
    return result;
  });
}

const FIELDS = { name: 'name', email: 'email', role: 'role', active: 'active' };

/**
 * Change a user's name, email, role or active flag — and nothing else.
 *
 * A password is never part of this. Renaming somebody is an everyday edit;
 * giving them a new password is a different act with different consequences,
 * and the two sharing a form is how one gets done by accident. See
 * setUserPassword.
 *
 * @throws {LastAdminError} the change would leave nobody administering.
 * @throws {DuplicateEmailError} somebody else holds that address.
 */
export async function updateUser(id, changes, db = pool) {
  const sets = [];
  const values = [];

  if (changes.name !== undefined) {
    const cleanName = normalizeName(changes.name);
    if (cleanName === '') throw new Error('A user needs a name.');
    values.push(cleanName);
    sets.push(`${FIELDS.name} = $${values.length}`);
  }
  if (changes.email !== undefined) {
    values.push(normalizeEmail(changes.email));
    sets.push(`${FIELDS.email} = $${values.length}`);
  }
  if (changes.role !== undefined) {
    if (!ROLES.includes(changes.role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}.`);
    values.push(changes.role);
    sets.push(`${FIELDS.role} = $${values.length}`);
  }
  if (changes.active !== undefined) {
    values.push(Boolean(changes.active));
    sets.push(`${FIELDS.active} = $${values.length}`);
    // Switching somebody off ends the sessions they already hold, in the
    // same statement that switches them off — so there is no instant where
    // the account is inactive and its cookies are still current.
    //
    // `active` on the right-hand side is the row's OLD value: inside an
    // UPDATE, Postgres reads columns as they were before the statement. So
    // this raises the counter on the true -> false transition and on
    // nothing else. Switching an already-off account off again, or on,
    // leaves it where it is — and leaving it where it is, on the way back
    // on, is the point: reactivating must not hand back cookies that were
    // revoked. The counter only ever goes up.
    sets.push(
      `session_version = session_version + ` +
        `CASE WHEN ${FIELDS.active} AND NOT $${values.length} THEN 1 ELSE 0 END`
    );
  }
  if (sets.length === 0) throw new Error('Nothing to change.');

  values.push(id);
  try {
    return await guardingAdmins(db, async (client) => {
      const { rows } = await client.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${values.length}
         RETURNING id, name, email, role, active, last_login_at, created_at, updated_at`,
        values
      );
      if (!rows.length) return null;
      return rows[0];
    });
  } catch (err) {
    throw asDomainError(err);
  }
}

/**
 * Give a user a new password. Deliberately its own function and its own
 * request: it does not touch the role, the name, or whether the account is
 * switched on. Setting a password on a switched-off account leaves it
 * switched off — a password is not permission to sign in.
 *
 * The plain password is hashed here and is neither stored, returned nor
 * logged.
 */
export async function setUserPassword(id, password, db = pool) {
  const hash = await hashPassword(password);

  // One statement, so the new password and the end of every session signed
  // under the old one commit together. Two statements would leave a window
  // where the password had changed and the old cookies still worked, which
  // is the exact window a reset after a leak exists to close.
  const { rows } = await db.query(
    `UPDATE users
        SET password_hash = $1,
            session_version = session_version + 1
      WHERE id = $2
     RETURNING id, name, email, role, active, last_login_at, created_at, updated_at`,
    [hash, id]
  );
  return rows[0] ?? null;
}

/**
 * The admin-facing create. Wraps createUser with the same invariant lock,
 * so a new admin arriving cannot interleave with the last one leaving.
 */
export async function createUserAsAdmin(input, db = pool) {
  try {
    return await guardingAdmins(db, (client) => createUser(input, client));
  } catch (err) {
    throw asDomainError(err);
  }
}
