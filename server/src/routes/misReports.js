/**
 * The scheduled sales reports (docs/mis-reports-plan.md): the Daily Sales
 * Briefing and the Weekly Sales MIS, read from the tracker's own records.
 *
 * Admin only:
 *   GET  /api/mis-reports/:kind/preview        the figures and the email, as JSON; nothing sent
 *   GET  /api/mis-reports/:kind/preview.pdf    the PDF, as it would be attached
 *   POST /api/mis-reports/:kind/send           { date? } send it now (or again) for the period `date` decides
 *   GET  /api/mis-reports/runs                 the run history
 *   GET  /api/mis-reports/runs/:id/pdf         the PDF a run sent, from document storage
 *   GET  /api/mis-reports/sender               who the reports will go from, and any problem
 *   POST /api/mis-reports/sender/test          a short test, to the caller only, by the reports' path
 *   GET  /api/mis-reports/personal/people      who a personal daily MIS is for, and each one's state
 *   GET  /api/mis-reports/personal/:userId/preview      their facts, and with ?ai=1 the AI's report; nothing sent
 *   GET  /api/mis-reports/personal/:userId/preview.pdf  the PDF the AI's report would be; one counted AI call
 *   POST /api/mis-reports/personal/:userId/send          { date? } send their report now
 *
 * Any sales or admin user, their own only (myMisRouter):
 *   GET  /api/mis-reports/mine                 their personal reports, and whether to show the notice
 *   GET  /api/mis-reports/mine/:id/pdf         one of their reports as it was sent
 *   POST /api/mis-reports/mine/notice          they have read the notice
 *
 * `kind` is daily_briefing or weekly_mis. `date` (YYYY-MM-DD) runs the
 * report as if that were today — yesterday's briefing, the previous week's
 * MIS — so a past period can be looked at or sent again.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { businessToday } from '../lib/businessDate.ts';
import { fetchDocument } from '../lib/documents.js';
import { KINDS } from '../lib/misReports.js';
import { misFileName, misPdf, pdfPageCount } from '../lib/misPdf.js';
import { buildReport, describeSender, listRuns, personalData, runPersonal, runReport, sendSenderTest } from '../lib/misSend.js';
import { writePersonal } from '../lib/misAi.js';
import { personalFacts, personalPeople, redactFacts } from '../lib/misPersonal.js';
import { misSettings } from '../lib/misReports.js';

/**
 * What every person whose report is sent is told (§B2), once, in the
 * tracker; the same words sit on the Mailboxes page.
 */
export const PERSONAL_NOTICE = 'Each morning a summary of your previous day\'s work email and your actions in the tracker is sent to management from your mailbox, copied to you.';

export const myMisRouter = Router();

/** Whether `userId`'s report is sent, so the notice applies to them. */
async function noticeFor(userId) {
  const { rows: [r] } = await query(
    `SELECT u.daily_mis_notice_seen_at AS seen_at,
            (SELECT value FROM settings WHERE key = 'personal_mis_enabled') = 'true' AND u.daily_mis AND u.active AND u.role IN ('sales', 'admin') AS enabled,
            EXISTS (SELECT 1 FROM connected_accounts a WHERE a.user_id = u.id AND NOT a.is_shared AND a.status <> 'disconnected') AS has_mailbox
       FROM users u WHERE u.id = $1`, [userId]);
  // enabled: their report would go once a mailbox is connected (said on the Mailboxes page);
  // applies: it goes now, so they are told once wherever they are.
  const applies = Boolean(r?.enabled && r.has_mailbox);
  return { text: PERSONAL_NOTICE, enabled: Boolean(r?.enabled), applies, show: Boolean(applies && !r.seen_at), seen_at: r?.seen_at ?? null };
}

const myId = (req) => (Number.isSafeInteger(req.user?.id) ? req.user.id : null);

myMisRouter.get('/', async (req, res) => {
  const id = myId(req);
  if (!id) return res.json({ data: { notice: { text: PERSONAL_NOTICE, enabled: false, applies: false, show: false }, runs: [] } });
  const { rows } = await query(
    `SELECT r.id, r.period_from, r.status, r.sent_via, r.sent_from, r.created_at, r.document_id IS NOT NULL AS has_pdf, r.error
       FROM report_runs r WHERE r.kind = 'personal_daily' AND r.user_id = $1 AND r.status = 'sent'
      ORDER BY r.period_from DESC, r.created_at DESC LIMIT 60`, [id]);
  res.json({ data: { notice: await noticeFor(id), runs: rows } });
});

myMisRouter.post('/notice', async (req, res) => {
  const id = myId(req);
  if (!id) throw new ApiError(422, 'Sign in with your own account');
  await query('UPDATE users SET daily_mis_notice_seen_at = COALESCE(daily_mis_notice_seen_at, now()) WHERE id = $1', [id]);
  res.json({ data: await noticeFor(id) });
});

myMisRouter.get('/:id/pdf', async (req, res) => {
  const id = Number(req.params.id);
  const me = myId(req);
  if (!me || !Number.isSafeInteger(id) || id < 1) throw new ApiError(404, 'No such report');
  const { rows: [run] } = await query(`SELECT id, document_id FROM report_runs WHERE id = $1 AND kind = 'personal_daily' AND user_id = $2`, [id, me]);
  // Someone else's report is "not found", the same as one that never was.
  if (!run) throw new ApiError(404, 'No such report');
  if (!run.document_id) throw new ApiError(404, 'This report kept no PDF (document storage was not set up when it ran)');
  const { document, body } = await fetchDocument(run.document_id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${document.file_name}"`);
  res.send(body);
});

export const misReportsRouter = Router();
misReportsRouter.use(requireAdmin);

const kindOf = (raw) => {
  if (!KINDS.includes(raw)) throw new ApiError(404, 'No such report');
  return raw;
};

const dateOf = (raw) => {
  if (raw === undefined || raw === null || raw === '') return businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new ApiError(422, 'date must be YYYY-MM-DD');
  return String(raw);
};

misReportsRouter.get('/runs', async (req, res) => {
  const kind = req.query.kind ? String(req.query.kind) : null;
  if (kind && ![...KINDS, 'personal_daily'].includes(kind)) throw new ApiError(422, 'No such report');
  const userId = req.query.user_id ? Number(req.query.user_id) : null;
  if (userId !== null && (!Number.isSafeInteger(userId) || userId < 1)) throw new ApiError(422, 'user_id must be a user');
  res.json({ data: await listRuns(undefined, { kind, userId }) });
});

misReportsRouter.get('/runs/:id/pdf', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(404, 'No such run');
  const { rows: [run] } = await query('SELECT id, document_id FROM report_runs WHERE id = $1', [id]);
  if (!run) throw new ApiError(404, 'No such run');
  if (!run.document_id) throw new ApiError(404, 'This run kept no PDF (document storage was not set up when it ran)');
  const { document, body } = await fetchDocument(run.document_id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${document.file_name}"`);
  res.send(body);
});

misReportsRouter.get('/sender', async (req, res) => {
  res.json({ data: await describeSender() });
});

// One test a minute per caller: it sends real mail.
const lastTest = new Map();

/**
 * The sender test (mis-report-sender-plan.md §A2). It goes to the signed-in
 * admin's own address and nowhere else, so it cannot be used to mail anyone
 * as the company.
 */
misReportsRouter.post('/sender/test', async (req, res) => {
  const to = String(req.user?.email || '').trim();
  if (!to.includes('@')) throw new ApiError(422, 'Your account has no email address to send the test to. Sign in with your own account.');
  const key = req.user?.id ?? to;
  const at = lastTest.get(key);
  if (at && Date.now() - at < 60_000) throw new ApiError(429, 'A test was sent less than a minute ago. Try again shortly.');
  lastTest.set(key, Date.now());
  res.json({ data: await sendSenderTest({ to, startedBy: req.user?.username || 'admin' }) });
});

// ---------------------------------------------------------------------
// The personal daily MIS (mis-report-sender-plan.md Part B)
// ---------------------------------------------------------------------

misReportsRouter.get('/personal/people', async (req, res) => {
  res.json({ data: await personalPeople() });
});

/**
 * One person's facts for a day, and with ?ai=1 the report the AI writes
 * from them and what the checks dropped (§B4.3). Nothing is sent. The
 * person's mail text is not shown to anyone else (redactFacts), though the
 * AI reads it to write their report.
 */
misReportsRouter.get('/personal/:userId/preview', async (req, res) => {
  const userId = personOf(req.params.userId);
  const facts = await personalFacts({ userId, today: dateOf(req.query.date) });
  if (!facts) throw new ApiError(404, 'No such person');
  const ai = req.query.ai === '1' ? await writePersonal(facts) : null;
  res.json({ data: { facts: redactFacts(facts, req.user?.id ?? null), ai } });
});

const personOf = (raw) => {
  const userId = Number(raw);
  if (!Number.isSafeInteger(userId) || userId < 1) throw new ApiError(404, 'No such person');
  return userId;
};

/**
 * The PDF the person's report would be, written now by the AI. It is one
 * counted call, and a report that fails the checks has no PDF: the reason
 * comes back instead.
 */
misReportsRouter.get('/personal/:userId/preview.pdf', async (req, res) => {
  const facts = await personalFacts({ userId: personOf(req.params.userId), today: dateOf(req.query.date) });
  if (!facts) throw new ApiError(404, 'No such person');
  const ai = await writePersonal(facts);
  if (!ai.ok) throw new ApiError(422, `This report would not be sent: ${ai.why}`);
  const data = personalData(facts, ai.report, await misSettings());
  const { rows: [{ company }] } = await query(`SELECT (SELECT value FROM settings WHERE key = 'company_name') AS company`);
  const pdf = await misPdf(data, { company: company?.trim() || 'Cetizion Verifica', generatedAt: new Date(), timeZone: config.businessTimeZone });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Page-Count', String(pdfPageCount(pdf)));
  res.setHeader('Content-Disposition', `inline; filename="${misFileName(data)}"`);
  res.send(pdf);
});

/**
 * Send one person's report now, for the day before `date` (today when
 * absent). Always sends, whatever the schedule's rules: the admin pressing
 * it has decided. A report the AI cannot write is still not sent.
 */
misReportsRouter.post('/personal/:userId/send', async (req, res) => {
  const userId = personOf(req.params.userId);
  const parsed = z.object({ date: z.string().optional() }).safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields');
  const run = await runPersonal(userId, { today: dateOf(parsed.data.date), startedBy: req.user?.username || 'admin', guarded: false });
  if (run.status === 'skipped' && run.skipped) throw new ApiError(404, 'No such person');
  res.status(run.status === 'failed' ? 502 : 200).json({ data: run });
});

// ?ai=1 has the AI word the preview too; it is a counted call, so not by default.
misReportsRouter.get('/:kind/preview', async (req, res) => {
  const kind = kindOf(req.params.kind);
  const built = await buildReport(kind, { today: dateOf(req.query.date), ai: req.query.ai === '1' });
  res.json({ data: { kind, period: built.data.period, file_name: built.fileName, email: { subject: built.email.subject, text: built.email.text }, report: built.data, ai: built.ai, settings: { to: built.settings.to, cc: built.settings.cc, sender_account_id: built.settings.senderAccountId, sender_address: built.settings.senderAddress, sender_name: built.settings.senderName, enabled: kind === 'daily_briefing' ? built.settings.dailyEnabled : built.settings.weeklyEnabled } } });
});

misReportsRouter.get('/:kind/preview.pdf', async (req, res) => {
  const kind = kindOf(req.params.kind);
  const built = await buildReport(kind, { today: dateOf(req.query.date), ai: req.query.ai === '1' });
  const pdf = await misPdf(built.data, { company: built.company, generatedAt: new Date(), timeZone: config.businessTimeZone });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Page-Count', String(pdfPageCount(pdf)));
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${built.fileName}"`);
  res.send(pdf);
});

/**
 * Send now, or send again. Always sends: the once-per-period rule is the
 * schedule's, and a person pressing the button has decided.
 */
misReportsRouter.post('/:kind/send', async (req, res) => {
  const kind = kindOf(req.params.kind);
  const parsed = z.object({ date: z.string().optional() }).safeParse(req.body || {});
  if (!parsed.success) throw new ApiError(422, 'Please check the highlighted fields');
  const run = await runReport(kind, { today: dateOf(parsed.data.date), startedBy: req.user?.username || 'admin', guarded: false });
  res.status(run.status === 'failed' ? 502 : 200).json({ data: run });
});
