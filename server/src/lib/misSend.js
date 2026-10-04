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
import { KINDS, attachRelated, dailyBriefing, misSettings, periodFor, weeklyMis } from './misReports.js';
import { REPORT_TITLE, misFileName, misPdf, pdfPageCount } from './misPdf.js';
import { wordReport } from './misAi.js';
import { raiseAlert } from './ops/alerts.js';

/** Replaceable in tests: the mailbox provider, and the clock. */
export const deps = { providerFor, now: () => new Date() };

const TEMPLATE = { daily_briefing: 'mis_daily', weekly_mis: 'mis_weekly' };

/**
 * The figures, the email and the PDF for one report, as the send builds
 * them. `ai: true` has the AI word it (misAi.js) — the send does, a preview
 * does not unless asked, since each is a counted call.
 */
export async function buildReport(kind, { today = businessToday(), db = { query }, settings = null, ai = false } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const s = settings || await misSettings(db);
  const data = kind === 'daily_briefing' ? await dailyBriefing({ today, db, settings: s }) : await weeklyMis({ today, db, settings: s });
  const worded = ai ? await wordReport(data, { db }) : { used: false, why: 'not asked' };
  // Earlier emails on each highlight's thread or record, once the highlights are final (§3).
  if (kind === 'daily_briefing') await attachRelated(db, data.highlights, data.period);
  const email = kind === 'daily_briefing' ? dailyEmail({ data, appUrl: s.appUrl }) : weeklyEmail({ data, appUrl: s.appUrl });
  const { rows: [{ company }] } = await db.query(`SELECT (SELECT value FROM settings WHERE key = 'company_name') AS company`);
  return { kind, data, email, settings: s, company: company?.trim() || 'Cetizion Verifica', fileName: misFileName(data), ai: worded };
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
 * `guarded` applies the schedule's rules — the report must be on, and the
 * period not yet sent — and is the default for the schedule and for the
 * jobs' Run now; Send now and Resend (routes/misReports.js) pass false,
 * because a person pressing the button has decided.
 * Returns the report_runs row, with `skipped` when the guards said no.
 */
export async function runReport(kind, { today = businessToday(), startedBy = 'schedule', guarded = startedBy === 'schedule', db = { query }, ai = true } = {}) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const settings = await misSettings(db);
  const period = periodFor(kind, today);
  if (guarded) {
    const enabled = kind === 'daily_briefing' ? settings.dailyEnabled : settings.weeklyEnabled;
    if (!enabled) return { kind, period, status: 'skipped', skipped: `${kind} is switched off` };
    // A run that only logged (delivery was off) did not reach anybody and does not count as sent.
    const { rows: [sent] } = await db.query(`SELECT id FROM report_runs WHERE kind = $1 AND period_from = $2 AND status = 'sent' AND sent_via <> 'log' LIMIT 1`, [kind, period.from]);
    if (sent) return { kind, period, status: 'skipped', skipped: `already sent for ${period.from} (run ${sent.id})` };
  }

  let built;
  try {
    built = await buildReport(kind, { today, db, settings, ai });
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
      const run = await record(db, { kind, period, status: 'failed', document_id: documentId, error: 'No recipients set (Settings → Scheduled reports)', triggered_by: startedBy, ai_used: built.ai.used });
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
    // report_runs_sent_once holds one scheduled *sent* row per period; a
    // log-only run must not take that slot, or the real send could not be recorded.
    const loggedOnly = !failed && sent.via === 'log';
    const run = await record(db, {
      kind, period, status: failed ? 'failed' : loggedOnly ? 'skipped' : 'sent', sent_via: failed ? null : sent.via, recipients: [...settings.to, ...settings.cc],
      document_id: documentId, email_log_id: sent.row.id, ai_used: built.ai.used, error: failed ? sent.error : loggedOnly ? `Composed and logged only: ${sent.row.reason}` : null, triggered_by: startedBy,
    });
    if (failed) await raiseAlert('mis', `${REPORT_TITLE[kind]} not sent`, sent.error || 'the email failed').catch(() => {});
    else if (sent.via === 'log' && guarded) await raiseAlert('mis', `${REPORT_TITLE[kind]} was composed but not delivered`, sent.row.reason || 'delivery is off', { every: 'day' }).catch(() => {});
    else if (sent.via === 'smtp' && sent.error) await raiseAlert('mis', `${REPORT_TITLE[kind]} went by SMTP, not the sales mailbox`, sent.error, { every: 'day' }).catch(() => {});
    return { ...run, pages: pdfPageCount(pdf), suppressed: sent.via === 'log' ? sent.row.reason : null, ai: built.ai };
  } catch (err) {
    const run = await record(db, { kind, period, status: 'failed', error: err.message, triggered_by: startedBy }).catch(() => ({ kind, period, status: 'failed', error: err.message }));
    await raiseAlert('mis', `${REPORT_TITLE[kind]} failed`, err.message).catch(() => {});
    return run;
  }
}

// The jobs, scheduled or pressed on the Jobs page: either way the guards apply.
export const runDailyBriefing = (opts = {}) => runReport('daily_briefing', { startedBy: opts.startedBy || 'schedule', guarded: true, ...(opts.today ? { today: opts.today } : {}) });
export const runWeeklyMis = (opts = {}) => runReport('weekly_mis', { startedBy: opts.startedBy || 'schedule', guarded: true, ...(opts.today ? { today: opts.today } : {}) });

/** The run history, newest first. */
export async function listRuns(db = { query }, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT r.*, d.file_name, d.size_bytes, l.status AS email_status, l.reason AS email_reason
       FROM report_runs r LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN email_log l ON l.id = r.email_log_id
      ORDER BY r.created_at DESC, r.id DESC LIMIT $1`, [limit]);
  return rows;
}
