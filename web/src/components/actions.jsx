import { useEffect, useState } from 'react';
import { Modal, Field, Input, Select, Alert, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
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
      toast(successMessage, 'success');
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

function ActionModal({ title, subtitle, onClose, onSubmit, busy, error, submitLabel, children, size = 'sm' }) {
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      size={size}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="action-form" className="btn btn--primary" disabled={busy}>
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

export function RecordInvoiceDialog({ stage, onClose, onDone }) {
  const [invoiceNo, setInvoiceNo] = useState(stage.invoice_no || '');
  const [invoiceDate, setInvoiceDate] = useState(stage.invoice_date || today());
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Invoice recorded' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/payment-stages/${stage.id}/invoice`, { invoice_no: invoiceNo, invoice_date: invoiceDate })
    );
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
    </ActionModal>
  );
}

/* -------------------------------------------------- record a receipt */

export function RecordPaymentDialog({ stage, onClose, onDone }) {
  const outstanding = Math.max(Number(stage.stage_amount || 0) - Number(stage.amount_received || 0), 0);
  const [amount, setAmount] = useState(String(outstanding));
  const [paidOn, setPaidOn] = useState(today());
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Payment recorded' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/payment-stages/${stage.id}/payment`, {
        amount_received: Number(amount) + Number(stage.amount_received || 0),
        payment_received_date: paidOn,
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
  const [by, setBy] = useState('HR Team');
  const { busy, error, run } = useAction({ onDone, successMessage: 'Claim updated' });

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/expense-claims/${claim.id}/decide`, { approval_status: status, approved_by: by })
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
      <Field label="Decided by">
        <Input value={by} onChange={(e) => setBy(e.target.value)} />
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
  const [projectId, setProjectId] = useState('');
  const [manager, setManager] = useState('');
  const [managerEmail, setManagerEmail] = useState('');
  const [start, setStart] = useState('');
  const [delivery, setDelivery] = useState('');
  const [applyTemplate, setApplyTemplate] = useState(true);
  const { busy, error, fieldErrors, run } = useAction({ onDone, successMessage: 'Project registered' });

  useEffect(() => {
    api.raw('/lookups/next-id/project').then((r) => setProjectId(r.data.next)).catch(() => {});
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/quotations/${quotation.id}/convert`, {
        project_id: projectId,
        project_manager: manager,
        project_manager_email: managerEmail,
        planned_start_date: start,
        planned_delivery_date: delivery,
        apply_onboarding_template: applyTemplate,
      })
    );
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
      submitLabel="Create project"
      size=""
    >
      <Alert>
        The quotation is marked won and linked to this project. Register the PO next so finance
        can raise the advance invoice.
      </Alert>
      <div className="form-grid">
        <Field label="Project ID" required error={fieldErrors.project_id} hint="Suggested from the last one used">
          <Input value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input mono" />
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

export function PaymentSplitDialog({ po, onClose, onDone }) {
  const [preset, setPreset] = useState('50/50');
  const [stages, setStages] = useState(() => buildStages(PRESETS['50/50']));
  const { busy, error, run } = useAction({ onDone, successMessage: 'Payment stages created' });

  function buildStages(percents) {
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

  const total = stages.reduce((sum, s) => sum + Number(s.percent || 0), 0);

  const submit = async (e) => {
    e.preventDefault();
    const ok = await run(() =>
      api.action(`/purchase-orders/${encodeURIComponent(po.po_number)}/stages`, {
        stages: stages.map((s) => ({
          stage_name: s.stage_name,
          trigger_event: s.trigger_event,
          stage_percent: Number(s.percent) / 100,
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
      size=""
    >
      <Alert>
        Stages triggered <strong>On PO Registration</strong> become invoiceable immediately.
        Ones triggered <strong>On Delivery</strong> wait until the PO's delivery date is recorded.
      </Alert>

      <Field label="Start from a common split">
        <Select
          value={preset}
          placeholder={null}
          options={Object.keys(PRESETS)}
          onChange={(e) => {
            setPreset(e.target.value);
            setStages(buildStages(PRESETS[e.target.value]));
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
                    <option>Manual</option>
                  </select>
                </td>
                <td className="num" style={{ width: 90 }}>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
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
              <td className="num" style={{ color: Math.abs(total - 100) > 0.01 ? 'var(--danger-fg)' : undefined }}>
                {total}%
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
        {Math.abs(total - 100) > 0.01 && <span className="small" style={{ color: 'var(--danger-fg)' }}>Stages must total 100%</span>}
      </div>
    </ActionModal>
  );
}
