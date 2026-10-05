/**
 * The worker process (#21): runs the scheduled jobs in JOBS on their cron
 * lines, in the business time zone, using pg-boss on the same Postgres.
 *
 * Start it as a second application from the same image:
 *   node src/worker.js        (npm run worker)
 *
 * pg-boss keeps its queue tables in its own `pgboss` schema, so it needs no
 * migration of ours, and a singleton schedule means one run per slot even
 * if two workers are started. The API never depends on this process: the
 * admin page can run any job by hand, and reminders are also logged when
 * EMAIL_MODE is not live.
 */
import { PgBoss } from 'pg-boss';
import { config } from './config.js';
import { aiConfig } from './lib/ai.js';
import { JOBS, runJob } from './jobs.js';
import { pool } from './db.js';
import { runWebhooks } from './lib/webhooks.js';
import { release, watchProcess } from './lib/ops/errors.js';

watchProcess('worker');

// What this process will do with mail and the AI, on its first line. The
// worker is a separate application with its own environment: a setting the
// API has and the worker lacks (EMAIL_MODE falls back to log) shows here.
const m = config.microsoft;
console.log(`[worker] EMAIL_MODE=${config.mail.mode} · SMTP ${config.mail.host ? 'configured' : 'not configured'} · Microsoft Graph ${m.clientId && m.clientSecret && m.tokenKey ? 'configured' : 'not configured'} · AI ${aiConfig.enabled ? 'configured' : 'not configured'} · time zone ${config.businessTimeZone} · release ${release()}`);

const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss' });
boss.on('error', (err) => console.error('[worker] pg-boss', err));

await boss.start();
for (const [name, job] of Object.entries(JOBS)) {
  await boss.createQueue(name);
  await boss.schedule(name, job.cron, null, { tz: config.businessTimeZone });
  await boss.work(name, async () => {
    const run = await runJob(name, { startedBy: 'schedule' });
    console.log(`[worker] ${name}: ${run.status}${run.error ? ` (${run.error})` : ''}`);
  });
  console.log(`[worker] ${name} at "${job.cron}" (${config.businessTimeZone})`);
}
// Webhook events are sent within seconds: the database notifies on each
// one, and the minute schedule above catches anything missed.
let sending = false;
let again = false;
async function sendWebhooks() {
  if (sending) { again = true; return; }
  sending = true;
  try { do { again = false; await runWebhooks(); } while (again); }
  catch (err) { console.error('[worker] webhooks', err.message); }
  finally { sending = false; }
}
const listener = await pool.connect();
listener.on('notification', () => { sendWebhooks(); });
await listener.query('LISTEN webhook_events');
console.log('[worker] running');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { listener.release(); await boss.stop({ graceful: true, timeout: 10_000 }); process.exit(0); });
}
