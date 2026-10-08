import {
  BarChart3, Building2, ClipboardList, FileText, FolderKanban, Gauge, Home,
  Inbox as InboxIcon, IndianRupee, Lightbulb, MessageSquare, Plane, Receipt, Wallet,
} from 'lucide-react';

/**
 * What the shell lists, per role. The same entries the sidebar had: four
 * pages and six record types, or, for the travel desk (#196 §3), its
 * dashboard and three record types. Everything else is a word away in Ctrl K.
 */
export const NAV_TOP = [
  { to: '/', icon: Home, label: 'Today', end: true },
  { to: '/inbox', icon: InboxIcon, label: 'Inbox', badge: 'inbox' },
  // A landing screen, like Reports: the five questions to start a day on.
  { to: '/insights', icon: Lightbulb, label: 'Insights' },
  { to: '/reports', icon: BarChart3, label: 'Reports' },
];
export const NAV_RECORDS = [
  { to: '/quotations', icon: FileText, label: 'Deals' },
  { to: '/companies', icon: Building2, label: 'Companies' },
  { to: '/projects', icon: FolderKanban, label: 'Projects' },
  { to: '/purchase-orders', icon: ClipboardList, label: 'Orders' },
  { to: '/payment-stages', icon: IndianRupee, label: 'Payment stages' },
  { to: '/travel', icon: Plane, label: 'Trips' },
  // The agency's bills (#214 decision 8): HR keeps them and an administrator
  // settles them, so an admin gets the door too. Not a salesperson's.
  { to: '/vendor-invoices', icon: Receipt, label: 'Vendor invoices', adminOnly: true },
];
export const NAV_HR_TOP = [
  { to: '/travel-dashboard', icon: Gauge, label: 'Travel dashboard', end: true },
];
export const NAV_HR_RECORDS = [
  { to: '/travel', icon: Plane, label: 'Trips' },
  { to: '/vendor-invoices', icon: Receipt, label: 'Vendor invoices' },
  { to: '/payables', icon: IndianRupee, label: 'Payables' },
];

export const navFor = (isHr, isAdmin = false) => ({
  top: isHr ? NAV_HR_TOP : NAV_TOP,
  records: isHr ? NAV_HR_RECORDS : NAV_RECORDS.filter((n) => !n.adminOnly || isAdmin),
});

/**
 * The phone tab bar: two pages, the New button, one record type, More.
 * The rest of the nav is in the More sheet.
 */
export const tabsFor = (isHr) => (isHr
  ? [NAV_HR_TOP[0], NAV_HR_RECORDS[0], '+', { ...NAV_HR_RECORDS[1], short: 'Bills' }, 'more']
  : [NAV_TOP[0], NAV_TOP[1], '+', NAV_RECORDS[0], 'more']);

/**
 * The New menu: each opens the list's own "+ New" form (ListPage reads
 * ?new=<resource>). Contacts have no form of their own outside a company,
 * so they are not here.
 */
export const NEW_ITEMS = [
  { label: 'Deal', icon: FileText, to: '/quotations?new=quotations' },
  { label: 'Enquiry', icon: MessageSquare, to: '/enquiries?new=enquiries' },
  { label: 'Company', icon: Building2, to: '/companies?new=companies' },
  { label: 'Project', icon: FolderKanban, to: '/projects?new=projects' },
  { label: 'Purchase order', icon: ClipboardList, to: '/purchase-orders?new=purchase-orders' },
  { label: 'Trip', icon: Plane, to: '/travel?new=travel-logs' },
  { label: 'Expense claim', icon: Wallet, to: '/expense-claims?new=expense-claims' },
];
export const NEW_ITEMS_HR = [
  { label: 'Trip', icon: Plane, to: '/travel?new=travel-logs' },
  { label: 'Vendor invoice', icon: Receipt, to: '/vendor-invoices?new=vendor-invoices' },
];

/** The quick-add dock: two palette steps and one form, or the travel desk's two forms. */
export const DOCK = [
  { label: 'Log a payment', icon: IndianRupee, step: 'record-payment' },
  { label: 'Raise an invoice', icon: Receipt, step: 'raise-invoice' },
  { label: 'New deal', icon: FileText, to: '/quotations?new=quotations' },
];
export const DOCK_HR = [
  { label: 'New trip', icon: Plane, to: '/travel?new=travel-logs' },
  { label: 'Add a vendor bill', icon: Receipt, to: '/vendor-invoices?new=vendor-invoices' },
];

/** The small word above a page title, from where the page lives. */
const EYEBROWS = [
  [/^\/(quotations|companies|projects|purchase-orders|payment-stages|enquiries|pipeline|renewals)(\/|$)/, 'Records'],
  [/^\/(worklist|tasks|follow-ups|schedule|notifications|data-quality|deliverables)(\/|$)/, 'Daily work'],
  [/^\/(travel|vendor-invoices|vendor-credit-notes|payables|travel-dashboard|import-travel)(\/|$)/, 'Travel desk'],
  [/^\/(collections|cashflow|money|profitability|accounting|expense-claims)(\/|$)/, 'Money'],
  [/^\/(settings|import)(\/|$)/, 'Settings'],
  [/^\/account(\/|$)/, 'Your account'],
];
export const eyebrowFor = (path) => EYEBROWS.find(([re]) => re.test(path))?.[1] || '';

export const ROLE_LABEL = { admin: 'Admin', sales: 'Sales', hr: 'HR (travel)' };

export const TONE_VAR = { late: 'var(--late)', waiting: 'var(--wait)', info: 'var(--info)', settled: 'var(--ok)' };

/**
 * Where each list lives, so a saved view knows where to send you. A view on
 * a resource nobody has routed is simply not shown rather than linking into
 * nothing.
 */
const RESOURCE_ROUTES = {
  quotations: '/quotations',
  enquiries: '/enquiries',
  companies: '/companies',
  projects: '/projects',
  'purchase-orders': '/purchase-orders',
  'payment-stages': '/payment-stages',
  'travel-logs': '/travel',
  'vendor-invoices': '/vendor-invoices',
  'expense-claims': '/expense-claims',
};

/** `{stage_status: 'Overdue'}` → `/payment-stages?stage_status=Overdue`. */
export function viewHref(view) {
  const base = RESOURCE_ROUTES[view.resource];
  if (!base) return null;
  const query = new URLSearchParams(
    Object.entries(view.filters || {}).filter(([, value]) => value !== '' && value != null)
  ).toString();
  return query ? `${base}?${query}` : base;
}

/** Two letters for the avatar, from however many names somebody has. */
export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
}
