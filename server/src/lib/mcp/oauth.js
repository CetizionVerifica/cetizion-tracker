/**
 * The tracker as its own OAuth 2.1 authorization server, for one resource:
 * the MCP endpoint (#249). This is what lets claude.ai add the tracker as a
 * custom connector, which cannot carry a pasted `ctz_` token.
 *
 * Who the person is comes from the existing sign-in; this file only issues
 * and checks the tracker's own tokens. Nothing from Microsoft or Google is
 * ever handed on.
 *
 * Every secret here — client secrets, request ids, codes, access and refresh
 * tokens — is random, shown once, and stored only as its SHA-256.
 *
 * Role and name are never stored on a grant or a token. They are read from
 * users on every check, so a changed role or an account switched off is in
 * force on the next call.
 */
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { query } from '../../db.js';

export const SCOPES = ['tracker:read', 'tracker:write'];
export const ACCESS_TTL_S = 60 * 60;
export const REFRESH_TTL_S = 30 * 24 * 60 * 60;
export const REQUEST_TTL_S = 10 * 60;

const PREFIX = { access: 'ctzo_', refresh: 'ctzr_', secret: 'ctzs_', request: 'ctzq_', code: 'ctzc_' };

export const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
export const secret = (kind) => `${PREFIX[kind]}${crypto.randomBytes(32).toString('base64url')}`;
export const isAccessToken = (t) => typeof t === 'string' && t.startsWith(PREFIX.access);

/**
 * The address the tracker is reached at, for the issuer and the resource.
 *
 * Never the request's Host or Origin: those are the caller's to choose, and
 * an issuer taken from them would let anybody name their own. The same two
 * server-owned answers the acceptance links use, in the same order.
 */
export async function siteOrigin() {
  const { rows: [r] } = await query(`SELECT value FROM settings WHERE key = 'public_app_url'`);
  const set = String(r?.value || '').trim();
  const configured = set || config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean)[0] || '';
  if (!configured) return null;
  try { return new URL(configured).origin; } catch { return null; }
}

export const resourceUrl = (origin) => `${origin}/api/mcp`;
export const protectedResourceMetadataUrl = (origin) => `${origin}/.well-known/oauth-protected-resource/api/mcp`;

export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: SCOPES,
    service_documentation: 'https://github.com/CetizionVerifica/cetizion-tracker/blob/main/docs/mcp.md',
  };
}

export function protectedResourceMetadata(origin) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Cetizion tracker',
  };
}

/**
 * Where a code may be sent. Claude's own callbacks by default, plus any
 * loopback address (RFC 8252), which is how Claude Code and other desktop
 * clients receive one. Anything else is refused at registration: an open
 * list would let anybody register "Claude" with their own callback and
 * collect a code from a colleague who clicked Allow.
 */
const DEFAULT_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function redirectAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.hash) return false;
  if (u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return true;
  const listed = (process.env.MCP_OAUTH_REDIRECT_URIS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_REDIRECTS, ...listed].includes(uri);
}

/** A requested redirect against a registered one: exact, except a loopback port (RFC 8252 §7.3). */
export function redirectMatches(requested, registered) {
  if (requested === registered) return true;
  let a; let b;
  try { a = new URL(requested); b = new URL(registered); } catch { return false; }
  if (!LOOPBACK.has(a.hostname) || !LOOPBACK.has(b.hostname)) return false;
  return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** PKCE S256: the verifier hashes to the challenge. */
export function pkceMatches(verifier, challenge) {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(String(verifier || ''))) return false;
  const computed = Buffer.from(crypto.createHash('sha256').update(verifier).digest('base64url'));
  const given = Buffer.from(String(challenge));
  return computed.length === given.length && crypto.timingSafeEqual(computed, given);
}

export function sameHash(plain, storedHash) {
  const a = Buffer.from(hash(plain));
  const b = Buffer.from(String(storedHash || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Which roles may connect, from Settings. 'none' (or empty) switches the connector off. */
export async function connectorRoles(db = { query }) {
  const { rows: [r] } = await db.query(`SELECT value FROM settings WHERE key = 'mcp_connector_roles'`);
  const value = String(r?.value ?? 'admin,sales').trim().toLowerCase();
  return value === 'none' ? [] : value.split(',').map((s) => s.trim()).filter((s) => s === 'admin' || s === 'sales');
}

/**
 * Why this person may not connect, or null if they may.
 *
 * HR is refused for now: the MCP tools have no travel-desk scoping, and a
 * token built for HR would fall into the sales branch and see by name.
 */
export async function whyNot(user) {
  if (!user?.id) return 'Claude can only be connected with a personal tracker account. Ask an administrator to switch the tracker to individual sign-in.';
  if (user.role === 'hr') return 'Connecting Claude is not available for the travel desk yet.';
  const roles = await connectorRoles();
  if (!roles.length) return 'An administrator has switched the Claude connector off.';
  if (!roles.includes(user.role)) return `An administrator has not opened the Claude connector to the ${user.role} role.`;
  return null;
}

/** The SQL that says a users row may still use a connector. */
const LIVE_USER = `u.active AND NOT EXISTS (SELECT 1 FROM deleted_users d WHERE d.user_id = u.id)`;

/**
 * An access token presented at /api/mcp, as the identity buildServer() takes,
 * or null. Same shape as an api_tokens row where it matters: role, person,
 * can_write and a name for the "(via MCP)" stamp.
 */
export async function verifyAccessToken(token) {
  if (!isAccessToken(token)) return null;
  const origin = await siteOrigin();
  if (!origin) return null;
  const { rows: [t] } = await query(
    `SELECT g.id AS grant_id, g.can_write, u.id AS user_id, u.name, u.role
       FROM oauth_tokens t
       JOIN oauth_grants g ON g.id = t.grant_id AND g.revoked_at IS NULL
       JOIN users u ON u.id = g.user_id AND ${LIVE_USER}
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL
        AND t.expires_at > now() AND t.resource = $2`,
    [hash(token), resourceUrl(origin)]);
  if (!t) return null;
  // Switching the connector off, or closing it to this role, stops tokens
  // already issued, not just new ones.
  if (await whyNot({ id: t.user_id, role: t.role })) return null;
  query('UPDATE oauth_grants SET last_used_at = now() WHERE id = $1', [t.grant_id]).catch(() => {});
  return { kind: 'oauth', id: null, grant_id: t.grant_id, user_id: t.user_id, role: t.role, person: t.name, name: t.name, can_write: t.can_write };
}

/** Issue an access token and a refresh token under a grant. */
export async function issueTokens(db, grant, resource) {
  const access = secret('access');
  const refresh = secret('refresh');
  await db.query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, resource, expires_at) VALUES ($1, $2, 'access', $3, now() + make_interval(secs => $4))`,
    [hash(access), grant.id, resource, ACCESS_TTL_S]);
  const { rows: [r] } = await db.query(
    `INSERT INTO oauth_tokens (token_hash, grant_id, kind, resource, expires_at) VALUES ($1, $2, 'refresh', $3, now() + make_interval(secs => $4)) RETURNING id`,
    [hash(refresh), grant.id, resource, REFRESH_TTL_S]);
  // Housekeeping where it costs nothing: this grant's tokens that can no
  // longer be used by anybody.
  await db.query(`DELETE FROM oauth_tokens WHERE grant_id = $1 AND expires_at < now() - interval '1 day'`, [grant.id]);
  return {
    refreshId: r.id,
    body: {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: grant.can_write ? 'tracker:read tracker:write' : 'tracker:read',
    },
  };
}

export { LIVE_USER };
