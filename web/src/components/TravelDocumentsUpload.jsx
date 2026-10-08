import { useRef, useState } from 'react';
import { Check, FileWarning, Info, Paperclip } from 'lucide-react';
import { cn } from 'cn';
import { Modal } from './ui.jsx';
import { MoneyBanner } from './money.jsx';
import { api } from '../lib/api.js';

/**
 * Many travel files at once, each filed by its name (#196 §5.4): an agency
 * invoice or credit note number ("HT-2627-1877.pdf") takes the file as that
 * record's PDF, a Travel ID ("TRV-2026-014-ticket.pdf") files it on the
 * trip. What names nothing is listed back, to attach from the trip itself.
 *
 * Wave 6: the button says "Filing…" while it works; the result is one
 * dialog, filed files first (an extra copy says it went "as an
 * attachment"), then "Not filed (n)" with each reason; a failed upload says
 * nothing was saved and offers Upload again.
 */
export function TravelDocumentsUpload({ batchId, onDone, label = 'Upload documents', className = 'mg-btn' }) {
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function send(files) {
    if (!files?.length) return;
    setBusy(true);
    const form = new FormData();
    for (const f of files) form.append('files', f);
    try {
      const { data } = await api.upload(batchId ? `/import/travel/${batchId}/documents` : '/import/travel/documents', form);
      setResult({ ...data, sent: files.length });
      onDone?.();
    } catch (err) {
      setResult({ error: err.message, sent: files.length });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const pick = () => input.current?.click();
  const sentence = (to) => (to.trip
    ? `Trip ${to.trip}, as ${articled(to.doc_type.replace(/_/g, ' '))}.`
    : to.credit_note ? `Credit note ${to.credit_note}, as its PDF.`
      : to.as === 'an attachment'
        ? `Invoice ${to.vendor_invoice} already had its PDF, so this was attached beside it. It shows on the bill's Documents tab.`
        : `Invoice ${to.vendor_invoice}, as its PDF.`);

  return (
    <>
      <button type="button" className={className} disabled={busy} aria-busy={busy || undefined} onClick={pick}>
        <Paperclip className="size-4" strokeWidth={1.8} aria-hidden="true" />{busy ? 'Filing…' : label}
      </button>
      <input ref={input} type="file" multiple className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif"
        aria-label="Travel documents" tabIndex={-1} onChange={(e) => send([...e.target.files])} />
      {result && (result.error ? (
        <Modal
          title="Documents not filed"
          subtitle="Nothing was saved."
          size="sm"
          onClose={() => setResult(null)}
          footer={(
            <>
              <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setResult(null)}>Close</button>
              <button type="button" className="mg-btn mg-btn--primary" onClick={() => { setResult(null); pick(); }}>Upload again</button>
            </>
          )}
        >
          <MoneyBanner tone="late" role="alert" title="The upload didn't finish.">
            {result.error} Nothing was filed, so you can upload the same files again.
          </MoneyBanner>
        </Modal>
      ) : (
        <Modal
          title="Documents filed"
          subtitle={`${result.sent} ${result.sent === 1 ? 'file' : 'files'} read. Each was filed by the number in its name: an invoice or credit note number, or a Travel ID.`}
          onClose={() => setResult(null)}
          footer={(
            <>
              <button type="button" className="mg-btn" onClick={() => { setResult(null); pick(); }}>Upload more</button>
              <button type="button" className="mg-btn mg-btn--primary" onClick={() => setResult(null)}>Done</button>
            </>
          )}
        >
          {result.attached.length > 0 && (
            <ul className="app-filed">
              {result.attached.map((a) => {
                const extra = a.to.as === 'an attachment';
                return (
                  <li key={a.document_id}>
                    <span className={cn('app-filed__mark', extra ? 'is-info' : 'is-ok')} aria-hidden="true">{extra ? <Info strokeWidth={2} /> : <Check strokeWidth={2.4} />}</span>
                    <span><b>{a.file}</b><span>{sentence(a.to)}</span></span>
                  </li>
                );
              })}
            </ul>
          )}
          {result.unmatched.length > 0 && (
            <>
              <h3 className="app-filed__head">Not filed ({result.unmatched.length})</h3>
              <ul className="app-filed">
                {result.unmatched.map((u) => (
                  <li key={u.file}>
                    <span className="app-filed__mark is-wait" aria-hidden="true"><FileWarning strokeWidth={1.9} /></span>
                    <span><b>{u.file}</b><span>{capital(u.reason)}. Rename it, or add it from the trip's Documents tab.</span></span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.attached.length === 0 && result.unmatched.length === 0 && <p className="m-0 text-[13px] text-muted-foreground">No files came through.</p>}
        </Modal>
      ))}
    </>
  );
}

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const articled = (w) => (/^[aeiou]/i.test(w) ? `an ${w}` : `a ${w}`);
