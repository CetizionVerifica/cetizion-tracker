const BASE = '/api';

export class ApiError extends Error {
  constructor(message, { status, fields } = {}) {
    super(message);
    this.status = status;
    this.fields = fields || null;
  }
}

// A session can lapse while a tab sits open. The provider registers here so
// that the first request to come back 401 drops the whole app to the sign-in
// screen, rather than each page reporting its own puzzling error.
let onUnauthorized = null;
export const setUnauthorizedHandler = (handler) => {
  onUnauthorized = handler;
};

// A file travels as the raw request body; its name and type ride in headers.
const fileHeaders = (file) => ({
  'Content-Type': 'application/octet-stream',
  'X-File-Name': encodeURIComponent(file.name),
  'X-File-Type': file.type || '',
});

async function request(path, { method = 'GET', body, file, signal } = {}) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal,
      credentials: 'include',
      headers: file ? fileHeaders(file) : body ? { 'Content-Type': 'application/json' } : undefined,
      body: file || (body ? JSON.stringify(body) : undefined),
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the server — is the API running?');
  }

  // The sign-in call answers 401 for a wrong password, which is a message for
  // that form to show, not a sign that the session went away.
  if (response.status === 401 && !path.startsWith('/auth/')) {
    onUnauthorized?.();
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
  uploadDocument: (file, owner) =>
    request(`/documents?for=${encodeURIComponent(owner)}`, { method: 'POST', file }),
  documentUrl: (id) => `${BASE}/documents/${id}`,
  exportUrl: (resource) => `${BASE}/export/${resource}.csv`,
  reportCsvUrl: (report, params) => `${BASE}/export/sales-report/${report}.csv${qs(params)}`,
  reportPdfUrl: (params) => `${BASE}/export/sales-report.pdf${qs(params)}`,
  auth: {
    me: () => request('/auth/me'),
    login: (username, password) =>
      request('/auth/login', { method: 'POST', body: { username, password } }),
    logout: () => request('/auth/logout', { method: 'POST' }),
  },
};
