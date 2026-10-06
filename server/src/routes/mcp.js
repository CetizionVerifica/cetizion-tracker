/**
 * The MCP server (#50): Claude Code, Claude Desktop and other MCP clients
 * can read the tracker and add a few guarded notes, with an API token.
 *
 *   POST /api/mcp          Streamable HTTP, stateless; Authorization: Bearer <token>
 *
 * Staff side (signed in):
 *   GET    /api/api-tokens               tokens (never their values) and recent calls
 *   POST   /api/api-tokens               { name, role, person } → the token, shown once
 *   POST   /api/api-tokens/:id/revoke
 *
 * No tool deletes anything, changes a status or moves money.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { withSupportedSchemaDialect } from '../lib/mcpSchema.js';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { requireAdmin } from '../auth/middleware.js';
import { query } from '../db.js';
import { ApiError, fromPgError } from '../middleware/error.js';
import * as data from '../lib/mcp/data.js';
import { duplicateCompanies } from '../lib/companies.js';
import * as imports from '../lib/mcp/imports.js';
import * as agg from '../lib/mcp/aggregate.js';
import * as money from '../lib/mcp/money.js';
import * as records from '../lib/mcp/records.js';

export const mcpRouter = Router();
export const apiTokenRouter = Router();

const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const ENTITY = z.enum(['company', 'quotation', 'enquiry', 'project', 'purchase_order']);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

async function authenticate(req) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(ctz_[A-Za-z0-9_-]{30,80})$/);
  if (!m) return null;
  const { rows: [t] } = await query('SELECT * FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL', [hash(m[1])]);
  if (!t) return null;
  query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [t.id]).catch(() => {});
  return t;
}

function buildServer(token) {
  const scope = { role: token.role, person: token.person };
  const server = new McpServer({ name: 'cetizion-tracker', version: '1.0.0' }, {
    instructions: `Cetizion Verifica's tracker: clients, quotations, projects, purchase orders, invoices and payments. Amounts are in the record's currency; INR totals use the exchange rates in Settings. ${token.role === 'admin' ? 'This token sees every record.' : `This token sees only records where the sales person is ${token.person} — with two deliberate exceptions, the same two the web app makes: a task assigned to it or raised by it is readable wherever it sits, and an unassigned inbox conversation is anyone's to pick up.`} ${token.can_write ? 'It may add notes and tasks, and mark a task done.' : 'It may read only: nothing it does changes a record.'} The shared inbox is readable as subjects and status only, never message bodies. Vendor payables are in rupees.`,
  });
  /**
   * The result, twice: once as text for a client that only reads content,
   * once as structuredContent for one that can use the shape.
   *
   * No indentation. `JSON.stringify(v, null, 1)` put a newline and a space
   * in front of every field of every row — fifty-one open deals measured
   * 24 KB pretty against 6.6 KB compact, and the caller pays for all of it.
   * Nothing reads this with its eyes.
   */
  const json = (v) => {
    // Serialise once and parse it back, so structuredContent is exactly what
    // the text block says — not a near-copy holding JS values that never
    // reach the wire. node-pg returns timestamptz as a Date, and validation
    // runs before serialisation, so a schema describing what the client
    // actually receives would otherwise be told it is wrong.
    const text = JSON.stringify(v);
    return { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) };
  };
  const notFound = (what) => ({ isError: true, content: [{ type: 'text', text: `${what} was not found, or this token may not see it.` }] });
  const tool = (name, description, shape, fn, { write = false, admin = false, out } = {}) => {
    // A token that may not write does not list the write tools either. An
    // MCP client reads the list and plans from it, so offering a tool it
    // will be refused is worse than not offering it. The same goes for the
    // import tools, which are an admin's on the upload screen and stay an
    // admin's here.
    if (write && !token.can_write) return;
    if (admin && token.role !== 'admin') return;
    server.registerTool(name, { description, inputSchema: shape, ...(out ? { outputSchema: out } : {}), annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write } }, async (args) => {
      try {
        const result = await fn(args);
        await query('INSERT INTO api_token_log (token_id, tool, arguments, ok) VALUES ($1,$2,$3,true)', [token.id, name, JSON.stringify(args)]);
        return result;
      } catch (err) {
        await query('INSERT INTO api_token_log (token_id, tool, arguments, ok, error) VALUES ($1,$2,$3,false,$4)', [token.id, name, JSON.stringify(args), String(err.message).slice(0, 500)]);
        // What the caller is told is either something they can act on or
        // nothing at all. A raw Postgres error names columns, constraints
        // and values, and the token log is readable by every signed-in
        // person, so the full text would sit there for all of them.
        const known = err instanceof ApiError ? err.message : fromPgError(err)?.message;
        return { isError: true, content: [{ type: 'text', text: known ? `The tracker could not do that: ${known}` : 'The tracker could not do that. An administrator can see why in the token log.' }] };
      }
    });
  };

  /**
   * What each tool gives back.
   *
   * Declaring it buys two things. A client gets a shape instead of a string
   * it has to re-parse, and the SDK validates our own output against the
   * schema and throws when it does not match — so a query that quietly
   * stops returning a column fails loudly rather than handing back a
   * narrower object nobody notices.
   *
   * Every row is a loose object on purpose. These come straight from SQL,
   * and a schema that pinned every column would turn "somebody added a
   * field" into a broken tool. Extra keys pass; the named ones are the
   * contract, and nullable because a column usually may be.
   */
  const row = (f) => z.looseObject(f);
  const str = z.string().nullable().optional();
  const num = z.number().nullable().optional();
  const pageOf = (item) => ({
    items: z.array(item),
    total: z.number().int().describe('Rows matching the filters, not rows returned'),
    offset: z.number().int(),
    limit: z.number().int(),
    has_more: z.boolean().describe('Call again with offset = offset + limit'),
  });

  tool('search_records', 'Find companies, quotations, enquiries, projects and purchase orders by name, number or service.',
    { text: z.string().min(2).describe('What to look for'), types: z.array(z.enum(['company', 'quotation', 'enquiry', 'project', 'purchase_order'])).optional(), per_type_limit: z.number().int().min(1).max(25).optional().describe('Rows per type, default 10') },
    async ({ text, types, per_type_limit: lim }) => json(await data.searchRecords(scope, { text, types, limit: lim })),
    { out: { results: z.array(row({ type: z.string(), id: z.string(), title: str, detail: str })), count: z.number().int(), per_type_limit: z.number().int() } });
  tool('get_company', 'A client with its contacts, open deals, what it owes and its recent activity.',
    { company_id: z.number().int().describe('Company id, from search_records') },
    async ({ company_id: id }) => { const r = await data.getCompany(scope, id); return r ? json(r) : notFound(`Company ${id}`); },
    { out: { name: str, contacts: z.array(row({})), open_deals: z.array(row({})), outstanding: z.array(row({})), recent_activity: z.array(row({})) } });
  tool('get_quotation', 'One quotation with its lines, stage, probability, acceptance and POs.',
    { quotation_no: z.string().describe('e.g. CTZ/QT/2026/062') },
    async ({ quotation_no: no }) => { const r = await data.getQuotation(scope, no); return r ? json(r) : notFound(`Quotation ${no}`); },
    { out: { quotation_no: str, client_name: str, status: str, lines: z.array(row({})), purchase_orders: z.array(row({})) } });
  tool('get_project', 'One project with its POs, money position and upcoming visits.',
    { project_id: z.string().describe('e.g. PRJ-2026-001') },
    async ({ project_id: id }) => { const r = await data.getProject(scope, id); return r ? json(r) : notFound(`Project ${id}`); },
    { out: { project_id: str, client_name: str, purchase_orders: z.array(row({})), upcoming_visits: z.array(row({})) } });
  tool('get_po', 'One purchase order with its payment stages and invoices.',
    { po_number: z.string() },
    async ({ po_number: no }) => { const r = await data.getPo(scope, no); return r ? json(r) : notFound(`PO ${no}`); },
    { out: { po_number: str, project_id: str, stages: z.array(row({})) } });
  tool('list_pipeline', 'Open quotations with stage, owner, value, probability, weighted value and last contact. Filter by stage name, owner (admin tokens only) and expected close dates.',
    { stage: z.string().optional(), owner: z.string().optional(), close_from: DAY.optional(), close_to: DAY.optional(), limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional().describe('Rows to skip; use has_more and total to walk the list') },
    async (a) => json(await data.listPipeline(scope, { stage: a.stage, owner: a.owner, from: a.close_from, to: a.close_to, limit: a.limit, offset: a.offset })),
    { out: { deals: z.array(row({ quotation_no: str, client_name: str, stage: str, value: num, currency: str, weighted_value: num, owner: str })),
      totals_this_page: z.record(z.string(), row({ deals: z.number(), value: z.number(), weighted: z.number() })),
      total: z.number().int(), offset: z.number().int(), limit: z.number().int(), has_more: z.boolean() } });
  tool('list_collections', 'Unpaid invoices, overdue first, with how long overdue, what is outstanding and the recent chasing.',
    { overdue_only: z.boolean().optional().describe('Default true'), min_days_overdue: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional().describe('Rows to skip; use has_more and total to walk the list') },
    async (a) => json(await data.listCollections(scope, { overdue_only: a.overdue_only ?? true, min_days: a.min_days_overdue, limit: a.limit, offset: a.offset })),
    { out: pageOf(row({ invoice_no: str, client_name: str, outstanding: num, currency: str, days_overdue: num, owner: str })) });
  tool('get_kpis', 'Sales numbers for a period: quotations issued, value, wins, losses, win rate, open and weighted pipeline, days to win, touches. Admin tokens may name a person.',
    { from: DAY.optional(), to: DAY.optional(), person: z.string().optional() },
    async (a) => json(await data.getKpis(scope, a)),
    { out: { period: row({ from: str, to: str }), person: str, win_rate_percent: num, touches_logged: num, definitions: row({}) } });
  tool('list_activity', 'Notes, tasks, logged calls and email threads on a record, newest first.',
    { entity: ENTITY, id: z.string(), limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional().describe('Rows to skip; use has_more and total to walk the list') },
    async ({ entity, id, limit, offset }) => { const r = await data.listActivity(scope, entity, id, { limit, offset }); return r ? json(r) : notFound(`${entity} ${id}`); },
    { out: pageOf(row({ kind: str, at: str, text: str, by: str })) });

  tool('list_inbox', 'Client emails in the shared inbox: who wrote, about what, whose it is and whether the reply is late. Subjects only, never message bodies. Use unanswered_only for threads where the client wrote last and nobody has answered.',
    { status: z.enum(['open', 'pending_client', 'snoozed', 'closed']).optional().describe('Default: open and pending_client together'), unanswered_only: z.boolean().optional().describe('Only threads whose last message came from the client'), limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional().describe('Rows to skip; use has_more and total to walk the list') },
    async (a) => json(await data.listInbox(scope, a)),
    { out: pageOf(row({ id: z.number().int(), subject: str, from_name: str, from_email: str, company: str, assignee: str, status: str, last_message_at: str, last_direction: str, overdue: z.boolean().nullable().optional() })) });
  tool('list_payables', 'What we owe travel vendors, longest overdue first, with the total outstanding and the count and sum in every ageing bucket. Rupees.',
    { bucket: z.enum(data.PAYABLE_BUCKETS).optional().describe('Only bills in one ageing bucket'), limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional().describe('Rows to skip; use has_more and total to walk the list') },
    async (a) => json(await data.listPayables(scope, a)),
    { out: { ...pageOf(row({ vendor_invoice_no: str, travel_vendor: str, client_name: str, outstanding: num, pay_by: str, days_overdue: num, bucket: str })),
      buckets: z.array(row({ bucket: z.string(), invoices: z.number().int(), outstanding: num })),
      total_outstanding: z.number().describe('Every bucket, not just this page'),
      amount_missing: z.number().int().describe('Bills with no amount recorded, so not in the total'),
      currency: z.string() } });
  tool('list_data_gaps', 'What is missing across the tracker and what it is blocking — quotations with no value, purchase orders with no quotation, invoiced stages with no invoice — with a count per gap and the page that lists those rows.',
    {},
    async () => json(await data.listDataGaps()),
    { out: { gaps: z.array(row({ key: z.string(), label: z.string(), count: z.number().int(), fix_at: str })), total_gaps: z.number().int(), checks_run: z.number().int(), all_clear: z.boolean() } });
  tool('list_tasks', 'Open tasks, soonest due first, with what record each is on. Admin tokens may name an assignee; a sales token gets its own.',
    { assignee: z.string().max(120).optional().describe('Admin tokens only; ignored otherwise'), overdue_only: z.boolean().optional().describe('Only tasks past their due date'), limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional().describe('Rows to skip; use has_more and total to walk the list') },
    async (a) => json(await data.listTasks(scope, a)),
    { out: pageOf(row({ id: z.number().int(), title: str, status: str, priority: str, assignee: str, due_on: str, overdue: z.boolean().nullable().optional(), entity: str, entity_id: str })) });

  tool('create_task', 'Add a follow-up task to a record. Marked as made through MCP.',
    { entity: ENTITY, id: z.string(), title: z.string().min(3).max(300), due_on: DAY.optional(), assignee: z.string().max(120).optional() },
    async (a) => { const r = await data.createTask(scope, token, a); return r ? json(r) : notFound(`${a.entity} ${a.id}`); },
    { write: true, out: { id: num, title: str, due_at: str, assignee: str, status: str } });
  tool('add_note', 'Add a note to a record\'s timeline. Marked as made through MCP.',
    { entity: ENTITY, id: z.string(), text: z.string().min(2).max(4000) },
    async (a) => { const r = await data.addNote(scope, token, a); return r ? json(r) : notFound(`${a.entity} ${a.id}`); },
    { write: true, out: { id: num, body: str, author: str } });
  tool('log_touch', 'Record a call, WhatsApp chat or meeting that already happened. It does not contact anyone.',
    { entity: z.enum(['company', 'quotation', 'enquiry', 'project']), id: z.string(), channel: z.enum(['call', 'whatsapp', 'meeting', 'email', 'other']), outcome: z.enum(['connected', 'no_answer', 'left_message', 'sent', 'held']).optional(), summary: z.string().max(4000).optional(), contact_name: z.string().max(160).optional() },
    async (a) => { const r = await data.logTouch(scope, token, a); return r ? json(r) : notFound(`${a.entity} ${a.id}`); },
    { write: true, out: { id: num, channel: str, outcome: str, started_at: str } });
  tool('update_next_step', 'Set the next step (and optionally the expected close date) on an open quotation. It does not change its stage.',
    { quotation_no: z.string(), next_step: z.string().min(2).max(500), expected_close_date: DAY.optional() },
    async (a) => { const r = await data.updateNextStep(scope, token, a); return r ? json(r) : notFound(`Quotation ${a.quotation_no}`); },
    { write: true, out: { quotation_no: str, next_step: str, expected_close_date: str } });
  tool('complete_task', 'Mark a task done. Calling it twice is calling it once: a task already done reports already_done rather than failing.',
    { task_id: z.number().int().describe('Task id, from list_tasks or create_task') },
    async (a) => { const r = await data.completeTask(scope, a); return r ? json(r) : notFound(`Task ${a.task_id}`); },
    { write: true, out: { id: num, title: str, status: str, completed_at: str, already_done: z.boolean(), entity: str, entity_id: str } });

  // ---- bulk import (#135) ------------------------------------------
  //
  // Planning writes nothing to the tracker; commit_sheet_import is the
  // only one of these that changes a record, and it will not run without
  // confirm: true. All four are admin-only, as the Import screen is.
  const STEP = z.enum(['quotation', 'project', 'purchase_order', 'service', 'stage', 'invoice', 'receipt']);
  tool('plan_sheet_import', `Read up to ${imports.MCP_MAX_ROWS} rows of a sales sheet and plan what importing them would do — quotations, projects, POs, payment stages, invoices and receipts — without writing anything. Finds duplicates already in the tracker and says, field by field, what the sheet would change. Send rows as objects keyed by the sheet's own column headings.`,
    { rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))).min(1).describe("One object per sheet row, keys are column headings e.g. {'Client Name': 'Aurora Chemicals', 'Deal Stage': 'Closed Won (100%)', 'PO Number': '4530056073'}"),
      sheet_name: z.string().max(120).optional().describe('What to call this batch in the import history'),
      rules: z.record(z.string(), z.unknown()).optional().describe('Overrides for the import assumptions, e.g. {exclude_iso: false}') },
    async (a) => json(await imports.planSheetImport(scope, token, a)),
    { write: true, admin: true, out: { batch_id: z.number().int(), status: str, sheet: str, rows_read: z.number().int(),
      steps: z.record(z.string(), row({})), duplicates: z.number().int(), assumptions: z.number().int(),
      left_out: z.number().int(), left_out_reasons: z.record(z.string(), z.number()), errors: z.number().int(),
      committed: z.boolean(), next: z.string(), needs_attention: z.array(row({ seq: z.number().int(), step: str, row: num, client: str, action: str, included: z.boolean(), existing: str, says: z.array(z.string()), assumptions: z.array(z.string()) })), needs_attention_total: z.number().int() } });
  tool('get_import_plan', 'Look at a planned import in detail, a page at a time — filter to one step, or to just the flagged, failing, duplicate or excluded rows.',
    { batch_id: z.number().int(), step: STEP.optional(), only: z.enum(['flagged', 'errors', 'duplicates', 'excluded']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Rows to return, default 25'), offset: z.number().int().min(0).optional() },
    async (a) => json(await imports.getImportPlan(scope, a)),
    { write: true, admin: true, out: { batch_id: z.number().int(), status: str, sheet: str, rows_read: z.number().int(),
      steps: z.record(z.string(), row({})), duplicates: z.number().int(), assumptions: z.number().int(),
      left_out: z.number().int(), left_out_reasons: z.record(z.string(), z.number()), errors: z.number().int(),
      committed: z.boolean(), next: z.string(), items: z.array(row({ seq: z.number().int(), step: str, row: num, client: str, action: str, included: z.boolean(), existing: str, says: z.array(z.string()), assumptions: z.array(z.string()) })), total: z.number().int(), offset: z.number().int(), limit: z.number().int(), has_more: z.boolean() } });
  tool('update_import_plan', 'Change what a planned import will do before committing it: tick or untick rows, and for a duplicate choose skip (keep what the tracker has) or update (replace it from the sheet). Aim it at named rows or at a whole step.',
    { batch_id: z.number().int(), seqs: z.array(z.number().int()).max(500).optional().describe('Row seq numbers from the plan'), step: STEP.optional().describe('Every row of one step'),
      included: z.boolean().optional().describe('Tick (true) or untick (false)'), action: z.enum(['create', 'update', 'skip']).optional().describe('skip keeps the original, update replaces it from the sheet'),
      duplicates_only: z.boolean().optional().describe('With step, limit it to the duplicates') },
    async (a) => json(await imports.updateImportPlan(scope, a)),
    { write: true, admin: true, out: { batch_id: z.number().int(), status: str, sheet: str, rows_read: z.number().int(),
      steps: z.record(z.string(), row({})), duplicates: z.number().int(), assumptions: z.number().int(),
      left_out: z.number().int(), left_out_reasons: z.record(z.string(), z.number()), errors: z.number().int(),
      committed: z.boolean(), next: z.string(), changed: z.number().int() } });
  tool('replan_sheet_import', 'Plan the same rows again with different import assumptions, replacing the previous plan. Nothing is written.',
    { batch_id: z.number().int(), rules: z.record(z.string(), z.unknown()).describe('e.g. {exclude_iso: false, default_split: [30, 70]}') },
    async (a) => json(await imports.replanSheetImport(scope, token, a)),
    { write: true, admin: true, out: { batch_id: z.number().int(), status: str, sheet: str, rows_read: z.number().int(),
      steps: z.record(z.string(), row({})), duplicates: z.number().int(), assumptions: z.number().int(),
      left_out: z.number().int(), left_out_reasons: z.record(z.string(), z.number()), errors: z.number().int(),
      committed: z.boolean(), next: z.string(), needs_attention: z.array(row({ seq: z.number().int(), step: str, row: num, client: str, action: str, included: z.boolean(), existing: str, says: z.array(z.string()), assumptions: z.array(z.string()) })), needs_attention_total: z.number().int() } });
  tool('commit_sheet_import', 'Write a planned import to the tracker. This is the only import step that changes a record, and it cannot be undone. Requires confirm: true, and refuses while any included row still has an error.',
    { batch_id: z.number().int(), confirm: z.literal(true).describe('Must be true. Nothing is written without it') },
    async (a) => json(await imports.commitSheetImport(scope, token, a)),
    { write: true, admin: true, out: { batch_id: z.number().int(), status: str, sheet: str, rows_read: z.number().int(),
      steps: z.record(z.string(), row({})), duplicates: z.number().int(), assumptions: z.number().int(),
      left_out: z.number().int(), left_out_reasons: z.record(z.string(), z.number()), errors: z.number().int(),
      committed: z.boolean(), next: z.string(), written_count: z.number().int(), written_by_action: z.record(z.string(), z.number()),
      written: z.array(row({ seq: z.number().int(), ref: str, action: str })), written_shown: z.number().int() } });

  // ---- counting, and the two money questions (#140) -----------------
  tool('describe_aggregate', 'What can be counted and totalled, and by which columns. Call with no arguments for the list, or name an entity to see its columns, its dates and its number fields.',
    { entity: z.string().max(60).optional() },
    async (a) => json(await agg.describeAggregate(scope, a)),
    { out: { entities: z.array(row({ name: z.string(), scoped: z.boolean() })).optional(), measures: z.array(z.string()).optional(),
      periods: z.array(z.string()).optional(), note: str,
      entity: str, group_by: z.array(z.string()).optional(), dates: z.array(z.string()).optional(), numbers: z.array(z.string()).optional() } });
  tool('aggregate', 'Count or total any records, grouped by any of their columns — deals by stage, value by salesperson, quotations by sector, wins by month. Group a date column by period with "column:month". Filters are the same ones the list screens take.',
    { entity: z.string().max(60).describe('From describe_aggregate, e.g. quotations'),
      by: z.string().max(80).describe('A column, or a date column and a period: "quotation_date:month"'),
      measure: z.enum(['count', 'sum', 'avg', 'min', 'max']).optional().describe('Default count'),
      of: z.string().max(60).optional().describe('The number column to sum/average, required unless counting'),
      where: z.record(z.string(), z.unknown()).optional().describe('Column filters, e.g. {status: "Submitted"}. Use null for "not set"'),
      order: z.enum(['value', 'group']).optional().describe('Default value: biggest first'),
      limit: z.number().int().min(1).max(200).optional().describe('Groups to return, default 50') },
    async (a) => json(await agg.aggregate(scope, a)),
    { out: { entity: z.string(), grouped_by: z.string(), measure: z.string(),
      groups: z.array(row({ group: str, value: num, rows: z.number().int() })),
      total: num, groups_returned: z.number().int(), blank_group_means: z.string() } });
  tool('list_renewals', 'Engagements coming up for renewal, soonest first, with the renewal quotation where one has been raised. Use within_days for what is due inside a window.',
    { status: z.string().max(60).optional().describe('active, renewal_open, renewed, lapsed, cancelled; comma-separated for several'),
      within_days: z.number().int().optional().describe('Only those due within this many days; negative days mean already overdue'),
      limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).optional() },
    async (a) => json(await money.listRenewals(scope, a)),
    { out: { ...pageOf(row({ engagement_id: z.number().int(), client: str, service: str, status: str, next_due_on: str, days_to_due: num, overdue: z.boolean().nullable().optional(), renewal_quotation_no: str, owner: str })),
      counts_all_engagements: row({}) } });
  tool('get_cashflow', 'Cash expected in and going out, by month: billed and unpaid, scheduled but not yet billed, the weighted pipeline, and what we owe travel vendors and staff. Rupees. Admin tokens only.',
    { months: z.number().int().min(1).max(24).optional().describe('How many months ahead, default 6'),
      detail: z.boolean().optional().describe('Include the biggest item lines per month. Off by default — a live book has thousands') },
    async (a) => json(await money.getCashflow(scope, a)),
    { out: { today: str, currency: z.string(), reads: z.string(),
      months: z.array(row({ month: z.string(), received: num, invoiced: num, scheduled: num, pipeline: num, inflow: num, outflow: num, net: num, lines: z.number().int() })),
      foreign: z.array(row({})) } });
  // ---- feeding any kind of record (#138) ---------------------------
  //
  // The sheet importer above understands one shape. These two take plain
  // rows into any resource the app has a form for, through that form's own
  // schema and save hooks. dry_run is the default and writes nothing.
  tool('describe_entity', 'What can be imported, and what fields each kind of record takes. Call with no arguments for the list of entities, or name one to see its fields and which of them are required.',
    { entity: z.string().max(60).optional().describe('e.g. companies, contacts, enquiries, travel-logs') },
    async (a) => json(await records.describeEntity(scope, a)),
    { write: true, admin: true, out: { entities: z.array(row({ name: z.string(), label: str, key: str })).optional(),
      not_bulk: z.array(z.string()).optional(), note: str,
      entity: str, label: str, match_on: str,
      fields: z.array(row({ name: z.string(), required: z.boolean(), says: str })).optional() } });
  tool('import_records', `Feed rows into any importable kind of record — companies, contacts, enquiries, quotations, projects, travel logs, vendor invoices and more. Up to ${records.MAX_ROWS} rows a call, validated by the same rules the app's own forms use. Reports what it would do and writes nothing unless dry_run is false. A row whose key already exists updates that record rather than adding a second one.`,
    { entity: z.string().max(60).describe('From describe_entity'),
      rows: z.array(z.record(z.string(), z.unknown())).min(1).describe("One object per record, keyed by field name e.g. {name: 'Aurora Chemicals', sector: 'Chemicals'}"),
      dry_run: z.boolean().optional().describe('Default true. Nothing is written until this is false'),
      match_on: z.string().max(60).nullable().optional().describe('Field that decides a record is already here. Defaults to the natural key; null to always create'),
      update_existing: z.boolean().optional().describe('Default true. False leaves existing records alone and reports them as skipped') },
    async (a) => json(await records.importRecords(scope, token, a)),
    { write: true, admin: true, out: { entity: z.string(), matched_on: str, rows_sent: z.number().int(),
      created: z.number().int(), updated: z.number().int(), rejected: z.number().int(), dry_run: z.boolean(),
      rows: z.array(row({ at: z.number().int(), action: z.string(), key: z.unknown().optional(), id: num, why: z.unknown().optional() })),
      rows_shown: z.number().int(), next: z.string() } });
  // Reading duplicates, and deliberately not merging them. A merge rewrites
  // the client name on every quotation, enquiry and project of one company
  // and then deletes it, with no undo — the most destructive thing this API
  // does. Finding them is the useful half and costs nothing; acting on one
  // belongs on the Companies screen, where whoever does it can see the
  // records that are about to move.
  tool('list_duplicate_companies', 'Groups of companies that look like one client spelt more than once. A group means the names share a brand, not that they are the same company — a plant or a subsidiary is its own client. Read-only: merging is done on the Companies screen.',
    { limit: z.number().int().min(1).max(100).optional().describe('Groups to return, default 25') },
    async ({ limit }) => {
      const groups = await duplicateCompanies();
      const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
      return json({
        groups: groups.slice(0, n).map((g) => ({
          names: g.members.map((m) => ({ id: m.id, name: m.name, records: m.records })),
          size: g.size,
          records: g.records,
          confidence: g.confidence,
          certain: g.certain,
        })),
        total: groups.length,
        certain_groups: groups.filter((g) => g.certain).length,
        merge_at: '/companies',
      });
    },
    { out: { groups: z.array(row({ names: z.array(row({ id: z.number().int(), name: z.string(), records: num })), size: z.number().int(), records: z.number().int(), confidence: z.string(), certain: z.boolean() })),
      total: z.number().int(), certain_groups: z.number().int(), merge_at: z.string() } });

  server.registerResource('pipeline-stages', 'tracker://pipeline-stages', { description: 'The quotation stages with their probabilities', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await query('SELECT name, probability, type, sort_order FROM pipeline_stages WHERE active ORDER BY sort_order')).rows) }] }));
  server.registerResource('service-catalogue', 'tracker://services', { description: 'Services we quote, with default rates and GST', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify((await query('SELECT name, code, default_rate, currency, gst_rate, unit, renewal_interval_months FROM services WHERE active ORDER BY sort_order, name')).rows) }] }));
  server.registerResource('kpi-definitions', 'tracker://kpi-definitions', { description: 'What each number from get_kpis means', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data.KPI_DEFINITIONS) }] }));
  return server;
}

// Per token, as #50 asks, not per address. Behind a proxy every MCP client
// arrives from the same address, so an IP bucket is one budget shared by
// all of them and one busy client starves the rest. The token is hashed
// into the key so the plaintext is never held in the limiter's store; a
// caller with no token at all falls back to the address, which is the right
// bucket for traffic that has not identified itself.
mcpRouter.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    // ipKeyGenerator, not req.ip: one IPv6 caller holds a whole /64 and
    // could otherwise take a fresh budget per address it made up.
    return bearer ? `token:${hash(bearer)}` : `ip:${ipKeyGenerator(req.ip)}`;
  },
}));

mcpRouter.post('/', async (req, res) => {
  const token = await authenticate(req);
  if (!token) {
    res.set('WWW-Authenticate', 'Bearer realm="cetizion-tracker"');
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'A valid API token is required' }, id: null });
  }
  const server = buildServer(token);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // The SDK writes the tool schemas as draft-07 and says in its own types
  // that they are 2020-12; a client whose validator is 2020-12 only refuses
  // the tool before calling it. Corrected on the way out, where every reply
  // passes whatever asked for it — see lib/mcpSchema.js. send() is the
  // transport interface rather than anything private, so a release that
  // starts emitting 2020-12 makes this a no-op instead of a conflict.
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(withSupportedSchemaDialect(message), options);
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless: no server-sent stream and no sessions to end.
mcpRouter.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST' }, id: null }));
mcpRouter.delete('/', (req, res) => res.status(405).set('Allow', 'POST').end());

// ------------------------------------------------------------ tokens (staff)

// Issuing one is issuing a key to the tracker: a token carries its own role,
// so anybody who may create one may create an admin one and read the whole
// company through MCP, whatever their own role is. Revoking is the same
// power pointed the other way — you could turn off everybody else's.
apiTokenRouter.use(requireAdmin);

apiTokenRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.name, t.token_prefix, t.role, t.can_write, t.person, t.created_by, t.created_at, t.last_used_at, t.revoked_at,
            (SELECT COUNT(*)::int FROM api_token_log l WHERE l.token_id = t.id) AS calls
       FROM api_tokens t ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`);
  const { rows: log } = await query(
    `SELECT l.created_at, l.tool, l.ok, l.error, t.name FROM api_token_log l JOIN api_tokens t ON t.id = l.token_id ORDER BY l.id DESC LIMIT 100`);
  res.json({ data: rows, log });
});

apiTokenRouter.post('/', async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(120), role: z.enum(['admin', 'sales']), person: z.string().trim().max(120).optional(), can_write: z.boolean().optional().default(false) }).safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const v = parsed.data;
  if (v.role === 'sales' && !v.person) throw new ApiError(422, 'Please check the highlighted fields', { fields: { person: 'Whose records may this token see?' } });
  const token = `ctz_${crypto.randomBytes(32).toString('base64url')}`;
  const { rows: [t] } = await query(
    `INSERT INTO api_tokens (name, token_hash, token_prefix, role, can_write, person, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, name, token_prefix, role, can_write, person, created_at`,
    [v.name, hash(token), token.slice(0, 10), v.role, v.can_write, v.role === 'sales' ? v.person : null, req.user?.username || 'admin']);
  res.status(201).json({ data: { ...t, token } });
});

apiTokenRouter.post('/:id/revoke', async (req, res) => {
  const { rows: [t] } = await query('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id, revoked_at', [Number(req.params.id)]);
  if (!t) throw new ApiError(404, 'Token not found');
  res.json({ data: t });
});
