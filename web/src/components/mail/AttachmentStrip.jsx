import { Download, ExternalLink, FileText, Image as ImageIcon, Lock, Paperclip } from 'lucide-react';
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

const typeLabel = (type) => (/pdf/i.test(type || '') ? 'PDF' : /^image\//i.test(type || '') ? 'Image' : /sheet|excel|csv/i.test(type || '') ? 'Spreadsheet' : /word|document/i.test(type || '') ? 'Document' : null);

const iconFor = (type) => (/^image\//i.test(type || '') ? ImageIcon : /pdf/i.test(type || '') ? FileText : Paperclip);

export function AttachmentStrip({ attachments = [], bodyHtml = '', className }) {
  // An inline image the body actually draws is not listed twice.
  const drawn = new Set((String(bodyHtml || '').match(/cid:[^"'\s>]+/gi) || []).map((s) => s.slice(4).replace(/^<|>$/g, '').toLowerCase()));
  const shown = attachments.filter((a) => !(a.is_inline && a.content_id && drawn.has(String(a.content_id).replace(/^<|>$/g, '').toLowerCase())));
  if (!shown.length) return null;
  return (
    <ul className={cn('app-atts', className)} aria-label="Attachments">
      {shown.map((a) => {
        const name = a.name || 'Attachment';
        const locked = !a.url;
        const Icon = locked ? Lock : iconFor(a.content_type);
        return (
          <li key={a.id} className={cn('app-att', locked && 'is-locked')} title={name}>
            <span className="app-att__icon" aria-hidden="true"><Icon strokeWidth={1.8} /></span>
            <span className="app-att__text">
              <span>{name}</span>
              <span>{locked ? 'Only the mailbox owner can open this' : [typeLabel(a.content_type), a.size_bytes != null ? fileSize(a.size_bytes) : null].filter(Boolean).join(' · ')}</span>
            </span>
            {!locked && previewable(a.content_type) && (
              <a href={`${a.url}?inline=1`} target="_blank" rel="noopener noreferrer" className="mg-iconbtn" aria-label={`Open ${name} in a new tab`} title="Open in a new tab">
                <ExternalLink className="size-4" strokeWidth={1.8} aria-hidden="true" />
              </a>
            )}
            {!locked && (
              <a href={a.url} download={name} className="mg-iconbtn" aria-label={`Download ${name}`} title="Download">
                <Download className="size-4" strokeWidth={1.8} aria-hidden="true" />
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}
