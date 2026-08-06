const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status, fields } = {}) {
    super(message);
    this.status = status;
    this.fields = fields || null;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server — is the API running?');
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(payload?.error?.message || `Request failed (${response.status})`, {
      status: response.status,
      fields: payload?.error?.fields,
    });
  }
  return payload;
}

const qs = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, value);
  }
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const api = {
  list: (resource, params, opts) => request(`/${resource}${qs(params)}`, opts),
  get: (resource, id, opts) => request(`/${resource}/${encodeURIComponent(id)}`, opts),
  create: (resource, body) => request(`/${resource}`, { method: 'POST', body }),
  update: (resource, id, body) =>
    request(`/${resource}/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  remove: (resource, id) =>
    request(`/${resource}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  action: (path, body) => request(path, { method: 'POST', body: body || {} }),
  raw: (path, opts) => request(path, opts),
  exportUrl: (resource) => `${BASE}/export/${resource}.csv`,
};
