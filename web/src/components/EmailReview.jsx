import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Badge, Card, DataTable, Empty, Field, Input, Modal, Select, useToast } from './ui.jsx';
import { Button } from './ui/button';
import { EmailThreadDialog } from './EmailThread.jsx';
import { RegisterPoDialog } from './RegisterPoDialog.jsx';
import { RecordInvoiceDialog } from './actions.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * The review queues of docs/email-po-plan.md: client POs (§3.7) and our own
 * invoices (§3.10.5) that the email reader would not register on its own.
 * Each item can be opened, registered or recorded by hand from a fresh read
 * of the email, or dismissed.
 */

const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';

const PO_REASONS = {
  no_match: 'No quotation matches it',
  several_matches: 'More than one quotation could be it',
  not_to_us: 'Not addressed to us',
  low_confidence: 'Could not be read with confidence',
  no_po_number: 'No PO number',
  value_mismatch: 'Value differs from the quotation',
  company_mismatch: 'Client differs from the quotation\'s',
  amendment: 'Amends an earlier PO',
  cancellation: 'Cancels a PO',
  multiple_pos: 'More than one PO in it',
  unreadable: 'The PDF could not be opened',
  no_value: 'No value could be read',
  amounts_not_in_pdf: 'Amounts not found in the PDF',
  totals_do_not_add_up: 'Totals do not add up',
  bad_currency: 'Currency the tracker does not use',
};

const INVOICE_REASONS = {
  po_not_found: 'Its PO is not in the tracker',
  several_pos: 'More than one PO could be it',
  amount_not_a_stage: 'Amount is not one of the PO\'s stages',
  po_without_stages: 'The PO has no payment stages',
  invoice_no_in_use: 'Number already on another stage',
  not_from_us: 'Not our invoice',
  low_confidence: 'Could not be read with confidence',
  credit_note: 'A credit or debit note',
  revised: 'Revises or cancels an invoice',
  unreadable: 'The PDF could not be opened',
  no_invoice_no: 'No invoice number',
  amounts_not_in_pdf: 'Amounts not found in the PDF',
  totals_do_not_add_up: 'Totals do not add up',
  bad_currency: 'Currency the tracker does not use',
  bad_date: 'Date missing, or after it was sent',
};

/** How many items wait in a queue, for a tab's count. Null while unknown. */
export function useReviewCount(path) {
  const { data } = useFetch(() => api.raw(path).catch(() => null), [path]);
  return data?.data ? data.data.length : undefined;
}

function OpenEmail({ threadId }) {
  const [open, setOpen] = useState(false);
  if (!threadId) return null;
  return (
    <>
      <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setOpen(true)}>Open email</Button>
      {open && <EmailThreadDialog threadId={threadId} onClose={() => setOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------- POs

export function PoReviewList() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/purchase-orders/review'), []);
  const [choosing, setChoosing] = useState(null);
  const [registering, setRegistering] = useState(null);
  const [busy, setBusy] = useState(null);
  const rows = data?.data || [];

  async function dismiss(row) {
    setBusy(row.id);
    try { await api.action(`/purchase-orders/review/${row.id}/dismiss`); toast('Marked not a PO', 'success'); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }

  const columns = [
    { key: 'received_at', header: 'Received', render: (r) => <>{date(r.received_at)}<div className="small muted">{r.mailbox}</div></> },
    { key: 'from_email', header: 'From', className: 'small', render: (r) => r.from_email || <span className="muted">—</span> },
    {
      key: 'review_reason', header: 'Why it needs a look',
      render: (r) => <>{PO_REASONS[r.review_reason] || r.review_reason}{r.mode === 'history' && <div className="small muted">from past mail</div>}</>,
    },
    {
      key: 'suggested', header: 'Suggested quotation',
      render: (r) => (r.suggested.length ? r.suggested.map((q) => (
        <div key={q.quotation_no} className="small"><span className="mono">{q.quotation_no}</span> · {q.client_name} · {money(q.total, q.currency)}</div>
      )) : <span className="muted small">none</span>),
    },
    {
      key: 'act', header: '', align: 'right',
      render: (r) => (
        <div className="table__actions">
          <OpenEmail threadId={r.thread_id} />
          <Button size="sm" className={ROW_BUTTON} disabled={busy === r.id} onClick={() => setChoosing(r)}>Register against…</Button>
          <Button variant="secondary" size="sm" className={ROW_BUTTON} disabled={busy === r.id} onClick={() => dismiss(r)}>Not a PO</Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card flush title="Purchase orders read from email that need a person">
        <DataTable
          rows={rows}
          loading={loading && !data}
          label="POs to review"
          columns={columns}
          empty={<Empty title="Nothing to review" text="POs the email reader could not register safely appear here: no matching quotation, a value off the quotation, an amendment, or a reading it was unsure of." />}
        />
      </Card>
      {choosing && (
        <ChooseQuotation
          row={choosing}
          onClose={() => setChoosing(null)}
          onReady={(state) => { setChoosing(null); setRegistering(state); }}
        />
      )}
      {registering && (
        <RegisterPoDialog
          quotation={registering.quotation}
          prefill={registering.prefill}
          reviewId={registering.reviewId}
          note={registering.note}
          onClose={() => setRegistering(null)}
          onDone={(done) => { refetch(); navigate(`/purchase-orders/${encodeURIComponent(done.po_number)}`); }}
        />
      )}
    </>
  );
}

/** Which quotation the PO is for, then a fresh read of the email for the dialog. */
function ChooseQuotation({ row, onClose, onReady }) {
  const [choice, setChoice] = useState(row.suggested[0]?.quotation_no || '');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const key = (choice === '__other__' ? typed : choice).trim();

  async function go(e) {
    e.preventDefault();
    if (!key) return;
    setBusy(true); setError(null);
    try {
      const { data: quotation } = await api.get('quotations', key);
      const { data: read } = await api.action(`/purchase-orders/review/${row.id}/register`);
      onReady({ quotation, prefill: read.prefill, reviewId: row.id, note: read.note });
    } catch (err) {
      setError(err.status === 404 ? `There is no quotation ${key} you can open` : err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register this PO against…"
      subtitle={`${row.from_email || 'Client'} · received ${date(row.received_at)}`}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="choose-quotation" className="btn btn--primary" disabled={busy || !key}>{busy ? 'Reading the PO again…' : 'Continue'}</button></>}
    >
      <form id="choose-quotation" onSubmit={go} className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Quotation" hint="The PO is read again from the email and the Register PO dialog is filled in; nothing is saved until you register it.">
          <Select
            value={choice}
            placeholder={null}
            options={[...row.suggested.map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} · ${q.client_name} · ${money(q.total, q.currency)}` })), { value: '__other__', label: 'Another quotation…' }]}
            onChange={(e) => setChoice(e.target.value)}
          />
        </Field>
        {choice === '__other__' && (
          <Field label="Quotation number"><Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="CTZ/QT/2026/045" autoFocus /></Field>
        )}
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------- invoices

export function InvoiceReviewList() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/payment-stages/invoice-review'), []);
  const [choosing, setChoosing] = useState(null);
  const [recording, setRecording] = useState(null);
  const [busy, setBusy] = useState(null);
  const rows = data?.data || [];

  async function dismiss(row) {
    setBusy(row.id);
    try { await api.action(`/payment-stages/invoice-review/${row.id}/dismiss`); toast('Marked not an invoice', 'success'); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }

  const columns = [
    { key: 'sent_at', header: 'Sent', render: (r) => <>{date(r.sent_at)}<div className="small muted">{r.mailbox}</div></> },
    { key: 'to_emails', header: 'To', className: 'small', render: (r) => (r.to_emails || []).join(', ') || <span className="muted">—</span> },
    { key: 'invoice_no', header: 'Invoice', className: 'mono small', render: (r) => r.invoice_no || <span className="muted">not read</span> },
    { key: 'po_number', header: 'PO', className: 'mono small', render: (r) => r.po_number || <span className="muted">—</span> },
    {
      key: 'review_reason', header: 'Why it needs a look',
      render: (r) => <>{INVOICE_REASONS[r.review_reason] || r.review_reason}{r.mode === 'history' && <div className="small muted">from past mail</div>}</>,
    },
    {
      key: 'act', header: '', align: 'right',
      render: (r) => (
        <div className="table__actions">
          <OpenEmail threadId={r.thread_id} />
          <Button size="sm" className={ROW_BUTTON} disabled={busy === r.id || !r.po_number} title={r.po_number ? undefined : 'Register its PO first'} onClick={() => setChoosing(r)}>Record against…</Button>
          <Button variant="secondary" size="sm" className={ROW_BUTTON} disabled={busy === r.id} onClick={() => dismiss(r)}>Not an invoice</Button>
        </div>
      ),
    },
  ];

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card flush title="Invoices we emailed that need a person">
        <DataTable
          rows={rows}
          loading={loading && !data}
          label="Invoices to review"
          columns={columns}
          empty={<Empty title="Nothing to review" text="Invoices the email reader could not record safely appear here: an amount that is not a stage, a number already in use, no PO, or a credit note." />}
        />
      </Card>
      {choosing && (
        <ChooseStage
          row={choosing}
          onClose={() => setChoosing(null)}
          onReady={(state) => { setChoosing(null); setRecording(state); }}
        />
      )}
      {recording && (
        <RecordInvoiceDialog
          stage={recording.stage}
          prefill={recording.prefill}
          reviewId={recording.reviewId}
          onClose={() => setRecording(null)}
          onDone={() => { setRecording(null); refetch(); }}
        />
      )}
    </>
  );
}

/** Which stage the invoice is for, then a fresh read of the email for the dialog. */
function ChooseStage({ row, onClose, onReady }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [read, setRead] = useState(null);
  const [stageId, setStageId] = useState('');
  const open = row.stages.filter((s) => !s.invoice_no);

  async function readAgain() {
    setBusy(true); setError(null);
    try {
      const { data } = await api.action(`/payment-stages/invoice-review/${row.id}/record`);
      setRead(data);
      setStageId(String(data.suggested_stage_id || open[0]?.id || ''));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function go(e) {
    e.preventDefault();
    if (!read) return readAgain();
    setBusy(true); setError(null);
    try {
      const { data: stage } = await api.get('payment-stages', stageId);
      onReady({ stage, prefill: read.prefill || {}, reviewId: row.id });
    } catch (err) { setError(err.message); setBusy(false); }
  }

  const total = read?.prefill?.total_value;
  const fits = (s) => total != null && Math.abs(Number(s.stage_amount) - Number(total)) <= Math.max(1, 0.005 * Number(total));

  return (
    <Modal
      title="Record this invoice against…"
      subtitle={`${row.invoice_no || 'Invoice'} · PO ${row.po_number}`}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="choose-stage" className="btn btn--primary" disabled={busy || (read && !stageId)}>{busy ? 'Reading the invoice again…' : read ? 'Continue' : 'Read the invoice'}</button></>}
    >
      <form id="choose-stage" onSubmit={go} className="stack">
        {error && <Alert tone="danger">{error}</Alert>}
        {read?.note && <Alert tone="warning">{read.note}</Alert>}
        {!read && <Alert>The invoice is read again from the email, and the invoice dialog is filled in. Nothing is saved until you record it.</Alert>}
        {read && (
          <>
            {total != null && !open.some(fits) && (
              <Alert tone="warning">
                The invoice is for {money(total, read.prefill.currency)}, which is none of this PO's open stages.
                Re-split the stages on the <Link to={`/purchase-orders/${encodeURIComponent(row.po_number)}`}>PO's page</Link> first if the invoice covers a different share.
              </Alert>
            )}
            <Field label="Stage">
              <Select
                value={stageId}
                placeholder={null}
                options={open.map((s) => ({ value: String(s.id), label: `${s.stage_no}. ${s.stage_name} · ${money(s.stage_amount, s.currency)}${fits(s) ? ' · matches' : ''}` }))}
                onChange={(e) => setStageId(e.target.value)}
              />
            </Field>
            {!open.length && <Badge tone="warning">Every stage of this PO has an invoice</Badge>}
          </>
        )}
      </form>
    </Modal>
  );
}
