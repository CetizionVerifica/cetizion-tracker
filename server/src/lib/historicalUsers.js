import { pool, withTransaction } from '../db.js';

/**
 * Turning the free-text salespeople in the old data into users rows
 * (#18 Phase 2B, the step migration 060 cannot take).
 *
 * 060 assigns `owner_user_id` wherever the data names somebody beyond
 * doubt, by matching `sales_person_email` or `sales_person` against a
 * *users row that already exists*. On every database today none of those
 * rows exist — the seed carries the names as text and no accounts — so the
 * migration correctly assigns nothing and is then marked applied for good.
 *
 * Issue #18 §2 asks for "one inactive `sales` user per distinct person,
 * grouping names with the same case- and space-insensitive rule the reports
 * already use". This is that step, and it is deliberately separate from the
 * backfill rather than folded into it:
 *
 *   creating people   invents identities, and an identity created wrongly
 *                     is a person who does not exist appearing in Settings
 *                     → Users and on a leaderboard. It needs an operator
 *                     looking at the list.
 *   assigning owners  is arithmetic on identities that already exist, and
 *                     is safe to re-run unattended.
 *
 * So the order is always: create (this file, reviewed) → backfill (060's
 * rules, via lib/ownership.js) → an admin clears what is left.
 *
 * Everything here is idempotent. A name that already resolves to a users
 * row is never created a second time, and a name that resolves to *more
 * than one* is never touched at all — see AMBIGUOUS below.
 */

/**
 * The one normalisation rule, written once.
 *
 * Identical to Rule B in 060_backfill_record_ownership.sql: lower-case,
 * trim the ends, collapse internal runs of whitespace. Nothing more — no
 * initials, no nicknames, no similarity. If this and the migration ever
 * disagree, this file creates a user the backfill then refuses to match,
 * which is the exact failure the shared constant exists to prevent.
 */
export const NORMALISE_NAME_SQL = "lower(regexp_replace(btrim(%s), '\\s+', ' ', 'g'))";

const norm = (expr) => NORMALISE_NAME_SQL.replace('%s', expr);

/** How a discovered name is classified, and what the operator should do. */
export const DISPOSITIONS = Object.freeze({
  /** No users row carries this name. This is the one we create. */
  CREATABLE: 'creatable',
  /** Exactly one users row already carries it; 060 will match it. */
  EXISTS: 'exists',
  /**
   * More than one users row carries it. Creating another makes it worse,
   * and 060's `count = 1` guard already refuses to match it, so the records
   * stay unowned until a person says which user is meant.
   */
  AMBIGUOUS: 'ambiguous',
});

/**
 * Every distinct salesperson named on a record that has no owner.
 *
 * Read-only. Returns counts and the names themselves — unlike
 * ownershipReport(), which is counts-only and safe to paste anywhere, this
 * one necessarily carries personal data, because naming the people is the
 * entire point. It is admin-only wherever it is exposed.
 *
 * `projects` has `sales_person` but no `sales_person_email`; that is not an
 * oversight in this query, it is the shape of the table (see 060 Rule B).
 * `project_manager` is deliberately not consulted — the manager who
 * delivers a project is not the salesperson who sold it.
 */
export async function discoverHistoricalSalespeople(db = pool) {
  const { rows } = await db.query(
    `WITH named AS (
       SELECT ${norm('e.sales_person')} AS norm,
              btrim(e.sales_person)     AS raw,
              lower(btrim(e.sales_person_email)) AS email,
              'enquiries'               AS source
         FROM enquiries e
        WHERE e.owner_user_id IS NULL
          AND e.sales_person IS NOT NULL AND btrim(e.sales_person) <> ''
       UNION ALL
       SELECT ${norm('q.sales_person')}, btrim(q.sales_person),
              lower(btrim(q.sales_person_email)), 'quotations'
         FROM quotations q
        WHERE q.owner_user_id IS NULL
          AND q.sales_person IS NOT NULL AND btrim(q.sales_person) <> ''
       UNION ALL
       SELECT ${norm('p.sales_person')}, btrim(p.sales_person),
              NULL, 'projects'
         FROM projects p
        WHERE p.owner_user_id IS NULL
          AND p.sales_person IS NOT NULL AND btrim(p.sales_person) <> ''
     ),
     grouped AS (
       SELECT norm,
              -- The spelling to show and to store. mode() takes the most
              -- common one and breaks ties by sort order, so the same data
              -- always yields the same name rather than whichever row the
              -- planner reached first.
              mode() WITHIN GROUP (ORDER BY raw) AS display_name,
              COUNT(*)::int                                          AS record_count,
              COUNT(*) FILTER (WHERE source = 'enquiries')::int       AS enquiries,
              COUNT(*) FILTER (WHERE source = 'quotations')::int      AS quotations,
              COUNT(*) FILTER (WHERE source = 'projects')::int        AS projects,
              COUNT(DISTINCT raw)::int                                AS spelling_count,
              COUNT(DISTINCT email) FILTER (WHERE email IS NOT NULL AND email <> '')::int AS email_count,
              MIN(email) FILTER (WHERE email IS NOT NULL AND email <> '')  AS sole_email
         FROM named
        GROUP BY norm
     )
     SELECT g.*,
            (SELECT COUNT(*)::int FROM users u
              WHERE ${norm('u.name')} = g.norm) AS existing_user_count,
            (SELECT COUNT(*)::int FROM users u
              WHERE g.email_count = 1
                AND u.email IS NOT NULL
                AND lower(btrim(u.email)) = g.sole_email) AS email_taken_count
       FROM grouped g
      ORDER BY g.record_count DESC, g.norm ASC`
  );

  return rows.map((r) => ({
    normalisedName: r.norm,
    displayName: r.display_name,
    spellingCount: r.spelling_count,
    records: {
      total: r.record_count,
      enquiries: r.enquiries,
      quotations: r.quotations,
      projects: r.projects,
    },
    // The address only carries when the name maps to exactly one, and
    // nobody already holds it. Two addresses for one name is a question for
    // a person, not something to pick a winner from; and reusing an address
    // that exists would collide with users_email_key anyway.
    email: r.email_count === 1 && r.email_taken_count === 0 ? r.sole_email : null,
    emailCount: r.email_count,
    emailWithheldReason:
      r.email_count > 1 ? 'more than one address for this name'
        : r.email_count === 1 && r.email_taken_count > 0 ? 'the address already belongs to an account'
          : null,
    existingUserCount: r.existing_user_count,
    disposition:
      r.existing_user_count === 0 ? DISPOSITIONS.CREATABLE
        : r.existing_user_count === 1 ? DISPOSITIONS.EXISTS
          : DISPOSITIONS.AMBIGUOUS,
  }));
}

/**
 * Create the missing people, as inactive sales accounts.
 *
 * `active = false`, no password. Two reasons, and both matter:
 *
 *   * the users_active_needs_login CHECK (015) forbids an active row
 *     without an email and a hash, and inventing either would be inventing
 *     a credential.
 *   * an inactive row cannot sign in. Until an admin sets a password
 *     deliberately, these are attribution only — exactly what 015's header
 *     describes them as.
 *
 * One transaction: a half-created set of people is a state nobody chose.
 *
 * @param {{ dryRun?: boolean }} options
 * @returns {{ created: Array, skipped: Array, dryRun: boolean }}
 */
export async function createHistoricalUsers(db = pool, { dryRun = false } = {}) {
  return withTransaction(db, async (client) => {
    const discovered = await discoverHistoricalSalespeople(client);
    const creatable = discovered.filter((d) => d.disposition === DISPOSITIONS.CREATABLE);
    const skipped = discovered.filter((d) => d.disposition !== DISPOSITIONS.CREATABLE);

    const created = [];
    for (const person of creatable) {
      if (dryRun) {
        created.push({ ...person, id: null });
        continue;
      }
      // Written here rather than through createUser() so the insert stays
      // in this transaction and the row is unambiguously attribution-only:
      // no password argument is accepted, so none can be supplied.
      const { rows } = await client.query(
        `INSERT INTO users (name, email, password_hash, role, active)
         VALUES ($1, $2, NULL, 'sales', false)
         RETURNING id, name, email, role, active`,
        [person.displayName, person.email]
      );
      created.push({ ...person, id: rows[0].id });
    }

    if (dryRun) {
      // Nothing written, and nothing to undo — but rolling back explicitly
      // means a future edit that does write cannot leave it behind.
      throw new DryRun({ created, skipped, dryRun: true });
    }
    return { created, skipped, dryRun: false };
  }).catch((err) => {
    if (err instanceof DryRun) return err.result;
    throw err;
  });
}

/** Carries a dry run's answer out through the transaction that rolls back. */
class DryRun extends Error {
  constructor(result) {
    super('dry run');
    this.result = result;
  }
}
