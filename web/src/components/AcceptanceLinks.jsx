import { useState } from 'react';
import { Badge, Card, DataTable, Field, Input, Modal, Textarea, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Client acceptance links on a quotation (#53): send one, see whether the
 * client opened it and what they answered, revoke an open one.
 */
const TONE = { sent: 'info', viewed: 'info', accepted: 'success', changes_requested: 'warning', expired: '', revoked: '' };

export function AcceptanceLinks({ quotation, canSend, onChanged }) {
  const toast = useToast();
  const key = encodeURIComponent(quotation.quotation_no);
  const { data, refetch } = useFetch(() => api.raw(`/quotations/${key}/acceptances`), [key, quotation.revision, quotation.accepted_at]);
  const [open, setOpen] = useState(false);
  const rows = data?.data ?? [];

  async function revoke(r) {
    try { await api.action(`/quotations/${key}/acceptances/${r.id}/revoke`); toast('Link revoked', 'success'); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
  }

  return (
    <Card
      flush
      title="Client acceptance"
      hint="A private link where the client reviews this quotation and accepts it, or asks for changes. It stops working when the quotation is revised or expires."
      actions={canSend && <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>Send acceptance link</button>}
    >
      {rows.length === 0 ? (
        <div className="small muted px-[18px] py-3">No link sent yet.</div>
      ) : (
        <DataTable rows={rows} columns={[
          { key: 'created_at', header: 'Sent', render: (r) => new Date(r.created_at).toLocaleString() },
          { key: 'sent_to', header: 'To', render: (r) => r.sent_to || <span className="muted">link only</span> },
          { key: 'revision', header: 'Rev', render: (r) => `Rev ${r.revision}` },
          { key: 'status', header: 'Status', render: (r) => <Badge tone={TONE[r.status]}>{r.status.replace('_', ' ')}</Badge> },
          { key: 'viewed_at', header: 'Opened', render: (r) => (r.viewed_at ? `${new Date(r.viewed_at).toLocaleString()}${r.view_count > 1 ? ` · ${r.view_count}×` : ''}` : '—') },
          { key: 'decided', header: 'Answer', className: 'wrap', render: (r) => (r.decided_at ? `${r.decided_by_name}${r.decided_by_email ? ` <${r.decided_by_email}>` : ''}, ${new Date(r.decided_at).toLocaleString()}${r.comments ? `: ${r.comments}` : ''}` : '—') },
          { key: 'proof', header: 'Record', className: 'small muted', render: (r) => (r.pdf_sha256 ? <span title={`PDF SHA-256 ${r.pdf_sha256}${r.ip ? ` · IP ${r.ip}` : ''}`}>PDF {r.pdf_sha256.slice(0, 10)}…{r.pdf_document_id ? ' · file kept' : ''}</span> : '') },
          { key: 'act', header: '', align: 'right', render: (r) => (['sent', 'viewed'].includes(r.status) ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => revoke(r)}>Revoke</button> : null) },
        ]} />
      )}
      {open && <LinkDialog quotation={quotation} onClose={() => setOpen(false)} onDone={() => { refetch(); onChanged?.(); }} />}
    </Card>
  );
}

function LinkDialog({ quotation, onClose, onDone }) {
  const toast = useToast();
  const [email, setEmail] = useState(Boolean(quotation.contact?.email));
  const [to, setTo] = useState(quotation.contact?.email || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);

  async function create() {
    setBusy(true);
    try {
      const { data } = await api.action(`/quotations/${encodeURIComponent(quotation.quotation_no)}/acceptance-link`, { email, to: email ? to : '', message });
      setMade(data); onDone();
      if (data.email) toast(data.email.status === 'sent' ? 'Emailed' : `Email ${data.email.status}${data.email.reason ? `: ${data.email.reason}` : ''}`, data.email.status === 'sent' ? 'success' : 'info');
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(made.url); toast('Link copied', 'success'); } catch { toast('Select the link and copy it', 'info'); }
  }

  if (made) {
    return (
      <Modal title="Acceptance link ready" subtitle="This is the only time the link is shown. Any earlier open link for this quotation no longer works." onClose={onClose} footer={<><button type="button" className="btn" onClick={copy}>Copy link</button><button type="button" className="btn btn--primary" onClick={onClose}>Done</button></>}>
        <Field label="Link"><Input readOnly value={made.url} onFocus={(e) => e.target.select()} /></Field>
        <p className="small muted">Valid until {new Date(made.expires_at).toLocaleDateString()}. You can also share it on WhatsApp.</p>
      </Modal>
    );
  }
  return (
    <Modal title="Send for acceptance" subtitle="Creates a private link to this revision. The client can accept it with their name, or ask for changes." onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy || (email && !to)} onClick={create}>{busy ? 'Creating…' : email ? 'Create and email' : 'Create link'}</button></>}>
      <div className="stack">
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the link and the PDF to the client</label>
        {email && <Field label="To" required><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@company.com" /></Field>}
        {email && <Field label="Message" hint="Blank: a standard covering note"><Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}
