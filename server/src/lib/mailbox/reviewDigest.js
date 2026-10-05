/**
 * Once a day, each admin is told about the PO and invoice review items that
 * have waited more than two days (docs/email-auto-entry-plan.md §3.10): an
 * email the readers could not enter on their own is a PO or an invoice
 * nobody has entered yet. One notification per admin per day, and none on a
 * day with nothing waiting.
 */
import { query } from '../../db.js';
import { notify } from '../notify.js';
import { businessToday } from '../businessDate.ts';

export const OLDER_THAN_DAYS = 2;

export async function runReviewDigest({ today = businessToday(), db = { query } } = {}) {
  const { rows: [r] } = await db.query(
    `SELECT (SELECT count(*) FROM email_po_decisions WHERE outcome = 'review' AND decided_at < now() - make_interval(days => $1))::int AS pos,
            (SELECT count(*) FROM email_invoice_decisions WHERE outcome = 'review' AND decided_at < now() - make_interval(days => $1))::int AS invoices,
            LEAST((SELECT min(decided_at) FROM email_po_decisions WHERE outcome = 'review'),
                  (SELECT min(decided_at) FROM email_invoice_decisions WHERE outcome = 'review')) AS oldest`, [OLDER_THAN_DAYS]);
  if (!r.pos && !r.invoices) return { pos: 0, invoices: 0, told: 0 };
  const { rows: admins } = await db.query(`SELECT email FROM users WHERE role = 'admin' AND active AND email IS NOT NULL ORDER BY id`);
  const items = [r.pos ? `${r.pos} purchase order${r.pos === 1 ? '' : 's'}` : null, r.invoices ? `${r.invoices} invoice${r.invoices === 1 ? '' : 's'}` : null].filter(Boolean);
  const oldest = r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : null;
  let told = 0;
  for (const a of admins) {
    const n = await notify({
      username: a.email, kind: 'mailbox',
      title: `${items.join(' and ')} from email ${r.pos + r.invoices === 1 ? 'has' : 'have'} waited more than ${OLDER_THAN_DAYS} days for review`,
      body: `Read from email but not entered automatically.${oldest ? ` The oldest is from ${oldest}.` : ''} Until someone settles them, they are not in the tracker.`,
      link: r.pos ? '/purchase-orders?tab=review' : '/payment-stages?tab=invoice-review',
      dedupeKey: `email-review-digest:${today}:${a.email.toLowerCase()}`,
    }, db);
    if (n) told += 1;
  }
  return { pos: r.pos, invoices: r.invoices, told };
}
