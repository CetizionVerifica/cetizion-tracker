import { useState } from 'react';
import { Copy, Link2, Send } from 'lucide-react';
import { ConfirmDialog, DataTable, Field, Input, Modal, Textarea, useToast } from './ui.jsx';
import { Sec, Tone } from './sales.jsx';
import { api } from '../lib/api.js';
import { date } from '../lib/format.js';

/**
 * Client acceptance links on a deal (#53): send one, see whether the
 * client opened it and what they answered, revoke an open one (after a
 * confirm). Drawn flat, as a section of the deal's tab panel; the deal page
 * loads the links so its tab can count them.
 */
const STATUS = {
  sent: { label: 'Sent', tone: 'info' },
  viewed: { label: 'Opened', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'ok' },
  changes_requested: { label: 'Changes requested', tone: 'wait' },
  expired: { label: 'Expired', tone: 'plain' },
  revoked: { label: 'Revoked', tone: 'plain' },
};
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null);

export function AcceptanceLinks({ quotation, rows = [], loading, failed, onRetry, canSend, onSend, onChanged }) {
  const toast = useToast();
  const key = encodeURIComponent(quotation.quotation_no);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);

  async function revoke() {
    setBusy(true);
    try { await api.action(`/quotations/${key}/acceptances/${revoking.id}/revoke`); toast('Link revoked: it no longer opens', 'success'); setRevoking(null); onChanged?.(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <Sec
      id="deal-accept"
      title="Client acceptance"
      hint="A private link where the client reviews this revision and accepts it, or asks for changes. It stops working when the deal is revised or expires."
      tools={canSend && rows.length > 0 && <button type="button" className="mg-btn mg-btn--sm" onClick={onSend}><Send className="size-4" aria-hidden="true" />Send for acceptance</button>}
    >
      {failed ? (
        <div className="mg-empty app-box" role="alert">
          <h4 className="mg-empty__title">Couldn't load the links</h4>
          <p className="mg-empty__text">{failed}</p>
          <button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}>Try again</button>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading"><div className="mg-skel" style={{ height: 44 }} /><div className="mg-skel" style={{ height: 44, width: '80%' }} /></div>
      ) : rows.length === 0 ? (
        <div className="mg-empty app-box">
          <span className="mg-empty__mark"><Link2 className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h4 className="mg-empty__title">No link sent yet</h4>
          <p className="mg-empty__text">{canSend ? 'Send one and the client can accept this revision with their name, or ask for changes, without signing in.' : quotation.accepted_at ? `${quotation.accepted_by_name || 'The client'} accepted it on ${date(quotation.accepted_at)}, recorded by hand.` : 'A link can be sent once the deal is open and its discount is settled.'}</p>
          {canSend && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={onSend}><Send className="size-4" aria-hidden="true" />Send for acceptance</button>}
        </div>
      ) : (
        <div className="app-box">
          <DataTable
            rows={rows}
            label="Acceptance links"
            phone={(r) => (
              <div className="mg-row">
                <span className="mg-row__title">Rev {r.revision} · {r.sent_to || 'link only'}</span>
                <span className="mg-row__amount"><Tone tone={(STATUS[r.status] || {}).tone}>{(STATUS[r.status] || { label: r.status }).label}</Tone></span>
                <span className="mg-row__meta" style={{ whiteSpace: 'normal', gridColumn: '1 / -1' }}>
                  Sent {when(r.created_at)}{r.viewed_at && ` · opened ${when(r.viewed_at)}`}{r.decided_at && ` · ${r.decided_by_name}, ${when(r.decided_at)}${r.comments ? `: ${r.comments}` : ''}`}
                </span>
                {['sent', 'viewed'].includes(r.status) && <span className="col-span-2 mt-1 flex justify-end"><button type="button" className="mg-btn mg-btn--ghost" onClick={() => setRevoking(r)}>Revoke</button></span>}
              </div>
            )}
            columns={[
              { key: 'created_at', header: 'Sent', render: (r) => when(r.created_at) },
              { key: 'sent_to', header: 'To', render: (r) => r.sent_to || <span className="text-muted-foreground">link only</span> },
              { key: 'revision', header: 'Rev', render: (r) => `Rev ${r.revision}` },
              { key: 'status', header: 'Status', render: (r) => <Tone tone={(STATUS[r.status] || {}).tone}>{(STATUS[r.status] || { label: r.status.replace('_', ' ') }).label}</Tone> },
              { key: 'viewed_at', header: 'Opened', render: (r) => (r.viewed_at ? `${when(r.viewed_at)}${r.view_count > 1 ? ` · ${r.view_count}×` : ''}` : <span className="text-muted-foreground">not yet</span>) },
              { key: 'decided', header: 'Answer', className: 'wrap', min: 180, render: (r) => (r.decided_at ? `${r.decided_by_name}${r.decided_by_email ? ` <${r.decided_by_email}>` : ''}, ${when(r.decided_at)}${r.comments ? `: ${r.comments}` : ''}` : <span className="text-muted-foreground">—</span>) },
              { key: 'proof', header: 'Record', render: (r) => (r.pdf_sha256 ? <span className="text-[12px] text-muted-foreground" title={`PDF SHA-256 ${r.pdf_sha256}${r.ip ? ` · IP ${r.ip}` : ''}`}>PDF {r.pdf_sha256.slice(0, 10)}…{r.pdf_document_id ? ' · file kept' : ''}</span> : '') },
              { key: 'act', header: '', align: 'right', render: (r) => (['sent', 'viewed'].includes(r.status) ? <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setRevoking(r)}>Revoke</button> : null) },
            ]}
          />
        </div>
      )}
      {revoking && (
        <ConfirmDialog
          title="Revoke this link?"
          message={`The link sent ${revoking.sent_to ? `to ${revoking.sent_to} ` : ''}on ${when(revoking.created_at)} stops working at once. The client sees that it was withdrawn. You can send a new one after.`}
          confirmLabel="Revoke the link"
          busy={busy}
          onConfirm={revoke}
          onClose={() => setRevoking(null)}
        />
      )}
    </Sec>
  );
}

export function LinkDialog({ quotation, onClose, onDone }) {
  const toast = useToast();
  const [email, setEmail] = useState(Boolean(quotation.contact?.email));
  const [to, setTo] = useState(quotation.contact?.email || '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [failed, setFailed] = useState(null);

  async function create() {
    setBusy(true); setFailed(null);
    try {
      const { data } = await api.action(`/quotations/${encodeURIComponent(quotation.quotation_no)}/acceptance-link`, { email, to: email ? to : '', message });
      setMade(data); onDone();
      if (data.email) toast(data.email.status === 'sent' ? 'Emailed' : `Email ${data.email.status}${data.email.reason ? `: ${data.email.reason}` : ''}`, data.email.status === 'sent' ? 'success' : 'info');
    } catch (err) { setFailed(err.fields ? Object.values(err.fields)[0] : err.message); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(made.url); toast('Link copied', 'success'); } catch { toast('Select the link and copy it', 'info'); }
  }

  if (made) {
    return (
      <Modal title="Link ready" subtitle="This is the only time the link is shown. Any earlier open link for this deal no longer works." onClose={onClose} footer={<>
        <button type="button" className="mg-btn" onClick={copy}><Copy className="size-4" aria-hidden="true" />Copy link</button>
        <button type="button" className="mg-btn mg-btn--primary" onClick={onClose}>Done</button>
      </>}>
        <div className="stack">
          <Field label="Link"><Input readOnly value={made.url} onFocus={(e) => e.target.select()} /></Field>
          <p className="m-0 text-[12.5px] text-muted-foreground">Valid until {new Date(made.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. You can also share it on WhatsApp.</p>
        </div>
      </Modal>
    );
  }
  const off = email && !to;
  return (
    <Modal title="Send for acceptance" subtitle={`${quotation.quotation_no}, Rev ${quotation.revision || 0} · ${quotation.client_name}. Creates a private link to this revision. The client can accept it with their name, or ask for changes.`} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="mg-btn mg-btn--primary" disabled={busy || off} onClick={create}>{busy ? 'Creating…' : failed ? 'Try again' : email ? 'Create and email' : 'Create link'}</button>
      {off && <span className="app-why">Type the address to email it, or untick the box.</span>}
    </>}>
      <div className="stack">
        {failed && <div className="mg-banner mg-banner--late" role="alert"><div className="mg-banner__body"><strong>Couldn't create the link.</strong>{failed}</div></div>}
        <label className="mg-check"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the link and the PDF to the client</label>
        {email && <Field label="To" required><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@company.com" /></Field>}
        {email && <Field label="Message" hint="Blank: a standard covering note"><Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}
