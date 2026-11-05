import { ownerForSalesperson } from '../lib/salespersonOwner.js';

/**
 * Who owns what a sheet import creates.
 *
 * A sales user sees a quotation, project or purchase order only when they
 * own it, or own the quotation or project above it (auth/ownership.js). The
 * importer used to write the salesperson's name and no owner, so every
 * imported deal was unowned: on the admin's Orders list and missing from
 * the salesperson's own.
 *
 * Each distinct salesperson name on the sheet resolves once, for the whole
 * batch:
 *
 *   1. the admin's choice for that name (import_batches.owner_map), which
 *      may be a sales user or an explicit "leave unassigned" (null);
 *   2. otherwise ownerForSalesperson (lib/salespersonOwner.js), the one rule
 *      the forms and migrations 096 and 104 use: the name, ignoring case
 *      and spacing, belongs to exactly one active sales user;
 *   3. otherwise undecided, which the Import screen will not commit; or,
 *      when the tracker has no active sales users at all, unassigned, as
 *      there is nobody to choose.
 *
 * A blank salesperson is a name of its own ('' key), resolved the same way.
 *
 * Only the quotations whose owner this batch actually sets are counted:
 * every new one, and a kept or replaced original that has no owner. An
 * original that already has an owner keeps it, and one an admin unassigned
 * on purpose (it has ownership history) keeps that decision, as migrations
 * 096 and 104 do; asking about either would be a question with no effect.
 */

/** A name as the batch groups it: trimmed, spacing collapsed, lower case. */
export const ownerKey = (name) => String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The originals (by quotation_no) a batch may give an owner: unowned, and
 * never deliberately unassigned.
 */
async function ownableOriginals(db, refs) {
  if (!refs.length) return new Set();
  const { rows } = await db.query(
    `SELECT q.quotation_no FROM quotations q
      WHERE q.quotation_no = ANY($1::text[]) AND q.owner_user_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM ownership_history h WHERE h.entity_type = 'quotations' AND h.entity_id = q.id)`,
    [refs]);
  return new Set(rows.map((r) => r.quotation_no));
}

/**
 * One entry per salesperson name on the batch:
 *   { key, name, rows, matched_user_id, choice, owner_user_id, owner_name, status }
 * status is 'matched', 'chosen', 'unassigned' or 'undecided'.
 */
export async function batchOwners(db, { owner_map: ownerMap = {}, items = [] }) {
  const deals = items.filter((it) => it.step === 'quotation' && it.included && it.parent_included !== false);
  const ownable = await ownableOriginals(db, [...new Set(deals.filter((it) => it.action !== 'create' && it.existing_ref).map((it) => it.existing_ref))]);

  const names = new Map();
  for (const it of deals) {
    if (it.action !== 'create' && !ownable.has(it.existing_ref)) continue;
    const raw = it.payload?.sales_person;
    const key = ownerKey(raw);
    const entry = names.get(key) || { key, name: key ? String(raw).trim().replace(/\s+/g, ' ') : null, rows: 0, sample: raw };
    entry.rows += 1;
    names.set(key, entry);
  }
  if (!names.size) return [];

  const { rows: users } = await db.query("SELECT id, btrim(name) AS name FROM users WHERE active AND role = 'sales'");
  const byId = new Map(users.map((u) => [u.id, u]));
  const map = ownerMap && typeof ownerMap === 'object' ? ownerMap : {};

  const out = [];
  for (const n of [...names.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    const matched = n.key ? await ownerForSalesperson(db, { name: n.sample }) : null;
    // A choice naming somebody who is no longer an active sales user no
    // longer counts: the name is undecided again.
    const choice = Object.hasOwn(map, n.key) && (map[n.key] === null || byId.has(map[n.key])) ? map[n.key] : undefined;
    const owner = choice !== undefined ? choice : matched;
    const status = choice === null ? 'unassigned'
      : choice !== undefined ? (choice === matched ? 'matched' : 'chosen')
        : matched ? 'matched' : users.length ? 'undecided' : 'unassigned';
    const { sample, ...entry } = n;
    out.push({
      ...entry,
      matched_user_id: matched,
      choice,
      owner_user_id: owner ?? null,
      owner_name: owner ? byId.get(owner)?.name ?? null : null,
      status,
    });
  }
  return out;
}

/** The names still waiting for an admin's answer. */
export const undecidedOwners = (owners) => (owners || []).filter((o) => o.status === 'undecided');

/** A sentence naming them, for a refused commit. */
export const undecidedMessage = (undecided) =>
  `Choose an owner for ${undecided.length} salesperson name${undecided.length === 1 ? '' : 's'} on the sheet first: ${undecided.map((o) => o.name ?? '(no salesperson)').join(', ')}.`;

/** name key -> owner id (or null), for the commit. */
export const ownerLookup = (owners) => {
  const map = new Map((owners || []).map((o) => [o.key, o.owner_user_id ?? null]));
  return (salesPerson) => map.get(ownerKey(salesPerson)) ?? null;
};
