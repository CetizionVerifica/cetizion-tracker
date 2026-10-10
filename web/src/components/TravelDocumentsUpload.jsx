import { useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { Modal } from './ui.jsx';
import { Button } from './ui/button';
import { api } from '../lib/api.js';

/**
 * Many travel files at once, each filed by its name (#196 §5.4): an agency
 * invoice or credit note number ("HT-2627-1877.pdf") takes the file as that
 * record's PDF, a Travel ID ("TRV-2026-014-ticket.pdf") files it on the
 * trip. What names nothing is listed back, to attach from the trip itself.
 */
export function TravelDocumentsUpload({ batchId, onDone, label = 'Upload documents' }) {
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
      setResult(data);
      onDone?.();
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const where = (to) => (to.trip ? `trip ${to.trip} (${to.doc_type.replace(/_/g, ' ')})`
    : to.credit_note ? `credit note ${to.credit_note}` : `invoice ${to.vendor_invoice} as ${to.as}`);

  return (
    <>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        <Paperclip aria-hidden="true" />{busy ? 'Filing…' : label}
      </Button>
      <input ref={input} type="file" multiple className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif"
        aria-label="Travel documents" onChange={(e) => send([...e.target.files])} />
      {result && (
        <Modal title="Documents filed" onClose={() => setResult(null)}
          subtitle="Named by an invoice or credit note number, or a Travel ID. Anything else is attached from the trip itself."
          footer={<Button onClick={() => setResult(null)}>Done</Button>}>
          {result.error ? <p className="text-late">{result.error}</p> : (
            <div className="stack">
              {result.attached.length > 0 && (
                <ul className="list-disc pl-5 text-[13px]">
                  {result.attached.map((a) => <li key={a.document_id}><strong>{a.file}</strong> → {where(a.to)}</li>)}
                </ul>
              )}
              {result.unmatched.length > 0 && (
                <>
                  <p className="text-[13px] font-medium text-waiting">Not filed ({result.unmatched.length})</p>
                  <ul className="list-disc pl-5 text-[13px]">
                    {result.unmatched.map((u) => <li key={u.file}><strong>{u.file}</strong>: {u.reason}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
