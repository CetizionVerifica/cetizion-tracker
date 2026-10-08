import { forwardRef } from 'react';
import { ChevronLeft, ChevronRight, Paperclip } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button.tsx';
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

/**
 * One conversation in a folder (docs/inbox-outlook-plan.md §3.3), as
 * Outlook lists it: unread in bold with a dot, the flag, a paperclip,
 * importance, who it is from — or who it went to, in Sent Items — the
 * subject, the first words of the newest message, and when.
 *
 * `outbound` tells the row to lead with the recipient: a Sent Items row
 * that said "Bea Sales" on every line said nothing.
 */
export const MessageRow = forwardRef(function MessageRow({ row, selected, outbound, onSelect }, ref) {
  const lead = outbound
    ? (row.to_emails?.length ? `To: ${row.to_emails.join(', ')}` : 'To: —')
    : (row.from_name || row.from_email || '—');
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
      className={cn(
        'flex w-full cursor-pointer gap-3 border-b border-border px-5 py-3 text-left transition-colors duration-150',
        selected ? 'border-l-2 border-l-primary bg-card' : 'border-l-2 border-l-transparent hover:bg-card'
      )}
    >
      <span className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-semibold',
        row.company_name ? 'text-primary' : 'text-muted-foreground'
      )}>
        {initials(outbound ? (row.to_emails?.[0] || '') : (row.from_name || row.company_name || row.from_email))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="flex w-2 shrink-0 items-center self-center" aria-hidden="true">
            {row.unread && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
          <span
            className={cn('min-w-0 flex-1 truncate text-[13px] text-foreground', row.unread ? 'font-semibold' : 'font-medium')}
            title={[row.company_name, lead].filter(Boolean).join(' · ')}
          >
            {lead}
            {row.in_folder > 1 && <span className="num ml-1.5 font-normal text-muted-foreground">{row.in_folder}</span>}
          </span>
          <StateMarks m={{ importance: row.high ? 'high' : row.importance, flag_status: row.flagged ? 'flagged' : row.flag_status }} className="shrink-0 self-center" />
          {row.has_attachments && (
            <Paperclip className="size-3 shrink-0 self-center text-muted-foreground" strokeWidth={1.75} aria-label="Has an attachment" />
          )}
          <span className="shrink-0 text-[11.5px] text-muted-foreground">{since(row.sent_at)}</span>
        </span>
        <span className={cn('mt-0.5 block truncate text-[12.5px]', row.unread ? 'font-medium text-foreground' : 'text-secondary-text')} title={row.subject || '(no subject)'}>
          {row.subject || '(no subject)'}
        </span>
        {row.snippet && (
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{row.snippet}</span>
        )}
        <AttachmentNames names={row.attachment_names} />
        {(row.company_name || row.entity_id) && (
          <span className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {row.company_name && <span className="truncate">{row.company_name}</span>}
            {row.entity_id && <span className="num">{row.entity_id}</span>}
          </span>
        )}
      </span>
    </div>
  );
});

/**
 * Which conversations are on show, and the way to the others.
 *
 * Under the list rather than over it, where a mail client keeps it: the
 * list is read top down and the pager is what you reach at the bottom.
 */
export function Pager({ page, pages, total, pageSize, onPage }) {
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pages of conversations" className="flex items-center gap-2 border-t border-border px-5 py-2.5">
      <span className="num text-[12px] text-muted-foreground" aria-live="polite">
        {first}–{last} of {total}
      </span>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Newer conversations">
        <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden="true" /> Newer
      </Button>
      <span className="num text-[12px] text-secondary-text">{page} / {pages}</span>
      <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Older conversations">
        Older <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </nav>
  );
}
