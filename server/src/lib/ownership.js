import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool, withTransaction } from '../db.js';

/**
 * Re-running the ownership backfill after the people it needs exist
 * (#18 Phase 2B).
 *
 * Migration 019 assigns an owner to every historical record whose
 * salesperson matches a users row exactly. That is the right thing to do at
 * deploy time, and it has one awkward property: a migration runs once. On a
 * database where the historical salespeople are not in the users table yet
 * — which is every database today, because the seed carries the names as
 * text and no accounts — 019 correctly assigns nothing, is marked applied,
 * and never looks again. The records stay unowned for good.
 *
 * So the same work has to be available on demand, once an admin has
 * prepared the user list. The thing to avoid is a second copy of the
 * matching rules: two SQL files that start identical and drift is how a
 * "safe deterministic backfill" quietly stops being either.
 *
 * Hence this module does not contain the rules. It reads the migration and
 * runs it. The migration file is the single statement of what a
 * deterministic match is; this is a second way to invoke it, at a time the
 * operator chooses, and both are safe to run repeatedly because every
 * statement in there is `WHERE owner_user_id IS NULL`.
 */

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db');

/**
 * The migration that defines a deterministic match. Named here, and only
 * here, so there is one place to change if a later migration ever
 * supersedes the rules — and a test asserts this file still holds them.
 */
export const BACKFILL_MIGRATION = '060_backfill_record_ownership.sql';

export const BACKFILL_SQL = readFileSync(join(DB_DIR, 'migrations', BACKFILL_MIGRATION), 'utf8');
export const REPORT_SQL = readFileSync(join(DB_DIR, 'diagnostics', 'ownership-backfill.sql'), 'utf8');

const TABLES = ['enquiries', 'quotations', 'projects'];

/**
 * Where ownership stands, per table. Counts only — no name, no address, no
 * record id — so the result can be printed, logged or pasted anywhere.
 *
 * Read-only. This is what `--dry-run` shows, and it is a real measurement
 * rather than a simulated write: the "would match" columns classify each
 * unowned row by the same rules the backfill applies, so a non-zero number
 * there is exactly the set of rows a run would claim.
 */
export async function ownershipReport(db = pool) {
  const { rows } = await db.query(REPORT_SQL);
  return rows.map((r) => ({
    table: r.table_name,
    total: Number(r.total),
    owned: Number(r.owned),
    emailWouldMatch: Number(r.email_would_match),
    nameWouldMatch: Number(r.name_would_match),
    nameAmbiguous: Number(r.name_ambiguous),
    emailMatchesNobody: Number(r.email_matches_nobody),
    noSignal: Number(r.no_signal),
  }));
}

/**
 * Assign every owner the historical data names beyond doubt, and leave the
 * rest alone.
 *
 * One transaction across all three tables: either every deterministic
 * assignment lands or none does. A backfill that got halfway would leave
 * the database in a state nobody chose — quotations owned, projects not —
 * and the operator with no way to tell which half ran.
 *
 * Nothing is caught here. If the database refuses a statement the
 * transaction rolls back and the error reaches the caller, because a
 * maintenance command that prints "done" over a failure is worse than one
 * that stops.
 *
 * Idempotent: a second run finds the rows it assigned no longer null and
 * skips them. Running it after more users are added claims the records that
 * now resolve, and only those.
 *
 * @returns {{ before, after, assigned: Record<string, number>, total: number }}
 */
export async function backfillOwnership(db = pool) {
  return withTransaction(db, async (client) => {
    // Measured inside the transaction, so the before and after readings
    // describe the same snapshot the writes happened in.
    const before = await ownershipReport(client);
    await client.query(BACKFILL_SQL);
    const after = await ownershipReport(client);

    const ownedBy = (report) => Object.fromEntries(report.map((r) => [r.table, r.owned]));
    const was = ownedBy(before);
    const now = ownedBy(after);
    // Counted by difference rather than by each statement's row count, so the answer
    // does not depend on the order the statements happen to sit in the file.
    const assigned = Object.fromEntries(TABLES.map((t) => [t, (now[t] ?? 0) - (was[t] ?? 0)]));

    return {
      before,
      after,
      assigned,
      total: Object.values(assigned).reduce((a, b) => a + b, 0),
    };
  });
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

/** The report as a grid. Counts only; nothing here can name a person. */
export function formatOwnershipReport(report) {
  const head = ['table', 'total', 'owned', 'email', 'name', 'ambiguous', 'no match', 'no signal'];
  const widths = [11, 7, 7, 7, 7, 10, 9, 10];
  const lines = [
    '  ' + head.map((h, i) => (i === 0 ? pad(h, widths[i]) : num(h, widths[i]))).join(''),
    '  ' + widths.map((w) => '-'.repeat(w - 1) + ' ').join(''),
  ];
  for (const r of report) {
    lines.push(
      '  ' +
        pad(r.table, widths[0]) +
        num(r.total, widths[1]) +
        num(r.owned, widths[2]) +
        num(r.emailWouldMatch, widths[3]) +
        num(r.nameWouldMatch, widths[4]) +
        num(r.nameAmbiguous, widths[5]) +
        num(r.emailMatchesNobody, widths[6]) +
        num(r.noSignal, widths[7])
    );
  }
  lines.push('');
  lines.push('  email / name  unowned rows a backfill would claim, by which rule');
  lines.push('  ambiguous     the name belongs to more than one user — left unowned');
  lines.push('  no match      an email address that belongs to no account — left unowned');
  lines.push('  no signal     no salesperson recorded, or a name nobody carries');
  return lines.join('\n');
}
