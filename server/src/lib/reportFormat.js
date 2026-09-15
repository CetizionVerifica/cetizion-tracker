/**
 * Number formatting for the PDF report and its written analysis — the same
 * conventions as the web app: Indian grouping for rupees, and lakh / crore
 * for compact amounts.
 */

const SYMBOL = { INR: '₹', EUR: '€', USD: '$', GBP: '£', AED: 'AED ', SGD: 'S$' };

const missing = (value) => value === null || value === undefined || value === '' || Number.isNaN(Number(value));

/** Indian grouping for rupees, western grouping for everything else. */
export function money(value, currency = 'INR') {
  if (missing(value)) return '—';
  const n = Number(value);
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  const digits = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.abs(n));
  return `${n < 0 ? '-' : ''}${SYMBOL[currency] ?? `${currency} `}${digits}`;
}

export const number = (value) => (missing(value) ? '—' : new Intl.NumberFormat('en-IN').format(Number(value)));

export const decimal = (value, digits = 1) =>
  missing(value) ? '—' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits }).format(Number(value));

export const percent = (value) => (missing(value) ? '—' : `${Math.round(Number(value) * 100)}%`);

/** [{ currency, amount }] side by side, never added across currencies. */
export const amounts = (list) => (list?.length ? list.map((a) => money(a.amount, a.currency)).join(' · ') : '—');

/** ₹2.41 Cr, ₹75.3 L, or the plain amount below one lakh. */
export function compactInr(value) {
  if (missing(value)) return '—';
  const n = Number(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (text) => text.replace(/\.?0+$/, '');
  if (abs >= 1e7) return `${sign}₹${trim((abs / 1e7).toFixed(2))} Cr`;
  if (abs >= 1e5) return `${sign}₹${trim((abs / 1e5).toFixed(1))} L`;
  return money(n);
}

/** "1 enquiry", "3 enquiries". */
export const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
