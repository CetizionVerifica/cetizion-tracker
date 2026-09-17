/**
 * The scheduled jobs (#21). One registry, used by the worker process
 * (src/worker.js) and by the admin "Run now" button, so a job behaves the
 * same however it was started. Every run is recorded in job_runs.
 */
import { query } from './db.js';
import { purgeOrphanedDocuments } from './lib/documents.js';
import { runFinanceDigest, runPaymentReminders } from './lib/reminders.js';

export const JOBS = {
  'reminders.payment': {
    description: 'Email each client with overdue invoices, once per interval, and note the chase on the stage',
    cron: '0 9 * * 1-5',        // weekday mornings, business time zone
    run: (opts) => runPaymentReminders(opts),
  },
  'finance.digest': {
    description: 'Morning summary to finance: stages to invoice, overdue invoices, reminders sent',
    cron: '30 8 * * 1-5',
    run: (opts) => runFinanceDigest(opts),
  },
  // A purge that could not reach Cloudinary leaves the row marked and tries
  // again here. Without a schedule the only retry was the next upload, so on
  // a quiet system the file and its row stayed for good.
  'documents.purge': {
    description: 'Finish interrupted document removals and clear uploads whose form was never saved',
    cron: '0 3 * * *',           // overnight, when nobody is uploading
    run: () => purgeOrphanedDocuments(),
  },
};

export const isJob = (name) => Object.hasOwn(JOBS, name);

/** Run one job now, recording the run. Never throws; the run row carries the error. */
export async function runJob(name, { startedBy = 'schedule' } = {}) {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown job ${name}`);
  const { rows: [run] } = await query('INSERT INTO job_runs (name, started_by) VALUES ($1, $2) RETURNING id', [name, startedBy]);
  try {
    const result = await job.run({ startedBy });
    await query(`UPDATE job_runs SET status = 'done', finished_at = now(), result = $2 WHERE id = $1`, [run.id, JSON.stringify(result)]);
    return { id: run.id, status: 'done', result };
  } catch (err) {
    await query(`UPDATE job_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, String(err.stack || err).slice(0, 2000)]);
    return { id: run.id, status: 'failed', error: err.message };
  }
}

export async function lastRuns() {
  const { rows } = await query(
    `SELECT DISTINCT ON (name) name, started_by, started_at, finished_at, status, result, error
       FROM job_runs ORDER BY name, started_at DESC`
  );
  return Object.fromEntries(rows.map((r) => [r.name, r]));
}
