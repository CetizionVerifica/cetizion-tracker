/**
 * Every email the tracker can send to a client, and the admin's switches
 * that hold them back.
 *
 * The delivery switches in lib/mail.js (emails_enabled, EMAIL_MODE, staging)
 * stop everything, the team's digests and alerts included. These stop only
 * what would reach a client, so production can run live for the team while
 * nothing goes to a client until an admin says so:
 *
 *   client_emails_hold_all   'true' holds every client email
 *   client_emails_held       JSON list of the scenario keys held one by one
 *
 * A held email is still composed and written to email_log as suppressed,
 * with the reason, so the admin can read what would have gone out. It is
 * not sent later when the switch is turned back.
 *
 * `key` is the email_log template each scenario is logged under. The one
 * exception is mailbox_reply, which goes out through the connected mailbox
 * (lib/mailbox/sync.js) rather than lib/mail.js; it is held the same way.
 */

export const CLIENT_EMAILS = [
  {
    key: 'payment_reminder',
    label: 'Overdue payment reminder',
    automatic: true,
    when: 'The daily reminders job finds an invoice overdue by 3, 14 and 30 days, then every 7 days after that.',
    to: 'The billing contact, or the first contact with an email. Finance is copied.',
    skips: 'Invoices on hold, a promise-to-pay date still ahead, contacts who opted out, invoices read from mail nobody has reviewed.',
  },
  {
    key: 'portal_new_invoice',
    label: 'New invoice in the portal',
    automatic: true,
    when: 'An invoice is recorded for a client with the portal and its Invoices section on. Once per invoice.',
    to: 'The company\'s billing contacts with portal access, or the first portal contact.',
    skips: 'Invoices we already emailed ourselves, or when the public address is not set or the notice is off in Settings.',
  },
  {
    key: 'visit_client_reminder',
    label: 'Visit confirmation',
    automatic: true,
    when: 'On the visit reminder day (one day ahead by default), when "notify client" was ticked on the visit.',
    to: 'The visit\'s site contact.',
    skips: 'Contacts marked do not contact.',
  },
  {
    key: 'quotation',
    label: 'Quotation',
    automatic: false,
    when: 'Someone sends a quotation with "email" ticked.',
    to: 'The quotation\'s contact, or the address typed in.',
    skips: null,
  },
  {
    key: 'quotation_acceptance',
    label: 'Quotation for acceptance',
    automatic: false,
    when: 'Someone sends a quotation for acceptance with "email" ticked.',
    to: 'The quotation\'s contact, with a link to accept or ask for changes.',
    skips: null,
  },
  {
    key: 'portal_link',
    label: 'Portal sign-in link',
    automatic: false,
    when: 'A client asks for a link on the portal sign-in page, or someone presses Invite on a contact.',
    to: 'That contact.',
    skips: null,
  },
  {
    key: 'portal_reply',
    label: 'Reply to a portal message',
    automatic: false,
    when: 'Someone replies to a message a client sent through the portal.',
    to: 'The contact who wrote it.',
    skips: null,
  },
  {
    key: 'mailbox_reply',
    label: 'Reply from the Inbox',
    automatic: false,
    when: 'Someone replies to a mail thread from the Inbox or a record\'s timeline.',
    to: 'The thread\'s participants, sent from the connected mailbox.',
    skips: 'Contacts marked do not contact.',
  },
];

export const CLIENT_EMAIL_KEYS = CLIENT_EMAILS.map((e) => e.key);
const LABELS = Object.fromEntries(CLIENT_EMAILS.map((e) => [e.key, e.label]));

export const isClientEmail = (template) => Object.hasOwn(LABELS, template);

/** The held list as stored: known keys only, each once. */
export function parseHeld(value) {
  let list;
  try { list = JSON.parse(value || '[]'); } catch { list = []; }
  return Array.isArray(list) ? CLIENT_EMAIL_KEYS.filter((k) => list.includes(k)) : [];
}

/** { holdAll, held } as the settings say now. */
export async function clientEmailSwitches(db) {
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key IN ('client_emails_hold_all', 'client_emails_held')`);
  const value = (key) => rows.find((r) => r.key === key)?.value;
  return { holdAll: String(value('client_emails_hold_all') ?? '').trim().toLowerCase() === 'true', held: parseHeld(value('client_emails_held')) };
}

/**
 * Why this email may not go to the client, or null when it may. Only
 * client emails are ever held; anything else returns null without reading
 * the settings.
 */
export async function clientEmailHold(db, template) {
  if (!isClientEmail(template)) return null;
  const { holdAll, held } = await clientEmailSwitches(db);
  if (holdAll) return 'client emails are held by an admin';
  if (held.includes(template)) return `${LABELS[template].toLowerCase()} emails are held by an admin`;
  return null;
}

/**
 * Whose email it is. SQL for the ids of the users who own the
 * record a logged email is about, for an email_log row aliased `e`:
 *
 *   quotation       the quotation's owner
 *   payment_stage   the owner of the PO's quotation or of its project
 *   company         anyone who owns a quotation, project or enquiry there
 *                   (payment reminders, portal links and replies, visit
 *                   confirmations are logged against the company)
 *   email_thread    the same, for the company the thread is tied to
 *
 * Only owners who are active users of the app count: an owner who cannot
 * sign in has no view to see it in, and is not listed against it.
 * An email whose record has no owner is the admin's alone.
 */
export const emailOwnersSql = (e = 'e') => `ARRAY(
  SELECT DISTINCT x.o FROM (
    SELECT q.owner_user_id AS o FROM quotations q
     WHERE ${e}.entity = 'quotation' AND q.quotation_no = ${e}.entity_id
    UNION ALL
    SELECT q.owner_user_id FROM payment_stages s
      JOIN purchase_orders po ON po.po_number = s.po_number
      JOIN quotations q ON q.quotation_no = po.quotation_no
     WHERE ${e}.entity = 'payment_stage' AND s.id::text = ${e}.entity_id
    UNION ALL
    SELECT p.owner_user_id FROM payment_stages s
      JOIN purchase_orders po ON po.po_number = s.po_number
      JOIN projects p ON p.project_id = po.project_id
     WHERE ${e}.entity = 'payment_stage' AND s.id::text = ${e}.entity_id
    UNION ALL
    SELECT r.owner_user_id FROM (
        SELECT company_id, owner_user_id FROM quotations
        UNION ALL SELECT company_id, owner_user_id FROM projects
        UNION ALL SELECT company_id, owner_user_id FROM enquiries) r
     WHERE r.company_id = CASE
       WHEN ${e}.entity = 'company' AND ${e}.entity_id ~ '^[0-9]+$' THEN ${e}.entity_id::int
       WHEN ${e}.entity = 'email_thread' AND ${e}.entity_id ~ '^[0-9]+$' THEN (SELECT t.company_id FROM email_threads t WHERE t.id = ${e}.entity_id::int)
     END
  ) x JOIN users u ON u.id = x.o AND u.active
)`;

/**
 * A predicate limiting email_log rows aliased `e` to the client emails on
 * the caller's own records, or '' for someone who sees everything. Pushes
 * its value onto `params`, like ownerClause.
 */
export function ownEmailClause(scope, params, e = 'e') {
  if (scope.unrestricted) return '';
  params.push(CLIENT_EMAIL_KEYS, scope.ownerId);
  return `(${e}.template = ANY($${params.length - 1}) AND $${params.length} = ANY(${emailOwnersSql(e)}))`;
}
