/**
 * The readers' to-do list: every email handed to the PO, invoice or
 * enquiry reader, kept until that reader has finished with it.
 *
 *   enqueue(db, account, cand, readers)   inside the transaction that stores the email
 *   runReaders(account, routed, opts)     hand a batch over, settling each row
 *   retryQueued(account, provider)        read again what failed, or never ran
 *
 * The readers used to be handed a sync's mail in memory only, after the
 * delta link had moved past it. An email whose reading threw (a database
 * hiccup, a lock timeout, the process restarted during an AI call) left no
 * decision behind, the next delta did not return it, and the past-mail
 * backfill had already finished: it was never read again, and the PO,
 * invoice or enquiry it carried was never entered.
 *
 * A row holds the email's ids and how ingest classified it — never the
 * message itself, so a metadata-only mailbox keeps no body here. A retry
 * fetches the message from the mailbox again, or from the tracker's stored
 * copy when the mailbox no longer has it under that id.
 */
import { query } from '../../db.js';
import { notify } from '../notify.js';

/** The order the readers run in: POs before the invoices that bill them, both before enquiries. */
export const READERS = ['po', 'invoice', 'enquiry'];
/** After this many failed reads the row stops being retried, and admins are told. */
export const MAX_ATTEMPTS = 8;
/** How many queued reads one sync takes on, so a backlog cannot hold up new mail. */
export const RETRY_BATCH = 20;

const slim = (cand) => ({ c: cand.c, threadId: cand.threadId ?? null, newThread: Boolean(cand.newThread), dropped: Boolean(cand.dropped) });

/** Queue `cand` for each of `readers`. An email already queued for a reader keeps its row. */
export async function enqueue(db, account, cand, readers) {
  for (const reader of readers) {
    await db.query(
      `INSERT INTO email_reader_queue (account_id, provider_id, reader, folder, sent_at, cand)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (account_id, provider_id, reader) DO NOTHING`,
      [account.id, cand.m.provider_id, reader, cand.m.folder || null, cand.m.sent_at || null, JSON.stringify(slim(cand))]);
  }
}

/** A reader has finished with an email: done, or failed and to be read again later. */
async function settle(account, reader, cand, err) {
  if (!err) {
    await query('DELETE FROM email_reader_queue WHERE account_id = $1 AND provider_id = $2 AND reader = $3', [account.id, cand.m.provider_id, reader]);
    return;
  }
  // A failure the backfill met has no row yet: it is queued here, once failed.
  const { rows: [row] } = await query(
    `INSERT INTO email_reader_queue AS q (account_id, provider_id, reader, folder, sent_at, cand, attempts, last_error, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,1,$7, now() + interval '10 minutes')
     ON CONFLICT (account_id, provider_id, reader) DO UPDATE
        SET attempts = q.attempts + 1, last_error = EXCLUDED.last_error,
            next_attempt_at = now() + make_interval(mins => least(10 * power(2, q.attempts), 720)::int),
            failed_at = CASE WHEN q.attempts + 1 >= $8 THEN now() END
     RETURNING *`,
    [account.id, cand.m.provider_id, reader, cand.m.folder || null, cand.m.sent_at || null, JSON.stringify(slim(cand)),
      String(err.message || err).slice(0, 500), MAX_ATTEMPTS]);
  if (row.failed_at) await giveUp(account, row);
}

async function giveUp(account, row) {
  const what = { po: 'a purchase order', invoice: 'an invoice', enquiry: 'an enquiry or quotation' }[row.reader];
  await notify({
    kind: 'mailbox', title: `An email to ${account.email} could not be read for ${what}`,
    body: `Tried ${row.attempts} times; last error: ${row.last_error}. Check it by hand.`,
    link: '/settings/mailboxes', dedupeKey: `reader-queue-failed:${row.id}`,
  }).catch(() => {});
}

/**
 * A reading that failed for a reason that passes (the AI timed out or gave
 * no answer, an attachment did not download). Thrown by a reader to have
 * the email read again later instead of deciding it on half the facts.
 */
export const transientError = (message) => Object.assign(new Error(message), { transient: true });

/** Is this the email's last try in the queue? Then a reader decides with what it has. */
export const lastTry = (cand) => (cand.attempts ?? 0) >= MAX_ATTEMPTS - 1;

/** `onSettled` for a reader: what every caller of a reader passes it. */
export const settler = (account, reader) => (cand, err) => settle(account, reader, cand, err);

/** `onSettled` for a backfill: only a failure is queued; the backfill's own cursor covers the rest. */
export const queueFailures = (account, reader) => (cand, err) => (err ? settle(account, reader, cand, err) : null);

/**
 * Hand each reader its candidates, in READERS order. `routed` is
 * { po: [cand], invoice: [cand], enquiry: [cand] }. Returns each reader's
 * tally by the names syncAccount reports them under.
 */
export async function runReaders(account, routed, { provider = null } = {}) {
  const out = {};
  const readers = {
    po: async () => (await import('./autoPurchaseOrder.js')).processPoCandidates,
    invoice: async () => (await import('./autoInvoice.js')).processInvoiceCandidates,
    enquiry: async () => (await import('./autoEnquiry.js')).processCandidates,
  };
  const names = { po: 'purchase_orders', invoice: 'invoices', enquiry: 'enquiries' };
  for (const reader of READERS) {
    const cands = routed[reader] || [];
    if (!cands.length) continue;
    const r = await (await readers[reader]())(account, cands, { provider, onSettled: settler(account, reader) });
    if (r) out[names[reader]] = r;
    // Switched off: nothing will read these, now or later.
    else await query('DELETE FROM email_reader_queue WHERE account_id = $1 AND reader = $2 AND provider_id = ANY($3)', [account.id, reader, cands.map((x) => x.m.provider_id)]);
  }
  return out;
}

/** The message behind a queued row: from the mailbox, else the tracker's stored copy. */
async function messageFor(account, provider, row) {
  try {
    if (provider.message) return { ...(await provider.message(row.provider_id)), folder: row.folder };
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  const { rows: [s] } = await query(
    `SELECT m.*, t.conversation_id FROM email_messages m JOIN email_threads t ON t.id = m.thread_id
      WHERE m.account_id = $1 AND m.provider_id = $2`, [account.id, row.provider_id]);
  if (!s) return null;
  const person = (email) => ({ email, name: null });
  return {
    provider_id: s.provider_id, conversation_id: s.conversation_id, internet_message_id: s.internet_message_id,
    subject: s.subject, body_html: s.body_html, preview: s.snippet, from: { email: s.from_email, name: s.from_name },
    to: (s.to_emails || []).map(person), cc: (s.cc_emails || []).map(person), sent_at: s.sent_at, has_attachments: s.has_attachments, folder: row.folder,
  };
}

/**
 * Read again what is due: emails whose reading failed, and any a crash
 * left behind before their reader ran. Oldest first, at most `limit`.
 */
export async function retryQueued(account, provider, { limit = RETRY_BATCH } = {}) {
  const { rows } = await query(
    `SELECT * FROM email_reader_queue WHERE account_id = $1 AND failed_at IS NULL AND next_attempt_at <= now()
      ORDER BY sent_at NULLS LAST, id LIMIT $2`, [account.id, limit]);
  if (!rows.length) return null;
  const routed = {};
  const fetched = new Map();
  for (const row of rows) {
    let m = fetched.get(row.provider_id);
    if (m === undefined) {
      try {
        m = await messageFor(account, provider, row);
      } catch (err) {
        // The mailbox could not be asked (throttled, offline): a failed attempt like any other.
        await settle(account, row.reader, { m: { provider_id: row.provider_id, folder: row.folder, sent_at: row.sent_at } }, err);
        continue;
      }
      fetched.set(row.provider_id, m);
    }
    if (!m) {
      const { rows: [gone] } = await query(
        `UPDATE email_reader_queue SET failed_at = now(), last_error = 'no longer in the mailbox, and never stored' WHERE id = $1 RETURNING *`, [row.id]);
      await giveUp(account, gone);
      continue;
    }
    // `attempts`: the readers settle a doubtful email on its last try
    // rather than leave it undecided (lastTry).
    (routed[row.reader] ||= []).push({ ...row.cand, m, attempts: row.attempts });
  }
  return { retried: rows.length, ...(await runReaders(account, routed, { provider })) };
}
