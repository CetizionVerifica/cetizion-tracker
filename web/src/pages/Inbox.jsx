import { forwardRef, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader, SidebarContext } from '../App.jsx';
import { PanelLeft, Paperclip, Reply } from 'lucide-react';
import { Badge, Card, ConfirmDialog, DataTable, Empty, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Select as ShadSelect, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select.tsx';
import { cn } from 'cn';
import { api } from '../lib/api.js';
import { frameDoc, hasRemoteImage } from '../lib/mailFrame.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { date } from '../lib/format.js';

/**
 * When something happened, written the way the rest of the app writes it.
 *
 * toLocaleString() gave "9/23/2026, 10:54:31 AM" — month-first, and to the
 * second — on every message and every reply-by line, in a tracker that
 * says "23 Sep 2026" everywhere else. Nobody needs the second an email
 * arrived.
 */
function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today, ${time}`;
  return `${date(d.toISOString())}, ${time}`;
}

/**
 * The shared sales inbox (#30): who owns each email, what is waiting on
 * us, replies from the shared address, and conversion to enquiries.
 */
/**
 * Three views, not six.
 *
 * "Unassigned" and "Overdue" were tabs somebody had to think about; they
 * are now reasons a row stands out in Open, which is where they were
 * always going to be looked at anyway.
 */
const VIEWS = [
  { key: 'all', label: 'Open' },
  { key: 'mine', label: 'Mine' },
  { key: 'closed', label: 'Done' },
];

const since = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (mins < 2880) return 'Yesterday';
  if (mins < 10080) return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

const initials = (name, email) => {
  const from = String(name || '').trim();
  if (!from) return '?';
  const parts = from.split(/\s+/).filter(Boolean);
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase();
};

/** A small square label. The word carries the meaning; the hue agrees. */
function Tag({ tone = 'plain', mono = false, children }) {
  const tones = {
    waiting: 'border-waiting/28 bg-waiting/10 text-waiting',
    settled: 'border-settled/28 bg-settled/10 text-settled',
    late: 'border-late/30 bg-late/10 text-late',
    plain: 'border-border bg-secondary text-secondary-text',
  };
  return (
    <span className={cn(
      'inline-flex h-5 items-center rounded-[6px] border px-2 text-[11px] font-semibold',
      mono && 'num font-medium', tones[tone]
    )}>
      {children}
    </span>
  );
}

/**
 * One conversation in the list.
 *
 * Everything the row says is a reason to pick it up or leave it: who it is
 * from, what it is about, whether anybody owns it, and what the tracker
 * already matched it to. That last part is the point — the inbox is not a
 * second CRM, so a thread arrives already knowing its company and its
 * deal.
 */
/**
 * The one chip that says what a thread is, in the order somebody acts on
 * it: a thread that looks like a new enquiry is that before it is anything
 * else, and one nobody could match to a company is that before it is a
 * reference number.
 */
function stateTag(row) {
  if (row.looks_new) return <Tag tone="waiting">New enquiry</Tag>;
  if (row.for_finance) return <Tag tone="settled">Payment · for finance</Tag>;
  if (!row.company_name) return <Tag>no company match</Tag>;
  if (row.enquiry_no) return <Tag tone="settled" mono>{row.enquiry_no}</Tag>;
  if (row.entity_id) return <Tag mono>{row.entity_id}</Tag>;
  return null;
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
 */
function MailBody({ id, html }) {
  const ref = useRef(null);
  const [height, setHeight] = useState(null);
  const [showImages, setShowImages] = useState(false);
  const blocked = !showImages && hasRemoteImage(html);

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
        srcDoc={frameDoc(html, showImages)}
      />
    </>
  );
}

const ThreadRow = forwardRef(function ThreadRow({ row, selected, onSelect }, ref) {
  // An option in a listbox rather than a button, so a screen reader says
  // "2 of 4, selected" and the arrow keys mean what they look like they
  // mean. Roving tabindex: Tab reaches the list once, arrows move inside.
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(row)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(row);
        }
      }}
      className={cn(
        'flex w-full cursor-pointer gap-3 border-b border-border px-5 py-3.5 text-left transition-colors duration-150',
        selected ? 'border-l-2 border-l-primary bg-card' : 'border-l-2 border-l-transparent hover:bg-card'
      )}
    >
      <span className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-semibold',
        row.company_name ? 'text-primary' : 'text-muted-foreground'
      )}>
        {initials(row.from_name || row.company_name, row.from_email)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {/* Nobody has opened it yet. A dot rather than bolding the row:
              weight would reflow the line the moment somebody read it, and
              the name is already semibold on every row. It sits in a fixed
              gutter so a read row lines up with an unread one. */}
          <span className="flex w-2 shrink-0 items-center self-center" aria-hidden="true">
            {row.unread && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground"
            title={[row.company_name || row.from_email, row.from_name].filter(Boolean).join(' · ')}
          >
            {row.company_name || row.from_email}
            {row.from_name && row.company_name && <span className="font-normal text-secondary-text"> · {row.from_name}</span>}
          </span>
          {row.has_attachments && (
            <Paperclip className="size-3 shrink-0 self-center text-muted-foreground" strokeWidth={1.75} aria-label="Has an attachment" />
          )}
          {/* Overdue is carried by the timestamp, not by a chip of its own.
              It is a fact about *when*, and on a quiet week every thread in
              the list is overdue — four red badges say nothing, four red
              timestamps say the same thing without displacing the chips
              that differ from row to row. */}
          <span
            className={cn('shrink-0 text-[11.5px]', row.overdue ? 'font-medium text-late' : 'text-muted-foreground')}
            title={row.overdue ? 'Nobody has replied to this yet' : undefined}
          >
            {since(row.last_message_at)}
          </span>
        </span>
        {/* Truncation has to be recoverable: the subject is the thing you
            are scanning for, and a clipped one with no way to read it is
            worse than a wrapped one. */}
        <span className={cn(
          'mt-0.5 block truncate text-[12.5px]',
          row.unread ? 'font-medium text-foreground' : 'text-secondary-text'
        )} title={row.subject || '(no subject)'}>
          {row.subject || '(no subject)'}
        </span>
        {/* Two lines of the newest message. This is the band C13 does not
            have, added deliberately: the subject alone does not say whether
            a "Re: Quotation …" is a question, an approval or a complaint,
            and opening a thread to find out is the thing the list exists to
            avoid. Clamped rather than truncated because one line of an
            email is rarely a sentence.

            A mailbox set to metadata-only stores no snippet, so the band
            simply does not appear for it rather than showing a blank line. */}
        {row.snippet && (
          <span className="mt-1 block line-clamp-2 text-[12px]/[1.45] text-muted-foreground">
            {row.snippet}
          </span>
        )}
        {/* Two chips at most: what this thread is, and whose it is. The
            row had up to six, all the same size, so the one that differed
            between rows was the hardest to find. */}
        <span className="mt-1.5 flex flex-wrap gap-1.5">
          {stateTag(row)}
          {row.assignee ? <Tag>{row.assignee}</Tag> : <Tag>no owner</Tag>}
        </span>
      </span>
    </div>
  );
});

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'all';
  const { isAdmin } = useAuth();
  const selected = params.get('c');
  const [q, setQ] = useState('');
  const sidebar = useContext(SidebarContext);
  const summary = useFetch(() => api.raw('/inbox/summary'), [view, selected]);
  const listUrl = view === 'closed' ? '/inbox?view=all&status=closed' : `/inbox?view=${view}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const list = useFetch(() => (view === 'setup' ? Promise.resolve({ data: [] }) : api.raw(listUrl)), [listUrl]);
  const s = summary.data?.data;
  const put = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const rows = list.data?.data ?? [];
  const rowRefs = useRef([]);
  const at = rows.findIndex((r) => String(r.id) === selected);

  /**
   * Up and down move through the list; Enter and Space open. Home and End
   * jump to the ends.
   *
   * A mail list you cannot walk with the keyboard is a mail list you
   * cannot use without a mouse, and this is a screen people live in.
   */
  const onListKey = useCallback((event) => {
    const keys = { ArrowDown: 1, ArrowUp: -1 };
    let next = null;
    if (event.key in keys) next = Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at) + keys[event.key]));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    if (next === null || !rows[next]) return;
    event.preventDefault();
    put('c', String(rows[next].id));
  }, [rows, at]);

  // Selection follows the keyboard, so focus has to follow it too —
  // otherwise the next arrow press starts from wherever focus was left.
  useEffect(() => {
    if (at >= 0) rowRefs.current[at]?.focus({ preventScroll: false });
  }, [at]);

  if (view === 'setup') {
    return (
      <>
        <PageHeader
          title="Inbox"
          subtitle="Email to the shared sales addresses."
          actions={<Button variant="secondary" onClick={() => put('view', 'all')}>Back to the inbox</Button>}
        />
        <div className="page stack"><InboxSetup /></div>
      </>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
        {/* The list. Its own header, because this screen is a place you
            live in rather than a page you visit. */}
        <div className={cn(
          'flex min-w-0 flex-col border-r border-border',
          selected && 'hidden lg:flex'
        )}>
          <div className="flex items-center gap-3 px-5 pt-6 pb-3">
            {/* This screen draws its own header instead of using PageHeader,
                and PageHeader is where the burger lives. Without this the
                inbox is a dead end on a phone: you can reach it and then
                not leave it. It is not `lg:hidden` either — PageHeader's
                burger shows at every width, so hiding this one made the
                inbox the one screen where a desktop cannot reclaim the
                240px the sidebar takes. */}
            <Button
              variant="ghost"
              size="icon"
              onClick={sidebar.toggle}
              aria-label={sidebar.hidden ? 'Show sidebar' : 'Hide sidebar'}
              className="size-control shrink-0"
            >
              <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden="true" />
            </Button>
            <h1 className="text-[20px] font-semibold tracking-[-0.018em] text-foreground">Inbox</h1>
            <span aria-live="polite" className="text-[13px] text-secondary-text">{s ? `${s.open} open` : ''}</span>
            <div className="flex-1" />
            <div className="flex items-center gap-1">
              {VIEWS.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => { const n = new URLSearchParams(); n.set('view', v.key); setParams(n, { replace: true }); }}
                  className={cn(
                    'rounded-[6px] px-2 py-1 text-[12.5px] font-medium transition-colors duration-150',
                    view === v.key ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {v.label}
                </button>
              ))}
              {/* The setup screen existed at ?view=setup and nothing linked
                  to it, so the only way to create an inbox — without which
                  a shared mailbox routes nothing — was to type the URL.
                  Admin-only, because only an admin can act on it. */}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => { const n = new URLSearchParams(); n.set('view', 'setup'); setParams(n, { replace: true }); }}
                  aria-label="Set up inboxes and canned responses"
                  className={cn(
                    'ml-auto rounded-[6px] px-2 py-1 text-[12.5px] font-medium transition-colors duration-150',
                    view === 'setup' ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  Set up
                </button>
              )}
            </div>
          </div>

          <div className="px-5 pb-3">
            <Input placeholder="Search subject, sender, company…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          <div
            role="listbox"
            aria-label="Conversations"
            onKeyDown={onListKey}
            className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
          >
            {list.loading && !list.data ? (
              <div className="p-5"><div className="skeleton" style={{ height: 120 }} /></div>
            ) : rows.length === 0 ? (
              <Empty title="Nothing here" text="New email to a shared mailbox appears here after the next sync." />
            ) : rows.map((row, i) => (
              <ThreadRow
                key={row.id}
                ref={(node) => { rowRefs.current[i] = node; }}
                row={row}
                selected={String(row.id) === selected}
                onSelect={(r) => put('c', String(r.id))}
              />
            ))}
          </div>
        </div>

        {/* The reading pane. On a phone it takes the screen, and the back
            link is how you get to the list again. */}
        <div className={cn('min-w-0 overflow-y-auto', !selected && 'hidden lg:block')}>
          {selected ? (
            <Conversation
              id={selected}
              onBack={() => put('c', null)}
              onChanged={() => { list.refetch(); summary.refetch(); }}
            />
          ) : (
            <div className="grid h-full place-items-center p-8">
              <Empty title="Pick a conversation" text="Every thread here already knows its company and its deal." />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Conversation({ id, onBack, onChanged }) {
  const toast = useToast();
  const lookups = useLookups();
  const conv = useFetch(() => api.raw(`/inbox/${id}`), [id]);
  const c = conv.data?.data;
  const thread = useFetch(() => (c ? api.raw(`/mail/threads/${c.thread_id}`) : Promise.resolve(null)), [c?.thread_id, c?.message_count]);
  const canned = useFetch(() => api.raw('/inbox/canned'));
  const [body, setBody] = useState('');
  // Closed on arrival, and closed again whenever the thread changes: a
  // draft belongs to the conversation it was started in.
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [snoozing, setSnoozing] = useState(false);

  useEffect(() => { setComposing(false); setBody(''); }, [id]);

  /**
   * Opening a thread is what marks it read, and the server does that as a
   * side effect of the fetch above — so the row in the list keeps its dot
   * until somebody tells it. This is that telling: once per thread, and
   * only for one that was actually unread, so reading down the list does
   * not refetch it on every arrow key.
   */
  const announced = useRef(null);
  useEffect(() => {
    if (c?.unread && announced.current !== id) {
      announced.current = id;
      onChanged();
    }
  }, [c?.unread, id, onChanged]);

  async function update(patch, ok) {
    setBusy(true);
    try { await api.raw(`/inbox/${id}`, { method: 'PATCH', body: patch }); if (ok) toast(ok, 'success'); conv.refetch(); onChanged(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function reply(close) {
    setBusy(true);
    try { await api.action(`/inbox/${id}/reply`, { body, close }); toast('Reply sent', 'success'); setBody(''); setComposing(false); conv.refetch(); thread.refetch(); onChanged(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  if (!c) return <div className="p-6"><div className="skeleton" style={{ height: 200 }} /></div>;
  const t = thread.data?.data;

  return (
    <div className="flex flex-col">
      <header className="border-b border-border px-6 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground lg:hidden"
        >
          ← All conversations
        </button>
        <h2 className="text-[18px]/[1.3] font-semibold tracking-[-0.015em] text-foreground">{c.subject || '(no subject)'}</h2>
        <p className="mt-1 wrap-anywhere text-[12.5px] text-secondary-text">
          {c.from_name || c.from_email} &lt;{c.from_email}&gt;
          {/* Which of our addresses it came to. C13 writes this as "to
              sales@", and it is the fact that decides who the reply is
              from — with two shared mailboxes connected, the pane read
              identically whichever one the client had written to. */}
          {c.inbox_email && <> · to <span className="text-foreground">{c.inbox_email.split('@')[0]}@</span></>}
          {c.company_name && <> · <Link to={`/companies/${c.company_id}`}>{c.company_name}</Link></>}
          {c.enquiry_no && <> · <Link to={`/enquiries?q=${encodeURIComponent(c.enquiry_no)}`}>{c.enquiry_no}</Link></>}
          {c.response_due_at && c.status === 'open' && <> · reply due {when(c.response_due_at)}</>}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {c.status !== 'closed'
            ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => update({ status: 'closed' }, 'Closed')}>Close</Button>
            : <Button variant="secondary" size="sm" disabled={busy} onClick={() => update({ status: 'open' }, 'Reopened')}>Reopen</Button>}
          {c.status !== 'snoozed' && c.status !== 'closed' && (
            <Button variant="ghost" size="sm" onClick={() => setSnoozing(true)}>Snooze</Button>
          )}
          <div className="flex-1" />
          <Input
            list="inbox-people"
            defaultValue={c.assignee || ''}
            key={`${c.id}-${c.assignee}`}
            onBlur={(e) => e.target.value !== (c.assignee || '') && update({ assignee: e.target.value || null }, 'Reassigned')}
            placeholder="Unassigned"
            aria-label="Owner"
            className="w-40"
          />
          <datalist id="inbox-people">{lookups.sales_people.map((p) => <option key={p} value={p} />)}</datalist>
        </div>
      </header>

      {/* One banner, one button.
          The tracker has already matched this thread to a company and
          looked for an open deal, so it says what it found and offers the
          single thing that follows. Only ever one suggestion: two would be
          a decision again, which is what this screen exists to remove. */}
      {c.suggestion && (
        <div className={cn(
          'flex flex-wrap items-center gap-3 border-b px-6 py-4',
          c.suggestion.kind === 'new_enquiry'
            ? 'border-primary/20 bg-primary/[0.06]'
            : 'border-waiting/20 bg-waiting/[0.07]'
        )}>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-medium text-foreground">{c.suggestion.headline}</div>
            <div className="mt-0.5 text-[12.5px] text-secondary-text">{c.suggestion.detail}</div>
          </div>
          <Button size="sm" onClick={() => setConverting(true)}>{c.suggestion.action}</Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => update({ status: 'closed' }, 'Closed without an enquiry')}
          >
            Not an enquiry
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3 px-6 py-4">
        {!t ? <div className="skeleton" style={{ height: 120 }} /> : t.messages.map((m) => (
          <div key={m.id} className={`mail mail--${m.direction}`}>
            <div className="mail__head"><span className="strong">{m.from_name || m.from_email}</span>{m.sent_from_tracker_by && <Badge tone="info">by {m.sent_from_tracker_by}</Badge>}<span className="small muted mail__when">{when(m.sent_at)}</span></div>
            {m.body_html ? <MailBody id={m.id} html={m.body_html} /> : <div className="mail__snippet">{m.snippet}</div>}
          </div>
        ))}

        {/* Reading is the common case and replying is the occasional one,
            so the composer is a button until it is wanted. Open, it took a
            third of the pane on every thread somebody only glanced at. */}
        {!composing ? (
          <div>
            <Button variant="secondary" size="sm" onClick={() => setComposing(true)}>
              <Reply className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> Reply
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-[10px] border border-border p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[12.5px] font-medium text-foreground">Reply from the shared address</span>
              <div className="flex-1" />
              <ShadSelect
                onValueChange={(value) => {
                  const x = (canned.data?.data ?? []).find((y) => String(y.id) === value);
                  if (x) setBody(x.body.replace(/\{\{\s*contact_name\s*\}\}/g, c.contact_name || c.from_name || 'Sir/Madam'));
                }}
              >
                <SelectTrigger size="sm" className="w-56" aria-label="Insert a canned response">
                  <SelectValue placeholder="Insert a canned response…" />
                </SelectTrigger>
                <SelectContent>
                  {(canned.data?.data ?? []).map((x) => (
                    <SelectItem key={x.id} value={String(x.id)}>{x.name}</SelectItem>
                  ))}
                </SelectContent>
              </ShadSelect>
            </div>
            <Textarea
              autoFocus
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="{{my_name}} is replaced with your name; the inbox signature is added."
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy || !body.trim()} onClick={() => reply(false)}>Send</Button>
              <Button variant="secondary" size="sm" disabled={busy || !body.trim()} onClick={() => reply(true)}>Send and close</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setComposing(false); setBody(''); }}>Cancel</Button>
            </div>
          </div>
        )}
      </div>
      {converting && <ConvertDialog c={c} people={lookups.sales_people} sources={lookups.lead_sources || []} onClose={() => setConverting(false)} onDone={() => { setConverting(false); conv.refetch(); onChanged(); }} />}
      {snoozing && <SnoozeDialog onClose={() => setSnoozing(false)} onSnooze={(until) => { setSnoozing(false); update({ status: 'snoozed', snoozed_until: until }, 'Snoozed'); }} />}
    </div>
  );
}

function ConvertDialog({ c, people, sources, onClose, onDone }) {
  const toast = useToast();
  const [v, setV] = useState({ client_name: c.company_name || '', contact_person: c.contact_name || c.from_name || '', service: c.subject || '', sales_person: c.assignee || '', source_id: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  async function go() {
    setBusy(true);
    try {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
      const { data } = await api.action(`/inbox/${c.id}/convert`, body);
      toast(`Enquiry ${data.enquiry_no} created`, 'success'); onDone();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="Convert to enquiry" subtitle="Creates an enquiry prefilled from this email, sourced from the inbox. The thread shows on the enquiry." onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy || !v.client_name.trim()} onClick={go}>Create enquiry</button></>}>
      <div className="form-grid">
        <Field label="Company" required><Input value={v.client_name} onChange={set('client_name')} /></Field>
        <Field label="Contact"><Input value={v.contact_person} onChange={set('contact_person')} /></Field>
        <div className="span-all"><Field label="Service asked for"><Input value={v.service} onChange={set('service')} /></Field></div>
        <Field label="Owner"><Input list="convert-people" value={v.sales_person} onChange={set('sales_person')} /><datalist id="convert-people">{people.map((p) => <option key={p} value={p} />)}</datalist></Field>
        <Field label="Source" hint="Blank: Inbound email or call"><Select value={v.source_id} options={sources.map((x) => ({ value: String(x.id), label: x.name }))} onChange={set('source_id')} /></Field>
        <div className="span-all"><Field label="Notes"><Textarea rows={2} value={v.notes} onChange={set('notes')} /></Field></div>
      </div>
    </Modal>
  );
}

function SnoozeDialog({ onClose, onSnooze }) {
  const at = (days, hour = 10) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  const [custom, setCustom] = useState('');
  return (
    <Modal size="sm" title="Snooze until" subtitle="It comes back to the open list then." onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Cancel</button>}>
      <div className="stack">
        <button type="button" className="btn" onClick={() => onSnooze(at(1))}>Tomorrow morning</button>
        <button type="button" className="btn" onClick={() => onSnooze(at(3))}>In 3 days</button>
        <button type="button" className="btn" onClick={() => onSnooze(at(7))}>Next week</button>
        <Field label="Or pick"><Input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} /></Field>
        <button type="button" className="btn btn--primary" disabled={!custom} onClick={() => onSnooze(new Date(custom).toISOString())}>Snooze</button>
      </div>
    </Modal>
  );
}

function InboxSetup() {
  const toast = useToast();
  const inboxes = useFetch(() => api.raw('/inbox/inboxes'));
  const canned = useFetch(() => api.raw('/inbox/canned'));
  const [form, setForm] = useState(null);
  const [cannedForm, setCannedForm] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = inboxes.data?.data ?? [];
  const avail = inboxes.data?.available_mailboxes ?? [];

  /**
   * The row already knows how many conversations it would take with it, so
   * the dialog says the number rather than making the server refuse once to
   * find out. ?discard=yes stands for having read it; the API still refuses
   * a delete that arrives without it, for callers with no dialog.
   */
  async function deleteInbox() {
    setBusy(true);
    try {
      await api.raw(`/inbox/inboxes/${removing.id}?discard=yes`, { method: 'DELETE' });
      toast(`${removing.name} deleted`, 'success');
      setRemoving(null);
      inboxes.refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally { setBusy(false); }
  }

  async function saveInbox() {
    try {
      const body = { name: form.name, default_assignment: form.default_assignment, members: form.members.split(',').map((x) => x.trim()).filter(Boolean), first_response_hours: form.first_response_hours || null, signature: form.signature || null };
      if (form.id) await api.raw(`/inbox/inboxes/${form.id}`, { method: 'PATCH', body }); else await api.action('/inbox/inboxes', { ...body, account_id: Number(form.account_id) });
      toast('Saved', 'success'); setForm(null); inboxes.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  async function saveCanned() {
    try {
      if (cannedForm.id) await api.raw(`/inbox/canned/${cannedForm.id}`, { method: 'PATCH', body: { name: cannedForm.name, body: cannedForm.body } }); else await api.action('/inbox/canned', { name: cannedForm.name, body: cannedForm.body });
      toast('Saved', 'success'); setCannedForm(null); canned.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <Card flush title="Inboxes" hint={<>A shared mailbox connected under <Link to="/mailboxes">Mailboxes</Link> becomes an inbox here.</>}
        actions={<button type="button" className="btn btn--sm btn--primary" disabled={!avail.length} title={avail.length ? '' : 'Connect a shared mailbox first'} onClick={() => setForm({ name: 'Sales', account_id: String(avail[0].id), default_assignment: 'owner_of_company', members: '', first_response_hours: '', signature: '' })}>+ Inbox</button>}>
        <DataTable rows={rows} empty={<Empty title="No inbox yet" text="Connect the shared sales mailbox under Mailboxes, then add it here." />} columns={[
          { key: 'name', header: 'Inbox', className: 'strong', render: (r) => <>{r.name}<div className="small muted">{r.email}</div></> },
          { key: 'default_assignment', header: 'New email goes to', render: (r) => ({ owner_of_company: 'The client\'s owner, else round robin', round_robin: 'Round robin', unassigned: 'Unassigned queue' }[r.default_assignment]) },
          { key: 'members', header: 'Round robin', render: (r) => r.members.join(', ') || '—' },
          { key: 'first_response_hours', header: 'Reply within', render: (r) => (r.first_response_hours ? `${r.first_response_hours} h` : 'Settings default') },
          { key: 'open', header: 'Open', align: 'right' },
          {
            key: 'act', header: '', align: 'right', render: (r) => (
              <div className="table__actions">
                <Button variant="ghost" size="sm" onClick={() => setForm({ ...r, members: r.members.join(', '), first_response_hours: r.first_response_hours || '', signature: r.signature || '' })}>Edit</Button>
                <Button variant="ghost" size="sm" aria-label={`Delete ${r.name}`} onClick={() => setRemoving(r)}>Delete</Button>
              </div>
            ),
          },
        ]} />
      </Card>
      <Card flush title="Canned responses" hint="Use {{contact_name}}, {{company_name}} and {{my_name}}." actions={<button type="button" className="btn btn--sm" onClick={() => setCannedForm({ name: '', body: '' })}>+ Response</button>}>
        <DataTable rows={canned.data?.data ?? []} columns={[
          { key: 'name', header: 'Name', className: 'strong' },
          { key: 'body', header: 'Text', className: 'wrap small', render: (r) => r.body.slice(0, 160) },
          { key: 'act', header: '', align: 'right', render: (r) => <div className="table__actions"><button type="button" className="btn btn--sm btn--ghost" onClick={() => setCannedForm(r)}>Edit</button><button type="button" className="btn btn--sm btn--ghost" onClick={() => api.remove('inbox/canned', r.id).then(canned.refetch)}>✕</button></div> },
        ]} />
      </Card>
      {form && (
        <Modal title={form.id ? `Edit ${form.name}` : 'New inbox'} onClose={() => setForm(null)} footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn--primary" onClick={saveInbox}>Save</button></>}>
          <div className="form-grid">
            <Field label="Name" required><Input value={form.name} onChange={set('name')} /></Field>
            {!form.id && <Field label="Mailbox" required><Select value={form.account_id} placeholder={null} options={avail.map((a) => ({ value: String(a.id), label: a.email }))} onChange={set('account_id')} /></Field>}
            <Field label="New email goes to"><Select value={form.default_assignment} placeholder={null} options={[{ value: 'owner_of_company', label: 'The client\'s owner, else round robin' }, { value: 'round_robin', label: 'Round robin' }, { value: 'unassigned', label: 'Unassigned queue' }]} onChange={set('default_assignment')} /></Field>
            <Field label="Reply within (hours)" hint="Blank: lead_first_response_hours in Settings"><Input type="number" min="1" value={form.first_response_hours} onChange={set('first_response_hours')} /></Field>
            <div className="span-all"><Field label="Round robin between" hint="Names, comma separated"><Input value={form.members} onChange={set('members')} /></Field></div>
            <div className="span-all"><Field label="Signature"><Textarea rows={3} value={form.signature} onChange={set('signature')} /></Field></div>
          </div>
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          message={removing.conversations
            ? `Its ${removing.conversations} conversation${removing.conversations === 1 ? '' : 's'} lose their status, owner and reply clock. The emails themselves stay under the mailbox, and new mail to ${removing.email} stops reaching the inbox.`
            : `Nothing has been routed to it yet. New mail to ${removing.email} stops reaching the inbox.`}
          confirmLabel="Delete"
          busy={busy}
          onConfirm={deleteInbox}
          onClose={() => setRemoving(null)}
        />
      )}
      {cannedForm && (
        <Modal title={cannedForm.id ? 'Edit response' : 'New response'} onClose={() => setCannedForm(null)} footer={<><button type="button" className="btn" onClick={() => setCannedForm(null)}>Cancel</button><button type="button" className="btn btn--primary" disabled={!cannedForm.name.trim() || !cannedForm.body.trim()} onClick={saveCanned}>Save</button></>}>
          <div className="stack">
            <Field label="Name" required><Input value={cannedForm.name} onChange={(e) => setCannedForm((f) => ({ ...f, name: e.target.value }))} /></Field>
            <Field label="Text" required><Textarea rows={8} value={cannedForm.body} onChange={(e) => setCannedForm((f) => ({ ...f, body: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
