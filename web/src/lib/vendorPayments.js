/**
 * Paying a travel agency, and putting a payment right (#214).
 *
 * The pure half of the vendor payment screens: who may do what, what the
 * figures in the form mean, and what goes on the wire. The dialogs in
 * `components/vendorPayments.jsx` draw it; nothing here renders, so the
 * arithmetic that decides whether a warning appears is testable without a
 * browser.
 *
 * ## The one thing to get right
 *
 * The server's `amount_paid` on POST /vendor-invoices/:id/pay is the
 * **settlement total** — cash plus tax deducted — and it writes the row as
 * `amount = amount_paid - tds_amount`. The invoice's own `amount_paid`
 * column is the same figure, kept by a trigger over the ledger.
 *
 * So a 100,000 bill paid by a 90,000 transfer with 10,000 deducted is
 * `amount_paid: 100000, tds_amount: 10000`, and the bill is paid in full.
 *
 * The form therefore asks for the two things somebody actually knows — what
 * left the bank, and what was deducted — and adds them. It never asks for a
 * total and never adds what is already paid to what is being typed, which is
 * how the figure gets counted twice.
 */

/** Every mode the server accepts, in the order the business uses them. */
export const VENDOR_PAYMENT_MODES = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'upi', label: 'UPI' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Card' },
  { value: 'other', label: 'Other' },
];

/* ------------------------------------------------------------------ who */

/**
 * Who may settle an agency bill, and who may say a settlement was wrong.
 *
 * Paying the agency is the travel desk's work, so HR has it and so does an
 * administrator. Deciding a payment already recorded was wrong is a
 * different act and only an administrator's — the same split the server
 * enforces with `requireRole('admin', 'hr')` and `requireAdmin`.
 *
 * These decide what to *draw*. The server checks the role again on every
 * request, so a hidden button is a courtesy and never the boundary.
 */
export const mayRecordVendorPayment = ({ isAdmin, isHr } = {}) => Boolean(isAdmin || isHr);
export const mayCorrectVendorPayment = ({ isAdmin } = {}) => Boolean(isAdmin);

/**
 * Who may read how the business paid a vendor.
 *
 * The same two roles. A sales user may open the invoice — that did not
 * change — but the UTR, the method, the bank advice and any correction are
 * not theirs, and the server leaves `payments` out of the reply for them
 * rather than trusting this.
 */
export const maySeeVendorPayments = ({ isAdmin, isHr } = {}) => Boolean(isAdmin || isHr);

/* -------------------------------------------------------------- figures */

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** What a payment settles: the transfer plus whatever was deducted. */
export const settlementOf = ({ transferred, tds } = {}) => num(transferred) + num(tds);

/**
 * What the bill stands at, and what this payment would make it.
 *
 * `netPayable` is the invoice less its credit notes, and null while the
 * invoice has no amount. `settled` is the invoice's `amount_paid`, which the
 * ledger trigger keeps as cash plus TDS.
 */
export function settlementState({ netPayable, settled, transferred, tds } = {}) {
  const payable = netPayable === null || netPayable === undefined ? null : num(netPayable);
  const before = num(settled);
  const settles = settlementOf({ transferred, tds });
  const after = before + settles;
  return {
    netPayable: payable,
    settledBefore: before,
    settles,
    settledAfter: after,
    outstanding: payable === null ? null : Math.max(payable - before, 0),
    // Allowed — an advance, a rounding, a currency difference — so it is a
    // figure to warn about rather than a reason to refuse. Nothing clamps it.
    overBy: payable === null ? 0 : Math.max(after - payable, 0),
  };
}

/** The ledger's two legs, for a history that does not call TDS cash. */
export function paymentTotals(payments = []) {
  return payments.reduce(
    (totals, p) => ({
      cash: totals.cash + num(p.amount),
      tds: totals.tds + num(p.tds_amount),
      settled: totals.settled + num(p.amount) + num(p.tds_amount),
    }),
    { cash: 0, tds: 0, settled: 0 }
  );
}

/**
 * What one entry settles.
 *
 * `/full` sends `settles` already worked out, so that is the figure used and
 * the sum is only the fallback for a caller that did not come from there.
 * One arithmetic, and it is the server's.
 */
export const settlesOf = (payment) =>
  payment?.settles === null || payment?.settles === undefined
    ? num(payment?.amount) + num(payment?.tds_amount)
    : num(payment.settles);

/**
 * A correction reads as an adjustment, never as a payment.
 *
 * The ledger is appended to, so a correction is a row like any other and is
 * told apart by its reason. A reversal is negative; putting a split right
 * leaves the total alone and moves the legs against each other.
 */
export const isCorrection = (payment) => Boolean(payment?.correction_reason);

export function correctionShape(payment) {
  if (!isCorrection(payment)) return null;
  const settles = settlesOf(payment);
  if (settles < 0) return 'reversal';
  if (settles > 0) return 'increase';
  return 'recomposition';
}

/* ------------------------------------------------------------- the form */

/** Today, as the date input spells it. Payments happened; they are not planned. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * What is wrong with the form, as the field errors the dialog shows.
 *
 * The server refuses the same things. These exist so a mistake is a message
 * beside the field rather than a 422 after a round trip — and, for the date,
 * so a future one cannot be submitted at all.
 */
export function validatePayment({ transferred, tds, paidOn, today = todayIso() } = {}) {
  const errors = {};
  const cash = num(transferred);
  const deducted = num(tds);

  if (String(transferred ?? '').trim() === '' && String(tds ?? '').trim() === '') {
    errors.amount_paid = 'Give what was transferred, or the tax deducted';
  } else if (cash + deducted <= 0) {
    errors.amount_paid = 'A payment has to settle something';
  }
  if (cash < 0) errors.amount_paid = 'A transfer cannot be negative. To take a payment back off the bill, correct it';
  if (deducted < 0) errors.tds_amount = 'Tax deducted cannot be negative';
  if (paidOn && paidOn > today) errors.payment_date = 'A payment cannot be dated in the future';

  return errors;
}

/** The body for POST /vendor-invoices/:id/pay. */
export function payBody({ transferred, tds, paidOn, paymentMode, reference, remarks, documentId } = {}) {
  const deducted = num(tds);
  return {
    // The settlement total, which is what this route's `amount_paid` means.
    amount_paid: settlementOf({ transferred, tds }),
    // `add` so the figure typed is this transfer and nothing adds the
    // invoice's existing total to it.
    mode: 'add',
    ...(deducted > 0 ? { tds_amount: deducted } : {}),
    ...(paidOn ? { payment_date: paidOn } : {}),
    ...(paymentMode ? { payment_mode: paymentMode } : {}),
    ...(reference?.trim() ? { reference: reference.trim() } : {}),
    ...(remarks?.trim() ? { remarks: remarks.trim() } : {}),
    ...(documentId ? { document_id: documentId } : {}),
  };
}

/* -------------------------------------------------------- a correction */

/**
 * What is wrong with a correction.
 *
 * Both legs are signed on purpose: this is the one route that may take money
 * back off a bill, and either leg may move. The reason cannot be left out —
 * the server refuses without it, and the point of the route is that somebody
 * said why.
 */
export function validateCorrection({ amount, tds, reason, paidOn, today = todayIso() } = {}) {
  const errors = {};
  const cash = num(amount);
  const deducted = num(tds);

  if (cash === 0 && deducted === 0) {
    errors.amount = 'Give the amount, the tax deducted, or both to correct';
  }
  if (!String(reason ?? '').trim()) errors.reason = 'Say why this is being corrected';
  if (paidOn && paidOn > today) errors.paid_on = 'A correction cannot be dated in the future';

  return errors;
}

/** The body for POST /vendor-invoices/:id/pay/correct. */
export function correctionBody({ amount, tds, reason, paidOn, paymentMode, reference, documentId } = {}) {
  const cash = num(amount);
  const deducted = num(tds);
  return {
    ...(cash !== 0 ? { amount: cash } : {}),
    ...(deducted !== 0 ? { tds_amount: deducted } : {}),
    reason: String(reason ?? '').trim(),
    ...(paidOn ? { paid_on: paidOn } : {}),
    ...(paymentMode ? { payment_mode: paymentMode } : {}),
    ...(reference?.trim() ? { reference: reference.trim() } : {}),
    ...(documentId ? { document_id: documentId } : {}),
  };
}

/**
 * What a correction would do to the bill, for the sentence above the button.
 *
 * A negative total is the case worth confirming: a figure the business had
 * booked goes down, which is the reason this route is an administrator's.
 */
export function correctionEffect({ amount, tds, settled, netPayable } = {}) {
  const delta = num(amount) + num(tds);
  const before = num(settled);
  const payable = netPayable === null || netPayable === undefined ? null : num(netPayable);
  return {
    delta,
    settledBefore: before,
    settledAfter: before + delta,
    lowers: delta < 0,
    // Moving the legs against each other: the bill settles the same, the
    // split between cash and deduction is what changes.
    recomposes: delta === 0,
    overBy: payable === null ? 0 : Math.max(before + delta - payable, 0),
  };
}

/* ------------------------------------------------- one transfer, many bills */

/**
 * Paying a travel agency monthly: one transfer, several of its bills (#214 §2.6).
 *
 * The agency sends a bill per trip and is paid once a month, so the bulk case
 * is the ordinary one and the single payment is the exception. What makes it
 * safe is that nothing new is invented: each bill still gets its own ledger
 * row with its own amount and its own TDS, and the transfer's date, method,
 * reference and advice are simply shared by all of them.
 *
 * Two rules are worth stating because they are the ones a reader will look
 * for:
 *
 *   - **One agency per transfer.** The server proves it against the locked
 *     rows; everything here exists so that a mixed selection cannot be made
 *     in the first place, and says why rather than failing at submit.
 *   - **No bulk correction.** Every figure below is non-negative. Taking
 *     money back off a bill is an administrator's correction with a reason,
 *     one bill at a time.
 */

/**
 * How many bills one transfer may settle, matching MAX_BATCH_ALLOCATIONS on
 * the server. The dialog refuses past this so the limit is a sentence before
 * the request rather than a 422 after it.
 */
export const MAX_BULK_VENDOR_INVOICES = 50;

/**
 * Who may record one transfer over several bills.
 *
 * The same two roles as a single payment, and for the same reason: paying the
 * agency is the travel desk's work and the administrator's. Sales may read a
 * bill and may not pay it, in bulk no more than singly. The server checks the
 * role again, so the absent checkbox is a courtesy and never the boundary.
 */
export const mayBulkPayVendorInvoices = ({ isAdmin, isHr } = {}) => Boolean(isAdmin || isHr);

/** The agency a bill belongs to, as the batch route proves sameness by. */
export const vendorKeyOf = (invoice) =>
  invoice?.vendor_id === null || invoice?.vendor_id === undefined ? null : Number(invoice.vendor_id);

/** What still has to be paid on a bill, or null while it has no amount. */
export function outstandingOf(invoice) {
  const payable = invoice?.net_payable ?? invoice?.invoice_amount ?? null;
  if (payable === null || payable === undefined) return null;
  return Math.max(num(payable) - num(invoice?.amount_paid), 0);
}

/**
 * Why a bill cannot join the selection as it stands, or null when it can.
 *
 * `selection` is what is already picked: `{ vendorId, vendorName, count }`.
 * A bill already in the selection is never refused — the reason is for rows
 * being offered, and a selected row can always be unticked.
 *
 * Said as a sentence rather than a code, because it is shown next to the
 * disabled checkbox. Discovering the one-vendor rule only after submit is
 * exactly what this avoids.
 */
export function bulkBlockedReason(invoice, selection = {}) {
  const vendorId = vendorKeyOf(invoice);
  if (vendorId === null) {
    return 'This bill has no agency on it, so it cannot be proved to belong to the same one.';
  }
  if (invoice?.invoice_amount === null || invoice?.invoice_amount === undefined) {
    return 'This bill has no amount yet. Enter the amount on the invoice first.';
  }
  if (invoice?.payment_status === 'Paid') {
    return 'This bill is already settled.';
  }
  if (selection.vendorId !== null && selection.vendorId !== undefined && selection.vendorId !== vendorId) {
    return `Bulk payments can contain invoices from one vendor only — this transfer is for ${selection.vendorName || 'another agency'}.`;
  }
  if (Number(selection.count) >= MAX_BULK_VENDOR_INVOICES) {
    return `One transfer may settle at most ${MAX_BULK_VENDOR_INVOICES} bills. Record the rest as a second transfer.`;
  }
  return null;
}

/** May this bill be ticked right now? */
export const mayJoinBulk = (invoice, selection) => bulkBlockedReason(invoice, selection) === null;

/**
 * What a set of ticked bills amounts to.
 *
 * `ids` is whatever the page is holding; `rows` is the bills themselves. The
 * vendor is read off the selection rather than asked for, which is what makes
 * the first tick decide it and every later row be measured against it.
 */
export function bulkSelection(rows = [], ids) {
  const picked = new Set([...(ids || [])].map(Number));
  const invoices = rows.filter((row) => picked.has(Number(row?.id)));
  const first = invoices[0];
  const outstanding = invoices.reduce((sum, row) => sum + num(outstandingOf(row)), 0);
  return {
    invoices,
    count: invoices.length,
    vendorId: first ? vendorKeyOf(first) : null,
    vendorName: first?.travel_vendor ?? null,
    outstanding,
    atLimit: invoices.length >= MAX_BULK_VENDOR_INVOICES,
  };
}

/**
 * What a row of the allocation table starts at.
 *
 * The balance, because that is what paying a bill means and it is the figure
 * the person would otherwise copy across by hand; TDS blank, because a
 * deduction is something they know and not something to guess. Nothing
 * spreads a lump sum across the bills by a rule nobody asked for (#214 §20):
 * every allocation is visible and editable before the transfer is recorded.
 */
export function allocationDefaults(invoice) {
  const outstanding = outstandingOf(invoice);
  return { transferred: outstanding === null ? '' : String(outstanding), tds: '' };
}

/** One row of the allocation table, with what it would do to its bill. */
export function allocationRow({ invoice, transferred, tds } = {}) {
  const state = settlementState({
    netPayable: invoice?.net_payable ?? invoice?.invoice_amount ?? null,
    settled: invoice?.amount_paid,
    transferred,
    tds,
  });
  return { invoice, transferred, tds, ...state };
}

/** The three figures the dialog shows, and how many bills go over. */
export function bulkTotals(allocations = []) {
  return allocations.reduce(
    (totals, row) => {
      const state = row.settles === undefined ? allocationRow(row) : row;
      return {
        transferred: totals.transferred + num(state.transferred),
        tds: totals.tds + num(state.tds),
        settled: totals.settled + num(state.settles),
        overpaid: totals.overpaid + (state.overBy > 0 ? 1 : 0),
        overBy: totals.overBy + num(state.overBy),
      };
    },
    { transferred: 0, tds: 0, settled: 0, overpaid: 0, overBy: 0 }
  );
}

/**
 * What is wrong with the transfer, as the dialog shows it.
 *
 * `form` is the shared half; `rows` is keyed by the bill's id, so a mistake
 * lands beside the field it is in rather than at the top of a table of
 * twelve. The server refuses the same things, including the date.
 */
export function validateBulkPayment({ allocations = [], paidOn, today = todayIso() } = {}) {
  const form = {};
  const rows = {};

  if (allocations.length === 0) form.allocations = 'Choose at least one bill for this transfer to settle';
  if (allocations.length > MAX_BULK_VENDOR_INVOICES) {
    form.allocations = `One transfer may settle at most ${MAX_BULK_VENDOR_INVOICES} bills. Record the rest as a second transfer.`;
  }
  const vendors = new Set(allocations.map(({ invoice }) => vendorKeyOf(invoice)));
  if (vendors.size > 1) form.allocations = 'Bulk payments can contain invoices from one vendor only';
  if (paidOn && paidOn > today) form.payment_date = 'A payment cannot be dated in the future';

  for (const { invoice, transferred, tds } of allocations) {
    const found = validatePayment({ transferred, tds, paidOn: null, today });
    // The shared date is checked once, above; a per-row date does not exist.
    delete found.payment_date;
    if (Object.keys(found).length) rows[invoice.id] = found;
  }

  return { form, rows, ok: Object.keys(form).length === 0 && Object.keys(rows).length === 0 };
}

/**
 * The body for POST /vendor-payments/batch.
 *
 * `amount` is the cash that left the bank for that bill and `tds_amount` is
 * what was deducted — the two ledger columns, as the batch route takes them.
 * It is not the settlement total: that is `/vendor-invoices/:id/pay`'s older
 * shape, kept there because its callers predate the ledger.
 */
export function bulkPayBody({ allocations = [], paidOn, paymentMode, reference, remarks, documentId } = {}) {
  return {
    ...(paidOn ? { payment_date: paidOn } : {}),
    ...(paymentMode ? { payment_mode: paymentMode } : {}),
    ...(reference?.trim() ? { reference: reference.trim() } : {}),
    ...(remarks?.trim() ? { remarks: remarks.trim() } : {}),
    ...(documentId ? { document_id: documentId } : {}),
    allocations: allocations.map(({ invoice, transferred, tds }) => {
      const deducted = num(tds);
      return {
        vendor_invoice_id: Number(invoice.id),
        amount: num(transferred),
        ...(deducted > 0 ? { tds_amount: deducted } : {}),
      };
    }),
  };
}

/**
 * The success line, from the server's own totals.
 *
 * `meta` is what POST /vendor-payments/batch returned. Nothing is recomputed
 * from the form: the server had the ledger and the credit notes as they stood
 * after the write, and the screen should say what was actually recorded.
 */
export function bulkResultSummary(meta, format = (n) => String(n)) {
  if (!meta) return null;
  const count = Number(meta.count) || 0;
  return {
    line: `${count} vendor ${count === 1 ? 'invoice' : 'invoices'} updated · ${format(meta.transferred)} transferred · ${format(meta.tds)} TDS`,
    overpaid: Number(meta.overpaid) || 0,
    overBy: Number(meta.over_payable) || 0,
  };
}

/* ------------------------------------------------------- agency status */

/**
 * The agency side of a trip, as the backing view already decides it.
 *
 * `vendor_invoice_status` on `v_travel_logs` is the derived status, and
 * `payment_status` on `v_travel_vendor_invoices` is one bill's. Neither is
 * recomputed here: this maps the exact strings those views emit onto a tone
 * and prefixes the word "Agency", so a trip's chip cannot be mistaken for
 * what the client owes us.
 */
export const AGENCY_TRIP_STATUSES = [
  'Awaiting travel',
  'Invoice awaited',
  'Invoice OVERDUE from vendor',
  'Vendor to pay',
  'Vendor partly paid',
  'Vendor paid',
];

export const VENDOR_INVOICE_STATUSES = [
  'Awaited',
  'Enter amount',
  'Enter date',
  'To Pay',
  'Partially Paid',
  'Overdue',
  'Paid',
];

const AGENCY_TRIP_CHIPS = {
  'Awaiting travel': { label: 'Agency: awaiting travel', tone: 'plain' },
  'Invoice awaited': { label: 'Agency: invoice awaited', tone: 'waiting' },
  'Invoice OVERDUE from vendor': { label: 'Agency: invoice overdue', tone: 'late' },
  'Vendor to pay': { label: 'Agency: to pay', tone: 'waiting' },
  'Vendor partly paid': { label: 'Agency: partly paid', tone: 'waiting' },
  'Vendor paid': { label: 'Agency: paid', tone: 'settled' },
};

const VENDOR_INVOICE_CHIPS = {
  Awaited: { label: 'Agency: invoice awaited', tone: 'waiting' },
  'Enter amount': { label: 'Agency: amount needed', tone: 'waiting' },
  'Enter date': { label: 'Agency: date needed', tone: 'waiting' },
  'To Pay': { label: 'Agency: to pay', tone: 'waiting' },
  'Partially Paid': { label: 'Agency: partly paid', tone: 'waiting' },
  Overdue: { label: 'Agency: overdue', tone: 'late' },
  Paid: { label: 'Agency: paid', tone: 'settled' },
};

/** A trip's agency chip, or null when the view gave no status. */
export const agencyTripChip = (status) => (status ? AGENCY_TRIP_CHIPS[status] ?? { label: `Agency: ${status}`, tone: 'plain' } : null);

/** One bill's agency chip, or null when the view gave no status. */
export const agencyInvoiceChip = (status) => (status ? VENDOR_INVOICE_CHIPS[status] ?? { label: `Agency: ${status}`, tone: 'plain' } : null);
