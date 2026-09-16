import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, ConfirmDialog, DataTable, DocumentLink, Empty, ErrorState, Field, Input, KeyValues, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { ConvertQuotationDialog } from '../components/actions.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';
import { quotationFields } from './Quotations.jsx';

/**
 * One quotation as a document (#23): its lines and totals, validity,
 * revisions, the PDF, sending, acceptance, and the road to a project.
 */
export default function QuotationDetail() {
  const { key } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [editing, setEditing] = useState(false);
  const [line, setLine] = useState(null);         // 'new' | line record
  const [removing, setRemoving] = useState(null);
  const [revising, setRevising] = useState(false);
  const [sending, setSending] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useFetch(() => api.raw(`/quotations/${encodeURIComponent(key)}/full`), [key]);
  const q = data?.data;

  async function act(path, body, okMessage) {
    setBusy(true);
    try {
      const { data: r } = await api.action(`/quotations/${encodeURIComponent(key)}/${path}`, body);
      toast(typeof okMessage === 'function' ? okMessage(r) : okMessage, 'success');
      invalidateLookups();
      refetch();
      return r;
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (error) return <><PageHeader title="Quotation" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (loading || !q) return <><PageHeader title="Quotation" /><div className="page"><div className="skeleton" style={{ height: 240 }} /></div></>;

  const cur = q.currency;
  const open = ['Submitted', 'Under Negotiation', 'On Hold'].includes(q.status);
  const won = q.status === 'Won - PO Received';
  const approvalBlocked = q.approval_status === 'pending' || q.approval_status === 'rejected';

  return (
    <>
      <PageHeader
        title={<>{q.quotation_no}{q.revision > 0 && <span className="muted"> · Rev {q.revision}</span>}</>}
        subtitle={<>{q.client_name} · {q.service_quoted || 'no subject'} · <Badge>{q.status}</Badge>{q.expired && <> · <Badge tone="danger">expired</Badge></>}{q.approval_status === 'pending' && <> · <Badge tone="warning">discount awaiting approval</Badge></>}</>}
        actions={
          <>
            <Link className="btn" to="/quotations">All quotations</Link>
            <a className="btn" href={`/api/quotations/${encodeURIComponent(q.quotation_no)}/pdf`} target="_blank" rel="noopener noreferrer">PDF</a>
            {open && !approvalBlocked && <button type="button" className="btn" onClick={() => setSending(true)}>Send</button>}
            {open && !q.accepted_at && <button type="button" className="btn" onClick={() => setAccepting(true)}>Client accepted</button>}
            {!won && <button type="button" className="btn" onClick={() => setRevising(true)}>Revise</button>}
            {won && !q.project_id && <button type="button" className="btn btn--primary" onClick={() => setConverting(true)}>Register project</button>}
            <button type="button" className="btn btn--primary" onClick={() => setEditing(true)}>Edit</button>
          </>
        }
      />
      <div className="page stack">
        {q.expired && open && <Alert tone="warning"><span>This quotation passed its validity date ({date(q.valid_until)}). Revise it to reopen it with a fresh date, or mark it lost.</span></Alert>}
        {q.approval_status === 'pending' && <Alert tone="warning"><span>The discount on this quotation is above the threshold and waits for approval before it can be sent.</span></Alert>}

        <div className="grid grid--2">
          <Card title="Quotation">
            <KeyValues items={[
              { label: 'Client', value: q.company_id ? <Link to={`/companies/${q.company_id}`}>{q.client_name}</Link> : q.client_name },
              { label: 'Contact', value: q.contact ? <>{q.contact.name}{q.contact.email && <div className="small muted">{q.contact.email}</div>}</> : q.contact_person },
              { label: 'Date', value: date(q.quotation_date) },
              { label: 'Valid until', value: q.valid_until ? <span style={{ color: q.expired ? 'var(--danger-fg)' : undefined }}>{date(q.valid_until)}</span> : <span className="muted">not set</span> },
              { label: 'Sales person', value: q.sales_person },
              { label: 'Sector', value: q.sector },
              { label: 'Sent', value: q.sent_at ? new Date(q.sent_at).toLocaleString() : <span className="muted">not yet</span> },
              { label: 'Accepted', value: q.accepted_at ? `${new Date(q.accepted_at).toLocaleDateString()} by ${q.accepted_by_name}` : <span className="muted">not yet</span> },
              { label: 'Enquiry', value: q.enquiry ? <Link to={`/enquiries?q=${encodeURIComponent(q.enquiry.enquiry_no)}`}>{q.enquiry.enquiry_no}</Link> : null },
              { label: 'Project', value: q.project_id ? <Link to={`/projects/${encodeURIComponent(q.project_id)}`}>{q.project_id}</Link> : null },
              { label: 'Client copy', value: <DocumentLink id={q.document_id} name={q.document_name} /> },
            ]} />
          </Card>
          <Card title="Value">
            <KeyValues items={[
              { label: q.line_count ? 'Subtotal' : 'Quoted value', value: money(q.line_count ? q.subtotal : q.quotation_value, cur) },
              q.line_count ? { label: 'GST', value: money(q.tax_total, cur) } : null,
              { label: 'Total', value: <strong>{money(q.line_count ? q.total : q.quotation_value, cur)}</strong> },
              { label: 'Currency', value: cur },
              q.purchase_orders.length ? { label: 'Purchase orders', value: q.purchase_orders.map((p) => <div key={p.po_number}><Link className="mono" to={`/purchase-orders/${encodeURIComponent(p.po_number)}`}>{p.po_number}</Link> · {money(p.po_value, p.currency)} · <Badge>{p.payment_status}</Badge></div>) } : null,
              { label: 'Payment', value: q.payment_status ? <Badge>{q.payment_status}</Badge> : null },
            ].filter(Boolean)} />
          </Card>
        </div>

        <Card
          flush
          title="Lines"
          hint="What is being quoted, priced. The totals and the quotation value follow these lines."
          actions={!won && <button type="button" className="btn btn--primary btn--sm" onClick={() => setLine('new')}>+ Line</button>}
        >
          <DataTable
            rows={q.lines}
            columns={[
              { key: 'n', header: '#', width: 40, render: (l, i) => l.sort_order || '' },
              { key: 'description', header: 'Description', className: 'wrap strong', render: (l) => <>{l.description}{l.service_name && l.service_name !== l.description && <div className="small muted">{l.service_name}</div>}</> },
              { key: 'qty', header: 'Qty', align: 'right', render: (l) => `${Number(l.qty)} ${l.unit || ''}` },
              { key: 'rate', header: 'Rate', align: 'right', render: (l) => money(l.rate, cur) },
              { key: 'discount_percent', header: 'Discount', align: 'right', render: (l) => (Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : <span className="muted">—</span>) },
              { key: 'gst_rate', header: 'GST', align: 'right', render: (l) => `${Number(l.gst_rate)}%` },
              { key: 'amount', header: 'Amount', align: 'right', className: 'strong', render: (l) => money(l.amount, cur) },
              { key: 'act', header: '', align: 'right', render: (l) => !won && <div className="table__actions"><button type="button" className="btn btn--sm btn--ghost" onClick={() => setLine(l)}>Edit</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving(l)}>✕</button></div> },
            ]}
            footer={q.lines.length > 0 && <><td colSpan={6} className="num">Subtotal {money(q.subtotal, cur)} · GST {money(q.tax_total, cur)}</td><td className="num strong">{money(q.total, cur)}</td><td /></>}
            empty={<Empty title="No lines yet" text="Add the services being quoted with their rates. Until then the quoted value typed on the form stands." action={!won && <button type="button" className="btn btn--primary" onClick={() => setLine('new')}>+ Line</button>} />}
          />
        </Card>

        {q.terms && <Card title="Terms"><div style={{ whiteSpace: 'pre-wrap' }}>{q.terms}</div></Card>}

        {q.revisions.length > 0 && (
          <Card flush title={`Revisions · ${q.revisions.length}`} hint="Earlier versions, as they stood before each revision.">
            <DataTable rows={q.revisions} columns={[
              { key: 'revision', header: 'Rev', render: (r) => `Rev ${r.revision}` },
              { key: 'created_at', header: 'Replaced on', render: (r) => new Date(r.created_at).toLocaleString() },
              { key: 'total', header: 'Was', align: 'right', render: (r) => money(r.snapshot.total ?? r.snapshot.quotation_value, r.snapshot.currency) },
              { key: 'valid', header: 'Valid until', render: (r) => date(r.snapshot.valid_until) },
              { key: 'lines', header: 'Lines', align: 'right', render: (r) => r.snapshot.lines?.length ?? 0 },
              { key: 'note', header: 'Why', className: 'wrap' },
              { key: 'by', header: 'By', className: 'small muted', render: (r) => r.created_by },
            ]} />
          </Card>
        )}
      </div>

      {editing && (
        <RecordForm title="Edit quotation" resource="quotations" fields={quotationFields(lookups).filter((f) => !f.auto)} record={q} onClose={() => setEditing(false)} onSaved={() => { invalidateLookups(); refetch(); }} />
      )}
      {line && (
        <LineForm quotation={q} line={line === 'new' ? null : line} catalogue={lookups.catalogue} settings={q.settings} onClose={() => setLine(null)} onSaved={() => { setLine(null); refetch(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Remove this line?" message="The totals update straight away." confirmLabel="Remove" busy={busy} onClose={() => setRemoving(null)} onConfirm={async () => { setBusy(true); try { await api.remove('quotation-lines', removing.id); setRemoving(null); refetch(); } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); } }} />
      )}
      {revising && (
        <ReviseDialog busy={busy} onClose={() => setRevising(false)} onConfirm={async (note) => { const r = await act('revise', { note }, (x) => `Now revision ${x.revision}, valid until ${date(x.valid_until)}`); if (r) setRevising(false); }} />
      )}
      {sending && (
        <SendDialog quotation={q} busy={busy} onClose={() => setSending(false)} onConfirm={async (body) => { const r = await act('send', body, (x) => (x.email ? `Marked sent; email ${x.email.status}${x.email.reason ? ` (${x.email.reason})` : ''}` : 'Marked as sent')); if (r) setSending(false); }} />
      )}
      {accepting && (
        <AcceptDialog quotation={q} busy={busy} onClose={() => setAccepting(false)} onConfirm={async (name) => { const r = await act('accept', { accepted_by_name: name }, 'Acceptance recorded'); if (r) setAccepting(false); }} />
      )}
      {converting && (
        <ConvertQuotationDialog quotation={q} onClose={() => setConverting(false)} onDone={() => { setConverting(false); invalidateLookups(); refetch(); }} />
      )}
    </>
  );
}

/** A line: pick a catalogue service to fill the rate and GST, or type a one-off. */
function LineForm({ quotation, line, catalogue, settings, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState(() => line ? { ...line } : { service_id: '', description: '', qty: 1, unit: 'engagement', rate: '', discount_percent: 0, gst_rate: settings?.gst_rate_default || 18, sort_order: (quotation.lines?.length || 0) + 1 });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const pickService = (id) => {
    const svc = catalogue.find((c) => String(c.id) === String(id));
    setV((s) => ({ ...s, service_id: id, description: svc ? svc.name : s.description, rate: svc?.default_rate ?? s.rate, gst_rate: svc?.gst_rate ?? s.gst_rate, unit: svc?.unit || s.unit }));
  };
  const amount = Math.round(Number(v.qty || 0) * Number(v.rate || 0) * (1 - Number(v.discount_percent || 0) / 100) * 100) / 100;

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErrors({});
    const payload = { quotation_id: quotation.id, service_id: v.service_id || null, description: v.description, qty: v.qty, unit: v.unit, rate: v.rate, discount_percent: v.discount_percent, gst_rate: v.gst_rate, sort_order: v.sort_order };
    try {
      if (line) await api.update('quotation-lines', line.id, payload); else await api.create('quotation-lines', payload);
      onSaved();
    } catch (err) { setErrors(err.fields || {}); toast(err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title={line ? 'Edit line' : 'Add line'} subtitle={quotation.quotation_no} onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="line-form" className="btn btn--primary" disabled={busy}>{busy ? 'Saving…' : 'Save line'}</button></>}>
      <form id="line-form" onSubmit={submit} className="form-grid">
        <div className="span-all"><Field label="Service from the catalogue" hint="Fills the description, rate and GST; edit anything after"><Select value={String(v.service_id || '')} placeholder="One-off line (not in the catalogue)" options={catalogue.map((c) => ({ value: String(c.id), label: `${c.name}${c.default_rate ? ` · ${money(c.default_rate, c.currency)}` : ''}` }))} onChange={(e) => pickService(e.target.value)} /></Field></div>
        <div className="span-all"><Field label="Description" required error={errors.description}><Textarea rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} /></Field></div>
        <Field label="Quantity" error={errors.qty}><Input type="number" step="any" min="0.01" value={v.qty} onChange={(e) => set('qty', e.target.value)} /></Field>
        <Field label="Unit"><Select value={v.unit || ''} placeholder="—" options={['engagement', 'site', 'day', 'audit', 'report', 'year']} onChange={(e) => set('unit', e.target.value)} /></Field>
        <Field label={`Rate (${quotation.currency})`} error={errors.rate}><Input type="number" step="0.01" min="0" value={v.rate} onChange={(e) => set('rate', e.target.value)} /></Field>
        <Field label="Discount %" error={errors.discount_percent} hint={settings?.discount_approval_threshold_percent ? `Above ${settings.discount_approval_threshold_percent}% needs approval` : undefined}><Input type="number" step="0.5" min="0" max="100" value={v.discount_percent} onChange={(e) => set('discount_percent', e.target.value)} /></Field>
        <Field label="GST %" error={errors.gst_rate}><Input type="number" step="0.5" min="0" max="100" value={v.gst_rate} onChange={(e) => set('gst_rate', e.target.value)} /></Field>
        <Field label="Order"><Input type="number" step="1" value={v.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field>
        <div className="span-all small muted">Line amount before GST: <strong>{money(amount, quotation.currency)}</strong></div>
      </form>
    </Modal>
  );
}

function ReviseDialog({ busy, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  return (
    <Modal title="Revise this quotation" subtitle="The current version is kept in the history. The revision number goes up, the date and validity restart, and it counts as not yet sent." onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy} onClick={() => onConfirm(note)}>{busy ? 'Revising…' : 'Revise'}</button></>}>
      <Field label="What changed" hint="Kept with the old version"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Client asked for two sites instead of one" /></Field>
    </Modal>
  );
}

function SendDialog({ quotation, busy, onClose, onConfirm }) {
  const [email, setEmail] = useState(Boolean(quotation.contact?.email));
  const [to, setTo] = useState(quotation.contact?.email || '');
  const [message, setMessage] = useState('');
  return (
    <Modal title="Send this quotation" subtitle="Marks it as sent. Tick the box to also email the PDF to the client; the email is logged under Emails & jobs." onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy || (email && !to)} onClick={() => onConfirm({ email, to: email ? to : undefined, message })}>{busy ? 'Sending…' : email ? 'Send email and mark sent' : 'Mark as sent'}</button></>}>
      <div className="stack">
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the PDF to the client</label>
        {email && <Field label="To" required><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@company.com" /></Field>}
        {email && <Field label="Message" hint="Blank: a standard covering note"><Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

function AcceptDialog({ quotation, busy, onClose, onConfirm }) {
  const [name, setName] = useState(quotation.contact?.name || quotation.contact_person || '');
  return (
    <Modal title="Client accepted" subtitle="Records who said yes and when. The quotation moves to Under Negotiation until the PO arrives." onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => onConfirm(name.trim())}>{busy ? 'Saving…' : 'Record acceptance'}</button></>}>
      <Field label="Accepted by" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}
