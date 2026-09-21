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
import { rateLimit } from 'express-rate-limit';
import { query } from '../db.js';
import { ApiError, fromPgError } from '../middleware/error.js';
import * as data from '../lib/mcp/data.js';

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
    instructions: `Cetizion Verifica's tracker: clients, quotations, projects, purchase orders, invoices and payments. Amounts are in the record's currency; INR totals use the exchange rates in Settings. ${token.role === 'admin' ? 'This token sees every record.' : `This token sees only records where the sales person is ${token.person}.`}`,
  });
  const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] });
  const notFound = (what) => ({ isError: true, content: [{ type: 'text', text: `${what} was not found, or this token may not see it.` }] });
  const tool = (name, description, shape, fn, { write = false } = {}) => {
    server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write } }, async (args) => {
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

  tool('search_records', 'Find companies, quotations, enquiries, projects and purchase orders by name, number or service.',
    { text: z.string().min(2).describe('What to look for'), types: z.array(z.enum(['company', 'quotation', 'enquiry', 'project', 'purchase_order'])).optional() },
    async ({ text, types }) => json(await data.searchRecords(scope, { text, types })));
  tool('get_company', 'A client with its contacts, open deals, what it owes and its recent activity.',
    { company_id: z.number().int().describe('Company id, from search_records') },
    async ({ company_id: id }) => { const r = await data.getCompany(scope, id); return r ? json(r) : notFound(`Company ${id}`); });
  tool('get_quotation', 'One quotation with its lines, stage, probability, acceptance and POs.',
    { quotation_no: z.string().describe('e.g. CTZ/QT/2026/062') },
    async ({ quotation_no: no }) => { const r = await data.getQuotation(scope, no); return r ? json(r) : notFound(`Quotation ${no}`); });
  tool('get_project', 'One project with its POs, money position and upcoming visits.',
    { project_id: z.string().describe('e.g. PRJ-2026-001') },
    async ({ project_id: id }) => { const r = await data.getProject(scope, id); return r ? json(r) : notFound(`Project ${id}`); });
  tool('get_po', 'One purchase order with its payment stages and invoices.',
    { po_number: z.string() },
    async ({ po_number: no }) => { const r = await data.getPo(scope, no); return r ? json(r) : notFound(`PO ${no}`); });
  tool('list_pipeline', 'Open quotations with stage, owner, value, probability, weighted value and last contact. Filter by stage name, owner (admin tokens only) and expected close dates.',
    { stage: z.string().optional(), owner: z.string().optional(), close_from: DAY.optional(), close_to: DAY.optional() },
    async (a) => json(await data.listPipeline(scope, { stage: a.stage, owner: a.owner, from: a.close_from, to: a.close_to })));
  tool('list_collections', 'Unpaid invoices, overdue first, with how long overdue, what is outstanding and the recent chasing.',
    { overdue_only: z.boolean().optional().describe('Default true'), min_days_overdue: z.number().int().min(0).optional() },
    async (a) => json(await data.listCollections(scope, { overdue_only: a.overdue_only ?? true, min_days: a.min_days_overdue })));
  tool('get_kpis', 'Sales numbers for a period: quotations issued, value, wins, losses, win rate, open and weighted pipeline, days to win, touches. Admin tokens may name a person.',
    { from: DAY.optional(), to: DAY.optional(), person: z.string().optional() },
    async (a) => json(await data.getKpis(scope, a)));
  tool('list_activity', 'Notes, tasks, logged calls and email threads on a record, newest first.',
    { entity: ENTITY, id: z.string() },
    async ({ entity, id }) => { const r = await data.listActivity(scope, entity, id); return r ? json(r) : notFound(`${entity} ${id}`); });

  tool('create_task', 'Add a follow-up task to a record. Marked as made through MCP.',
    { entity: ENTITY, id: z.string(), title: z.string().min(3).max(300), due_on: DAY.optional(), assignee: z.string().max(120).optional() },
    async (a) => { const r = await data.createTask(scope, token, a); return r ? json(r) : notFound(`${a.entity} ${a.id}`); }, { write: true });
  tool('add_note', 'Add a note to a record\'s timeline. Marked as made through MCP.',
    { entity: ENTITY, id: z.string(), text: z.string().min(2).max(4000) },
    async (a) => { const r = await data.addNote(scope, token, a); return r ? json(r) : notFound(`${a.entity} ${a.id}`); }, { write: true });
  tool('log_touch', 'Record a call, WhatsApp chat or meeting that already happened. It does not contact anyone.',
    { entity: z.enum(['company', 'quotation', 'enquiry', 'project']), id: z.string(), channel: z.enum(['call', 'whatsapp', 'meeting', 'email', 'other']), outcome: z.enum(['connected', 'no_answer', 'left_message', 'sent', 'held']).optional(), summary: z.string().max(4000).optional(), contact_name: z.string().max(160).optional() },
    async (a) => { const r = await data.logTouch(scope, token, a); return r ? json(r) : notFound(`${a.entity} ${a.id}`); }, { write: true });
  tool('update_next_step', 'Set the next step (and optionally the expected close date) on an open quotation. It does not change its stage.',
    { quotation_no: z.string(), next_step: z.string().min(2).max(500), expected_close_date: DAY.optional() },
    async (a) => { const r = await data.updateNextStep(scope, token, a); return r ? json(r) : notFound(`Quotation ${a.quotation_no}`); }, { write: true });

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
    return bearer ? `token:${hash(bearer)}` : `ip:${req.ip}`;
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
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless: no server-sent stream and no sessions to end.
mcpRouter.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Use POST' }, id: null }));
mcpRouter.delete('/', (req, res) => res.status(405).set('Allow', 'POST').end());

// ------------------------------------------------------------ tokens (staff)

apiTokenRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.name, t.token_prefix, t.role, t.person, t.created_by, t.created_at, t.last_used_at, t.revoked_at,
            (SELECT COUNT(*)::int FROM api_token_log l WHERE l.token_id = t.id) AS calls
       FROM api_tokens t ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`);
  const { rows: log } = await query(
    `SELECT l.created_at, l.tool, l.ok, l.error, t.name FROM api_token_log l JOIN api_tokens t ON t.id = l.token_id ORDER BY l.id DESC LIMIT 100`);
  res.json({ data: rows, log });
});

apiTokenRouter.post('/', async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(120), role: z.enum(['admin', 'sales']), person: z.string().trim().max(120).optional() }).safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields', { fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join('.'), i.message])) });
  const v = parsed.data;
  if (v.role === 'sales' && !v.person) throw new ApiError(422, 'Please check the highlighted fields', { fields: { person: 'Whose records may this token see?' } });
  const token = `ctz_${crypto.randomBytes(32).toString('base64url')}`;
  const { rows: [t] } = await query(
    `INSERT INTO api_tokens (name, token_hash, token_prefix, role, person, created_by) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, name, token_prefix, role, person, created_at`,
    [v.name, hash(token), token.slice(0, 10), v.role, v.role === 'sales' ? v.person : null, req.user?.username || 'admin']);
  res.status(201).json({ data: { ...t, token } });
});

apiTokenRouter.post('/:id/revoke', async (req, res) => {
  const { rows: [t] } = await query('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING id, revoked_at', [Number(req.params.id)]);
  if (!t) throw new ApiError(404, 'Token not found');
  res.json({ data: t });
});
