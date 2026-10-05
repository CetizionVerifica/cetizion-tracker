/**
 * Who may see which sales record (#18 Phase 2C).
 *
 * One rule, stated once, and every query that can reach an enquiry, a
 * quotation or a project asks this module rather than deciding for itself:
 *
 *   admin, or the legacy shared login   every row
 *   a database sales user               rows they own
 *   nobody                              rows owned by nobody
 *
 * The last line is the one worth saying out loud. An unowned record is not
 * public — it is a record whose owner could not be determined (Phase 2B
 * leaves those null on purpose), and the safe reading of "we do not know
 * whose this is" is "not yours". Admins see them; that is how they get
 * assigned.
 *
 * Why this is a module and not an `if` in each route: there are about
 * twenty places that can return one of these rows — lists, details,
 * exports, lookups, the dashboard, company and project composites,
 * documents, four report builders — and a scoping rule that is written
 * twenty times is a rule with twenty chances to be written wrong. Worse,
 * the failure is silent: a missed predicate does not break a test that
 * nobody wrote, it just quietly serves somebody else's pipeline.
 *
 * Every predicate here is parameterised. No id is ever interpolated.
 */
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';

/** The column carrying ownership, on all three scoped tables. */
export const OWNER_COLUMN = 'owner_user_id';

/** The tables this applies to. Nothing else is scoped by ownership. */
export const OWNER_SCOPED_TABLES = ['enquiries', 'quotations', 'projects'];

/**
 * How a record is named when one table points at another by (entity, id)
 * text instead of by a foreign key — the timeline, the touch log and the
 * notes/tasks/attachments tables all address records that way.
 *
 * The convention is not invented here. It is the one main's own code
 * already reads: resolveParties() in routes/communications.js and
 * recordEvents() in routes/timeline.js both look a record up by its natural
 * key where it has one (enquiry_no, quotation_no, project_id, po_number)
 * and by its serial id where it does not. This table says the same thing
 * once, so a caller does not have to know it.
 *
 *   shared        master data nobody owns. A client's name and sector are
 *                 not one salesperson's secret — /api/companies is open to
 *                 anybody signed in, and a gate here that disagreed with it
 *                 would only be inconsistent, not safer.
 *   parent 'own'  the table carries owner_user_id itself.
 *   parent <kind> ownership comes from the record above; see parentClause.
 */
export const ENTITY_RECORDS = {
  company: { shared: true },
  contact: { shared: true },
  enquiry: { relation: 'enquiries', key: 'enquiry_no', parent: 'own', label: 'Enquiry' },
  quotation: { relation: 'quotations', key: 'quotation_no', parent: 'own', label: 'Quotation' },
  project: { relation: 'projects', key: 'project_id', parent: 'own', label: 'Project' },
  purchase_order: { relation: 'purchase_orders', key: 'po_number', parent: 'purchase_order', label: 'Purchase order' },
  payment_stage: { relation: 'payment_stages', key: 'id', parent: 'via_po', label: 'Payment stage' },
};

/**
 * Does this request see everything?
 *
 * Shared mode counts. It is the legacy single administrator and there is no
 * users row behind it, so there is no owner id to compare against — and
 * inventing one would be inventing a person. The transition depends on the
 * shared admin keeping full access until the cutover is done.
 */
export function isUnrestricted(user) {
  return user?.mode === 'shared' || user?.role === 'admin';
}

/**
 * The scope for one request.
 *
 * @returns {{ unrestricted: boolean, ownerId: number|null }}
 * @throws {ApiError} 401 when there is no user — every scoped route is
 *   behind requireAuth, so that is a wiring mistake, and the safe way for
 *   one to surface is a refused request rather than an unscoped query.
 */
export function ownershipScope(user) {
  if (!user) throw new ApiError(401, 'Your session has ended — sign in again');
  if (isUnrestricted(user)) return { unrestricted: true, ownerId: null };

  // A database sales user. No id means the session is not what it claims
  // to be; refusing beats falling through to "see everything".
  if (user.mode !== 'database' || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new ApiError(403, 'You do not have access to this');
  }
  return { unrestricted: false, ownerId: user.id };
}

/**
 * The scope for work that belongs to no one in particular — a scheduled job,
 * a migration, a report built outside a request. Global by design: the
 * payment reminders go to every client with an overdue invoice, not to one
 * salesperson's. Library functions default to this, and every route passes a
 * real scope instead.
 */
export const UNRESTRICTED = Object.freeze({ unrestricted: true, ownerId: null });

/** The scope for a request, straight from Express. */
export const scopeOf = (req) => ownershipScope(req.user);

/**
 * A SQL predicate restricting a scoped table to what this request may see,
 * or '' when it may see everything.
 *
 * Pushes its value onto `params` so the caller's numbering stays correct.
 *
 *   const params = [];
 *   const mine = ownerClause(scope, params, { alias: 'q' });
 *   `SELECT … FROM v_quotations q ${mine ? `WHERE ${mine}` : ''}`
 *
 * `owner_user_id = $n` excludes unowned rows on its own: NULL = anything is
 * never true. That is the intended reading, not an accident of SQL, and it
 * is why there is no special case for null here.
 */
export function ownerClause(scope, params, { alias = '', column = OWNER_COLUMN } = {}) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  const qualified = alias ? `${alias}.${column}` : `"${column}"`;
  return `${qualified} = $${params.length}`;
}

/**
 * The same restriction for a table that has no owner of its own but hangs
 * off one that does — a purchase order under its quotation, a payment stage
 * under its purchase order, a document under whichever row references it.
 *
 * Expressed as EXISTS rather than a join so it can be dropped into an
 * existing query without changing its shape, its grouping or its row count.
 *
 * @param link  SQL joining the parent to the outer row, e.g.
 *              `q.quotation_no = po.quotation_no`.
 */
export function derivedClause(scope, params, { table, alias = 'parent', link }) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  return `EXISTS (SELECT 1 FROM ${table} ${alias}
                   WHERE ${link} AND ${alias}.${OWNER_COLUMN} = $${params.length})`;
}

/**
 * A purchase order has no owner of its own. It belongs to whoever owns the
 * quotation it fulfils, or the project it sits under — either is enough,
 * because both are the same piece of work seen from a different table.
 *
 * The same parameter is referenced twice on purpose; one value, two places.
 */
export function purchaseOrderClause(scope, params, { alias = 'po' } = {}) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  const n = params.length;
  return `(EXISTS (SELECT 1 FROM quotations pq
                    WHERE pq.quotation_no = ${alias}.quotation_no AND pq.${OWNER_COLUMN} = $${n})
       OR EXISTS (SELECT 1 FROM projects pp
                    WHERE pp.project_id = ${alias}.project_id AND pp.${OWNER_COLUMN} = $${n}))`;
}

/**
 * Whether this request may read a document.
 *
 * A document has no owner and no uploader — the table records the file and
 * nothing about who put it there. Visibility is therefore derived from
 * whatever points at it: a quotation, a purchase order, a payment stage, a
 * quotation acceptance, a project cost or a deliverable. You may read the
 * file if you may read the record it belongs to.
 *
 * The last three arrived after this rule was first written: a quotation's
 * acceptance PDF, a cost receipt, a project's issued deliverable. Each
 * reaches its owner through a declared foreign key, so leaving them out kept
 * nothing safe — it made a salesperson's own file unreadable to them and
 * readable only to an admin.
 *
 * `attachments` names its parent as (entity, entity_id) text rather than by
 * a foreign key. That is not a guess: ENTITY_RECORDS above writes down the
 * convention main's own resolveParties() and recordEvents() already read, so
 * a file attached that way reaches its owner the same way every other row
 * addressed that way does.
 *
 * A document nothing references is **not** readable by a sales user. "No
 * parent" means ownership is unknown, and the rule for unknown ownership is
 * admin-only — the same answer an unassigned record gets. Treating it as
 * public would make the transient window between upload and save a way to
 * read anybody's file by guessing a serial id.
 *
 * Nothing needs that window. The upload endpoint returns the document's own
 * metadata, and the form puts the returned id straight into the record it
 * then saves; the only GET the app makes is for a document already attached
 * to a record it has loaded. So this costs no working flow, and it closes
 * the gap without a schema change.
 */
export function documentClause(scope, params, { alias = 'd' } = {}) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  const n = params.length;
  return `(
       EXISTS (SELECT 1 FROM quotations dq
                WHERE dq.document_id = ${alias}.id AND dq.${OWNER_COLUMN} = $${n})
    OR EXISTS (SELECT 1 FROM purchase_orders dpo
                WHERE dpo.document_id = ${alias}.id
                  AND (EXISTS (SELECT 1 FROM quotations pq
                                WHERE pq.quotation_no = dpo.quotation_no AND pq.${OWNER_COLUMN} = $${n})
                    OR EXISTS (SELECT 1 FROM projects pp
                                WHERE pp.project_id = dpo.project_id AND pp.${OWNER_COLUMN} = $${n})))
    OR EXISTS (SELECT 1 FROM payment_stages dps
                JOIN purchase_orders spo ON spo.po_number = dps.po_number
               WHERE dps.document_id = ${alias}.id
                 AND (EXISTS (SELECT 1 FROM quotations pq2
                               WHERE pq2.quotation_no = spo.quotation_no AND pq2.${OWNER_COLUMN} = $${n})
                   OR EXISTS (SELECT 1 FROM projects pp2
                               WHERE pp2.project_id = spo.project_id AND pp2.${OWNER_COLUMN} = $${n})))
    OR EXISTS (SELECT 1 FROM quotation_acceptances dqa
                JOIN quotations aq ON aq.id = dqa.quotation_id
               WHERE dqa.pdf_document_id = ${alias}.id AND aq.${OWNER_COLUMN} = $${n})
    OR EXISTS (SELECT 1 FROM project_costs dpc
                JOIN projects cp ON cp.project_id = dpc.project_id
               WHERE dpc.document_id = ${alias}.id AND cp.${OWNER_COLUMN} = $${n})
    OR EXISTS (SELECT 1 FROM attachments dat
               WHERE dat.document_id = ${alias}.id AND ${entityCase('dat', n)})
    OR EXISTS (SELECT 1 FROM deliverables ddl
               WHERE ddl.document_id = ${alias}.id
                 AND (EXISTS (SELECT 1 FROM projects dp
                               WHERE dp.project_id = ddl.project_id AND dp.${OWNER_COLUMN} = $${n})
                   OR EXISTS (SELECT 1 FROM purchase_orders dpo2
                               WHERE dpo2.po_number = ddl.po_number
                                 AND (EXISTS (SELECT 1 FROM quotations pq3
                                               WHERE pq3.quotation_no = dpo2.quotation_no AND pq3.${OWNER_COLUMN} = $${n})
                                   OR EXISTS (SELECT 1 FROM projects pp3
                                               WHERE pp3.project_id = dpo2.project_id AND pp3.${OWNER_COLUMN} = $${n})))))
  )`;
}

/**
 * Rows that carry no owner of their own and take it from the record above
 * them — a purchase order under its quotation or project, a payment stage
 * or a PO service line under its purchase order.
 *
 * `purchase_order` reads the alias's own quotation_no and project_id, both
 * of which exist on purchase_orders and on v_purchase_orders, so the same
 * clause serves a read from the view and a write to the table. `via_po`
 * reads po_number, which payment_stages, po_services and both of their
 * views all carry.
 *
 * The others each read one declared foreign key: `quotation` reads
 * quotation_id (quotation_lines), `project` reads project_id
 * (project_costs), `via_stage` reads stage_id (payments). Every one of them
 * is a real column with a real reference, which is why they are here and
 * why the polymorphic entity/entity_id tables — tasks, notes, attachments —
 * are not: their parent is named in text, by a convention this module would
 * have to guess at.
 */
/**
 * The predicate for a row that names its parent as (entity, entity_id) text
 * rather than by a foreign key — a task, a note, an attachment.
 *
 * Built from ENTITY_RECORDS, so the rule lives in one place and a kind added
 * there is covered here without anybody remembering to. Only the entity
 * *names* are written into the SQL and they are this module's own constants,
 * never anything a client sent; every id stays a parameter.
 *
 * `ELSE false` is the important line. A row whose entity is none of the
 * known kinds has an ownership this module cannot work out, and the rule for
 * ownership it cannot work out is admin-only — the same answer an unassigned
 * record gets. The CHECK constraint on those tables makes it unreachable
 * today; it is here so that stays true if the constraint ever widens.
 *
 * Takes the parameter index rather than pushing, so a caller that already
 * pushed the owner id (documentClause) references the same one.
 */
function entityCase(alias, n, { sharedAs = 'true' } = {}) {
  const poOwned = (po) => `(EXISTS (SELECT 1 FROM quotations eq
                                     WHERE eq.quotation_no = ${po}.quotation_no AND eq.${OWNER_COLUMN} = $${n})
                         OR EXISTS (SELECT 1 FROM projects ep
                                     WHERE ep.project_id = ${po}.project_id AND ep.${OWNER_COLUMN} = $${n}))`;
  const branches = Object.entries(ENTITY_RECORDS).map(([entity, def]) => {
    // Master data is everybody's: a note on a company is not one
    // salesperson's, the same as the company itself is not. A caller for
    // whom "on a company" is not a reason to see the row (an email thread,
    // mailboxClause below) says so with sharedAs.
    if (def.shared) return `WHEN '${entity}' THEN ${sharedAs}`;
    const match = `x.${def.key}${def.key === 'id' ? '::text' : ''} = ${alias}.entity_id`;
    if (def.parent === 'own') {
      return `WHEN '${entity}' THEN EXISTS (SELECT 1 FROM ${def.relation} x
                WHERE ${match} AND x.${OWNER_COLUMN} = $${n})`;
    }
    if (def.parent === 'purchase_order') {
      return `WHEN '${entity}' THEN EXISTS (SELECT 1 FROM ${def.relation} x
                WHERE ${match} AND ${poOwned('x')})`;
    }
    return `WHEN '${entity}' THEN EXISTS (SELECT 1 FROM ${def.relation} x
              JOIN purchase_orders epo ON epo.po_number = x.po_number
             WHERE ${match} AND ${poOwned('epo')})`;
  });
  return `CASE ${alias}.entity
  ${branches.join('\n  ')}
  ELSE false
END`;
}

export function parentClause(scope, params, { kind, alias }) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  const n = params.length;
  const poOwned = (po) => `(EXISTS (SELECT 1 FROM quotations pq
                                     WHERE pq.quotation_no = ${po}.quotation_no AND pq.${OWNER_COLUMN} = $${n})
                         OR EXISTS (SELECT 1 FROM projects pp
                                     WHERE pp.project_id = ${po}.project_id AND pp.${OWNER_COLUMN} = $${n}))`;
  if (kind === 'purchase_order') return poOwned(alias);
  if (kind === 'via_po') {
    return `EXISTS (SELECT 1 FROM purchase_orders ppo
                     WHERE ppo.po_number = ${alias}.po_number AND ${poOwned('ppo')})`;
  }
  // A quotation's own priced lines (#23). quotation_id is a declared foreign
  // key, so there is nothing to infer: the line belongs to whoever owns the
  // quotation it prices, and the rate and discount on it are exactly the
  // commercial detail row-level access exists to keep to one salesperson.
  if (kind === 'quotation') {
    return `EXISTS (SELECT 1 FROM quotations lq
                     WHERE lq.id = ${alias}.quotation_id AND lq.${OWNER_COLUMN} = $${n})`;
  }
  // A cost booked against a project (#33): project_id is a foreign key to
  // projects, which carries the owner.
  if (kind === 'project') {
    return `EXISTS (SELECT 1 FROM projects cp
                     WHERE cp.project_id = ${alias}.project_id AND cp.${OWNER_COLUMN} = $${n})`;
  }
  // A receipt in the payments ledger (#27). One link further down than
  // via_po: a payment hangs off a payment stage, which hangs off the
  // purchase order that carries the ownership.
  if (kind === 'via_stage') {
    return `EXISTS (SELECT 1 FROM payment_stages rps
                      JOIN purchase_orders rpo ON rpo.po_number = rps.po_number
                     WHERE rps.id = ${alias}.stage_id AND ${poOwned('rpo')})`;
  }
  // A row that names its parent in text: tasks, notes, attachments.
  if (kind === 'entity') return entityCase(alias, n);
  // A task, which main lets stand on several records at once (task_targets,
  // #22). Any one of those records being reachable makes the task reachable,
  // because the task genuinely hangs off it — the same parent rule, applied
  // to each parent. It grants nothing on the *other* records it names: those
  // are reached, or not, through their own ownership.
  if (kind === 'task_entity') {
    return `(${entityCase(alias, n)}
      OR EXISTS (SELECT 1 FROM task_targets tt
                  WHERE tt.task_id = ${alias}.id AND ${entityCase('tt', n)}))`;
  }
  // The same, but "a record they own" rather than "a record they may
  // reach": shared master data does not count. My Today asks this of an
  // unassigned task (docs/my-today-plan.md) — one on a company would
  // otherwise be on every salesperson's list at once.
  if (kind === 'task_owned') {
    return `(${entityCase(alias, n, { sharedAs: 'false' })}
      OR EXISTS (SELECT 1 FROM task_targets tt
                  WHERE tt.task_id = ${alias}.id AND ${entityCase('tt', n, { sharedAs: 'false' })}))`;
  }
  throw new Error(`Unknown ownership parent: ${kind}`);
}

/**
 * The predicate for one resource, whichever way it carries ownership.
 * '' when the resource is not ownership-scoped, or the caller is an admin.
 */
export function resourceClause(def, scope, params, { alias = '' } = {}) {
  if (def.ownerScoped) return ownerClause(scope, params, { alias });
  if (def.ownerScopedBy) {
    // A parent-derived clause has to name columns on the relation the
    // statement reads or writes, so the caller says which that is.
    if (!alias) throw new Error('A parent-derived scope needs the relation it applies to.');
    return parentClause(scope, params, { kind: def.ownerScopedBy, alias: `"${alias}"` });
  }
  return '';
}

/**
 * The scoped tables and views, each as a drop-in replacement for its own
 * name in a FROM clause.
 *
 *   const params = [];
 *   const src = scopedSources(scope, params);
 *   `SELECT count(*) FROM ${src.quotations} q WHERE …`
 *
 * For an admin every entry is just the view's name and the query is exactly
 * the one that ran before. For a sales user it becomes a parenthesised
 * SELECT over the same view with the ownership predicate inside, which
 * substitutes cleanly wherever the bare name appeared: same columns, same
 * shape, fewer rows.
 *
 * That substitution is the point. The dashboard and the report builders are
 * long multi-CTE queries whose arithmetic is the business's own — "Due now"
 * counts raised invoices, revenue converts at the rate in force on the
 * record's date. Rewriting those queries to add a predicate risks changing
 * what they compute; replacing the table they read from cannot, because
 * every figure is still derived the same way from a narrower set of rows.
 *
 * One parameter for the whole call, referenced by every entry.
 */
export function scopedSources(scope, params) {
  const plain = {
    enquiries: 'enquiries',
    quotations: 'quotations',
    projects: 'projects',
    vQuotations: 'v_quotations',
    vProjects: 'v_projects',
    vPurchaseOrders: 'v_purchase_orders',
    vPaymentStages: 'v_payment_stages',
    purchaseOrders: 'purchase_orders',
  };
  if (scope.unrestricted) return plain;

  params.push(scope.ownerId);
  const n = params.length;
  const owned = (name) => `(SELECT * FROM ${name} WHERE ${OWNER_COLUMN} = $${n})`;
  // A purchase order or a payment stage has no owner; both belong to the
  // quotation or project above them.
  const viaParent = (name, alias) => `(SELECT * FROM ${name} ${alias}
     WHERE EXISTS (SELECT 1 FROM quotations pq
                    WHERE pq.quotation_no = ${alias}.quotation_no AND pq.${OWNER_COLUMN} = $${n})
        OR EXISTS (SELECT 1 FROM projects pp
                    WHERE pp.project_id = ${alias}.project_id AND pp.${OWNER_COLUMN} = $${n}))`;

  // A payment stage carries its project but not its quotation, so it reaches
  // the quotation through the purchase order it belongs to.
  const stages = `(SELECT * FROM v_payment_stages sps
     WHERE EXISTS (SELECT 1 FROM projects sp
                    WHERE sp.project_id = sps.project_id AND sp.${OWNER_COLUMN} = $${n})
        OR EXISTS (SELECT 1 FROM purchase_orders spo2
                    JOIN quotations sq2 ON sq2.quotation_no = spo2.quotation_no
                   WHERE spo2.po_number = sps.po_number AND sq2.${OWNER_COLUMN} = $${n}))`;

  return {
    enquiries: owned('enquiries'),
    quotations: owned('quotations'),
    projects: owned('projects'),
    vQuotations: owned('v_quotations'),
    vProjects: owned('v_projects'),
    vPurchaseOrders: viaParent('v_purchase_orders', 'spo'),
    vPaymentStages: stages,
    purchaseOrders: viaParent('purchase_orders', 'bpo'),
  };
}

/**
 * The statement that answers "may this request reach this record?", or null
 * when the question does not arise — an admin, or shared master data.
 *
 * Separate from the assertion below so the SQL can be read and tested
 * without a database, the same as every other predicate in this module.
 */
export function recordReachableSql(scope, entity, id) {
  const def = ENTITY_RECORDS[entity];
  if (!def) throw new Error(`Unknown record kind: ${entity}`);
  if (def.shared || scope.unrestricted) return null;
  const params = [String(id)];
  const mine = def.parent === 'own'
    ? ownerClause(scope, params, { alias: 'r' })
    : parentClause(scope, params, { kind: def.parent, alias: 'r' });
  return {
    label: def.label,
    params,
    sql: `SELECT 1 FROM ${def.relation} r WHERE r.${def.key}::text = $1 AND ${mine}`,
  };
}

/**
 * Refuse a record this request may not reach, whichever table it is in.
 *
 * One gate in front of a composite response is worth more than a predicate
 * on each of its parts: the timeline reads seven tables about one record,
 * and a rule applied in six of them is not a rule. Gate the record, and
 * everything hanging off it follows.
 *
 * 404, like every other ownership refusal, so asking about a record does
 * not confirm that it exists.
 */
export async function assertRecordReachable(scope, entity, id, db = null) {
  const probe = recordReachableSql(scope, entity, id);
  if (!probe) return;
  const run = db?.query ? (text, values) => db.query(text, values) : query;
  const { rowCount } = await run(probe.sql, probe.params);
  if (!rowCount) throw new ApiError(404, `${probe.label} not found`);
}

/** Fold a clause into a list of others, skipping the empty admin case. */
export function andClause(clauses, clause) {
  if (clause) clauses.push(clause);
  return clauses;
}

/**
 * `WHERE …` for a scoped read, or '' when unrestricted and there is nothing
 * else to say.
 */
export function whereFrom(clauses) {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

/**
 * The owner a newly created record should carry.
 *
 * A sales user owns what they enter — that is the only assignment rule this
 * phase is confident about, and it needs no screen. An admin, or the shared
 * login, creates a record with no owner: guessing which salesperson an
 * admin meant is the same mistake Phase 2B refused to make in bulk, and an
 * unowned record is visibly unassigned rather than wrongly assigned.
 *
 * Never taken from the request body. `owner_user_id` is not in any
 * resource's writable columns, so a client cannot propose one at all; this
 * is the only thing that writes it on create.
 */
export function ownerForNewRecord(user) {
  const scope = ownershipScope(user);
  return scope.unrestricted ? null : scope.ownerId;
}

/**
 * Who may see which mailbox, and which email thread
 * (docs/per-user-mailboxes-plan.md §2, §4.2).
 *
 *   admin, or the legacy shared login   every mailbox, every thread
 *   a sales user                        mailboxes where user_id = me,
 *                                       plus shared mailboxes (read only)
 *                                       threads in those mailboxes,
 *                                       plus threads on a record they own
 *
 * One helper, and `routes/mailboxes.js`, `routes/timeline.js` and anything
 * else that returns mail ask it. Before this the rule was string matching
 * on `connected_accounts.username` against the caller's name or email,
 * written in one route file and not written at all in the timeline, which
 * showed a salesperson the subjects of colleagues' personal threads.
 *
 *   read        a mailbox the caller may read mail from: their own, or a
 *               shared one. The shared inbox stays the team's.
 *   administer  a mailbox the caller may change, sync or disconnect: their
 *               own only. Shared mailboxes are an admin's to run.
 *
 * '' when unrestricted, like every other predicate here.
 */
export function mailboxClause(scope, params, { alias = 'a', kind = 'read' } = {}) {
  if (scope.unrestricted) return '';
  params.push(scope.ownerId);
  const n = params.length;
  if (kind === 'administer') return `${alias}.user_id = $${n}`;
  if (kind === 'read') return `(${alias}.user_id = $${n} OR (${alias}.is_shared AND ${inboxMemberOrOpen(alias, n)}))`;
  throw new Error(`Unknown mailbox access kind: ${kind}`);
}

/**
 * A shared mailbox that feeds a team Inbox with named members is those
 * members' (docs/inbox-outlook-plan.md §1, §3.2); one with no members, or
 * no Inbox, is the whole team's. Members are typed names or addresses, so
 * the signed-in user is matched on both, as routes/inbox.js matches them.
 */
/**
 * A typed name or address matches one of several, whatever its case or
 * surrounding spaces. The one spelling of the Inbox's member test, used
 * here and in routes/inbox.js, so the two cannot drift apart again.
 */
export const namedIn = (expr, candidates) => `lower(btrim(${expr})) IN (${candidates.map((c) => `lower(${c})`).join(', ')})`;

const inboxMemberOrOpen = (alias, n) => `NOT EXISTS (
  SELECT 1 FROM inboxes mi WHERE mi.account_id = ${alias}.id AND mi.active AND mi.members <> '{}'
     AND NOT EXISTS (SELECT 1 FROM unnest(mi.members) mm JOIN users mu ON mu.id = $${n}
                      WHERE ${namedIn('mm', ['mu.email', 'mu.name'])}))`;

/**
 * The thread's conversation in the team Inbox is the caller's, or nobody's
 * yet — the same rule the Inbox page lists by (routes/inbox.js inboxScope):
 * an unassigned conversation is there for anybody to pick up.
 */
const inboxAssignee = (threadAlias, n) => `EXISTS (
  SELECT 1 FROM inbox_conversations mc JOIN users mu ON mu.id = $${n}
   WHERE mc.thread_id = ${threadAlias}.id AND (mc.assignee IS NULL OR ${namedIn('mc.assignee', ['mu.email', 'mu.name'])}))`;

/**
 * "threads this caller may read": the mailboxes above, plus a thread that
 * sits on a record they own — the client's reply about your own deal is
 * yours to see whichever mailbox it landed in. Ownership is owner_user_id,
 * through the same entity convention every other (entity, entity_id) table
 * uses; an email thread's entity is never a company, and a thread on
 * nothing is reachable only through its mailbox.
 *
 * Reading only. Replying stays on `mailboxClause`: a reply leaves from the
 * mailbox and lands in its Sent Items, and seeing a thread and speaking as
 * somebody else are different questions.
 */
export function threadClause(scope, params, { accountAlias = 'a', threadAlias = 't' } = {}) {
  if (scope.unrestricted) return '';
  const mailbox = mailboxClause(scope, params, { alias: accountAlias, kind: 'read' });
  return `(${mailbox} OR ${inboxAssignee(threadAlias, params.length)} OR ${entityCase(threadAlias, params.length, { sharedAs: 'false' })})`;
}
