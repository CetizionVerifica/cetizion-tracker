/**
 * OAuth 2.1 for the MCP endpoint (#249): how claude.ai connects the tracker
 * as a custom connector, signed in as the person who added it.
 *
 * Discovery (public, before the single-page app can answer them):
 *   GET  /.well-known/oauth-protected-resource[/api/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server           RFC 8414
 *
 * The flow (public; each step checks its own proof):
 *   POST /api/oauth/register      a client registers itself (RFC 7591)
 *   GET  /api/oauth/authorize     → /oauth/consent?request=…, the tracker's own screen
 *   POST /api/oauth/token         a code (with its PKCE verifier) or a refresh token → tokens
 *   POST /api/oauth/revoke        RFC 7009
 *
 * The consent screen and Connected apps (signed in):
 *   GET    /api/oauth/requests/:id     what is asking, and whether this person may allow it
 *   POST   /api/oauth/requests/:id     { allow, can_write } → where to send the browser
 *   GET    /api/oauth/grants           your connections; an admin's lists everybody's
 *   DELETE /api/oauth/grants/:id       disconnect
 *
 * Library code (lib/mcp/oauth.js) issues and checks tokens; this file is the
 * HTTP around it.
 */
import crypto from 'node:crypto';
import cors from 'cors';
import express, { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { requireAuth } from '../auth/middleware.js';
import { query, transaction } from '../db.js';
import { ApiError } from '../middleware/error.js';
import {
  LIVE_USER, REQUEST_TTL_S, SCOPES, authorizationServerMetadata, connectorRoles, hash, issueTokens, pkceMatches,
  protectedResourceMetadata, redirectAllowed, redirectMatches, resourceUrl, sameHash, secret, siteOrigin, whyNot,
} from '../lib/mcp/oauth.js';

export const wellKnownRouter = Router();
export const oauthRouter = Router();

// A browser-based MCP client reads discovery and calls the token endpoint
// from its own origin. None of these carries a cookie, so any origin may.
const open = cors({ origin: '*', credentials: false });

const limit = (windowMs, max) => rateLimit({
  windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => oauthError(res, 429, 'too_many_requests', 'Too many requests. Try again in a few minutes.'),
});

function oauthError(res, status, error, description) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ error, error_description: description });
}

async function origin() {
  const o = await siteOrigin();
  if (!o) throw new ApiError(503, 'The public address of the tracker is not set (Settings, or CORS_ORIGIN)');
  return o;
}

// ------------------------------------------------------------- discovery

const prm = async (req, res) => res.json(protectedResourceMetadata(await origin()));
wellKnownRouter.get('/oauth-protected-resource', open, prm);
wellKnownRouter.get('/oauth-protected-resource/api/mcp', open, prm);
wellKnownRouter.get('/oauth-authorization-server', open, async (req, res) => res.json(authorizationServerMetadata(await origin())));
// Some clients look for OpenID discovery first. The same document answers;
// there is no id_token here, so nothing OpenID-specific is claimed.
wellKnownRouter.get('/openid-configuration', open, async (req, res) => res.json(authorizationServerMetadata(await origin())));

// ---------------------------------------------------------- registration

for (const path of ['/register', '/token', '/revoke']) oauthRouter.options(path, open);

oauthRouter.post('/register', open, limit(60 * 60 * 1000, 20), async (req, res) => {
  const parsed = OAuthClientMetadataSchema.safeParse(req.body || {});
  if (!parsed.success) return oauthError(res, 400, 'invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const meta = parsed.data;
  if (!meta.redirect_uris.length) return oauthError(res, 400, 'invalid_redirect_uri', 'At least one redirect_uri is required');
  const refused = meta.redirect_uris.find((u) => !redirectAllowed(u));
  if (refused) return oauthError(res, 400, 'invalid_redirect_uri', `${refused} is not a redirect this tracker sends codes to`);
  const method = meta.token_endpoint_auth_method || 'client_secret_basic';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) return oauthError(res, 400, 'invalid_client_metadata', `token_endpoint_auth_method ${method} is not supported`);
  if (meta.grant_types && meta.grant_types.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
    return oauthError(res, 400, 'invalid_client_metadata', 'Only authorization_code and refresh_token are supported');
  }

  const clientId = `ctzclient_${crypto.randomUUID()}`;
  const clientSecret = method === 'none' ? null : secret('secret');
  const name = String(meta.client_name || '').slice(0, 120) || null;
  const stored = { ...meta, token_endpoint_auth_method: method };
  const { rows: [c] } = await query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, metadata) VALUES ($1,$2,$3,$4,$5)
     RETURNING created_at`,
    [clientId, clientSecret ? hash(clientSecret) : null, name, meta.redirect_uris, JSON.stringify(stored)]);
  res.set('Cache-Control', 'no-store').status(201).json({
    ...stored,
    client_id: clientId,
    client_id_issued_at: Math.floor(new Date(c.created_at).getTime() / 1000),
    ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
  });
});

// --------------------------------------------------------- authorization

const clientById = async (id) => (await query('SELECT * FROM oauth_clients WHERE client_id = $1', [String(id || '')])).rows[0];

function errorRedirect(redirectUri, error, description, state) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  return u.href;
}

oauthRouter.get('/authorize', limit(15 * 60 * 1000, 100), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = req.query;
  // Until the client and its redirect are known, an error cannot go back to
  // it: the browser is shown it here instead, never sent somewhere unchecked.
  const client = await clientById(q.client_id);
  if (!client) return oauthError(res, 400, 'invalid_client', 'This app is not registered with the tracker. Remove the connector and add it again.');
  let redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : undefined;
  if (redirectUri !== undefined) {
    if (!client.redirect_uris.some((r) => redirectMatches(redirectUri, r))) return oauthError(res, 400, 'invalid_request', 'Unregistered redirect_uri');
  } else if (client.redirect_uris.length === 1) {
    [redirectUri] = client.redirect_uris;
  } else {
    return oauthError(res, 400, 'invalid_request', 'redirect_uri is required');
  }

  const state = typeof q.state === 'string' ? q.state : undefined;
  const fail = (error, description) => res.redirect(302, errorRedirect(redirectUri, error, description, state));
  if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
  if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9\-_]{43}$/.test(q.code_challenge)) return fail('invalid_request', 'A PKCE code_challenge is required');
  if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
  const scopes = typeof q.scope === 'string' && q.scope.trim() ? q.scope.trim().split(/\s+/) : ['tracker:read'];
  if (scopes.some((s) => !SCOPES.includes(s))) return fail('invalid_scope', `Scopes offered: ${SCOPES.join(' ')}`);
  const site = await origin();
  const resource = resourceUrl(site);
  // RFC 8707: a token is only ever for this server's MCP endpoint.
  if (q.resource !== undefined && String(q.resource).replace(/\/$/, '') !== resource) return fail('invalid_target', `This server issues tokens for ${resource} only`);

  const id = secret('request');
  await query(
    `INSERT INTO oauth_requests (id_hash, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8))`,
    [hash(id), client.client_id, redirectUri, q.code_challenge, state ?? null, scopes, resource, REQUEST_TTL_S]);
  query(`DELETE FROM oauth_requests WHERE expires_at < now() - interval '1 day'`).catch(() => {});
  // The consent screen is the tracker's own page: sign-in happens there
  // first if needed, and the person sees what is asking before anything is
  // issued.
  res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
});

/** An undecided, unexpired request, with its client. */
async function openRequest(id) {
  const { rows: [r] } = await query(
    `SELECT r.*, c.client_name FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
      WHERE r.id_hash = $1 AND r.decided_at IS NULL AND r.expires_at > now()`, [hash(String(id || ''))]);
  return r;
}

oauthRouter.get('/requests/:id', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const r = await openRequest(req.params.id);
  if (!r) throw new ApiError(404, 'This request has expired or was already answered. Start again from Claude.');
  res.json({
    data: {
      client_name: r.client_name || 'An MCP client',
      redirect_host: new URL(r.redirect_uri).host,
      asks_write: r.scopes.includes('tracker:write'),
      sees: req.user.role === 'admin' ? 'everything' : 'own',
      user_name: req.user.name || req.user.username,
      refused: await whyNot(req.user),
    },
  });
});

oauthRouter.post('/requests/:id', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const allow = req.body?.allow === true;
  const canWrite = allow && req.body?.can_write === true;
  const why = allow ? await whyNot(req.user) : null;
  if (why) throw new ApiError(403, why);

  const redirect = await transaction(async (db) => {
    const { rows: [r] } = await db.query(
      `UPDATE oauth_requests SET decided_at = now()
        WHERE id_hash = $1 AND decided_at IS NULL AND expires_at > now() RETURNING *`, [hash(String(req.params.id || ''))]);
    if (!r) throw new ApiError(404, 'This request has expired or was already answered. Start again from Claude.');
    if (!allow) return errorRedirect(r.redirect_uri, 'access_denied', 'The person declined', r.state);

    // One grant per person and app: approving again updates it rather than
    // stacking connections nobody can tell apart on Connected apps.
    const { rows: [existing] } = await db.query(
      'SELECT id FROM oauth_grants WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', [req.user.id, r.client_id]);
    const { rows: [grant] } = existing
      ? await db.query('UPDATE oauth_grants SET can_write = $2 WHERE id = $1 RETURNING id', [existing.id, canWrite])
      : await db.query('INSERT INTO oauth_grants (user_id, client_id, can_write) VALUES ($1,$2,$3) RETURNING id', [req.user.id, r.client_id, canWrite]);
    const code = secret('code');
    await db.query('UPDATE oauth_requests SET grant_id = $2, code_hash = $3 WHERE id_hash = $1', [r.id_hash, grant.id, hash(code)]);
    const u = new URL(r.redirect_uri);
    u.searchParams.set('code', code);
    if (r.state) u.searchParams.set('state', r.state);
    return u.href;
  });
  res.json({ data: { redirect } });
});

// ----------------------------------------------------------------- tokens

const form = express.urlencoded({ extended: false });

/** The client from client_id (and its secret, for a confidential one), from the body or HTTP Basic. */
async function authenticateClient(req) {
  let id = req.body?.client_id;
  let given = req.body?.client_secret;
  const basic = String(req.get('authorization') || '').match(/^Basic\s+(.+)$/i);
  if (basic) {
    const [u, p] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    id = decodeURIComponent(u || ''); given = decodeURIComponent(p || '');
  }
  const client = await clientById(id);
  if (!client) return null;
  if (client.client_secret_hash && !(given && sameHash(given, client.client_secret_hash))) return null;
  return client;
}

oauthRouter.post('/token', open, limit(15 * 60 * 1000, 100), form, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const client = await authenticateClient(req);
  if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
  const b = req.body || {};
  const site = await origin();
  const resource = resourceUrl(site);
  if (b.resource !== undefined && String(b.resource).replace(/\/$/, '') !== resource) return oauthError(res, 400, 'invalid_target', `This server issues tokens for ${resource} only`);

  if (b.grant_type === 'authorization_code') {
    if (typeof b.code !== 'string' || typeof b.code_verifier !== 'string') return oauthError(res, 400, 'invalid_request', 'code and code_verifier are required');
    const result = await transaction(async (db) => {
      const { rows: [r] } = await db.query('SELECT * FROM oauth_requests WHERE code_hash = $1 FOR UPDATE', [hash(b.code)]);
      if (!r || r.client_id !== client.client_id) return { error: 'The code is not valid' };
      if (r.used_at) {
        // A code presented twice: one of the two is not the client. Whatever
        // was issued from it is withdrawn.
        await db.query('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [r.grant_id]);
        return { error: 'The code was already used' };
      }
      if (new Date(r.expires_at) <= new Date()) return { error: 'The code has expired' };
      if (b.redirect_uri !== undefined && b.redirect_uri !== r.redirect_uri) return { error: 'redirect_uri does not match the authorization request' };
      if (!pkceMatches(b.code_verifier, r.code_challenge)) return { error: 'code_verifier does not match the challenge' };
      await db.query('UPDATE oauth_requests SET used_at = now() WHERE id_hash = $1', [r.id_hash]);
      const { rows: [grant] } = await db.query(
        `SELECT g.* FROM oauth_grants g JOIN users u ON u.id = g.user_id AND ${LIVE_USER} WHERE g.id = $1 AND g.revoked_at IS NULL`, [r.grant_id]);
      if (!grant) return { error: 'The approval behind this code no longer stands' };
      return { tokens: (await issueTokens(db, grant, r.resource)).body };
    });
    if (result.error) return oauthError(res, 400, 'invalid_grant', result.error);
    return res.json(result.tokens);
  }

  if (b.grant_type === 'refresh_token') {
    if (typeof b.refresh_token !== 'string') return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
    const result = await transaction(async (db) => {
      const { rows: [t] } = await db.query(
        `SELECT t.*, g.client_id, g.revoked_at AS grant_revoked_at FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = $1 AND t.kind = 'refresh' FOR UPDATE OF t`, [hash(b.refresh_token)]);
      if (!t || t.client_id !== client.client_id) return { error: 'The refresh token is not valid' };
      if (t.replaced_by || t.revoked_at) {
        // A refresh token used after it was replaced is a copy somebody kept.
        // The connection ends; the person reconnects from Claude.
        await db.query('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [t.grant_id]);
        await db.query('UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE grant_id = $1', [t.grant_id]);
        return { error: 'The refresh token was already used' };
      }
      if (t.grant_revoked_at || new Date(t.expires_at) <= new Date()) return { error: 'The refresh token has expired or was revoked' };
      const { rows: [grant] } = await db.query(
        `SELECT g.* FROM oauth_grants g JOIN users u ON u.id = g.user_id AND ${LIVE_USER} WHERE g.id = $1`, [t.grant_id]);
      if (!grant) return { error: 'The account behind this connection is no longer active' };
      const issued = await issueTokens(db, grant, t.resource);
      await db.query('UPDATE oauth_tokens SET replaced_by = $2 WHERE id = $1', [t.id, issued.refreshId]);
      return { tokens: issued.body };
    });
    if (result.error) return oauthError(res, 400, 'invalid_grant', result.error);
    return res.json(result.tokens);
  }

  return oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
});

oauthRouter.post('/revoke', open, limit(15 * 60 * 1000, 100), form, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const client = await authenticateClient(req);
  if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
  if (typeof req.body?.token !== 'string') return oauthError(res, 400, 'invalid_request', 'token is required');
  const { rows: [t] } = await query(
    `SELECT t.id, t.kind, t.grant_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
      WHERE t.token_hash = $1 AND g.client_id = $2`, [hash(req.body.token), client.client_id]);
  // RFC 7009: an unknown token is not an error. Revoking a refresh token
  // ends the connection, which is what a client means by "disconnect".
  if (t?.kind === 'refresh') await query('UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [t.grant_id]);
  else if (t) await query('UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [t.id]);
  res.status(200).json({});
});

// --------------------------------------------------------- connected apps

oauthRouter.get('/grants', requireAuth, async (req, res) => {
  const everyone = req.user.role === 'admin' && req.query.all === '1';
  const { rows } = await query(
    `SELECT g.id, g.can_write, g.created_at, g.last_used_at, g.revoked_at, c.client_name, c.redirect_uris[1] AS redirect_uri,
            u.id AS user_id, u.name AS user_name,
            (SELECT COUNT(*)::int FROM api_token_log l WHERE l.grant_id = g.id) AS calls
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id JOIN users u ON u.id = g.user_id
      WHERE ($1 OR g.user_id = $2)
      ORDER BY g.revoked_at IS NOT NULL, COALESCE(g.last_used_at, g.created_at) DESC
      LIMIT 200`, [everyone, req.user.id ?? null]);
  const site = await siteOrigin();
  res.json({
    data: rows.map(({ redirect_uri: r, ...g }) => ({ ...g, app_host: (() => { try { return new URL(r).host; } catch { return null; } })() })),
    connector_url: site ? resourceUrl(site) : null,
    roles: await connectorRoles(),
    refused: await whyNot(req.user),
  });
});

oauthRouter.delete('/grants/:id', requireAuth, async (req, res) => {
  const { rows: [g] } = await query(
    `UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND (user_id = $2 OR $3) RETURNING id, revoked_at`,
    [Number(req.params.id) || 0, req.user.id ?? null, req.user.role === 'admin']);
  if (!g) throw new ApiError(404, 'Connection not found');
  res.json({ data: g });
});
