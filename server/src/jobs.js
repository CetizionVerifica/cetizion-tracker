/**
 * The scheduled jobs (#21). One registry, used by the worker process
 * (src/worker.js) and by the admin "Run now" button, so a job behaves the
 * same however it was started. Every run is recorded in job_runs.
 */
import { query } from './db.js';
import { purgeOrphanedDocuments } from './lib/documents.js';
import { runFinanceDigest, runPaymentReminders } from './lib/reminders.js';
import { runRenewals } from './lib/renewals.js';
import { runNotifications } from './lib/notify.js';
import { runDeliverableReminders } from './lib/deliverables.js';
import { syncAll } from './lib/mailbox/sync.js';
import { runVisitReminders } from './lib/visits.js';
import { runWebhooks } from './lib/webhooks.js';
import { runAccountingSync } from './routes/accounting.js';
import './lib/inbox.js'; // routes shared-mailbox mail into the inbox while syncing

/**
 * Quotations sent from the tracker whose validity passed more than the grace
 * period ago are marked lost as expired. Only sent ones: anything typed in
 * or imported without a send is left for a person to decide.
 */
async function expireQuotations() {
  const { rows: [{ value: grace }] } = await query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'quotation_expiry_grace_days'), '14') AS value`);
  const { rows } = await query(
    `UPDATE quotations q
        SET lost_reason_id = (SELECT id FROM lost_reasons WHERE name = 'Quotation expired'),
            lost_notes = 'Validity date ' || q.valid_until || ' passed',
            status = 'Lost'
      WHERE q.status IN ('Submitted', 'Under Negotiation') AND q.sent_at IS NOT NULL AND q.accepted_at IS NULL
        AND q.valid_until IS NOT NULL AND q.valid_until + ($1::int) < CURRENT_DATE
      RETURNING q.quotation_no, q.client_name, q.valid_until`,
    [Number(grace) || 14]
  );
  return { grace_days: Number(grace) || 14, expired: rows };
}

export const JOBS = {
  'quotations.expire': {
    description: 'Mark quotations sent from the tracker as lost (expired) once their validity has passed by the grace period',
    cron: '15 8 * * *',
    run: () => expireQuotations(),
  },
  'renewals.daily': {
    description: 'Turn delivered renewable work into engagements, open renewal quotations inside the lead time, close renewed or lapsed ones',
    cron: '45 8 * * *',
    run: () => runRenewals(),
  },
  'reminders.payment': {
    description: 'Email each client with overdue invoices, once per interval, and note the chase on the stage',
    cron: '0 9 * * 1-5',        // weekday mornings, business time zone
    run: (opts) => runPaymentReminders(opts),
  },
  'accounting.sync': {
    description: 'Read invoices and payments from the books (Zoho Books), compare them with the tracker, apply payments if allowed',
    cron: '30 6 * * *',
    run: () => runAccountingSync(),
  },
  'webhooks.deliver': {
    description: 'Send webhook events to their endpoints and retry failed ones',
    cron: '* * * * *',
    quiet: (r) => r.fanned + r.delivered + r.retrying + r.failed > 0,
    run: () => runWebhooks(),
  },
  'visits.reminders': {
    description: 'Remind the team, and the client where chosen, before a visit',
    cron: '0 17 * * *',
    run: () => runVisitReminders(),
  },
  'mail.sync': {
    description: 'Pull new client email from connected mailboxes and keep push subscriptions alive',
    cron: '*/5 * * * *',
    quiet: (r) => r.results.some((x) => x.stored > 0 || x.error),
    run: () => syncAll(),
  },
  'deliverables.daily': {
    description: 'Mark expired certificates and deliverables; remind owners before expiry with a task',
    cron: '50 7 * * *',
    run: () => runDeliverableReminders(),
  },
  'notifications.daily': {
    description: 'Raise notifications for tasks, follow-ups, approvals, new overdue invoices, renewals and expiring quotations; email the digest',
    cron: '0 8 * * *',
    run: (opts) => runNotifications(opts),
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
    run: async () => {
      const result = await purgeOrphanedDocuments();
      // Nothing removed and everything refused: the run is a failure, or a
      // permanently stuck document is retried nightly and never surfaces.
      if (result.found > 0 && result.purged === 0) {
        throw new Error(`every document refused: ${JSON.stringify(result.failed).slice(0, 500)}`);
      }
      return result;
    },
  },
};

export const isJob = (name) => Object.hasOwn(JOBS, name);

/** Run one job now, recording the run. Never throws; the run row carries the error. */
export async function runJob(name, { startedBy = 'schedule' } = {}) {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown job ${name}`);
  // Frequent jobs are only recorded when they did something or failed.
  if (job.quiet && startedBy === 'schedule') {
    try {
      const result = await job.run({ startedBy });
      if (job.quiet(result)) await query(`INSERT INTO job_runs (name, started_by, status, finished_at, result) VALUES ($1, $2, 'done', now(), $3)`, [name, startedBy, JSON.stringify(result)]);
      return { status: 'done', result };
    } catch (err) {
      await query(`INSERT INTO job_runs (name, started_by, status, finished_at, error) VALUES ($1, $2, 'failed', now(), $3)`, [name, startedBy, String(err.stack || err).slice(0, 2000)]);
      return { status: 'failed', error: err.message };
    }
  }
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
