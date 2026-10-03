import { useEffect, useState } from 'react';
import { Modal, Field, Input, Select, Alert, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useDocumentUploads, useLookups } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';

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

function ActionModal({ title, subtitle, onClose, onSubmit, busy, error, submitLabel, submitDisabled = false, children, size = 'sm' }) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size={size}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="action-form" className="btn btn--primary" disabled={busy || submitDisabled}>
            {busy ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <form id="action-form" onSubmit={onSubmit} className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
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

  return (
    <ActionModal
      title="Record the invoice"
      subtitle={`${stage.po_number} · ${stage.stage_name}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Save invoice"
    >
      {prefill && (
        <Alert tone="warning">
          <strong>Read from the invoice we emailed: check the number and date before you save.</strong>
          {prefill.total_value != null && Math.abs(Number(prefill.total_value) - Number(stage.stage_amount)) > Math.max(1, 0.005 * Number(prefill.total_value))
            && <> The invoice is for {money(prefill.total_value, prefill.currency)}, not this stage's {money(stage.stage_amount, stage.currency)}.</>}
        </Alert>
      )}
      <Alert>
        Billing <strong>{money(stage.stage_amount, stage.currency)}</strong> to {stage.client_name}
        {stage.terms_days ? ` on ${stage.terms_days}-day terms` : ''}.
        {dueDate && <> Payment will be due <strong>{dueDate}</strong>.</>}
      </Alert>
      <Field label="Invoice number" required error={fieldErrors.invoice_no}>
        <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="CTZ/INV/2026/001" autoFocus />
      </Field>
      <Field label="Invoice date" required error={fieldErrors.invoice_date}>
        <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
      </Field>
      <Field
        label="Invoice document"
        hint={stage.document_id ? 'Choose a file to replace the current one, or leave empty to keep it' : 'Optional: PDF or image'}
        error={fieldErrors.document_id}
      >
        <Input type="file" onChange={(e) => setDocument(e.target.files?.[0] || null)} />
        {emailDocument && !document && (
          <div className="small muted">
            <a href={api.documentUrl(emailDocument)} target="_blank" rel="noopener noreferrer">The invoice from the email</a> will be attached
            {' · '}<button type="button" className="underline" onClick={() => setEmailDocument(null)}>don't attach it</button>
          </div>
        )}
        {stage.document_id && (
          <div className="small muted">
            Current:{' '}
            <a href={api.documentUrl(stage.document_id)} target="_blank" rel="noopener noreferrer">
              {stage.document_name || 'view document'}
            </a>
          </div>
        )}
      </Field>
    </ActionModal>
  );
}

/* -------------------------------------------------- record a receipt */

export function RecordPaymentDialog({ stage, onClose, onDone }) {
  const outstanding = Math.max(Number(stage.stage_amount || 0) - Number(stage.amount_received || 0), 0);
  const [amount, setAmount] = useState(String(outstanding));
  const [tds, setTds] = useState('');
  const [mode, setMode] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(today());
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Payment recorded' });

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
      })
    );
    if (ok) onClose();
  };

  return (
    <ActionModal
      title="Record a payment"
      subtitle={`${stage.po_number} · ${stage.stage_name}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Save payment"
    >
      <Alert>
        Stage value {money(stage.stage_amount, stage.currency)} · already received{' '}
        {money(stage.amount_received, stage.currency)} · outstanding{' '}
        <strong>{money(outstanding, stage.currency)}</strong>
      </Alert>
      <Field label="Amount received now" required error={fieldErrors.amount_received}>
        <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </Field>
      <Field label="Received on" error={fieldErrors.payment_received_date}>
        <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </Field>
      <div className="form-grid">
        <Field label="TDS deducted" hint="Counts as settled">
          <Input type="number" min="0" step="0.01" value={tds} onChange={(e) => setTds(e.target.value)} />
        </Field>
        <Field label="Mode">
          <Select value={mode} placeholder={null} options={[{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cheque', label: 'Cheque' }, { value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }, { value: 'other', label: 'Other' }]} onChange={(e) => setMode(e.target.value)} />
        </Field>
        <div className="span-all">
          <Field label="Reference" hint="UTR, cheque number">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} />
          </Field>
        </div>
      </div>
    </ActionModal>
  );
}

/* -------------------------------------------------- pay a travel vendor */

export function PayVendorDialog({ invoice, onClose, onDone }) {
  const outstanding = Math.max(Number(invoice.invoice_amount || 0) - Number(invoice.amount_paid || 0), 0);
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
      submitLabel="Record payment"
    >
      {invoice.invoice_amount === null ? (
        <Alert tone="warning">
          This invoice has no amount yet. Edit the invoice and enter the amount before paying it.
        </Alert>
      ) : (
        <Alert>
          Invoiced {money(invoice.invoice_amount)} · paid {money(invoice.amount_paid)} · outstanding{' '}
          <strong>{money(outstanding)}</strong>
          {invoice.pay_by && <> · due by {invoice.pay_by}</>}
        </Alert>
      )}
      <Field label="Amount paid now" required error={fieldErrors.amount_paid}>
        <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </Field>
      <Field label="Paid on" error={fieldErrors.payment_date}>
        <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </Field>
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
      <Field label="Decision" required>
        <Select
          value={status}
          placeholder={null}
          options={['Approved', 'Rejected', 'On Hold', 'Submitted']}
          onChange={(e) => setStatus(e.target.value)}
        />
      </Field>
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
      subtitle={`${claim.claim_id} · ${claim.employee_name}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel="Record reimbursement"
    >
      <Alert>
        Claimed {money(claim.amount_claimed)} · reimbursed {money(claim.amount_reimbursed)} · outstanding{' '}
        <strong>{money(outstanding)}</strong>
      </Alert>
      <Field label="Amount reimbursed now" required>
        <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </Field>
      <Field label="Paid on">
        <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
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
      title="Register the project"
      subtitle={`${quotation.quotation_no} · ${quotation.client_name}`}
      onClose={onClose}
      onSubmit={submit}
      busy={busy}
      error={error}
      submitLabel={mode === 'existing' ? 'Link to project' : 'Create project'}
      submitDisabled={mode === 'existing' && (noSameClientProjects || !selectedProjectId)}
      size=""
    >
      <Alert>
        The quotation is marked won and linked to this project. Register the PO next so finance
        can raise the advance invoice.
      </Alert>

      {/* Mode toggle */}
      <div className="row" style={{ gap: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="convert-mode"
            value="new"
            checked={mode === 'new'}
            onChange={() => handleModeChange('new')}
          />
          Create new project
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="radio"
            name="convert-mode"
            value="existing"
            checked={mode === 'existing'}
            onChange={() => handleModeChange('existing')}
          />
          Add to existing project
        </label>
      </div>

      {/* ---- Add to existing project ---- */}
      {mode === 'existing' && (
        noSameClientProjects ? (
          <p className="small muted">
            No existing projects found for <strong>{quotation.client_name}</strong>.
            Create a new project first or choose &ldquo;Create new project&rdquo;.
          </p>
        ) : (
          <Field
            label="Existing project"
            hint={`Showing ${sameClientProjects.length} project(s) for ${quotation.client_name}`}
            error={fieldErrors.project_id}
          >
            <select
              className="select"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(e.target.value)}
            >
              <option value="">— select a project —</option>
              {sameClientProjects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.project_id} — {p.client_name}
                </option>
              ))}
            </select>
          </Field>
        )
      )}

      {/* ---- Create new project ---- */}
      {mode === 'new' && (
        <div className="form-grid">
          <Field label="Project ID" hint="Assigned automatically when you save">
            <Input
              value=""
              placeholder={nextProjectId ? `${nextProjectId} (next number)` : 'Assigned on save'}
              className="input mono"
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
      <Alert>
        Stages triggered <strong>On PO Registration</strong> become invoiceable immediately.
        Ones triggered <strong>On Delivery</strong> wait until the PO's delivery date is recorded.
      </Alert>

      {nothingToSplit ? (
        <Alert tone="warning">
          <span>
            <strong>Every stage on this PO is already invoiced or paid.</strong> Those are never
            replaced, so there is nothing left to split. Record a payment or add a stage from the
            payment schedule instead.
          </span>
        </Alert>
      ) : locked > 0 && (
        <Alert tone="warning">
          <span>
            <strong>{locked}% of this PO is already invoiced or paid.</strong> Those stages are kept,
            so the ones below must add up to the remaining <strong>{allocatable}%</strong>.
          </span>
        </Alert>
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

      <div className="table-wrap">
        <table className="table">
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
                    className="input"
                    value={stage.stage_name}
                    onChange={(e) => setStages((s) => s.map((x, j) => (j === i ? { ...x, stage_name: e.target.value } : x)))}
                  />
                </td>
                <td>
                  <select
                    className="select"
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
                    className="input"
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
              <td className="num" style={{ color: off ? 'var(--danger-fg)' : undefined }}>
                {total}%{locked > 0 && <span className="small muted"> of {allocatable}%</span>}
              </td>
              <td className="num">{money((Number(po.po_value) * total) / 100, po.currency)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="row">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setStages((s) => [...s, { stage_name: `Milestone ${s.length}`, trigger_event: 'Manual', percent: 0 }])}
        >
          + Add stage
        </button>
        {stages.length > 1 && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setStages((s) => s.slice(0, -1))}>
            Remove last
          </button>
        )}
        {off && (
          <span className="small" style={{ color: 'var(--danger-fg)' }}>
            Stages must total {allocatable}%{locked > 0 ? ` — the other ${locked}% is already invoiced or paid` : ''}
          </span>
        )}
      </div>
    </ActionModal>
  );
}
