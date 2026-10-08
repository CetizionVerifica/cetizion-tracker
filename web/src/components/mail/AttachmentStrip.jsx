import { useState } from 'react';
import { FileSpreadsheet, FileText, Image as ImageIcon, Lock, Paperclip, Presentation } from 'lucide-react';
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
const iconFor = (view, name) => {
  if (view === 'image') return ImageIcon;
  if (view === 'sheet') return FileSpreadsheet;
  if (view === 'office' && /\.(pptx?|pps[xm]?|pptm|odp)$/i.test(name || '')) return Presentation;
  if (view === 'pdf' || view === 'text' || view === 'word' || view === 'office') return FileText;
  return Paperclip;
};

const typeLabel = (view, type) => (view === 'pdf' || /pdf/i.test(type || '') ? 'PDF'
  : view === 'image' ? 'Image'
  : view === 'sheet' ? 'Spreadsheet'
  : view === 'word' ? 'Document'
  : view === 'text' ? 'Text'
  : view === 'office' ? 'Office file' : null);

export function AttachmentStrip({ attachments = [], bodyHtml = '', webLink = null, className }) {
  const [open, setOpen] = useState(null);
  // An inline image the body actually draws is not listed twice.
  const drawn = new Set((String(bodyHtml || '').match(/cid:[^"'\s>]+/gi) || []).map((s) => s.slice(4).replace(/^<|>$/g, '').toLowerCase()));
  const shown = attachments.filter((a) => !(a.is_inline && a.content_id && drawn.has(String(a.content_id).replace(/^<|>$/g, '').toLowerCase())));
  if (!shown.length) return null;
  const viewable = shown.filter((a) => a.view_url);
  return (
    <>
      <ul className={cn('app-atts', className)} aria-label="Attachments">
        {shown.map((a) => {
          const name = a.name || 'Attachment';
          const locked = !a.view_url;
          const Icon = locked ? Lock : iconFor(a.view, a.name);
          return (
            <li key={a.id} className="app-atts__item">
              <button
                type="button"
                disabled={locked}
                onClick={() => setOpen(viewable.indexOf(a))}
                title={locked ? 'Only the mailbox owner can open this attachment' : `View ${name}`}
                aria-label={locked ? `${name}, only the mailbox owner can open it` : `View ${name}`}
                className={cn('app-att', locked && 'is-locked')}
              >
                <span className="app-att__icon" aria-hidden="true"><Icon strokeWidth={1.8} /></span>
                <span className="app-att__text">
                  <span>{name}</span>
                  <span>{locked ? 'Only the mailbox owner can open this' : [typeLabel(a.view, a.content_type), a.size_bytes != null ? fileSize(a.size_bytes) : null].filter(Boolean).join(' · ')}</span>
                </span>
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
    <span className={cn('app-attnames', className)} aria-label={`Attachments: ${names.join(', ')}`}>
      {names.slice(0, 2).map((n, i) => (
        <span key={i} className="mg-badge mg-badge--plain app-attnames__one">
          <Paperclip strokeWidth={1.8} aria-hidden="true" />
          <span>{n}</span>
        </span>
      ))}
      {more > 0 && <span className="app-attnames__more mg-num">+{more}</span>}
    </span>
  );
}
