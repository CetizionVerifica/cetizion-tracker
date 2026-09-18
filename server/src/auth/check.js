import { pool } from '../db.js';

/**
 * Is this database ready to become the only way in? (#18 Phase 1B-C1)
 *
 * Read-only, and meant to be run BEFORE anybody changes AUTH_MODE — the
 * one question worth answering while the answer is still cheap. Getting it
 * wrong the other way round means a deploy that will not start, or worse,
 * one that starts with nobody able to sign in.
 *
 * It reads. It does not create an admin, activate anybody, or set a
 * password: fixing what it finds is deliberate work for a person, and a
 * check command that quietly repaired things would be a check nobody could
 * trust.
 *
 * Nothing it returns can carry a secret. Counts, and the verdict. Not a
 * hash, not an address, not a password — this runs in terminals and CI
 * logs, and an operator who needs to see *which* account is which has
 * Settings -> Users, where being signed in is the price of looking.
 */

/** @typedef {{key: string, label: string, ok: boolean, detail: string}} Check */

const check = (key, label, ok, detail) => ({ key, label, ok, detail });

/**
 * Run every readiness check.
 *
 * Never throws for a database that is simply unwell — that is a finding,
 * not a crash, and the caller wants the report either way.
 *
 * @returns {{ready: boolean, checks: Check[], activeAdmins: number}}
 */
export async function authReadinessReport({ db = pool } = {}) {
  const checks = [];
  let activeAdmins = 0;

  // 1. Can we talk to the database at all?
  try {
    await db.query('SELECT 1');
    checks.push(check('database', 'Database reachable', true, 'answered'));
  } catch (err) {
    checks.push(check('database', 'Database reachable', false, firstLine(err)));
    // Nothing below can mean anything if this failed.
    return { ready: false, checks, activeAdmins };
  }

  // 2. Is the users table there and readable?
  let users;
  try {
    const { rows } = await db.query(
      `SELECT id, email, password_hash IS NOT NULL AS has_password, role, active FROM users`
    );
    users = rows;
    checks.push(check('table', 'Users table', true, `${rows.length} row${rows.length === 1 ? '' : 's'}`));
  } catch (err) {
    checks.push(check('table', 'Users table', false, firstLine(err)));
    return { ready: false, checks, activeAdmins };
  }

  // 3. Somebody has to be able to administer it.
  const admins = users.filter((u) => u.role === 'admin' && u.active);
  activeAdmins = admins.length;
  checks.push(
    check(
      'admins',
      'Active database admins',
      admins.length > 0,
      admins.length > 0
        ? String(admins.length)
        : 'none — database mode would start with nobody able to sign in'
    )
  );

  // 4. An account that may sign in needs something to sign in with. The
  //    table's own CHECK says so, which is exactly why this is worth
  //    confirming rather than assuming: a check that only repeats what it
  //    trusts is not a check.
  const signIn = users.filter((u) => u.active);
  const withoutEmail = signIn.filter((u) => !u.email).length;
  const withoutPassword = signIn.filter((u) => !u.has_password).length;
  checks.push(
    check(
      'credentials',
      'Sign-in credentials present',
      withoutEmail === 0 && withoutPassword === 0,
      withoutEmail === 0 && withoutPassword === 0
        ? `${signIn.length} active account${signIn.length === 1 ? '' : 's'}, all complete`
        : `${withoutEmail} without an email, ${withoutPassword} without a password`
    )
  );

  // 5. Sign-in matches on lower(email). Two accounts colliding there would
  //    make which one you reach a matter of row order.
  const byKey = new Map();
  for (const u of users) {
    if (!u.email) continue;
    const key = u.email.trim().toLowerCase();
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  const collisions = [...byKey.values()].filter((n) => n > 1).length;
  checks.push(
    check(
      'unique-emails',
      'Email uniqueness (case-insensitive)',
      collisions === 0,
      collisions === 0 ? 'no collisions' : `${collisions} address${collisions === 1 ? '' : 'es'} used more than once`
    )
  );

  // 6. An address nobody could type is an account nobody could use.
  const unusable = signIn.filter((u) => u.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email)).length;
  checks.push(
    check(
      'email-shape',
      'Email addresses usable',
      unusable === 0,
      unusable === 0 ? 'all parse as addresses' : `${unusable} that nobody could type at the sign-in form`
    )
  );

  return { ready: checks.every((c) => c.ok), checks, activeAdmins };
}

/** Errors from pg carry stacks and sometimes the statement; take the sentence. */
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/**
 * The report as an operator reads it. Returned rather than printed, so the
 * caller decides where it goes and the tests can look at it.
 */
export function formatReadinessReport({ ready, checks }) {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = [
    'Database authentication readiness',
    '',
    ...checks.map((c) => `  ${c.label.padEnd(width)}   ${c.ok ? 'PASS' : 'FAIL'}   ${c.detail}`),
    '',
    ready
      ? 'READY FOR AUTH_MODE=database'
      : 'NOT READY FOR AUTH_MODE=database — fix the FAIL lines above, then run this again.',
  ];
  return lines.join('\n');
}
