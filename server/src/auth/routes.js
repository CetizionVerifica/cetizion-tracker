import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { ApiError } from '../middleware/error.js';
import { authConfig } from './config.js';
import { readSession } from './middleware.js';
import { constantTimeEqual, signSession } from './session.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;

const credentials = z.object({
  username: z.string().trim().min(1, 'Enter the username'),
  password: z.string().min(1, 'Enter the password'),
});

// Only failed attempts count, so an open tab refreshing its session all day
// never locks the one person who is allowed in.
const loginLimiter = rateLimit({
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

const asUser = (username, expiresAt) => ({
  username,
  expires_at: new Date(expiresAt).toISOString(),
});

export const authRouter = Router();

authRouter.post('/login', loginLimiter, (req, res) => {
  const parsed = credentials.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      fields: Object.fromEntries(
        parsed.error.issues.map((i) => [i.path.join('.') || '_', i.message])
      ),
    });
  }

  const { username, password } = parsed.data;
  // Both comparisons run before the branch: `&&` would short-circuit and time
  // the username check separately from the password one.
  const usernameOk = constantTimeEqual(username, authConfig.username);
  const passwordOk = constantTimeEqual(password, authConfig.password);
  if (!(usernameOk && passwordOk)) {
    throw new ApiError(401, 'That username and password do not match');
  }

  const expiresAt = Date.now() + authConfig.sessionTtlMs;
  const token = signSession({ sub: username, exp: expiresAt }, authConfig.sessionSecret);

  res.cookie(authConfig.cookieName, token, { ...cookieOptions(), maxAge: authConfig.sessionTtlMs });
  res.json({ data: asUser(username, expiresAt) });
});

authRouter.post('/logout', (req, res) => {
  res.clearCookie(authConfig.cookieName, cookieOptions());
  res.status(204).end();
});

authRouter.get('/me', (req, res) => {
  const session = readSession(req);
  if (!session) throw new ApiError(401, 'Not signed in');
  res.json({ data: asUser(session.sub, session.exp) });
});
