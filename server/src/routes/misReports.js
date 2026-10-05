/**
 * The scheduled sales reports (docs/mis-reports-plan.md): the Daily Sales
 * Briefing and the Weekly Sales MIS, read from the tracker's own records.
 *
 * Admin only:
 *   GET  /api/mis-reports/:kind/preview        the figures and the email, as JSON; nothing sent
 *   GET  /api/mis-reports/:kind/preview.pdf    the PDF, as it would be attached
 *   POST /api/mis-reports/:kind/send           { date? } send it now (or again) for the period `date` decides
 *   GET  /api/mis-reports/runs                 the run history
 *   GET  /api/mis-reports/schedule             next runs, the worker's state, warnings
 *   GET  /api/mis-reports/runs/:id/pdf         the PDF a run sent, from document storage
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
import { misPdf, pdfPageCount } from '../lib/misPdf.js';
import { buildReport, listRuns, runReport } from '../lib/misSend.js';
import { scheduleStatus } from '../lib/misSchedule.js';

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
  res.json({ data: await listRuns() });
});

misReportsRouter.get('/schedule', async (req, res) => {
  res.json({ data: await scheduleStatus() });
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

// ?ai=1 has the AI word the preview too; it is a counted call, so not by default.
misReportsRouter.get('/:kind/preview', async (req, res) => {
  const kind = kindOf(req.params.kind);
  const built = await buildReport(kind, { today: dateOf(req.query.date), ai: req.query.ai === '1' });
  res.json({ data: { kind, period: built.data.period, file_name: built.fileName, email: { subject: built.email.subject, text: built.email.text }, report: built.data, ai: built.ai, settings: { to: built.settings.to, cc: built.settings.cc, sender_account_id: built.settings.senderAccountId, enabled: kind === 'daily_briefing' ? built.settings.dailyEnabled : built.settings.weeklyEnabled } } });
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
