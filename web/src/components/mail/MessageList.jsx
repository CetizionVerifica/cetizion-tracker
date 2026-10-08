import { forwardRef } from 'react';
import { ChevronLeft, ChevronRight, Paperclip } from 'lucide-react';
import { cn } from 'cn';
import { StateMarks } from './MessageView.jsx';
import { AttachmentNames } from './AttachmentStrip.jsx';

/** How long ago, the way a mail list writes it: minutes today, then the time, then the day, then the date. */
export const since = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m`;
  if (mins < 1440) return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (mins < 2880) return 'Yesterday';
  if (mins < 10080) return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

export const initials = (name) => {
  const from = String(name || '').trim();
  if (!from) return '?';
  const parts = from.split(/\s+/).filter(Boolean);
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
};

/** Enter and Space open a row; the list's own handler does the arrows. */
export const openOnKey = (onOpen) => (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onOpen();
  }
};

/**
 * One conversation in a folder, as Outlook lists it: unread with a dot,
 * importance and the flag, a paperclip, who it is from — or who it went
 * to, in Sent Items ("To: —" when nobody is listed) — the subject, the
 * first words of the newest message, and the company and record it
 * matched. The option's name says unread and the attachment, so a screen
 * reader hears them too.
 */
export const MessageRow = forwardRef(function MessageRow({ row, selected, outbound, onSelect }, ref) {
  const lead = outbound
    ? (row.to_emails?.length ? `To: ${row.to_emails.join(', ')}` : 'To: —')
    : (row.from_name || row.from_email || '—');
  const when = since(row.sent_at);
  const aria = [row.unread && 'Unread', lead, row.subject || '(no subject)', row.has_attachments && 'has an attachment', when].filter(Boolean).join(', ');
  const tag = [row.company_name, row.entity_id].filter(Boolean).join(' · ');
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={aria}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(row)}
      onKeyDown={openOnKey(() => onSelect(row))}
      className={cn('app-ib__row', row.unread && 'is-unread')}
    >
      <span className={cn('mg-avatar', !row.company_name && 'is-unmatched')} aria-hidden="true">
        {initials(outbound ? (row.to_emails?.[0] || '') : (row.from_name || row.company_name || row.from_email))}
      </span>
      <span className="app-ib__name">
        {row.unread && <span className="app-ib__dot" aria-hidden="true" />}
        <span className="app-ib__lead" title={[row.company_name, lead].filter(Boolean).join(' · ')}><span>{lead}</span></span>
        {row.in_folder > 1 && <span className="app-ib__n mg-num">{row.in_folder}</span>}
      </span>
      <span className="app-ib__time">
        <StateMarks m={{ importance: row.high ? 'high' : row.importance, flag_status: row.flagged ? 'flagged' : row.flag_status }} />
        {row.has_attachments && <Paperclip strokeWidth={1.8} aria-hidden="true" />}
        <span>{when}</span>
      </span>
      <span className="app-ib__subj" title={row.subject || '(no subject)'}>{row.subject || '(no subject)'}</span>
      {row.snippet && <span className="app-ib__snip is-one"><span>{row.snippet}</span></span>}
      <AttachmentNames names={row.attachment_names} />
      {tag && <span className="app-ib__chips"><span className="mg-badge mg-badge--plain">{tag}</span></span>}
    </div>
  );
});

/**
 * Which conversations are on show, and the way to the others. Under the
 * list, where a mail client keeps it. A single page shows only the count.
 */
export function Pager({ page, pages, total, pageSize, onPage, noun = 'conversation' }) {
  if (pages <= 1) {
    return <p className="app-ib__countline" aria-live="polite">{total} {noun}{total === 1 ? '' : 's'}</p>;
  }
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pages of conversations" className="app-ib__pager">
      <span aria-live="polite">{first}–{last} of {total}</span>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Newer conversations">
        <ChevronLeft className="size-4" strokeWidth={2} aria-hidden="true" />Newer
      </button>
      <span className="mg-num">{page} / {pages}</span>
      <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Older conversations">
        Older<ChevronRight className="size-4" strokeWidth={2} aria-hidden="true" />
      </button>
    </nav>
  );
}
