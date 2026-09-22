/**
 * Error reports to Sentry or a self-hosted GlitchTip (#38), with no SDK:
 * one envelope per error over HTTPS. Set SENTRY_DSN to turn it on.
 *
 * What is sent: the error, its stack, the release (the deployed commit),
 * the environment, the route, the request id and the user name. What is
 * never sent: request bodies, cookies, headers, query strings, or tokens.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import { maskUrl } from './logger.js';

const dsn = (() => {
  try {
    const u = new URL(process.env.SENTRY_DSN || '');
    const projectId = u.pathname.replace(/^\//, '');
    return { key: u.username, url: `${u.protocol}//${u.host}/api/${projectId}/envelope/`, raw: u.toString() };
  } catch { return null; }
})();

export const errorReportingEnabled = () => Boolean(dsn);
export const release = () => process.env.RELEASE || process.env.GIT_SHA || process.env.SOURCE_COMMIT || 'dev';
const environment = () => process.env.APP_ENV || process.env.NODE_ENV || 'development';

const SECRETISH = /(password|secret|token|authorization|cookie|api[_-]?key|dsn)\s*[=:]\s*\S+/gi;
const scrub = (s) => String(s || '').replace(SECRETISH, '$1=…').replace(/ctz_[A-Za-z0-9_-]{20,}/g, 'ctz_…').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '…@…');

function frames(stack) {
  return String(stack || '').split('\n').slice(1, 40).reverse().map((line) => {
    const m = line.match(/at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
    return m ? { function: m[1] || '?', filename: m[2].replace(/^file:\/\/\/?/, '').replace(/.*\/(server|web)\//, '$1/'), lineno: Number(m[2] ? m[3] : 0), colno: Number(m[4]), in_app: !m[2].includes('node_modules') } : { function: line.trim() };
  });
}

/**
 * @param err  the error
 * @param ctx  { route, method, url, requestId, user, tags, level, source }
 */
export async function reportError(err, ctx = {}, { fetchImpl = fetch } = {}) {
  if (!dsn) return null;
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: ctx.level || 'error',
    release: release(),
    environment: environment(),
    server_name: os.hostname(),
    transaction: ctx.route || undefined,
    tags: { source: ctx.source || 'api', route: ctx.route, method: ctx.method, ...ctx.tags },
    user: ctx.user ? { username: String(ctx.user) } : undefined,
    request: ctx.url ? { url: maskUrl(ctx.url).split('?')[0], method: ctx.method } : undefined,
    extra: { request_id: ctx.requestId },
    exception: { values: [{ type: err?.name || 'Error', value: scrub(err?.message || err), stacktrace: { frames: frames(err?.stack) } }] },
  };
  const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString(), dsn: dsn.raw })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
  try {
    const r = await fetchImpl(dsn.url, {
      method: 'POST', signal: AbortSignal.timeout(5000), body,
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=cetizion-tracker/1.0, sentry_key=${dsn.key}` },
    });
    return r.ok ? eventId : null;
  } catch { return null; }
}

/** Unhandled errors in a process (API or worker) are reported before it goes down. */
export function watchProcess(source, log = console) {
  process.on('unhandledRejection', (reason) => {
    log.error?.({ err: reason }, `[${source}] unhandled rejection`);
    reportError(reason instanceof Error ? reason : new Error(String(reason)), { source, level: 'error' });
  });
  process.on('uncaughtException', (err) => {
    log.error?.({ err }, `[${source}] uncaught exception`);
    reportError(err, { source, level: 'fatal' }).finally(() => process.exit(1));
  });
}
