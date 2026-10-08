import { useState } from 'react';
import { FileSpreadsheet, FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import { cn } from 'cn';
import { fileSize } from '../../lib/format.js';
import { AttachmentViewer } from './AttachmentViewer.jsx';

/**
 * What came with the message (docs/inbox-outlook-plan.md §3.3,
 * docs/inbox-attachments-plan.md).
 *
 * The file stays in Outlook; the tracker only knows its name, type and
 * size. Each one opens in the tracker's viewer and only there: there is
 * no download, and no new tab. A file the viewer cannot show yet still
 * opens it, to say so and point at Outlook.
 *
 * Inline images are the message's own pictures and are shown in the body,
 * not here — unless the body never referenced them, in which case they
 * are ordinary attachments and listed.
 */
const iconFor = (view) => (view === 'image' ? ImageIcon : view === 'sheet' ? FileSpreadsheet : view === 'pdf' || view === 'text' ? FileText : Paperclip);

export function AttachmentStrip({ attachments = [], bodyHtml = '', webLink = null, className }) {
  const [open, setOpen] = useState(null);
  // An inline image the body actually draws is not listed twice.
  const drawn = new Set((String(bodyHtml || '').match(/cid:[^"'\s>]+/gi) || []).map((s) => s.slice(4).replace(/^<|>$/g, '').toLowerCase()));
  const shown = attachments.filter((a) => !(a.is_inline && a.content_id && drawn.has(String(a.content_id).replace(/^<|>$/g, '').toLowerCase())));
  if (!shown.length) return null;
  const viewable = shown.filter((a) => a.view_url);
  return (
    <>
      <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Attachments">
        {shown.map((a) => {
          const Icon = iconFor(a.view);
          const name = a.name || 'Attachment';
          const locked = !a.view_url;
          return (
            <li key={a.id} className="max-w-full">
              <button
                type="button"
                disabled={locked}
                onClick={() => setOpen(viewable.indexOf(a))}
                title={locked ? 'Only the mailbox owner can open this attachment' : `View ${name}`}
                aria-label={locked ? `${name}, only the mailbox owner can open it` : `View ${name}`}
                className={cn(
                  'inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-secondary px-2 py-1 text-left text-[12px] transition-colors duration-150',
                  locked ? 'cursor-not-allowed opacity-70' : 'hover:border-border-strong hover:bg-card'
                )}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
                <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
                {a.size_bytes != null && <span className="num shrink-0 text-muted-foreground">{fileSize(a.size_bytes)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {open !== null && open >= 0 && (
        <AttachmentViewer attachments={viewable} index={open} onIndex={setOpen} onClose={() => setOpen(null)} webLink={webLink} />
      )}
    </>
  );
}

/**
 * The names of what a conversation's newest message carries, for a list
 * row: two, then how many more, so the files show before anything is
 * opened. Nothing when the mailbox does not share names.
 */
export function AttachmentNames({ names, className }) {
  if (!names?.length) return null;
  const more = names.length - 2;
  return (
    <span className={cn('mt-1 flex min-w-0 flex-wrap gap-1', className)} aria-label={`Attachments: ${names.join(', ')}`}>
      {names.slice(0, 2).map((n, i) => (
        <span key={i} className="inline-flex min-w-0 max-w-[60%] items-center gap-1 rounded-sm border border-border bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-text">
          <Paperclip className="size-3 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
          <span className="truncate">{n}</span>
        </span>
      ))}
      {more > 0 && <span className="self-center text-[11px] text-muted-foreground num">+{more}</span>}
    </span>
  );
}
