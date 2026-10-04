import { Download, ExternalLink, FileText, Image as ImageIcon, Paperclip } from 'lucide-react';
import { cn } from 'cn';
import { fileSize } from '../../lib/format.js';

/**
 * What came with the message (docs/inbox-outlook-plan.md §3.3).
 *
 * The file stays in Outlook; the tracker only knows its name, type and
 * size, and streams it through on request. A PDF or an image can open in
 * a new tab, served under its own strict policy; anything else downloads,
 * because a spreadsheet drawn by the browser is a spreadsheet run by it.
 *
 * Inline images are the message's own pictures and are shown in the body,
 * not here — unless the body never referenced them, in which case they
 * are ordinary attachments and listed.
 */
export const previewable = (type) => /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp|svg\+xml))$/i.test(String(type || ''));

const iconFor = (type) => (/^image\//i.test(type || '') ? ImageIcon : /pdf/i.test(type || '') ? FileText : Paperclip);

export function AttachmentStrip({ attachments = [], bodyHtml = '', className }) {
  // An inline image the body actually draws is not listed twice.
  const drawn = new Set((String(bodyHtml || '').match(/cid:[^"'\s>]+/gi) || []).map((s) => s.slice(4).replace(/^<|>$/g, '').toLowerCase()));
  const shown = attachments.filter((a) => !(a.is_inline && a.content_id && drawn.has(String(a.content_id).replace(/^<|>$/g, '').toLowerCase())));
  if (!shown.length) return null;
  return (
    <ul className={cn('flex flex-wrap gap-1.5', className)} aria-label="Attachments">
      {shown.map((a) => {
        const Icon = iconFor(a.content_type);
        const name = a.name || 'Attachment';
        const locked = !a.url;
        return (
          <li
            key={a.id}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-[7px] border border-border bg-secondary px-2 py-1 text-[12px]',
              locked && 'opacity-70'
            )}
            title={locked ? 'Only the mailbox owner can open this attachment' : name}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
            {a.size_bytes != null && <span className="num shrink-0 text-muted-foreground">{fileSize(a.size_bytes)}</span>}
            {!locked && previewable(a.content_type) && (
              <a
                href={`${a.url}?inline=1`}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${name} in a new tab`}
                className="ml-0.5 inline-flex rounded-[4px] p-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </a>
            )}
            {!locked && (
              <a
                href={a.url}
                download={name}
                aria-label={`Download ${name}`}
                className="inline-flex rounded-[4px] p-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
              >
                <Download className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
