import { changeRecordOwner } from './ownershipHistory.js';

/**
 * The owner an admin names when they fill in a record's salesperson.
 *
 * The forms label `sales_person` as the record's Owner, so an admin who
 * enters an enquiry, a quotation or a project and picks "Madhuri Pogir"
 * there reasonably believes Madhuri now owns it. Until this module, nothing
 * turned that choice into owner_user_id: an admin-created record stayed
 * unowned, and an unowned record is one only an admin can see — so it was
 * on the admin's list and missing from Madhuri's.
 *
 * The match is exact, never a guess, in the spirit of the 060 backfill:
 *
 *   1. the salesperson email belongs to exactly one active sales user;
 *   2. otherwise, the salesperson name, ignoring case and spacing, belongs
 *      to exactly one active sales user.
 *
 * Active sales users only, because that is who an owner may be given to
 * (changeRecordOwner refuses anybody else). Anything else — a name nobody
 * carries, two people with one name — leaves the owner as it is, and the
 * record stays where an admin can assign it by hand.
 *
 * Migration 096 applies the same two rules to the records created before
 * this existed; test/salespersonOwner.test.js holds both to the same cases.
 */

const SQL = `
  SELECT COALESCE(
    (SELECT max(u.id) FROM users u
      WHERE u.active AND u.role = 'sales'
        AND $2::text IS NOT NULL AND btrim($2::text) <> ''
        AND lower(btrim(u.email)) = lower(btrim($2::text))
     HAVING count(*) = 1),
    (SELECT max(u.id) FROM users u
      WHERE u.active AND u.role = 'sales'
        AND $1::text IS NOT NULL AND btrim($1::text) <> ''
        AND lower(regexp_replace(btrim(u.name), '\\s+', ' ', 'g'))
          = lower(regexp_replace(btrim($1::text), '\\s+', ' ', 'g'))
     HAVING count(*) = 1)
  ) AS id`;

/** The active sales user a salesperson name/email names beyond doubt, or null. */
export async function ownerForSalesperson(db, { name = null, email = null } = {}) {
  const { rows } = await db.query(SQL, [name ?? null, email ?? null]);
  return rows[0]?.id ?? null;
}

const SALESPERSON_FIELDS = ['sales_person', 'sales_person_email'];

/**
 * After an admin saves an owner-scoped record: if the salesperson on it
 * names a sales user, make that user the owner, through the same
 * changeRecordOwner an explicit assignment uses, so the change lands in
 * ownership_history and the activity log like any other.
 *
 * Runs on a create, and on an update that touched the salesperson. A name
 * that resolves to nobody changes nothing: it never unassigns.
 *
 * @param row     the record as written
 * @param fields  the columns the save wrote; null for a create
 * @returns the row as it now stands
 */
export async function assignOwnerFromSalesperson(client, def, row, { fields = null, actor }) {
  if (!def.ownerScoped || !row) return row;
  if (fields && !fields.some((f) => SALESPERSON_FIELDS.includes(f))) return row;

  const owner = await ownerForSalesperson(client, { name: row.sales_person, email: row.sales_person_email });
  if (owner === null || owner === row.owner_user_id) return row;

  const { record } = await changeRecordOwner(client, {
    entityType: def.table,
    // The natural key where there is one: idPredicate reads digits as a key first.
    entityIdOrKey: String(def.naturalKey && row[def.naturalKey] != null ? row[def.naturalKey] : row.id),
    expectedOwnerId: row.owner_user_id ?? null,
    newOwnerId: owner,
    reason: `Owner set from the salesperson on the record (${row.sales_person_email || row.sales_person})`,
    actor,
  });
  return record;
}
