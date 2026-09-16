/**
 * Prometheus metrics (#38) at /metrics, for Grafana or Uptime Kuma: request
 * rate and duration by route, the database pool, job results and PDF build
 * time. Not public: a bearer token (METRICS_TOKEN) or a staff session.
 */
import client from 'prom-client';
import { pool } from '../../db.js';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'cetizion_' });

export const httpDuration = new client.Histogram({
  name: 'cetizion_http_request_duration_seconds', help: 'API request duration by route',
  labelNames: ['method', 'route', 'status'], buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry],
});
export const jobRuns = new client.Counter({ name: 'cetizion_job_runs_total', help: 'Scheduled job runs by result', labelNames: ['job', 'result'], registers: [registry] });
export const pdfDuration = new client.Histogram({ name: 'cetizion_pdf_build_seconds', help: 'PDF build time', labelNames: ['kind'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: [registry] });
export const alertsRaised = new client.Counter({ name: 'cetizion_alerts_total', help: 'Alerts raised by kind', labelNames: ['kind'], registers: [registry] });
export const failedSignIns = new client.Counter({ name: 'cetizion_failed_sign_ins_total', help: 'Failed staff sign-ins', registers: [registry] });

new client.Gauge({ name: 'cetizion_db_pool_connections', help: 'Database pool connections', labelNames: ['state'], registers: [registry],
  collect() {
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount);
    this.set({ state: 'waiting' }, pool.waitingCount);
  } });

/** Express middleware: times every API request by its route pattern, not its URL. */
export function httpMetrics(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : req.path.startsWith('/api') ? 'unmatched' : 'static';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

export async function timed(kind, fn) {
  const end = pdfDuration.startTimer({ kind });
  try { return await fn(); } finally { end(); }
}
