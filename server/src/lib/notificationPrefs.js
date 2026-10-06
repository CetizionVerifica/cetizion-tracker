/**
 * What each person wants to hear about, and how (#44).
 *
 * Stored in users.notify, which already existed and which nothing read:
 *
 *   kinds   { <group>: 'in_app' | 'email' | 'both' | 'off' }   default in_app
 *   quiet   { from: 'HH:MM', to: 'HH:MM' } | null              no email or pop-up then
 *   digest  boolean                                              the 08:30 digest, default on
 *   weekly  boolean                                              admins' Monday digest, default on
 *
 * The four switches the page had before (follow_up_late, deal_accepted,
 * discount_approval, monday_brief) are still accepted; monday_brief false
 * still turns the weekly digest off.
 *
 * A group is what a person decides about; a kind is what the sweep raises.
 */
export const GROUPS = {
  tasks: { label: 'Tasks due or overdue', kinds: ['task_due', 'task_overdue'] },
  follow_ups: { label: 'Enquiry follow-ups due', kinds: ['follow_up'] },
  approvals: { label: 'Discounts waiting for approval', kinds: ['approval'] },
  deals: { label: 'Deals: accepted, PO registered, expiring, renewals', kinds: ['acceptance', 'po_registered', 'expiring', 'renewal'] },
  money: { label: 'Overdue invoices and cost alerts', kinds: ['invoice_overdue', 'cost_alert'] },
  inbox: { label: 'Mail waiting for a reply', kinds: ['inbox'] },
  visits: { label: 'Audit and site visits', kinds: ['visit'] },
  follow_up_escalations: { label: 'Follow-ups escalated to management', kinds: ['follow_up_escalated'] },
  // docs/email-po-plan.md: what the email readers could not settle alone, and the invoices they recorded.
  from_email: { label: 'POs and invoices read from email', kinds: ['po_review', 'invoice_recorded', 'invoice_review'] },
  client_portal: { label: 'Client portal: queries, payments reported, files uploaded', kinds: ['portal_action', 'portal_upload'] },
};
export const CHANNELS = ['in_app', 'email', 'both', 'off'];

export const groupOf = (kind) => Object.keys(GROUPS).find((g) => GROUPS[g].kinds.includes(kind)) || null;

/** How this person takes this kind; anything unconfigured, or ungrouped, is in the app. */
export function channelFor(prefs, kind) {
  const group = groupOf(kind);
  const chosen = group ? prefs?.kinds?.[group] : null;
  return CHANNELS.includes(chosen) ? chosen : 'in_app';
}

/** The kinds this person does not want in the bell. */
export function hiddenKinds(prefs) {
  return Object.values(GROUPS).flatMap((g) => g.kinds).filter((k) => ['email', 'off'].includes(channelFor(prefs, k)));
}

export const wantsEmail = (prefs, kind) => ['email', 'both'].includes(channelFor(prefs, kind));
export const wantsDigest = (prefs) => prefs?.digest !== false;
export const wantsWeekly = (prefs) => prefs?.weekly !== false && prefs?.monday_brief !== false;

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Inside the person's quiet hours, in their time zone? A range may run past midnight. */
export function inQuietHours(prefs, { now = new Date(), timeZone = 'Asia/Kolkata' } = {}) {
  const from = minutes(prefs?.quiet?.from);
  const to = minutes(prefs?.quiet?.to);
  if (from === null || to === null || from === to) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const at = Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
  return from < to ? at >= from && at < to : at >= from || at < to;
}
