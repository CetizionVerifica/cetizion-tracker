/**
 * Payment reminders and the finance digest (#21, #27).
 *
 * The rules are pure functions over rows (tested without a database); the
 * runners read the rows, apply them and send through lib/mail.js.
 */
import { query } from '../db.js';
import { businessToday } from './businessDate.ts';
import { financeDigest, paymentReminder } from './emailTemplates.js';
import { sendMail } from './mail.js';

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Which overdue stages get a reminder today, grouped per client, and at
 * which level.
 *
 * stages: rows of v_payment_stages joined with the billing contact:
 *   { ..., company_id, company_name, contact_name, contact_email, opt_out,
 *     on_hold, promise_to_pay_date, reminder_level, reminder_sent_on }
 * Rules:
 *  - an invoice must exist and the stage must be Overdue;
 *  - a stage on hold (dispute) or with a promise to pay still in the
 *    future is left alone;
 *  - levels: the first, second and final reminders go at the days in
 *    levelDays (3, 14, 30 by default); after the final one, every
 *    intervalDays; a level already sent is not repeated;
 *  - a client with no billing email, or an opted-out contact, is
 *    reported but not emailed.
 */
export function planReminders(stages, { today, intervalDays = 7, levelDays = [3, 14, 30] } = {}) {
  const groups = new Map();
  const skipped = [];
  for (const s of stages) {
    if (s.stage_status !== 'Overdue' || !s.invoice_no) continue;
    const overdue = Number(s.days_overdue || 0);
    const current = Number(s.reminder_level || 0);
    if (s.on_hold) { skipped.push({ id: s.id, reason: `on hold${s.hold_reason ? `: ${s.hold_reason}` : ''}` }); continue; }
    if (s.promise_to_pay_date && s.promise_to_pay_date >= today) { skipped.push({ id: s.id, reason: `promised to pay by ${s.promise_to_pay_date}` }); continue; }
    // The level this stage has earned by now.
    const earned = levelDays.filter((d) => overdue >= d).length;
    // However many levels it has earned, a client hears from us once per
    // interval. Without this, an invoice already past every threshold walks
    // up the levels one run at a time — three emails on three consecutive
    // mornings, which is what the first run after deploy would have done to
    // every debt over 30 days old.
    const sinceLast = s.reminder_sent_on ? daysBetween(s.reminder_sent_on, today) : null;
    const intervalElapsed = sinceLast === null || sinceLast >= intervalDays;
    let level = null;
    if (earned > current && intervalElapsed) level = Math.min(current + 1, levelDays.length);
    else if (earned >= levelDays.length && intervalElapsed) level = current + 1;
    if (level === null) {
      const reason = earned === 0 ? `within the ${levelDays[0]}-day grace period`
        : sinceLast !== null ? `reminded ${sinceLast} days ago at level ${current}`
        : 'nothing due yet';
      skipped.push({ id: s.id, reason }); continue;
    }
    if (!s.contact_email) { skipped.push({ id: s.id, reason: `${s.client_name}: no billing contact with an email` }); continue; }
    if (s.opt_out) { skipped.push({ id: s.id, reason: `${s.contact_email} opted out of automatic email` }); continue; }
    const key = s.company_id ?? s.client_name;
    if (!groups.has(key)) groups.set(key, { company: s.company_name || s.client_name, companyId: s.company_id, to: s.contact_email, contactName: s.contact_name, stages: [], level: 0 });
    const g = groups.get(key);
    g.stages.push({ ...s, next_level: level });
    g.level = Math.max(g.level, Math.min(level, levelDays.length));
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

async function setting(db, key, fallback) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? fallback;
}

/** Send today's payment reminders. Returns what was sent and what was skipped, for the job log. */
export async function runPaymentReminders({ db = { query }, today = businessToday(), startedBy = 'schedule' } = {}) {
  const intervalDays = Number(await setting(db, 'reminder_interval_days', '7')) || 7;
  const levelDays = String(await setting(db, 'reminder_levels_days', '3,14,30')).split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const { rows } = await db.query(`${STAGE_ROWS} WHERE ps.stage_status = 'Overdue'`);
  const financeEmail = (await setting(db, 'finance_email', '')) || null;
  const plan = planReminders(rows, { today, intervalDays, levelDays: levelDays.length ? levelDays : [3, 14, 30] });
  const sent = [];
  for (const r of plan.reminders) {
    const email = paymentReminder({ company: r.company, contactName: r.contactName, stages: r.stages, financeEmail, level: r.level, finalLevel: levelDays.length || 3 });
    const log = await sendMail({ ...email, to: r.to, cc: financeEmail, template: 'payment_reminder', entity: 'company', entityId: r.companyId, sentBy: startedBy }, db);
    // The stage remembers the chase and its level whether the mail left the server or was only logged.
    for (const s of r.stages) {
      await db.query('UPDATE payment_stages SET reminder_sent_on = $1, reminder_level = $3 WHERE id = $2', [today, s.id, s.next_level]);
    }
    await db.query(
      `INSERT INTO collection_log (stage_id, company_id, channel, by_whom, summary)
       SELECT id, $2, 'email', $3, $4 FROM payment_stages WHERE id = ANY($1::int[])`,
      [r.stages.map((s) => s.id), r.companyId, startedBy, `Reminder level ${r.level} emailed to ${r.to} (${log.status})`]
    );
    sent.push({ company: r.company, to: r.to, level: r.level, stages: r.stages.map((s) => s.invoice_no), status: log.status, email_id: log.id });
  }
  return { today, sent, skipped: plan.skipped, interval_days: intervalDays, level_days: levelDays };
}

/** The morning digest to finance. */
export async function runFinanceDigest({ db = { query }, today = businessToday(), startedBy = 'schedule' } = {}) {
  const to = (await setting(db, 'finance_email', '')) || null;
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
