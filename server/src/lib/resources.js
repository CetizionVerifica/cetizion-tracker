import { z } from 'zod';
import { saveEnquiry } from './enquiries.js';
import { saveProject } from './projects.js';
import { linkPurchaseOrder } from './purchaseOrders.js';
import { REPORT_LIST_KEYS, reportListClauses, saveSectorAlias, saveServiceReportLine } from './reportDefinitions.js';
import { LEGACY_ENQUIRY_STATUS, STATUS } from './statuses.js';
import { assertEmailLooksReal, contactDetailsFrom, saveContactDetails } from './clientContacts.js';
import { ApiError } from '../middleware/error.js';

/** The records the HR role files documents against (#196). */
const HR_ATTACHMENT_ENTITIES = ['travel_log', 'travel_vendor_invoice'];
/** What a travel file is (#196 §4.6). */
export const TRAVEL_DOC_TYPES = ['ticket', 'boarding_pass', 'vendor_invoice', 'credit_note', 'hotel_bill', 'visa', 'travel_approval', 'other'];

// ---------------------------------------------------------------------
// Field helpers
//
// Forms post empty strings for untouched inputs; every optional field
// therefore coerces '' to null so the column stays genuinely empty
// instead of holding a blank string.
// ---------------------------------------------------------------------

const blankToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);

const str = (max = 255) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());

const requiredStr = (max = 255) =>
  z.preprocess(
    blankToNull,
    z
      .string({ error: 'Required' })
      .trim()
      .min(1, 'Required')
      .max(max, `Keep this under ${max} characters`)
  );

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const date = () =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .regex(DATE_PATTERN, 'Use YYYY-MM-DD')
      .nullable()
      .optional()
  );

const toNumber = (v) => {
  const cleaned = blankToNull(v);
  if (cleaned === null || cleaned === undefined) return cleaned;
  const n = typeof cleaned === 'string' ? Number(cleaned.replace(/,/g, '')) : cleaned;
  return Number.isNaN(n) ? cleaned : n;
};

const bounded = (schema, { min, max }) => {
  let s = schema;
  if (min !== undefined) s = s.min(min, `Must be at least ${min}`);
  if (max !== undefined) s = s.max(max, `Must be at most ${max}`);
  return s;
};

const num = ({ min, max } = {}) =>
  z.preprocess(toNumber, bounded(z.number({ error: 'Enter a number' }), { min, max }).nullable().optional());

/**
 * A number or a date the caller must actually supply.
 *
 * These are not `num()`/`date()` with a "is it there?" refinement on top,
 * which is what they were until zod 4: a refinement wrapped around an
 * optional field never runs when the key is absent, so the check quietly
 * stopped happening and an exchange rate could be saved with no rate and
 * no date at all. Being required has to belong to the field's own type.
 */
const requiredNum = ({ min, max } = {}) =>
  z.preprocess(toNumber, bounded(z.number({ error: 'Required' }), { min, max }));

const requiredDate = () =>
  z.preprocess(blankToNull, z.string({ error: 'Required' }).regex(DATE_PATTERN, 'Use YYYY-MM-DD'));

const int = (opts) => num(opts).transform((v) => (v === null || v === undefined ? v : Math.round(v)));
const requiredInt = (opts) => requiredNum(opts).transform((v) => Math.round(v));

const bool = () =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : blankToNull(v)),
    z.boolean().nullable().optional()
  );

const enumOf = (values) => z.enum(values);

// Defined in statuses.js, which the report modules read without pulling in
// this registry. Re-exported here because the routes import them from here.
export { LEGACY_ENQUIRY_STATUS, STATUS };

// ---------------------------------------------------------------------
// Resource registry
//
// Each entry drives a full REST router: list (served from the computed
// view so the client always sees live totals), read, create, update and
// delete against the base table.
// ---------------------------------------------------------------------

/** An admin saving a client document note approves it (docs/email-po-invoice-prompt-plan.md §6). */
async function approveProfile(client, { after }) {
  await client.query(`UPDATE company_document_profiles SET approved_at = now(), approved_by = COALESCE(approved_by, 'an admin, in Settings') WHERE id = $1`, [after.id]);
}

/**
 * A quotation had no onSave. It needs one now only to put the contact's
 * email and phone where they live — on the contact the trigger linked.
 */
async function saveQuotationContact(client, { after, input }) {
  assertEmailLooksReal(input.contact_email);
  const saved = await saveContactDetails(client, after.contact_id, contactDetailsFrom(input));
  return saved ? { contact: saved } : undefined;
}

export const resources = {
  companies: {
    // Shared master data: every quotation, enquiry and project that ever
    // named this client points at it, and the link trigger creates one on
    // its own the first time somebody types a new name. Anybody may add and
    // correct; only an admin may delete.
    adminOnlyDeletes: true,
    table: 'companies',
    view: 'v_companies',
    label: 'Company',
    defaultSort: 'name',
    search: ['name', 'sector', 'city', 'gstin'],
    filters: ['sector', 'city', 'contacts', 'contacts_all_without_email', 'needs_billing_contact'],
    normalizedFilters: ['sector', 'city'],
    columns: ['name', 'sector', 'gstin', 'website', 'address', 'city', 'notes'],
    schema: z.object({
      name: requiredStr(200),
      sector: str(120),
      gstin: str(20),
      website: str(200),
      address: str(500),
      city: str(120),
      notes: str(2000),
    }),
  },

  contacts: {
    // Shared master data, for the same reasons as companies above, and
    // created the same way — by the trigger, from a name on a record.
    adminOnlyDeletes: true,
    table: 'contacts',
    view: null,
    label: 'Contact',
    defaultSort: 'name',
    search: ['name', 'email', 'phone', 'role'],
    filters: ['company_id', 'is_billing'],
    columns: ['company_id', 'name', 'email', 'phone', 'role', 'is_billing', 'opt_out_reminders', 'notes', 'whatsapp_number', 'preferred_channel', 'best_time_to_call', 'do_not_contact', 'whatsapp_opt_in_at', 'whatsapp_opt_in_source'],
    schema: z.object({
      company_id: int({ min: 1 }),
      name: requiredStr(160),
      email: str(160),
      phone: str(40),
      role: str(120),
      is_billing: bool(),
      opt_out_reminders: bool(),
      notes: str(1000),
      whatsapp_number: str(40),
      preferred_channel: z.preprocess(blankToNull, z.enum(['email', 'call', 'whatsapp', 'meeting']).nullable().optional()),
      best_time_to_call: str(120),
      do_not_contact: bool(),
      whatsapp_opt_in_at: date(),
      whatsapp_opt_in_source: str(120),
    }),
  },

  enquiries: {
    table: 'enquiries',
    // Row-level ownership applies (#18 Phase 2C): a sales user reaches only
    // the rows they own, and an unowned row is admin-only. Declared here so
    // the policy is visible beside the resource rather than hidden in crud.js.
    ownerScoped: true,
    filterAliases: { status: LEGACY_ENQUIRY_STATUS },
    // The table plus the linked contact's email and phone, so the form can
    // show the address it is about to change (client-data-gaps.md, gap 1).
    view: 'v_enquiries',
    label: 'Enquiry',
    naturalKey: 'enquiry_no',
    // enquiry_no is assigned on create (CTZ/ENQ/2026/004) and never changed.
    autoId: 'enquiry',
    // The year in the generated number comes from the enquiry's own date.
    autoIdDateField: 'enquiry_date',
    defaultSort: 'enquiry_date DESC NULLS LAST, id DESC',
    search: ['enquiry_no', 'client_name', 'contact_person', 'service', 'sector', 'country', 'source', 'sales_person', 'quotation_no'],
    filters: ['status', 'sales_person', 'client_name', 'sector', 'country', 'source', 'company_id', 'source_id'],
    normalizedFilters: ['sales_person', 'client_name', 'sector'],
    dateFilter: 'enquiry_date',
    // Insights' filters (?risk=, ?owner=) and the records behind a Reports
    // chart (?report_from=&report_outcome=…), each worked out by its own rules.
    listClauses: async (q, ctx) => [...await enquiryListClauses(q, ctx), ...fromEmailClause('enquiries', q), ...await reportListClauses('enquiries', q, ctx)],
    computedFilters: ['risk', 'owner', 'from_email', ...REPORT_LIST_KEYS],
    // quotation_no links a quotation that already exists; left blank, a won
    // enquiry creates one (quoteWonEnquiry).
    columns: [
      'enquiry_no', 'enquiry_date', 'client_name', 'source', 'sector',
      'country', 'contact_person', 'sales_person', 'sales_person_email', 'service',
      'status', 'quotation_no', 'source_id', 'estimated_value', 'currency',
      'expected_decision_date', 'next_follow_up_at', 'unqualified_reason_id', 'unqualified_notes', 'services_interested',
      'notes',
    ],
    schema: z.object({
      enquiry_no: str(60),
      enquiry_date: date(),
      client_name: requiredStr(160),
      source: str(120),
      sector: str(120),
      country: str(120),
      contact_person: str(120),
      sales_person: str(120),
      sales_person_email: str(160),
      service: str(300),
      status: z.preprocess((v) => LEGACY_ENQUIRY_STATUS[v] ?? v, enumOf(STATUS.enquiry)).default('New'),
      quotation_no: str(60),
      source_id: int({ min: 1 }),
      estimated_value: num({ min: 0 }),
      currency: enumOf(STATUS.currency).default('INR'),
      expected_decision_date: date(),
      next_follow_up_at: date(),
      unqualified_reason_id: int({ min: 1 }),
      unqualified_notes: str(1000),
      services_interested: str(500),
      notes: str(2000),
      // Not columns of enquiries — they belong to the linked contact, and
      // onSave writes them there. Same route projects take for quotation_no.
      contact_email: str(160),
      contact_phone: str(40),
    }),
    onSave: saveEnquiry,
  },

  quotations: {
    table: 'quotations',
    // Row-level ownership applies (#18 Phase 2C): a sales user reaches only
    // the rows they own, and an unowned row is admin-only. Declared here so
    // the policy is visible beside the resource rather than hidden in crud.js.
    ownerScoped: true,
    view: 'v_quotations',
    label: 'Quotation',
    hasDocument: true,
    naturalKey: 'quotation_no',
    // quotation_no is assigned on create (CTZ/QT/2026/064) and never changed.
    autoId: 'quotation',
    // The year in the generated number comes from the quotation's own date.
    autoIdDateField: 'quotation_date',
    defaultSort: 'quotation_date DESC NULLS LAST, id DESC',
    search: ['quotation_no', 'printed_no', 'client_name', 'contact_person', 'service_quoted', 'sector', 'country', 'sales_person'],
    filters: ['status', 'sales_person', 'project_id', 'client_name', 'sector', 'country', 'payment_status', 'company_id', 'stage_id', 'lost_reason_id', 'quotation_value', 'contact_email', 'contact_person', 'stage_type'],
    normalizedFilters: ['sales_person', 'client_name', 'sector'],
    dateFilter: 'quotation_date',
    // Insights opens this list on what it counted (docs/insights-dashboard-plan.md §5.3).
    listClauses: async (q, ctx) => [...await quotationListClauses(q, ctx), ...fromEmailClause('quotations', q)],
    computedFilters: ['follow_up', 'overdue_days', 'close_month', 'month', 'owner', 'from_email'],
    columns: [
      'quotation_no', 'client_name', 'contact_person', 'service_quoted', 'sector', 'country',
      'sales_person', 'sales_person_email', 'quotation_date', 'quotation_value',
      'currency', 'status', 'po_received', 'project_id', 'remarks', 'document_id',
      'valid_until', 'terms', 'place_of_supply_state', 'printed_no',
      'stage_id', 'probability', 'expected_close_date', 'next_step', 'lost_reason_id', 'lost_notes', 'competitor',
    ],
    schema: z.object({
      quotation_no: str(60),
      client_name: requiredStr(160),
      contact_person: str(120),
      service_quoted: str(300),
      sector: str(120),
      country: str(120),
      sales_person: str(120),
      sales_person_email: str(160),
      quotation_date: date(),
      quotation_value: num({ min: 0 }),
      currency: enumOf(STATUS.currency).default('INR'),
      status: enumOf(STATUS.quotation).default('Submitted'),
      po_received: bool(),
      project_id: str(40),
      remarks: str(1000),
      document_id: int({ min: 1 }),
      valid_until: date(),
      terms: str(4000),
      place_of_supply_state: str(80),
      // The number printed on the PDF we sent, when it is not quotation_no:
      // a client's PO quotes it back (docs/email-auto-entry-plan.md §3.4).
      printed_no: str(60),
      stage_id: int({ min: 1 }),
      probability: int({ min: 0, max: 100 }),
      expected_close_date: date(),
      next_step: str(300),
      lost_reason_id: int({ min: 1 }),
      lost_notes: str(1000),
      competitor: str(160),
      // As on enquiries: the contact's own fields, written by onSave.
      contact_email: str(160),
      contact_phone: str(40),
    }),
    onSave: saveQuotationContact,
  },

  projects: {
    table: 'projects',
    // Row-level ownership applies (#18 Phase 2C): a sales user reaches only
    // the rows they own, and an unowned row is admin-only. Declared here so
    // the policy is visible beside the resource rather than hidden in crud.js.
    ownerScoped: true,
    view: 'v_projects',
    label: 'Project',
    naturalKey: 'project_id',
    // project_id is assigned on create (PRJ-2026-012) and never changed.
    autoId: 'project',
    // planned_start_date drives the year; falls back to the current business year when blank.
    autoIdDateField: 'planned_start_date',
    defaultSort: 'project_id DESC',
    search: ['project_id', 'client_name', 'primary_service', 'project_manager', 'sales_person'],
    filters: ['project_stage', 'payment_status', 'project_manager', 'client_name', 'sales_person', 'company_id'],
    columns: [
      'project_id', 'client_name', 'primary_service', 'project_manager',
      'project_manager_email', 'sales_person', 'planned_start_date',
      'planned_delivery_date', 'percent_complete', 'remarks', 'estimated_cost',
      // CV108: how a trip with no PO finds its project (#196 §4.2b).
      'service_request_no',
    ],
    schema: z.object({
      project_id: str(40),
      service_request_no: str(40),
      client_name: requiredStr(160),
      primary_service: str(300),
      project_manager: str(120),
      project_manager_email: str(160),
      sales_person: str(120),
      planned_start_date: date(),
      planned_delivery_date: date(),
      // The column is NOT NULL; a blank form field means not started.
      percent_complete: num({ min: 0, max: 1 }).transform((v) => v ?? 0),
      remarks: str(1000),
      estimated_cost: num({ min: 0 }),
      // Not a column on projects: the link lives on quotations.project_id and
      // is written by linkProjectQuotation. Declared here so it survives
      // validation and reaches onSave.
      quotation_no: str(60),
      // Not a column either: delivery is recorded on the project's POs, which
      // is where the on-delivery stages read it (#26). v_projects reports it back.
      actual_delivery_date: date(),
    }),
    onSave: saveProject,
  },

  'project-milestones': {
    // A milestone belongs to its project, so the project's owner_user_id
    // decides who may see or move it. Not project_manager: that is a name in
    // a text column, not an identity. Marking a milestone reached makes
    // every stage triggered "On Milestone" billable (views.sql), so this is
    // a write worth gating properly rather than by a name match.
    ownerScopedBy: 'project',
    // What a project has to reach before an On Milestone stage can be
    // invoiced (#26). Reaching one stamps its date on every stage it triggers.
    table: 'project_milestones',
    view: null,
    label: 'Milestone',
    defaultSort: 'sort_order, target_date NULLS LAST, id',
    search: ['name', 'project_id'],
    filters: ['project_id'],
    columns: ['project_id', 'name', 'target_date', 'reached_on', 'sort_order'],
    schema: z.object({
      project_id: requiredStr(40),
      name: requiredStr(160),
      target_date: date(),
      reached_on: date(),
      sort_order: int({ min: 0 }).default(0),
    }),
    // Scoped to the project's own people (#26, and the review of #115).
    //
    // This is a money control, not a tidiness one. Marking a milestone
    // reached stamps milestone_reached_on on every payment stage pointing
    // at it, and a stage triggered "On Milestone" is ready to invoice the
    // moment that is not null — so an open PATCH here let any signed-in
    // user move another project into the invoice run, the cash-flow
    // forecast and the ageing.
  },

  'purchase-orders': {
    // Ownership is not this row's own — it belongs to the record above it
    // (#18 Phase 2C). A sales user reaches it only through a quotation or
    // project they own; an unreachable parent means unknown ownership, which
    // is admin-only.
    ownerScopedBy: 'purchase_order',
    // A financial record. The PO value is what every billing figure — Due
    // now, To bill, project profitability — is computed against, and
    // deleting one takes its services and payment stages with it. Entering
    // and correcting POs is ordinary sales work; removing one is not.
    adminOnlyDeletes: true,
    table: 'purchase_orders',
    view: 'v_purchase_orders',
    label: 'Purchase order',
    hasDocument: true,
    // Deleting a PO deletes its payment stages, and with them their invoice documents.
    cascadeDocuments: { sql: 'SELECT document_id FROM payment_stages WHERE po_number = $1 FOR UPDATE', key: 'po_number' },
    naturalKey: 'po_number',
    defaultSort: 'po_date DESC NULLS LAST, id DESC',
    search: ['po_number', 'project_id', 'client_name', 'quotation_no'],
    filters: ['project_id', 'payment_status', 'client_name', 'quotation_no', 'company_id'],
    dateFilter: 'po_date',
    // ?live=1: not cancelled and not replaced by a revision, the POs the
    // sales figures and Insights count (docs/insights-dashboard-plan.md §5.3).
    // And the records behind a Reports chart (?report_from=&report_sector=…),
    // picked by the report's own rules, so the list holds what the bar counted.
    // ?from_email=1: POs registered automatically from a client's email.
    listClauses: async (q, ctx) => [
      ...(String(q.live ?? '') === '1' ? ['NOT cancelled AND replaced_by_po_number IS NULL'] : []),
      ...fromEmailClause('purchase-orders', q),
      ...await reportListClauses('pos', q, ctx),
    ],
    computedFilters: ['live', 'from_email', ...REPORT_LIST_KEYS],
    // quotation_no: the won quotation this PO fulfils (linkPurchaseOrder).
    columns: [
      'po_number', 'project_id', 'quotation_no', 'po_date', 'po_value', 'currency',
      'payment_terms_days', 'actual_initiation_date', 'actual_delivery_date',
      'project_manager_email', 'remarks', 'document_id',
      // Revised or cancelled — out of the sales figures (linkPurchaseOrder checks the link).
      'replaces_po_number', 'cancelled',
      'client_vendor_code',
    ],
    schema: z.object({
      po_number: requiredStr(60),
      project_id: requiredStr(40),
      po_date: date(),
      po_value: num({ min: 0 }).default(0),
      currency: enumOf(STATUS.currency).default('INR'),
      payment_terms_days: int({ min: 0, max: 365 }).default(30),
      actual_initiation_date: date(),
      actual_delivery_date: date(),
      project_manager_email: str(160),
      remarks: str(1000),
      document_id: int({ min: 1 }),
      quotation_no: str(60),
      replaces_po_number: str(60),
      // Our supplier code at the client, which its accounts ask for on invoices.
      client_vendor_code: str(40),
      // NOT NULL in the table: blank means "not cancelled". An edit that does
      // not send it leaves it alone (crud writes only the fields sent).
      cancelled: bool().transform((v) => v ?? false),
    }),
    onSave: linkPurchaseOrder,
  },

  'po-services': {
    // Ownership is not this row's own — it belongs to the record above it
    // (#18 Phase 2C). A sales user reaches it only through a quotation or
    // project they own; an unreachable parent means unknown ownership, which
    // is admin-only.
    ownerScopedBy: 'via_po',
    // The lines a PO's value is made of, so deleting one silently changes
    // what the project is worth. Admin-only to delete, like the PO itself.
    adminOnlyDeletes: true,
    table: 'po_services',
    view: null,
    label: 'PO service line',
    defaultSort: 'id',
    search: ['po_number', 'service'],
    filters: ['po_number'],
    columns: ['po_number', 'service', 'service_value', 'remarks'],
    schema: z.object({
      po_number: requiredStr(60),
      service: requiredStr(300),
      service_value: num({ min: 0 }),
      remarks: str(1000),
    }),
  },

  'payment-stages': {
    // Ownership is not this row's own — it belongs to the record above it
    // (#18 Phase 2C). A sales user reaches it only through a quotation or
    // project they own; an unreachable parent means unknown ownership, which
    // is admin-only.
    ownerScopedBy: 'via_po',
    // The invoicing schedule: what has been raised, what is due and what has
    // been paid. A deleted stage is an invoice the tracker stops accounting
    // for. Sales users raise and record against stages as usual; only an
    // admin removes one.
    adminOnlyDeletes: true,
    table: 'payment_stages',
    view: 'v_payment_stages',
    label: 'Payment stage',
    computedFilters: ['from_past_po', 'from_email'],
    listClauses: async (q) => [...fromPastPoClause(q), ...fromEmailClause('payment-stages', q)],
    // The invoice document: replaced on edit, deleted from Cloudinary with the stage.
    hasDocument: true,
    defaultSort: 'po_number, stage_no',
    search: ['po_number', 'stage_name', 'invoice_no', 'client_name', 'project_id'],
    filters: ['po_number', 'project_id', 'stage_status', 'trigger_event', 'client_name', 'invoice_no', 'document_id'],
    columns: [
      'po_number', 'stage_no', 'stage_name', 'trigger_event', 'stage_percent',
      'invoice_no', 'invoice_date', 'amount_received', 'payment_received_date',
      'reminder_sent_on', 'remarks', 'document_id', 'credit_days', 'milestone_name', 'milestone_reached_on', 'milestone_id',
    ],
    schema: z.object({
      po_number: requiredStr(60),
      stage_no: int({ min: 1 }),
      stage_name: requiredStr(120),
      trigger_event: enumOf(STATUS.trigger).default('On PO Registration'),
      stage_percent: num({ min: 0.0001, max: 1 }),
      invoice_no: str(60),
      invoice_date: date(),
      amount_received: num({ min: 0 }).default(0),
      payment_received_date: date(),
      reminder_sent_on: date(),
      document_id: int({ min: 1 }),
      remarks: str(1000),
      credit_days: int({ min: 0, max: 365 }),
      milestone_name: str(160),
      milestone_reached_on: date(),
      milestone_id: int({ min: 1 }),
    }),
  },

  onboarding: {
    table: 'onboarding_tasks',
    view: null,
    label: 'Onboarding step',
    defaultSort: 'project_id, step_no',
    search: ['project_id', 'step', 'owner'],
    filters: ['project_id', 'status', 'stage', 'owner'],
    columns: [
      'project_id', 'step_no', 'stage', 'step', 'owner', 'owner_email',
      'target_date', 'status', 'completed_date', 'remarks',
    ],
    schema: z.object({
      project_id: requiredStr(40),
      step_no: requiredInt({ min: 1 }),
      stage: str(60),
      step: requiredStr(400),
      owner: str(120),
      owner_email: str(160),
      target_date: date(),
      status: enumOf(STATUS.onboarding).default('Not Started'),
      completed_date: date(),
      remarks: str(1000),
    }),
  },

  'travel-logs': {
    table: 'travel_logs',
    view: 'v_travel_logs',
    label: 'Trip',
    naturalKey: 'travel_id',
    defaultSort: 'travel_start_date DESC NULLS LAST, id DESC',
    search: ['travel_id', 'employee_name', 'destination', 'po_number', 'client_name', 'origin'],
    filters: ['po_number', 'project_id', 'arranged_by', 'vendor_invoice_status', 'reimbursement_status', 'employee_name',
      'trip_type_id', 'vendor_id', 'staff_id', 'cancelled', 'chargeable'],
    columns: [
      'travel_id', 'po_number', 'service_delivered', 'employee_name',
      'employee_email', 'purpose', 'destination', 'travel_start_date',
      'travel_end_date', 'arranged_by', 'hr_owner', 'hr_owner_email', 'remarks',
      // The travel desk's fields (#196 §4.2).
      'vendor_id', 'project_id', 'staff_id', 'trip_type_id', 'origin', 'booking_date', 'cancelled', 'billed_stage_id', 'client_label',
    ],
    schema: z.object({
      travel_id: requiredStr(40),
      po_number: str(60),
      service_delivered: str(300),
      employee_name: requiredStr(160),
      employee_email: str(160),
      purpose: str(400),
      destination: str(160),
      travel_start_date: date(),
      travel_end_date: date(),
      arranged_by: str(120),
      hr_owner: str(120),
      hr_owner_email: str(160),
      remarks: str(1000),
      vendor_id: int({ min: 1 }),
      // A project when there is no PO; with a PO it must be the PO's (a trigger says so).
      project_id: str(40),
      staff_id: int({ min: 1 }),
      // Left out, the trip is Chargeable with a PO or project and Non-chargeable without.
      trip_type_id: int({ min: 1 }),
      origin: str(160),
      booking_date: date(),
      cancelled: bool(),
      // The payment stage whose invoice billed this trip to the client; chargeable trips only.
      billed_stage_id: int({ min: 1 }),
      client_label: str(160),
    }),
  },

  'vendor-invoices': {
    // What has actually been paid is recorded by POST /vendor-invoices/:id/pay,
    // which validates the figure and writes an audit row naming the account
    // that recorded it (#85). Both roles may pay a vendor invoice — that is
    // the agreed rule — so the gate here is not about who, it is about which
    // door: a payment entered through the ordinary edit form would land with
    // none of that. Everything else on the invoice stays editable by anyone.
    protectedFields: ['amount_paid', 'payment_date'],
    table: 'travel_vendor_invoices',
    view: 'v_travel_vendor_invoices',
    label: 'Vendor invoice',
    naturalKey: 'vendor_invoice_id',
    defaultSort: 'invoice_date DESC NULLS FIRST, id DESC',
    search: ['vendor_invoice_id', 'travel_id', 'vendor_invoice_no', 'travel_vendor', 'employee_name'],
    filters: ['travel_id', 'payment_status', 'travel_vendor', 'project_id', 'vendor_id'],
    // The invoice PDF (#196 §4.4).
    hasDocument: true,
    columns: [
      'vendor_invoice_id', 'travel_id', 'vendor_invoice_no', 'invoice_date',
      'invoice_amount', 'payment_terms_days', 'amount_paid', 'payment_date', 'remarks',
      'vendor_id', 'document_id', 'vendor_gstin_on_invoice', 'place_of_supply',
    ],
    schema: z.object({
      vendor_invoice_id: requiredStr(60),
      // One trip, the old way: the invoice gets one line for it. An invoice
      // covering several trips leaves this blank and has lines (#196).
      travel_id: str(40),
      vendor_id: int({ min: 1 }),
      document_id: int({ min: 1 }),
      vendor_gstin_on_invoice: str(20),
      place_of_supply: str(80),
      vendor_invoice_no: str(60),
      invoice_date: date(),
      invoice_amount: num({ min: 0 }),
      payment_terms_days: int({ min: 0, max: 365 }).default(30),
      amount_paid: num({ min: 0 }).default(0),
      payment_date: date(),
      remarks: str(1000),
    }),
  },

  'expense-claims': {
    // Submitting a claim is ordinary work and stays open to everyone. Deciding
    // one and reimbursing it are not: they are what turn a claim into money,
    // and they belong to POST /expense-claims/:id/decide and /reimburse, which
    // are admin-only, validated and audited (#85).
    //
    // Listing the four fields here is what makes that real. Without it the
    // generic form is a second, unguarded route to the same columns: a sales
    // user could create a claim already marked Approved, name anybody as its
    // approver, and write in what they had been paid. The gate is on the
    // fields rather than on the resource because the rest of a claim — the
    // amount, the category, the month, the remarks — is the claimant's own to
    // enter and correct.
    //
    // Admins are held to it too. An administrator editing these figures
    // through the ordinary form would skip the approval check, the cumulative
    // arithmetic and the audit row just as surely; POST /expense-claims/:id/correct
    // is the deliberate, recorded way to put a wrong figure right.
    protectedFields: ['approval_status', 'approved_by', 'amount_reimbursed', 'reimbursement_date'],
    table: 'employee_expense_claims',
    view: 'v_employee_expense_claims',
    label: 'Expense claim',
    naturalKey: 'claim_id',
    defaultSort: 'submission_date DESC NULLS LAST, id DESC',
    search: ['claim_id', 'travel_id', 'employee_name', 'expense_category'],
    filters: ['travel_id', 'approval_status', 'status', 'employee_name', 'claim_month', 'project_id'],
    columns: [
      'claim_id', 'travel_id', 'expense_category', 'claim_month',
      'amount_claimed', 'submission_date', 'approval_status', 'approved_by',
      'amount_reimbursed', 'reimbursement_date', 'remarks',
    ],
    schema: z.object({
      claim_id: requiredStr(60),
      travel_id: requiredStr(40),
      expense_category: str(120),
      claim_month: str(20),
      amount_claimed: num({ min: 0 }).default(0),
      submission_date: date(),
      approval_status: enumOf(STATUS.approval).default('Submitted'),
      approved_by: str(120),
      amount_reimbursed: num({ min: 0 }).default(0),
      reimbursement_date: date(),
      remarks: str(1000),
    }),
  },

  'pipeline-stages': {
    // The board's own shape: a stage's status mapping and probability rewrite
    // quotation statuses and the whole forecast through c_stage_sync.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'pipeline_stages',
    view: null,
    label: 'Pipeline stage',
    defaultSort: 'sort_order, id',
    search: ['name'],
    filters: ['type', 'active'],
    columns: ['name', 'probability', 'type', 'maps_to_status', 'sort_order', 'color', 'rotting_days', 'active'],
    schema: z.object({
      name: requiredStr(80),
      probability: requiredInt({ min: 0, max: 100 }),
      type: enumOf(['open', 'paused', 'won', 'lost']).default('open'),
      maps_to_status: enumOf(STATUS.quotation).default('Submitted'),
      sort_order: int().default(0),
      color: str(20),
      rotting_days: int({ min: 1, max: 365 }),
      active: bool(),
    }),
  },

  engagements: {
    table: 'engagements',
    view: null,
    label: 'Engagement',
    defaultSort: 'next_due_on',
    search: ['client_name', 'service_name', 'po_number'],
    filters: ['status', 'company_id', 'owner'],
    columns: ['client_name', 'service_name', 'valid_until', 'next_due_on', 'status', 'owner', 'notes'],
    schema: z.object({
      client_name: requiredStr(160),
      service_name: requiredStr(300),
      valid_until: date(),
      next_due_on: requiredDate(),
      status: enumOf(['active', 'renewal_open', 'renewed', 'lapsed', 'cancelled']).default('active'),
      owner: str(120),
      notes: str(2000),
    }),
  },

  payments: {
    // What has actually been received. payment_stages.amount_received is
    // computed from these rows by trigger, so a deleted or re-pointed
    // payment silently moves Due now, Collections and the forecast.
    // Recording a receipt is ordinary work and goes through
    // POST /payment-stages/:id/payment; editing the ledger by hand is not.
    adminOnlyWrites: true,
    // Ownership is not this row's own — it belongs to the record above it
    // (#18 Phase 2C), reached through a declared foreign key. An unreachable
    // parent means unknown ownership, which is admin-only.
    ownerScopedBy: 'via_stage',
    table: 'payments',
    view: null,
    label: 'Payment',
    defaultSort: 'received_on DESC, id DESC',
    search: ['reference', 'notes'],
    filters: ['stage_id', 'mode'],
    columns: ['stage_id', 'amount', 'tds_amount', 'received_on', 'mode', 'reference', 'notes', 'recorded_by'],
    schema: z.object({
      stage_id: requiredInt({ min: 1 }),
      amount: requiredNum({ min: 0 }),
      tds_amount: num({ min: 0 }).default(0),
      received_on: date(),
      mode: enumOf(['bank_transfer', 'cheque', 'upi', 'cash', 'other']).default('bank_transfer'),
      reference: str(120),
      notes: str(1000),
      recorded_by: str(120),
    }),
  },

  tasks: {
    // Ownership is not this row's own — it belongs to the record it is filed
    // against (#18 Phase 2C), named as (entity, entity_id) text. A company
    // or a contact is shared, so those stay open; the five sales records
    // carry their owner's reach, and an unreachable parent means unknown
    // ownership, which is admin-only.
    // A task reaches its owner through the record it is filed against, and
    // through any other record it stands on (task_targets, #22). Being the
    // assignee or the author is deliberately NOT a way in: that would let a
    // task somebody assigned me open a deal that is not mine.
    ownerScopedBy: 'task_entity',
    table: 'tasks',
    stampActor: 'created_by',
    view: null,
    label: 'Task',
    // A sales user sees the tasks on their own records, and any task that is
    // theirs to do or that they set, wherever it sits (#22).
    // The other records the task is on, besides its own (#22). Sent as the
    // whole list: what is not in it is taken off.
    onSave: async (client, { after, input }) => {
      if (!Array.isArray(input.targets)) return undefined;
      await client.query('DELETE FROM task_targets WHERE task_id = $1 AND NOT (entity = $2 AND entity_id = $3)', [after.id, after.entity, after.entity_id]);
      for (const t of input.targets) {
        await client.query('INSERT INTO task_targets (task_id, entity, entity_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [after.id, t.entity, String(t.entity_id)]);
      }
      return undefined;
    },
    defaultSort: 'due_at NULLS LAST, id',
    search: ['title', 'description', 'entity_id', 'assignee'],
    filters: ['entity', 'entity_id', 'status', 'assignee', 'priority', 'type'],
    columns: ['entity', 'entity_id', 'title', 'description', 'due_at', 'status', 'priority', 'type', 'assignee', 'created_by'],
    schema: z.object({
      entity: enumOf(['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']),
      entity_id: requiredStr(120),
      title: requiredStr(300),
      description: str(2000),
      due_at: date(),
      status: enumOf(['todo', 'in_progress', 'done']).default('todo'),
      priority: enumOf(['low', 'normal', 'high']).default('normal'),
      type: enumOf(['call', 'email', 'meeting', 'follow_up', 'document', 'other']).default('follow_up'),
      assignee: str(120),
      created_by: str(120),
      targets: z.array(z.object({ entity: enumOf(['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']), entity_id: requiredStr(120) })).max(20).optional(),
    }),
  },

  notes: {
    // Ownership is not this row's own — it belongs to the record it is filed
    // against (#18 Phase 2C), named as (entity, entity_id) text. A company
    // or a contact is shared, so those stay open; the five sales records
    // carry their owner's reach, and an unreachable parent means unknown
    // ownership, which is admin-only.
    ownerScopedBy: 'entity',
    table: 'notes',
    stampActor: 'author',
    view: null,
    label: 'Note',
    defaultSort: 'pinned DESC, created_at DESC',
    search: ['body'],
    filters: ['entity', 'entity_id'],
    columns: ['entity', 'entity_id', 'body', 'author', 'pinned'],
    schema: z.object({
      entity: enumOf(['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']),
      entity_id: requiredStr(120),
      body: requiredStr(10000),
      author: str(120),
      pinned: bool(),
    }),
  },

  'project-costs': {
    // What a project cost to deliver, and so what it earned. Writing these
    // moves the margin on a deal, so they belong to whoever owns the
    // numbers rather than to whoever sold it.
    adminOnlyWrites: true,
    // Ownership is not this row's own — it belongs to the record above it
    // (#18 Phase 2C), reached through a declared foreign key. An unreachable
    // parent means unknown ownership, which is admin-only.
    ownerScopedBy: 'project',
    table: 'project_costs',
    view: null,
    label: 'Project cost',
    hasDocument: true,
    defaultSort: 'incurred_on DESC NULLS LAST, id DESC',
    search: ['description', 'vendor'],
    filters: ['project_id', 'category', 'status'],
    columns: ['project_id', 'po_number', 'category', 'description', 'vendor', 'amount', 'currency', 'incurred_on', 'status', 'document_id', 'created_by'],
    schema: z.object({
      project_id: requiredStr(40),
      po_number: str(80),
      category: enumOf(['subcontractor', 'auditor_fee', 'certification_body', 'lab_testing', 'travel', 'accommodation', 'materials', 'other']).default('subcontractor'),
      description: requiredStr(300),
      vendor: str(160),
      amount: num({ min: 0 }),
      currency: str(3).transform((v) => (v === undefined ? v : v ? v.toUpperCase() : 'INR')),
      incurred_on: date(),
      status: enumOf(['committed', 'paid']).default('committed'),
      document_id: int({ min: 1 }),
      created_by: str(120),
    }),
  },

  attachments: {
    // Ownership is not this row's own — it belongs to the record it is filed
    // against (#18 Phase 2C), named as (entity, entity_id) text. A company
    // or a contact is shared, so those stay open; the five sales records
    // carry their owner's reach, and an unreachable parent means unknown
    // ownership, which is admin-only.
    ownerScopedBy: 'entity',
    // The HR role reaches the files on trips and travel vendor invoices only (#196).
    hrClause: (col) => `${col}entity IN ('travel_log','travel_vendor_invoice')`,
    authorize: (req, input) => {
      if (req.user?.role === 'hr' && input?.entity !== undefined && !HR_ATTACHMENT_ENTITIES.includes(input.entity)) {
        throw new ApiError(403, 'HR attaches files to trips and travel vendor invoices only');
      }
    },
    table: 'attachments',
    view: null,
    label: 'Attachment',
    hasDocument: true,
    defaultSort: 'created_at DESC',
    search: ['label'],
    filters: ['entity', 'entity_id'],
    columns: ['entity', 'entity_id', 'document_id', 'label', 'uploaded_by', 'doc_type'],
    stampActor: 'uploaded_by',
    schema: z.object({
      entity: enumOf(['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage', 'travel_log', 'travel_vendor_invoice']),
      entity_id: requiredStr(120),
      document_id: requiredInt({ min: 1 }),
      label: str(200),
      uploaded_by: str(120),
      // What the file is, so a trip's files can be checked by kind (#196 §4.6).
      doc_type: enumOf(TRAVEL_DOC_TYPES).nullable().optional(),
    }),
  },

  'payment-terms-templates': {
    // The invoicing schedules every new PO is built from.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'payment_terms_templates',
    view: null,
    label: 'Payment terms template',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active', 'is_default', 'sort_order'],
    schema: z.object({ name: requiredStr(120), active: bool(), is_default: bool(), sort_order: int().default(0) }),
  },

  'payment-terms-template-lines': {
    // The lines those schedules are made of.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'payment_terms_template_lines',
    view: null,
    label: 'Payment terms line',
    defaultSort: 'template_id, sort_order, id',
    search: ['stage_name'],
    filters: ['template_id'],
    columns: ['template_id', 'sort_order', 'stage_name', 'percent', 'trigger_event', 'credit_days', 'milestone_name'],
    schema: z.object({
      template_id: requiredInt({ min: 1 }),
      sort_order: int().default(0),
      stage_name: requiredStr(120),
      percent: requiredNum({ min: 0.01, max: 100 }),
      trigger_event: enumOf(STATUS.trigger).default('On PO Registration'),
      credit_days: int({ min: 0, max: 365 }),
      milestone_name: str(160),
    }),
  },

  'onboarding-templates': {
    // The delivery checklists every new project starts with.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'onboarding_templates',
    view: null,
    label: 'Onboarding template',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active', 'is_default', 'sort_order'],
    schema: z.object({ name: requiredStr(120), active: bool(), is_default: bool(), sort_order: int().default(0) }),
  },

  'onboarding-template-lines': {
    // The steps those checklists are made of.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'onboarding_template_lines',
    view: null,
    label: 'Onboarding template step',
    defaultSort: 'template_id, step_no',
    search: ['step'],
    filters: ['template_id'],
    columns: ['template_id', 'step_no', 'stage', 'step', 'owner_role', 'days_after_start'],
    schema: z.object({
      template_id: requiredInt({ min: 1 }),
      step_no: requiredInt({ min: 1 }),
      stage: str(60),
      step: requiredStr(400),
      owner_role: str(60),
      days_after_start: int({ min: 0, max: 730 }),
    }),
  },

  'lead-sources': {
    // A Settings list. Deleting one blanks it on every enquiry that used it.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'lead_sources',
    view: null,
    label: 'Lead source',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active', 'sort_order'],
    schema: z.object({ name: requiredStr(120), active: bool(), sort_order: int().default(0) }),
  },

  'sector-aliases': {
    // A Settings list (065): a spelling of a sector that the Reports section
    // counts under one of its headline sectors ("Steel" -> Metal Industry).
    // Nothing on a quotation or enquiry changes. Admins curate it.
    adminOnlyWrites: true,
    table: 'sector_aliases',
    view: null,
    label: 'Sector alias',
    defaultSort: 'sector, alias',
    search: ['alias', 'sector'],
    filters: ['sector'],
    columns: ['alias', 'sector'],
    schema: z.object({ alias: requiredStr(120), sector: requiredStr(120) }),
    // The sector must be a headline sector (Settings → Report categories).
    onSave: saveSectorAlias,
  },

  'lost-reasons': {
    // A Settings list. Deleting one blanks it on every lost quotation and
    // unqualified enquiry, through ON DELETE SET NULL.
    // Admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'lost_reasons',
    view: null,
    label: 'Lost reason',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active', 'sort_order'],
    schema: z.object({ name: requiredStr(120), active: bool(), sort_order: int().default(0) }),
  },

  services: {
    // A Settings list: admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'services',
    view: null,
    label: 'Service',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active', 'sort_order', 'code', 'sac_code', 'default_rate', 'currency', 'gst_rate', 'unit', 'description', 'renewal_interval_months', 'renewal_lead_days', 'onboarding_template_id', 'payment_terms_template_id', 'report_line'],
    schema: z.object({
      name: requiredStr(200),
      active: bool(),
      sort_order: int().default(0),
      code: str(30),
      sac_code: str(20),
      default_rate: num({ min: 0 }),
      currency: enumOf(STATUS.currency).default('INR'),
      gst_rate: num({ min: 0, max: 100 }).default(18),
      unit: enumOf(STATUS.unit).default('engagement'),
      description: str(2000),
      renewal_interval_months: int({ min: 1, max: 120 }),
      renewal_lead_days: int({ min: 0, max: 365 }).default(60),
      onboarding_template_id: int({ min: 1 }),
      payment_terms_template_id: int({ min: 1 }),
      // The Reports section's service line (065); blank = matched by name.
      report_line: str(120),
    }),
    // A report line, when set, must be one of the listed service lines.
    onSave: saveServiceReportLine,
  },

  'quotation-lines': {
    // Ownership is not this row's own — it belongs to the record above it
    // (#18 Phase 2C), reached through a declared foreign key. An unreachable
    // parent means unknown ownership, which is admin-only.
    ownerScopedBy: 'quotation',
    table: 'quotation_lines',
    view: null,
    label: 'Quotation line',
    defaultSort: 'sort_order, id',
    search: ['description'],
    filters: ['quotation_id', 'service_id'],
    columns: ['quotation_id', 'service_id', 'description', 'qty', 'unit', 'rate', 'discount_percent', 'gst_rate', 'sort_order'],
    schema: z.object({
      quotation_id: requiredInt({ min: 1 }),
      service_id: int({ min: 1 }),
      description: requiredStr(500),
      qty: num({ min: 0.01 }).default(1),
      unit: str(40),
      rate: num({ min: 0 }).default(0),
      discount_percent: num({ min: 0, max: 100 }).default(0),
      gst_rate: num({ min: 0, max: 100 }).default(18),
      sort_order: int().default(0),
    }),
  },

  'travel-vendors': {
    // A Settings list: admins and the travel desk curate it (#196), everybody reads it.
    adminOnlyWrites: true,
    hrWrites: true,
    table: 'travel_vendors',
    view: null,
    label: 'Travel vendor',
    defaultSort: 'name',
    search: ['name', 'gstin', 'contact_name'],
    filters: ['active'],
    columns: ['name', 'active', 'gstin', 'pan', 'contact_name', 'email', 'phone', 'address', 'payment_terms_days', 'invoice_prefixes'],
    schema: z.object({
      name: requiredStr(160), active: bool(),
      gstin: str(20), pan: str(12), contact_name: str(120), email: str(160), phone: str(40), address: str(400),
      payment_terms_days: int({ min: 0, max: 365 }).default(30),
      // "HT/2627/, HTT/26-27/": how the importer recognises this vendor's invoices.
      invoice_prefixes: z.preprocess(
        (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map((p) => String(p).trim()).filter(Boolean)),
        z.array(z.string().max(40)).max(20).optional(),
      ),
    }),
  },

  'trip-types': {
    // A Settings list (#196 §4.2a): admins and the travel desk keep it, everybody reads it.
    // A type in use cannot be deleted (the trips point at it); make it inactive instead.
    adminOnlyWrites: true,
    hrWrites: true,
    table: 'trip_types',
    view: null,
    label: 'Trip type',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active', 'chargeable'],
    columns: ['name', 'chargeable', 'active', 'sort_order'],
    schema: z.object({ name: requiredStr(80), chargeable: bool(), active: bool().default(true), sort_order: int().default(0) }),
  },

  'travel-segments': {
    // A trip's legs (#196 §4.3): flights, trains, buses, cabs and hotel stays.
    table: 'travel_segments',
    view: 'v_travel_segments',
    label: 'Leg',
    defaultSort: 'travel_id, seq, start_date NULLS LAST, id',
    search: ['travel_id', 'from_place', 'to_place', 'provider', 'pnr_or_ref'],
    filters: ['travel_id', 'mode', 'status'],
    columns: ['travel_id', 'seq', 'mode', 'from_place', 'to_place', 'start_date', 'end_date', 'start_time', 'end_time',
      'provider', 'service_no', 'travel_class', 'pnr_or_ref', 'rooms', 'guests', 'status', 'remarks'],
    schema: z.object({
      travel_id: requiredStr(40),
      seq: int({ min: 1 }).default(1),
      mode: enumOf(['flight', 'train', 'bus', 'cab', 'hotel', 'other']),
      from_place: str(120), to_place: str(120),
      start_date: date(), end_date: date(),
      start_time: z.preprocess(blankToNull, z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'A time, like 14:30').nullable().optional()),
      end_time: z.preprocess(blankToNull, z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'A time, like 14:30').nullable().optional()),
      provider: str(120), service_no: str(40), travel_class: str(60), pnr_or_ref: str(60),
      rooms: int({ min: 1 }), guests: int({ min: 1 }),
      status: enumOf(['booked', 'cancelled', 'partly_refunded']).default('booked'),
      remarks: str(500),
    }),
  },

  'vendor-invoice-lines': {
    // One line per leg billed (#196 §4.4): one travel agency invoice covers
    // several trips and people. The invoice's total follows its lines.
    table: 'travel_vendor_invoice_lines',
    view: 'v_travel_invoice_lines',
    label: 'Vendor invoice line',
    defaultSort: 'vendor_invoice_id, id',
    search: ['travel_id', 'remarks'],
    filters: ['vendor_invoice_id', 'travel_id', 'segment_id'],
    columns: ['vendor_invoice_id', 'travel_id', 'segment_id', 'base_fare', 'service_charge', 'gst_amount', 'gst_rate', 'line_total', 'remarks'],
    schema: z.object({
      vendor_invoice_id: requiredInt({ min: 1 }),
      travel_id: requiredStr(40),
      segment_id: int({ min: 1 }),
      base_fare: num({ min: 0 }), service_charge: num({ min: 0 }), gst_amount: num({ min: 0 }), gst_rate: num({ min: 0, max: 40 }),
      line_total: num({ min: 0 }),
      remarks: str(500),
    }),
  },

  'vendor-credit-notes': {
    // Credit and cancellation notes against a vendor invoice (#196 §4.5).
    // One on a leg marks the leg cancelled or partly refunded.
    table: 'travel_vendor_credit_notes',
    view: null,
    label: 'Credit note',
    hasDocument: true,
    defaultSort: 'credit_note_date DESC NULLS LAST, id DESC',
    search: ['credit_note_no', 'remarks'],
    filters: ['vendor_id', 'against_invoice_id', 'kind', 'segment_id'],
    columns: ['vendor_id', 'credit_note_no', 'credit_note_date', 'against_invoice_id', 'segment_id', 'kind',
      'refund_amount', 'cancellation_charges', 'remarks', 'document_id'],
    schema: z.object({
      vendor_id: requiredInt({ min: 1 }),
      credit_note_no: requiredStr(60),
      credit_note_date: date(),
      against_invoice_id: int({ min: 1 }),
      segment_id: int({ min: 1 }),
      kind: enumOf(['credit_note', 'cancellation_note']).default('credit_note'),
      refund_amount: num({ min: 0 }).default(0),
      cancellation_charges: num({ min: 0 }),
      remarks: str(500),
      document_id: int({ min: 1 }),
    }),
  },

  'expense-categories': {
    // A Settings list: admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'expense_categories',
    view: null,
    label: 'Expense category',
    defaultSort: 'name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active'],
    schema: z.object({ name: requiredStr(160), active: bool() }),
  },

  // INR for one unit of a currency, from a given date. Reports convert every
  // figure at the rate in force on that record's own date, so entering a new
  // rate never changes what an older quotation, PO or invoice was worth.
  'exchange-rates': {
    // A Settings list like the three above, and the one with the most reach:
    // a rate is what every report converts at, so one row decides what every
    // historical deal in every currency is reported to be worth. Admins
    // curate it; everybody reads it, because the same rows drive the figures
    // sales users work from.
    adminOnlyWrites: true,
    table: 'exchange_rates',
    view: null,
    label: 'Exchange rate',
    defaultSort: 'from_currency, effective_from DESC',
    search: ['from_currency', 'note'],
    filters: ['from_currency', 'source'],
    dateFilter: 'effective_from',
    columns: ['from_currency', 'to_currency', 'rate', 'effective_from', 'source', 'entered_by', 'note'],
    schema: z.object({
      from_currency: enumOf(STATUS.currency.filter((c) => c !== 'INR')),
      // INR is the only target: every report figure is an INR figure.
      to_currency: z.literal('INR').default('INR'),
      // numeric(18,6) holds 12 digits before the point; anything larger is a
      // typo, and letting it through turns a bad rate into a 500.
      rate: requiredNum({ min: 0.000001, max: 1000000 }),
      effective_from: requiredDate(),
      source: enumOf(['manual', 'feed']).default('manual'),
      entered_by: str(120),
      note: str(300),
    }),
    // A person correcting an ECB rate in Settings makes that rate theirs. The
    // feed and the backfill only ever replace rows marked 'feed' (lib/fx.ts),
    // and the form does not send `source`, so without this the correction
    // stayed 'feed' and the next backfill silently put the ECB number back.
    onSave: async (client, { before, after }) => {
      if (!before || after.source !== 'feed') return;
      const sameRate = Number(after.rate) === Number(before.rate);
      const sameDay = String(after.effective_from).slice(0, 10) === String(before.effective_from).slice(0, 10);
      if (sameRate && sameDay) return;
      await client.query(`UPDATE exchange_rates SET source = 'manual' WHERE id = $1`, [after.id]);
    },
  },

  'document-profiles': {
    // What is particular about one client's POs or invoices, for the email
    // readers (docs/email-po-invoice-prompt-plan.md §6): a note for the
    // model, the labels it prints, its PO numbers' shape. Saved by an admin,
    // which approves it; a suggested one waits until then.
    adminOnlyWrites: true,
    table: 'company_document_profiles',
    view: 'v_company_document_profiles',
    label: 'Client document note',
    defaultSort: 'company_name, doc_type',
    search: ['company_name', 'hint', 'label_aliases'],
    filters: ['doc_type', 'approved'],
    columns: ['company_id', 'doc_type', 'sender_domains', 'po_number_pattern', 'label_aliases', 'hint'],
    schema: z.object({
      company_id: requiredInt({ min: 1 }),
      doc_type: enumOf(['po', 'invoice']),
      // "dasami.com, dasamilab.in": the domains the client sends from.
      sender_domains: z.preprocess(
        // Left out of a change, left as it is; blank is none.
        (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v ?? '').split(/[,\s]+/)).map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean)),
        z.array(z.string().max(120).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'A domain, like dasami.com')).max(20).optional(),
      ),
      po_number_pattern: z.preprocess(blankToNull, z.string().trim().max(120).refine((p) => { try { new RegExp(p); return true; } catch { return false; } }, 'Not a pattern the tracker can read').nullable().optional()),
      label_aliases: str(300),
      hint: str(500),
    }),
    onSave: approveProfile,
  },

  holidays: {
    // The days nobody works (#73), which the working-day helpers in
    // businessDate.ts skip. Read by everybody, because the figures sales
    // and finance see count them; kept by an admin, like the rates above.
    adminOnlyWrites: true,
    table: 'holidays',
    view: null,
    label: 'Holiday',
    defaultSort: 'holiday_on',
    search: ['name'],
    filters: [],
    dateFilter: 'holiday_on',
    columns: ['holiday_on', 'name'],
    schema: z.object({
      holiday_on: requiredDate(),
      name: requiredStr(120),
    }),
  },
};

// The standard project lifecycle from the workbook's Onboarding sheet,
// offered as a one-click checklist on any new project.
export const ONBOARDING_TEMPLATE = [
  ['Onboarding', 'Purchase order(s) received and registered in the PO Register'],
  ['Onboarding', 'Services on each PO listed against the PO'],
  ['Onboarding', 'Payment stages for each PO entered in the payment schedule'],
  ['Onboarding', 'Finance raises the stage-1 (advance) invoice per the PO payment terms'],
  ['Onboarding', 'Project manager and delivery team assigned'],
  ['Onboarding', 'Client kick-off meeting held; scope and delivery date confirmed'],
  ['Execution', 'Fieldwork / assessment / data collection completed'],
  ['Execution', 'Draft deliverable shared with client for review'],
  ['Delivery', 'Final deliverable / report / certificate issued to client'],
  ['Delivery', 'Finance raises the on-delivery stage invoice(s)'],
  ['Closure', 'All stage invoices paid on time as per agreed terms - project closed'],
];

/* ------------------------------------------------- computed list filters */

const MONTH = /^\d{4}-\d{2}$/;

/**
 * The scope the Insights rules run with: the reader's own, or, for an admin
 * following a bar for one owner, that owner's (`owner=none` is the records
 * nobody owns). Not a column filter: owner_user_id stays out of the generic
 * filters until ownership is a list filter everywhere.
 */
function ruleScope(scope, owner) {
  if (!scope.unrestricted || !owner) return { scope, unowned: false };
  if (owner === 'none') return { scope, unowned: true };
  const id = Number(owner);
  return Number.isInteger(id) && id > 0 ? { scope: { unrestricted: false, ownerId: id }, unowned: false } : { scope, unowned: false };
}

/**
 * The record numbers the Insights rules pick out, as a clause. Loaded on
 * demand: insights.js reaches the follow-up and mail modules, which reach
 * back here, and a static import would make that a cycle.
 */
async function numbersClause(column, params, pick) {
  const { insightsContext } = await import('./insights.js');
  const { businessToday } = await import('./businessDate.ts');
  const { query } = await import('../db.js');
  const db = { query };
  const numbers = await pick(db, await insightsContext(db, businessToday()));
  params.push(numbers);
  return `${column} = ANY($${params.length}::text[])`;
}

/**
 *   ?follow_up=overdue        open quotations past their follow-up date
 *   &overdue_days=8-14 | 15+  …and overdue by that many days
 *   &owner=<user id> | none   …and, for an admin, one owner's
 *   ?close_month=YYYY-MM      expected to close that month
 *   ?month=YYYY-MM            quoted that month (Reports' quoted-vs-won bars)
 */
async function quotationListClauses(q, { scope, params }) {
  const out = [];
  if (MONTH.test(String(q.close_month ?? ''))) {
    params.push(q.close_month);
    out.push(`to_char(expected_close_date, 'YYYY-MM') = $${params.length}`);
  } else if (q.close_month === 'undated') out.push('expected_close_date IS NULL');
  if (MONTH.test(String(q.month ?? ''))) {
    params.push(q.month);
    out.push(`to_char(quotation_date, 'YYYY-MM') = $${params.length}`);
  }
  if (q.follow_up === 'overdue') {
    const { parseDayRange } = await import('./ageing.js');
    const range = parseDayRange(q.overdue_days);
    out.push(await numbersClause('quotation_no', params, async (db, ctx) => {
      const { overdueFollowUps } = await import('./insights.js');
      const who = ruleScope(scope, q.owner);
      const items = (await overdueFollowUps(db, who.scope, ctx)).filter((i) => !who.unowned || i.owner_user_id == null);
      return items.filter((i) => !range || (i.days_overdue >= range.lo && i.days_overdue <= range.hi)).map((i) => i.number);
    }));
  }
  return out;
}

/**
 * ?from_email=1   enquiries created automatically from an email, or
 *                 quotations read from a PDF we emailed — derived from the
 *                 decision log (docs/email-enquiries-plan.md), not stored on
 *                 the record.
 */
function fromEmailClause(resource, q) {
  if (!['1', 'true', 'yes'].includes(String(q.from_email ?? '').toLowerCase())) return [];
  // POs registered automatically from a client's email (docs/email-po-plan.md).
  // Invoices recorded automatically from one we emailed (§3.10).
  if (resource === 'payment-stages') return [`id IN (SELECT stage_id FROM email_invoice_decisions WHERE outcome = 'recorded' AND stage_id IS NOT NULL)`];
  if (resource === 'purchase-orders') return [`po_number IN (SELECT po_number FROM email_po_decisions WHERE outcome = 'registered' AND po_number IS NOT NULL)`];
  return resource === 'enquiries'
    ? [`enquiry_no IN (SELECT enquiry_no FROM email_enquiry_decisions WHERE outcome = 'created' AND enquiry_no IS NOT NULL)`]
    : [`quotation_no IN (SELECT quotation_no FROM email_enquiry_decisions WHERE quotation_extraction IN ('created','revised') AND quotation_no IS NOT NULL)`];
}

/**
 * ?from_past_po=1   "Past POs and invoices to settle" (docs/email-po-plan.md
 *                   §3.8, §3.10.4): the stages of POs registered from past
 *                   mail, and the stages whose invoice was recorded from
 *                   past mail, that have no payment recorded yet. Their
 *                   invoices and payments very likely happened outside the
 *                   tracker; finance records them from this list.
 */
function fromPastPoClause(q) {
  if (!['1', 'true', 'yes'].includes(String(q.from_past_po ?? '').toLowerCase())) return [];
  return [`(po_number IN (SELECT po_number FROM email_po_decisions WHERE outcome = 'registered' AND mode = 'history' AND po_number IS NOT NULL)
            OR id IN (SELECT stage_id FROM email_invoice_decisions WHERE outcome = 'recorded' AND mode = 'history' AND stage_id IS NOT NULL))
           AND COALESCE(amount_received, 0) = 0`];
}

/** ?risk=at_risk | no_reply | follow_up_missed | decision_near | idle, and &owner= as above */
async function enquiryListClauses(q, { scope, params }) {
  if (!q.risk) return [];
  const { RISK_REASONS } = await import('./enquiryRisk.js');
  const reason = RISK_REASONS.includes(q.risk) ? q.risk : null;
  return [await numbersClause('enquiry_no', params, async (db, ctx) => {
    const { enquiriesAtRisk } = await import('./insights.js');
    const who = ruleScope(scope, q.owner);
    const items = (await enquiriesAtRisk(db, who.scope, ctx)).filter((i) => !who.unowned || i.owner_user_id == null);
    return items.filter((i) => !reason || i.reasons.some((r) => r.reason === reason)).map((i) => i.number);
  })];
}
