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
import { JOBS, runJob } from './jobs.js';
import { pool } from './db.js';
import { runWebhooks } from './lib/webhooks.js';

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
