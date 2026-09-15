const SYMBOL = { INR: '₹', EUR: '€', USD: '$', GBP: '£', AED: 'AED ', SGD: 'S$' };

/** Indian grouping for rupees, western grouping for everything else. */
export function money(value, currency = 'INR', { compact = false } = {}) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';

  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  if (compact && Math.abs(n) >= 100000) {
    return `${SYMBOL[currency] ?? ''}${new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n)}`;
  }
  return `${SYMBOL[currency] ?? ''}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)}`;
}

export function number(value) {
  if (value === null || value === undefined || value === '') return '—';
  return new Intl.NumberFormat('en-IN').format(Number(value));
}

export function fileSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return '—';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${Number((n / 1024 / 1024).toFixed(1))} MB`;
}

export function percent(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function date(value) {
  if (!value) return '—';
  const [y, m, d] = String(value).slice(0, 10).split('-');
  if (!y || !m || !d) return String(value);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

/** Map any status string in the app onto one of four visual tones. */
export function toneFor(status) {
  if (!status) return 'neutral';
  const s = String(status).toLowerCase();
  if (/overdue|rejected|lost|declined/.test(s)) return 'danger';
  if (/to invoice|to pay|invoicing pending|pending|partly|partially|on hold|awaited|enter amount|to reimburse|due/.test(s))
    return 'warning';
  if (/paid|reimbursed|done|won|delivered|up to date|on time|no dues/.test(s)) return 'success';
  if (/in progress|submitted|under negotiation|onboarding/.test(s)) return 'info';
  return 'neutral';
}
