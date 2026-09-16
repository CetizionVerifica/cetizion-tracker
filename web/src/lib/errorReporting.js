/**
 * Browser errors go to the API, which scrubs them and forwards them to
 * error tracking (#38). At most one report per message per page load.
 */
const seen = new Set();

function send(name, message, stack) {
  const key = `${name}:${message}`;
  if (seen.has(key) || seen.size > 20) return;
  seen.add(key);
  fetch('/api/client-errors', {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, message: String(message).slice(0, 500), stack: String(stack || '').slice(0, 4000), route: window.location.pathname, release: import.meta.env.VITE_RELEASE || '' }),
  }).catch(() => {});
}

export function startErrorReporting() {
  window.addEventListener('error', (e) => send(e.error?.name || 'Error', e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', (e) => send(e.reason?.name || 'UnhandledRejection', e.reason?.message || e.reason, e.reason?.stack));
}
