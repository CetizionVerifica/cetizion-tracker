import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FileWarning, Minus, Plus } from 'lucide-react';
import { cn } from 'cn';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.tsx';
import { fileSize } from '../../lib/format.js';
import { frameDoc } from '../../lib/mailFrame.js';

/**
 * An email's attachments, opened in the tracker (docs/inbox-attachments-plan.md,
 * step 1). Viewed here and nowhere else: there is no Download, no Print,
 * no "open in a new tab", and the file is read with a header a link
 * cannot send, so its address pasted into a tab gives nothing. The file
 * is drawn by the page itself: a PDF by pdf.js onto canvases (its own
 * scripts never run, and the browser's PDF toolbar with its Save button
 * never appears), a picture as an <img>, a spreadsheet or a text file from
 * the data the server turned it into, a Word document or a forwarded
 * email as cleaned HTML in the same script-free frame a mail body uses.
 * Nothing is kept once it closes.
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
        className="app-av flex h-[92dvh] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,calc(100%-2rem))]"
      >
        <header className="app-av__head">
          <div className="min-w-0 flex-1">
            <DialogTitle className="app-av__title">{att.name || 'Attachment'}</DialogTitle>
            <DialogDescription className="app-av__sub">
              {[att.size_bytes != null && fileSize(att.size_bytes), many && `${index + 1} of ${attachments.length}`, 'view only'].filter(Boolean).join(' · ')}
            </DialogDescription>
          </div>
          {many && (
            <div className="app-av__nav">
              <button type="button" onClick={() => go(-1)} aria-label="Previous attachment" className="mg-iconbtn">
                <ChevronLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => go(1)} aria-label="Next attachment" className="mg-iconbtn">
                <ChevronRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          )}
        </header>
        <div className="app-av__body">
          <Viewer key={att.id} att={att} webLink={webLink} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The file, read for the viewer: bytes for a PDF, a picture or a
 * converted Office file, the server's data for a sheet or a text file.
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
      return att.view === 'pdf' || att.view === 'image' || att.view === 'office' ? new Uint8Array(await res.arrayBuffer()) : (await res.json()).data;
    })()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => { if (err.name !== 'AbortError') setState({ loading: false, error: err.message, data: null }); });
    return () => ctl.abort();
  }, [att.view, att.view_url]);
  return state;
}

function Viewer({ att, webLink }) {
  const { loading, error, data } = useAttachment(att);
  if (!att.view) {
    return <NotViewable webLink={webLink} text={att.kind === 'reference' ? 'This is a link to a file in OneDrive or SharePoint. Open the message in Outlook to reach it.' : "This kind of file can't be shown in the tracker yet."} />;
  }
  if (loading) {
    return (
      <div className="p-6">
        {att.view === 'office' && <p className="app-av__note" role="status">Converting the file for viewing…</p>}
        <div className="mg-skel mx-auto h-[60vh] max-w-[800px]" />
      </div>
    );
  }
  if (error) return <NotViewable webLink={webLink} text={error} />;
  // PowerPoint and older Office files arrive converted to a PDF.
  if (att.view === 'pdf' || att.view === 'office') return <PdfView bytes={data} />;
  if (att.view === 'image') return <ImageView bytes={data} type={att.content_type} name={att.name} />;
  if (att.view === 'sheet') return <SheetView sheets={data.sheets} />;
  if (att.view === 'word') return <div className="p-4"><HtmlView html={data.html} title={att.name} /></div>;
  if (att.view === 'email') return <EmailView email={data} />;
  return <TextView text={data.text} truncated={data.truncated} />;
}

function NotViewable({ text, webLink }) {
  return (
    <div className="mg-empty app-av__none">
      <span className="mg-empty__mark" aria-hidden="true"><FileWarning strokeWidth={1.8} /></span>
      <p className="mg-empty__text">{text}</p>
      {webLink && (
        <a href={webLink} target="_blank" rel="noopener noreferrer" className="mg-btn mg-btn--sm">
          <ExternalLink className="size-4" strokeWidth={1.8} aria-hidden="true" />Open the message in Outlook
        </a>
      )}
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
      <div className="app-av__tools">
        <span>{doc ? `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` : 'Opening…'}</span>
        <span className="app-av__sep" aria-hidden="true" />
        <button type="button" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))} className="mg-iconbtn app-av__zoom">
          <Minus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span className="mg-num app-av__pct">{Math.round(ZOOMS[zoom] * 100)}%</span>
        <button type="button" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))} className="mg-iconbtn app-av__zoom">
          <Plus className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setZoom(2)} className="mg-btn mg-btn--ghost mg-btn--sm">Fit width</button>
      </div>
      <div className="flex flex-col items-center gap-3 p-3">
        {doc && width > 0 && pages.map((n) => <PdfPage key={n} doc={doc} n={n} width={Math.max(200, width - 24) * ZOOMS[zoom]} />)}
        {!doc && <div className="mg-skel h-[60vh] w-full max-w-[800px]" />}
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
      className="app-av__paper max-w-none"
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
        className={cn('app-av__paper', fit ? 'max-h-[calc(92vh-6rem)] max-w-full cursor-zoom-in object-contain' : 'max-w-none cursor-zoom-out')}
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
      <div className="app-av__sheet">
        {sheet.rows.length === 0 ? (
          <p className="app-av__note p-6">This sheet is empty.</p>
        ) : (
          <table className="app-av__grid">
            <thead>
              <tr>
                <th className="is-corner" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} scope="col">{letter(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row" className="mg-num">{r + 1}</th>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} title={row[c] || undefined}>{row[c] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sheet.truncated && (
          <p className="app-av__note p-2">Only the first 2,000 rows and 60 columns are shown here.</p>
        )}
      </div>
      {sheets.length > 1 && (
        <div className="mg-tabs app-av__sheets" role="tablist" aria-label="Sheets">
          {sheets.map((s, n) => (
            <button
              key={n}
              type="button"
              role="tab"
              aria-selected={n === i}
              onClick={() => setI(n)}
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
      <pre className="app-av__text">{text}</pre>
      {truncated && <p className="app-av__note mt-2">Only the first part of this file is shown here.</p>}
    </div>
  );
}

/**
 * HTML the server cleaned (a Word document, a forwarded email), drawn the
 * way a mail body is: on white paper, in a frame that runs no script and
 * loads no remote picture. It is sized to its content once loaded.
 */
function HtmlView({ html, title }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(240);
  const onLoad = () => {
    const body = ref.current?.contentDocument?.body;
    if (body) setHeight(Math.max(body.scrollHeight + 24, 120));
  };
  return (
    <iframe
      ref={ref}
      title={title || 'Attachment'}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      srcDoc={frameDoc(html, false)}
      style={{ height }}
      className="mail__body app-av__frame"
    />
  );
}

const person = (p) => (p ? (p.name ? `${p.name} <${p.email}>` : p.email) : '');

/** An email forwarded as an attachment: who, when, and its body. */
function EmailView({ email }) {
  return (
    <div className="mx-auto max-w-[860px] p-4">
      <dl className="app-av__mailhead">
        <dt>Subject</dt><dd className="is-strong">{email.subject || '(no subject)'}</dd>
        <dt>From</dt><dd>{person(email.from) || '—'}</dd>
        <dt>To</dt><dd>{email.to?.map(person).join(', ') || '—'}</dd>
        {email.cc?.length > 0 && <><dt>Cc</dt><dd>{email.cc.map(person).join(', ')}</dd></>}
        {email.sent_at && <><dt>Sent</dt><dd>{new Date(email.sent_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</dd></>}
      </dl>
      <HtmlView html={email.html || '<p></p>'} title={email.subject} />
    </div>
  );
}
