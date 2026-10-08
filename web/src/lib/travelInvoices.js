/**
 * The invoice that bills a trip to the client (#214 §5.2).
 *
 * The pure half of raising one: who may, which trips it may carry, what the
 * figures mean and what goes on the wire. Nothing here renders, so the rules
 * that decide whether a trip can be ticked are testable without a browser.
 *
 * ## The one thing to get right
 *
 * A travel invoice's amount is **typed, not derived**. It is its own printed
 * total and has nothing to do with the PO's value: ₹37,500 against a
 * ₹10,00,000 PO is ₹37,500, and the PO's 50/50 split is still 100% of the
 * order. The selected trips' cost is shown beside the field so the figure
 * can be checked against them, and it is never written into it — nothing
 * records how much of a trip was re-billed (#214 §9.4).
 */

/** A travel invoice is a payment stage of this kind. */
export const TRAVEL_KIND = 'travel';

/** How many trips one invoice may carry, matching the route's own cap. */
export const MAX_TRIPS_PER_INVOICE = 200;

/**
 * Who may raise one.
 *
 * Admin and sales, who own the PO side of a trip. HR runs the travel desk
 * and keeps the trips and the agency's bills, but raising a client invoice
 * is not its work (#214 §9.3) — the route is absent from HR_ROUTES, so the
 * server answers 403 whatever is drawn. This decides what to draw.
 */
export const mayRaiseTravelInvoice = ({ isAdmin, isHr } = {}) => Boolean(isAdmin) || !isHr;

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** Today, as the date input spells it. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/* --------------------------------------------------------- which trips */

/**
 * Why a trip cannot go on a travel invoice, or null when it can.
 *
 * `scope` is where the invoice is being raised: `{ projectId, poNumber }`.
 * With a PO, only that PO's trips are offered — an invoice raised against
 * one order should not quietly bill a trip taken for another.
 *
 * The server checks every one of these again against locked rows, and the
 * database's own trigger is the last word. These exist so a trip that
 * cannot be billed is visibly not offered, rather than refused after the
 * amount has been typed.
 */
export function tripBlockedReason(trip, scope = {}) {
  if (!trip?.chargeable) return 'Not a chargeable trip, so there is nothing to bill';
  if (trip.cancelled) return 'Cancelled';
  if (trip.billed_stage_id) {
    return `Already billed on ${trip.billed_invoice_no || 'another invoice'}`;
  }
  if (scope.poNumber && trip.po_number !== scope.poNumber) {
    return `On ${trip.po_number ? `PO ${trip.po_number}` : 'no PO'}, not ${scope.poNumber}`;
  }
  return null;
}

/** May this trip be ticked for this invoice? */
export const mayBillTrip = (trip, scope) => tripBlockedReason(trip, scope) === null;

/**
 * The trips a Raise travel invoice dialog should offer, eligible first.
 *
 * Blocked trips are kept rather than hidden, with their reason, so "why is
 * that trip not here?" is answered on the screen instead of becoming a
 * question. One already billed says which invoice has it.
 */
export function billableTrips(trips = [], scope = {}) {
  return trips
    .map((trip) => ({ trip, blocked: tripBlockedReason(trip, scope) }))
    .sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0));
}

/** What the ticked trips cost, for checking the amount against them. */
export function selectedCost(trips = [], ids) {
  const picked = new Set([...(ids || [])]);
  return trips
    .filter((t) => picked.has(t.travel_id))
    .reduce((sum, t) => sum + num(t.total_travel_cost), 0);
}

/* ---------------------------------------------------------- the form */

/**
 * What is wrong with the form, as the field errors the dialog shows.
 *
 * The server refuses the same things. The invoice date is allowed to be in
 * the past — an invoice raised last month is recorded this month — and is
 * refused in the future, because an invoice that has not been raised has no
 * number to record.
 */
export function validateTravelInvoice({ invoiceNo, invoiceDate, amount, creditDays, today = todayIso() } = {}) {
  const errors = {};
  if (!String(invoiceNo ?? '').trim()) errors.invoice_no = 'Give the invoice number';
  if (!String(invoiceDate ?? '').trim()) errors.invoice_date = 'Give the invoice date';
  else if (invoiceDate > today) errors.invoice_date = 'An invoice cannot be dated in the future';
  if (String(amount ?? '').trim() === '') errors.amount = 'Enter the invoice amount';
  else if (num(amount) <= 0) errors.amount = 'The invoice amount has to be more than zero';
  if (String(creditDays ?? '').trim() !== '' && num(creditDays) < 0) {
    errors.credit_days = 'Credit days cannot be negative';
  }
  return errors;
}

/** The body for POST /api/travel-invoices. */
export function travelInvoiceBody({
  projectId, poNumber, invoiceNo, invoiceDate, amount, creditDays, documentId, remarks, travelIds = [],
} = {}) {
  return {
    project_id: projectId,
    ...(poNumber ? { po_number: poNumber } : {}),
    invoice_no: String(invoiceNo ?? '').trim(),
    invoice_date: invoiceDate,
    amount: num(amount),
    ...(String(creditDays ?? '').trim() === '' ? {} : { credit_days: num(creditDays) }),
    ...(documentId ? { document_id: documentId } : {}),
    ...(remarks?.trim() ? { remarks: remarks.trim() } : {}),
    travel_ids: [...travelIds],
  };
}

/* ------------------------------------------------- reading one back */

/**
 * The travel invoices a trip may be billed on.
 *
 * One rule, the same one the database applies: a travel invoice raised for
 * this trip's project, where a project is the record's own or its PO's. An
 * ordinary PO stage is never a candidate — that is what 097 closed.
 */
export function billableInvoices(stages = [], trip = {}) {
  const tripProject = trip.project_id ?? null;
  return stages.filter((s) => s.kind === TRAVEL_KIND
    && (tripProject === null || s.project_id === tripProject));
}

/** The chip that tells a travel invoice from a share of a PO. */
export const travelChip = () => ({ label: 'Travel', tone: 'plain' });

/**
 * One travel invoice as a row reads it.
 *
 * `stage_amount` is the server's figure — `amount` for a travel invoice —
 * so nothing here multiplies anything by a PO value.
 */
export function travelInvoiceRow(stage) {
  return {
    id: stage.id,
    invoiceNo: stage.invoice_no,
    invoiceDate: stage.invoice_date,
    amount: num(stage.stage_amount ?? stage.amount),
    received: num(stage.amount_received),
    status: stage.stage_status,
    documentId: stage.document_id ?? null,
    poNumber: stage.po_number ?? null,
    projectId: stage.project_id ?? null,
    tripCount: stage.trip_count === undefined || stage.trip_count === null ? null : Number(stage.trip_count),
  };
}

/** What a list of travel invoices adds up to. */
export function travelInvoiceTotals(stages = []) {
  return stages.reduce(
    (totals, s) => ({
      count: totals.count + 1,
      invoiced: totals.invoiced + num(s.stage_amount ?? s.amount),
      received: totals.received + num(s.amount_received),
    }),
    { count: 0, invoiced: 0, received: 0 }
  );
}
