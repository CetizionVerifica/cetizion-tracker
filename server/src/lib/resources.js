import { z } from 'zod';

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
      .string({ required_error: 'Required', invalid_type_error: 'Required' })
      .trim()
      .min(1, 'Required')
      .max(max, `Keep this under ${max} characters`)
  );

const date = () =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .nullable()
      .optional()
  );

const num = ({ min, max } = {}) =>
  z.preprocess((v) => {
    const cleaned = blankToNull(v);
    if (cleaned === null || cleaned === undefined) return cleaned;
    const n = typeof cleaned === 'string' ? Number(cleaned.replace(/,/g, '')) : cleaned;
    return Number.isNaN(n) ? cleaned : n;
  }, (() => {
    let s = z.number({ invalid_type_error: 'Enter a number' });
    if (min !== undefined) s = s.min(min, `Must be at least ${min}`);
    if (max !== undefined) s = s.max(max, `Must be at most ${max}`);
    return s.nullable().optional();
  })());

const int = (opts) => num(opts).transform((v) => (v === null || v === undefined ? v : Math.round(v)));

const bool = () =>
  z.preprocess(
    (v) => (v === 'true' ? true : v === 'false' ? false : blankToNull(v)),
    z.boolean().nullable().optional()
  );

const enumOf = (values) => z.enum(values);

export const STATUS = {
  quotation: ['Submitted', 'Under Negotiation', 'Won - PO Received', 'Lost', 'On Hold'],
  trigger: ['On PO Registration', 'On Delivery', 'Manual'],
  onboarding: ['Not Started', 'In Progress', 'Done', 'N/A'],
  approval: ['Submitted', 'Approved', 'Rejected', 'On Hold'],
  currency: ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD'],
};

// ---------------------------------------------------------------------
// Resource registry
//
// Each entry drives a full REST router: list (served from the computed
// view so the client always sees live totals), read, create, update and
// delete against the base table.
// ---------------------------------------------------------------------

export const resources = {
  quotations: {
    table: 'quotations',
    view: 'v_quotations',
    label: 'Quotation',
    naturalKey: 'quotation_no',
    defaultSort: 'quotation_date DESC NULLS LAST, id DESC',
    search: ['quotation_no', 'client_name', 'contact_person', 'service_quoted', 'sales_person'],
    filters: ['status', 'sales_person', 'project_id', 'client_name', 'payment_status'],
    columns: [
      'quotation_no', 'client_name', 'contact_person', 'service_quoted',
      'sales_person', 'sales_person_email', 'quotation_date', 'quotation_value',
      'currency', 'status', 'po_received', 'project_id', 'remarks',
    ],
    schema: z.object({
      quotation_no: requiredStr(60),
      client_name: requiredStr(160),
      contact_person: str(120),
      service_quoted: str(300),
      sales_person: str(120),
      sales_person_email: str(160),
      quotation_date: date(),
      quotation_value: num({ min: 0 }),
      currency: enumOf(STATUS.currency).default('INR'),
      status: enumOf(STATUS.quotation).default('Submitted'),
      po_received: bool(),
      project_id: str(40),
      remarks: str(1000),
    }),
  },

  projects: {
    table: 'projects',
    view: 'v_projects',
    label: 'Project',
    naturalKey: 'project_id',
    defaultSort: 'project_id DESC',
    search: ['project_id', 'client_name', 'primary_service', 'project_manager', 'sales_person'],
    filters: ['project_stage', 'payment_status', 'project_manager', 'client_name', 'sales_person'],
    columns: [
      'project_id', 'client_name', 'primary_service', 'project_manager',
      'project_manager_email', 'sales_person', 'planned_start_date',
      'planned_delivery_date', 'percent_complete', 'remarks',
    ],
    schema: z.object({
      project_id: requiredStr(40),
      client_name: requiredStr(160),
      primary_service: str(300),
      project_manager: str(120),
      project_manager_email: str(160),
      sales_person: str(120),
      planned_start_date: date(),
      planned_delivery_date: date(),
      percent_complete: num({ min: 0, max: 1 }),
      remarks: str(1000),
    }),
  },

  'purchase-orders': {
    table: 'purchase_orders',
    view: 'v_purchase_orders',
    label: 'Purchase order',
    naturalKey: 'po_number',
    defaultSort: 'po_date DESC NULLS LAST, id DESC',
    search: ['po_number', 'project_id', 'client_name'],
    filters: ['project_id', 'payment_status', 'client_name'],
    columns: [
      'po_number', 'project_id', 'po_date', 'po_value', 'currency',
      'payment_terms_days', 'actual_initiation_date', 'actual_delivery_date',
      'project_manager_email', 'remarks',
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
    }),
  },

  'po-services': {
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
    table: 'payment_stages',
    view: 'v_payment_stages',
    label: 'Payment stage',
    defaultSort: 'po_number, stage_no',
    search: ['po_number', 'stage_name', 'invoice_no', 'client_name', 'project_id'],
    filters: ['po_number', 'project_id', 'stage_status', 'trigger_event', 'client_name'],
    columns: [
      'po_number', 'stage_no', 'stage_name', 'trigger_event', 'stage_percent',
      'invoice_no', 'invoice_date', 'amount_received', 'payment_received_date',
      'reminder_sent_on', 'remarks',
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
      remarks: str(1000),
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
      step_no: int({ min: 1 }),
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

  services: {
    table: 'services',
    view: null,
    label: 'Service',
    defaultSort: 'sort_order, name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active', 'sort_order'],
    schema: z.object({
      name: requiredStr(200),
      active: bool(),
      sort_order: int().default(0),
    }),
  },

  'travel-vendors': {
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
    table: 'expense_categories',
    view: null,
    label: 'Expense category',
    defaultSort: 'name',
    search: ['name'],
    filters: ['active'],
    columns: ['name', 'active'],
    schema: z.object({ name: requiredStr(160), active: bool() }),
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
