/**
 * Insights, the pure half (docs/insights-dashboard-plan.md §5.1): where each
 * bar and tile leads, what tone a tile takes, and the one-line answer under
 * each question. No React and no fetching, so test/insights.test.js reads it
 * directly.
 */
import { money, number } from './format.js';

export const GRANULARITY_OPTIONS = [
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'fy', label: 'FY' },
];
export const HORIZON_OPTIONS = ['3', '6', '12'];
export const BASIS_OPTIONS = [
  { value: 'cash', label: 'Cash basis' },
  { value: 'order', label: 'Order basis' },
];

export const inr = (value) => money(value, 'INR', { compact: true });
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

/** The filters, as they sit in the address bar, with defaults dropped. */
export function readFilters(params) {
  const get = (k) => params.get(k) || '';
  return {
    owner: get('owner'),
    granularity: ['month', 'quarter', 'fy'].includes(get('granularity')) ? get('granularity') : 'month',
    horizon: HORIZON_OPTIONS.includes(get('horizon')) ? get('horizon') : '6',
    basis: get('basis') === 'order' ? 'order' : 'cash',
  };
}

/** `?a=b&c=d` from an object, leaving out blanks. */
export function queryString(values) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

/* ------------------------------------------------------------ drill-downs */

/**
 * An admin looking at one owner carries that owner into the lists Insights
 * works out (follow-ups, risk). The stage lists are the plain lists.
 */
const withOwner = (owner) => (owner ? { owner } : {});

export const hrefs = {
  followUps: (owner, band) => `/quotations${queryString({ follow_up: 'overdue', overdue_days: band, ...withOwner(owner) })}`,
  followUpOwner: (ownerId) => `/quotations${queryString({ follow_up: 'overdue', owner: ownerId ?? 'none' })}`,
  ageing: (bucket) => `/collections${queryString({ bucket })}`,
  client: (companyId) => (companyId ? `/companies/${encodeURIComponent(companyId)}` : '/collections'),
  invoice: (stageId) => `/collections${queryString({ stage: stageId })}`,
  risk: (owner, reason) => `/enquiries${queryString({ risk: reason || 'at_risk', ...withOwner(owner) })}`,
  stage: (owner, stageId) => `/quotations${queryString({ stage_id: stageId })}`,
  awaitingMonth: (owner, stageId, month) => `/quotations${queryString({ stage_id: stageId, close_month: month })}`,
  poStatus: (status) => `/purchase-orders${queryString({ payment_status: status, live: 1 })}`,
  /** A cash period opens Cash flow on its month, or across its months. */
  period: (p, granularity) => (granularity === 'month'
    ? `/cashflow${queryString({ month: p.period })}`
    : `/cashflow${queryString({ from: p.from, to: p.to })}`),
  record: (link) => link || '/',
};

/* ------------------------------------------------------------------ tones */

/**
 * A tile is red when something is already late, amber when it is close, and
 * plain when there is nothing to do. Colour is never the only signal: the
 * number and its line say the same thing.
 */
export const tones = {
  followUps: (s) => (!s?.count ? 'success' : s.oldest_days > 7 ? 'danger' : 'warning'),
  receivables: (s) => (!s?.overdue ? 'success' : s.buckets?.some((b) => (b.key === '61-90' || b.key === '90+') && b.amount > 0) ? 'danger' : 'warning'),
  enquiryRisk: (s) => (!s?.count ? 'success' : s.top?.some((i) => i.decision_near) ? 'danger' : 'warning'),
  awaitingPo: (s) => (s?.awaiting_po?.count ? 'info' : ''),
  revenue: () => '',
};

/* ----------------------------------------------------------- one-liners */

export function followUpAnswer(s) {
  if (!s?.count) return 'No quotations past their follow-up date. Nice.';
  const first = s.top?.[0];
  const start = first ? ` Start with ${first.client || first.number}${first.value_inr ? ` (${inr(first.value_inr)})` : ''}.` : '';
  return `${plural(s.count, 'quotation')}, oldest ${plural(s.oldest_days, 'day')} past its date.${start}`;
}

export function receivablesAnswer(s) {
  if (!s?.outstanding) return 'Nothing invoiced is waiting to be paid.';
  if (!s.overdue) return `${inr(s.outstanding)} invoiced, none of it late yet.`;
  const first = s.top_clients?.[0];
  return `${inr(s.overdue)} is late, of ${inr(s.outstanding)} owed.${first ? ` ${first.company} owes the most (${inr(first.overdue)}).` : ''}`;
}

export function enquiryRiskAnswer(s) {
  if (!s?.count) return 'Every open enquiry is in hand. Nice.';
  const first = s.top?.[0];
  return `${plural(s.count, 'enquiry', 'enquiries')} need handling.${first ? ` Start with ${first.client || first.number}: ${reasonText(first.reasons?.[0])}.` : ''}`;
}

export function poAnswer(s) {
  if (!s) return '';
  const toBill = s.stages?.find((x) => x.key === 'po-to-bill');
  const parts = [];
  if (s.awaiting_po?.count) parts.push(`${plural(s.awaiting_po.count, 'deal')} awaiting a PO (${inr(s.awaiting_po.value)})`);
  if (toBill?.count) parts.push(`${plural(toBill.count, 'PO')} still to bill (${inr(toBill.value)})`);
  return parts.length ? `${parts.join('; ')}.` : 'No deal is waiting on a PO and every PO is billed.';
}

export function revenueAnswer(r) {
  if (!r?.periods?.length) return '';
  if (r.basis === 'order') {
    const won = r.periods.reduce((n, p) => n + p.won, 0);
    const pipe = r.periods.reduce((n, p) => n + p.pipeline, 0);
    return `${inr(won)} ordered in the months shown, ${inr(pipe)} more weighted in the pipeline.`;
  }
  const firm = r.periods.reduce((n, p) => n + p.received + p.invoiced + p.scheduled, 0);
  const pipe = r.periods.reduce((n, p) => n + p.pipeline, 0);
  return `${inr(firm)} expected in the bank over the months shown, ${inr(pipe)} more if the weighted pipeline lands.`;
}

/* --------------------------------------------------------- the ⓘ rules */

export function reasonText(r) {
  if (!r) return '';
  if (r.reason === 'decision_near') return r.days_left < 0 ? `decision was due ${plural(-r.days_left, 'working day')} ago, no quotation` : `decides in ${plural(r.days_left, 'working day')}, no quotation`;
  if (r.reason === 'no_reply') return `no reply, ${plural(r.days_late, 'working day')} over`;
  if (r.reason === 'follow_up_missed') return `follow-up missed${r.days_late ? `, ${plural(r.days_late, 'working day')} ago` : ' today'}`;
  return `quiet, ${plural(r.days_late, 'working day')} over`;
}

export function ruleText(section, settings = {}) {
  const s = settings;
  switch (section) {
    case 'follow_ups':
      return `A quotation's follow-up is overdue when its date (or its next open task) has passed and nothing was logged since. With no date set, after ${plural(s.quotation_idle_days ?? 5, 'working day')} of silence since it was sent. Change it in Settings → Follow-ups.`;
    case 'receivables':
      return 'Invoiced and not fully paid, by days past the due date. Other currencies are in rupees at the rate on the invoice date.';
    case 'enquiry_risk':
      return `An open enquiry is at risk when nobody has replied within ${plural(s.enquiry_reply_days ?? 1, 'working day')}, a follow-up date passed with nothing logged, the client decides within ${plural(s.enquiry_decision_warn_days ?? 5, 'working day')} and there is no quotation, or it went quiet for ${plural(s.enquiry_idle_days ?? 3, 'working day')}. Change it in Settings → Follow-ups.`;
    case 'po_pipeline':
      return 'Open deals by stage, weighted by each stage\'s chance, then live POs: still to bill, and billed but not yet paid. Revised and cancelled POs are left out.';
    case 'revenue':
      return 'Cash basis is money expected in the bank: received, invoiced and due, and stages not yet invoiced by their trigger. Order basis is POs by their date. The weighted pipeline is shown apart, never mixed in.';
    default:
      return '';
  }
}
