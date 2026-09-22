import { z } from 'zod';
import { quoteWonEnquiry } from './enquiries.js';
import { linkProjectQuotation } from './projects.js';
import { linkPurchaseOrder } from './purchaseOrders.js';
import { LEGACY_ENQUIRY_STATUS, STATUS } from './statuses.js';

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
    filters: ['sector', 'city'],
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
    filterAliases: { status: LEGACY_ENQUIRY_STATUS },
    view: null,
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
    }),
    onSave: quoteWonEnquiry,
  },

  quotations: {
    table: 'quotations',
    view: 'v_quotations',
    label: 'Quotation',
    hasDocument: true,
    naturalKey: 'quotation_no',
    // quotation_no is assigned on create (CTZ/QT/2026/064) and never changed.
    autoId: 'quotation',
    // The year in the generated number comes from the quotation's own date.
    autoIdDateField: 'quotation_date',
    defaultSort: 'quotation_date DESC NULLS LAST, id DESC',
    search: ['quotation_no', 'client_name', 'contact_person', 'service_quoted', 'sector', 'country', 'sales_person'],
    filters: ['status', 'sales_person', 'project_id', 'client_name', 'sector', 'country', 'payment_status', 'company_id', 'stage_id', 'lost_reason_id'],
    normalizedFilters: ['sales_person', 'client_name', 'sector'],
    dateFilter: 'quotation_date',
    columns: [
      'quotation_no', 'client_name', 'contact_person', 'service_quoted', 'sector', 'country',
      'sales_person', 'sales_person_email', 'quotation_date', 'quotation_value',
      'currency', 'status', 'po_received', 'project_id', 'remarks', 'document_id',
      'valid_until', 'terms', 'place_of_supply_state',
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
      stage_id: int({ min: 1 }),
      probability: int({ min: 0, max: 100 }),
      expected_close_date: date(),
      next_step: str(300),
      lost_reason_id: int({ min: 1 }),
      lost_notes: str(1000),
      competitor: str(160),
    }),
  },

  projects: {
    table: 'projects',
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
      'planned_delivery_date', 'percent_complete', 'remarks',
    ],
    schema: z.object({
      project_id: str(40),
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
      // Not a column on projects: the link lives on quotations.project_id and
      // is written by linkProjectQuotation. Declared here so it survives
      // validation and reaches onSave.
      quotation_no: str(60),
    }),
    onSave: linkProjectQuotation,
  },

  'purchase-orders': {
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
    // quotation_no: the won quotation this PO fulfils (linkPurchaseOrder).
    columns: [
      'po_number', 'project_id', 'quotation_no', 'po_date', 'po_value', 'currency',
      'payment_terms_days', 'actual_initiation_date', 'actual_delivery_date',
      'project_manager_email', 'remarks', 'document_id',
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
    }),
    onSave: linkPurchaseOrder,
  },

  'po-services': {
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
    // The invoicing schedule: what has been raised, what is due and what has
    // been paid. A deleted stage is an invoice the tracker stops accounting
    // for. Sales users raise and record against stages as usual; only an
    // admin removes one.
    adminOnlyDeletes: true,
    table: 'payment_stages',
    view: 'v_payment_stages',
    label: 'Payment stage',
    // The invoice document: replaced on edit, deleted from Cloudinary with the stage.
    hasDocument: true,
    defaultSort: 'po_number, stage_no',
    search: ['po_number', 'stage_name', 'invoice_no', 'client_name', 'project_id'],
    filters: ['po_number', 'project_id', 'stage_status', 'trigger_event', 'client_name'],
    columns: [
      'po_number', 'stage_no', 'stage_name', 'trigger_event', 'stage_percent',
      'invoice_no', 'invoice_date', 'amount_received', 'payment_received_date',
      'reminder_sent_on', 'remarks', 'document_id', 'credit_days', 'milestone_name', 'milestone_reached_on',
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
    search: ['travel_id', 'employee_name', 'destination', 'po_number', 'client_name'],
    filters: ['po_number', 'project_id', 'arranged_by', 'vendor_invoice_status', 'reimbursement_status', 'employee_name'],
    columns: [
      'travel_id', 'po_number', 'service_delivered', 'employee_name',
      'employee_email', 'purpose', 'destination', 'travel_start_date',
      'travel_end_date', 'arranged_by', 'hr_owner', 'hr_owner_email', 'remarks',
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
    }),
  },

  'vendor-invoices': {
    table: 'travel_vendor_invoices',
    view: 'v_travel_vendor_invoices',
    label: 'Vendor invoice',
    naturalKey: 'vendor_invoice_id',
    defaultSort: 'invoice_date DESC NULLS FIRST, id DESC',
    search: ['vendor_invoice_id', 'travel_id', 'vendor_invoice_no', 'travel_vendor', 'employee_name'],
    filters: ['travel_id', 'payment_status', 'travel_vendor', 'project_id'],
    columns: [
      'vendor_invoice_id', 'travel_id', 'vendor_invoice_no', 'invoice_date',
      'invoice_amount', 'payment_terms_days', 'amount_paid', 'payment_date', 'remarks',
    ],
    schema: z.object({
      vendor_invoice_id: requiredStr(60),
      travel_id: requiredStr(40),
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
    table: 'tasks',
    view: null,
    label: 'Task',
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
    }),
  },

  notes: {
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

  attachments: {
    table: 'attachments',
    view: null,
    label: 'Attachment',
    hasDocument: true,
    defaultSort: 'created_at DESC',
    search: ['label'],
    filters: ['entity', 'entity_id'],
    columns: ['entity', 'entity_id', 'document_id', 'label', 'uploaded_by'],
    stampActor: 'uploaded_by',
    schema: z.object({
      entity: enumOf(['company', 'contact', 'enquiry', 'quotation', 'project', 'purchase_order', 'payment_stage']),
      entity_id: requiredStr(120),
      document_id: requiredInt({ min: 1 }),
      label: str(200),
      uploaded_by: str(120),
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
    columns: ['name', 'active', 'sort_order', 'code', 'sac_code', 'default_rate', 'currency', 'gst_rate', 'unit', 'description', 'renewal_interval_months', 'renewal_lead_days', 'onboarding_template_id', 'payment_terms_template_id'],
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
    }),
  },

  'quotation-lines': {
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
    // A Settings list: admins curate it, everybody reads it.
    adminOnlyWrites: true,
    table: 'travel_vendors',
    view: null,
    label: 'Travel vendor',
    defaultSort: 'name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active'],
    schema: z.object({ name: requiredStr(160), active: bool() }),
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
