/**
 * Spotting and folding together one owner written more than once, the way
 * lib/companies.js does it for clients (#20).
 *
 * The Owner on an enquiry, a quotation and a project is the free-text
 * `sales_person`, so the same person turns up as "Madhuri", "madhuri pogir"
 * and "Madhuri Pogir" — the Sales MIS import alone brought several. Every
 * report grouped by owner then shows one person as three, and a short
 * spelling never matches the sales user it means, so the record stays
 * unowned and only an admin can see it (lib/salespersonOwner.js).
 *
 * There is no owners table to fold rows of: an owner is a spelling. So a
 * merge rewrites the spelling on every record that carries it, and then
 * gives each unowned record to the sales user the new spelling names, the
 * same exact match an admin's save uses.
 *
 * As with companies, similarName suggests and a person decides. Nothing
 * here merges on its own, and nothing that imports records calls the merge.
 */
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, logActivity } from './activity.js';
import { compact, similarNamePairs } from './names.ts';
import { resources } from './resources.js';
import { assignOwnerFromSalesperson } from './salespersonOwner.js';

/** The records that name an owner, in the order a merge reports them. */
const TABLES = ['enquiries', 'quotations', 'projects'];

const weight = (o) => o.enquiries + o.quotations + o.projects;

/**
 * Owners that look like one person written more than once, as groups.
 *
 * Each member is one spelling exactly as the records carry it (trimmed),
 * because "madhuri pogir" and "Madhuri Pogir" are two spellings to fold even
 * though the list filters already treat them as one. Active sales users join
 * in by their account name even when no record carries it yet: that is the
 * spelling a merge should usually land on, because it is the one that makes
 * the person the records' owner.
 *
 * A group is "these names share a name", never "these are one person":
 * "Ravi" matches "Ravi Kumar" and "Ravi Shankar", who do not match each
 * other and may be two people. Only names identical once case, spacing and
 * punctuation are removed are beyond argument.
 */
export async function duplicateOwners() {
  const { rows: spellings } = await query(`
    WITH named AS (
      SELECT btrim(sales_person) AS name, 'enquiries' AS t FROM enquiries WHERE btrim(sales_person) <> ''
      UNION ALL
      SELECT btrim(sales_person), 'quotations' FROM quotations WHERE btrim(sales_person) <> ''
      UNION ALL
      SELECT btrim(sales_person), 'projects' FROM projects WHERE btrim(sales_person) <> ''
    )
    SELECT name,
           count(*) FILTER (WHERE t = 'enquiries')::int  AS enquiries,
           count(*) FILTER (WHERE t = 'quotations')::int AS quotations,
           count(*) FILTER (WHERE t = 'projects')::int   AS projects
      FROM named GROUP BY name ORDER BY name`);
  const { rows: users } = await query(
    `SELECT DISTINCT btrim(name) AS name FROM users
      WHERE active AND role = 'sales' AND btrim(name) <> ''`);
  const userNames = new Set(users.map((u) => u.name));

  const owners = spellings.map((s) => ({ ...s, sales_user: userNames.has(s.name) }));
  const seen = new Set(owners.map((o) => o.name));
  for (const name of userNames) {
    if (!seen.has(name)) owners.push({ name, enquiries: 0, quotations: 0, projects: 0, sales_user: true });
  }

  // Union-find over the matches, as duplicateCompanies does, so five
  // spellings of one person come out as one group rather than ten pairs.
  const parent = owners.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [i, j] of similarNamePairs(owners.map((o) => o.name))) {
    const ri = find(i); const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  }
  const groups = new Map();
  owners.forEach((o, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(o);
  });

  return [...groups.values()]
    .filter((members) => members.length > 1)
    // Account names alone, with no record carrying any of them, give
    // nothing to fold: two users called alike is for Settings → Users.
    .filter((members) => members.some((m) => weight(m) > 0))
    .map((members) => {
      // The sales user's own name first, because landing on it is what
      // gives the records an owner; then the spelling with most history.
      const sorted = [...members].sort((a, b) =>
        Number(b.sales_user) - Number(a.sales_user) || weight(b) - weight(a) || a.name.localeCompare(b.name));
      const sameName = new Set(members.map((m) => compact(m.name))).size === 1;
      return {
        members: sorted.map((m) => ({ ...m, records: weight(m) })),
        // Only a sales user may be kept (see mergeOwners); a group with
        // none of them leaves the choice to the reader.
        suggested_keep: sorted[0].sales_user ? sorted[0].name : null,
        size: members.length,
        records: members.reduce((n, m) => n + weight(m), 0),
        confidence: sameName ? 'same name, written differently' : 'shares a name',
        certain: sameName,
      };
    })
    .sort((a, b) => (a.certain === b.certain ? b.size - a.size : a.certain ? -1 : 1));
}

/**
 * Rewrite every record whose owner is spelt as one of `from` to `into`, and
 * give each of them that is still unowned to the sales user `into` names.
 *
 * `into` must be the name of an active sales user, as the Owner field on
 * the forms now only offers those: merging onto yet another spelling that
 * is nobody's account would fold the duplicates and still leave every
 * record unowned.
 *
 * Ownership is only ever filled in, never moved: a record a sales user
 * already owns stays theirs whatever its Owner text now says, because a
 * clean-up of spellings is not the place to take records off somebody.
 * The assignment goes through assignOwnerFromSalesperson, so it lands in
 * ownership_history and the activity log like an admin's own save.
 *
 * One transaction, with the activity row that records the merge inside it:
 * the old spellings are gone afterwards, and that row is the only place
 * that still says what they were.
 */
export async function mergeOwners({ from, into, actor }) {
  const target = String(into ?? '').trim();
  const sources = [...new Set((from ?? []).map((s) => String(s ?? '').trim()).filter(Boolean))].filter((s) => s !== target);
  if (!target) throw new ApiError(422, 'Pick the owner to keep');
  if (!sources.length) throw new ApiError(422, 'Pick at least one other spelling to merge');

  return transaction(async (client) => {
    const { rows: users } = await client.query(
      `SELECT id FROM users WHERE active AND role = 'sales' AND btrim(name) = $1`, [target]);
    if (!users.length) throw new ApiError(422, `${target} is not a sales user on the platform. Merge into one of them`);
    const moved = {};
    let owned = 0;
    for (const table of TABLES) {
      const { rows } = await client.query(
        `UPDATE ${table} SET sales_person = $2 WHERE btrim(sales_person) = ANY($1::text[]) RETURNING *`,
        [sources, target]);
      moved[table] = rows.length;
      for (const row of rows) {
        if (row.owner_user_id !== null) continue;
        const after = await assignOwnerFromSalesperson(client, resources[table], row, { fields: ['sales_person'], actor });
        if (after?.owner_user_id != null) owned += 1;
      }
    }

    await logActivity(client, {
      actor,
      action: ACTIONS.OWNER_MERGED,
      entityType: 'owner',
      entityId: target,
      metadata: { from: sources, into: target, moved, owner_assigned: owned },
    });
    return { merged: sources, into: target, moved, owner_assigned: owned };
  });
}
