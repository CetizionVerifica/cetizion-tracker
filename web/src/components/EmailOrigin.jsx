import { useState } from 'react';
import { EmailThreadDialog } from './EmailThread.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * One line saying a record was made from an email (docs/email-enquiries.md,
 * docs/email-po-plan.md): an enquiry, a quotation, a PO or a stage's invoice —
 * when, in which mailbox, and the thread to open when the reader may see it.
 * Nothing at all for a record that was typed in.
 */
export function EmailOrigin({ entity, id, className }) {
  const { data } = useFetch(
    () => (id ? api.raw(`/mail/origin?entity=${entity}&id=${encodeURIComponent(id)}`).catch(() => null) : Promise.resolve(null)),
    [entity, id]
  );
  const [open, setOpen] = useState(false);
  const o = data?.data;
  if (!o) return null;
  const what = entity === 'quotation' ? 'Read automatically from the PDF emailed'
    : entity === 'purchase_order' ? (o.by_hand ? 'Registered from the client\'s PO emailed' : 'Registered automatically from the client\'s PO emailed')
    : entity === 'payment_stage' ? (o.by_hand ? 'Invoice recorded from the email sent' : 'Invoice recorded automatically from the email sent')
    : o.kind === 'quotation_sent' ? 'Created automatically from the quotation emailed' : 'Created automatically from an email';
  return (
    <p className={className || 'm-0 text-[12.5px] text-muted-foreground'}>
      {what} on {date(o.received_at)} · {o.mailbox}
      {o.thread_id && <> · <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => setOpen(true)}>open the email</button></>}
      {open && <EmailThreadDialog threadId={o.thread_id} onClose={() => setOpen(false)} />}
    </p>
  );
}
