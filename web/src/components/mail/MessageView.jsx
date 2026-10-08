import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ExternalLink, Flag, FlagOff, ImageOff, Info } from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from 'cn';
import { api } from '../../lib/api.js';
import { frameDoc, hasRemoteImage } from '../../lib/mailFrame.js';
import { splitQuotedReply } from '../../lib/quotedReply.js';
import { useFetch } from '../../lib/hooks.js';
import { date } from '../../lib/format.js';
import { AttachmentStrip } from './AttachmentStrip.jsx';

/**
 * When something happened, written the way the rest of the app writes it:
 * "today, 11:08" or "23 Sep 2026, 10:54". Nobody needs the second an email
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

/** The full time, for a tooltip: "Tuesday 7 October 2026, 11:08 am (India)". */
export const fullWhen = (iso) => (iso
  ? `${new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' })} (India)`
  : '');

export const initialsOf = (name) => {
  const parts = String(name || '').replace(/[<>()@.]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
};

/** Small enough not to crop a one-line email, large enough to stop a newsletter owning the page. */
const MAIL_MIN = 64;
const MAIL_MAX = 720;

/**
 * The page's resolved colours for a bare email's paper, so it follows light
 * and dark (the frame cannot see the page's custom properties).
 */
function usePaper() {
  const { resolvedTheme } = useTheme();
  return useMemo(() => {
    if (typeof window === 'undefined' || !document.body) return null;
    const css = getComputedStyle(document.body);
    const v = (k) => css.getPropertyValue(k).trim();
    return { scheme: resolvedTheme === 'dark' ? 'dark' : 'light', text: v('--text'), link: v('--caramel-text'), muted: v('--text2'), line: v('--line'), track: v('--track') };
  }, [resolvedTheme]);
}

/**
 * Somebody else's HTML, rendered at its own height, on the theme's paper.
 *
 * It stays in an iframe because it is untrusted markup. `sandbox` without
 * `allow-scripts` means the email cannot run a line of script, and
 * `allow-same-origin` lets this document measure it (and fetch the
 * message's own inline images from the one path the frame's policy
 * allows). The popup permissions make a link open as an ordinary tab
 * rather than load the client's site inside the message.
 */
export function MailBody({ id, html }) {
  const ref = useRef(null);
  const paper = usePaper();
  const [height, setHeight] = useState(null);
  const [showImages, setShowImages] = useState(false);
  const [showQuoted, setShowQuoted] = useState(false);

  // A reply is mostly the email it is replying to; the history is one click away.
  const parts = useMemo(() => splitQuotedReply(html), [html]);
  const shown = parts.hasQuoted && !showQuoted ? parts.main : html;
  const blocked = !showImages && hasRemoteImage(shown);

  // The body, not documentElement: documentElement.scrollHeight never
  // reports less than the frame's own viewport.
  const measure = useCallback(() => {
    const body = ref.current?.contentDocument?.body;
    if (!body) return;
    setHeight(Math.min(Math.max(body.scrollHeight, MAIL_MIN), MAIL_MAX));
  }, []);

  const onLoad = useCallback(() => {
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
        <div className="mg-banner mg-banner--wait" role="note">
          <ImageOff strokeWidth={1.8} aria-hidden="true" />
          <div className="mg-banner__body">Images are not loaded. Loading them tells the sender you opened this.</div>
          <button type="button" className="mg-btn mg-btn--sm" onClick={() => setShowImages(true)}>Show images</button>
        </div>
      )}
      <div className="app-msg__paper">
        <iframe
          ref={ref}
          className="app-msg__frame"
          style={height ? { height } : undefined}
          title={`email ${id}`}
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          onLoad={onLoad}
          srcDoc={frameDoc(shown, showImages, { messageId: id, paper })}
        />
        {parts.hasQuoted && (
          <button
            type="button"
            className="mg-btn mg-btn--ghost mg-btn--sm app-msg__quoted"
            onClick={() => setShowQuoted((v) => !v)}
            aria-expanded={showQuoted}
          >
            {showQuoted ? 'Hide the earlier replies' : 'Show the earlier replies'}
          </button>
        )}
      </div>
    </>
  );
}

const people = (emails = []) => (emails || []).join(', ');

/**
 * Outlook's marks on a message or a row: importance and the flag, as small
 * icons (the list) — the message card says them in words.
 */
export function StateMarks({ m, className }) {
  const marks = [];
  if (m.importance === 'high') marks.push(<span key="hi" className="inline-flex items-center text-late" title="High importance" aria-label="High importance"><span className="text-[13px] font-extrabold leading-none">!</span></span>);
  if (m.importance === 'low') marks.push(<ArrowDown key="lo" className="size-3.5 text-muted-foreground" strokeWidth={2} aria-label="Low importance" />);
  if (m.flag_status === 'flagged') marks.push(<Flag key="flag" className="size-3.5 text-late" strokeWidth={1.8} aria-label="Flagged" />);
  if (m.flag_status === 'complete') marks.push(<FlagOff key="done" className="size-3.5 text-muted-foreground" strokeWidth={1.8} aria-label="Flag completed" />);
  if (!marks.length) return null;
  return <span className={cn('inline-flex items-center gap-1', className)}>{marks}</span>;
}

/** The marks as word badges, for the message card. */
function markBadges(m) {
  const out = [];
  if (m.direction === 'outbound') out.push(['Sent', 'mg-badge--plain']);
  if (m.sent_from_tracker_by) out.push([`Sent from the tracker by ${m.sent_from_tracker_by}`, 'mg-badge--plain']);
  if (m.importance === 'high') out.push(['High importance', 'mg-badge--late']);
  if (m.importance === 'low') out.push(['Low importance', 'mg-badge--plain']);
  if (m.flag_status === 'flagged') out.push(['Flagged', 'mg-badge--wait']);
  if (m.flag_status === 'complete') out.push(['Flag completed', 'mg-badge--plain']);
  if (m.removed_at) out.push(['Deleted in Outlook', 'mg-badge--plain']);
  return out;
}

/**
 * One message in a thread, open or shut.
 *
 * Shut, it is the line you recognise it by: who, when, and its first
 * words. Open, it says who it went to, offers Details (every recipient,
 * the time and the importance) and Open in Outlook, and shows the body on
 * the theme's paper with its attachments. A thread of one or two stays
 * open, because collapsing half of a two-message thread hides nothing.
 */
export function Message({ m, openByDefault }) {
  const [open, setOpen] = useState(openByDefault);
  const [details, setDetails] = useState(false);
  useEffect(() => { setOpen(openByDefault); }, [openByDefault, m.id]);
  const outbound = m.direction === 'outbound';
  const who = m.from_name || m.from_email;

  // A mailbox that stores less than the whole message is read live from
  // Outlook by its owner when they open it; asked once and kept.
  const [wanted, setWanted] = useState(Boolean(openByDefault && m.can_read_live));
  useEffect(() => { if (open && m.can_read_live) setWanted(true); }, [open, m.can_read_live]);
  useEffect(() => { setWanted(Boolean(openByDefault && m.can_read_live)); }, [m.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = useFetch(
    () => (wanted ? api.raw(`/mail/messages/${m.id}`) : Promise.resolve(null)),
    [m.id, wanted]
  );
  const liveData = live.data?.data;
  const body = liveData?.body_html ?? m.body_html;
  const snippet = liveData?.snippet ?? m.snippet;
  const attachments = liveData?.attachments ?? m.attachments ?? [];
  const removed = Boolean(m.removed_at);
  const to = `to ${people(m.to_emails) || '—'}${m.cc_emails?.length ? ` · cc ${people(m.cc_emails)}` : ''}`;
  const sent = when(m.sent_at);

  return (
    <article
      className={cn('app-msg', outbound && 'is-out', removed && 'is-removed')}
      aria-label={`${outbound ? 'Sent by' : 'From'} ${who}, ${sent}`}
    >
      <button type="button" className="app-msg__top" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="mg-avatar" aria-hidden="true">{initialsOf(who)}</span>
        <span className="app-msg__who">
          <strong title={m.from_email}>{who}</strong>
          {markBadges(m).map(([label, tone]) => <span key={label} className={cn('mg-badge is-sm', tone)}>{label}</span>)}
        </span>
        <time dateTime={m.sent_at} title={fullWhen(m.sent_at)} className="app-msg__when">{sent}</time>
        <span className="app-msg__line2">{open ? to : (snippet || to)}</span>
      </button>
      {open && (
        <div className="app-msg__open">
          <div className="app-msg__tools">
            <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
              {details ? 'Hide details' : 'Details'}
            </button>
            {m.web_link && (
              <a href={m.web_link} target="_blank" rel="noopener noreferrer" className="mg-btn mg-btn--ghost mg-btn--sm" title="Open this message in Outlook on the web">
                <ExternalLink className="size-4" strokeWidth={1.8} aria-hidden="true" />Open in Outlook
              </a>
            )}
          </div>
          {details && (
            <dl className="mg-facts app-msg__facts">
              <div><dt>From</dt><dd>{m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email}</dd></div>
              <div><dt>To</dt><dd>{people(m.to_emails) || '—'}</dd></div>
              {m.cc_emails?.length > 0 && <div><dt>Cc</dt><dd>{people(m.cc_emails)}</dd></div>}
              {m.bcc_emails?.length > 0 && <div><dt>Bcc</dt><dd>{people(m.bcc_emails)}</dd></div>}
              <div><dt>Sent</dt><dd>{fullWhen(m.sent_at)}</dd></div>
              <div><dt>Importance</dt><dd>{m.importance === 'high' ? 'High' : m.importance === 'low' ? 'Low' : 'Normal'}</dd></div>
            </dl>
          )}
          {removed ? (
            <div className="mg-banner" role="status"><Info strokeWidth={1.8} aria-hidden="true" /><div className="mg-banner__body">This message was deleted in Outlook. The record keeps the fact that it was sent; the text is gone.</div></div>
          ) : body
            ? <MailBody id={m.id} html={body} />
            : live.loading && m.can_read_live
              ? <div className="mg-skel" style={{ height: 80 }} aria-label="Reading the message from the mailbox" />
              : (
                <p className="app-msg__note">
                  {snippet || liveData?.live_error || (m.can_read_live ? 'The message could not be read from the mailbox just now. It is tried again on the next sync.' : 'The mailbox owner shares only who and when.')}
                </p>
              )}
          <AttachmentStrip attachments={attachments} bodyHtml={body} webLink={m.web_link} />
        </div>
      )}
    </article>
  );
}
