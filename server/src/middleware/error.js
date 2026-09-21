import { reportError } from '../lib/ops/errors.js';

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Postgres constraint violations are user mistakes far more often than
// bugs, so translate the common ones into something a person can act on.
export function fromPgError(err) {
  switch (err.code) {
    case '23505': {
      const match = /Key \((.+?)\)=\((.+?)\)/.exec(err.detail || '');
      return {
        status: 409,
        message: match
          ? `${match[1].replace(/_/g, ' ')} "${match[2]}" is already in use`
          : 'That record already exists',
      };
    }
    case '23503':
      return {
        status: 409,
        message:
          /is still referenced/.test(err.detail || '')
            ? 'Cannot delete: other records still point at this one'
            : 'A linked record does not exist — check the ID you entered',
      };
    case '23514':
      return { status: 422, message: 'A value is outside the allowed range' };
    case '22P02':
      return { status: 422, message: 'A value has the wrong format' };
    default:
      return null;
  }
}

export function notFound(req, res) {
  res.status(404).json({ error: { message: `No route for ${req.method} ${req.originalUrl}` } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies this by arity
export function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { message: err.message, ...err.extra } });
  }

  const translated = fromPgError(err);
  if (translated) {
    return res.status(translated.status).json({ error: { message: translated.message } });
  }

  (req.log || console).error?.({ err }, 'unhandled error');
  // Reported without the body, cookies or query string (#38).
  reportError(err, { source: 'api', route: req.route ? `${req.baseUrl}${req.route.path}` : undefined, method: req.method, url: req.originalUrl, requestId: req.id, user: req.user?.username });
  res.status(500).json({ error: { message: 'Something went wrong on the server', request_id: req.id } });
}
