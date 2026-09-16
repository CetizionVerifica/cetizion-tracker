/**
 * Payment reminders and the finance digest (#21).
 *
 * The rules are pure functions over rows (tested without a database); the
 * runners read the rows, apply them and send through lib/mail.js.
 */
import { query } from '../db.js';
import { businessToday } from './businessDate.js';
import { financeDigest, paymentReminder } from './emailTemplates.js';
import { sendMail } from './mail.js';

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Which overdue stages get a reminder today, grouped per client.
 *
 * stages: rows of v_payment_stages joined with the billing contact:
 *   { ..., company_id, company_name, contact_name, contact_email, opt_out }
 * Rules: an invoice must exist; the stage must be past due by at least
 * graceDays; a stage chased within intervalDays waits; a client with no
 * billing email, or an opted-out contact, is reported but not emailed.
 */
export function planReminders(stages, { today, intervalDays = 7, graceDays = 3 } = {}) {
  const groups = new Map();
  const skipped = [];
  for (const s of stages) {
    if (s.stage_status !== 'Overdue' || !s.invoice_no) continue;
    if (Number(s.days_overdue || 0) < graceDays) { skipped.push({ id: s.id, reason: `within the ${graceDays}-day grace period` }); continue; }
    if (s.reminder_sent_on && daysBetween(s.reminder_sent_on, today) < intervalDays) { skipped.push({ id: s.id, reason: `reminded ${daysBetween(s.reminder_sent_on, today)} days ago` }); continue; }
    if (!s.contact_email) { skipped.push({ id: s.id, reason: `${s.client_name}: no billing contact with an email` }); continue; }
    if (s.opt_out) { skipped.push({ id: s.id, reason: `${s.contact_email} opted out of automatic email` }); continue; }
    const key = s.company_id ?? s.client_name;
    if (!groups.has(key)) groups.set(key, { company: s.company_name || s.client_name, companyId: s.company_id, to: s.contact_email, contactName: s.contact_name, stages: [] });
    groups.get(key).stages.push(s);
  }
  return { reminders: [...groups.values()], skipped };
}

const STAGE_ROWS = `
  SELECT ps.*, pr.company_id, c.name AS company_name, ct.name AS contact_name, ct.email AS contact_email, ct.opt_out_reminders AS opt_out
    FROM v_payment_stages ps
    JOIN projects pr ON pr.project_id = ps.project_id
    LEFT JOIN companies c ON c.id = pr.company_id
    LEFT JOIN LATERAL (
      SELECT name, email, opt_out_reminders FROM contacts
       WHERE company_id = pr.company_id AND email IS NOT NULL
       ORDER BY is_billing DESC, id LIMIT 1
    ) ct ON true`;

async function settingNumber(db, key, fallback) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Send today's payment reminders. Returns what was sent and what was skipped, for the job log. */
export async function runPaymentReminders({ db = { query }, today = businessToday(), startedBy = 'schedule' } = {}) {
  const [intervalDays, graceDays] = await Promise.all([settingNumber(db, 'reminder_interval_days', 7), settingNumber(db, 'reminder_grace_days', 3)]);
  const { rows } = await db.query(`${STAGE_ROWS} WHERE ps.stage_status = 'Overdue'`);
  const { rows: fin } = await db.query(`SELECT value FROM settings WHERE key = 'finance_email'`);
  const financeEmail = fin[0]?.value || null;
  const plan = planReminders(rows, { today, intervalDays, graceDays });
  const sent = [];
  for (const r of plan.reminders) {
    const email = paymentReminder({ company: r.company, contactName: r.contactName, stages: r.stages, financeEmail });
    const log = await sendMail({ ...email, to: r.to, cc: financeEmail, template: 'payment_reminder', entity: 'company', entityId: r.companyId, sentBy: startedBy }, db);
    // The stage remembers the chase whether the mail left the server or was only logged.
    await db.query('UPDATE payment_stages SET reminder_sent_on = $1 WHERE id = ANY($2::int[])', [today, r.stages.map((s) => s.id)]);
    sent.push({ company: r.company, to: r.to, stages: r.stages.map((s) => s.invoice_no), status: log.status, email_id: log.id });
  }
  return { today, sent, skipped: plan.skipped, interval_days: intervalDays, grace_days: graceDays };
}

/** The morning digest to finance. */
export async function runFinanceDigest({ db = { query }, today = businessToday(), startedBy = 'schedule' } = {}) {
  const { rows: fin } = await db.query(`SELECT value FROM settings WHERE key = 'finance_email'`);
  const to = fin[0]?.value;
  if (!to) return { today, skipped: 'finance_email setting is empty' };
  const [{ rows: toInvoice }, { rows: overdue }, { rows: [{ n: remindersSent }] }] = await Promise.all([
    db.query(`SELECT * FROM v_payment_stages WHERE stage_status = 'To Invoice' ORDER BY client_name, po_number, stage_no`),
    db.query(`SELECT * FROM v_payment_stages WHERE stage_status = 'Overdue' ORDER BY days_overdue DESC`),
    db.query(`SELECT COUNT(*)::int AS n FROM email_log WHERE template = 'payment_reminder' AND created_at::date = $1::date AND status = 'sent'`, [today]),
  ]);
  const email = financeDigest({ today, toInvoice, overdue, remindersSent });
  const log = await sendMail({ ...email, to, template: 'finance_digest', entity: 'digest', entityId: today, sentBy: startedBy }, db);
  return { today, to, to_invoice: toInvoice.length, overdue: overdue.length, status: log.status, email_id: log.id };
}
