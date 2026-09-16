/**
 * Every status the app stores, written down once.
 *
 * These strings are compared against the CHECK constraints in db/schema.sql
 * and are interpolated into report SQL, so they must stay byte-identical to
 * what is in the database. Nothing here is computed, and this module imports
 * nothing, so any part of the app can read it without pulling in the
 * resource registry.
 */

export const QUOTATION_STATUS = {
  submitted: 'Submitted',
  negotiating: 'Under Negotiation',
  onHold: 'On Hold',
  won: 'Won - PO Received',
  lost: 'Lost',
};

export const ENQUIRY_STATUS = {
  open: 'In Progress',
  declined: 'Declined',
  quoted: 'Won - Quotation Sent',
};

/**
 * The values each status column accepts, in the order the forms offer them.
 * A report that lists statuses in its own reading order keeps its own list.
 */
export const STATUS = {
  enquiry: [ENQUIRY_STATUS.open, ENQUIRY_STATUS.declined, ENQUIRY_STATUS.quoted],
  quotation: [
    QUOTATION_STATUS.submitted, QUOTATION_STATUS.negotiating, QUOTATION_STATUS.won,
    QUOTATION_STATUS.lost, QUOTATION_STATUS.onHold,
  ],
  trigger: ['On PO Registration', 'On Delivery', 'Manual'],
  unit: ['engagement', 'site', 'day', 'audit', 'report', 'year'],
  onboarding: ['Not Started', 'In Progress', 'Done', 'N/A'],
  approval: ['Submitted', 'Approved', 'Rejected', 'On Hold'],
  currency: ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD'],
};
