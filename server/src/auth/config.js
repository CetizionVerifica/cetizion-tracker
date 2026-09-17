import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * One user, one password, held in the environment next to DATABASE_URL.
 *
 * In production a missing password or secret is fatal: a tracker that boots
 * without a lock is worse than one that does not boot at all. In development
 * both fall back so `npm run dev` still works with no .env file.
 */

const DEV_PASSWORD = 'cetizion-dev';
const MIN_SECRET_LENGTH = 32;
const DEFAULT_SESSION_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Who the API checks a sign-in against.
 *
 *   shared    AUTH_USERNAME / AUTH_PASSWORD from the environment — one
 *             account, exactly as the tracker has always worked.
 *   database  an email and password in the users table.
 *
 * The default is deliberately `shared`: deploying this code without
 * touching the environment must not change how anybody signs in. Moving to
 * `database` is a decision somebody makes, not something that happens.
 *
 * The two never assist each other. In database mode the shared password is
 * not a fallback, and in shared mode a users row is not an alternate way
 * in — a mode that quietly accepted both would be two locks on one door
 * with only one of them audited.
 */
export const AUTH_MODES = ['shared', 'database'];
const DEFAULT_MODE = 'shared';

const isProduction = config.nodeEnv === 'production';

class AuthConfigError extends Error {}

function fatal(message) {
  throw new AuthConfigError(
    `${message}\n` +
      'Set it in the environment before starting the API. ' +
      'See server/.env.example for the full list.'
  );
}

function resolvePassword() {
  const provided = process.env.AUTH_PASSWORD || '';
  if (provided) return provided;
  if (isProduction) fatal('AUTH_PASSWORD is not set.');
  console.warn(`[auth] AUTH_PASSWORD is not set — using the development password "${DEV_PASSWORD}".`);
  return DEV_PASSWORD;
}

function resolveSecret() {
  const provided = process.env.SESSION_SECRET || '';
  if (provided.length >= MIN_SECRET_LENGTH) return provided;

  if (isProduction) {
    fatal(
      provided
        ? `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`
        : 'SESSION_SECRET is not set.'
    );
  }
  if (provided) {
    console.warn(`[auth] SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — ignoring it.`);
  }
  console.warn('[auth] Using a throwaway SESSION_SECRET — everyone is signed out when the API restarts.');
  return randomBytes(32).toString('hex');
}

function resolveSessionTtlMs() {
  const hours = Number(process.env.SESSION_TTL_HOURS || DEFAULT_SESSION_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.warn(`[auth] SESSION_TTL_HOURS is not a positive number — falling back to ${DEFAULT_SESSION_HOURS}.`);
    return DEFAULT_SESSION_HOURS * HOUR_MS;
  }
  return hours * HOUR_MS;
}

/**
 * An unrecognised AUTH_MODE is always fatal, in every environment. Falling
 * back to a default would mean a typo silently chooses who may sign in.
 */
function resolveMode() {
  const provided = String(process.env.AUTH_MODE ?? '').trim();
  if (provided === '') return DEFAULT_MODE;
  if (AUTH_MODES.includes(provided)) return provided;
  fatal(`AUTH_MODE must be one of: ${AUTH_MODES.join(', ')}. It is set to something else.`);
}

// Cookies are refused by the browser over plain HTTP once `secure` is set, so
// this needs an escape hatch for anyone running behind a proxy that terminates
// TLS elsewhere or on an internal host with no certificate.
function resolveSecureCookie() {
  const override = process.env.COOKIE_SECURE;
  if (override === undefined || override === '') return isProduction;
  return override !== 'false' && override !== '0';
}

export const authConfig = {
  mode: resolveMode(),
  username: process.env.AUTH_USERNAME || 'admin',
  password: resolvePassword(),
  sessionSecret: resolveSecret(),
  sessionTtlMs: resolveSessionTtlMs(),
  secureCookie: resolveSecureCookie(),
  cookieName: 'cetizion_session',
};
