/**
 * Feeding any kind of record in over MCP (#138).
 *
 * The sheet importer (imports.js) is clever about one shape: a sales sheet,
 * where one row becomes a quotation and, if it is won, a project, a PO, its
 * stages and an invoice beneath it. It knows nothing about the other thirty
 * tables. This is the other half — plain rows into any resource the app has
 * a form for, which is how master data, back-fills and seeding arrive.
 *
 * It writes through the resource registry, never around it: each row is
 * validated by that resource's own zod schema and written by insertRecord /
 * updateRecordRow from crud.js, the same two functions the form posts
 * through. So an import cannot accept a value a form would reject, and a
 * resource that grows a save hook grows it for both at once.
 *
 * Same two-step shape as the sheet importer, for the same reason: a bulk
 * write a model composed should be read by a person before it lands.
 * dry_run is the default and it touches nothing.
 */
import { transaction } from '../../db.js';
import { ApiError } from '../../middleware/error.js';
import { resources } from '../resources.js';
import { insertRecord, updateRecordRow, validateRecord } from '../crud.js';

/**
 * As many rows as one call may carry.
 *
 * Lower than the sheet importer's 500 because these arrive as full objects
 * with every column named, not as a narrow sheet row, so each one costs
 * several times as much of the message they travel in.
 */
export const MAX_ROWS = 200;

const isAdmin = (scope) => scope.role === 'admin';

/**
 * Bulk writing is an admin's, as it is on the Import screen. A sales token
 * creating rows straight into any table would walk around every scope the
 * rest of this server applies — it could write a quotation for somebody
 * else's client and then read it back as its own.
 */
function assertMayImport(scope) {
  if (!isAdmin(scope)) throw new ApiError(403, 'Only an admin token may import records.');
}

/**
 * Which resources may be fed this way.
 *
 * Everything the registry has a schema for, minus the ones where a plain
 * INSERT is the wrong instrument:
 *
 *   quotation-lines, payment stages and the template lines are written by
 *   their parent's own save hook, which numbers and totals them; a row
 *   pushed in beside that arrives unnumbered and unpriced.
 *
 *   notes, tasks and attachments already have their own MCP tools that
 *   stamp who wrote them and check the record is visible first.
 *
 *   exchange rates come from the rate feed, and a hand-written one is the
 *   thing fx:correction exists to undo.
 */
const NOT_BULK = new Set([
  'quotation-lines', 'payment-stages', 'payment-terms-template-lines', 'onboarding-template-lines',
  'notes', 'tasks', 'attachments', 'exchange-rates',
]);

export const importable = () => Object.keys(resources).filter((k) => !NOT_BULK.has(k) && resources[k].schema);

/** A resource's fields, so a caller can shape rows without guessing. */
export function describeEntity(scope, { entity } = {}) {
  assertMayImport(scope);
  if (!entity) {
    return {
      entities: importable().map((name) => ({ name, label: resources[name].label || name, key: naturalKeyOf(name) })),
      not_bulk: [...NOT_BULK],
      note: 'Call again with an entity to see its fields. Rows are objects keyed by field name.',
    };
  }
  const def = mustHave(entity);
  const shape = def.schema.shape || {};
  return {
    entity,
    label: def.label || entity,
    match_on: naturalKeyOf(entity),
    fields: Object.entries(shape).map(([name, f]) => ({
      name,
      required: !f.safeParse(undefined).success,
      // The schema's own message is what a form would show, so a caller
      // reads the same sentence a person would.
      says: describeField(f),
    })),
  };
}

function describeField(f) {
  const bad = f.safeParse('__probe__');
  if (bad.success) return 'text';
  const issue = bad.error.issues[0];
  const allowed = issue?.values || issue?.options;
  if (Array.isArray(allowed)) return `one of: ${allowed.join(', ')}`;
  return issue?.message || 'value';
}

function mustHave(entity) {
  const def = resources[entity];
  if (!def || NOT_BULK.has(entity) || !def.schema) {
    throw new ApiError(422, `"${entity}" cannot be imported. Call describe_entity with no arguments for the list.`);
  }
  return def;
}

/**
 * What decides a row is already here.
 *
 * The resource's own natural key where it has one — a PO number, a project
 * id — because that is the identifier the business already uses. Otherwise
 * the first thing in its schema that reads like a name, which is what makes
 * a second import of the same company list update rather than duplicate.
 */
function naturalKeyOf(entity) {
  const def = resources[entity];
  if (def?.naturalKey) return def.naturalKey;
  for (const col of ['name', 'code', 'title']) if (def?.columns?.includes(col)) return col;
  return null;
}

/**
 * Plan, and optionally write, a batch of rows.
 *
 * Every row is validated first and the whole batch is reported before
 * anything is written, so a caller sees all thirty mistakes at once rather
 * than the first one thirty times. The batch is one transaction and one
 * bad row stops all of it: half an imported client list, with no record of
 * which half, is worse than none of it.
 */
export async function importRecords(scope, token, { entity, rows, dry_run: dryRun = true, match_on: matchOn, update_existing: updateExisting = true }) {
  assertMayImport(scope);
  const def = mustHave(entity);
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(422, 'Send at least one row.');
  if (rows.length > MAX_ROWS) {
    throw new ApiError(422, `That is ${rows.length} rows; this takes up to ${MAX_ROWS} at a time. Send it in parts.`);
  }
  const key = matchOn === null ? null : matchOn || naturalKeyOf(entity);
  if (key && !def.columns.includes(key)) {
    throw new ApiError(422, `"${key}" is not a field of ${entity}. Call describe_entity to see its fields.`);
  }

  // Validate everything before touching the database, so a rejected batch
  // costs nothing and a caller learns about every bad row in one reply.
  const checked = rows.map((row, i) => {
    try {
      const { values, input } = validateRecord(def, row, { partial: false });
      return { at: i + 1, ok: true, values, input, key: key ? row[key] ?? null : null };
    } catch (err) {
      return { at: i + 1, ok: false, why: err.extra?.fields || { _: err.message }, key: key ? row[key] ?? null : null };
    }
  });
  const bad = checked.filter((r) => !r.ok);

  const report = (results) => ({
    entity,
    matched_on: key,
    rows_sent: rows.length,
    created: results.filter((r) => r.action === 'create').length,
    updated: results.filter((r) => r.action === 'update').length,
    rejected: bad.length,
    dry_run: Boolean(dryRun),
    rows: results.slice(0, 50),
    rows_shown: Math.min(results.length, 50),
    next: dryRun
      ? (bad.length ? 'Fix the rejected rows, then call again with dry_run: false. Nothing has been written.'
        : 'Nothing has been written. Call again with dry_run: false to write it.')
      : 'Written.',
  });

  // A dry run still looks the rows up, because "would this create or update?"
  // is most of what the caller is asking.
  const lookup = async (client, value) => {
    if (!key || value === null || value === undefined || value === '') return null;
    const { rows: [found] } = await client.query(
      `SELECT id FROM "${def.table.replace(/"/g, '')}" WHERE lower(btrim("${key.replace(/"/g, '')}"::text)) = lower(btrim($1::text)) LIMIT 1`,
      [String(value)]);
    return found?.id ?? null;
  };

  return transaction(async (client) => {
    const results = [];
    for (const r of checked) {
      if (!r.ok) { results.push({ at: r.at, action: 'rejected', key: r.key, why: r.why }); continue; }
      const existing = await lookup(client, r.key);
      if (existing && !updateExisting) { results.push({ at: r.at, action: 'skipped', key: r.key, id: existing, why: 'already here' }); continue; }
      const action = existing ? 'update' : 'create';
      if (dryRun) { results.push({ at: r.at, action, key: r.key, id: existing }); continue; }

      if (def.stampActor && !r.values[def.stampActor]) r.values[def.stampActor] = `${token.person || token.name} (via MCP)`;
      const written = existing
        ? await updateRecordRow(client, def, existing, { values: r.values, input: r.input })
        : await insertRecord(client, def, { values: r.values, input: r.input });
      results.push({ at: r.at, action, key: r.key, id: written?.row?.id ?? existing });
    }
    const out = report(results);
    // A dry run must leave nothing behind, and the cheapest way to be sure
    // of that is to never commit it — the lookups above ran in here too.
    if (dryRun) throw new Rollback(out);
    // One bad row stops the batch, the same rule the sheet importer commits
    // under. Writing the good rows and reporting the rest sounds helpful and
    // is not: the caller is left holding a half-imported list with no record
    // of which half, and re-sending the whole thing is then the only safe
    // move. Refusing costs one more round trip and nothing else.
    if (bad.length) {
      throw new Rollback({
        ...out,
        created: 0,
        updated: 0,
        next: `${bad.length} row(s) were refused, so nothing was written. Fix them and send the batch again.`,
      });
    }
    return out;
  }).catch((err) => {
    if (err instanceof Rollback) return err.report;
    throw err;
  });
}

/** Carries the report back out of the transaction that is about to roll back. */
class Rollback extends Error {
  constructor(report) { super('rolled back'); this.report = report; }
}
