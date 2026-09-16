/**
 * Operations endpoints (#38).
 *
 *   GET  /api/health?deep=1    signed in only: database, migrations, backups, jobs, queue
 *   GET  /metrics              METRICS_TOKEN bearer or a staff session
 *   POST /api/client-errors    browser errors from signed-in users, scrubbed and forwarded
 */
import { readdirSync } from 'node:fs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db.js';
import { readSession } from '../auth/middleware.js';
import { constantTimeEqual } from '../auth/session.js';
import { ApiError } from '../middleware/error.js';
import { MIGRATIONS_DIR } from '../migrations.js';
import { JOBS } from '../jobs.js';
import { registry } from '../lib/ops/metrics.js';
import { errorReportingEnabled, release, reportError } from '../lib/ops/errors.js';

export const metricsRouter = Router();
export const clientErrorRouter = Router();

const STARTED = Date.now();

export async function deepHealth() {
  const checks = {};
  const t0 = Date.now();
  await query('SELECT 1');
  checks.database = { ok: true, ms: Date.now() - t0 };

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const { rows: applied } = await query('SELECT name FROM schema_migrations').catch(() => ({ rows: [] }));
  const done = new Set(applied.map((r) => r.name));
  const pending = files.filter((f) => !done.has(f));
  checks.migrations = { ok: pending.length === 0, applied: done.size, pending };

  const { rows: [b] } = await query(`SELECT to_regclass('backup_runs') IS NOT NULL AS present`);
  if (b.present) {
    const { rows: [last] } = await query(
      `SELECT (SELECT row_to_json(x) FROM (SELECT finished_at, size_bytes, location FROM backup_runs WHERE kind = 'backup' AND ok ORDER BY finished_at DESC LIMIT 1) x) AS backup,
              (SELECT row_to_json(x) FROM (SELECT finished_at, detail FROM backup_runs WHERE kind = 'verify' AND ok ORDER BY finished_at DESC LIMIT 1) x) AS verify,
              (SELECT row_to_json(x) FROM (SELECT kind, finished_at, error FROM backup_runs WHERE NOT ok ORDER BY finished_at DESC LIMIT 1) x) AS last_failure`);
    const age = last.backup ? (Date.now() - new Date(last.backup.finished_at)) / 3600e3 : null;
    checks.backups = { ok: age !== null && age < 8, hours_since_backup: age === null ? null : Math.round(age * 10) / 10, ...last };
  } else checks.backups = { ok: false, note: 'no backup records yet' };

  const { rows: runs } = await query(
    `SELECT DISTINCT ON (name) name, status, started_at, finished_at, error FROM job_runs ORDER BY name, started_at DESC`);
  const { rows: [fails] } = await query(`SELECT COUNT(*)::int AS n FROM job_runs WHERE status = 'failed' AND started_at > now() - interval '24 hours'`);
  checks.jobs = {
    ok: fails.n === 0,
    failed_last_24h: fails.n,
    last_runs: Object.keys(JOBS).map((name) => ({ name, ...(runs.find((r) => r.name === name) || { status: 'never run' }) })),
  };

  const { rows: [q] } = await query(`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`);
  if (q.present) {
    const { rows } = await query(`SELECT state, COUNT(*)::int AS n FROM pgboss.job WHERE state IN ('created','retry','active','failed') GROUP BY state`).catch(() => ({ rows: [] }));
    checks.queue = { ok: !rows.some((r) => r.state === 'failed' && r.n > 0), ...Object.fromEntries(rows.map((r) => [r.state, r.n])) };
  } else checks.queue = { ok: true, note: 'worker has not started on this database' };

  return {
    status: Object.values(checks).every((c) => c.ok) ? 'ok' : 'degraded',
    release: release(), environment: process.env.APP_ENV || process.env.NODE_ENV || 'development',
    uptime_seconds: Math.round((Date.now() - STARTED) / 1000), error_reporting: errorReportingEnabled(), checks,
  };
}

/** The deep check answers only to a signed-in person; the plain one stays public. */
export async function healthHandler(req, res, next) {
  if (!req.query.deep) return next();
  if (!readSession(req)) throw new ApiError(401, 'Sign in to see the detailed health check');
  const r = await deepHealth();
  res.status(r.status === 'ok' ? 200 : 503).json(r);
}

metricsRouter.get('/', async (req, res) => {
  const token = process.env.METRICS_TOKEN || '';
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const allowed = (token && bearer && constantTimeEqual(bearer, token)) || readSession(req);
  if (!allowed) return res.status(401).set('WWW-Authenticate', 'Bearer').send('Unauthorized');
  res.set('Content-Type', registry.contentType);
  res.send(await registry.metrics());
});

clientErrorRouter.post('/', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }), async (req, res) => {
  const b = req.body || {};
  const err = new Error(String(b.message || 'Browser error').slice(0, 500));
  err.name = String(b.name || 'BrowserError').slice(0, 80);
  err.stack = `${err.name}: ${err.message}\n${String(b.stack || '').slice(0, 4000)}`;
  await reportError(err, { source: 'web', route: String(b.route || '').slice(0, 200), user: req.user?.username, requestId: req.id, tags: { release_web: String(b.release || '').slice(0, 60) } });
  req.log?.warn({ browserError: err.message, route: b.route }, 'browser error');
  res.status(204).end();
});
