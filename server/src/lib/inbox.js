/**
 * The shared sales inbox (#30): every thread in a shared mailbox is a
 * conversation with an owner, a status and a first-response deadline.
 *
 * Registered as a mailbox hook, so it runs inside the transaction that
 * stores each message.
 */
import { query } from '../db.js';
import { businessWeekday } from './businessDate.ts';
import { messageHooks } from './mailbox/sync.js';
import { notify } from './notify.js';

/** Who should own a new conversation. */
export function pickAssignee({ rule, companyOwner, members = [], last = null }) {
  if (rule === 'unassigned') return { assignee: null, last };
  if (rule === 'owner_of_company' && companyOwner) return { assignee: companyOwner, last };
  if (!members.length) return { assignee: companyOwner || null, last };
  const i = last ? members.indexOf(last) : -1;
  const next = members[(i + 1) % members.length];
  return { assignee: next, last: next };
}

/**
 * Add working hours, skipping Sundays: a deadline that lands on one moves
 * to Monday, the same time of day.
 *
 * Sunday where the business is, not where the container's clock is. IST is
 * five and a half hours ahead, so 20:00 UTC Saturday is already Sunday
 * morning in Mumbai and was not being moved, while 19:30 UTC Sunday is
 * Monday here and was being pushed a day it did not need.
 */
export function dueAfter(fromIso, hours, timeZone = undefined) {
  const d = new Date(new Date(fromIso).getTime() + hours * 3600 * 1000);
  if (businessWeekday(d, timeZone) === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

async function companyOwner(db, companyId) {
  if (!companyId) return null;
  const { rows: [r] } = await db.query(
    `SELECT sales_person FROM quotations WHERE company_id = $1 AND sales_person IS NOT NULL AND sales_person <> ''
      ORDER BY COALESCE(last_contacted_at, created_at) DESC LIMIT 1`, [companyId]);
  return r?.sales_person || null;
}

/**
 * Mail that arrived in the shared mailbox's Inbox folder from somebody
 * other than the mailbox itself.
 *
 * classify() calls a message outbound when its sender is one of us, which
 * is right for answering a client and wrong for a colleague writing to
 * sales@: that is mail the shared address received, and the Inbox shows
 * everything the address receives. It only decides whether a thread gets
 * a conversation — once it has one, a colleague's message still counts as
 * our reply, as it always has.
 */
const receivedHere = (account, message, folder) => folder === 'inbox'
  && String(message.from_email || '').toLowerCase() !== String(account.email || '').toLowerCase();

async function routeToInbox({ db, account, thread, message, folder = null }) {
  if (!account.is_shared) return;
  const { rows: [inbox] } = await db.query('SELECT * FROM inboxes WHERE account_id = $1 AND active FOR UPDATE', [account.id]);
  if (!inbox) return;
  const { rows: [conv] } = await db.query('SELECT * FROM inbox_conversations WHERE thread_id = $1 FOR UPDATE', [thread.id]);

  if (message.direction === 'outbound' && !(!conv && receivedHere(account, message, folder))) {
    if (conv) {
      await db.query(
        `UPDATE inbox_conversations SET first_response_at = COALESCE(first_response_at, $2), response_due_at = NULL,
                status = CASE WHEN status = 'closed' THEN status ELSE 'pending_client' END WHERE id = $1`, [conv.id, message.sent_at]);
    }
    return;
  }

  const { rows: [{ value: defaultHours }] } = await db.query(`SELECT COALESCE((SELECT value FROM settings WHERE key = 'lead_first_response_hours'), '24') AS value`);
  const hours = inbox.first_response_hours || Number(defaultHours) || 24;
  if (!conv) {
    const pick = pickAssignee({ rule: inbox.default_assignment, companyOwner: await companyOwner(db, thread.company_id), members: inbox.members, last: inbox.round_robin_last });
    if (pick.last !== inbox.round_robin_last) await db.query('UPDATE inboxes SET round_robin_last = $2 WHERE id = $1', [inbox.id, pick.last]);
    const { rows: [created] } = await db.query(
      `INSERT INTO inbox_conversations (inbox_id, thread_id, company_id, contact_id, from_email, from_name, assignee, last_inbound_at, response_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [inbox.id, thread.id, thread.company_id, thread.contact_id, message.from_email, message.from_name, pick.assignee, message.sent_at, dueAfter(message.sent_at, hours)]);
    await notify({ kind: 'inbox', username: 'admin', title: `New email in ${inbox.name}: ${message.subject || '(no subject)'}`, body: `${message.from_name || message.from_email}${pick.assignee ? ` · assigned to ${pick.assignee}` : ' · unassigned'}`, link: `/inbox?c=${created.id}`, dedupeKey: `inbox:${created.id}` }, db);
    return;
  }
  // The client wrote again: reopen, and a new reply is due if we had answered.
  await db.query(
    `UPDATE inbox_conversations SET last_inbound_at = $2, status = 'open', closed_at = NULL, snoozed_until = NULL,
            response_due_at = CASE WHEN response_due_at IS NULL THEN $3::timestamptz ELSE response_due_at END,
            company_id = COALESCE(company_id, $4), contact_id = COALESCE(contact_id, $5)
      WHERE id = $1`, [conv.id, message.sent_at, dueAfter(message.sent_at, hours), thread.company_id, thread.contact_id]);
}

let registered = false;
export function registerInboxHook() {
  if (registered) return;
  registered = true;
  messageHooks.push(routeToInbox);
}
registerInboxHook();

/** Fill {{variables}} in a canned response. */
export function fillTemplate(body, vars) {
  return String(body).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] ?? '').toString());
}

/**
 * Snoozed conversations wake when their time comes.
 *
 * There is no background job for this: a conversation comes back only
 * because somebody asked for a list and it was woken on the way. That was
 * fine while the Inbox page was the only reader — it lived in routes and
 * both its list routes called it. list_inbox over MCP is a second reader,
 * and one that will not call it is one that under-reports the queue: a
 * thread snoozed until Tuesday stays invisible on Wednesday until a person
 * happens to open the page.
 */
export const wake = () => query(
  `UPDATE inbox_conversations SET status = 'open', snoozed_until = NULL
    WHERE status = 'snoozed' AND snoozed_until <= now()`);
