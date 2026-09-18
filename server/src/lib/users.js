import { pool } from '../db.js';
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

const COLUMNS = 'id, name, email, password_hash, role, active, last_login_at, created_at, updated_at';

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
