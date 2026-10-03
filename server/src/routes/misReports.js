/**
 * The scheduled sales reports (docs/mis-reports-plan.md): the Daily Sales
 * Briefing and the Weekly Sales MIS, read from the tracker's own records.
 *
 * Admin only:
 *   GET /api/mis-reports/:kind/preview          the figures and the email, as JSON; nothing sent
 *   GET /api/mis-reports/:kind/preview.pdf      the PDF, as it would be attached
 *
 * `kind` is daily_briefing or weekly_mis. `?date=YYYY-MM-DD` runs the report
 * as if that were today (yesterday's briefing, the previous week's MIS), so
 * a past period can be looked at again.
 */
import { Router } from 'express';
import { requireAdmin } from '../auth/middleware.js';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../middleware/error.js';
import { businessToday } from '../lib/businessDate.ts';
import { dailyBriefing as dailyEmail, weeklyMis as weeklyEmail } from '../lib/emailTemplates.js';
import { KINDS, dailyBriefing, misSettings, weeklyMis } from '../lib/misReports.js';
import { misFileName, misPdf, pdfPageCount } from '../lib/misPdf.js';

export const misReportsRouter = Router();
misReportsRouter.use(requireAdmin);

const kindOf = (raw) => {
  if (!KINDS.includes(raw)) throw new ApiError(404, 'No such report');
  return raw;
};

const dateOf = (raw) => {
  if (raw === undefined || raw === '') return businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new ApiError(422, 'date must be YYYY-MM-DD');
  return String(raw);
};

/** The figures and the email for one report, as the send would build them. */
export async function buildReport(kind, { today = businessToday(), db = { query } } = {}) {
  const settings = await misSettings(db);
  const data = kind === 'daily_briefing' ? await dailyBriefing({ today, db, settings }) : await weeklyMis({ today, db, settings });
  const email = kind === 'daily_briefing' ? dailyEmail({ data, appUrl: settings.appUrl }) : weeklyEmail({ data, appUrl: settings.appUrl });
  const { rows: [{ company }] } = await db.query(`SELECT (SELECT value FROM settings WHERE key = 'company_name') AS company`);
  return { data, email, settings, company: company?.trim() || 'Cetizion Verifica', fileName: misFileName(data) };
}

misReportsRouter.get('/:kind/preview', async (req, res) => {
  const kind = kindOf(req.params.kind);
  const built = await buildReport(kind, { today: dateOf(req.query.date) });
  res.json({ data: { kind, period: built.data.period, file_name: built.fileName, email: { subject: built.email.subject, text: built.email.text }, report: built.data, settings: { to: built.settings.to, cc: built.settings.cc, enabled: kind === 'daily_briefing' ? built.settings.dailyEnabled : built.settings.weeklyEnabled } } });
});

misReportsRouter.get('/:kind/preview.pdf', async (req, res) => {
  const kind = kindOf(req.params.kind);
  const built = await buildReport(kind, { today: dateOf(req.query.date) });
  const pdf = await misPdf(built.data, { company: built.company, generatedAt: new Date(), timeZone: config.businessTimeZone });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Page-Count', String(pdfPageCount(pdf)));
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${built.fileName}"`);
  res.send(pdf);
});
