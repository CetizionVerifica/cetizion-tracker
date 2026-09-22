/**
 * Which environment this is (#35). APP_ENV=staging turns every outbound
 * channel off in code, whatever the database or other variables say, and
 * STAGING_BASIC_AUTH ("user:password") puts the whole site behind a shared
 * credential.
 */
import crypto from 'node:crypto';

export const appEnv = () => (process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'development')).toLowerCase();
export const isStaging = () => appEnv() === 'staging';

/** Refuse an outbound action on staging. */
export function assertNotStaging(what) {
  if (isStaging()) throw Object.assign(new Error(`${what} is switched off on staging`), { status: 409 });
}

const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/** HTTP basic auth for the whole staging site; the plain health check stays open for the platform. */
export function stagingGate(req, res, next) {
  const expected = process.env.STAGING_BASIC_AUTH || '';
  if (!expected || req.path === '/api/health') return next();
  const [scheme, value] = String(req.get('authorization') || '').split(' ');
  // MCP clients and webhooks carry their own bearer tokens; the gate still applies to them.
  const given = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString('utf8') : '';
  if (given && same(given, expected)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Cetizion staging", charset="UTF-8"').status(401).send('Staging: sign in with the shared staging credential.');
}
