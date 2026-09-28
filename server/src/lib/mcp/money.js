/**
 * The two money questions nothing else answered (#140): what is up for
 * renewal, and when is cash expected.
 *
 * Both read the libs the pages read — lib/renewals.js and lib/cashflow.js —
 * so a figure here and a figure on screen are the same figure. Neither
 * recomputes anything.
 */
import { renewalsList } from '../renewals.js';
import { cashflow } from '../cashflow.js';
import { isAdmin } from './data.js';
import { page } from './data.js';

/**
 * Engagements and their renewal state, soonest due first.
 *
 * Scoped in SQL to the engagement's own owner, or the salesperson on the
 * quotation it was created from — an engagement comes from a won deal and
 * inherits that relationship. An engagement with neither is nobody's and
 * shows to nobody but an admin, which is the safe reading of "I cannot say
 * whose this is".
 */
export async function listRenewals(scope, { status, within_days: withinDays, limit, offset } = {}) {
  const win = page({ limit, offset });
  const { rows, totals } = await renewalsList({ status, owner: isAdmin(scope) ? null : scope.person || '\u0000' });

  let items = rows;
  if (withinDays !== undefined && withinDays !== null) {
    const n = Number(withinDays);
    items = items.filter((r) => r.days_to_due !== null && r.days_to_due <= n);
  }
  const shown = items.slice(win.offset, win.offset + win.limit).map((r) => ({
    engagement_id: r.id,
    client: r.company_name,
    service: r.service_name ?? null,
    status: r.status,
    next_due_on: r.next_due_on,
    days_to_due: r.days_to_due,
    overdue: r.days_to_due !== null && r.days_to_due < 0,
    original_quotation_no: r.original_quotation_no,
    renewal_quotation_no: r.renewal_quotation_no,
    renewal_status: r.renewal_status,
    renewal_value: r.renewal_value === null || r.renewal_value === undefined ? null : Number(r.renewal_value),
    renewal_currency: r.renewal_currency,
    owner: r.owner ?? r.quotation_owner ?? null,
  }));
  return {
    items: shown,
    total: items.length,
    offset: win.offset,
    limit: win.limit,
    has_more: win.offset + shown.length < items.length,
    // The cards' counts, which are of every engagement rather than of this
    // token's — said so, rather than quietly meaning something else.
    counts_all_engagements: totals,
  };
}

/**
 * Cash expected in and going out, by month.
 *
 * Admin only. This is the company's cash position: every unpaid stage, the
 * weighted pipeline, what we owe travel vendors and what we owe staff in
 * expenses, in one number per month. There is no salesperson on a cash
 * forecast to scope it by, and the honest answer to "whose is this?" is
 * "the company's". The same #89 decision governs it as the Payables page.
 *
 * `detail` is off by default: the forecast carries an item line for every
 * unpaid stage, invoice, deal, vendor bill and claim, which for a live book
 * is thousands of lines and not what "when is money coming in?" asks.
 */
export async function getCashflow(scope, { months, detail = false } = {}) {
  if (!isAdmin(scope)) {
    const err = new Error('Only an admin token may read the cash forecast.');
    err.status = 403;
    throw err;
  }
  const f = await cashflow({ months });
  return {
    today: f.today,
    months: f.months.map((m) => ({
      month: m.month,
      received: round(m.received),
      invoiced: round(m.invoiced),
      scheduled: round(m.scheduled),
      pipeline: round(m.pipeline),
      inflow: round(m.inflow),
      inflow_with_pipeline: round(m.inflow_with_pipeline),
      vendors: round(m.vendors),
      claims: round(m.claims),
      outflow: round(m.outflow),
      net: round(m.net),
      lines: m.items.length,
      ...(detail ? { items: m.items.slice(0, 25) } : {}),
    })),
    currency: 'INR',
    // Amounts in other currencies are listed rather than converted, which
    // is what the page does: a forecast that silently applied a rate would
    // be a different number every day for the same book.
    foreign: f.foreign,
    reads: 'invoiced = billed and unpaid; scheduled = not yet billed, dated from the PO terms; pipeline = open deals at their weighted value. "later" is beyond the window, "unscheduled" has no date to place it on.',
  };
}

const round = (n) => Math.round(Number(n || 0) * 100) / 100;
