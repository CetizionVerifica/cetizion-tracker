import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FileWarning, Minus, Plus } from 'lucide-react';
import { cn } from 'cn';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { fileSize } from '../../lib/format.js';

/**
 * An email's attachments, opened in the tracker (docs/inbox-attachments-plan.md,
 * step 1). Viewed here and nowhere else: there is no Download, no Print,
 * no "open in a new tab", and the file is read with a header a link
 * cannot send, so its address pasted into a tab gives nothing. The file
 * is drawn by the page itself: a PDF by pdf.js onto canvases (its own
 * scripts never run, and the browser's PDF toolbar with its Save button
 * never appears), a picture as an <img>, a spreadsheet or a text file from
 * the data the server turned it into. Nothing is kept once it closes.
 *
 * This does not make a file impossible to copy: whoever can see it can
 * photograph the screen, and the mailbox owner has it in Outlook. It
 * keeps the tracker from being the way files leave.
 *
 * `attachments` are the message's listed ones; `index` the one open;
 * ← and → move between them.
 */
export function AttachmentViewer({ attachments, index, onIndex, onClose, webLink }) {
  const att = attachments[index];
  const many = attachments.length > 1;
  const go = useCallback((step) => onIndex((index + step + attachments.length) % attachments.length), [index, attachments.length, onIndex]);
  const onKeyDown = (e) => {
    if (!many) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  };
  if (!att) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        onKeyDown={onKeyDown}
        // Right-click "Save image as" and dragging the picture out are the
        // two easy ways out of a page; neither is offered here.
        onContextMenu={(e) => e.preventDefault()}
        className="flex h-[92vh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,calc(100%-2rem))]"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-[14px] font-semibold">{att.name || 'Attachment'}</DialogTitle>
            <DialogDescription className="text-[12px] text-muted-foreground">
              {[att.size_bytes != null && fileSize(att.size_bytes), many && `${index + 1} of ${attachments.length}`, 'view only'].filter(Boolean).join(' · ')}
            </DialogDescription>
          </div>
          {many && (
            <div className="flex shrink-0 gap-1">
              <button type="button" onClick={() => go(-1)} aria-label="Previous attachment" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => go(1)} aria-label="Next attachment" className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground">
                <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          )}
        </header>
        <div className="min-h-0 flex-1 select-text overflow-auto bg-secondary/40">
          <Viewer key={att.id} att={att} webLink={webLink} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The file, read for the viewer: bytes for a PDF or a picture, the
 * server's data for a sheet or a text file.
 */
function useAttachment(att) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    if (!att.view || !att.view_url) { setState({ loading: false, error: null, data: null }); return undefined; }
    const ctl = new AbortController();
    setState({ loading: true, error: null, data: null });
    (async () => {
      const res = await fetch(att.view_url, { credentials: 'include', headers: { 'X-Tracker-View': '1' }, signal: ctl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message || `The attachment could not be opened (${res.status})`);
      }
      return att.view === 'pdf' || att.view === 'image' ? new Uint8Array(await res.arrayBuffer()) : (await res.json()).data;
    })()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => { if (err.name !== 'AbortError') setState({ loading: false, error: err.message, data: null }); });
    return () => ctl.abort();
  }, [att.view, att.view_url]);
  return state;
}

function Viewer({ att, webLink }) {
  const { loading, error, data } = useAttachment(att);
  if (!att.view) return <NotViewable webLink={webLink} text="This kind of file can't be shown in the tracker yet." />;
  if (loading) return <div className="p-6"><div className="skeleton mx-auto h-[60vh] max-w-[800px]" /></div>;
  if (error) return <NotViewable webLink={webLink} text={error} />;
  if (att.view === 'pdf') return <PdfView bytes={data} />;
  if (att.view === 'image') return <ImageView bytes={data} type={att.content_type} name={att.name} />;
  if (att.view === 'sheet') return <SheetView sheets={data.sheets} />;
  return <TextView text={data.text} truncated={data.truncated} />;
}

function NotViewable({ text, webLink }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-[360px]">
        <FileWarning className="mx-auto mb-3 size-8 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
        <p className="text-[13px] text-secondary-text">{text}</p>
        {webLink && (
          <a href={webLink} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">
            <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Open the message in Outlook
          </a>
        )}
      </div>
    </div>
  );
}

// pdf.js is large, so it loads the first time a PDF is opened, with its
// worker from the app's own origin (the page's script-src allows nothing else).
let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    pdfjs = lib;
  }
  return pdfjs;
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

/** A PDF, page by page onto canvases. Its scripts, forms and links do nothing. */
function PdfView({ bytes }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  const [zoom, setZoom] = useState(2); // index into ZOOMS: 1 = fit width
  const box = useRef(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let task = null; let gone = false;
    loadPdfjs().then((lib) => {
      if (gone) return;
      // A copy: pdf.js takes the buffer over to its worker.
      task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false, enableXfa: false, disableAutoFetch: true });
      return task.promise.then((d) => { if (!gone) setDoc(d); });
    }).catch(() => { if (!gone) setError('This PDF could not be read.'); });
    return () => { gone = true; task?.destroy(); };
  }, [bytes]);

  useEffect(() => {
    if (!box.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  if (error) return <NotViewable text={error} />;
  const pages = doc ? Array.from({ length: doc.numPages }, (_, i) => i + 1) : [];
  return (
    <div ref={box} className="relative min-h-full">
      <div className="sticky top-0 z-10 flex items-center justify-center gap-2 border-b border-border bg-card/95 px-3 py-1.5 text-[12px] text-secondary-text backdrop-blur">
        <span>{doc ? `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` : 'Opening…'}</span>
        <span className="text-border">|</span>
        <button type="button" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))} className="rounded-sm p-1 hover:bg-secondary disabled:opacity-40">
          <Minus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span className="num w-10 text-center">{Math.round(ZOOMS[zoom] * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} className="rounded-sm p-1 hover:bg-secondary disabled:opacity-40">
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setZoom(2)} className="rounded-sm px-1.5 py-0.5 hover:bg-secondary">Fit width</button>
      </div>
      <div className="flex flex-col items-center gap-3 p-3">
        {doc && width > 0 && pages.map((n) => <PdfPage key={n} doc={doc} n={n} width={Math.max(200, width - 24) * ZOOMS[zoom]} />)}
        {!doc && <div className="skeleton h-[60vh] w-full max-w-[800px]" />}
      </div>
    </div>
  );
}

/** One page, drawn when it scrolls near the view, at the screen's own pixel density. */
function PdfPage({ doc, n, width }) {
  const canvas = useRef(null);
  const [near, setNear] = useState(n <= 2);
  const [ratio, setRatio] = useState(1.414);

  useEffect(() => {
    if (near || !canvas.current) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true); }, { rootMargin: '800px 0px' });
    io.observe(canvas.current);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return undefined;
    let task = null; let gone = false;
    doc.getPage(n).then((page) => {
      if (gone || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      task = page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp, annotationMode: 0 });
      return task.promise;
    }).catch(() => { /* a cancelled render, or a page that would not draw */ });
    return () => { gone = true; task?.cancel(); };
  }, [doc, n, width, near]);

  // A page is paper in either theme, as the PDF itself is.
  return (
    <canvas
      ref={canvas}
      aria-label={`Page ${n}`}
      style={{ width, height: width * ratio }}
      className="max-w-none bg-white shadow-sm"
    />
  );
}

/**
 * A picture, from a data: address — the page's policy allows pictures from
 * the app and data: only, and a data: address is gone with the viewer.
 * An SVG drawn by an <img> runs nothing.
 */
function ImageView({ bytes, type, name }) {
  const [src, setSrc] = useState(null);
  const [fit, setFit] = useState(true);
  useEffect(() => {
    const reader = new FileReader();
    reader.onload = () => setSrc(reader.result);
    reader.readAsDataURL(new Blob([bytes], { type: type || 'image/png' }));
    return () => reader.abort();
  }, [bytes, type]);
  if (!src) return null;
  return (
    <div className={cn('flex min-h-full p-4', fit ? 'items-center justify-center' : 'items-start justify-start')}>
      <img
        src={src}
        alt={name || 'Attachment'}
        draggable={false}
        onClick={() => setFit((f) => !f)}
        className={cn('bg-white shadow-sm', fit ? 'max-h-[calc(92vh-6rem)] max-w-full cursor-zoom-in object-contain' : 'max-w-none cursor-zoom-out')}
      />
    </div>
  );
}

/** A spreadsheet, read-only, one tab per sheet; values as the sheet shows them. */
function SheetView({ sheets }) {
  const [i, setI] = useState(0);
  const sheet = sheets[i] || { rows: [] };
  const cols = useMemo(() => sheet.rows.reduce((n, r) => Math.max(n, r.length), 0), [sheet]);
  const letter = (c) => { let s = ''; for (let x = c + 1; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };
  if (!sheets.length) return <NotViewable text="This spreadsheet has no sheets." />;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-card">
        {sheet.rows.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-muted-foreground">This sheet is empty.</p>
        ) : (
          <table className="border-collapse text-[12px]">
            <thead className="sticky top-0 z-10 bg-secondary">
              <tr>
                <th className="sticky left-0 z-20 border border-border bg-secondary px-2 py-1" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} className="border border-border px-2 py-1 font-medium text-muted-foreground">{letter(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th className="sticky left-0 border border-border bg-secondary px-2 py-1 text-right font-medium text-muted-foreground num">{r + 1}</th>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} className="max-w-[320px] truncate border border-border px-2 py-1 text-foreground" title={row[c] || undefined}>{row[c] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sheet.truncated && (
          <p className="p-2 text-[12px] text-muted-foreground">Only the first 2,000 rows and 60 columns are shown here.</p>
        )}
      </div>
      {sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-card px-2 py-1.5" role="tablist" aria-label="Sheets">
          {sheets.map((s, n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={n === i}
              onClick={() => setI(n)}
              className={cn('shrink-0 rounded-md px-2.5 py-1 text-[12px]', n === i ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary/60')}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TextView({ text, truncated }) {
  return (
    <div className="p-4">
      <pre className="whitespace-pre-wrap break-words rounded-md bg-card p-4 font-mono text-[12.5px] text-foreground">{text}</pre>
      {truncated && <p className="mt-2 text-[12px] text-muted-foreground">Only the first part of this file is shown here.</p>}
    </div>
  );
}
