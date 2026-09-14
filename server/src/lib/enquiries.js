import { businessToday } from './businessDate.js';
import { nextId } from './sequences.js';

export const ENQUIRY_WON = 'Won - Quotation Sent';

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

  // Two enquiries won at the same moment must not be handed the same number.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('quotation_no'))");
  const quotationNo = await nextId('quotation', client);

  await client.query(
    `INSERT INTO quotations (quotation_no, client_name, contact_person, service_quoted,
                             sector, sales_person, sales_person_email, quotation_date,
                             status, remarks)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Submitted',$9)`,
    [
      quotationNo, after.client_name, after.contact_person, after.service,
      after.sector, after.sales_person, after.sales_person_email,
      // Dated where the business is, not by the database server's clock.
      businessToday(),
      `From enquiry ${after.enquiry_no}`,
    ]
  );
  await client.query('UPDATE enquiries SET quotation_no = $1 WHERE id = $2', [quotationNo, after.id]);
  return { quotation_created: quotationNo };
}
