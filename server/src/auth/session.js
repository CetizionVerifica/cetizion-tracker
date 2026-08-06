import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Sessions are a signed payload in a cookie rather than rows in a table.
 * Nothing to store, nothing to clean up, and the API can be restarted or run
 * twice over without anyone losing their place.
 */

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const macOf = (body, secret) => createHmac('sha256', secret).update(body).digest('base64url');

/**
 * Compare without leaking, through timing, how much of the input was right.
 * Both sides are hashed first so that even the length gives nothing away.
 */
export function constantTimeEqual(a, b) {
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function signSession(payload, secret) {
  const body = encode(payload);
  return `${body}.${macOf(body, secret)}`;
}

/** @returns the payload, or null for anything that is not a live, untampered token. */
export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  if (!body || !mac) return null;

  if (!constantTimeEqual(mac, macOf(body, secret))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return payload;
}
