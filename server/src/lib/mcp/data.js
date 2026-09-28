/**
 * What the MCP tools read and write (#50). Every function takes the token's
 * scope: an admin sees everything; a sales token sees only records whose
 * sales person is the token's person. The scope is applied in SQL, never by
 * filtering results afterwards.
 */
import { query, transaction } from '../../db.js';
import { RATES } from '../salesReport.js';
import { businessToday } from '../businessDate.ts';
import { wake } from '../inbox.js';
import { recordVisibleSql } from '../scope.js';
import { dataQuality } from '../dataQuality.js';
import { BUCKETS, payablesSummary } from '../payables.js';

const isAdmin = (scope) => scope.role === 'admin';

/** A WHERE fragment and its parameter for "this record belongs to the token's person". */
function own(scope, column, params) {
  if (isAdmin(scope)) return 'TRUE';
  params.push(scope.person);
  return `lower(btrim(${column})) = lower(btrim($${params.length}))`;
}
function ownCompany(scope, companyColumn, params) {
  if (isAdmin(scope)) return 'TRUE';
  params.push(scope.person);
  const p = `$${params.length}`;
  return `(EXISTS (SELECT 1 FROM quotations oq WHERE oq.company_id = ${companyColumn} AND lower(btrim(oq.sales_person)) = lower(btrim(${p})))
        OR EXISTS (SELECT 1 FROM enquiries oe WHERE oe.company_id = ${companyColumn} AND lower(btrim(oe.sales_person)) = lower(btrim(${p})))
        OR EXISTS (SELECT 1 FROM projects op WHERE op.company_id = ${companyColumn} AND lower(btrim(op.sales_person)) = lower(btrim(${p}))))`;
}

/**
 * How much of a list one call returns.
 *
 * These defaulted to 200 and allowed 1,000, and the result was pretty-printed
 * JSON. Fifty-one open deals measured 24 KB that way — roughly six thousand
 * tokens — so the default alone could spend a fifth of a context window, and
 * the ceiling could spend all of it. A caller that wants more now asks for
 * the next page instead of a bigger page.
 */
export const PAGE = { default: 25, max: 100 };
export const page = ({ limit, offset } = {}) => ({
  limit: Math.min(Math.max(Number(limit) || PAGE.default, 1), PAGE.max),
  offset: Math.max(Number(offset) || 0, 0),
});

/**
 * count(*) OVER () rides along on the rows we are already fetching, so the
 * total costs no second query. It is the same for every row, hence [0].
 */
const paged = (rows, { limit, offset }) => {
  const total = rows.length ? Number(rows[0].total_rows) : 0;
  for (const r of rows) delete r.total_rows;
  return { items: rows, total, offset, limit, has_more: offset + rows.length < total };
};

export async function searchRecords(scope, { text, types = ['company', 'quotation', 'enquiry', 'project', 'purchase_order'], limit = 10 }) {
  // Per type, not overall: five types at 20 was up to a hundred rows for a
  // word somebody was still narrowing down.
  const like = `%${String(text).trim()}%`;
  const out = [];
  if (types.includes('company')) {
    const params = [like];
    const { rows } = await query(`SELECT 'company' AS type, id::text AS id, name AS title, sector AS detail FROM companies c WHERE (name ILIKE $1 OR gstin ILIKE $1) AND ${ownCompany(scope, 'c.id', params)} ORDER BY name LIMIT ${limit}`, params);
    out.push(...rows);
  }
  if (types.includes('quotation')) {
    const params = [like];
    const { rows } = await query(`SELECT 'quotation' AS type, quotation_no AS id, client_name AS title, concat_ws(' · ', service_quoted, status) AS detail FROM quotations q
                                   WHERE (quotation_no ILIKE $1 OR client_name ILIKE $1 OR service_quoted ILIKE $1) AND ${own(scope, 'q.sales_person', params)} ORDER BY quotation_date DESC NULLS LAST LIMIT ${limit}`, params);
    out.push(...rows);
  }
  if (types.includes('enquiry')) {
    const params = [like];
    const { rows } = await query(`SELECT 'enquiry' AS type, enquiry_no AS id, client_name AS title, concat_ws(' · ', service, status) AS detail FROM enquiries e
                                   WHERE (enquiry_no ILIKE $1 OR client_name ILIKE $1 OR service ILIKE $1) AND ${own(scope, 'e.sales_person', params)} ORDER BY created_at DESC LIMIT ${limit}`, params);
    out.push(...rows);
  }
  if (types.includes('project')) {
    const params = [like];
    const { rows } = await query(`SELECT 'project' AS type, project_id AS id, client_name AS title, primary_service AS detail FROM projects p
                                   WHERE (project_id ILIKE $1 OR client_name ILIKE $1 OR primary_service ILIKE $1) AND ${own(scope, 'p.sales_person', params)} ORDER BY project_id DESC LIMIT ${limit}`, params);
    out.push(...rows);
  }
  if (types.includes('purchase_order')) {
    const params = [like];
    const { rows } = await query(`SELECT 'purchase_order' AS type, po.po_number AS id, p.client_name AS title, po.project_id AS detail FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id
                                   WHERE (po.po_number ILIKE $1 OR p.client_name ILIKE $1) AND ${own(scope, 'p.sales_person', params)} ORDER BY po.po_date DESC NULLS LAST LIMIT ${limit}`, params);
    out.push(...rows);
  }
  // An object, not a bare array: the wire format wants one, and a count the
  // caller can see beats a list that stops without saying it has.
  return { results: out, count: out.length, per_type_limit: limit };
}

export async function getCompany(scope, id) {
  const params = [Number(id)];
  const { rows: [c] } = await query(`SELECT id, name, sector, gstin, city, website, last_contacted_at FROM companies c WHERE id = $1 AND ${ownCompany(scope, 'c.id', params)}`, params);
  if (!c) return null;
  const [contacts, deals, outstanding, activity] = await Promise.all([
    query('SELECT name, role, email, phone, is_billing, do_not_contact, last_contacted_at FROM contacts WHERE company_id = $1 ORDER BY name', [c.id]),
    query(`SELECT q.quotation_no, q.service_quoted, q.status, ps.name AS stage, q.probability, q.quotation_value, q.currency, q.expected_close_date, q.next_step, q.sales_person, q.last_contacted_at
             FROM quotations q LEFT JOIN pipeline_stages ps ON ps.id = q.stage_id WHERE q.company_id = $1 AND ps.type IN ('open','paused') ORDER BY q.quotation_date DESC`, [c.id]),
    query(`SELECT s.currency, SUM(s.stage_amount - s.amount_received) AS outstanding, COUNT(*) FILTER (WHERE s.stage_status = 'Overdue')::int AS overdue_invoices
             FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
            WHERE p.company_id = $1 AND s.invoice_no IS NOT NULL AND s.stage_status <> 'Paid' GROUP BY s.currency`, [c.id]),
    listActivity(scope, 'company', String(c.id), { limit: 15 }),
  ]);
  // The rows, not the page envelope: recent_activity on a company is a
  // short list, and its total and offset would mean nothing embedded here.
  return { ...c, contacts: contacts.rows, open_deals: deals.rows, outstanding: outstanding.rows, recent_activity: activity?.items ?? [] };
}

export async function getQuotation(scope, no) {
  const params = [no];
  const { rows: [q] } = await query(`SELECT quotation_no, revision, quotation_date, valid_until, client_name, company_id, contact_person, service_quoted, status, stage, probability,
                                            quotation_value, currency, subtotal, tax_total, total, sales_person, expected_close_date, next_step, sent_at, accepted_at, accepted_by_name,
                                            approval_status, lost_reason, competitor, project_id, last_contacted_at
                                       FROM v_quotations q WHERE quotation_no = $1 AND ${own(scope, 'q.sales_person', params)}`, params);
  if (!q) return null;
  // Every column qualified: quotations carries discount_percent too (the
  // approval flow puts it there), so the unqualified list was ambiguous and
  // this query threw on every call. get_quotation has never returned a
  // quotation; the caller only ever saw the sanitised "could not do that".
  const { rows: lines } = await query('SELECT ql.description, ql.qty, ql.unit, ql.rate, ql.discount_percent, ql.gst_rate, ql.amount FROM quotation_lines ql JOIN quotations x ON x.id = ql.quotation_id WHERE x.quotation_no = $1 ORDER BY ql.sort_order, ql.id', [no]);
  const { rows: pos } = await query('SELECT po_number, po_date, po_value, currency FROM purchase_orders WHERE quotation_no = $1', [no]);
  return { ...q, lines, purchase_orders: pos };
}

export async function getProject(scope, id) {
  const params = [id];
  const { rows: [p] } = await query(`SELECT project_id, client_name, company_id, primary_service, project_manager, sales_person, planned_start_date, planned_delivery_date, project_stage, payment_status,
                                            total_contract_value, total_invoiced, total_received, balance_due_now, actual_delivery_date, onboarding_done, onboarding_total
                                       FROM v_projects p WHERE project_id = $1 AND ${own(scope, 'p.sales_person', params)}`, params);
  if (!p) return null;
  const { rows: pos } = await query('SELECT po_number, po_date, po_value, currency, actual_delivery_date FROM purchase_orders WHERE project_id = $1 ORDER BY po_date', [id]);
  const { rows: visits } = await query(`SELECT title, type, status, starts_at, ends_at, city FROM visits WHERE project_id = $1 AND status IN ('planned','confirmed') ORDER BY starts_at`, [id]);
  return { ...p, purchase_orders: pos, upcoming_visits: visits };
}

export async function getPo(scope, no) {
  const params = [no];
  const { rows: [po] } = await query(`SELECT v.* FROM v_purchase_orders v JOIN projects p ON p.project_id = v.project_id WHERE v.po_number = $1 AND ${own(scope, 'p.sales_person', params)}`, params);
  if (!po) return null;
  const { rows: stages } = await query(`SELECT stage_no, stage_name, trigger_event, stage_amount, stage_status, invoice_no, invoice_date, invoice_due_date, amount_received, days_overdue FROM v_payment_stages WHERE po_number = $1 ORDER BY stage_no`, [no]);
  return { ...po, stages };
}

export async function listPipeline(scope, { stage, owner, from, to, limit, offset } = {}) {
  const win = page({ limit, offset });
  const params = [];
  const where = ["ps.type IN ('open','paused')", own(scope, 'q.sales_person', params)];
  if (stage) { params.push(`%${stage}%`); where.push(`ps.name ILIKE $${params.length}`); }
  if (owner && isAdmin(scope)) { params.push(owner); where.push(`lower(q.sales_person) = lower($${params.length})`); }
  if (from) { params.push(from); where.push(`q.expected_close_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`q.expected_close_date <= $${params.length}`); }
  const { rows } = await query(
    `SELECT count(*) OVER () AS total_rows,
            q.quotation_no, q.client_name, q.service_quoted, ps.name AS stage, q.probability, q.quotation_value AS value, q.currency,
            round(COALESCE(q.quotation_value, 0) * q.probability / 100.0, 2) AS weighted_value, q.expected_close_date, q.sales_person AS owner,
            q.next_step, q.last_contacted_at, q.stage_changed_at
       FROM quotations q JOIN pipeline_stages ps ON ps.id = q.stage_id
      WHERE ${where.join(' AND ')} ORDER BY ps.sort_order, q.expected_close_date NULLS LAST LIMIT ${win.limit} OFFSET ${win.offset}`, params);
  const p = paged(rows, win);
  // Totals cover this page, and say so. A per-currency total over 25 of 200
  // deals read like the pipeline until it was labelled.
  const totals = {};
  for (const r of p.items) {
    totals[r.currency] ||= { deals: 0, value: 0, weighted: 0 };
    totals[r.currency].deals += 1; totals[r.currency].value += Number(r.value || 0); totals[r.currency].weighted += Number(r.weighted_value || 0);
  }
  return { deals: p.items, totals_this_page: totals, total: p.total, offset: p.offset, limit: p.limit, has_more: p.has_more };
}

export async function listCollections(scope, { overdue_only: overdueOnly = true, min_days: minDays = 0, limit, offset } = {}) {
  const win = page({ limit, offset });
  const params = [];
  const where = ['s.invoice_no IS NOT NULL', "s.stage_status <> 'Paid'", own(scope, 'p.sales_person', params)];
  if (overdueOnly) where.push(`s.stage_status = 'Overdue'`);
  if (minDays) { params.push(Number(minDays)); where.push(`s.days_overdue >= $${params.length}`); }
  const { rows } = await query(
    `SELECT count(*) OVER () AS total_rows, s.id AS stage_id, s.invoice_no, s.invoice_date, s.invoice_due_date, s.days_overdue, s.client_name, s.po_number, s.stage_name,
            s.stage_amount, s.amount_received, (s.stage_amount - s.amount_received) AS outstanding, s.currency, s.stage_status,
            s.reminder_level, s.on_hold, s.promise_to_pay_date, p.sales_person AS owner,
            (SELECT json_agg(json_build_object('at', l.happened_at, 'channel', l.channel, 'summary', l.summary, 'promise_to_pay', l.promise_to_pay_date) ORDER BY l.happened_at DESC) FROM (SELECT * FROM collection_log cl WHERE cl.stage_id = s.id ORDER BY cl.happened_at DESC LIMIT 5) l) AS recent_chasing
       FROM v_payment_stages s JOIN purchase_orders po ON po.po_number = s.po_number JOIN projects p ON p.project_id = po.project_id
      WHERE ${where.join(' AND ')} ORDER BY s.days_overdue DESC NULLS LAST LIMIT ${win.limit} OFFSET ${win.offset}`, params);
  return paged(rows, win);
}

export async function getKpis(scope, { from, to, person } = {}) {
  const who = isAdmin(scope) ? person || null : scope.person;
  const start = from || `${businessToday().slice(0, 4)}-01-01`;
  const end = to || businessToday();
  const params = [start, end, who];
  const { rows: [k] } = await query(
    `WITH ${RATES},
     q AS (
       SELECT q.*, ps.type AS stage_type, q.quotation_value * r.rate AS value_inr
         FROM quotations q LEFT JOIN pipeline_stages ps ON ps.id = q.stage_id LEFT JOIN rates r ON r.currency = q.currency
        WHERE ($3::text IS NULL OR lower(btrim(q.sales_person)) = lower(btrim($3)))
     )
     SELECT
       COUNT(*) FILTER (WHERE quotation_date BETWEEN $1 AND $2)::int AS quotations_issued,
       COALESCE(SUM(value_inr) FILTER (WHERE quotation_date BETWEEN $1 AND $2), 0) AS quoted_value_inr,
       COUNT(*) FILTER (WHERE stage_type = 'won' AND closed_at::date BETWEEN $1 AND $2)::int AS won,
       COALESCE(SUM(value_inr) FILTER (WHERE stage_type = 'won' AND closed_at::date BETWEEN $1 AND $2), 0) AS won_value_inr,
       COUNT(*) FILTER (WHERE stage_type = 'lost' AND closed_at::date BETWEEN $1 AND $2)::int AS lost,
       COUNT(*) FILTER (WHERE stage_type IN ('open','paused'))::int AS open_deals,
       COALESCE(SUM(value_inr * probability / 100.0) FILTER (WHERE stage_type = 'open'), 0) AS weighted_pipeline_inr,
       round(AVG(EXTRACT(EPOCH FROM (closed_at - created_at)) / 86400) FILTER (WHERE stage_type = 'won' AND closed_at::date BETWEEN $1 AND $2))::int AS avg_days_to_win,
       COUNT(*) FILTER (WHERE value_inr IS NULL AND quotation_value IS NOT NULL)::int AS without_exchange_rate
     FROM q`, params);
  const { rows: [t] } = await query(
    `SELECT COUNT(*)::int AS touches FROM communications WHERE started_at::date BETWEEN $1 AND $2 AND ($3::text IS NULL OR company_id IN (SELECT company_id FROM quotations WHERE lower(btrim(sales_person)) = lower(btrim($3))))`, params);
  const decided = k.won + k.lost;
  return { period: { from: start, to: end }, person: who || 'everyone', ...k, win_rate_percent: decided ? Math.round((100 * k.won) / decided) : null, touches_logged: t.touches, definitions: KPI_DEFINITIONS };
}

export const KPI_DEFINITIONS = {
  quotations_issued: 'Quotations dated in the period.',
  quoted_value_inr: 'Their value in rupees, at the exchange rates in Settings; a currency with no rate is left out and counted in without_exchange_rate.',
  won: 'Quotations that reached Won (PO received) in the period.',
  lost: 'Quotations marked Lost in the period.',
  win_rate_percent: 'Won divided by won plus lost, for the period.',
  open_deals: 'Quotations open or on hold now, whatever their date.',
  weighted_pipeline_inr: 'Open quotations now, each value times its stage probability.',
  avg_days_to_win: 'Average days from a quotation being entered to it being won, for wins in the period.',
  touches_logged: 'Calls, WhatsApp chats and meetings logged in the period on the person\'s clients.',
};

export async function listActivity(scope, entity, id, { limit, offset } = {}) {
  // The record itself must be visible to the token first.
  if (!(await canSee(scope, entity, id))) return null;
  const win = page({ limit, offset });
  const { rows } = await query(
    `SELECT count(*) OVER () AS total_rows, * FROM (
       SELECT 'note' AS kind, created_at AS at, body AS text, author AS by FROM notes WHERE entity = $1 AND entity_id = $2
       UNION ALL SELECT 'task', t.created_at, concat_ws(' · ', t.title, t.status, 'due ' || t.due_at), t.created_by FROM tasks t
         WHERE EXISTS (SELECT 1 FROM task_targets tt WHERE tt.task_id = t.id AND tt.entity = $1 AND tt.entity_id = $2)
       UNION ALL SELECT 'touch', started_at, concat_ws(' · ', channel, outcome, summary), username FROM communications WHERE (entity = $1 AND entity_id = $2) OR ($1 = 'company' AND company_id::text = $2)
       UNION ALL SELECT 'email', last_message_at, concat_ws(' · ', subject, message_count || ' messages'), NULL FROM email_threads WHERE (entity = $1 AND entity_id = $2) OR ($1 = 'company' AND company_id::text = $2)
     ) x ORDER BY at DESC NULLS LAST LIMIT ${win.limit} OFFSET ${win.offset}`, [entity, String(id)]);
  return paged(rows, win);
}

export async function canSee(scope, entity, id) {
  if (isAdmin(scope)) return true;
  const params = [String(id)];
  // Only the query for this entity is built, so only its parameter is added.
  const build = {
    company: () => `SELECT 1 FROM companies c WHERE c.id::text = $1 AND ${ownCompany(scope, 'c.id', params)}`,
    quotation: () => `SELECT 1 FROM quotations q WHERE q.quotation_no = $1 AND ${own(scope, 'q.sales_person', params)}`,
    enquiry: () => `SELECT 1 FROM enquiries e WHERE e.enquiry_no = $1 AND ${own(scope, 'e.sales_person', params)}`,
    project: () => `SELECT 1 FROM projects p WHERE p.project_id = $1 AND ${own(scope, 'p.sales_person', params)}`,
    purchase_order: () => `SELECT 1 FROM purchase_orders po JOIN projects p ON p.project_id = po.project_id WHERE po.po_number = $1 AND ${own(scope, 'p.sales_person', params)}`,
  }[entity];
  const sql = build && build();
  if (!sql) return false;
  const { rowCount } = await query(sql, params);
  return rowCount > 0;
}

// ------------------------------------------------------------ guarded writes

const actor = (token) => `${token.person || token.name} (via MCP)`;

export async function createTask(scope, token, { entity, id, title, due_on: dueOn, assignee }) {
  if (!(await canSee(scope, entity, id))) return null;
  const { rows: [t] } = await query(
    `INSERT INTO tasks (entity, entity_id, title, due_at, assignee, created_by, type) VALUES ($1,$2,$3,$4,$5,$6,'follow_up') RETURNING id, title, due_at, status`,
    [entity, String(id), title, dueOn || null, assignee || token.person || null, actor(token)]);
  return t;
}

export async function addNote(scope, token, { entity, id, text }) {
  if (!(await canSee(scope, entity, id))) return null;
  const { rows: [n] } = await query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [entity, String(id), text, actor(token)]);
  return n;
}

export async function logTouch(scope, token, { entity, id, channel, outcome, summary, contact_name: contactName }) {
  if (!['company', 'quotation', 'enquiry', 'project'].includes(entity) || !(await canSee(scope, entity, id))) return null;
  const { resolveParties } = await import('../../routes/communications.js');
  const parties = await resolveParties(entity, id);
  let contactId = parties.contact_id || null;
  if (contactName && parties.company_id) {
    const { rows: [c] } = await query('SELECT id, do_not_contact FROM contacts WHERE company_id = $1 AND lower(name) = lower($2)', [parties.company_id, contactName]);
    if (c) contactId = c.id;
  }
  const { rows: [row] } = await query(
    `INSERT INTO communications (channel, direction, outcome, entity, entity_id, company_id, contact_id, username, summary, provider)
     VALUES ($1,'outbound',$2,$3,$4,$5,$6,$7,$8,'mcp') RETURNING id, started_at`,
    [channel, outcome || null, entity, String(id), parties.company_id || null, contactId, actor(token), summary || null]);
  return row;
}

export async function updateNextStep(scope, token, { quotation_no: no, next_step: nextStep, expected_close_date: close }) {
  if (!(await canSee(scope, 'quotation', no))) return null;
  return transaction(async (db) => {
    const { rows: [q] } = await db.query(
      `UPDATE quotations SET next_step = $2, expected_close_date = COALESCE($3, expected_close_date) WHERE quotation_no = $1 RETURNING quotation_no, next_step, expected_close_date`,
      [no, nextStep, close || null]);
    await db.query(`INSERT INTO notes (entity, entity_id, body, author) VALUES ('quotation', $1, $2, $3)`, [no, `Next step set: ${nextStep}${close ? ` (close by ${close})` : ''}`, actor(token)]);
    return q;
  });
}

// ---------------------------------------------------------------- inbox

/**
 * Conversations in the shared inbox, the ones due soonest first.
 *
 * Only what the list screen shows: who wrote, about what, whose it is, and
 * whether it is late. No message bodies. A mailbox's owner chooses what the
 * team may see of it, and that choice is applied once at ingest — `subject`
 * here is already whatever they allowed, and a tool reading bodies would
 * have to re-apply the rest of that rule. A rule applied in two places is a
 * rule that will eventually be applied in one.
 */
export async function listInbox(scope, { status, unanswered_only: unansweredOnly = false, limit, offset } = {}) {
  // Nothing else brings a snoozed conversation back — there is no job, only
  // whoever asks for a list next. Both Inbox routes do this; a reader that
  // does not is a reader that quietly under-reports the queue.
  await wake();
  const win = page({ limit, offset });
  const params = [];
  const where = [status ? null : "c.status IN ('open','pending_client')"].filter(Boolean);
  if (status) { params.push(status); where.push(`c.status = $${params.length}`); }
  // Nobody has answered since the client last wrote. NULL means no message
  // has been classified yet, which is also nobody's reply.
  if (unansweredOnly) where.push("(t.last_direction = 'inbound' OR t.last_direction IS NULL)");
  if (!isAdmin(scope)) {
    // The rule the Inbox page applies: a conversation is yours if the inbox
    // is open to everyone, you are a member of it, it is unassigned, or it
    // is assigned to you. The page matches two identities (sign-in name and
    // full name); a token carries one person, so this matches that one.
    //
    // The membership test is an unnest rather than `&&`, because `&&` is
    // case-sensitive element equality and `inboxes.members` is free text
    // typed into a settings field headed "Names, comma separated" — so it
    // holds {Asha Kumar}, and comparing it against a lowercased array
    // matched nothing at all. That disjunct was dead for every member whose
    // name has a capital letter in it, and a member of an inbox was quietly
    // told there was nothing in it. Both sides are folded here; the Inbox
    // page compares raw and has the same latent hole from the other side.
    params.push(scope.person || '');
    const p = `$${params.length}`;
    where.push(`(i.members = '{}'
      OR EXISTS (SELECT 1 FROM unnest(i.members) m WHERE lower(btrim(m)) = lower(btrim(${p})))
      OR c.assignee IS NULL OR lower(c.assignee) = lower(${p}))`);
  }
  const { rows } = await query(
    `SELECT count(*) OVER () AS total_rows,
            c.id, c.status, c.priority, c.assignee, c.from_name, c.from_email, c.enquiry_no,
            t.subject, t.last_message_at, t.message_count, t.last_direction,
            co.name AS company, i.name AS inbox, c.response_due_at,
            (c.status = 'open' AND c.response_due_at IS NOT NULL AND c.response_due_at < now()) AS overdue
       FROM inbox_conversations c
       JOIN inboxes i ON i.id = c.inbox_id
       JOIN email_threads t ON t.id = c.thread_id
       LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.response_due_at NULLS LAST, t.last_message_at DESC NULLS LAST, c.id
      LIMIT ${win.limit} OFFSET ${win.offset}`, params);
  return paged(rows, win);
}

// ------------------------------------------------------------- payables

/**
 * What we owe travel vendors, longest overdue first, with the bucket
 * summary beside the page so the totals are the whole debt and not just
 * this page of it.
 *
 * Reads v_vendor_invoice_ageing, the view the Payables page and its CSV
 * read, so the three agree by construction. Vendor bills are in rupees;
 * nothing here mixes currencies.
 *
 * Not scoped by person, which is what the page does: a travel vendor's bill
 * belongs to the company, and there is no ownership column to scope it by.
 * If #89 settles that money is finance-only, this is one of the surfaces
 * that decision has to reach.
 */
export async function listPayables(scope, { bucket, limit, offset } = {}) {
  const win = page({ limit, offset });
  const params = [];
  const where = [];
  if (bucket) { params.push(bucket); where.push(`bucket = $${params.length}`); }
  const [{ rows }, summary] = await Promise.all([
    // The same ORDER BY as payablesRows(), tiebreak included: pay_by is the
    // month end, so two bills invoiced in one month share it and share a
    // days_overdue, and without invoice_date they can come back in a
    // different order than the page shows them.
    query(
      `SELECT count(*) OVER () AS total_rows,
              vendor_invoice_no, travel_vendor, employee_name, client_name, travel_id,
              invoice_date, invoice_amount, amount_paid, outstanding, pay_by,
              payment_status, days_overdue, bucket
         FROM v_vendor_invoice_ageing
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY days_overdue DESC, pay_by NULLS LAST, invoice_date NULLS LAST, vendor_invoice_id
        LIMIT ${win.limit} OFFSET ${win.offset}`, params),
    payablesSummary(),
  ]);
  return { ...paged(rows, win), ...summary, currency: 'INR' };
}

/**
 * The bucket names, so the tool's accepted values are the page's buckets
 * rather than a second list that can drift from them.
 */
export const PAYABLE_BUCKETS = BUCKETS;

// ------------------------------------------------------------ data gaps

/**
 * What is missing, and where to go and fix it.
 *
 * The same checks the Data quality page runs, filtered to the ones that
 * currently find something. Counts rather than rows, because the question
 * this answers — what is blocking invoicing this week — is answered by a
 * number with a name on it. `fix_at` is the page that lists exactly those
 * rows, which is where somebody goes to clear them.
 */
export async function listDataGaps() {
  const checks = await dataQuality();
  const blocking = checks.filter((c) => Number(c.count) > 0);
  return {
    gaps: blocking.map(({ key, label, count, link }) => ({ key, label, count: Number(count), fix_at: link })),
    total_gaps: blocking.reduce((n, c) => n + Number(c.count), 0),
    checks_run: checks.length,
    all_clear: blocking.length === 0,
  };
}

// ---------------------------------------------------------------- tasks

/**
 * Open tasks, soonest due first.
 *
 * create_task could add one and nothing could read it back, which made the
 * write half of this server write-only. A sales token sees tasks assigned
 * to it or raised by it; an admin token sees everyone's.
 */
export async function listTasks(scope, { assignee, overdue_only: overdueOnly = false, limit, offset } = {}) {
  const win = page({ limit, offset });
  const params = [];
  const where = ["t.status <> 'done'"];
  if (overdueOnly) where.push('t.due_at IS NOT NULL AND t.due_at < CURRENT_DATE');
  // Naming somebody else's tasks is an admin's to do; a sales token asking
  // for them gets its own, which is what its scope says it may see.
  if (assignee && isAdmin(scope)) { params.push(assignee); where.push(`lower(btrim(t.assignee)) = lower(btrim($${params.length}))`); }
  if (!isAdmin(scope)) where.push(mine(scope, params));
  const { rows } = await query(
    `SELECT count(*) OVER () AS total_rows,
            t.id, t.title, t.description, t.status, t.priority, t.type, t.assignee, t.created_by,
            t.due_at::text AS due_on, (t.due_at IS NOT NULL AND t.due_at < CURRENT_DATE) AS overdue,
            t.entity, t.entity_id
       FROM tasks t
      WHERE ${where.join(' AND ')}
      ORDER BY t.due_at NULLS LAST, t.id
      LIMIT ${win.limit} OFFSET ${win.offset}`, params);
  return paged(rows, win);
}

/**
 * A task is a sales token's if it is assigned to it, was raised by it, or
 * sits on a record it can see. That third one was missing, and its absence
 * reopened exactly the hole list_tasks was written to close: create_task
 * gates on canSee, so a token could add a task to its own quotation,
 * delegate it to a colleague, and never see it again.
 *
 * The second one was broken too. Writes are stamped "<person> (via MCP)" so
 * the timeline says where they came from, and an exact comparison against
 * the person's name never equals that — so a token could not even find the
 * tasks it had raised itself. The stamp is stripped before comparing.
 */
function mine(scope, params) {
  params.push(scope.person || '');
  const p = `$${params.length}`;
  params.push([String(scope.person || '').trim().toLowerCase()]);
  const ids = `$${params.length}::text[]`;
  const raisedBy = `regexp_replace(t.created_by, '\\s*\\(via MCP\\)$', '', 'i')`;
  return `(lower(btrim(t.assignee)) = lower(btrim(${p}))
    OR lower(btrim(${raisedBy})) = lower(btrim(${p}))
    OR ${recordVisibleSql('t.entity', 't.entity_id', ids)})`;
}

/**
 * Mark a task done — the only thing this server may change about a task.
 *
 * Reads first, then writes: a task this token may not see returns null, so
 * it cannot learn an id exists by being refused it, and a task already done
 * says so rather than erroring. Calling it twice is calling it once. Who
 * completed it is in api_token_log, which every MCP call writes; tasks
 * itself has no column for it and the web app does not record one either.
 */
export async function completeTask(scope, { task_id: id }) {
  const params = [Number(id)];
  const visible = isAdmin(scope) ? 'TRUE' : mine(scope, params);
  const { rows: [t] } = await query(
    `SELECT t.id, t.title, t.status, t.assignee, t.entity, t.entity_id, t.completed_at
       FROM tasks t WHERE t.id = $1 AND ${visible}`, params);
  if (!t) return null;
  if (t.status === 'done') return { ...t, already_done: true };
  const { rows: [done] } = await query(
    `UPDATE tasks SET status = 'done', completed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING id, title, status, completed_at, assignee, entity, entity_id`, [t.id]);
  return { ...done, already_done: false };
}
