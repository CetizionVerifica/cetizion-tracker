/**
 * The scheduled jobs (#21). One registry, used by the worker process
 * (src/worker.js) and by the admin "Run now" button, so a job behaves the
 * same however it was started. Every run is recorded in job_runs.
 */
import { query } from './db.js';
import { purgeOrphanedDocuments } from './lib/documents.js';
import { runFinanceDigest, runPaymentReminders } from './lib/reminders.js';
import { runFollowUps } from './lib/followUps.js';
import { runExchangeRateSync } from './lib/fx.ts';
import { runRenewals } from './lib/renewals.js';
import { runDigests, runNotifications, runWeeklyDigest, sendNotificationEmails } from './lib/notify.js';
import { runDeliverableReminders } from './lib/deliverables.js';
import { syncAll } from './lib/mailbox/sync.js';
import { runBackfills } from './lib/mailbox/autoEnquiry.js';
import { runPoBackfills } from './lib/mailbox/autoPurchaseOrder.js';
import { runInvoiceBackfills } from './lib/mailbox/autoInvoice.js';
import { runReviewDigest } from './lib/mailbox/reviewDigest.js';
import { runVisitReminders } from './lib/visits.js';
import { runDailyBriefing, runWeeklyMis } from './lib/misSend.js';
import { runWebhooks } from './lib/webhooks.js';
import { runAccountingSync } from './routes/accounting.js';
import { runOpsWatch, raiseAlert } from './lib/ops/alerts.js';
import { jobRuns } from './lib/ops/metrics.js';
import './lib/inbox.js'; // routes shared-mailbox mail into the inbox while syncing
import './lib/aiUsage.js'; // each day's AI calls and spend, for the auto-entry panel

/**
 * Quotations sent from the tracker whose validity passed more than the grace
 * period ago move to the Expired stage (#25), which counts as lost. Only sent
 * ones: anything typed in or imported without a send is left for a person to
 * decide. Without an Expired stage (renamed or retired) they are marked Lost.
 */
async function expireQuotations() {
  const { rows: [{ value: grace }] } = await query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'quotation_expiry_grace_days'), '14') AS value`);
  const { rows } = await query(
    `UPDATE quotations q
        SET lost_reason_id = (SELECT id FROM lost_reasons WHERE name = 'Quotation expired'),
            lost_notes = 'Validity date ' || q.valid_until || ' passed',
            stage_id = COALESCE((SELECT id FROM pipeline_stages WHERE name = 'Expired' AND active), q.stage_id),
            status = CASE WHEN EXISTS (SELECT 1 FROM pipeline_stages WHERE name = 'Expired' AND active) THEN q.status ELSE 'Lost' END
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
  'ops.watch': {
    description: 'Check the TLS certificate, disk space, backups and stuck jobs; alert when something is wrong',
    cron: '*/15 * * * *',
    // Every run is recorded, including the quiet ones. This is the
    // watchdog: "it last ran fifteen minutes ago and found nothing" is the
    // answer the deep health check exists to give, and with quiet: () =>
    // false it recorded nothing and reported itself as never run.
    run: () => runOpsWatch(),
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
    // The API also pulls mail every minute on its own (lib/mailbox/autoSync.js);
    // this run is the backstop, and the per-mailbox lock keeps the two apart.
    description: 'Pull new email from connected mailboxes and keep push subscriptions alive',
    cron: '*/5 * * * *',
    quiet: (r) => r.results.some((x) => x.stored > 0 || x.error),
    run: () => syncAll(),
  },
  'enquiries.backfill': {
    description: 'Read back through each connected mailbox\'s past year of mail, once, and create the enquiries it finds',
    cron: '*/10 * * * *',
    quiet: (r) => r.created > 0 || r.errors > 0,
    run: () => runBackfills(),
  },
  'pos.backfill': {
    description: 'Read back through each connected mailbox\'s past year of inbox mail, once, after its enquiries, and register the purchase orders it finds',
    cron: '*/10 * * * *',
    quiet: (r) => r.registered > 0 || r.review > 0 || r.errors > 0,
    run: () => runPoBackfills(),
  },
  'invoices.backfill': {
    description: 'Record the invoices we emailed whose PO has since arrived; read each mailbox\'s past year of sent mail, once, after its POs, for the invoices in it',
    cron: '*/10 * * * *',
    quiet: (r) => r.recorded > 0 || r.review > 0 || r.errors > 0,
    run: () => runInvoiceBackfills(),
  },
  'email.review_digest': {
    description: 'Tell each admin about the POs and invoices read from email that have waited more than two days for review',
    cron: '45 9 * * 1-5',
    quiet: (r) => r.told > 0,
    run: () => runReviewDigest(),
  },
  // The scheduled sales reports (docs/mis-reports-plan.md §3.7). Each
  // period is sent once: a run that finds it already sent does nothing.
  'reports.daily_briefing': {
    description: 'Email management the Daily Sales Briefing for the previous day, from the chosen sender with the PDF attached',
    cron: '56 8 * * *',
    run: (opts) => runDailyBriefing(opts),
  },
  'reports.weekly_mis': {
    description: 'Email management the Weekly Sales MIS for the previous Monday to Sunday, from the chosen sender with the PDF attached',
    cron: '54 8 * * 1',
    run: (opts) => runWeeklyMis(opts),
  },
  'deliverables.daily': {
    description: 'Mark expired certificates and deliverables; remind owners before expiry with a task',
    cron: '50 7 * * *',
    run: () => runDeliverableReminders(),
  },
  'notifications.daily': {
    description: 'Raise notifications for tasks, follow-ups, approvals, new overdue invoices, renewals and expiring quotations',
    cron: '0 8 * * *',
    run: (opts) => runNotifications(opts),
  },
  // #44: working days are Monday to Friday until the holiday calendar (#73) lands.
  'notifications.digest': {
    description: 'Each person their own digest of what is waiting for them, unless they switched it off',
    cron: '30 8 * * 1-5',
    run: (opts) => runDigests(opts),
  },
  'notifications.weekly': {
    description: 'Monday digest for admins: the week in notifications, and what is still open',
    cron: '0 9 * * 1',
    run: (opts) => runWeeklyDigest(opts),
  },
  'notifications.email': {
    description: 'Email the notifications people asked to get by email, outside their quiet hours',
    cron: '*/10 * * * *',
    run: (opts) => sendNotificationEmails(opts),
  },
  'followups.daily': {
    description: 'Email owners about enquiries, quotations and invoices due a follow-up; tell management about the ones nobody acted on',
    // After reminders.payment (09:00) so today's client reminders are already
    // marked automated, and after the 08:00 notification sweep. Holidays are
    // skipped by the run itself.
    cron: '15 9 * * 1-5',
    run: (opts) => runFollowUps(opts),
  },
  'finance.digest': {
    description: 'Morning summary to finance: stages to invoice, overdue invoices, reminders sent',
    // After reminders.payment, not before it: the digest counts the reminders
    // sent this morning, and at 08:30 that count was always zero.
    cron: '30 9 * * 1-5',
    run: (opts) => runFinanceDigest(opts),
  },
  // The ECB publishes its reference rates each working day at about 16:00
  // CET, which is the evening in the business time zone. A failure throws
  // before anything is written, so the run is recorded as failed and
  // yesterday's rates stand: an older record's rate has not changed just
  // because today's file was late.
  'exchange.rates': {
    description: 'Fetch the day\'s ECB reference rates and store one row per currency; hand-entered rates are left alone',
    cron: '0 21 * * 1-5',        // after the ECB has published, business time zone
    run: (opts) => runExchangeRateSync(opts),
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
      jobRuns.inc({ job: name, result: 'done' });
      if (job.quiet(result)) await query(`INSERT INTO job_runs (name, started_by, status, finished_at, result) VALUES ($1, $2, 'done', now(), $3)`, [name, startedBy, JSON.stringify(result)]);
      return { status: 'done', result };
    } catch (err) {
      await query(`INSERT INTO job_runs (name, started_by, status, finished_at, error) VALUES ($1, $2, 'failed', now(), $3)`, [name, startedBy, String(err.stack || err).slice(0, 2000)]);
      jobRuns.inc({ job: name, result: 'failed' });
      await raiseAlert('job', `Job ${name} failed`, err.message).catch(() => {});
      return { status: 'failed', error: err.message };
    }
  }
  const { rows: [run] } = await query('INSERT INTO job_runs (name, started_by) VALUES ($1, $2) RETURNING id', [name, startedBy]);
  try {
    const result = await job.run({ startedBy });
    await query(`UPDATE job_runs SET status = 'done', finished_at = now(), result = $2 WHERE id = $1`, [run.id, JSON.stringify(result)]);
    jobRuns.inc({ job: name, result: 'done' });
    return { id: run.id, status: 'done', result };
  } catch (err) {
    await query(`UPDATE job_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, String(err.stack || err).slice(0, 2000)]);
    jobRuns.inc({ job: name, result: 'failed' });
    if (startedBy === 'schedule') await raiseAlert('job', `Job ${name} failed`, err.message).catch(() => {});
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
