/**
 * Writing a client contact's email and phone from the screens people work in
 * (client-data-gaps.md, gap 1).
 *
 * `contacts.email` has always existed, and sending a quotation, chasing a
 * payment, reminding about a visit, the client portal and mailbox matching
 * all read it. What was missing was any way to fill it: the enquiry and
 * quotation forms take a contact's *name*, the trigger turns that name into
 * a contact row holding a name and nothing else, and so every contact made
 * the ordinary way had no address and every one of those features quietly
 * did less than it should.
 *
 * This is the other half. The fact still lives on the contact — one place,
 * as the README promises — and the forms write it there.
 *
 * Not built yet, from the same gap: the warning when an address already
 * belongs to a contact at another company. It needs a lookup the form can
 * call before saving, which is new API surface, so it is left out rather
 * than half-done.
 */
import { ApiError } from '../middleware/error.js';

/**
 * A blank is not an instruction.
 *
 * A value that is sent replaces what is stored, because the person is
 * looking at the current value in the form and changing it. A field left
 * empty leaves the stored value alone: clearing an address is a deliberate
 * act and belongs on the contact form, not a side effect of saving a
 * quotation that happened not to mention it.
 */
const sent = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Write an email and phone onto the contact a record is linked to.
 *
 * `contactId` is the row the b_link_contact trigger resolved from the typed
 * name, so this runs after the insert or update it belongs to, inside the
 * same transaction. No contact means nothing to write — a record can be
 * saved without naming anybody, and that is not an error.
 *
 * Returns what it changed, so a caller can say so.
 */
export async function saveContactDetails(client, contactId, { email, phone } = {}) {
  if (!contactId) return null;
  const sets = [];
  const params = [contactId];
  if (sent(email)) { params.push(email.trim()); sets.push(`email = $${params.length}`); }
  if (sent(phone)) { params.push(phone.trim()); sets.push(`phone = $${params.length}`); }
  if (!sets.length) return null;

  const { rows: [row] } = await client.query(
    `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, email, phone`, params);
  return row || null;
}

/**
 * The shape both forms accept, and the reason it is not a column.
 *
 * `contact_email` and `contact_phone` belong to `contacts`, not to
 * `enquiries` or `quotations`, so they stay out of each resource's
 * `columns` and never reach the INSERT. They arrive in `input`, which is
 * everything the schema accepted, and onSave writes them where they live —
 * the same route projects already take for `quotation_no`.
 */
export function contactDetailsFrom(input = {}) {
  return { email: input.contact_email, phone: input.contact_phone };
}

/** An address that is not one. Kept here so both forms refuse the same things. */
export function assertEmailLooksReal(email) {
  if (!sent(email)) return;
  const v = email.trim();
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v) || v.length > 160) {
    throw new ApiError(422, 'Please check the highlighted fields', {
      contact_email: 'That does not look like an email address',
    });
  }
}
