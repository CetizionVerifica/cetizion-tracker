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
