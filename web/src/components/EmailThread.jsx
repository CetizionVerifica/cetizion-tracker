import { useState } from 'react';
import { Badge, Field, Modal, Textarea, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * One synced email conversation (#29), with a reply that goes out from the
 * connected mailbox and stays in the same Outlook thread.
 */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const textToHtml = (text) => text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export function EmailThreadDialog({ threadId, onClose, onReplied, footerExtra }) {
  const toast = useToast();
  const { data, refetch } = useFetch(() => api.raw(`/mail/threads/${threadId}`), [threadId]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const t = data?.data;

  async function send() {
    setBusy(true);
    try {
      await api.action(`/mail/threads/${threadId}/reply`, { html: textToHtml(reply), reply_all: true });
      toast('Reply sent', 'success'); setReply(''); refetch(); onReplied?.();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <Modal size="lg" title={t ? (t.subject || 'Email thread') : 'Loading…'} subtitle={t && `${t.company_name || 'Unmatched sender'}${t.contact_name ? ` · ${t.contact_name}` : ''} · ${t.mailbox}`} onClose={onClose}
      footer={<>{footerExtra}<button type="button" className="btn" onClick={onClose}>Close</button>{t?.mailbox_status === 'active' && <button type="button" className="btn btn--primary" disabled={busy || !reply.trim()} onClick={send}>{busy ? 'Sending…' : 'Send reply'}</button>}</>}>
      {!t ? <div className="skeleton h-[160px]" /> : (
        <div className="stack">
          {t.visibility !== 'share_everything' && <div className="small muted">The mailbox owner shares {t.visibility === 'subject' ? 'subjects only' : 'only who and when'}.</div>}
          {t.messages.map((m) => (
            <div key={m.id} className={`mail mail--${m.direction}`}>
              <div className="mail__head">
                <span className="strong">{m.from_name || m.from_email}</span>
                <span className="small muted">to {m.to_emails.join(', ')}{m.cc_emails.length ? `, cc ${m.cc_emails.join(', ')}` : ''}</span>
                {m.sent_from_tracker_by && <Badge tone="info">sent from the tracker by {m.sent_from_tracker_by}</Badge>}
                {m.has_attachments && <Badge>attachments</Badge>}
                <span className="small muted mail__when">{new Date(m.sent_at).toLocaleString()}</span>
              </div>
              {m.body_html
                ? <iframe className="mail__body" title={`email ${m.id}`} sandbox="" srcDoc={`<base target="_blank"><style>body{font:13px system-ui,sans-serif;margin:8px;color:#0f172a}img{max-width:100%}</style>${m.body_html}`} />
                : m.snippet ? <div className="mail__snippet">{m.snippet}</div> : null}
            </div>
          ))}
          {t.mailbox_status === 'active'
            ? <Field label="Reply to all"><Textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Goes out from the connected mailbox, in the same thread." /></Field>
            : <div className="small muted">This mailbox is {t.mailbox_status.replace('_', ' ')}; reconnect it to reply.</div>}
        </div>
      )}
    </Modal>
  );
}
