import { ApiError } from '../middleware/error.js';
import { authConfig } from './config.js';
import { verifySession } from './session.js';

/** @returns the session payload for this request, or null when signed out. */
export function readSession(req) {
  const token = req.cookies?.[authConfig.cookieName];
  return token ? verifySession(token, authConfig.sessionSecret) : null;
}

export function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return next(new ApiError(401, 'Your session has ended — sign in again'));
  }
  req.user = { username: session.sub };
  next();
}
