/**
 * What a person can do, said the way they would say it.
 *
 * The design's finding was "I can't work out how to do something", and its
 * answer is verbs above records: you type what you want to happen, not the
 * name of the screen that owns it. So each workflow route in the server
 * gets exactly one entry here, phrased as a sentence rather than as the
 * endpoint it calls.
 *
 * Two kinds of entry:
 *
 *   A **step** has `fields` and an `endpoint`. Choosing it turns the
 *   palette into a short form and posts from there. The page underneath
 *   never changes — that is the point, and the reason the palette is worth
 *   having at all rather than being a nicer set of links.
 *
 *   A **jump** has `to`. Choosing it navigates. Used for the work that is
 *   genuinely a screen — a board you drag things around, a sheet you
 *   upload — and for every page the sidebar no longer lists.
 *
 * Adding a verb is one object. Keep the wording in the imperative and
 * keep `hint` to the thing somebody needs to know before choosing it.
 */

/** A record the palette is acting on, when the person picked one first. */
export const NEEDS_RECORD = 'needs-record';

/**
 * The fields a step asks for.
 *
 * `required` is enforced before the post, so a missing one is a message in
 * the palette rather than a 422 from the server.
 */
const f = {
  text: (name, label, opts = {}) => ({ name, label, type: 'text', ...opts }),
  money: (name, label, opts = {}) => ({ name, label, type: 'number', min: 0, step: '0.01', ...opts }),
  date: (name, label, opts = {}) => ({ name, label, type: 'date', ...opts }),
  choice: (name, label, options, opts = {}) => ({ name, label, type: 'select', options, ...opts }),
  note: (name, label, opts = {}) => ({ name, label, type: 'textarea', ...opts }),
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The steps, in the order somebody would meet them: money first, because
 * the overdue invoice is what the design promotes on Today and what the
 * palette opens on.
 */
export const STEPS = [
  {
    id: 'raise-invoice',
    verb: 'Raise an invoice',
    hint: 'one stage, without leaving this page — or run the whole queue',
    icon: 'money',
    keywords: 'invoice bill raise stage payment',
    picks: { type: 'stage', resource: 'payment-stages', params: { stage_status: 'To Invoice' }, label: 'Which stage?' },
    fields: [
      // Not required: left blank the server takes the next number in the
      // series inside the transaction that writes the stage. A GST series
      // has to be unbroken, so a number typed here is the exception.
      f.text('invoice_no', 'Invoice number', { maxLength: 60, placeholder: 'next in series' }),
      f.date('invoice_date', 'Invoice date', { required: true, value: today }),
    ],
    endpoint: (record) => `/payment-stages/${record.id}/invoice`,
    done: 'Invoice raised.',
  },
  {
    id: 'record-payment',
    verb: 'Record a payment',
    hint: 'against an invoice already raised',
    icon: 'money',
    keywords: 'payment received money paid receipt',
    // Anything already invoiced, whether or not it has gone past its date.
    picks: { type: 'stage', resource: 'payment-stages', params: { stage_status: 'Overdue,Partially Paid,Not Due' }, label: 'Against which invoice?' },
    fields: [
      f.money('amount_received', 'Amount received', { required: true }),
      f.date('payment_received_date', 'Received on', { value: today }),
      f.choice('mode', 'This figure is', [
        { value: 'set', label: 'the total received so far' },
        { value: 'add', label: 'a further receipt to add' },
      ], { value: 'set' }),
      f.choice('payment_mode', 'How it came in', [
        { value: 'bank_transfer', label: 'Bank transfer' },
        { value: 'cheque', label: 'Cheque' },
        { value: 'upi', label: 'UPI' },
        { value: 'cash', label: 'Cash' },
        { value: 'other', label: 'Other' },
      ], { value: 'bank_transfer' }),
      f.text('reference', 'Reference', { maxLength: 120 }),
    ],
    endpoint: (record) => `/payment-stages/${record.id}/payment`,
    done: 'Payment recorded.',
  },
  {
    id: 'pay-vendor-bill',
    verb: 'Pay a travel vendor bill',
    hint: 'the ones waiting on finance',
    icon: 'trip',
    keywords: 'vendor bill travel pay holidays agent',
    picks: { type: 'bill', resource: 'vendor-invoices', params: { payment_status: 'Overdue,To Pay,Partially Paid,Enter amount,Enter date' }, label: 'Which bill?' },
    fields: [
      f.money('amount_paid', 'Amount paid', { required: true }),
      f.date('payment_date', 'Paid on', { value: today }),
    ],
    endpoint: (record) => `/vendor-invoices/${record.id}/pay`,
    done: 'Bill marked paid.',
  },
  {
    id: 'decide-claim',
    verb: 'Approve or reject an expense claim',
    hint: 'the ones waiting on you',
    icon: 'deal',
    keywords: 'expense claim approve reject reimburse',
    picks: { type: 'claim', resource: 'expense-claims', params: { approval_status: 'Submitted' }, label: 'Which claim?' },
    fields: [
      f.choice('approval_status', 'Decision', [
        { value: 'Approved', label: 'Approve it' },
        { value: 'Rejected', label: 'Reject it' },
        { value: 'On Hold', label: 'Hold it for now' },
      ], { required: true, value: 'Approved' }),
      f.text('approved_by', 'Decided by', { maxLength: 120 }),
    ],
    endpoint: (record) => `/expense-claims/${record.id}/decide`,
    done: 'Claim decided.',
  },
  {
    id: 'log-chase',
    verb: 'Log a chase on an overdue invoice',
    hint: 'and pause the reminders if they promised a date',
    icon: 'money',
    keywords: 'chase collections call promise follow up overdue',
    picks: { type: 'stage', resource: 'payment-stages', params: { stage_status: 'Overdue' }, label: 'Which invoice?' },
    fields: [
      f.choice('channel', 'How you chased', [
        { value: 'call', label: 'Call' },
        { value: 'email', label: 'Email' },
        { value: 'whatsapp', label: 'WhatsApp' },
        { value: 'meeting', label: 'Meeting' },
        { value: 'note', label: 'Note to self' },
      ], { value: 'call' }),
      f.note('summary', 'What was said', { required: true, maxLength: 2000 }),
      f.date('promise_to_pay_date', 'They promised to pay on', { hint: 'Setting this pauses reminders until the date' }),
    ],
    endpoint: () => '/collections/log',
    body: (record) => ({ stage_id: record.id }),
    done: 'Chase logged.',
  },
  {
    id: 'send-quotation',
    verb: 'Send a quotation',
    hint: 'stamps it as sent, and emails it if you ask',
    icon: 'deal',
    keywords: 'send quotation quote email client',
    picks: { type: 'deal', resource: 'quotations', params: { status: 'Submitted' }, label: 'Which quotation?' },
    key: 'quotation_no',
    fields: [
      f.text('to', 'Send to', { type: 'email', hint: 'Leave blank to record it as sent without emailing' }),
      f.note('message', 'Covering note', { maxLength: 2000 }),
    ],
    endpoint: (record) => `/quotations/${encodeURIComponent(record.quotation_no)}/send`,
    body: (record, values) => ({ email: Boolean(values.to) }),
    done: 'Quotation sent.',
  },
  {
    id: 'mark-accepted',
    verb: 'Mark a quotation accepted',
    hint: 'when the client said yes outside the tracker',
    icon: 'deal',
    keywords: 'accept won yes approved quotation',
    picks: { type: 'deal', resource: 'quotations', params: { status: 'Under Negotiation' }, label: 'Which quotation?' },
    key: 'quotation_no',
    fields: [f.text('accepted_by_name', 'Who accepted it', { required: true, maxLength: 160 })],
    endpoint: (record) => `/quotations/${encodeURIComponent(record.quotation_no)}/accept`,
    done: 'Marked accepted.',
  },
  {
    id: 'log-touch',
    verb: 'Log a call or a meeting',
    hint: 'on any record, so the next person sees it',
    icon: 'company',
    keywords: 'call meeting whatsapp log touch contact spoke',
    picks: { type: 'deal', resource: 'quotations', label: 'On which deal?' },
    key: 'quotation_no',
    fields: [
      f.choice('channel', 'What happened', [
        { value: 'call', label: 'A call' },
        { value: 'meeting', label: 'A meeting' },
        { value: 'whatsapp', label: 'A WhatsApp message' },
        { value: 'email', label: 'An email' },
        { value: 'other', label: 'Something else' },
      ], { required: true, value: 'call' }),
      f.note('summary', 'What was said', { maxLength: 4000 }),
    ],
    endpoint: () => '/communications',
    body: (record) => ({ entity: 'quotation', entity_id: record.quotation_no }),
    done: 'Logged.',
  },
];

/**
 * The screens. Everything the sidebar used to list is here, which is what
 * lets the sidebar stop listing it: thirty items nobody can scan became
 * two, and the rest are a word away.
 */
export const JUMPS = [
  { id: 'go-today', verb: 'Today', to: '/', icon: 'today', keywords: 'home dashboard overview start' },
  { id: 'go-inbox', verb: 'Inbox', to: '/inbox', icon: 'inbox', keywords: 'email mail shared conversations' },
  { id: 'go-worklist', verb: 'Action list', to: '/worklist', icon: 'today', keywords: 'worklist queue waiting everything' },
  { id: 'go-data-quality', verb: 'Data quality', to: '/data-quality', icon: 'waiting', adminOnly: true, keywords: 'data quality missing blank gaps incomplete fix' },
  { id: 'go-deals', verb: 'Deals', to: '/quotations', icon: 'deal', keywords: 'quotations quotes deals' },
  { id: 'go-enquiries', verb: 'Enquiries', to: '/enquiries', icon: 'deal', keywords: 'enquiries leads' },
  { id: 'go-pipeline', verb: 'Pipeline board', to: '/pipeline', icon: 'deal', keywords: 'pipeline board kanban stages drag' },
  { id: 'go-companies', verb: 'Companies', to: '/companies', icon: 'company', keywords: 'clients accounts companies' },
  { id: 'go-projects', verb: 'Projects', to: '/projects', icon: 'project', keywords: 'projects delivery' },
  { id: 'go-orders', verb: 'Purchase orders', to: '/purchase-orders', icon: 'order', keywords: 'po orders purchase' },
  { id: 'go-invoice-run', verb: 'Raise the invoices that are due', to: '/money/invoice-run', icon: 'money', keywords: 'invoice run raise billing queue bill' },
  { id: 'go-stages', verb: 'Payment schedule', to: '/payment-stages', icon: 'money', keywords: 'stages invoices payment schedule billing' },
  { id: 'go-reports', verb: 'Reports', to: '/reports', icon: 'today', keywords: 'reports charts pipeline ageing cash win rate graphs' },
  { id: 'go-collections', verb: 'Collections', to: '/collections', icon: 'money', keywords: 'collections overdue chase debt ageing' },
  { id: 'go-cashflow', verb: 'Cash-flow forecast', to: '/cashflow', icon: 'money', keywords: 'cash flow forecast money in out' },
  { id: 'go-renewals', verb: 'Renewals', to: '/renewals', icon: 'waiting', keywords: 'renewals expiring recurring' },
  { id: 'go-trips', verb: 'Trips', to: '/travel', icon: 'trip', keywords: 'travel trips journeys' },
  { id: 'go-vendor-invoices', verb: 'Vendor invoices', to: '/vendor-invoices', icon: 'trip', keywords: 'vendor bills travel agent' },
  { id: 'go-payables', verb: 'Payables', to: '/payables', icon: 'money', keywords: 'payables owe vendors ageing overdue bills creditors travel agent pay' },
  { id: 'go-claims', verb: 'Expense claims', to: '/expense-claims', icon: 'money', keywords: 'expenses claims reimburse' },
  { id: 'go-travel-spend', verb: 'Travel spend', to: '/travel-dashboard', icon: 'trip', keywords: 'travel spend cost dashboard' },
  { id: 'go-schedule', verb: 'Schedule', to: '/schedule', icon: 'waiting', keywords: 'calendar visits audits diary schedule' },
  { id: 'go-certificates', verb: 'Certificates', to: '/deliverables', icon: 'done', keywords: 'certificates deliverables reports issued' },
  { id: 'go-tasks', verb: 'Tasks', to: '/tasks', icon: 'done', keywords: 'tasks todo' },
  { id: 'go-sales-report', verb: 'Sales reports', to: '/sales-report', icon: 'today', keywords: 'reports sales funnel analysis' },
  { id: 'go-profitability', verb: 'Profitability', to: '/profitability', icon: 'money', adminOnly: true, keywords: 'margin profit cost' },
  { id: 'go-accounting', verb: 'Accounting', to: '/accounting', icon: 'money', adminOnly: true, keywords: 'books zoho tally reconcile' },
  { id: 'go-account', verb: 'My account', to: '/account/profile', icon: 'company', personalOnly: true, keywords: 'account profile password sessions devices signature linked microsoft google sign out everywhere' },
  { id: 'go-settings', verb: 'Settings', to: '/settings', icon: 'waiting', keywords: 'settings preferences rates services users' },
  { id: 'go-import', verb: 'Bulk import', to: '/settings/import', icon: 'today', keywords: 'import upload sheet excel csv' },
  { id: 'go-templates', verb: 'Templates', to: '/settings/templates', icon: 'done', adminOnly: true, keywords: 'templates payment terms onboarding checklist' },
  { id: 'go-mailboxes', verb: 'Mailboxes', to: '/settings/mailboxes', icon: 'inbox', adminOnly: true, keywords: 'mailbox connect outlook microsoft sync' },
  { id: 'go-webhooks', verb: 'Webhooks', to: '/settings/webhooks', icon: 'waiting', adminOnly: true, keywords: 'webhooks events n8n integrations' },
  { id: 'go-emails', verb: 'Emails & jobs', to: '/settings/emails', icon: 'inbox', keywords: 'emails jobs reminders digest' },
  { id: 'go-notifications', verb: 'Notifications', to: '/notifications', icon: 'waiting', keywords: 'notifications alerts bell' },
  // The settings panes by name, because "exchange rates" is what somebody
  // types — not "settings".
  { id: 'go-rates', verb: 'Exchange rates', to: '/settings/rates', icon: 'money', keywords: 'exchange rates currency fx usd eur conversion' },
  { id: 'go-assumptions', verb: 'Assumptions', to: '/settings/assumptions', icon: 'waiting', keywords: 'assumptions settings defaults terms thresholds' },
  { id: 'go-holidays', verb: 'Holidays', to: '/settings/holidays', icon: 'waiting', keywords: 'holidays calendar working days closed off gazetted' },
  { id: 'go-users', verb: 'Users & roles', to: '/settings/users', icon: 'company', adminOnly: true, keywords: 'users people roles accounts passwords access' },
  { id: 'go-sign-in', verb: 'Sign-in methods', to: '/settings/sign-in', icon: 'company', adminOnly: true, keywords: 'sign in sso oauth microsoft google single sign on login providers' },
  { id: 'go-tokens', verb: 'API tokens', to: '/settings/tokens', icon: 'waiting', adminOnly: true, keywords: 'api tokens mcp claude assistant access' },
];

/** Everything, with the steps first: a verb is more useful than a screen. */
export function commandsFor({ isAdmin, mode }) {
  // `personalOnly` is the account page: shared mode is one account in an
  // environment variable, so there is nothing personal to go to and the
  // route answers 404. A palette entry that 404s is worse than no entry.
  const allowed = (c) => (!c.adminOnly || isAdmin) && (!c.personalOnly || mode === 'database');
  return {
    steps: STEPS.filter(allowed),
    jumps: JUMPS.filter(allowed),
  };
}

/** Defaults for a step's form, resolving the ones that are a function. */
export function initialValues(step) {
  const out = {};
  for (const field of step.fields || []) {
    out[field.name] = typeof field.value === 'function' ? field.value() : (field.value ?? '');
  }
  return out;
}

/** What is missing, so the palette can say so before it posts. */
export function missingFields(step, values) {
  return (step.fields || [])
    .filter((field) => field.required && !String(values[field.name] ?? '').trim())
    .map((field) => field.label);
}

/** The body to post: the typed values, minus blanks, plus the record's keys. */
export function bodyFor(step, record, values) {
  const typed = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === '' || value === null || value === undefined) continue;
    typed[key] = value;
  }
  return { ...typed, ...(step.body ? step.body(record, values) : {}) };
}
