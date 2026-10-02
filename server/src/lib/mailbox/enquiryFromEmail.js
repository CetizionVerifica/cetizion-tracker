/**
 * An email thread becomes an enquiry: one function, so a person pressing
 * "Create the enquiry" in the shared inbox and the automatic reader
 * (autoEnquiry.js) produce the same record, linked the same way.
 *
 * Runs inside the caller's transaction.
 */
import { claimNextId } from '../sequences.js';

const COLUMNS = ['client_name', 'contact_person', 'sales_person', 'service', 'sector', 'country', 'status', 'source_id', 'notes',
  'first_responded_at', 'owner_user_id', 'quotation_no', 'converted_at', 'estimated_value', 'currency'];

/**
 * enquiry: the enquiry's columns (client_name is required), plus
 *   dated_at  the moment it is dated from; its IST date is enquiry_date
 *   year      the numbering year; omitted, the current business year
 * The thread, and its inbox conversation if it has one, are linked to it,
 * and the sender's address goes onto the contact the enquiry linked to.
 */
export async function createEnquiryFromEmail(db, { threadId, fromEmail = null, fromName = null, enquiry }) {
  const no = await claimNextId('enquiry', db, enquiry.year);
  const cols = COLUMNS.filter((c) => enquiry[c] !== undefined);
  const values = cols.map((c) => enquiry[c]);
  const { rows: [e] } = await db.query(
    `INSERT INTO enquiries (enquiry_no, enquiry_date, ${cols.join(', ')})
     VALUES ($1, ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
    [no, enquiry.dated_at || new Date().toISOString(), ...values]);
  await db.query('UPDATE inbox_conversations SET enquiry_no = $2, company_id = COALESCE(company_id, $3) WHERE thread_id = $1', [threadId, e.enquiry_no, e.company_id]);
  await db.query(`UPDATE email_threads SET entity = 'enquiry', entity_id = $2, company_id = COALESCE(company_id, $3) WHERE id = $1`, [threadId, e.enquiry_no, e.company_id]);
  // The sender's address, onto the contact this enquiry is actually
  // linked to.
  //
  // This used to insert a contact under the sender's *display* name. The
  // enquiry above had already made one under whatever name was typed, and
  // whoever converts the thread often corrects it — "Ravi K" in the From
  // line becomes "Ravi Kumar". Contacts are unique by name within a
  // company, so those are two rows: one with the email and one the
  // enquiry and every quotation made from it point at, without it. The
  // address was recorded and then not used, which is worse than not
  // recording it (client-data-gaps.md, gap 2).
  //
  // So: fill the linked contact's blank, and only create one when the
  // enquiry linked to nobody.
  let contactId = e.contact_id || null;
  if (e.company_id && fromEmail) {
    if (contactId) {
      await db.query(
        `UPDATE contacts SET email = COALESCE(NULLIF(btrim(email), ''), $2) WHERE id = $1`,
        [contactId, fromEmail]);
    } else {
      const { rows: [ct] } = await db.query(
        `INSERT INTO contacts (company_id, name, email, notes) VALUES ($1,$2,$3,'Added from the inbox')
         ON CONFLICT (company_id, lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))) DO UPDATE SET email = COALESCE(contacts.email, EXCLUDED.email) RETURNING id`,
        [e.company_id, (fromName || fromEmail.split('@')[0]).slice(0, 160), fromEmail]);
      contactId = ct.id;
    }
    await db.query('UPDATE inbox_conversations SET contact_id = $2 WHERE thread_id = $1', [threadId, contactId]);
    await db.query('UPDATE email_threads SET contact_id = $2 WHERE id = $1', [threadId, contactId]);
  }
  return e;
}
