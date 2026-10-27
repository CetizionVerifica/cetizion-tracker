import { reportError } from '../lib/ops/errors.js';

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// A few constraints are checked by name, so the form can put the message
// next to the field it is about instead of in a banner. A new PO's own
// checks (purchaseOrders.js) run after the INSERT, so these are what a
// mistake meets first there.
const CONSTRAINT_FIELDS = {
  purchase_orders_replaces_key: ['replaces_po_number', 'That purchase order is already replaced by another revision: pick that revision instead'],
  purchase_orders_not_replacing_itself: ['replaces_po_number', 'A purchase order cannot replace itself'],
  purchase_orders_replaces_po_number_fkey: ['replaces_po_number', 'There is no purchase order with that number'],
  company_document_profiles_company_id_doc_type_key: ['company_id', 'This client already has a note for these documents: edit that one instead'],
};

// A company still named on these records cannot be deleted (089): the
// records would only bring it back. Merging is the way to get rid of one.
const COMPANY_IN_USE = new Set(['quotations_company_id_fkey', 'enquiries_company_id_fkey', 'projects_company_id_fkey']);

// Postgres constraint violations are user mistakes far more often than
// bugs, so translate the common ones into something a person can act on.
export function fromPgError(err) {
  if (err.code === '23503' && COMPANY_IN_USE.has(err.constraint) && /is still referenced/.test(err.detail || '')) {
    return {
      status: 409,
      message: `This company still has ${err.table || 'records'} under its name, so it cannot be deleted. Merge it into the company those records belong to instead.`,
    };
  }
  const field = CONSTRAINT_FIELDS[err.constraint];
  if (field && ['23505', '23514', '23503'].includes(err.code)) {
    return { status: 422, message: 'Please check the highlighted fields', fields: { [field[0]]: field[1] } };
  }
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
    return res.status(translated.status).json({ error: { message: translated.message, ...(translated.fields && { fields: translated.fields }) } });
  }

  (req.log || console).error?.({ err }, 'unhandled error');
  // Reported without the body, cookies or query string (#38).
  reportError(err, { source: 'api', route: req.route ? `${req.baseUrl}${req.route.path}` : undefined, method: req.method, url: req.originalUrl, requestId: req.id, user: req.user?.username });
  res.status(500).json({ error: { message: 'Something went wrong on the server', request_id: req.id } });
}
