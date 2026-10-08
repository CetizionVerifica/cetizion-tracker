import { useState } from 'react';
import { AlertCircle, Lock, ReceiptText, Send, Unplug } from 'lucide-react';
import { Modal, useToast } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { Message } from './mail/MessageView.jsx';

/**
 * One synced email conversation (#29), with a reply that goes out from the
 * connected mailbox and stays in the same Outlook thread. The messages are
 * the Inbox's own message cards (images blocked until asked, earlier
 * replies folded, attachments), and a thread that cannot be opened says so
 * instead of loading for ever.
 */
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const textToHtml = (text) => text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

export function EmailThreadDialog({ threadId, onClose, onReplied, footerExtra }) {
  const toast = useToast();
  const { data, error, refetch } = useFetch(() => api.raw(`/mail/threads/${threadId}`), [threadId]);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const t = data?.data;
  const active = t?.mailbox_status === 'active';
  const portal = /^\[portal\]/i.test(t?.subject || '');
  const firstIn = t?.messages?.find((m) => m.direction !== 'outbound');

  async function send() {
    setBusy(true);
    try {
      await api.action(`/mail/threads/${threadId}/reply`, { html: textToHtml(reply), reply_all: true });
      toast('Reply sent', 'success'); setReply(''); refetch(); onReplied?.();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const subtitle = t && `${t.company_name || 'Unmatched sender'}${t.contact_name ? ` · ${t.contact_name}` : ''} · ${portal ? 'client portal' : t.mailbox}`;
  const stored = t ? t.messages.filter((m) => !m.removed_at) : [];

  return (
    <Modal
      size="lg"
      title={t ? (t.subject || 'Email thread') : error ? 'Email thread' : 'Loading…'}
      subtitle={subtitle}
      onClose={onClose}
      footer={<>
        {footerExtra}
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose}>Close</button>
        {active && (
          <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !reply.trim()} onClick={send}>
            <Send className="size-4" strokeWidth={1.8} aria-hidden="true" />{busy ? 'Sending…' : 'Send reply'}
          </button>
        )}
      </>}
    >
      {error ? (
        <div className="mg-empty" role="alert" style={{ padding: '32px 16px' }}>
          <span className="mg-empty__mark app-ib__late-mark"><AlertCircle className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h3 className="mg-empty__title">Couldn’t open this email</h3>
          <p className="mg-empty__text">The thread is not in a mailbox you can read, or the server didn’t answer. Nothing was sent.</p>
          <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
        </div>
      ) : !t ? (
        <div aria-busy="true" aria-label="Loading the email" className="flex flex-col gap-3">
          <div className="mg-skel" style={{ height: 56 }} /><div className="mg-skel" style={{ height: 160 }} />
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {portal && (
            <div className="mg-banner" role="note">
              <ReceiptText strokeWidth={1.8} aria-hidden="true" />
              <div className="mg-banner__body"><strong>A client query from the portal</strong>Your reply goes by email. Sending it does not resolve the query; mark it resolved in Collections when it is settled.</div>
            </div>
          )}
          {t.visibility !== 'share_everything' && !t.messages.some((m) => m.can_read_live) && (
            <div className="mg-banner" role="note">
              <Lock strokeWidth={1.8} aria-hidden="true" />
              <div className="mg-banner__body">The mailbox owner shares {t.visibility === 'subject' ? 'subjects only' : 'only who and when'}.</div>
            </div>
          )}
          {t.messages.map((m, i) => (
            <Message key={m.id} m={m} openByDefault={i >= t.messages.length - 1 || stored.length <= 2} />
          ))}
          {active ? (
            <div className="flex flex-col gap-1.5 pt-1.5">
              <label htmlFor={`thread-reply-${threadId}`} className="text-[12px] font-medium text-secondary-foreground">
                {portal && firstIn ? `Reply by email to ${firstIn.from_email}` : `Reply to all from ${t.mailbox}`}
              </label>
              <textarea id={`thread-reply-${threadId}`} className="mg-textarea" rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write your reply" />
              <span className="text-[12px] text-muted-foreground">
                {portal
                  ? 'Goes as a new email from the tracker, not from a connected mailbox.'
                  : 'Goes out from the connected mailbox, in the same thread, to everyone on it.'}
              </span>
            </div>
          ) : (
            <div className="mg-banner mg-banner--late" role="note">
              <Unplug strokeWidth={1.8} aria-hidden="true" />
              <div className="mg-banner__body">
                <strong>{t.mailbox} needs to be reconnected before you can reply.</strong>
                This mailbox is {String(t.mailbox_status || 'not connected').replace('_', ' ')}. Its owner reconnects it from Settings › Mailboxes; nothing synced so far is lost.
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
