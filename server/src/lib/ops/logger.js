/**
 * Structured request logs (#38): one JSON line per request with a request
 * id, the signed-in user, the route and the duration. Secrets never reach
 * the log: cookies and authorization headers are dropped, and one-time
 * tokens in paths or query strings are masked.
 */
import crypto from 'node:crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { config } from '../../config.js';

/** Long random path segments and token-like query values become "…". */
export function maskUrl(url) {
  return String(url || '')
    .replace(/\/(accept|login|reset|invite)\/[A-Za-z0-9_-]{20,}/g, '/$1/…')
    .replace(/\/api\/public\/accept\/[A-Za-z0-9_-]{20,}/g, '/api/public/accept/…')
    .replace(/([?&](?:token|code|state|validationToken|access_token|refresh_token|key)=)[^&#]*/gi, '$1…')
    .replace(/ctz_[A-Za-z0-9_-]{20,}/g, 'ctz_…');
}

const pretty = config.nodeEnv !== 'production' && process.env.LOG_FORMAT !== 'json';

// In development a short line is easier to read than JSON.
const devStream = {
  write(line) {
    try {
      const l = JSON.parse(line);
      if (l.req && l.res) {
        process.stdout.write(`${l.req.method} ${l.req.url} ${l.res.statusCode} ${l.responseTime}ms${l.user ? ` ${l.user}` : ''}\n`);
      } else process.stdout.write(`${l.msg || line}\n`);
    } catch { process.stdout.write(line); }
  },
};

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.nodeEnv === 'test' ? 'silent' : 'info'),
  base: { app: 'cetizion-tracker', env: process.env.APP_ENV || config.nodeEnv },
  redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-cetizion-signature"]', 'res.headers["set-cookie"]'], remove: true },
}, pretty ? devStream : undefined);

export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const id = req.get?.('x-request-id') && /^[A-Za-z0-9-]{8,64}$/.test(req.get('x-request-id')) ? req.get('x-request-id') : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customProps: (req) => ({ user: req.user?.username || (req.portal ? `portal:${req.portal.contact_id}` : undefined), route: req.route ? `${req.baseUrl}${req.route.path}` : undefined }),
  customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
  serializers: {
    req: (req) => ({ id: req.id, method: req.method, url: maskUrl(req.url), ip: req.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
  // Health checks every minute would drown everything else.
  autoLogging: { ignore: (req) => req.url === '/api/health' || req.url === '/metrics' },
});
