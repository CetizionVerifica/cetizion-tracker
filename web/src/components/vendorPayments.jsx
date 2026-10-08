import { useState } from 'react';
import { FileText, Undo2 } from 'lucide-react';
import { Alert, Field, Input, Select, Textarea, useToast } from './ui.jsx';
import { ActionModal, useAction } from './actionModal.jsx';
import { Chip, RecordSection } from './record.jsx';
import { api } from '../lib/api.js';
import { useDocumentUploads } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';
import {
  VENDOR_PAYMENT_MODES, allocationDefaults, allocationRow, bulkPayBody, bulkResultSummary, bulkTotals,
  correctionBody, correctionEffect, correctionShape, isCorrection,
  payBody, paymentTotals, settlementState, settlesOf, todayIso, validateBulkPayment, validateCorrection,
  validatePayment,
} from '../lib/vendorPayments.js';

/**
 * Settling a travel agency, and putting a settlement right (#214).
 *
 * One dialog records a payment, wherever it is opened from — the vendor
 * invoice list, the invoice itself, a trip, the worklist or ⌘K. There is no
 * second vendor payment form anywhere in the app, which is the point: the
 * figure means one thing and the TDS is asked for in one place.
 *
 * The arithmetic and the wire format live in `lib/vendorPayments.js`.
 */

/** Documents a payment proof may be: what the repo already stores inline. */
const PROOF_HINT = 'Optional: the bank advice, UTR slip or cheque image (PDF or image)';

/** A payment proof belongs to the agency bill it settles. */
const PROOF_OWNER = 'vendor-invoices';

/* ------------------------------------------------------- record a payment */

/**
 * `invoice` is a row of `v_travel_vendor_invoices`, from any of the screens
 * that list or show one. Its `amount_paid` is what the ledger settles — cash
 * plus tax deducted — because a trigger keeps it that way, so it is the
 * figure to read and never a figure to add to.
 */
export function PayVendorDialog({ invoice, onClose, onDone }) {
  const [transferred, setTransferred] = useState('');
  const [tds, setTds] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [paymentMode, setPaymentMode] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [proof, setProof] = useState(null);
  const [local, setLocal] = useState({});
  const uploadDocument = useDocumentUploads();
  const toast = useToast();
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Vendor payment recorded' });

  const state = settlementState({
    netPayable: invoice.net_payable ?? invoice.invoice_amount ?? null,
    settled: invoice.amount_paid,
    transferred,
    tds,
  });
  const noAmount = invoice.invoice_amount === null || invoice.invoice_amount === undefined;
  const errors = { ...local, ...fieldErrors };

  const submit = async (event) => {
    event.preventDefault();
    const found = validatePayment({ transferred, tds, paidOn });
    setLocal(found);
    if (Object.keys(found).length) return;

    let reply = null;
    const ok = await run(async () => {
      // Uploaded first, then named on the payment. An upload nothing points
      // at is what the daily purge of unattached documents is for, so a
      // failed submit leaves no file to clean up by hand.
      const documentId = proof ? await uploadDocument(proof, PROOF_OWNER) : null;
      reply = await api.action(`/vendor-invoices/${invoice.id}/pay`, payBody({
        transferred, tds, paidOn, paymentMode, reference, remarks, documentId,
      }));
      return reply;
    });
    // The server's own figure, not the form's: it has the ledger and the
    // credit notes as they stand after the write.
    if (ok && Number(reply?.meta?.over_payable) > 0) {
      toast(`Recorded. This bill now settles ${money(reply.meta.over_payable)} more than it is payable.`, 'warning');
    }
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Record a payment to the agency"
      subtitle={`${invoice.travel_vendor || 'Vendor'} · ${invoice.vendor_invoice_no || invoice.vendor_invoice_id}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Record payment"
      submitDisabled={noAmount}
    >
      {noAmount ? (
        <Alert tone="warning">
          This bill has no amount yet, so there is nothing to settle against. Enter the amount on the invoice first.
        </Alert>
      ) : (
        <Alert>
          Payable {money(state.netPayable)}
          {Number(invoice.credited) > 0 && <> (after {money(invoice.credited)} in credit notes)</>}
          {' · '}settled so far {money(state.settledBefore)}
          {' · '}still to pay <strong>{money(state.outstanding)}</strong>
          {invoice.pay_by && <> · due by {date(invoice.pay_by)}</>}
        </Alert>
      )}

      {invoice.trip_count > 1 && (
        <Alert tone="info">
          This payment settles the agency&apos;s bill, not one trip: the bill covers {invoice.trip_count} trips.
        </Alert>
      )}

      <div className="form-grid">
        <Field
          label="Amount transferred"
          required
          hint="What actually left the bank"
          error={errors.amount_paid}
        >
          <Input type="number" min="0" step="0.01" inputMode="decimal" value={transferred} onChange={(e) => setTransferred(e.target.value)} autoFocus />
        </Field>
        <Field label="TDS deducted" hint="Settles the bill without reaching the agency" error={errors.tds_amount}>
          <Input type="number" min="0" step="0.01" inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} />
        </Field>
      </div>

      {state.settles > 0 && (
        <Alert tone="info">
          This payment settles <strong>{money(state.settles)}</strong>
          {Number(tds) > 0 && <> — {money(transferred)} transferred and {money(tds)} deducted at source</>}
          . The bill will stand at {money(state.settledAfter)} of {money(state.netPayable)}.
        </Alert>
      )}

      {/* Allowed, and said plainly before the button is pressed. Nothing
          here blocks it or quietly reduces the figure. */}
      {state.overBy > 0 && (
        <Alert tone="warning">
          <strong>This payment will settle {money(state.overBy)} more than the payable amount.</strong>
          {' '}The bill is payable at {money(state.netPayable)} and this would take it to {money(state.settledAfter)}.
          Record it anyway if that is right — an advance, a rounding or a currency difference — otherwise check the figures.
        </Alert>
      )}

      <div className="form-grid">
        <Field label="Paid on" error={errors.payment_date}>
          {/* A payment is something that happened, so today is the latest
              date the picker will offer, and the server refuses a later
              one regardless. Bills already carrying a future date are left
              exactly as they are. */}
          <Input type="date" max={todayIso()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="How it was paid" error={errors.payment_mode}>
          <Select value={paymentMode} placeholder={null} options={VENDOR_PAYMENT_MODES} onChange={(e) => setPaymentMode(e.target.value)} />
        </Field>
        <div className="span-all">
          <Field label="Reference" hint="UTR, cheque number or transaction id" error={errors.reference}>
            <Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </div>

      <Field label="Payment proof" hint={PROOF_HINT} error={errors.document_id}>
        <Input type="file" onChange={(e) => setProof(e.target.files?.[0] || null)} />
      </Field>

      <Field label="Remarks" error={errors.remarks}>
        <Textarea rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>
    </ActionModal>
  );
}

/* ------------------------------------------------ one transfer, many bills */

/**
 * Settle several of one agency's bills with one transfer (#214 §2.6).
 *
 * An agency is paid monthly, so this is the ordinary way the business pays
 * one: one bank transfer, one UTR, one advice, a dozen bills closed. Each
 * bill still receives its own ledger row with its own amount and its own
 * TDS — the transfer's date, method, reference and proof are simply shared
 * by all of them, which is what the shared fields above the table mean.
 *
 * ## What it does not do
 *
 * It does not spread a lump sum across the bills by any rule of its own
 * (#214 §20). Each row starts at that bill's balance and every figure is
 * visible and editable before the button is pressed, because the person
 * recording the transfer is the one who knows how the bank split it.
 *
 * It does not correct anything. Every figure here is non-negative; taking
 * money back off a bill is an administrator's correction with a reason, one
 * bill at a time.
 *
 * ## All of it or none of it
 *
 * The server writes the batch in one transaction. A refusal means no bill
 * moved, so this keeps what was typed and shows the server's own message
 * rather than reporting a partial success that did not happen.
 */
export function BulkPayVendorDialog({ invoices = [], onClose, onDone }) {
  const [rows, setRows] = useState(() =>
    Object.fromEntries(invoices.map((invoice) => [invoice.id, allocationDefaults(invoice)])));
  const [paidOn, setPaidOn] = useState(todayIso());
  const [paymentMode, setPaymentMode] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [remarks, setRemarks] = useState('');
  const [proof, setProof] = useState(null);
  const [local, setLocal] = useState({ form: {}, rows: {} });
  // Bills going past their payable amount are confirmed before the transfer
  // is sent, not explained after it.
  const [armed, setArmed] = useState(false);
  const uploadDocument = useDocumentUploads();
  const toast = useToast();
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: null });

  const vendor = invoices[0]?.travel_vendor || 'the agency';
  const allocations = invoices.map((invoice) => allocationRow({ invoice, ...rows[invoice.id] }));
  const totals = bulkTotals(allocations);
  const outstanding = allocations.reduce((sum, row) => sum + Number(row.outstanding || 0), 0);

  const setRow = (id, field, value) => {
    setRows((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
    setArmed(false);
  };

  const submit = async (event) => {
    event.preventDefault();
    const found = validateBulkPayment({ allocations, paidOn });
    setLocal(found);
    if (!found.ok) return;
    if (totals.overpaid > 0 && !armed) {
      setArmed(true);
      return;
    }

    let reply = null;
    const ok = await run(async () => {
      // One upload for one transfer: the advice proves the transfer, and
      // every row written points at the same document rather than the file
      // being uploaded once per bill.
      const documentId = proof ? await uploadDocument(proof, PROOF_OWNER) : null;
      reply = await api.action('/vendor-payments/batch', bulkPayBody({
        allocations, paidOn, paymentMode, reference, remarks, documentId,
      }));
      return reply;
    });
    if (!ok) return;

    // The server's figures, not the form's: it had the ledger and the credit
    // notes as they stood after the write.
    const summary = bulkResultSummary(reply?.meta, money);
    if (summary) {
      toast(
        summary.overpaid > 0
          ? `${summary.line}. ${summary.overpaid} ${summary.overpaid === 1 ? 'bill now settles' : 'bills now settle'} ${money(summary.overBy)} more than payable.`
          : summary.line,
        summary.overpaid > 0 ? 'warning' : 'success'
      );
    }
    onClose();
  };

  const errors = { ...local.form, ...fieldErrors };

  return (
    <ActionModal
      title="Record one transfer to the agency"
      subtitle={`${vendor} · ${invoices.length} ${invoices.length === 1 ? 'bill' : 'bills'} · ${money(outstanding)} outstanding`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      size="lg"
      submitLabel={totals.overpaid > 0 && armed
        ? `Yes, record ${money(totals.transferred)} anyway`
        : `Record transfer of ${money(totals.transferred)}`}
    >
      <Alert>
        One bank transfer, shared below, and <strong>one entry per bill</strong> with its own amount and tax deducted.
        Either the whole transfer is recorded or none of it is — a problem with any one bill leaves every bill untouched.
      </Alert>

      <div className="form-grid">
        <Field label="Paid on" error={errors.payment_date}>
          {/* A payment is something that happened, so today is the latest the
              picker offers and the server refuses a later one regardless. */}
          <Input type="date" max={todayIso()} value={paidOn} onChange={(e) => { setPaidOn(e.target.value); setArmed(false); }} />
        </Field>
        <Field label="How it was paid" error={errors.payment_mode}>
          <Select value={paymentMode} placeholder={null} options={VENDOR_PAYMENT_MODES} onChange={(e) => setPaymentMode(e.target.value)} />
        </Field>
        <div className="span-all">
          <Field label="Reference" hint="The one UTR, cheque number or transaction id — every bill below gets it" error={errors.reference}>
            <Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} autoFocus />
          </Field>
        </div>
      </div>

      <Field label="Payment proof" hint={`${PROOF_HINT}. One advice for the transfer, shared by every bill`} error={errors.document_id}>
        <Input type="file" onChange={(e) => setProof(e.target.files?.[0] || null)} />
      </Field>

      <Field label="Remarks" error={errors.remarks}>
        <Textarea rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>

      {errors.allocations && <Alert tone="danger">{errors.allocations}</Alert>}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-[12.5px] text-secondary-text">
          <thead>
            <tr className="border-b border-border eyebrow">
              <th className="py-2 pr-2 text-left font-medium">Bill</th>
              <th className="px-2 py-2 text-right font-medium">Payable</th>
              <th className="px-2 py-2 text-right font-medium">Settled</th>
              <th className="px-2 py-2 text-right font-medium">Balance</th>
              <th className="px-2 py-2 text-right font-medium">Transfer</th>
              <th className="px-2 py-2 text-right font-medium">TDS</th>
              <th className="px-2 py-2 text-right font-medium">Will settle</th>
            </tr>
          </thead>
          <tbody>
            {allocations.map((row) => {
              const rowErrors = local.rows[row.invoice.id] || {};
              return (
                <tr key={row.invoice.id} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-2">
                    <span className="num">{row.invoice.vendor_invoice_no || row.invoice.vendor_invoice_id}</span>
                    <span className="block text-[12px] text-muted-foreground">
                      {row.invoice.invoice_date ? date(row.invoice.invoice_date) : 'no date'}
                      {row.invoice.trip_count > 1 ? ` · ${row.invoice.trip_count} trips` : ''}
                    </span>
                  </td>
                  <td className="num px-2 py-2 text-right">{money(row.netPayable)}</td>
                  <td className="num px-2 py-2 text-right">{money(row.settledBefore)}</td>
                  <td className="num px-2 py-2 text-right">{money(row.outstanding)}</td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number" min="0" step="0.01" inputMode="decimal"
                      aria-label={`Amount transferred to ${row.invoice.vendor_invoice_no || row.invoice.vendor_invoice_id}`}
                      value={row.transferred}
                      onChange={(e) => setRow(row.invoice.id, 'transferred', e.target.value)}
                    />
                    {rowErrors.amount_paid && <span className="block pt-1 text-[12px] text-late">{rowErrors.amount_paid}</span>}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Input
                      type="number" min="0" step="0.01" inputMode="decimal"
                      aria-label={`Tax deducted on ${row.invoice.vendor_invoice_no || row.invoice.vendor_invoice_id}`}
                      value={row.tds}
                      onChange={(e) => setRow(row.invoice.id, 'tds', e.target.value)}
                    />
                    {rowErrors.tds_amount && <span className="block pt-1 text-[12px] text-late">{rowErrors.tds_amount}</span>}
                  </td>
                  <td className="num px-2 py-2 text-right font-semibold text-foreground">
                    {money(row.settles)}
                    {row.overBy > 0 && (
                      <span className="block pt-1 text-[12px] font-normal text-late">
                        {money(row.overBy)} over payable
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr className="font-semibold text-foreground">
              <td className="py-2 pr-2" colSpan={4}>Transfer</td>
              <td className="num px-2 py-2 text-right">{money(totals.transferred)}</td>
              <td className="num px-2 py-2 text-right">{money(totals.tds)}</td>
              <td className="num px-2 py-2 text-right">{money(totals.settled)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <Alert tone="info">
        Transferred <strong>{money(totals.transferred)}</strong> · TDS {money(totals.tds)} · settles{' '}
        <strong>{money(totals.settled)}</strong> across {invoices.length} {invoices.length === 1 ? 'bill' : 'bills'}.
        Only the transferred figure leaves the bank; tax deducted settles the bill without reaching the agency.
      </Alert>

      {/* Allowed, and said plainly before the button is pressed. Nothing here
          blocks it or quietly reduces a figure. */}
      {totals.overpaid > 0 && (
        <Alert tone="warning">
          <strong>
            {totals.overpaid} {totals.overpaid === 1 ? 'bill' : 'bills'} will be paid {money(totals.overBy)} above
            {totals.overpaid === 1 ? ' its' : ' their'} current payable amount.
          </strong>
          {armed
            ? ' Press the button again to record this transfer anyway.'
            : ' Record it anyway if that is right — an advance, a rounding or a currency difference — otherwise check the figures.'}
        </Alert>
      )}
    </ActionModal>
  );
}

/* ------------------------------------------------------ correct a payment */

/**
 * Take a payment back off an agency bill, or put its split right (#214).
 *
 * An administrator's, and append-only: this writes an adjustment row and
 * leaves the original payment and its bank advice exactly as they were. The
 * wording never offers to edit or delete anything, because it cannot.
 */
export function CorrectVendorPaymentDialog({ invoice, payments = [], onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [tds, setTds] = useState('');
  const [reason, setReason] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [paymentMode, setPaymentMode] = useState('other');
  const [reference, setReference] = useState('');
  const [proof, setProof] = useState(null);
  const [local, setLocal] = useState({});
  // A figure the business had booked going down is confirmed before it is
  // sent, not after.
  const [armed, setArmed] = useState(false);
  const uploadDocument = useDocumentUploads();
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Correction recorded' });

  const totals = paymentTotals(payments);
  const effect = correctionEffect({
    amount, tds,
    settled: invoice.amount_paid,
    netPayable: invoice.net_payable ?? invoice.invoice_amount ?? null,
  });
  const errors = { ...local, ...fieldErrors };

  const submit = async (event) => {
    event.preventDefault();
    const found = validateCorrection({ amount, tds, reason, paidOn });
    setLocal(found);
    if (Object.keys(found).length) return;
    if (effect.lowers && !armed) {
      setArmed(true);
      return;
    }

    const ok = await run(async () => {
      const documentId = proof ? await uploadDocument(proof, PROOF_OWNER) : null;
      return api.action(`/vendor-invoices/${invoice.id}/pay/correct`, correctionBody({
        amount, tds, reason, paidOn, paymentMode, reference, documentId,
      }));
    });
    if (ok) onClose();
  };

  const reverseAll = () => {
    setAmount(String(-totals.cash));
    setTds(String(-totals.tds));
    setArmed(false);
  };

  return (
    <ActionModal
      title="Correct a payment"
      subtitle={`${invoice.travel_vendor || 'Vendor'} · ${invoice.vendor_invoice_no || invoice.vendor_invoice_id}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={effect.lowers && armed ? `Yes, take ${money(Math.abs(effect.delta))} off the bill` : 'Record correction'}
    >
      <Alert>
        This records an <strong>adjustment</strong> of its own. The payments already on this bill, and any bank advice
        attached to them, stay exactly as they are — the ledger is added to, never edited or deleted.
      </Alert>

      <Alert tone="info">
        The bill settles {money(totals.settled)} today: {money(totals.cash)} transferred and {money(totals.tds)} deducted
        at source, across {payments.length} {payments.length === 1 ? 'entry' : 'entries'}.
        {totals.settled !== 0 && (
          <> <button type="button" className="underline" onClick={reverseAll}>Reverse all of it</button>.</>
        )}
      </Alert>

      <div className="form-grid">
        <Field
          label="Adjust the transferred amount by"
          hint="Negative takes it off the bill"
          error={errors.amount}
        >
          <Input type="number" step="0.01" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setArmed(false); }} autoFocus />
        </Field>
        <Field label="Adjust TDS by" hint="Negative removes deduction" error={errors.tds_amount}>
          <Input type="number" step="0.01" inputMode="decimal" value={tds} onChange={(e) => { setTds(e.target.value); setArmed(false); }} />
        </Field>
      </div>

      {(amount !== '' || tds !== '') && (
        <Alert tone={effect.lowers ? 'warning' : 'info'}>
          {effect.recomposes
            ? <>The bill still settles {money(effect.settledAfter)}; only the split between cash and tax deducted changes.</>
            : <>The bill settles {money(effect.settledBefore)} today and would settle <strong>{money(effect.settledAfter)}</strong> after this adjustment.</>}
          {effect.overBy > 0 && <> That is {money(effect.overBy)} more than the payable amount.</>}
        </Alert>
      )}

      {effect.lowers && armed && (
        <Alert tone="warning">
          <strong>Confirm: this takes {money(Math.abs(effect.delta))} off what this bill is recorded as settling.</strong>
          {' '}The original payment stays on the history, with this adjustment beside it and your reason against it.
          Press the button again to record it.
        </Alert>
      )}

      <Field label="Why this is being corrected" required error={errors.reason}>
        <Textarea
          rows={3}
          maxLength={1000}
          placeholder="e.g. the transfer was reversed by the bank, or the UTR belonged to another bill"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>

      <div className="form-grid">
        <Field label="Dated" error={errors.paid_on}>
          <Input type="date" max={todayIso()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Mode" error={errors.payment_mode}>
          <Select value={paymentMode} placeholder={null} options={VENDOR_PAYMENT_MODES} onChange={(e) => setPaymentMode(e.target.value)} />
        </Field>
        <div className="span-all">
          <Field label="Reference" hint="The reversal's UTR, or the advice that proves it" error={errors.reference}>
            <Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </div>

      <Field label="Proof" hint={PROOF_HINT} error={errors.document_id}>
        <Input type="file" onChange={(e) => setProof(e.target.files?.[0] || null)} />
      </Field>
    </ActionModal>
  );
}

/* ---------------------------------------------------------------- history */

/** What a correction did, said as an adjustment rather than as a payment. */
const CORRECTION_LABEL = {
  reversal: 'Correction — taken off the bill',
  increase: 'Correction — added to the bill',
  recomposition: 'Correction — split put right',
};

/**
 * The agency's payment history: append-only, so it is a list and nothing on
 * it is editable.
 *
 * `payments` comes from GET /vendor-invoices/:id/full, which leaves the key
 * out altogether for a role that may not read it. So an absent list is not
 * an empty one, and the section is not drawn at all.
 */
export function VendorPaymentHistory({ payments, action, title = 'Payments to the agency' }) {
  if (!payments) return null;
  const totals = paymentTotals(payments);

  return (
    <RecordSection
      title={title}
      hint="every entry as it was recorded; a correction is an entry of its own"
      action={action}
    >
      {payments.length === 0 ? (
        <p className="px-5 py-4 text-[12.5px] text-muted-foreground">
          Nothing paid to the agency against this bill yet.
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12.5px] text-secondary-text">
              <thead>
                <tr className="border-b border-border eyebrow">
                  <th className="px-5 py-2 text-left font-medium">Date</th>
                  <th className="px-2 py-2 text-left font-medium">What</th>
                  <th className="px-2 py-2 text-right font-medium">Transferred</th>
                  <th className="px-2 py-2 text-right font-medium">TDS</th>
                  <th className="px-2 py-2 text-right font-medium">Settles</th>
                  <th className="px-2 py-2 text-left font-medium">Mode</th>
                  <th className="px-2 py-2 text-left font-medium">Reference</th>
                  <th className="px-5 py-2 text-left font-medium">Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const correction = isCorrection(p);
                  const shape = correctionShape(p);
                  return (
                    <tr key={p.id} className="border-b border-border/60 align-top">
                      <td className="px-5 py-2 whitespace-nowrap">{p.paid_on ? date(p.paid_on) : <span className="text-muted-foreground">not dated</span>}</td>
                      <td className="px-2 py-2">
                        {correction ? (
                          <>
                            <Chip tone="late" icon={Undo2}>{CORRECTION_LABEL[shape] || 'Correction'}</Chip>
                            <span className="block pt-1 text-[12px] text-muted-foreground">
                              Why: {p.correction_reason}
                            </span>
                          </>
                        ) : (
                          <>
                            Payment
                            {p.remarks && <span className="block text-[12px] text-muted-foreground">{p.remarks}</span>}
                          </>
                        )}
                        {p.document_id && (
                          <a
                            className="mt-1 inline-flex items-center gap-1 text-[12px] underline underline-offset-2"
                            href={api.documentUrl(p.document_id)}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <FileText className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                            {p.document_name || 'proof'}
                          </a>
                        )}
                      </td>
                      <td className="num px-2 py-2 text-right">{money(p.amount)}</td>
                      <td className="num px-2 py-2 text-right">{Number(p.tds_amount) ? money(p.tds_amount) : '—'}</td>
                      <td className="num px-2 py-2 text-right font-semibold text-foreground">{money(settlesOf(p))}</td>
                      <td className="px-2 py-2">{VENDOR_PAYMENT_MODES.find((m) => m.value === p.mode)?.label || p.mode || '—'}</td>
                      <td className="num px-2 py-2">{p.reference || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-5 py-2">{p.recorded_by || <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  );
                })}
                <tr className="font-semibold text-foreground">
                  <td className="px-5 py-2" colSpan={2}>Settled</td>
                  <td className="num px-2 py-2 text-right">{money(totals.cash)}</td>
                  <td className="num px-2 py-2 text-right">{money(totals.tds)}</td>
                  <td className="num px-2 py-2 text-right">{money(totals.settled)}</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="px-5 pb-4 pt-1 text-[12px] text-muted-foreground">
            Transferred is what left the bank; TDS settles the bill without reaching the agency. Together they are what
            the bill settles. Entries are never edited or removed — a mistake is corrected by an adjustment of its own.
          </p>
        </>
      )}
    </RecordSection>
  );
}
