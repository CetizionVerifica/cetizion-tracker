/**
 * Notifications (#44): one place to tell a person something needs them.
 *
 *   notify({ kind, title, body, entity, entityId, link, dedupeKey })
 *     writes a row for the admin (the only account until #18); a dedupe key
 *     stops the same thing being raised twice.
 *
 *   collectNotifications({ today })
 *     the daily sweep: tasks due or overdue, follow-ups due, approvals
 *     waiting, invoices newly overdue, renewals open, quotations expiring
 *     soon. Returns what it raised and the counts for the digest.
 */
import { query } from '../db.js';
import { businessToday } from './businessDate.js';
import { sendMail } from './mail.js';
import { dailyDigest } from './emailTemplates.js';

/**
 * Raise one notification.
 *
 * `username` is who it is for: a name the tracker already records — a
 * task's assignee, an enquiry's sales person — or null, which means
 * everyone. Null is the honest answer for most of them: a backup that
 * failed or an invoice gone overdue is not one person's business.
 *
 * It used to default to the literal string 'admin' while the route read as
 * req.user.username, which in database mode is an email address. Nothing
 * ever matched, so the bell read zero for everybody (#44).
 */
export async function notify({ username = null, kind, title, body = null, entity = null, entityId = null, link = null, dedupeKey = null }, db = { query }) {
  const { rows } = await db.query(
    `INSERT INTO notifications (username, kind, title, body, entity, entity_id, link, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
    [username, kind, title, body, entity, entityId === null ? null : String(entityId), link, dedupeKey]
  );
  return rows[0] || null;
}

const enc = (s) => encodeURIComponent(String(s));

export async function collectNotifications({ today = businessToday(), db = { query } } = {}) {
  const raised = [];
  const add = async (n) => { const r = await notify(n, db); if (r) raised.push(r); return r; };
  const day = today;

  const { rows: tasks } = await db.query(`SELECT * FROM tasks WHERE status <> 'done' AND due_at <= $1 ORDER BY due_at`, [today]);
  for (const t of tasks) {
    const overdue = t.due_at < today;
    await add({ username: t.assignee || null, kind: overdue ? 'task_overdue' : 'task_due', title: `${overdue ? 'Overdue' : 'Due today'}: ${t.title}`, body: `${t.entity.replace('_', ' ')} ${t.entity_id}${t.assignee ? ` · ${t.assignee}` : ''}`, entity: t.entity, entityId: t.entity_id, link: '/tasks', dedupeKey: `task:${t.id}:${day}` });
  }

  const { rows: followups } = await db.query(`SELECT enquiry_no, client_name, next_follow_up_at, sales_person FROM enquiries WHERE status IN ('New','Contacted','Qualified','Nurture') AND next_follow_up_at <= $1`, [today]);
  for (const e of followups) {
    await add({ username: e.sales_person || null, kind: 'follow_up', title: `Follow up ${e.client_name}`, body: `Enquiry ${e.enquiry_no}, due ${e.next_follow_up_at}${e.sales_person ? ` · ${e.sales_person}` : ''}`, entity: 'enquiry', entityId: e.enquiry_no, link: `/enquiries?q=${enc(e.enquiry_no)}`, dedupeKey: `followup:${e.enquiry_no}:${day}` });
  }

  const { rows: approvals } = await db.query(`SELECT quotation_no, client_name, approval_reason, discount_percent FROM quotations WHERE approval_status = 'pending'`);
  for (const q of approvals) {
    await add({ kind: 'approval', title: `Approval waiting: ${q.quotation_no}`, body: `${q.client_name} · ${q.approval_reason || `${Number(q.discount_percent)}% discount`}`, entity: 'quotation', entityId: q.quotation_no, link: `/quotations/${enc(q.quotation_no)}`, dedupeKey: `approval:${q.quotation_no}:${day}` });
  }

  const { rows: overdue } = await db.query(`SELECT id, po_number, stage_name, invoice_no, client_name, days_overdue FROM v_payment_stages WHERE stage_status = 'Overdue' AND days_overdue <= 1`);
  for (const s of overdue) {
    await add({ kind: 'invoice_overdue', title: `Invoice ${s.invoice_no} is now overdue`, body: `${s.client_name} · ${s.po_number} · ${s.stage_name}`, entity: 'payment_stage', entityId: s.id, link: '/collections', dedupeKey: `overdue:${s.id}` });
  }

  const { rows: renewals } = await db.query(`SELECT e.id, e.client_name, e.service_name, e.next_due_on, q.quotation_no FROM engagements e LEFT JOIN quotations q ON q.id = e.renewal_quotation_id WHERE e.status = 'renewal_open' AND e.renewal_opened_at >= $1::date - 1`, [today]);
  for (const r of renewals) {
    await add({ kind: 'renewal', title: `Renewal opened: ${r.client_name}`, body: `${r.service_name} due ${r.next_due_on}${r.quotation_no ? ` · draft ${r.quotation_no}` : ''}`, entity: 'quotation', entityId: r.quotation_no, link: '/renewals', dedupeKey: `renewal:${r.id}` });
  }

  const { rows: [{ value: warn }] } = await db.query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'quotation_expiry_warning_days'), '7') AS value`);
  const { rows: expiring } = await db.query(
    `SELECT quotation_no, client_name, valid_until FROM quotations WHERE status IN ('Submitted','Under Negotiation') AND sent_at IS NOT NULL AND accepted_at IS NULL
        AND valid_until BETWEEN $1::date AND $1::date + $2::int`, [today, Number(warn) || 7]);
  for (const q of expiring) {
    await add({ kind: 'expiring', title: `${q.quotation_no} expires on ${q.valid_until}`, body: `${q.client_name}: chase, extend or revise`, entity: 'quotation', entityId: q.quotation_no, link: `/quotations/${enc(q.quotation_no)}`, dedupeKey: `expiring:${q.quotation_no}:${q.valid_until}` });
  }

  const { rows: [{ value: unseenDays }] } = await db.query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'acceptance_unviewed_days'), '3') AS value`);
  const { rows: unseen } = await db.query(
    `SELECT a.id, a.sent_to, a.created_at, q.quotation_no, q.client_name FROM quotation_acceptances a JOIN quotations q ON q.id = a.quotation_id
      WHERE a.status = 'sent' AND a.expires_at > now() AND a.created_at < $1::date - $2::int`, [today, Number(unseenDays) || 3]);
  for (const a of unseen) {
    await add({ kind: 'acceptance', title: `${a.quotation_no}: acceptance link not opened yet`, body: `${a.client_name}${a.sent_to ? ` · sent to ${a.sent_to}` : ''}`, entity: 'quotation', entityId: a.quotation_no, link: `/quotations/${enc(a.quotation_no)}`, dedupeKey: `unseen:${a.id}` });
  }

  const { rows: late } = await db.query(
    `SELECT c.id, c.assignee, c.from_email, c.from_name, c.response_due_at, t.subject, i.name AS inbox
       FROM inbox_conversations c JOIN email_threads t ON t.id = c.thread_id JOIN inboxes i ON i.id = c.inbox_id
      WHERE c.status = 'open' AND c.response_due_at < now()`);
  for (const c of late) {
    await add({ kind: 'inbox', title: `No reply yet: ${c.subject || '(no subject)'}`, body: `${c.inbox} · ${c.from_name || c.from_email}${c.assignee ? ` · ${c.assignee}` : ' · unassigned'}`, link: `/inbox?c=${c.id}`, dedupeKey: `inbox-late:${c.id}:${day}` });
  }

  return { today, raised, counts: { tasks: tasks.length, follow_ups: followups.length, approvals: approvals.length, newly_overdue: overdue.length, renewals: renewals.length, expiring: expiring.length, unopened_links: unseen.length, inbox_overdue: late.length } };
}

/** The daily job: the sweep, then one digest email with everything still unread. */
export async function runNotifications({ today = businessToday() } = {}) {
  const sweep = await collectNotifications({ today });
  const { rows: unread } = await query(`SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT 100`);
  const { rows: s } = await query(`SELECT key, value FROM settings WHERE key IN ('digest_email', 'finance_email')`);
  const settings = Object.fromEntries(s.map((r) => [r.key, r.value]));
  const to = settings.digest_email || settings.finance_email || null;
  let email = null;
  if (to && unread.length) {
    email = await sendMail({ ...dailyDigest({ today, items: unread }), to, template: 'daily_digest', entity: 'digest', entityId: `notifications:${today}`, sentBy: 'schedule' });
  }
  return { ...sweep, raised: sweep.raised.length, unread: unread.length, digest: email ? { to, status: email.status, reason: email.reason } : 'nothing to send' };
}
