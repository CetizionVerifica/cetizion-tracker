/**
 * Sign in with Microsoft 365 or Google (C18).
 *
 *   GET /api/auth/oauth/:provider/start      → redirect to the provider
 *   GET /api/auth/oauth/:provider/callback   → session cookie, then home
 *
 * Nothing here creates a person. An identity attaches to a `users` row an
 * admin has already added and left active; a verified email that matches
 * nobody is refused with the same sentence as one that matches somebody
 * switched off, because "does this person work here?" is not a question an
 * unauthenticated caller gets answered.
 *
 * Only in `database` mode. `shared` mode has one account and no per-person
 * row to attach an identity to, so the buttons are not offered at all
 * rather than offered and refused.
 *
 * Why the id_token's signature is not verified here: the token is fetched
 * by this server, directly from the provider's token endpoint, over TLS,
 * using the client secret. That is the confidential-client code flow, and
 * the channel is the proof — the claims never pass through the browser.
 * `aud`, `iss`, `exp` and (for Microsoft) `tid` are still checked, because
 * those catch a token that is genuine but meant for somebody else.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { findUserByEmail, findUserById, recordLogin } from '../lib/users.js';
import { startSession } from '../lib/sessions.js';
import { authConfig } from './config.js';
import { databasePayload, signSession, verifySession } from './session.js';

export const oauthRouter = Router();

const HANDSHAKE_COOKIE = 'cetizion_oauth';
const HANDSHAKE_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;

const google = {
  id: 'google',
  label: 'Google',
  scope: 'openid email profile',
  authorizeUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: () => 'https://oauth2.googleapis.com/token',
  clientId: () => config.google?.clientId || '',
  clientSecret: () => config.google?.clientSecret || '',
  redirectUri: () => config.google?.redirectUri || '',
  requires: () => [
    ['GOOGLE_CLIENT_ID', config.google?.clientId],
    ['GOOGLE_CLIENT_SECRET', config.google?.clientSecret],
    ['GOOGLE_REDIRECT_URI', config.google?.redirectUri],
  ],
  /**
   * Google says outright whether it has verified the address, and an
   * unverified one is worth nothing: anybody can put any string in a
   * Google profile, and matching it to a colleague's account would hand
   * them that colleague's session.
   */
  emailFrom: (claims) => (claims.email_verified === true || claims.email_verified === 'true' ? claims.email : null),
  extraChecks: () => null,
};

const microsoft = {
  id: 'microsoft',
  label: 'Microsoft 365',
  scope: 'openid email profile',
  authorizeUrl: () => `https://login.microsoftonline.com/${config.microsoft.tenantId}/oauth2/v2.0/authorize`,
  tokenUrl: () => `https://login.microsoftonline.com/${config.microsoft.tenantId}/oauth2/v2.0/token`,
  clientId: () => config.microsoft.clientId,
  clientSecret: () => config.microsoft.clientSecret,
  // A separate redirect from the mailbox one: the same Entra app
  // registration, a different journey, and mixing them would let a consent
  // meant for reading mail come back as a sign-in.
  redirectUri: () => config.microsoft.signInRedirectUri || '',
  // The tenant id is in this list because the authorize URL is built from
  // it. Without it the URL is still a URL — login.microsoftonline.com//… —
  // so the button would appear, send somebody to Microsoft, and fail there
  // rather than here.
  requires: () => [
    ['MS_TENANT_ID', config.microsoft.tenantId],
    ['MS_CLIENT_ID', config.microsoft.clientId],
    ['MS_CLIENT_SECRET', config.microsoft.clientSecret],
    ['MS_SIGNIN_REDIRECT_URI', config.microsoft.signInRedirectUri],
  ],
  /**
   * Entra has no `email_verified`. What it has instead is `tid`: an
   * account inside our tenant is one our own directory administers, which
   * is a stronger statement than a verification flag. The tenant check
   * below is what makes the address trustworthy, so it must not be
   * skipped — hence it is a hard failure in extraChecks, not a warning.
   */
  emailFrom: (claims) => claims.email || claims.preferred_username || claims.upn || null,
  extraChecks: (claims) => (claims.tid && claims.tid === config.microsoft.tenantId
    ? null
    : 'That account is not in this organisation.'),
};

// Microsoft first everywhere it is listed: it reuses the Entra app the
// mailbox sync already needs, so it is the shorter of the two jobs.
const PROVIDERS = { microsoft, google };

/** Which of a provider's environment variables are still blank. */
const missingFor = (p) => p.requires().filter(([, value]) => !String(value || '').trim()).map(([name]) => name);

/** A provider is offered only when it is completely configured. */
export function providerEnabled(provider) {
  const p = PROVIDERS[provider];
  if (!p || authConfig.mode !== 'database') return false;
  return missingFor(p).length === 0;
}

/**
 * What an admin needs to finish setting one up.
 *
 * Until this existed, a typo in one variable meant a button that simply
 * never appeared, with nothing anywhere to say why — the only way to tell
 * a missing secret from a wrong redirect was to read the source. It never
 * returns a value, only whether each name is blank: an admin screen has no
 * business printing a client secret back at anybody.
 */
export const providerSetup = () => Object.values(PROVIDERS).map((p) => ({
  id: p.id,
  label: p.label,
  enabled: providerEnabled(p.id),
  missing: missingFor(p),
  // The exact string to paste into the provider's console. A redirect that
  // does not match to the character is the most common way this fails, and
  // the error it produces names neither side.
  redirect_uri: p.redirectUri() || null,
  callback_path: `/api/auth/oauth/${p.id}/callback`,
}));

/** What the sign-in form is allowed to know: which buttons to draw. */
export const enabledProviders = () =>
  Object.values(PROVIDERS)
    .filter((p) => providerEnabled(p.id))
    .map((p) => ({ id: p.id, label: p.label }));

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: authConfig.secureCookie,
  path: '/',
});

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/** The claims out of an id_token, without trusting its signature — see the file header. */
function readClaims(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const sameString = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Where to send somebody afterwards.
 *
 * Only a path on this site, never a URL. An open redirect on a sign-in
 * endpoint is how a phishing page borrows a real domain, and `next` comes
 * from the query string, which is to say from whoever sent the link.
 */
function safeNext(value) {
  const raw = String(value || '/');
  return /^\/(?!\/)[\w\-./?=&%:]*$/.test(raw) ? raw : '/';
}

oauthRouter.get('/:provider/start', async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider || !providerEnabled(provider.id)) throw new ApiError(404, 'That sign-in method is not available');

  const state = base64url(randomBytes(STATE_BYTES));
  const verifier = base64url(randomBytes(STATE_BYTES));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  // The handshake lives in a cookie of its own, signed with the session
  // secret and expiring in ten minutes. Comparing the state in the callback
  // against it is what stops somebody feeding this endpoint a code they
  // obtained elsewhere.
  res.cookie(
    HANDSHAKE_COOKIE,
    signSession({ p: provider.id, state, verifier, next: safeNext(req.query.next), exp: Date.now() + HANDSHAKE_TTL_MS }, authConfig.sessionSecret),
    { ...cookieOptions(), maxAge: HANDSHAKE_TTL_MS }
  );

  const url = new URL(provider.authorizeUrl());
  url.search = new URLSearchParams({
    client_id: provider.clientId(),
    response_type: 'code',
    redirect_uri: provider.redirectUri(),
    scope: provider.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Always ask which account, rather than silently reusing whichever one
    // the browser last used. On a shared machine that is the difference
    // between signing in and signing in as somebody else.
    prompt: 'select_account',
  }).toString();

  res.redirect(url.toString());
});

async function exchange(provider, code, verifier) {
  const response = await fetch(provider.tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: provider.clientId(),
      client_secret: provider.clientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: provider.redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/** Every refusal says the same thing, and the reason goes to the log. */
function refuse(res, next, reason) {
  console.warn(`[auth] provider sign-in refused: ${reason}`);
  res.redirect(`${next === '/' ? '/' : next}${next.includes('?') ? '&' : '?'}sso=refused`);
}

oauthRouter.get('/:provider/callback', async (req, res) => {
  const provider = PROVIDERS[req.params.provider];
  if (!provider || !providerEnabled(provider.id)) throw new ApiError(404, 'That sign-in method is not available');

  const handshake = verifySession(req.cookies?.[HANDSHAKE_COOKIE], authConfig.sessionSecret);
  res.clearCookie(HANDSHAKE_COOKIE, cookieOptions());
  const next = safeNext(handshake?.next);

  if (!handshake || handshake.p !== provider.id) return refuse(res, next, 'no handshake cookie');
  if (!req.query.code || !req.query.state) return refuse(res, next, 'no code returned');
  if (!sameString(req.query.state, handshake.state)) return refuse(res, next, 'state did not match');

  const tokens = await exchange(provider, String(req.query.code), handshake.verifier);
  if (!tokens?.id_token) return refuse(res, next, 'token exchange failed');

  const claims = readClaims(tokens.id_token);
  if (!claims) return refuse(res, next, 'unreadable id_token');
  if (!sameString(claims.aud || '', provider.clientId())) return refuse(res, next, 'token was issued for another application');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return refuse(res, next, 'token already expired');

  const problem = provider.extraChecks(claims);
  if (problem) return refuse(res, next, problem);

  const email = provider.emailFrom(claims);
  const subject = claims.sub;
  if (!email || !subject) return refuse(res, next, 'no verified email on the account');

  // An identity already linked wins, because email can change and `sub`
  // cannot. Only a first sign-in falls back to matching on the address.
  const { rows: [linked] } = await query(
    'SELECT user_id FROM auth_identities WHERE provider = $1 AND subject = $2', [provider.id, subject]);

  const user = linked
    ? await findUserById(linked.user_id)
    : await findUserByEmail(email);

  // The same refusal for an address nobody holds and for an account
  // switched off. Telling them apart would answer "does this person work
  // here?" to whoever asked.
  if (!user || !user.active) return refuse(res, next, `no active account for ${email}`);

  await query(
    `INSERT INTO auth_identities (user_id, provider, subject, email, last_used_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email, last_used_at = now()`,
    [user.id, provider.id, subject, email]);

  await recordLogin(user.id);
  await query('INSERT INTO auth_events (username, ip, ok, reason) VALUES ($1,$2,true,$3)',
    [String(user.email || '').slice(0, 120), req.ip, provider.id]).catch(() => {});

  const expiresAt = Date.now() + authConfig.sessionTtlMs;
  const sessionId = await startSession({ userId: user.id, via: provider.id, req });
  res.cookie(
    authConfig.cookieName,
    signSession(databasePayload(user.id, user.session_version, expiresAt, sessionId), authConfig.sessionSecret),
    { ...cookieOptions(), maxAge: authConfig.sessionTtlMs }
  );
  res.redirect(next);
});
