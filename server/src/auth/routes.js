import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { query } from '../db.js';
import { config } from '../config.js';
import { raiseAlert } from '../lib/ops/alerts.js';
import { failedSignIns } from '../lib/ops/metrics.js';

import { ApiError } from '../middleware/error.js';
import { verifyPasswordOrDummy } from '../lib/passwords.js';
import { findUserByEmail, recordLogin } from '../lib/users.js';
import { startSession } from '../lib/sessions.js';
import { authConfig } from './config.js';
import { currentUser, requireAdmin, requireAuth } from './middleware.js';
import { constantTimeEqual, databasePayload, sharedPayload, signSession } from './session.js';
import { enabledProviders, oauthRouter, providerSetup } from './oauth.js';
import { accountRouter } from './account.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
// The sign-in form starts warning at this many attempts remaining.
const WARN_WHEN_LEFT = 2;

const sharedCredentials = z.object({
  username: z.string().trim().min(1, 'Enter the username'),
  password: z.string().min(1, 'Enter the password'),
});

/**
 * Database mode signs in with an email address. Phase 1B-A accepted
 * `username` as a second name for this field so the old form could reach
 * it; the form now posts `email`, and the alias is gone — one field, one
 * name, no guessing which the caller meant.
 */
const databaseCredentials = z.object({
  email: z.string().trim().min(1, 'Enter the email address'),
  password: z.string().min(1, 'Enter the password'),
});

// Only failed attempts count, so an open tab refreshing its session all day
// never locks the one person who is allowed in. Keyed on the caller's
// address, which is what it has always been: moving from a username to an
// email changed the field being guessed, not who is guessing, so the limit
// follows the attacker either way and cannot be shaken off by switching
// the address being tried.
// Exported so a test can clear it between cases; the app itself only ever
// mounts it. Nothing here weakens the limit at run time.
export const loginLimiter = rateLimit({
  windowMs: LOGIN_WINDOW_MS,
  limit: MAX_LOGIN_ATTEMPTS,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { message: 'Too many sign-in attempts — wait a few minutes and try again' } },
});

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: authConfig.secureCookie,
  path: '/',
});

const parse = (schema, body) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }
  return parsed.data;
};

/** What the browser is told about whoever just signed in. Never a hash. */
const sharedBody = (username, expiresAt) => ({
  username,
  expires_at: new Date(expiresAt).toISOString(),
});

const databaseBody = (user, expiresAt) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
  expires_at: new Date(expiresAt).toISOString(),
});

export const authRouter = Router();

// ------------------------------------------------------------- lockout (#34)
// Stored failures per address, on top of the in-memory limiter above: they
// survive a restart, raise an alert once, and work the same in both sign-in
// modes, because they wrap whichever check runs.
const setting = async (key, fallback) => Number((await query('SELECT value FROM settings WHERE key = $1', [key]).catch(() => ({ rows: [] }))).rows[0]?.value) || fallback;

/** Failures from this address inside the window, since its last success. */
/**
 * Failed sign-ins that still count, two ways: against this account from
 * this address, and against this address whoever was being guessed at.
 *
 * The account one is what is enforced. Counting only the address locks the
 * wrong people out: behind Traefik every request carries the proxy's
 * address, so ten bad guesses from anywhere on the internet used to lock
 * out the whole company for fifteen minutes — people typing the right
 * password included. A success clears the count it belongs to, so getting
 * it right on the eleventh attempt is not punished.
 */
async function recentFailures(ip, username) {
  const minutes = await setting('signin_lockout_minutes', 15);
  const name = String(username || '').slice(0, 120).toLowerCase();
  const { rows: [r] } = await query(
    `SELECT
       (SELECT COUNT(*)::int FROM auth_events
         WHERE ip = $1 AND lower(username) = $3 AND NOT ok AND created_at > now() - make_interval(mins => $2)
           AND created_at > COALESCE((SELECT MAX(created_at) FROM auth_events WHERE ip = $1 AND lower(username) = $3 AND ok), '-infinity')) AS account,
       (SELECT COUNT(*)::int FROM auth_events
         WHERE ip = $1 AND NOT ok AND created_at > now() - make_interval(mins => $2)
           AND created_at > COALESCE((SELECT MAX(created_at) FROM auth_events WHERE ip = $1 AND ok), '-infinity')) AS address`,
    [ip, minutes, name]).catch(() => ({ rows: [{ account: 0, address: 0 }] }));
  return { account: r.account, address: r.address, minutes };
}

/**
 * Whether req.ip is really the caller's address. With a proxy in front and
 * TRUST_PROXY=0 it is the proxy's, and an address-wide lock built on it
 * punishes everybody for one stranger. With no proxy at all there is
 * nothing to forward, so the address stands.
 */
const addressIsTheCallers = (req) => config.trustProxy > 0 || !req.headers['x-forwarded-for'];
/**
 * `userId` is which account it turned out to be, once one was resolved
 * (065). Null on a failure, because nobody knows who a wrong password
 * belongs to, and null in shared mode, where there is no users row to point
 * at. `username` stays beside it: for a failure it is the only thing there
 * is, and it is what the lockout counts on.
 *
 * Still .catch(() => {}) — a sign-in that succeeded must not be turned into
 * a 500 because the audit insert failed. That is the opposite of
 * logActivity's rule, and deliberately: there the write is the thing being
 * audited and can be rolled back, whereas here the session already exists.
 */
const record = (who, ip, ok, reason, userId = null) =>
  query(
    'INSERT INTO auth_events (username, ip, ok, reason, user_id) VALUES ($1,$2,$3,$4,$5)',
    [String(who || '').slice(0, 120), ip, ok, reason, userId]
  ).catch(() => {});

function sharedLogin(body) {
  const { username, password } = parse(sharedCredentials, body);

  // Both comparisons run before the branch: `&&` would short-circuit and time
  // the username check separately from the password one.
  const usernameOk = constantTimeEqual(username, authConfig.username);
  const passwordOk = constantTimeEqual(password, authConfig.password);
  if (!(usernameOk && passwordOk)) {
    throw new ApiError(401, 'That username and password do not match');
  }

  const expiresAt = Date.now() + authConfig.sessionTtlMs;
  return { payload: sharedPayload(username, expiresAt), body: sharedBody(username, expiresAt), expiresAt };
}

/**
 * Sign in against the users table.
 *
 * Every way of failing takes the same path and the same time. An address
 * nobody holds, an account switched off, one with no password set and a
 * password simply typed wrong all end at verifyPasswordOrDummy, which does
 * a real scrypt either way, and all four come back as the same sentence.
 * Anything else — an early return, a kinder message for an account that
 * exists — would answer the question "does this person work here?" to
 * whoever asked.
 */
async function databaseLogin(body, req) {
  const { email, password } = parse(databaseCredentials, body);

  const user = await findUserByEmail(email);
  // Only an account that may actually sign in offers a hash to check
  // against; for every other case the dummy is checked instead.
  const hash = user && user.active ? user.password_hash : null;

  if (!(await verifyPasswordOrDummy(password, hash))) {
    throw new ApiError(401, 'That email address and password do not match');
  }

  await recordLogin(user.id);

  const expiresAt = Date.now() + authConfig.sessionTtlMs;
  // Signed with the counter the row carries right now. A reset or a
  // deactivation raises it, and every cookie signed before that — this one
  // included, if it loses the race — stops matching on its next request.
  // Failing that way round is the safe one: a session too few, never one
  // too many.
  const sessionId = await startSession({ userId: user.id, via: 'password', req });
  return {
    payload: databasePayload(user.id, user.session_version, expiresAt, sessionId),
    body: databaseBody(user, expiresAt),
    expiresAt,
  };
}

authRouter.post('/login', loginLimiter, async (req, res) => {
  // Whatever was typed as the name, for the record only; never used to decide.
  const who = req.body?.email ?? req.body?.username ?? '';
  const limit = await setting('signin_lockout_failures', 10);
  const before = await recentFailures(req.ip, who);
  // The account lock always applies. The address-wide one is five times the
  // limit and only when the address is the caller's own, because otherwise
  // it is the proxy's and locking it locks everyone.
  const lockedOut = before.account >= limit || (addressIsTheCallers(req) && before.address >= limit * 5);
  if (lockedOut) {
    await record(who, req.ip, false, 'locked');
    throw new ApiError(429, `Too many failed sign-ins. Try again in ${before.minutes} minutes.`);
  }

  let result;
  try {
    result = authConfig.mode === 'database' ? await databaseLogin(req.body, req) : sharedLogin(req.body);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await record(who, req.ip, false, 'bad credentials');
      failedSignIns.inc();
      // "Two attempts left" only once it is two, so an ordinary typo is not
      // alarming and the number is not a running commentary for whoever is
      // guessing. They could count their own failures anyway; what this
      // avoids is announcing the limit from the first mistake.
      const left = limit - (before.account + 1);
      if (left <= WARN_WHEN_LEFT && left > 0) err.extra = { ...err.extra, attempts_left: left, lockout_minutes: before.minutes };
      // Raised once, when this account reaches the limit.
      if (before.account + 1 === limit) {
        raiseAlert('signin', `${limit} failed sign-ins for one account from ${req.ip}`, `Name tried: ${String(who).slice(0, 60)}. That account is locked from this address for ${before.minutes} minutes.`).catch(() => {});
      }
    }
    throw err;
  }
  // The account it resolved to, not the spelling that was typed. In shared
  // mode there is none, and null is the honest answer rather than an id.
  await record(who, req.ip, true, null, result.body?.id ?? null);
  const { payload, body, expiresAt } = result;

  const token = signSession(payload, authConfig.sessionSecret);
  res.cookie(authConfig.cookieName, token, { ...cookieOptions(), maxAge: authConfig.sessionTtlMs });
  res.json({ data: body });
});

/**
 * Which field the sign-in form should ask for. Public on purpose — it is
 * read before anybody is signed in, and it is the one thing the form
 * cannot work out for itself.
 *
 * The mode and nothing else. Not AUTH_USERNAME, not the bootstrap address,
 * not the password policy: an unauthenticated caller learns only which
 * question they will be asked, which they would learn from the form anyway.
 */
authRouter.get('/config', (req, res) => {
  // The mode, and which provider buttons to draw. Both are things the form
  // would learn by being rendered anyway. Still not: AUTH_USERNAME, the
  // bootstrap address, the password policy, or whether a given account
  // exists.
  res.json({ data: { mode: authConfig.mode, providers: enabledProviders() } });
});

/**
 * How far each provider is from working, for the admin setting one up.
 *
 * Admin-only, and it never returns a value — only which variable names are
 * still blank, plus the redirect this server expects, which is the string
 * that has to match the provider's console to the character.
 */
authRouter.get('/providers', requireAuth, requireAdmin, (req, res) => {
  res.json({ data: { mode: authConfig.mode, providers: providerSetup() } });
});

authRouter.use('/oauth', oauthRouter);
authRouter.use('/account', accountRouter);

authRouter.post('/logout', async (req, res) => {
  // Read before the cookie is cleared, so the row can say whose session
  // ended. A session's end was invisible until 065, which left "were they
  // still signed in at 19:40?" with no answer either way.
  const user = await currentUser(req).catch(() => null);
  res.clearCookie(authConfig.cookieName, cookieOptions());
  // ok = true: signing out is a success, not a failed sign-in. The lockout
  // counts rows with `ok` false and takes MAX(created_at) WHERE ok as the
  // point to count from, so a sign-out reads as "they got in", which is
  // true and is what clears the failure count anyway.
  await record(user?.name ?? user?.username ?? null, req.ip, true, 'signed out', user?.id ?? null);
  res.status(204).end();
});

/**
 * Who is signed in now — read fresh, so this reports the role somebody has
 * rather than the one they had when they signed in.
 */
authRouter.get('/me', async (req, res) => {
  const user = await currentUser(req);
  if (!user) throw new ApiError(401, 'Not signed in');

  res.json({
    data:
      user.mode === 'database'
        ? databaseBody(user, user.expiresAt)
        : sharedBody(user.username, user.expiresAt),
  });
});
