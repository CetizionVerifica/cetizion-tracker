import { query } from '../db.js';

/**
 * What is missing, and where to fix it (#74).
 *
 * Each check is a predicate on the view its list page reads, and a link to
 * that list with the filter that selects the same rows. The predicate is
 * written the way buildWhere in crud.js turns the link's filter into SQL, so
 * the count on the page and the length of the list it opens always agree.
 * A check whose rows no list can filter to does not belong here.
 *
 * Read-only. Checks on the same view share one statement, and the
 * statements run together, so the page is one request and a handful of
 * COUNT(*) FILTER scans however many checks it grows.
 */
export const CHECKS = [
  {
    key: 'quotations_without_value',
    label: 'Quotations with no value',
    from: 'v_quotations',
    where: 'quotation_value IS NULL',
    link: '/quotations?quotation_value=__none__',
  },
  {
    key: 'quotations_without_sales_person',
    label: 'Quotations with no sales person',
    from: 'v_quotations',
    // sales_person is a normalized filter: blank counts as not set.
    where: `NULLIF(btrim(sales_person), '') IS NULL`,
    link: '/quotations?sales_person=__none__',
  },
  {
    key: 'quotations_without_sector',
    label: 'Quotations with no sector',
    from: 'v_quotations',
    where: `NULLIF(btrim(sector), '') IS NULL`,
    link: '/quotations?sector=__none__',
  },
  {
    key: 'projects_without_sales_person',
    label: 'Projects with no sales person',
    from: 'v_projects',
    where: 'sales_person IS NULL',
    link: '/projects?sales_person=__none__',
  },
  {
    key: 'purchase_orders_without_quotation',
    label: 'Purchase orders with no linked quotation',
    from: 'v_purchase_orders',
    where: 'quotation_no IS NULL',
    link: '/purchase-orders?quotation_no=__none__',
  },
  {
    key: 'vendor_invoices_without_amount',
    label: 'Vendor invoices with no amount',
    from: 'v_travel_vendor_invoices',
    // The view's own name for an invoice number with no amount.
    where: `payment_status = 'Enter amount'`,
    link: '/vendor-invoices?payment_status=Enter%20amount',
  },
  {
    key: 'payment_stages_without_document',
    label: 'Invoiced payment stages with no invoice document',
    from: 'v_payment_stages',
    where: 'invoice_no IS NOT NULL AND document_id IS NULL',
    link: '/payment-stages?invoice_no=__any__&document_id=__none__',
  },
  {
    key: 'companies_without_contact',
    label: 'Companies with no contact',
    from: 'v_companies',
    where: 'contacts = 0',
    link: '/companies?contacts=0',
  },
  // The check above passes a company whose only contact is a name — which is
  // every contact the enquiry and quotation forms used to make. So a client
  // nothing could be sent to read as healthy (client-data-gaps.md, gap 2).
  {
    key: 'companies_without_contact_email',
    label: 'Companies whose contacts have no email',
    from: 'v_companies',
    where: 'contacts_all_without_email = 1',
    link: '/companies?contacts_all_without_email=1',
  },
  // Who a payment chaser is addressed to. With none marked, reminders fall
  // back to whichever contact was created first, which can be the client's
  // technical lead (gap 5).
  {
    key: 'clients_without_billing_contact',
    label: 'Clients with a purchase order but no billing contact with an email',
    from: 'v_companies',
    where: 'needs_billing_contact = 1',
    link: '/companies?needs_billing_contact=1',
  },
  // The quotation cannot be sent and the acceptance link cannot go out.
  //
  // Only deals that name somebody. A quotation with no contact at all is a
  // different question with a different answer — "who is this deal with?"
  // rather than "what is their address?" — and counting both here would
  // give one number nobody can act on.
  {
    key: 'open_quotations_without_contact_email',
    label: 'Open quotations that name a contact with no email',
    from: 'v_quotations',
    where: `stage_type = 'open' AND NULLIF(btrim(contact_person), '') IS NOT NULL AND NULLIF(btrim(contact_email), '') IS NULL`,
    link: '/quotations?stage_type=open&contact_person=__any__&contact_email=__none__',
  },
];

/** Every check, in CHECKS order, as `{ key, label, count, link }`. */
export async function dataQuality() {
  const views = [...new Set(CHECKS.map((check) => check.from))];
  const counted = await Promise.all(views.map(async (view) => {
    const checks = CHECKS.filter((check) => check.from === view);
    const { rows } = await query(
      `SELECT ${checks.map((check, i) => `COUNT(*) FILTER (WHERE ${check.where})::int AS c${i}`).join(', ')}
       FROM ${view}`
    );
    return checks.map((check, i) => [check.key, rows[0][`c${i}`]]);
  }));
  const counts = new Map(counted.flat());
  return CHECKS.map(({ key, label, link }) => ({ key, label, count: counts.get(key), link }));
}
