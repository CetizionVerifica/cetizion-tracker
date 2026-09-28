import { businessToday } from './businessDate.ts';
import { claimNextId } from './sequences.js';
import { ENQUIRY_STATUS } from './statuses.js';

export const ENQUIRY_WON = ENQUIRY_STATUS.quoted;

/**
 * An enquiry marked won becomes a quotation, with everything the enquiry
 * already knows copied across and the two linked. An enquiry that is
 * already linked — to a quotation created earlier, or to an existing one
 * picked on the form — creates nothing, so enquiries back-filled for past
 * quotations never duplicate them. Runs inside the save's transaction, so
 * if the quotation cannot be created the enquiry is not saved either.
 *
 * Returns { quotation_created } when it made one, for the save response.
 */
export async function quoteWonEnquiry(client, { before, after }) {
  if (after.status !== ENQUIRY_WON || after.quotation_no) return undefined;
  // Already won before this save and no quotation linked: someone removed
  // the link on purpose, so an unrelated edit must not create another.
  if (before?.status === ENQUIRY_WON) return undefined;

  // The quotation date inherits the enquiry's date (e.g. for historical enquiries),
  // falling back to today in the business time zone when blank.
  const quotationDate = after.enquiry_date || businessToday();
  const year = String(quotationDate).slice(0, 4);

  // Two quotations created at the same moment must not be handed the same number.
  // The quotation number year is strictly derived from the quotation's own date.
  const quotationNo = await claimNextId('quotation', client, year);

  await client.query(
    // owner_user_id comes from the enquiry, not from whoever happened to save
    // it and not from the free-text sales_person beside it (#18 Phase 2C).
    // The quotation is the same piece of work one step on, so responsibility
    // carries across; an unowned enquiry makes an unowned quotation, which is
    // the honest answer rather than a guess.
    //
    // Originating salesperson (#18 Phase 4): preserved only when the enquiry
    // has a verified originating salesperson.
    `INSERT INTO quotations (quotation_no, client_name, contact_person, service_quoted,
                             sector, sales_person, sales_person_email, quotation_date,
                             status, remarks, quotation_value, currency, owner_user_id,
                             originating_user_id, originating_user_snapshot_id, originating_user_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Submitted',$9,$10,$11,$12,$13,$14,$15)`,
    [
      quotationNo, after.client_name, after.contact_person, after.service || after.services_interested,
      after.sector, after.sales_person, after.sales_person_email,
      quotationDate,
      `From enquiry ${after.enquiry_no}`,
      after.estimated_value ?? null, after.currency || 'INR',
      after.owner_user_id ?? null,
      after.originating_user_id ?? null,
      after.originating_user_id ? (after.originating_user_snapshot_id ?? after.originating_user_id) : null,
      after.originating_user_id ? (after.originating_user_name ?? null) : null,
    ]
  );
  await client.query('UPDATE enquiries SET quotation_no = $1 WHERE id = $2', [quotationNo, after.id]);
  return { quotation_created: quotationNo };
}
