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
 * The email leaves through the connected mailbox in `mis_sender_account_id`
 * — a shared one, or a personal one whose owner allowed it — as the Send As
 * address in `mis_sender_address` when one is set, with the PDF attached,
 * through mail.js's sendViaMailbox and its switches
 * (mis-report-sender-plan.md Part A). When that mailbox cannot send, the
 * report goes by SMTP and admins are told, whichever the reason: a Graph
 * error, or a mailbox that is no longer usable. The run records the From it
 * carried. The PDF is kept as a document (owner `reports`) when document
 * storage is set up, so a run can be re-opened from the tracker.
 */
import { config } from '../config.js';
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { documentStorageReady, uploadDocument } from './documents.js';
import { dailyBriefing as dailyEmail, weeklyMis as weeklyEmail } from './emailTemplates.js';
import { mailConfigured, sendViaMailbox, smtpFrom } from './mail.js';
import pdfmake from './pdf.js';
import { providerFor } from './mailbox/sync.js';
import { KINDS, attachRelated, dailyBriefing, misSettings, periodFor, weeklyMis } from './misReports.js';
import { refreshReceivableList } from './mailbox/receivablesList.js';
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
  // Finance's debtors list, read once when it arrives (docs/mis-briefing-fix-plan.md §3a). It never holds the briefing up.
  const receivablesList = kind === 'daily_briefing'
    ? await refreshReceivableList(db, { ai }).catch((err) => { console.error('[mis] receivables list:', err.message); return { error: err.message }; })
    : null;
  const data = kind === 'daily_briefing' ? await dailyBriefing({ today, db, settings: s }) : await weeklyMis({ today, db, settings: s });
  const worded = ai ? await wordReport(data, { db }) : { used: false, why: 'not asked' };
  // Earlier emails on each highlight's thread or record, once the highlights are final (§3).
  if (kind === 'daily_briefing') await attachRelated(db, data.highlights, data.period);
  const email = kind === 'daily_briefing' ? dailyEmail({ data, appUrl: s.appUrl }) : weeklyEmail({ data, appUrl: s.appUrl });
  const { rows: [{ company }] } = await db.query(`SELECT (SELECT value FROM settings WHERE key = 'company_name') AS company`);
  return { kind, data, email, settings: s, company: company?.trim() || 'Cetizion Verifica', fileName: misFileName(data), ai: worded, receivables_list: receivablesList };
}

async function record(db, run) {
  const { rows: [r] } = await db.query(
    `INSERT INTO report_runs (kind, period_from, period_to, status, sent_via, recipients, document_id, email_log_id, ai_used, error, triggered_by, sent_from, sent_through)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [run.kind, run.period.from, run.period.to, run.status, run.sent_via || null, run.recipients || null, run.document_id || null, run.email_log_id || null,
      Boolean(run.ai_used), run.error ? String(run.error).slice(0, 1000) : null, run.triggered_by || 'schedule', run.sent_from || null, run.sent_through || null]);
  return r;
}

/** Why a mailbox cannot send the reports, or null when it can. */
export function mailboxProblem(account) {
  if (!account) return 'is no longer connected';
  if (account.status === 'needs_reconnect') return 'needs reconnecting (Mailboxes)';
  if (account.status !== 'active') return 'is disconnected';
  if (!account.is_shared && !account.may_send_reports) return "is a personal mailbox whose owner has not allowed reports to be sent from it";
  return null;
}

/**
 * Who the reports go from (mis-report-sender-plan.md §A4):
 *   mailbox   the account to send through, when it is usable; else null (SMTP)
 *   chosen    the account that was chosen, usable or not
 *   sendAs    { address, name } for the From, or null for the mailbox's own
 *   problem   why the chosen mailbox cannot send, in words; null when it can
 *             or when SMTP was chosen
 */
export async function resolveSender(db, settings) {
  const sendAs = settings.senderAddress || settings.senderName ? { address: settings.senderAddress || null, name: settings.senderName || null } : null;
  if (!settings.senderAccountId) return { mailbox: null, chosen: null, sendAs, problem: null };
  const { rows: [a] } = await db.query('SELECT * FROM connected_accounts WHERE id = $1', [settings.senderAccountId]);
  const problem = mailboxProblem(a);
  return { mailbox: problem ? null : a, chosen: a || null, sendAs, problem: problem ? `${a?.email || `Mailbox ${settings.senderAccountId}`} ${problem}` : null };
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

    const sender = await resolveSender(db, settings);
    const { mailbox } = sender;
    const sent = await sendViaMailbox({
      send: mailbox ? (msg) => deps.providerFor(mailbox).send(msg) : null,
      from: mailbox?.email || null, sendAs: sender.sendAs,
      to: settings.to, cc: settings.cc, subject: built.email.subject, text: built.email.text, html: built.email.html,
      template: TEMPLATE[kind], entity: 'report', entityId: `${kind}:${period.from}`, sentBy: startedBy, attachments,
    }, db);

    const failed = sent.row.status === 'failed';
    // report_runs_sent_once holds one scheduled *sent* row per period; a
    // log-only run must not take that slot, or the real send could not be recorded.
    const loggedOnly = !failed && sent.via === 'log';
    // Why it did not go through the chosen mailbox: the mailbox itself, or Graph's error.
    const fellBack = sent.via === 'smtp' && (sender.problem || sent.error) ? [sender.problem, sent.error].filter(Boolean).join('; ') : null;
    const run = await record(db, {
      kind, period, status: failed ? 'failed' : loggedOnly ? 'skipped' : 'sent', sent_via: failed ? null : sent.via, recipients: [...settings.to, ...settings.cc],
      document_id: documentId, email_log_id: sent.row.id, ai_used: built.ai.used, triggered_by: startedBy,
      error: failed ? [sender.problem, sent.error].filter(Boolean).join('; ')
        : loggedOnly ? [`Composed and logged only: ${sent.row.reason}`, sender.problem].filter(Boolean).join('; ')
          : fellBack ? `Went by SMTP: ${fellBack}` : null,
      sent_from: failed ? null : sent.from, sent_through: sent.via === 'graph' ? mailbox.id : null,
    });
    const through = sender.chosen?.email || 'the chosen mailbox';
    if (failed) await raiseAlert('mis', `${REPORT_TITLE[kind]} not sent`, [sender.problem, sent.error].filter(Boolean).join('; ') || 'the email failed').catch(() => {});
    else if (sent.via === 'log' && guarded) await raiseAlert('mis', `${REPORT_TITLE[kind]} was composed but not delivered`, sent.row.reason || 'delivery is off', { every: 'day' }).catch(() => {});
    // Never silent (§A1.3): a mailbox that is no longer usable is told the same as one Graph refused.
    if (!failed && fellBack) await raiseAlert('mis', `${REPORT_TITLE[kind]} went by SMTP, not ${through}`, fellBack, { every: 'day' }).catch(() => {});
    else if (!failed && sender.problem) await raiseAlert('mis', `${REPORT_TITLE[kind]}: ${through} cannot send`, sender.problem, { every: 'day' }).catch(() => {});
    return { ...run, pages: pdfPageCount(pdf), suppressed: sent.via === 'log' ? sent.row.reason : null, ai: built.ai };
  } catch (err) {
    const run = await record(db, { kind, period, status: 'failed', error: err.message, triggered_by: startedBy }).catch(() => ({ kind, period, status: 'failed', error: err.message }));
    await raiseAlert('mis', `${REPORT_TITLE[kind]} failed`, err.message).catch(() => {});
    return run;
  }
}

/**
 * What the reports will go from, for the settings card
 * (mis-report-sender-plan.md §A2): the mailbox chosen and its state, the
 * From the email will carry, and, when the mailbox cannot send, why and
 * what happens instead.
 */
export async function describeSender(db = { query }) {
  const settings = await misSettings(db);
  const sender = await resolveSender(db, settings);
  const smtp = smtpFrom(sender.sendAs);
  const through = sender.chosen
    ? { id: sender.chosen.id, email: sender.chosen.email, is_shared: sender.chosen.is_shared, status: sender.chosen.status, may_send_reports: sender.chosen.may_send_reports }
    : settings.senderAccountId ? { id: settings.senderAccountId, email: null, status: 'missing' } : null;
  const viaMailbox = Boolean(sender.mailbox);
  const from = viaMailbox ? (sender.sendAs?.address || sender.mailbox.email) : (mailConfigured() ? smtp.address : null);
  return {
    // Through a mailbox, Exchange keeps its own display name unless another address is sent as.
    through, via: viaMailbox ? 'mailbox' : 'smtp', from,
    name: viaMailbox && (!sender.sendAs?.address || sender.sendAs.address.toLowerCase() === sender.mailbox.email.toLowerCase()) ? null : sender.sendAs?.name || null,
    send_as: sender.sendAs?.address || null, problem: sender.problem,
    // A Send As address the SMTP relay may not use: a fallback goes from EMAIL_FROM.
    smtp_from: mailConfigured() ? smtp.address : null, smtp_configured: mailConfigured(),
  };
}

/** A one-page PDF for the sender test, so the attachment path is tried too. */
const testPdf = () => pdfmake.createPdf({ content: [{ text: 'Scheduled reports: sender test', fontSize: 14, bold: true }, { text: 'If you can open this, attachments get through.', margin: [0, 8, 0, 0] }] }).getBuffer();

/**
 * Send a short test email, with a small PDF, to `to` (the admin asking)
 * by exactly the path the reports take (§A2 "Send a test to me"). Only to
 * the caller; nothing is recorded in report_runs.
 */
export async function sendSenderTest({ to, startedBy = 'admin', db = { query } }) {
  const settings = await misSettings(db);
  const sender = await resolveSender(db, settings);
  const { mailbox } = sender;
  const lines = [
    'This is a test of the sender of the scheduled reports.',
    mailbox ? `It was sent through ${mailbox.email}${sender.sendAs?.address ? ` as ${sender.sendAs.address}` : ''}.` : 'It was sent by the server\'s SMTP sender.',
    sender.problem ? `The chosen mailbox cannot send: ${sender.problem}.` : null,
  ].filter(Boolean);
  const sent = await sendViaMailbox({
    send: mailbox ? (msg) => deps.providerFor(mailbox).send(msg) : null,
    from: mailbox?.email || null, sendAs: sender.sendAs,
    to: [to], subject: 'Scheduled reports: sender test', text: lines.join('\n\n'), html: lines.map((l) => `<p>${l.replace(/</g, '&lt;')}</p>`).join(''),
    template: 'mis_sender_test', entity: 'report', entityId: 'sender_test', sentBy: startedBy,
    attachments: [{ name: 'Sender_test.pdf', contentType: 'application/pdf', content: await testPdf() }],
  }, db);
  return {
    status: sent.row.status, via: sent.via, from: sent.from || null, to,
    problem: sender.problem, error: sent.error || sent.row.error || null, suppressed: sent.via === 'log' ? sent.row.reason : null,
  };
}

// The jobs, scheduled or pressed on the Jobs page: either way the guards apply.
export const runDailyBriefing = (opts = {}) => runReport('daily_briefing', { startedBy: opts.startedBy || 'schedule', guarded: true, ...(opts.today ? { today: opts.today } : {}) });
export const runWeeklyMis = (opts = {}) => runReport('weekly_mis', { startedBy: opts.startedBy || 'schedule', guarded: true, ...(opts.today ? { today: opts.today } : {}) });

/** The run history, newest first. */
export async function listRuns(db = { query }, { limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT r.*, d.file_name, d.size_bytes, l.status AS email_status, l.reason AS email_reason, a.email AS sent_through_email
       FROM report_runs r LEFT JOIN documents d ON d.id = r.document_id LEFT JOIN email_log l ON l.id = r.email_log_id
       LEFT JOIN connected_accounts a ON a.id = r.sent_through
      ORDER BY r.created_at DESC, r.id DESC LIMIT $1`, [limit]);
  return rows;
}
