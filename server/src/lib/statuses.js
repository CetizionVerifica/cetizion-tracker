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

// A payment stage's status. Not stored: v_payment_stages works it out
// (db/views.sql), so these must match the labels that view produces.
export const STAGE_STATUS = {
  notDue: 'Not Due',
  toInvoice: 'To Invoice',
  paid: 'Paid',
  overdue: 'Overdue',
  partiallyPaid: 'Partially Paid',
  due: 'Due',
};

// Since #24 an enquiry is a lead: several open statuses, Unqualified
// instead of Declined, Converted once quoted.
export const ENQUIRY_STATUS = {
  open: ['New', 'Contacted', 'Qualified', 'Nurture'],
  declined: 'Unqualified',
  quoted: 'Converted',
};

// The enquiry statuses before #24, still sent by older clients and scripts;
// the migration renamed the stored values the same way.
export const LEGACY_ENQUIRY_STATUS = {
  'In Progress': 'Contacted',
  Declined: 'Unqualified',
  'Won - Quotation Sent': ENQUIRY_STATUS.quoted,
};

/**
 * The values each status column accepts, in the order the forms offer them.
 * A report that lists statuses in its own reading order keeps its own list.
 */
export const STATUS = {
  enquiry: [...ENQUIRY_STATUS.open, ENQUIRY_STATUS.quoted, ENQUIRY_STATUS.declined],
  quotation: [
    QUOTATION_STATUS.submitted, QUOTATION_STATUS.negotiating, QUOTATION_STATUS.won,
    QUOTATION_STATUS.lost, QUOTATION_STATUS.onHold,
  ],
  trigger: ['On PO Registration', 'On Delivery', 'On Milestone', 'Manual'],
  onboarding: ['Not Started', 'In Progress', 'Done', 'N/A'],
  approval: ['Submitted', 'Approved', 'Rejected', 'On Hold'],
  currency: ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD'],
  unit: ['engagement', 'site', 'day', 'audit', 'report', 'year'],
};
