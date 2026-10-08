import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, Info, Mail, TriangleAlert } from 'lucide-react';
import { DataTable, Field, Modal, useToast } from './ui.jsx';
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

export const PO_REASONS = {
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
  currency_mismatch: 'Currency differs from the quotation\'s',
  no_currency: 'Currency could not be read',
  wrong_gstin: 'Addressed to a GSTIN we do not invoice from',
  po_number_pattern: 'PO number not of the client\'s usual shape',
  bad_gstin: 'A GSTIN on it was misread',
  readers_disagree: 'An image PDF; two readings differ',
  review_only: 'Read and checked; review-only for now',
};

export const INVOICE_REASONS = {
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
  client_unknown: 'Its client could not be confirmed',
  wrong_gstin: 'Raised from another GSTIN than its PO was addressed to',
  po_date_mismatch: 'The PO date it gives is not the PO\'s',
  bad_gstin: 'A GSTIN on it was misread',
  readers_disagree: 'An image PDF; two readings differ',
  review_only: 'Read and checked; review-only for now',
};

/** How many items wait in a queue, for a tab's count. Null while unknown. */
export function useReviewCount(path) {
  const { data } = useFetch(() => api.raw(path).catch(() => null), [path]);
  return data?.data ? data.data.length : undefined;
}

function OpenEmail({ threadId, phone }) {
  const [open, setOpen] = useState(false);
  if (!threadId) return null;
  return (
    <>
      <button type="button" className={phone ? 'mg-btn' : 'mg-btn mg-btn--ghost mg-btn--sm'} onClick={() => setOpen(true)}>
        <Mail className="size-4" strokeWidth={1.8} aria-hidden="true" />Open email
      </button>
      {open && <EmailThreadDialog threadId={threadId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** "Why it needs a look", in the wait tone, with the reader's note and where it came from. */
function Why({ reasons, row }) {
  return (
    <>
      <span className="app-why" style={{ display: 'block' }}>{reasons[row.review_reason] || row.review_reason}</span>
      {row.review_note && <span className="sub">{row.review_note}</span>}
      {row.mode === 'history' && <span className="sub is-info">from past mail</span>}
    </>
  );
}

/**
 * A review queue as one strong-glass panel: the title and what to do, then
 * the table (phone rows under 768px), or its loading, failed or empty state.
 */
function Queue({ id, title, hint, label, rows, loading, error, onRetry, columns, phone, emptyText }) {
  return (
    <section className="mg-glass mg-glass--strong app-ib-panel" data-a="rise" aria-labelledby={id}>
      <div className="app-ib-panel__head">
        <div className="app-ib-panel__titles"><h2 className="mg-panel__title" id={id}>{title}</h2><p className="mg-panel__hint">{hint}</p></div>
      </div>
      {error ? (
        <div style={{ padding: '0 22px 20px' }}>
          <div className="mg-banner mg-banner--late" role="alert">
            <AlertCircle strokeWidth={1.8} aria-hidden="true" />
            <div className="mg-banner__body"><strong>Couldn’t load the {label.toLowerCase()}.</strong>{error}. Nothing was registered or dismissed.</div>
            <button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}>Try again</button>
          </div>
        </div>
      ) : loading ? (
        <div className="mg-panel" aria-busy="true" aria-label={`Loading the ${label.toLowerCase()}`} style={{ paddingTop: 0 }}>
          <div className="mg-skel" style={{ height: 64 }} /><div className="mg-skel" style={{ height: 64 }} /><div className="mg-skel" style={{ height: 64, width: '84%' }} />
        </div>
      ) : (
        <DataTable
          rows={rows}
          label={label}
          columns={columns}
          phone={phone}
          empty={(
            <div className="mg-empty">
              <span className="mg-empty__mark"><Check className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
              <h3 className="mg-empty__title">Nothing to review</h3>
              <p className="mg-empty__text" style={{ maxWidth: '56ch' }}>{emptyText}</p>
            </div>
          )}
        />
      )}
    </section>
  );
}

/** The facts a review dialog is about, on the track: what was read, and why it is here. */
function Facts({ items }) {
  return (
    <div className="app-ib-facts">
      {items.filter(Boolean).map(([k, v]) => <span key={k}><span className="mg-label">{k}</span>{v}</span>)}
    </div>
  );
}

function Banner({ tone, icon: Icon = Info, children, role = 'note' }) {
  return (
    <div className={`mg-banner${tone ? ` mg-banner--${tone}` : ''}`} role={role}>
      <Icon strokeWidth={1.8} aria-hidden="true" />
      <div className="mg-banner__body" style={{ fontSize: 13 }}>{children}</div>
    </div>
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

  const acts = (r, phone) => (
    <>
      <OpenEmail threadId={r.thread_id} phone={phone} />
      <button type="button" className={phone ? 'mg-btn mg-btn--primary' : 'mg-btn mg-btn--primary mg-btn--sm'} disabled={busy === r.id} onClick={() => setChoosing(r)}>Register against…</button>
      <button type="button" className={phone ? 'mg-btn mg-btn--ghost' : 'mg-btn mg-btn--ghost mg-btn--sm'} disabled={busy === r.id} onClick={() => dismiss(r)}>Not a PO</button>
    </>
  );
  const suggestion = (q) => `${q.quotation_no} · ${q.client_name} · ${money(q.total, q.currency)}`;

  const columns = [
    { key: 'received_at', header: 'Received', className: 'app-nowrap', render: (r) => <>{date(r.received_at)}<span className="sub">{r.mailbox}</span></> },
    { key: 'from_email', header: 'From', render: (r) => (r.from_email ? <strong style={{ overflowWrap: 'anywhere' }}>{r.from_email}</strong> : <span className="text-muted-foreground">—</span>) },
    { key: 'review_reason', header: 'Why it needs a look', className: 'app-say', render: (r) => <Why reasons={PO_REASONS} row={r} /> },
    {
      key: 'suggested', header: 'Suggested quotation', className: 'app-say',
      render: (r) => (r.suggested.length ? r.suggested.map((q, i) => (
        <span key={q.quotation_no} className={i ? 'sub' : undefined} style={i ? undefined : { display: 'block' }}>{suggestion(q)}</span>
      )) : <span className="text-muted-foreground">none</span>),
    },
    { key: 'act', header: '', render: (r) => acts(r, false) },
  ];
  const phone = (r) => (
    <div className="app-rv">
      <span className="app-rv__top"><strong>{r.from_email || 'Unknown sender'}</strong><span>{date(r.received_at)}</span></span>
      <span className="app-rv__why">{PO_REASONS[r.review_reason] || r.review_reason}</span>
      <span className="app-rv__detail">{[r.review_note, r.suggested.length ? `Suggested ${r.suggested.map((q) => q.quotation_no).join(' or ')}` : 'No quotation suggested', r.mode === 'history' ? 'from past mail' : null].filter(Boolean).join(' · ')}</span>
      <span className="app-rv__acts">{acts(r, true)}</span>
    </div>
  );

  return (
    <>
      <Queue
        id="sec-po-review"
        title="Purchase orders read from email that need a person"
        hint="The email reader would not register these on its own. Choose the quotation, or mark it not a PO."
        label="POs to review"
        rows={rows}
        loading={loading && !data}
        error={error}
        onRetry={refetch}
        columns={columns}
        phone={phone}
        emptyText="POs the email reader could not register safely appear here: no matching quotation, a value off the quotation, an amendment, or a reading it was unsure of."
      />
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

/** Which quotation the PO is for, then a fresh read of the email for the Register the PO dialog. */
function ChooseQuotation({ row, onClose, onReady }) {
  const [choice, setChoice] = useState(row.suggested[0]?.quotation_no || '__other__');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [missing, setMissing] = useState(null);
  const other = choice === '__other__';
  const key = (other ? typed : choice).trim();

  async function go(e) {
    e.preventDefault();
    if (!key) return;
    setBusy(true); setError(null); setMissing(null);
    try {
      const { data: quotation } = await api.get('quotations', key);
      const { data: read } = await api.action(`/purchase-orders/review/${row.id}/register`);
      onReady({ quotation, prefill: read.prefill, reviewId: row.id, note: read.note });
    } catch (err) {
      if (err.status === 404) setMissing(`There is no quotation ${key} you can open. Check the number, or ask its owner to share the deal with you.`);
      else setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Register this PO against…"
      subtitle={`${row.from_email || 'Client'} · received ${date(row.received_at)}`}
      onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="choose-quotation" className="mg-btn mg-btn--primary" disabled={busy || !key} aria-busy={busy || undefined}>{busy ? 'Reading the PO again…' : 'Continue'}</button>
      </>}
    >
      <form id="choose-quotation" onSubmit={go} className="flex flex-col gap-3.5">
        <Facts items={[['From', row.from_email || '—'], ['Why it is here', PO_REASONS[row.review_reason] || row.review_reason]]} />
        {error && <Banner tone="late" icon={AlertCircle} role="alert">{error}</Banner>}
        <Field label="Quotation" hint="The PO is read again from the email and the Register the PO form is filled in. Nothing is saved until you register it.">
          <span className="mg-select-wrap">
            <select className="mg-select" value={choice} onChange={(e) => { setChoice(e.target.value); setMissing(null); }}>
              {row.suggested.map((q) => <option key={q.quotation_no} value={q.quotation_no}>{`${q.quotation_no} · ${q.client_name} · ${money(q.total, q.currency)}`}</option>)}
              <option value="__other__">Another quotation…</option>
            </select>
          </span>
        </Field>
        {other && (
          <Field label="Quotation number" required error={missing}>
            <input className="mg-input" value={typed} onChange={(e) => { setTyped(e.target.value); setMissing(null); }} placeholder="CTZ/QT/2026/045" autoFocus aria-invalid={missing ? true : undefined} />
          </Field>
        )}
        {!other && missing && <Banner tone="late" icon={AlertCircle} role="alert">{missing}</Banner>}
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

  // The split the item suggests (an invoice for part of a PO with one 100% stage): the stage is split, then the invoice dialog opens on the new share.
  async function split(row) {
    setBusy(row.id);
    try {
      await api.action(`/payment-stages/invoice-review/${row.id}/split`);
      refetch();
      setChoosing({ ...row, split_suggestion: null, stages: null });
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }

  const acts = (r, phone) => (
    <>
      <OpenEmail threadId={r.thread_id} phone={phone} />
      {r.split_suggestion && <button type="button" className={phone ? 'mg-btn' : 'mg-btn mg-btn--sm'} disabled={busy === r.id} onClick={() => split(r)} title={`The invoice covers ${r.split_suggestion.percent}% of a PO with one 100% stage: this splits that stage in two, then records the invoice against the ${r.split_suggestion.percent}% share`}>Split {r.split_suggestion.percent}% and record</button>}
      {r.split_suggestion && <span className="basis-full text-[12px] text-muted-foreground" style={{ whiteSpace: 'normal' }}>Splits the PO's one 100% stage into {r.split_suggestion.percent}% (this invoice) and {100 - Number(r.split_suggestion.percent)}% still to bill.</span>}
      <button type="button" className={phone ? 'mg-btn mg-btn--primary' : 'mg-btn mg-btn--primary mg-btn--sm'} disabled={busy === r.id} onClick={() => setChoosing(r)}>Record against…</button>
      <button type="button" className={phone ? 'mg-btn mg-btn--ghost' : 'mg-btn mg-btn--ghost mg-btn--sm'} disabled={busy === r.id} onClick={() => dismiss(r)}>Not an invoice</button>
    </>
  );

  const columns = [
    { key: 'sent_at', header: 'Sent', className: 'app-nowrap', render: (r) => <>{date(r.sent_at)}<span className="sub">{r.mailbox}</span></> },
    { key: 'to_emails', header: 'To', render: (r) => ((r.to_emails || []).length ? <span style={{ overflowWrap: 'anywhere' }}>{r.to_emails.join(', ')}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'invoice_no', header: 'Invoice', className: 'app-nowrap', render: (r) => (r.invoice_no ? <strong className="mg-num">{r.invoice_no}</strong> : <span className="text-muted-foreground">not read</span>) },
    { key: 'po_number', header: 'PO', className: 'app-nowrap', render: (r) => (r.po_number ? <span className="mg-num">{r.po_number}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'review_reason', header: 'Why it needs a look', className: 'app-say', render: (r) => <Why reasons={INVOICE_REASONS} row={r} /> },
    { key: 'act', header: '', render: (r) => acts(r, false) },
  ];
  const phone = (r) => (
    <div className="app-rv">
      <span className="app-rv__top"><strong>{(r.to_emails || [])[0] || 'Unknown client'}</strong><span>{date(r.sent_at)}</span></span>
      <span className="app-rv__why">{INVOICE_REASONS[r.review_reason] || r.review_reason}</span>
      <span className="app-rv__detail">{[r.invoice_no || 'Invoice number not read', r.po_number ? `PO ${r.po_number}` : 'no PO', r.review_note, r.mode === 'history' ? 'from past mail' : null].filter(Boolean).join(' · ')}</span>
      <span className="app-rv__acts">{acts(r, true)}</span>
    </div>
  );

  return (
    <>
      <Queue
        id="sec-invoice-review"
        title="Invoices we emailed that need a person"
        hint="The email reader would not record these on its own. Choose the stage, split one, or mark it not an invoice."
        label="Invoices to review"
        rows={rows}
        loading={loading && !data}
        error={error}
        onRetry={refetch}
        columns={columns}
        phone={phone}
        emptyText="Invoices the email reader could not record safely appear here: an amount that is not a stage, a number already in use, no PO, or a credit note."
      />
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

/**
 * Which stage the invoice is for, then a fresh read of the email for the
 * dialog. An item matched to no PO (its PO was not in the tracker, or
 * several fitted) asks for the PO first.
 */
function ChooseStage({ row, onClose, onReady }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [read, setRead] = useState(null);
  const [stageId, setStageId] = useState('');
  const [poNumber, setPoNumber] = useState(row.po_number || '');
  const [stages, setStages] = useState(row.po_number ? row.stages : null);
  const open = (stages || []).filter((s) => !s.invoice_no);
  const invoiced = (stages || []).filter((s) => s.invoice_no);

  async function loadPo() {
    const { data } = await api.raw(`/purchase-orders/${encodeURIComponent(poNumber.trim())}/full`);
    return data.payment_stages;
  }

  async function readAgain() {
    setBusy(true); setError(null);
    try {
      const list = stages || await loadPo();
      setStages(list);
      const { data } = await api.action(`/payment-stages/invoice-review/${row.id}/record`);
      setRead(data);
      const openNow = list.filter((s) => !s.invoice_no);
      // Only an open stage is ever chosen for you: one with an invoice would be overwritten.
      const suggested = openNow.find((s) => s.id === data.suggested_stage_id);
      setStageId(String(suggested?.id || openNow[0]?.id || ''));
    } catch (err) {
      setError(err.status === 404 ? `There is no purchase order ${poNumber} you can open` : err.message);
    } finally { setBusy(false); }
  }

  async function go(e) {
    e.preventDefault();
    if (!read) return readAgain();
    if (!open.some((s) => String(s.id) === stageId)) return;
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
      subtitle={`${row.invoice_no || 'Invoice'}${row.po_number ? ` · PO ${row.po_number}` : ''}`}
      onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" form="choose-stage" className="mg-btn mg-btn--primary" disabled={busy || (!read && !poNumber.trim()) || (read && !stageId)} aria-busy={busy || undefined}>
          {busy ? 'Reading the invoice again…' : read ? 'Continue' : 'Read the invoice'}
        </button>
      </>}
    >
      <form id="choose-stage" onSubmit={go} className="flex flex-col gap-3.5">
        <Facts items={[['Invoice', row.invoice_no || 'not read'], row.po_number && ['PO', row.po_number], ['Why it is here', INVOICE_REASONS[row.review_reason] || row.review_reason]]} />
        {error && <Banner tone="late" icon={AlertCircle} role="alert">{error}</Banner>}
        {read?.note && <Banner tone="wait" icon={TriangleAlert}>{read.note}</Banner>}
        {!read && <Banner>The invoice is read again from the email, and the invoice dialog is filled in. Nothing is saved until you record it.</Banner>}
        {!read && !row.po_number && (
          <Field label="Purchase order" hint="This invoice was matched to no PO: name the one it bills. Register the PO first if it is not in the tracker.">
            <input className="mg-input" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="4500012345" autoFocus />
          </Field>
        )}
        {read && (
          <>
            {total != null && (
              <Banner>
                The invoice was read again from the email, so what you record matches what the client was sent: <strong style={{ display: 'inline' }}>{money(total, read.prefill.currency)}</strong>.
              </Banner>
            )}
            {total != null && open.length > 0 && !open.some(fits) && (
              <Banner tone="wait" icon={TriangleAlert}>
                {money(total, read.prefill.currency)} fits no open stage of this PO. Re-split the stages on the{' '}
                <Link className="app-link" to={`/purchase-orders/${encodeURIComponent(poNumber)}`}>PO’s page</Link> first if the invoice covers a different share.
              </Banner>
            )}
            {open.length ? (
              <Field label="Stage">
                <span className="mg-select-wrap">
                  <select className="mg-select" value={stageId} onChange={(e) => setStageId(e.target.value)}>
                    {open.map((s) => <option key={s.id} value={String(s.id)}>{`${s.stage_no}. ${s.stage_name} · ${money(s.stage_amount, s.currency)}${fits(s) ? ' · matches' : ''}`}</option>)}
                    {invoiced.map((s) => <option key={s.id} value={String(s.id)} disabled>{`${s.stage_no}. ${s.stage_name} · ${money(s.stage_amount, s.currency)} · already invoiced`}</option>)}
                  </select>
                </span>
              </Field>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="text-[12px] font-medium text-secondary-foreground">Stage</span>
                <span className="mg-badge mg-badge--wait" style={{ alignSelf: 'flex-start' }}>Every stage of this PO has an invoice</span>
                <span className="text-[12px] text-muted-foreground">Add a stage on the PO’s page, or mark this one not an invoice.</span>
              </div>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}
