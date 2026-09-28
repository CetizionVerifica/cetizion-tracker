/**
 * Spotting and folding together one client spelt twice (#20), without the
 * HTTP around it.
 *
 * Lifted out of routes/companies.js so the MCP server can offer the same
 * two things (#139). They belong together and apart: finding look-alikes
 * costs nothing and is open to everybody, while folding one company into
 * another rewrites the client name on every quotation, enquiry and project
 * it owns and then deletes a row, with no undo.
 *
 * similarName suggests; a person decides. Nothing here merges on its own,
 * and nothing that imports records is allowed to call the merge.
 */
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { ACTIONS, logActivity } from './activity.js';
import { compact, similarNamePairs } from './names.ts';

const weight = (c) => c.quotations + c.projects + c.enquiries;

/**
 * Companies that look like one client spelt more than once, as groups.
 *
 * This used to return pairs, and pairs are the wrong unit. Five spellings
 * of Hindalco made ten rows, each offering a merge, several of them
 * contradicting each other — "fold A into B" sat next to "fold B into C" —
 * and the reader had to hold the whole graph in their head to see that it
 * was one client. Worse, doing them in the order shown did not converge:
 * the third merge referred to a company the second had already deleted.
 *
 * One group per client instead, so the question is the one a person can
 * actually answer: of these four spellings, which is the real one?
 *
 * A group is not a claim that its members are one company. Matching is not
 * transitive — bare "Hindalco" matches both "Hindalco - Belur" and
 * "Hindalco FRP", which do not match each other and are two plants — so a
 * group is "these names share a brand", and which of them are really one
 * client is the reader's call. The exception is a group whose names are
 * identical once punctuation is removed — there is nothing to weigh up
 * there.
 */
export async function duplicateCompanies() {
  const { rows } = await query('SELECT id, name, sector, quotations, projects, enquiries FROM v_companies ORDER BY name');

  // Union-find: every company starts alone, and each match joins two
  // groups. What comes out is one group per client however many spellings
  // reached it, and no pair can contradict another because there are no
  // longer any pairs.
  //
  // The pairs come from similarNamePairs rather than a double loop, which
  // files each name under what a match would have to share and compares
  // only names filed together — 77 companies is 2,926 comparisons the long
  // way and 500 would be 125,000, on every page load. Same answer, because
  // the same alike() still decides each candidate.
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (x, y) => { const rx = find(x); const ry = find(y); if (rx !== ry) parent.set(rx, ry); };

  for (const [i, j] of similarNamePairs(rows.map((r) => r.name))) union(rows[i].id, rows[j].id);

  const groups = new Map();
  for (const r of rows) {
    const root = find(r.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }

  return [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => {
      // Most history first: that is the spelling the others would move onto,
      // and the one a reader recognises.
      const sorted = [...members].sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name));
      // companies.name_key is UNIQUE, so two rows can never hold the same
      // name once case and spacing are normalised — a group of literally
      // identical names is not a thing that can exist. What can, and what
      // is just as clearly one client, is the same name punctuated two
      // ways: "Hindalco-Belur" beside "Hindalco - Belur". That is the case
      // with nothing to weigh up.
      const keys = new Set(members.map((m) => compact(m.name)));
      const sameName = keys.size === 1;
      return {
        members: sorted.map((m) => ({ ...m, records: weight(m) })),
        suggested_keep: sorted[0].id,
        size: members.length,
        records: members.reduce((n, m) => n + weight(m), 0),
        // A group is built by joining up matches, and matching is not
        // transitive: bare "Hindalco" matches "Hindalco - Belur" and
        // "Hindalco FRP", which do not match each other and are two
        // plants. So a group means "these names share a brand — are any
        // of them one client?", never "these are all the same". Only the
        // same-name case is beyond argument.
        confidence: sameName ? 'same name, punctuated differently' : 'shares a brand',
        certain: sameName,
      };
    })
    .sort((a, b) => (a.certain === b.certain ? b.size - a.size : a.certain ? -1 : 1));
}

/**
 * Fold `source` into `target`: every record and contact moves across and
 * takes the survivor's name; a contact on both sides is kept once; the
 * source company is deleted. One transaction, and the activity row that
 * records it is written inside the same one — the source is gone at the
 * end, so that row is the only remaining answer to "where did this client
 * go?" and had better not be able to go missing on its own.
 */
export async function mergeCompanies({ source, target, actor }) {
  if (target === source) throw new ApiError(422, 'A company cannot be merged into itself');
  return transaction(async (client) => {
    const { rows: [a] } = await client.query('SELECT id, name FROM companies WHERE id = $1 FOR UPDATE', [source]);
    const { rows: [b] } = await client.query('SELECT id, name FROM companies WHERE id = $1 FOR UPDATE', [target]);
    if (!a || !b) throw new ApiError(404, 'Company not found');

    // Contacts that exist on both sides: point records at the survivor's copy, then drop the duplicate.
    await client.query(
      `UPDATE quotations q SET contact_id = t.id
         FROM contacts s JOIN contacts t
           ON t.company_id = $2 AND name_key(t.name) = name_key(s.name)
        WHERE s.company_id = $1 AND q.contact_id = s.id`, [source, target]);
    await client.query(
      `UPDATE enquiries e SET contact_id = t.id
         FROM contacts s JOIN contacts t
           ON t.company_id = $2 AND name_key(t.name) = name_key(s.name)
        WHERE s.company_id = $1 AND e.contact_id = s.id`, [source, target]);
    await client.query(
      `DELETE FROM contacts s WHERE s.company_id = $1
          AND EXISTS (SELECT 1 FROM contacts t WHERE t.company_id = $2 AND name_key(t.name) = name_key(s.name))`, [source, target]);
    await client.query('UPDATE contacts SET company_id = $2 WHERE company_id = $1', [source, target]);

    // Records move and take the survivor's spelling; the link trigger sees the new name and keeps the link.
    const counts = {};
    for (const table of ['quotations', 'enquiries', 'projects']) {
      const { rowCount } = await client.query(`UPDATE ${table} SET company_id = $2, client_name = $3 WHERE company_id = $1`, [source, target, b.name]);
      counts[table] = rowCount;
    }
    await client.query('DELETE FROM companies WHERE id = $1', [source]);

    // Filed against the surviving company, because that is the one somebody
    // can still look up; the company folded in survives only as its id and
    // name in the metadata.
    await logActivity(client, {
      actor,
      action: ACTIONS.COMPANY_MERGED,
      entityType: 'company',
      entityId: b.id,
      metadata: {
        source_company_id: a.id,
        source_company_name: a.name,
        target_company_id: b.id,
        target_company_name: b.name,
        moved: counts,
      },
    });
    return { merged: a.name, into: b.name, moved: counts };
  });
}
