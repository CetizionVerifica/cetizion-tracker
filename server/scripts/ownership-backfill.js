#!/usr/bin/env node
/**
 * Assign historical ownership that the data names beyond doubt.
 *
 *   npm run ownership:backfill -- --dry-run                  what it would do; changes nothing
 *   npm run ownership:backfill -- --create-users --dry-run   including the accounts it would create
 *   npm run ownership:backfill -- --create-users             create the missing people, then assign
 *   npm run ownership:backfill                               assign only
 *
 * Why this exists alongside migration 019: a migration runs once. On a
 * database where the historical salespeople are not yet in the users table,
 * 019 correctly assigns nothing and is then marked applied for good. Run
 * this after Settings → Users holds those people, and the records they
 * plainly own are claimed. Run it again after adding more; it only ever
 * fills in a blank owner, never changes one.
 *
 * Not an API route, and deliberately so: it is a data-maintenance step an
 * operator takes once, with the user list in front of them, not something a
 * browser should be able to set off.
 *
 * Prints counts only — no name and no email address leaves this command.
 * Exits non-zero if anything failed, so a runbook can stop on it.
 */
import { pool } from '../src/db.js';
import {
  BACKFILL_MIGRATION, backfillOwnership, formatOwnershipReport, ownershipReport,
} from '../src/lib/ownership.js';
import { DISPOSITIONS, createHistoricalUsers } from '../src/lib/historicalUsers.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const createUsers = args.includes('--create-users');

/**
 * `--create-users` first, then the assignment.
 *
 * The two are separate commands on purpose (see lib/historicalUsers.js):
 * creating a person invents an identity and wants an operator looking at
 * the list, whereas assigning owners is arithmetic on identities that
 * already exist. Running them in one invocation is a convenience for a
 * rehearsal, not an instruction to stop reading the output.
 */
async function createMissingPeople() {
  const { created, skipped } = await createHistoricalUsers(pool, { dryRun });

  console.log(dryRun
    ? 'Historical salespeople — dry run. Nothing is written.\n'
    : 'Creating historical salespeople as inactive sales accounts.\n');

  if (!created.length) console.log('  No new people to create.');
  for (const p of created) {
    const where = `${p.records.total} record${p.records.total === 1 ? '' : 's'}`;
    const mail = p.email ? ' · ' + p.email : p.emailWithheldReason ? ` · no address (${p.emailWithheldReason})` : ' · no address';
    console.log(`  ${dryRun ? 'would create' : 'created'}  ${p.displayName}  (${where}${mail})`);
  }

  const ambiguous = skipped.filter((s) => s.disposition === DISPOSITIONS.AMBIGUOUS);
  const exists = skipped.filter((s) => s.disposition === DISPOSITIONS.EXISTS);
  if (exists.length) console.log(`\n  ${exists.length} name${exists.length === 1 ? '' : 's'} already had an account.`);
  for (const p of ambiguous) {
    console.log(`  AMBIGUOUS  ${p.displayName} — ${p.existingUserCount} accounts carry this name; assign these ${p.records.total} records by hand.`);
  }
  console.log('');
}

try {
  if (createUsers) await createMissingPeople();

  if (dryRun) {
    console.log('Ownership backfill — dry run. Nothing is written.\n');
    console.log(formatOwnershipReport(await ownershipReport()));
    const report = await ownershipReport();
    const would = report.reduce((n, r) => n + r.emailWouldMatch + r.nameWouldMatch, 0);
    console.log('');
    console.log(
      would === 0
        ? '  Nothing to assign. Every record either has an owner already or cannot be'
        : `  ${would} record${would === 1 ? '' : 's'} would be assigned an owner.`
    );
    if (would === 0) console.log('  matched deterministically — see the last three columns.');
    else console.log('  Run it without --dry-run to apply.');
  } else {
    console.log(`Ownership backfill — applying ${BACKFILL_MIGRATION} in one transaction.\n`);
    const { after, assigned, total } = await backfillOwnership();

    for (const [table, n] of Object.entries(assigned)) {
      console.log(`  ${table.padEnd(11)} ${n === 0 ? 'no change' : `+${n} assigned`}`);
    }
    console.log('');
    console.log(formatOwnershipReport(after));
    console.log('');
    console.log(
      total === 0
        ? '✓ Nothing needed assigning. Ownership is unchanged.'
        : `✓ ${total} record${total === 1 ? '' : 's'} now have an owner.`
    );
    const left = after.reduce((n, r) => n + r.total - r.owned, 0);
    if (left > 0) {
      console.log('');
      console.log(`  ${left} record${left === 1 ? '' : 's'} remain unowned. That is a valid state:`);
      console.log('  it means the historical owner could not be determined safely. Add the');
      console.log('  missing people under Settings → Users and run this again, or leave them');
      console.log('  unowned — Phase 2C treats an unowned record as admin-only.');
    }
  }
} finally {
  await pool.end();
}
