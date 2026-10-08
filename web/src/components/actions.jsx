import { useEffect, useState } from 'react';
import { Modal, Field, FileDrop, Input, Select, Textarea, Alert, useToast } from './ui.jsx';
import { Button } from '@/components/ui/button.tsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useDocumentUploads, useLookups } from '../lib/hooks.js';
import { date, fileSize, money, today } from '../lib/format.js';
import { Banknote, MessageSquareText } from 'lucide-react';
import { DialogError, MoneyBanner, MoneyFacts } from './money.jsx';
import { SumBox } from './travel.jsx';

/** Shared plumbing: submit, surface field errors, toast, close. */
function useAction({ onDone, successMessage }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const result = await fn();
      toast(typeof successMessage === 'function' ? successMessage(result?.data) : successMessage, 'success');
      onDone?.(result?.data);
      return true;
    } catch (err) {
      if (err.fields) setFieldErrors(err.fields);
      setError(err.message);
      setBusy(false);
      return false;
    }
  };

  return { busy, error, fieldErrors, run };
}

/**
 * Every money dialog: a form, its refusal kept inside it (DialogErrors), and
 * a button that offers "Try again" when the failure was not a field.
 */
function ActionModal({ title, subtitle, onClose, onSubmit, busy, error, fieldErrors = {}, what = 'this', submitLabel, submitDisabled = false, children, size = '', extra }) {
  const fieldFailure = Object.keys(fieldErrors).length > 0;
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size={size}
      footer={
        <>
          {extra}
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="max-sm:w-full">Cancel</Button>
          <Button type="submit" form="action-form" disabled={busy || submitDisabled} aria-busy={busy || undefined} className="max-sm:w-full">
            {busy ? 'Saving…' : error && !fieldFailure ? 'Try again' : submitLabel}
          </Button>
        </>
      }
    >
      <form id="action-form" onSubmit={onSubmit} className="flex flex-col gap-4">
        <DialogError error={error} what={what} />
        {children}
      </form>
    </Modal>
  );
}

/* --------------------------------------------------- record an invoice */

/**
 * From the invoices-to-review queue (docs/email-po-plan.md §3.10.5) it opens
 * filled in from a fresh read of the email we sent — `prefill` — with the
 * invoice PDF already stored; saving settles the review item (`reviewId`).
 */
export function RecordInvoiceDialog({ stage, prefill = null, reviewId = null, onClose, onDone }) {
  const [invoiceNo, setInvoiceNo] = useState(prefill?.invoice_no || stage.invoice_no || '');
  const [invoiceDate, setInvoiceDate] = useState(prefill?.invoice_date || stage.invoice_date || today());
  // A document already on the stage is kept unless somebody chooses otherwise (decision 10).
  const [emailDocument, setEmailDocument] = useState(stage.document_id ? null : prefill?.document_id || null);
  const [document, setDocument] = useState(null);
  const [docError, setDocError] = useState(null);
  const maxBytes = useLookups().limits?.document_max_bytes;
  const pickDocument = (f) => {
    if (f && maxBytes && f.size > maxBytes) { setDocument(null); setDocError(`This file is ${fileSize(f.size)}: the limit is ${fileSize(maxBytes)}. Pick a smaller one.`); return; }
    setDocError(null); setDocument(f);
  };
  const uploadDocument = useDocumentUploads();
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Invoice recorded' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(async () => {
      const documentId = document ? await uploadDocument(document, 'payment-stages') : emailDocument;
      return api.action(`/payment-stages/${stage.id}/invoice`, {
        invoice_no: invoiceNo,
        invoice_date: invoiceDate,
        // No file chosen keeps the document already attached.
        document_id: documentId,
        ...(reviewId ? { review_id: reviewId } : {}),
      });
    });
    if (ok) onClose();
  };

  const dueDate = invoiceDate
    ? new Date(new Date(invoiceDate).getTime() + (stage.terms_days || 0) * 86400000).toISOString().slice(0, 10)
    : null;
  const wrongTotal = prefill?.total_value != null
    && Math.abs(Number(prefill.total_value) - Number(stage.stage_amount)) > Math.max(1, 0.005 * Number(prefill.total_value));

  return (
    <ActionModal
      title="Record the invoice"
      subtitle={`${stage.po_number} · ${stage.stage_name}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      fieldErrors={fieldErrors}
      what="the invoice"
      submitLabel="Save invoice"
    >
      {prefill && (
        <MoneyBanner tone="wait" title="Read from the invoice we emailed: check the number and date before you save.">
          {wrongTotal && <>The invoice is for {money(prefill.total_value, prefill.currency)}, not this stage's {money(stage.stage_amount, stage.currency)}.</>}
        </MoneyBanner>
      )}
      <MoneyFacts
        icon={Banknote}
        items={[
          { label: 'Billing', value: money(stage.stage_amount, stage.currency) },
          { label: 'To', value: stage.client_name },
          stage.terms_days ? { label: 'Terms', value: `${stage.terms_days} days` } : null,
          dueDate && stage.terms_days ? { label: 'Due', value: date(dueDate), tone: 'wait' } : null,
        ]}
      />
      <div className="mg-grid2">
        <Field label="Invoice number" required error={fieldErrors.invoice_no}>
          <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="CTZ/INV/2026/001" autoFocus />
        </Field>
        <Field label="Invoice date" required error={fieldErrors.invoice_date}>
          <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
        </Field>
      </div>
      <Field
        as="div"
        label="Invoice document (optional)"
        hint={stage.document_id ? 'Leave it empty to keep the current file, or drop one to replace it.' : 'You can add it later.'}
        error={docError || fieldErrors.document_id}
      >
        {stage.document_id && !document && (
          <div className="app-mfacts">
            <span className="app-mfacts__items">
              <span>Current file <a className="app-link" href={api.documentUrl(stage.document_id)} target="_blank" rel="noopener noreferrer">{stage.document_name || 'view document'}</a></span>
            </span>
          </div>
        )}
        <FileDrop label="Invoice document" text={stage.document_id ? 'Drop a file here to replace the current one' : 'Drop a PDF or image here'} error={docError || fieldErrors.document_id} onFile={pickDocument} />
        {emailDocument && !document && (
          <div className="text-[12.5px] text-secondary-text">
            <a className="app-link" href={api.documentUrl(emailDocument)} target="_blank" rel="noopener noreferrer">The invoice from the email</a> will be attached
            {' · '}<button type="button" className="app-textbtn" onClick={() => setEmailDocument(null)}>don&apos;t attach it</button>
          </div>
        )}
      </Field>
    </ActionModal>
  );
}

/* -------------------------------------------------- record a receipt */

/**
 * `advice` is a client's payment advice from the portal (#198 §4): the
 * dialog opens filled from it, and saving links the receipt to it. Opened
 * without one, the client's open payment reports on this invoice are
 * offered in "The client's payment report", so a receipt that answers one
 * settles it and it is not matched again later.
 */
export function RecordPaymentDialog({ stage, onClose, onDone, advice: given, preselect }) {
  const outstanding = Math.max(Number(stage.stage_amount || 0) - Number(stage.amount_received || 0), 0);
  const [reports, setReports] = useState([]);
  const [adviceId, setAdviceId] = useState(given ? String(given.id) : '');
  const advice = given || reports.find((a) => String(a.id) === adviceId) || null;
  // One invoice: what the client said they paid. Several: this invoice's outstanding, to adjust.
  const single = (a) => a && a.invoices.length === 1;
  const [amount, setAmount] = useState(String(single(given) ? Number(given.amount) : outstanding));
  const [tds, setTds] = useState(single(given) && Number(given.tds_amount) > 0 ? String(Number(given.tds_amount)) : '');
  const [mode, setMode] = useState('bank_transfer');
  const [reference, setReference] = useState(given?.reference || '');
  const [paidOn, setPaidOn] = useState(given?.paid_on?.slice(0, 10) || today());
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Payment recorded' });

  useEffect(() => {
    if (given || !stage.po_number) return;
    api.raw(`/portal-admin/actions?status=open&kind=payment_advice&po_number=${encodeURIComponent(stage.po_number)}`)
      .then((r) => setReports((r.data || []).filter((a) => a.invoices.some((i) => i.id === stage.id))))
      .catch(() => setReports([]));
  }, [given, stage.id, stage.po_number]);
  // "Match it" on a client's word opens the dialog on that report.
  useEffect(() => {
    if (preselect && !adviceId && reports.some((a) => String(a.id) === String(preselect))) pickReport(String(preselect));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports, preselect]);

  function pickReport(id) {
    setAdviceId(id);
    const a = reports.find((x) => String(x.id) === id);
    if (!a) return;
    if (single(a)) { setAmount(String(Number(a.amount))); setTds(Number(a.tds_amount) > 0 ? String(Number(a.tds_amount)) : ''); }
    if (a.reference) setReference(a.reference);
    if (a.paid_on) setPaidOn(a.paid_on.slice(0, 10));
  }

  const submit = async (e) => {
    e.preventDefault();
    // A receipt row (#27): what came in now, plus any TDS the client deducted.
    const ok = await run(() =>
      api.action(`/payment-stages/${stage.id}/payment`, {
        amount_received: Number(amount),
        tds_amount: tds ? Number(tds) : 0,
        payment_mode: mode,
        reference,
        payment_received_date: paidOn,
        mode: 'add',
        portal_action_id: advice?.id,
      })
    );
    if (ok) onClose();
  };

  const subtitle = [stage.invoice_no, stage.po_number, stage.stage_name].filter(Boolean).join(' · ');
  const reported = given && `${given.company_name} reported ${money(given.amount, stage.currency)}${Number(given.tds_amount) > 0 ? ` + TDS ${money(given.tds_amount, stage.currency)}` : ''} paid on ${date(given.paid_on)}${given.invoices.length > 1 ? `, across ${given.invoices.map((i) => i.invoice_no).join(' and ')}` : ''}.`;
  return (
    <ActionModal
      title="Record a payment"
      subtitle={subtitle}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      fieldErrors={fieldErrors}
      what="the payment"
      submitLabel="Save payment"
    >
      {given && <MoneyBanner icon={MessageSquareText} title={reported}>Check it against the bank before saving.</MoneyBanner>}
      {given && outstanding <= 0 && (
        <MoneyBanner tone="wait" title="This invoice is already fully received.">
          If this is the payment already recorded, reject the client&apos;s advice with that reason rather than recording it again.
        </MoneyBanner>
      )}
      {!given && reports.length > 0 && (
        <Field label="The client's payment report" hint="Linking settles their report in Collections, so it is not matched again later." error={fieldErrors.portal_action_id}>
          <Select
            value={adviceId}
            placeholder="Not linked to a report"
            options={reports.map((a) => ({ value: String(a.id), label: `${a.company_name}: ${money(a.amount, stage.currency)} paid on ${date(a.paid_on)}${a.reference ? ` · ${a.reference}` : ''}` }))}
            onChange={(e) => pickReport(e.target.value)}
          />
        </Field>
      )}
      {given && fieldErrors.portal_action_id && <MoneyBanner tone="late" role="alert">{fieldErrors.portal_action_id}</MoneyBanner>}
      <MoneyFacts
        icon={Banknote}
        items={[
          { label: 'Stage value', value: money(stage.stage_amount, stage.currency) },
          { label: 'Already received', value: money(stage.amount_received, stage.currency) },
          { label: 'Outstanding', value: money(outstanding, stage.currency), tone: outstanding > 0 ? 'wait' : undefined },
        ]}
      />
      <div className="mg-grid2">
        <Field label="Amount received now" required error={fieldErrors.amount_received}>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="mg-input--money" aria-invalid={fieldErrors.amount_received ? true : undefined} />
        </Field>
        <Field label="Received on" error={fieldErrors.payment_received_date}>
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="TDS deducted" hint="Counts as settled." error={fieldErrors.tds_amount}>
          <Input type="number" min="0" step="0.01" value={tds} onChange={(e) => setTds(e.target.value)} className="mg-input--money" placeholder="0" />
        </Field>
        <Field label="Mode">
          <Select value={mode} placeholder={null} options={[{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' }, { value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }]} onChange={(e) => setMode(e.target.value)} />
        </Field>
      </div>
      <Field label="Reference" hint="UTR, cheque number.">
        <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or cheque number" />
      </Field>
    </ActionModal>
  );
}

/* -------------------------------------------------- pay a travel vendor */

export function PayVendorDialog({ invoice, onClose, onDone }) {
  // Owed is the bill less its credit notes (#196).
  const outstanding = Math.max(Number(invoice.net_payable ?? invoice.invoice_amount ?? 0) - Number(invoice.amount_paid || 0), 0);
  const [amount, setAmount] = useState(String(outstanding));
  const [paidOn, setPaidOn] = useState(today());
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Vendor payment recorded' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/vendor-invoices/${invoice.id}/pay`, {
        amount_paid: Number(amount) + Number(invoice.amount_paid || 0),
        payment_date: paidOn,
      })
    );
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Pay the vendor"
      subtitle={`${invoice.travel_vendor || 'Vendor'} · ${invoice.vendor_invoice_no || invoice.vendor_invoice_id}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      fieldErrors={fieldErrors}
      submitLabel="Record payment"
      submitDisabled={invoice.invoice_amount === null}
    >
      {invoice.invoice_amount === null ? (
        <MoneyBanner tone="wait" title="This bill has no amount yet.">
          Enter the amount from {invoice.travel_vendor || 'the vendor'}'s bill before paying it.
        </MoneyBanner>
      ) : (
        <SumBox
          rows={[
            ['Invoiced', money(invoice.invoice_amount), invoice.line_count > 1 ? `${invoice.line_count} lines` : invoice.travel_id],
            ['Credit notes', Number(invoice.credited) > 0 ? `− ${money(invoice.credited)}` : 'None'],
            ['Paid so far', Number(invoice.amount_paid) > 0 ? `− ${money(invoice.amount_paid)}` : money(0), invoice.payment_date ? date(invoice.payment_date) : null],
            ['Outstanding', money(outstanding), null, true],
          ]}
          foot={invoice.pay_by ? `Pay by ${date(invoice.pay_by)}${invoice.payment_status === 'Overdue' && invoice.days_overdue ? ` · ${invoice.days_overdue} days overdue` : ''}` : 'No pay-by date yet: the bill has no date'}
          footTone={invoice.payment_status === 'Overdue' ? 'late' : undefined}
        />
      )}
      <div className="mg-grid2">
        <Field label="Amount paid now" required error={fieldErrors.amount_paid} hint={invoice.invoice_amount === null ? undefined : `This payment only. Paying ${money(outstanding)} clears the bill.`}>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="mg-input--money" />
        </Field>
        <Field label="Paid on" error={fieldErrors.payment_date}>
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
      </div>
    </ActionModal>
  );
}

/* ---------------------------------------------------------- claim flow */

export function ClaimDecisionDialog({ claim, onClose, onDone }) {
  const [status, setStatus] = useState('Approved');
  const { busy, error, run } = useAction({ onDone, successMessage: 'Claim updated' });

  // Who decided is no longer typed in (#85). The server takes it from the
  // session, so the name on the claim is the account that pressed the button
  // rather than whatever was in the box.
  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/expense-claims/${claim.id}/decide`, { approval_status: status })
    );
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Review the claim"
      subtitle={`${claim.claim_id} · ${claim.employee_name} · ${money(claim.amount_claimed)}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Save decision"
    >
      <SumBox
        rows={[
          ['Trip', [claim.travel_id, claim.client_name].filter(Boolean).join(' · ') || '—'],
          ['Category', [claim.expense_category || 'Uncategorised', claim.claim_month].filter(Boolean).join(' · ')],
          ['Claimed', money(claim.amount_claimed), null, true],
        ]}
        foot={claim.approval_status === 'On Hold' ? 'On hold: decide it once what was asked for is in.' : 'Your name is recorded as the one who decided.'}
      />
      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
        <legend className="mg-field__label mb-2.5 p-0">Decision<span className="req" aria-hidden="true">*</span></legend>
        {[['Approved', 'Approved'], ['Rejected', 'Rejected'], ['On Hold', 'On hold'], ['Submitted', 'Submitted (undo an earlier decision)']].map(([value, label]) => (
          <label key={value} className="mg-check">
            <input type="radio" name="claim-decision" value={value} checked={status === value} onChange={() => setStatus(value)} />{label}
          </label>
        ))}
      </fieldset>
    </ActionModal>
  );
}

export function ReimburseClaimDialog({ claim, onClose, onDone }) {
  const outstanding = Math.max(Number(claim.amount_claimed || 0) - Number(claim.amount_reimbursed || 0), 0);
  const [amount, setAmount] = useState(String(outstanding));
  const [paidOn, setPaidOn] = useState(today());
  const { busy, error, run } = useAction({ onDone, successMessage: 'Reimbursement recorded' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/expense-claims/${claim.id}/reimburse`, {
        amount_reimbursed: Number(amount) + Number(claim.amount_reimbursed || 0),
        reimbursement_date: paidOn,
      })
    );
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Reimburse the employee"
      subtitle={[claim.claim_id, claim.employee_name, claim.expense_category, claim.claim_month].filter(Boolean).join(' · ')}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Record reimbursement"
    >
      <SumBox
        rows={[
          ['Claimed', money(claim.amount_claimed), claim.submission_date ? `submitted ${date(claim.submission_date)}` : null],
          ['Reimbursed so far', Number(claim.amount_reimbursed) > 0 ? `− ${money(claim.amount_reimbursed)}` : money(0)],
          ['Still to reimburse', money(outstanding), null, true],
        ]}
      />
      <div className="mg-grid2">
        <Field label="Amount reimbursed now" required>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus className="mg-input--money" />
        </Field>
        <Field label="Paid on">
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
      </div>
    </ActionModal>
  );
}

/**
 * Put a decided or reimbursed claim's figures right (POST /expense-claims/:id/correct,
 * admin only): the reimbursement in all, its date, the decision, and why.
 * Recorded with the admin's name and the reason.
 */
export function CorrectClaimDialog({ claim, onClose, onDone }) {
  const [amount, setAmount] = useState(String(Number(claim.amount_reimbursed || 0)));
  const [paidOn, setPaidOn] = useState(claim.reimbursement_date ? String(claim.reimbursement_date).slice(0, 10) : '');
  const [status, setStatus] = useState(claim.approval_status || 'Approved');
  const [reason, setReason] = useState('');
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Claim corrected' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/expense-claims/${claim.id}/correct`, {
        amount_reimbursed: amount === '' ? null : Number(amount),
        reimbursement_date: paidOn || null,
        approval_status: status,
        reason,
      })
    );
    if (ok) onClose();
  };

  return (
    <ActionModal
      title={`Correct claim ${claim.claim_id}`}
      subtitle={[claim.employee_name, money(claim.amount_claimed), Number(claim.amount_reimbursed) > 0 && `${money(claim.amount_reimbursed)} reimbursed`].filter(Boolean).join(' · ')}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      fieldErrors={fieldErrors}
      what="the correction"
      submitLabel="Save correction"
    >
      <MoneyBanner tone="wait" title={Number(claim.amount_reimbursed) > 0 ? 'This claim is already reimbursed.' : 'This claim is already decided.'}>
        A correction is recorded with your name and the reason, and the trip's cost updates. Money already paid stays as it is unless you change the figure.
      </MoneyBanner>
      <div className="mg-grid2">
        <Field label="Reimbursed in all" error={fieldErrors.amount_reimbursed} hint={`Up to the ${money(claim.amount_claimed)} claimed`}>
          <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mg-input--money" />
        </Field>
        <Field label="Reimbursed on" error={fieldErrors.reimbursement_date}>
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Decision" error={fieldErrors.approval_status}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={null}
            options={[{ value: 'Approved', label: 'Approved' }, { value: 'Rejected', label: 'Rejected' }, { value: 'On Hold', label: 'On hold' }, { value: 'Submitted', label: 'Waiting for a decision' }]} />
        </Field>
      </div>
      <Field label="Why" required error={fieldErrors.reason}>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The receipt was for ₹1,020" required error={fieldErrors.reason} />
      </Field>
    </ActionModal>
  );
}

/* -------------------------------------------- quotation → project */

export function ConvertQuotationDialog({ quotation, onClose, onDone }) {
  // 'new' = create new project (default); 'existing' = link to an existing one.
  const [mode, setMode] = useState('new');

  // ---- "Create new project" state ----
  // Only a guide: the server assigns the number when the project is created.
  const [nextProjectId, setNextProjectId] = useState('');
  const [manager, setManager] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [start, setStart] = useState('');
  const [delivery, setDelivery] = useState('');
  const [applyTemplate, setApplyTemplate] = useState(true);

  // ---- "Add to existing project" state ----
  const [selectedProjectId, setSelectedProjectId] = useState('');
  // useLookups() is already called in the parent but we need it here too.
  // It is cached after the first call so there is no extra network request.
  const { projects: allProjects } = useLookups();

  // Only show projects that belong to the same client as this quotation.
  // If none exist, we show an empty state — we never fall back to other clients'
  // projects because the backend rejects cross-client links anyway.
  // Uses the same normalization as the backend (server/src/lib/names.js normalizeName):
  //   trim + collapse repeated interior spaces + lowercase
  // so "Hindalco  Ltd" and "Hindalco Ltd" are treated as the same client.
  const normClient = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const sameClientProjects = allProjects.filter(
    (p) => normClient(p.client_name) === normClient(quotation.client_name)
  );
  const noSameClientProjects = sameClientProjects.length === 0;

  const { busy, error, fieldErrors, run } = useAction({
    onDone,
    successMessage: (data) => `Project ${data?.project?.project_id ?? ''} registered`,
  });

  useEffect(() => {
    api.raw('/lookups/next-id/project').then((r) => setNextProjectId(r.data.next)).catch(() => {});
  }, []);

  // Reset the existing-project selector when switching modes.
  const handleModeChange = (newMode) => {
    setMode(newMode);
    if (newMode === 'existing') setSelectedProjectId(sameClientProjects[0]?.project_id || '');
  };

  const submit = async (e) => {
    e.preventDefault();

    let payload;
    if (mode === 'existing') {
      // Existing-project path: send only project_id; the backend does the rest.
      if (!selectedProjectId) return; // nothing selected yet — guard only
      payload = { project_id: selectedProjectId };
    } else {
      // New-project path: identical to the pre-regression behaviour.
      payload = {
        project_manager: manager,
        project_manager_email: managerEmail,
        planned_start_date: start,
        planned_delivery_date: delivery,
        apply_onboarding_template: applyTemplate,
      };
    }

    const ok = await run(() => api.action(`/quotations/${quotation.id}/convert`, payload));
    // The quotation now has a project, so it belongs in the PO forms' won-quotation lists.
    if (ok) invalidateLookups();
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Create the project"
      subtitle={[quotation.quotation_no, quotation.client_name, quotation.quotation_value != null ? money(quotation.quotation_value, quotation.currency) : null].filter(Boolean).join(' · ')}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      fieldErrors={fieldErrors}
      submitLabel={mode === 'existing' ? 'Link to project' : 'Create project'}
      submitDisabled={mode === 'existing' && (noSameClientProjects || !selectedProjectId)}
      size=""
    >
      <Alert><span>
        The quotation is marked won and linked to this project. Register the PO next so finance
        can raise the advance invoice.
      </span></Alert>

      {/* Mode toggle */}
      <div className="mg-seg flex" role="radiogroup" aria-label="Project">
        <span className="mg-seg__thumb" aria-hidden="true" style={{ width: 'calc(50% - 3px)', transform: mode === 'existing' ? 'translateX(100%)' : 'none' }} />
        <button type="button" role="radio" aria-checked={mode === 'new'} className="flex-1" onClick={() => handleModeChange('new')}>Create new project</button>
        <button type="button" role="radio" aria-checked={mode === 'existing'} className="flex-1" onClick={() => handleModeChange('existing')}>Add to existing project</button>
      </div>

      {/* ---- Add to existing project ---- */}
      {mode === 'existing' && (
        noSameClientProjects ? (
          <Alert tone="warning">
            <span>No existing projects found for <strong>{quotation.client_name}</strong>. Choose &ldquo;Create new project&rdquo; instead.</span>
          </Alert>
        ) : (
          <Field
            label="Existing project"
            required
            hint={`Showing ${sameClientProjects.length === 1 ? '1 project' : `${sameClientProjects.length} projects`} for ${quotation.client_name}. None fits? Choose Create new project.`}
            error={fieldErrors.project_id}
          >
            <Select
              value={selectedProjectId}
              placeholder="Select a project"
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              {sameClientProjects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.project_id} · {p.client_name}
                </option>
              ))}
            </Select>
          </Field>
        )
      )}

      {/* ---- Create new project ---- */}
      {mode === 'new' && (
        <div className="mg-grid2">
          <Field label="Project ID" hint="Assigned automatically when you save">
            <Input
              value=""
              placeholder={nextProjectId ? `${nextProjectId} (next number)` : 'Assigned on save'}
              className="mono"
              disabled
              readOnly
            />
          </Field>
          <Field label="Project manager">
            <Input value={manager} onChange={(e) => setManager(e.target.value)} />
          </Field>
          <Field label="Manager email">
            <Input type="email" value={managerEmail} onChange={(e) => setManagerEmail(e.target.value)} />
          </Field>
          <Field label="Planned start">
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Planned delivery">
            <Input type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} />
          </Field>
          <Field label="Onboarding checklist" hint="Adds the 11 standard lifecycle steps">
            <Select
              value={applyTemplate ? 'yes' : 'no'}
              placeholder={null}
              options={[{ value: 'yes', label: 'Add standard checklist' }, { value: 'no', label: 'Skip for now' }]}
              onChange={(e) => setApplyTemplate(e.target.value === 'yes')}
            />
          </Field>
        </div>
      )}
    </ActionModal>
  );
}

/* ------------------------------------------------ payment split builder */

const PRESETS = {
  '50/50': [50, 50],
  '30/70': [30, 70],
  '40/30/30': [40, 30, 30],
  '100 on delivery': [100],
};

// stage_percent is numeric(6,4) and the server accepts a 0.0001 drift, which
// is 0.01 of a percent. Rounding any coarser than that makes a split the dialog
// cannot express — 33.33% kept leaves 66.67%, which 0.1 steps can never hit.
const pct = (n) => Math.round(n * 100) / 100;

/** A preset covers the whole PO; fit it to whatever share is still free. */
const scale = (percents, allocatable) => {
  if (Math.abs(allocatable - 100) < 0.005) return percents;
  const scaled = percents.map((p) => pct((p * allocatable) / 100));
  // Rounding lands on the last stage, so the split still adds up exactly.
  scaled[scaled.length - 1] = pct(scaled.at(-1) + (allocatable - scaled.reduce((a, b) => a + b, 0)));
  return scaled;
};

export function PaymentSplitDialog({ po, lockedPercent = 0, onClose, onDone }) {
  const lookups = useLookups();
  // What is already invoiced or paid stays, so only the rest is up for
  // splitting. 100% of the PO with half of it billed would schedule 150%.
  const locked = pct(Number(lockedPercent || 0) * 100);
  const allocatable = pct(100 - locked);
  // Nothing left to split: every stage is invoiced or paid, and those are never
  // replaced. Offering a form the server must reject wastes the user's time.
  const nothingToSplit = allocatable < 0.01;
  // The saved templates (#26) come first; the fixed splits stay as a fallback.
  // A template keeps its own stage names, triggers, credit days and
  // milestones, as /register copies them.
  const presets = {
    ...Object.fromEntries((lookups.payment_terms_templates || []).map((t) => [t.name, t.lines.map((l) => ({
      stage_name: l.stage_name, trigger_event: l.trigger_event, percent: Number(l.percent),
      credit_days: l.credit_days ?? null, milestone_name: l.milestone_name ?? null,
    }))])),
    ...PRESETS,
  };
  // A template's percentages are fitted to the free share the same way.
  const fit = (split) => {
    if (!split.length || typeof split[0] !== 'object') return scale(split, allocatable);
    const scaled = scale(split.map((l) => l.percent), allocatable);
    return split.map((l, i) => ({ ...l, percent: scaled[i] }));
  };
  const [preset, setPreset] = useState(() => (lookups.payment_terms_templates?.find((t) => t.is_default)?.name) || '50/50');
  const [stages, setStages] = useState(() => buildStages(fit(presets[preset] || PRESETS['50/50'])));
  const { busy, error, run } = useAction({ onDone, successMessage: 'Payment stages created' });

  function buildStages(split) {
    if (split.length && typeof split[0] === 'object') return split.map((line) => ({ ...line }));
    const percents = split;
    return percents.map((p, i) => ({
      stage_name:
        percents.length === 1
          ? `Full value (${p}%)`
          : i === 0
          ? `Advance (${p}%)`
          : i === percents.length - 1
          ? `On delivery (${p}%)`
          : `Milestone ${i} (${p}%)`,
      trigger_event: percents.length === 1 ? 'On Delivery' : i === 0 ? 'On PO Registration' : 'On Delivery',
      percent: p,
    }));
  }

  const total = pct(stages.reduce((sum, s) => sum + Number(s.percent || 0), 0));
  const off = Math.abs(total - allocatable) > 0.005;

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/purchase-orders/${encodeURIComponent(po.po_number)}/stages`, {
        stages: stages.map((s) => ({
          stage_name: s.stage_name,
          trigger_event: s.trigger_event,
          stage_percent: Number(s.percent) / 100,
          credit_days: s.credit_days ?? null,
          milestone_name: s.milestone_name ?? null,
        })),
        replace: true,
      })
    );
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Set the payment stages"
      subtitle={`${po.po_number} · ${money(po.po_value, po.currency)}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Create stages"
      submitDisabled={nothingToSplit || off}
      size=""
    >
      <MoneyBanner>
        Stages triggered <strong className="inline">On PO Registration</strong> can be invoiced at once.
        Ones triggered <strong className="inline">On Delivery</strong> wait until the order's delivery date is recorded.
      </MoneyBanner>

      {nothingToSplit ? (
        <MoneyBanner tone="wait" title="Every stage on this PO is already invoiced or paid.">
          Those are never replaced, so there is nothing left to split. Record a payment, or add a stage, instead.
        </MoneyBanner>
      ) : locked > 0 && (
        <MoneyBanner tone="wait" title={`${locked}% of this PO is already invoiced or paid.`}>
          Those stages are kept, so the ones below must add up to the remaining {allocatable}%.
        </MoneyBanner>
      )}

      <Field label="Start from a common split">
        <Select
          value={preset}
          placeholder={null}
          options={Object.keys(presets)}
          onChange={(e) => {
            setPreset(e.target.value);
            setStages(buildStages(fit(presets[e.target.value])));
          }}
        />
      </Field>

      <div className="mg-tablewrap app-splitwrap">
        <table className="mg-table app-split">
          <thead>
            <tr>
              <th>Stage</th>
              <th>Trigger</th>
              <th className="num">%</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="mg-input"
                    value={stage.stage_name}
                    onChange={(e) => setStages((s) => s.map((x, j) => (j === i ? { ...x, stage_name: e.target.value } : x)))}
                  />
                </td>
                <td>
                  <select
                    className="mg-select"
                    value={stage.trigger_event}
                    onChange={(e) => setStages((s) => s.map((x, j) => (j === i ? { ...x, trigger_event: e.target.value } : x)))}
                  >
                    <option>On PO Registration</option>
                    <option>On Delivery</option>
                    <option>On Milestone</option>
                    <option>Manual</option>
                  </select>
                </td>
                <td className="num" style={{ width: 90 }}>
                  <input
                    className="mg-input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={stage.percent}
                    onChange={(e) => setStages((s) => s.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))}
                  />
                </td>
                <td className="num">{money((Number(po.po_value) * Number(stage.percent || 0)) / 100, po.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              <td className={off ? 'num is-late-text' : 'num'}>
                {total}%{locked > 0 && <span className="text-muted-foreground"> of {allocatable}%</span>}
              </td>
              <td className="num">{money((Number(po.po_value) * total) / 100, po.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="mg-btn mg-btn--sm"
          onClick={() => setStages((s) => [...s, { stage_name: `Milestone ${s.length}`, trigger_event: 'Manual', percent: 0 }])}
        >
          + Add stage
        </button>
        {stages.length > 1 && (
          <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setStages((s) => s.slice(0, -1))}>
            Remove last
          </button>
        )}
        {off && (
          <span className="text-[12.5px] font-semibold text-late" role="alert">
            Stages must total {allocatable}%{locked > 0 ? ` — the other ${locked}% is already invoiced or paid` : ''}
          </span>
        )}
      </div>
    </ActionModal>
  );
}
