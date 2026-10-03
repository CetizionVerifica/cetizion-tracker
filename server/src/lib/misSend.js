/**
 * Building and sending the scheduled sales reports
 * (docs/mis-reports-plan.md §3.6, §3.7).
 *
 *   buildReport(kind, { today })             the figures, the email and the PDF
 *   runReport(kind, { today, startedBy })    build, send, record in report_runs
 *   runDailyBriefing() / runWeeklyMis()      the two jobs (jobs.js)
 *
 * A scheduled run is idempotent per period: when a sent run already exists
 * for that kind and period, it does nothing. Send now and Resend are
 * explicit and always send. Every run is recorded, sent or not, and a
 * failure is raised to admins through the ops alerts.
 *
 * The email leaves from the connected mailbox in `mis_sender_account_id`
 * (sales@), with the PDF attached, through mail.js's sendViaMailbox and its
 * switches; it falls back to SMTP when the mailbox cannot send. The PDF is
 * kept as a document (owner `reports`) when document storage is set up, so
 * a run can be re-opened from the tracker.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { documentStorageReady, uploadDocument } from './documents.js';
import { dailyBriefing as dailyEmail, weeklyMis as weeklyEmail } from './emailTemplates.js';
import { sendViaMailbox } from './mail.js';
import { providerFor } from './mailbox/sync.js';
import { KINDS, dailyBriefing, misSettings, periodFor, weeklyMis } from './misReports.js';
import { REPORT_TITLE, misFileName, misPdf, pdfPageCount } from './misPdf.js';
import { raiseAlert } from './ops/alerts.js';

/** Replaceable in tests: the mailbox provider, and the clock. */
export const deps = { providerFor, now: () => new Date() };

const TEMPLATE = { daily_briefing: 'mis_daily', weekly_mis: 'mis_weekly' };

/** The figures, the email and the PDF for one report, as the send builds them. */
export async function buildReport(kind, { today = businessToday(), db = { query }, settings = null, commentary = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const s = settings || await misSettings(db);
  const data = kind === 'daily_briefing' ? await dailyBriefing({ today, db, settings: s }) : await weeklyMis({ today, db, settings: s });
  if (commentary) data.commentary = commentary;
  const email = kind === 'daily_briefing' ? dailyEmail({ data, appUrl: s.appUrl }) : weeklyEmail({ data, appUrl: s.appUrl });
  const { rows: [{ company }] } = await db.query(`SELECT (SELECT value FROM settings WHERE key = 'company_name') AS company`);
  return { kind, data, email, settings: s, company: company?.trim() || 'Cetizion Verifica', fileName: misFileName(data) };
}

async function record(db, run) {
  const { rows: [r] } = await db.query(
    `INSERT INTO report_runs (kind, period_from, period_to, status, sent_via, recipients, document_id, email_log_id, ai_used, error, triggered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [run.kind, run.period.from, run.period.to, run.status, run.sent_via || null, run.recipients || null, run.document_id || null, run.email_log_id || null,
      Boolean(run.ai_used), run.error ? String(run.error).slice(0, 1000) : null, run.triggered_by || 'schedule']);
  return r;
}

/** The sender mailbox, if one is set and can send; else null (SMTP). */
async function senderMailbox(db, settings) {
  if (!settings.senderAccountId) return null;
  const { rows: [a] } = await db.query(`SELECT * FROM connected_accounts WHERE id = $1 AND status = 'active'`, [settings.senderAccountId]);
  return a || null;
}

/**
 * Build and send one report. `startedBy` is 'schedule' or a username.
 * Returns the report_runs row, with `skipped` when the schedule had nothing
 * to do (the report is off, or that period was already sent).
 */
export async function runReport(kind, { today = businessToday(), startedBy = 'schedule', db = { query }, commentary = null } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const settings = await misSettings(db);
  const period = periodFor(kind, today);
  const scheduled = startedBy === 'schedule';
  if (scheduled) {
    const enabled = kind === 'daily_briefing' ? settings.dailyEnabled : settings.weeklyEnabled;
    if (!enabled) return { kind, period, status: 'skipped', skipped: `${kind} is switched off` };
    const { rows: [sent] } = await db.query(`SELECT id FROM report_runs WHERE kind = $1 AND period_from = $2 AND status = 'sent' LIMIT 1`, [kind, period.from]);
    if (sent) return { kind, period, status: 'skipped', skipped: `already sent for ${period.from} (run ${sent.id})` };
  }

  let built;
  try {
    built = await buildReport(kind, { today, db, settings, commentary });
    const pdf = await misPdf(built.data, { company: built.company, generatedAt: deps.now(), timeZone: config.businessTimeZone });
    const attachments = [{ name: built.fileName, contentType: 'application/pdf', content: pdf }];

    let documentId = null;
    if (documentStorageReady) {
      try {
        documentId = (await uploadDocument({ buffer: pdf, fileName: built.fileName, contentType: 'application/pdf', owner: 'reports' })).id;
      } catch (err) {
        // The report still goes; the copy in the tracker is the part that failed.
        console.error('[mis] the PDF could not be stored:', err.message);
      }
    }

    if (!settings.to.length) {
      const run = await record(db, { kind, period, status: 'failed', document_id: documentId, error: 'No recipients set (Settings → Scheduled reports)', triggered_by: startedBy, ai_used: Boolean(commentary) });
      await raiseAlert('mis', `${REPORT_TITLE[kind]} not sent`, 'No recipients are set under Reports → Scheduled reports.').catch(() => {});
      return run;
    }

    const mailbox = await senderMailbox(db, settings);
    const sent = await sendViaMailbox({
      send: mailbox ? (msg) => deps.providerFor(mailbox).send(msg) : null,
      from: mailbox?.email || null,
      to: settings.to, cc: settings.cc, subject: built.email.subject, text: built.email.text, html: built.email.html,
      template: TEMPLATE[kind], entity: 'report', entityId: `${kind}:${period.from}`, sentBy: startedBy, attachments,
    }, db);

    const failed = sent.row.status === 'failed';
    const run = await record(db, {
      kind, period, status: failed ? 'failed' : 'sent', sent_via: failed ? null : sent.via, recipients: [...settings.to, ...settings.cc],
      document_id: documentId, email_log_id: sent.row.id, ai_used: Boolean(commentary), error: failed ? sent.error : null, triggered_by: startedBy,
    });
    if (failed) await raiseAlert('mis', `${REPORT_TITLE[kind]} not sent`, sent.error || 'the email failed').catch(() => {});
    else if (sent.via === 'smtp' && sent.error) await raiseAlert('mis', `${REPORT_TITLE[kind]} went by SMTP, not the sales mailbox`, sent.error, { every: 'day' }).catch(() => {});
    return { ...run, pages: pdfPageCount(pdf), suppressed: sent.via === 'log' ? sent.row.reason : null };
  } catch (err) {
    const run = await record(db, { kind, period, status: 'failed', error: err.message, triggered_by: startedBy }).catch(() => ({ kind, period, status: 'failed', error: err.message }));
    await raiseAlert('mis', `${REPORT_TITLE[kind]} failed`, err.message).catch(() => {});
    return run;
  }
}

export const runDailyBriefing = (opts = {}) => runReport('daily_briefing', { startedBy: opts.startedBy || 'schedule' });
export const runWeeklyMis = (opts = {}) => runReport('weekly_mis', { startedBy: opts.startedBy || 'schedule' });

/** The run history, newest first. */
export async function listRuns(db = { query }, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT r.*, d.file_name, d.size_bytes, l.status AS email_status, l.reason AS email_reason
       FROM report_runs r LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN email_log l ON l.id = r.email_log_id
      ORDER BY r.created_at DESC, r.id DESC LIMIT $1`, [limit]);
  return rows;
}
