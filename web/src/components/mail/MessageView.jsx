import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ChevronRight, ExternalLink, Flag, FlagOff, MoreHorizontal, Trash2 } from 'lucide-react';
import { cn } from 'cn';
import { Badge } from '../ui.jsx';
import { Button } from '@/components/ui/button.tsx';
import { api } from '../../lib/api.js';
import { frameDoc, hasRemoteImage } from '../../lib/mailFrame.js';
import { splitQuotedReply } from '../../lib/quotedReply.js';
import { useFetch } from '../../lib/hooks.js';
import { date } from '../../lib/format.js';
import { AttachmentStrip } from './AttachmentStrip.jsx';

/**
 * When something happened, written the way the rest of the app writes it.
 *
 * toLocaleString() gave "9/23/2026, 10:54:31 AM" — month-first, and to the
 * second — on every message and every reply-by line, in a tracker that
 * says "23 Sep 2026" everywhere else. Nobody needs the second an email
 * arrived.
 */
export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today, ${time}`;
  return `${date(d.toISOString())}, ${time}`;
}

/** Small enough not to crop a one-line email, large enough to stop a newsletter owning the page. */
const MAIL_MIN = 64;
const MAIL_MAX = 720;

/**
 * Somebody else's HTML, rendered at its own height.
 *
 * It stays in an iframe because an email is written for a white page and
 * rendering it inline on the dark ground turns dark text invisible — and
 * because it is untrusted markup either way.
 *
 * It was pinned at 220px, which cropped long messages and left three
 * inches of white under short ones. `sandbox="allow-same-origin"` without
 * `allow-scripts` is what fixes that: the email still cannot run a single
 * line of script, and *this* document can reach in and measure it. The
 * ResizeObserver catches images that arrive after load and change the
 * height under us.
 *
 * The popup permissions are what make a link in an email behave. Without
 * them `<base target="_blank">` is refused and the client's website loads
 * *inside* the message, which looks like the tracker and is not; with them
 * it opens as an ordinary tab, outside the sandbox where it belongs.
 *
 * `allow-same-origin` is also what lets the frame fetch the message's own
 * inline images (docs/inbox-outlook-plan.md §3.3): they come from the
 * tracker's inline route with the session cookie, and the frame's policy
 * allows that one path of ours and no other.
 */
export function MailBody({ id, html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(null);
  const [showImages, setShowImages] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);

  /**
   * A reply is mostly the email it is replying to. Showing the whole thing
   * meant every message in a thread repeated all the ones above it, so a
   * four-exchange thread rendered the first message four times and the
   * pane scrolled for pages. The history is still here, one click away —
   * it is the thing you occasionally need and never want by default.
   */
  const parts = useMemo(() => splitQuotedReply(html), [html]);
  const shown = parts.hasQuoted && !showQuoted ? parts.main : html;
  const blocked = !showImages && hasRemoteImage(shown);

  // The body, not documentElement: documentElement.scrollHeight never
  // reports less than the frame's own viewport, so measuring it just reads
  // back the height we set and the frame never shrinks.
  const measure = useCallback(() => {
    const body = ref.current?.contentDocument?.body;
    if (!body) return;
    setHeight(Math.min(Math.max(body.scrollHeight, MAIL_MIN), MAIL_MAX));
  }, []);

  const onLoad = useCallback(() => {
    // Showing the images rewrites srcDoc, so this runs again on a frame
    // that already has an observer. Without the disconnect the old one
    // keeps measuring a document that is gone.
    ref.current?._observer?.disconnect();
    measure();
    const body = ref.current?.contentDocument?.body;
    if (!body || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    ref.current._observer = observer;
  }, [measure]);

  useEffect(() => () => ref.current?._observer?.disconnect(), []);

  return (
    <>
      {blocked && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 rounded-[8px] border border-waiting/25 bg-waiting/[0.07] px-3 py-2">
          <span className="text-[12.5px] text-secondary-text">
            Images are not loaded. Loading them tells the sender you opened this.
          </span>
          <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setShowImages(true)}>
            Show images
          </Button>
        </div>
      )}
      <iframe
        ref={ref}
        className="mail__body"
        style={height ? { height } : undefined}
        title={`email ${id}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={onLoad}
        srcDoc={frameDoc(shown, showImages, { messageId: id })}
      />
      {parts.hasQuoted && (
        <button
          type="button"
          onClick={() => setShowQuoted((v) => !v)}
          aria-expanded={showQuoted}
          className="mt-1.5 inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-secondary px-2 py-1 text-[12px] text-secondary-text transition-colors duration-150 hover:text-foreground"
        >
          <MoreHorizontal className="size-3.5" strokeWidth={2} aria-hidden="true" />
          {showQuoted ? 'Hide the earlier replies' : 'Show the earlier replies'}
        </button>
      )}
    </>
  );
}

/** "Ravi Kumar <ravi@acme.com>" as the header writes a person; the address alone when that is all there is. */
const people = (emails = []) => (emails || []).join(', ');

/**
 * Outlook's marks on a message: importance and the flag
 * (docs/inbox-outlook-plan.md §3.3). Facts from the mailbox, shown as they
 * are; the actions that change them come with step 3.
 */
export function StateMarks({ m, className }) {
  const marks = [];
  if (m.importance === 'high') marks.push(<span key="hi" className="inline-flex items-center text-late" title="High importance" aria-label="High importance"><span className="text-[13px] font-bold leading-none">!</span></span>);
  if (m.importance === 'low') marks.push(<ArrowDown key="lo" className="size-3.5 text-muted-foreground" strokeWidth={2} aria-label="Low importance" title="Low importance" />);
  if (m.flag_status === 'flagged') marks.push(<Flag key="flag" className="size-3.5 fill-late text-late" strokeWidth={1.75} aria-label="Flagged" title="Flagged" />);
  if (m.flag_status === 'complete') marks.push(<FlagOff key="done" className="size-3.5 text-muted-foreground" strokeWidth={1.75} aria-label="Flag completed" title="Flag completed" />);
  if (!marks.length) return null;
  return <span className={cn('inline-flex items-center gap-1', className)}>{marks}</span>;
}

/**
 * One message in a thread, open or shut.
 *
 * A four-exchange thread rendered every message in full, so reading the
 * reply somebody actually sent meant scrolling past three you had already
 * read — and the one that matters is always the last. Everything above it
 * collapses to the line you need to recognise it by: who, when, and its
 * first few words. A thread of one or two stays open, because collapsing
 * half of a two-message thread hides nothing and costs a click.
 *
 * Open, it says who it went to (To, Cc, and Bcc on our own mail), what is
 * attached, and offers Open in Outlook. The recipients are one line until
 * asked for: the From and the first words are what a thread is read by.
 *
 * The body is inset rather than bled to the card edge. An email is written
 * for white paper and has to stay on it, but a white rectangle butted
 * against the dark chrome reads as a hole in the interface; with a margin
 * and a radius it reads as a letter lying on the desk.
 */
export function Message({ m, openByDefault }) {
  const [open, setOpen] = useState(openByDefault);
  const [details, setDetails] = useState(false);
  useEffect(() => { setOpen(openByDefault); }, [openByDefault, m.id]);
  const outbound = m.direction === 'outbound';
  const who = m.from_name || m.from_email;

  // The owner of a mailbox that stores less than the whole message reads
  // the rest live from Outlook when they open it (plan §3.3); nothing is
  // stored. Asked for once the message is open, never for a shut one.
  const live = useFetch(
    () => (open && m.can_read_live ? api.raw(`/mail/messages/${m.id}`) : Promise.resolve(null)),
    [m.id, open, m.can_read_live]
  );
  const liveData = live.data?.data;
  const body = liveData?.body_html ?? m.body_html;
  const snippet = liveData?.snippet ?? m.snippet;
  const attachments = liveData?.attachments ?? m.attachments ?? [];
  const removed = Boolean(m.removed_at);

  return (
    <article
      className={cn(
        'overflow-hidden rounded-[10px] border border-border bg-card',
        outbound && 'border-l-[3px] border-l-primary',
        removed && 'opacity-80'
      )}
    >
      <header
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-150 hover:bg-secondary/60"
      >
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span className="shrink-0 text-[13px] font-semibold text-foreground" title={m.from_email}>{who}</span>
        <StateMarks m={m} className="shrink-0" />
        {outbound && <Badge tone="info">sent</Badge>}
        {m.sent_from_tracker_by && <Badge tone="neutral">by {m.sent_from_tracker_by}</Badge>}
        {removed && <Badge tone="neutral"><Trash2 className="size-3" strokeWidth={1.75} aria-hidden="true" /> deleted in Outlook</Badge>}
        {/* Shut, the line has to be enough to recognise the message by. */}
        {!open && snippet && (
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{snippet}</span>
        )}
        {open && <span className="flex-1" />}
        <time
          dateTime={m.sent_at}
          title={new Date(m.sent_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
          className="shrink-0 text-[11.5px] text-muted-foreground"
        >
          {when(m.sent_at)}
        </time>
      </header>
      {open && (
        <div className="px-2.5 pb-2.5">
          {/* Who it went to. One line, with the full list behind "Details":
              the names are what you check before you reply all, not what
              you read a message for. */}
          <div className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-1 px-1 text-[12px] text-secondary-text">
            {!details ? (
              <>
                <span className="min-w-0 flex-1 truncate">
                  to <span className="text-foreground">{people(m.to_emails) || '—'}</span>
                  {m.cc_emails?.length > 0 && <> · cc <span className="text-foreground">{people(m.cc_emails)}</span></>}
                </span>
                <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setDetails(true)} aria-expanded={false}>Details</button>
              </>
            ) : (
              <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
                <dt className="text-muted-foreground">From</dt><dd className="wrap-anywhere text-foreground">{m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email}</dd>
                <dt className="text-muted-foreground">To</dt><dd className="wrap-anywhere text-foreground">{people(m.to_emails) || '—'}</dd>
                {m.cc_emails?.length > 0 && <><dt className="text-muted-foreground">Cc</dt><dd className="wrap-anywhere text-foreground">{people(m.cc_emails)}</dd></>}
                {m.bcc_emails?.length > 0 && <><dt className="text-muted-foreground">Bcc</dt><dd className="wrap-anywhere text-foreground">{people(m.bcc_emails)}</dd></>}
                <dt className="text-muted-foreground">Sent</dt><dd className="text-foreground">{new Date(m.sent_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</dd>
                {m.importance && m.importance !== 'normal' && <><dt className="text-muted-foreground">Importance</dt><dd className="capitalize text-foreground">{m.importance}</dd></>}
              </dl>
            )}
            {details && <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setDetails(false)} aria-expanded>Less</button>}
            {m.web_link && (
              <a
                href={m.web_link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-muted-foreground hover:text-foreground"
                title="Open this message in Outlook on the web"
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Open in Outlook
              </a>
            )}
          </div>
          {removed ? (
            <div className="rounded-[7px] bg-secondary px-3 py-2.5 text-[13px] text-secondary-text">This message was deleted in Outlook. The record keeps the fact that it was sent; the text is gone.</div>
          ) : body
            ? <MailBody id={m.id} html={body} />
            : live.loading && m.can_read_live
              ? <div className="skeleton" style={{ height: 80 }} />
              : (
                <div className="rounded-[7px] bg-secondary px-3 py-2.5 text-[13px] text-secondary-text">
                  {snippet || (liveData?.live_error || (m.can_read_live ? 'The message could not be read from the mailbox just now.' : 'The mailbox owner shares only who and when.'))}
                </div>
              )}
          <AttachmentStrip attachments={attachments} bodyHtml={body} className="mt-2 px-1" />
        </div>
      )}
    </article>
  );
}
