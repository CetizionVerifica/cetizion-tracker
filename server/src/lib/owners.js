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
import { compact, normalizeName, similarNamePairs } from './names.ts';
import { changeRecordOwner } from './ownershipHistory.js';
import { resources } from './resources.js';

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
    // Something to fold means a spelling that is nobody's account and is on
    // records. Account names alone are not duplicates, even when records
    // carry them: two colleagues called alike ("Ravi Kumar", "Ravi Kumar
    // Reddy") would otherwise sit in the banner for good, now that the
    // Owner field writes exact account names. Two users called alike is for
    // the super admin portal.
    .filter((members) => members.some((m) => !m.sales_user && weight(m) > 0))
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
 * Exactly one such user, too: two accounts with one name would leave the
 * records under a name that no longer says whose they are.
 *
 * Ownership is only ever filled in, never moved: a record a sales user
 * already owns stays theirs whatever its Owner text now says, because a
 * clean-up of spellings is not the place to take records off somebody.
 * An unowned record goes to that user and nobody else, even when its Owner
 * email names a colleague: the person merging just said whose it is. It
 * goes through changeRecordOwner, so it lands in ownership_history and the
 * activity log like an explicit assignment.
 *
 * Two other places hold an owner as text and are moved with the records:
 * an engagement's owner, which a renewal quotation copies, and a sales API
 * token's person, which is the whole of what that token may read
 * (lib/mcp/data.js). Left behind, the first would bring the old spelling
 * back on the next renewal and the second would leave the token reading
 * nothing.
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
    if (users.length > 1) throw new ApiError(422, `${users.length} sales users are called ${target}. Rename one in the super admin portal, then merge`);
    const ownerId = users[0].id;

    // Another sales user's own name is a different person, never a
    // spelling to fold: merging it would rewrite their records and hand
    // their assistant token to someone else.
    const { rows: others } = await client.query(
      `SELECT btrim(name) AS name FROM users
        WHERE active AND role = 'sales' AND id <> $2
          AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = ANY($1::text[])
        ORDER BY 1`, [sources.map(normalizeName), ownerId]);
    if (others.length) {
      throw new ApiError(422, `${others.map((o) => o.name).join(', ')} ${others.length === 1 ? 'is a sales user' : 'are sales users'} in their own right, so cannot be merged into ${target}`);
    }

    const moved = {};
    let owned = 0;
    for (const table of TABLES) {
      const def = resources[table];
      const { rows } = await client.query(
        `UPDATE ${table} SET sales_person = $2 WHERE btrim(sales_person) = ANY($1::text[]) RETURNING *`,
        [sources, target]);
      moved[table] = rows.length;
      for (const row of rows) {
        if (row.owner_user_id !== null) continue;
        await changeRecordOwner(client, {
          entityType: def.table,
          // The natural key where there is one, as assignOwnerFromSalesperson does.
          entityIdOrKey: String(def.naturalKey && row[def.naturalKey] != null ? row[def.naturalKey] : row.id),
          expectedOwnerId: null,
          newOwnerId: ownerId,
          reason: `Owner set by merging ${sources.join(', ')} into ${target}`,
          actor,
        });
        owned += 1;
      }
    }

    const { rowCount: engagements } = await client.query(
      `UPDATE engagements SET owner = $2, updated_at = now() WHERE btrim(owner) = ANY($1::text[])`, [sources, target]);
    moved.engagements = engagements;
    // Matched as the token's scope matches it: ignoring case and spacing.
    const { rowCount: tokens } = await client.query(
      `UPDATE api_tokens SET person = $2
        WHERE role = 'sales' AND revoked_at IS NULL
          AND lower(regexp_replace(btrim(person), '\\s+', ' ', 'g')) = ANY($1::text[])`,
      [sources.map(normalizeName), target]);

    await logActivity(client, {
      actor,
      action: ACTIONS.OWNER_MERGED,
      entityType: 'owner',
      entityId: target,
      metadata: { from: sources, into: target, owner_user_id: ownerId, moved, owner_assigned: owned, tokens_moved: tokens },
    });
    return { merged: sources, into: target, moved, owner_assigned: owned, tokens_moved: tokens };
  });
}

/**
 * The account name of the one active sales user that `text` names, by
 * email or by name ignoring case and spacing; null for anybody else. For a
 * value that arrives as text from elsewhere, such as an inbox
 * conversation's assignee (a login), before it becomes a record's Owner.
 */
export async function ownerNameFor(db, text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const { rows } = await db.query(
    `SELECT max(btrim(name)) AS name FROM users
      WHERE active AND role = 'sales'
        AND (lower(btrim(email)) = lower($1)
             OR lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $2)
     HAVING count(*) = 1`, [value, normalizeName(value)]);
  return rows[0]?.name ?? null;
}
