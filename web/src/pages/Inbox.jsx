import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast as sonnerToast } from 'sonner';
import {
  ArrowLeft, Check, Clock, Copy, ExternalLink, FilePlus, Filter, Keyboard, Lightbulb, Lock, Paperclip, Plus, Reply, RotateCcw, Search, Send, SlidersHorizontal, X,
} from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { useToast } from '../components/ui.jsx';
import { MoreMenu } from '../components/sales.jsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { cn } from 'cn';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
// The pieces of a mail client (docs/inbox-outlook-plan.md §3.7), each its
// own component: the message card, the mailbox and folder switcher, the
// rows of a folder, the pane a folder's conversation is read in.
import { Message, when } from '../components/mail/MessageView.jsx';
import { MailboxSwitcher, selectionLabel, teamInboxes } from '../components/mail/MailboxSwitcher.jsx';
import { MessageRow, Pager, initials, openOnKey, since } from '../components/mail/MessageList.jsx';
import { ReadingPane } from '../components/mail/ReadingPane.jsx';
import { PaneLoading, PaneState } from '../components/mail/PaneState.jsx';
import { ConvertDialog, SnoozeDialog } from './inbox/dialogs.jsx';
import { InboxSetup } from './inbox/InboxSetup.jsx';

/**
 * The shared sales inbox (#30): who owns each email, what is waiting on
 * us, replies from the shared address, and conversion to enquiries. Wave 4
 * of the redesign: the mailbox name is the title with the switcher beside
 * it, the views sit in the header, and the list and the conversation are
 * two glass panes (one at a time under 1000px).
 *
 * Three views, not six: "Unassigned" and "Overdue" are reasons a row
 * stands out in Open.
 */
const VIEWS = [
  { key: 'all', label: 'Open', count: 'open' },
  { key: 'mine', label: 'Mine', count: 'mine' },
  { key: 'closed', label: 'Done' },
];
const SEG_W = 86;

/** Conversations per page; the server's default too. */
const PAGE_SIZE = 50;
/** How often the open page asks the server to pull mail, and re-reads what it has. */
const SYNC_EVERY_MS = 60_000;
const REFRESH_EVERY_MS = 20_000;

/** Somewhere a key press is typing, not a shortcut. */
const typing = (el) => Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
const dialogOpen = () => Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]'));

const KEYS = [
  ['Move through the list and open', ['↑', '↓']],
  ['First and last conversation', ['Home', 'End']],
  ['Open the highlighted conversation', ['Enter']],
  ['Open it too', ['Space']],
  ['Back to the list', ['Esc']],
  ['Reply', ['R']],
  ['Close', ['E']],
  ['Snooze', ['S']],
  ['Search', ['/']],
];

/** The time a reply is due, the way the row says it: "Due 15:30" today, else "Due 9 Oct". */
function dueWord(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toDateString() === new Date().toDateString()
    ? `Due ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : `Due ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/** Where the conversation stands: overdue, due, waiting on the client, snoozed or closed. */
function dueChip(row) {
  if (row.status === 'closed') return ['Closed', 'mg-badge--plain'];
  if (row.status === 'snoozed') return ['Snoozed', 'mg-badge--info'];
  if (row.status === 'pending_client') return ['Waiting on client', 'mg-badge--info'];
  if (row.overdue) return ['Overdue', 'mg-badge--late'];
  if (row.response_due_at) return [dueWord(row.response_due_at), 'mg-badge--wait'];
  return null;
}

/**
 * The one chip that says what a thread is, in the order somebody acts on
 * it: a robot never reads as a lead, a thread that looks like a new
 * enquiry is that before it is anything else, and one nobody could match
 * to a company is that before it is a reference number.
 */
function stateTag(row) {
  if (row.filtered_as === 'internal only') return ['Internal', 'mg-badge--plain'];
  if (row.filtered_as) return ['Automated', 'mg-badge--plain'];
  if (row.looks_new) return ['New enquiry', 'mg-badge--wait'];
  if (row.for_finance) return ['Payment · for finance', 'mg-badge--ok'];
  if (!row.company_name) return ['No company on file', 'mg-badge--plain'];
  if (row.enquiry_no) return [row.enquiry_no, 'mg-badge--ok'];
  if (row.entity_id) return [row.entity_id, 'mg-badge--plain'];
  return null;
}

/**
 * One conversation in the team queue: who, what about, whether anybody
 * owns it, and what the tracker already matched it to. An option in a
 * listbox, so a screen reader says "2 of 4, selected"; its name carries
 * unread, overdue and the attachment, so they are heard as well as seen.
 */
const ThreadRow = forwardRef(function ThreadRow({ row, selected, onSelect }, ref) {
  const lead = row.company_name || row.from_name || row.from_email;
  const due = dueChip(row);
  const tag = stateTag(row);
  const when = since(row.last_message_at);
  const aria = [row.unread && 'Unread', row.overdue && 'Overdue', lead, row.company_name && row.from_name, row.subject || '(no subject)', row.has_attachments && 'has an attachment', when].filter(Boolean).join(', ');
  return (
    <div
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-label={aria}
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(row)}
      onKeyDown={openOnKey(() => onSelect(row))}
      className={cn('app-ib__row', row.unread && 'is-unread')}
    >
      <span className={cn('mg-avatar', !row.company_name && 'is-unmatched')} aria-hidden="true">{initials(row.from_name || row.company_name || row.from_email)}</span>
      <span className="app-ib__name">
        {row.unread && <span className="app-ib__dot" aria-hidden="true" />}
        <span className="app-ib__lead" title={[row.company_name, row.from_name, row.from_email].filter(Boolean).join(' · ')}>
          <span>{lead}{row.company_name && row.from_name && <small> · {row.from_name}</small>}</span>
        </span>
      </span>
      <span className={cn('app-ib__time', row.overdue && 'is-late')} title={row.overdue ? 'Nobody has replied to this yet' : undefined}>
        {row.has_attachments && <Paperclip strokeWidth={1.8} aria-hidden="true" />}
        <span>{when}</span>
      </span>
      <span className="app-ib__subj" title={row.subject || '(no subject)'}>{row.subject || '(no subject)'}</span>
      {/* A mailbox set to metadata-only stores no snippet; the band does not appear rather than show a blank line. */}
      {row.snippet && <span className="app-ib__snip"><span>{row.snippet}</span></span>}
      <span className="app-ib__chips">
        {due && <span className={cn('mg-badge', due[1])}>{due[0]}</span>}
        {tag && <span className={cn('mg-badge mg-num', tag[1])}>{tag[0]}</span>}
        <span className="mg-badge mg-badge--plain">{row.assignee || 'No owner'}</span>
      </span>
    </div>
  );
});

function ListSkeleton() {
  const rows = [['58%', '44%'], ['46%', '62%'], ['64%', '38%'], ['52%', '56%'], ['40%', '48%']];
  return (
    <div className="app-ib__skel" aria-busy="true" aria-label="Loading conversations">
      {rows.map(([a, b]) => (
        <div key={a + b} className="app-ib__skelrow">
          <div className="mg-skel" /><div className="mg-skel" style={{ height: 12, width: a }} /><div className="mg-skel" style={{ height: 12, width: '92%' }} /><div className="mg-skel" style={{ height: 10, width: b }} />
        </div>
      ))}
    </div>
  );
}

function KeysButton() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="mg-iconbtn max-[719px]:hidden" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" style={{ flex: 'none' }}>
          <Keyboard className="size-[18px]" strokeWidth={1.8} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] p-2" aria-label="Keyboard shortcuts">
        <div className="app-keys">
          <h2 className="mg-panel__title" style={{ padding: '6px 10px' }}>Keyboard shortcuts</h2>
          {KEYS.map(([what, keys]) => (
            <div key={what} className="app-keys__row"><span>{what}</span><span>{keys.map((k) => <span key={k} className="mg-kbd">{k}</span>)}</span></div>
          ))}
          <p className="app-pop-note">The arrows open each conversation as they reach it, and opening one marks it read for the team.</p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'all';
  const { isAdmin } = useAuth();
  /**
   * Where the list is looking: the team's triage queue (one team inbox
   * with ?inbox=, or all of them), or one folder of one mailbox
   * (?mb=<accountId>&f=<folderId>, ?t= the conversation open in it). The
   * team view keeps ?view= and ?c=. The search is ?q=.
   */
  const mb = params.get('mb');
  const f = params.get('f');
  const inboxId = params.get('inbox');
  const folderView = Boolean(mb && f);
  const selectKey = folderView ? 't' : 'c';
  const selected = params.get(selectKey);
  const q = params.get('q') || '';
  const unreadOnly = params.get('unread') === '1';
  const flaggedOnly = params.get('flagged') === '1';
  const page = Math.max(1, Number.parseInt(params.get('p'), 10) || 1);
  const summary = useFetch(() => (folderView ? Promise.resolve(null) : api.raw('/inbox/summary')), [view, selected, folderView]);
  // The mailboxes this person may read, with Outlook's folders and unread counts, for the switcher.
  const mailboxes = useFetch(() => api.raw('/mail/mailboxes'), []);
  const boxes = mailboxes.data?.data ?? [];
  const teams = teamInboxes(boxes);
  const team = teams.find((t) => String(t.id) === inboxId) || null;
  const teamQuery = `${q ? `&q=${encodeURIComponent(q)}` : ''}${inboxId ? `&inbox_id=${encodeURIComponent(inboxId)}` : ''}`;
  const listUrl = folderView
    ? `/mail/folders/${encodeURIComponent(mb)}/${encodeURIComponent(f)}/messages?${new URLSearchParams({ ...(q ? { q } : {}), ...(unreadOnly ? { unread: '1' } : {}), ...(flaggedOnly ? { flagged: '1' } : {}), page: String(page), page_size: String(PAGE_SIZE) })}`
    : `${view === 'closed' ? '/inbox?view=all&status=closed' : `/inbox?view=${view}`}${teamQuery}&page=${page}&page_size=${PAGE_SIZE}`;
  const list = useFetch(() => (view === 'setup' ? Promise.resolve({ data: [] }) : api.raw(listUrl)), [listUrl]);
  const s = summary.data?.data;
  const putMany = (changes) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) { if (v) n.set(k, v); else n.delete(k); }
    setParams(n, { replace: true });
  };
  const put = (k, v) => putMany({ [k]: v });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const rowRefs = useRef([]);
  const listRef = useRef(null);
  const searchRef = useRef(null);
  const panesRef = useRef(null);
  const at = rows.findIndex((r) => String(r.id) === selected);
  // A Sent Items row leads with who it went to; every other folder with who it is from.
  const outboundFolder = meta?.folder?.well_known === 'sentitems';
  const currentBox = folderView ? boxes.find((b) => String(b.id) === mb) : null;
  const currentFolder = currentBox?.folders?.find((x) => x.folder_id === f || x.well_known === f);
  const notSetUp = !folderView && mailboxes.data && !teams.length;

  /** Switch mailbox, folder or team inbox. Each starts afresh: no search, page 1, nothing selected. */
  const switchTo = (target) => {
    const n = new URLSearchParams();
    if (target.kind === 'folder') { n.set('mb', String(target.accountId)); n.set('f', String(target.folderId)); }
    else if (target.inboxId) n.set('inbox', String(target.inboxId));
    setParams(n, { replace: true });
    rowRefs.current = [];
    listRef.current?.scrollTo({ top: 0 });
  };

  /**
   * New mail arrives without anybody asking for it: the page asks for a
   * pull when it opens and every minute after, and re-reads the list, the
   * counts and the open thread every 20 seconds, only while the tab is
   * visible.
   */
  const [tick, setTick] = useState(0);
  // Past page 1 the rows stay put: re-reading page 2 after new mail would slide rows between pages.
  const onFirstPage = useRef(page === 1);
  onFirstPage.current = page === 1;
  const { refetch: refetchList } = list;
  const { refetch: refetchSummary } = summary;
  const { refetch: refetchMailboxes } = mailboxes;
  useEffect(() => {
    if (view === 'setup') return undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const pull = () => { if (visible()) api.action('/inbox/sync', {}).catch(() => {}); };
    const refresh = () => { if (!visible()) return; if (onFirstPage.current) refetchList(); refetchSummary(); refetchMailboxes(); setTick((n) => n + 1); };
    const onVisible = () => { if (visible()) { pull(); refresh(); } };
    pull();
    const pulling = setInterval(pull, SYNC_EVERY_MS);
    const refreshing = setInterval(refresh, REFRESH_EVERY_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(pulling); clearInterval(refreshing); document.removeEventListener('visibilitychange', onVisible); };
  }, [view, refetchList, refetchSummary, refetchMailboxes]);

  // A page that no longer exists goes to the last one that does.
  useEffect(() => {
    if (meta && page > meta.pages) put('p', meta.pages > 1 ? String(meta.pages) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.pages, page]);

  /** Up and down move through the list and open; Home and End jump to the ends. */
  const onListKey = useCallback((event) => {
    const keys = { ArrowDown: 1, ArrowUp: -1 };
    let next = null;
    if (event.key in keys) next = Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at) + keys[event.key]));
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    if (next === null || !rows[next]) return;
    event.preventDefault();
    put(selectKey, String(rows[next].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, at, selectKey]);

  // Focus follows the selection, only from inside the list: a thread
  // arriving above the selected one must not pull focus out of the reply box.
  useEffect(() => {
    if (at < 0 || !listRef.current?.contains(document.activeElement)) return;
    rowRefs.current[at]?.focus({ preventScroll: false });
  }, [at]);

  // "/" searches; Esc goes back to the list from a conversation.
  useEffect(() => {
    if (view === 'setup') return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || dialogOpen()) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === 'Escape' && selected) { put(selectKey, null); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selected, selectKey, params]);

  // The two panes fill the window under the header, down to the dock.
  useLayoutEffect(() => {
    const el = panesRef.current;
    if (!el) return undefined;
    const set = () => el.style.setProperty('--ib-top', `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`);
    set();
    window.addEventListener('resize', set);
    return () => window.removeEventListener('resize', set);
  });

  if (view === 'setup') return <InboxSetup onBack={() => setParams(new URLSearchParams(), { replace: true })} />;

  const title = selectionLabel(folderView ? { kind: 'folder', accountId: mb, folderId: f } : { kind: 'team', inboxId }, boxes);
  const filtered = folderView && (unreadOnly || flaggedOnly);

  let sub;
  if (folderView) {
    sub = outboundFolder || currentFolder?.well_known === 'sentitems'
      ? 'What was sent from this mailbox, as Outlook has it. Read only here.'
      : `${currentFolder?.unread_count ? `${currentFolder.unread_count} unread in Outlook. ` : ''}A read-only copy: what you read, flag or move in Outlook shows here within a minute.`;
  } else if (notSetUp) {
    sub = isAdmin ? 'No team inbox is set up yet. Set one up to share the sales mailbox with the team.' : 'No team inbox is set up yet. Your own mailbox is in the switcher.';
  } else if (list.error) {
    sub = 'The conversations couldn’t be loaded just now.';
  } else if (!list.data) {
    sub = 'Loading the conversations…';
  } else if (view === 'mine') {
    sub = `${team ? meta?.total ?? 0 : s?.mine ?? meta?.total ?? 0} assigned to you. Replying to a conversation with no owner makes it yours.`;
  } else if (view === 'closed') {
    sub = `${meta?.total ?? 0} closed. Search looks through closed conversations too.`;
  } else if (team || !s) {
    sub = `${meta?.total ?? 0} open${team ? ` in ${team.name}` : ''}. New mail lands here within a minute while this page is open.`;
  } else {
    sub = `${s.open} open${s.overdue ? `, ${s.overdue} past their reply time` : ''}. New mail lands here within a minute while this page is open.`;
  }

  const viewAt = Math.max(0, VIEWS.findIndex((v) => v.key === view));
  const views = !folderView && (
    <div className="mg-seg app-ib-views" role="radiogroup" aria-label="Which conversations" style={{ '--seg-w': `${SEG_W}px`, '--seg-x': `${viewAt * SEG_W}px` }}>
      <span className="mg-seg__thumb" aria-hidden="true" />
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          role="radio"
          aria-checked={view === v.key}
          onClick={() => { const n = new URLSearchParams(); n.set('view', v.key); if (inboxId) n.set('inbox', inboxId); setParams(n, { replace: true }); }}
        >
          {v.label}{v.count && s && !team ? ` ${s[v.count]}` : ''}
        </button>
      ))}
    </div>
  );

  const emptyState = () => {
    if (notSetUp) {
      return (
        <PaneState
          title="No team inbox yet"
          text={isAdmin ? 'Connect the shared sales mailbox under Settings › Mailboxes, then turn it into an inbox here.' : 'An admin turns the shared sales mailbox into an inbox. Until then, your own mail is under My mailbox in the switcher.'}
          action={isAdmin && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setParams({ view: 'setup' }, { replace: true })}>Set up an inbox</button>}
        />
      );
    }
    if (q) {
      return (
        <PaneState
          icon={Search}
          title="Nothing matches"
          text={`No conversation here matches “${q}”. Search looks at the subject, the sender and the company.`}
          action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => putMany({ q: null, p: null })}>Clear search</button>}
        />
      );
    }
    if (filtered) {
      return (
        <PaneState
          icon={Filter}
          title="Nothing matches"
          text={`Nothing in this folder is ${unreadOnly && flaggedOnly ? 'unread and flagged' : unreadOnly ? 'unread' : 'flagged'}. Clear the filter to see the whole folder.`}
          action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => putMany({ unread: null, flagged: null, p: null })}>Clear the filter</button>}
        />
      );
    }
    if (folderView) return <PaneState icon={Check} title="Nothing in this folder" text="Mail in this folder appears here after the next sync, within a minute or so." />;
    return {
      mine: <PaneState icon={Check} title="Nothing is assigned to you" text="Conversations you reply to, or that someone gives you as owner, show here." />,
      closed: <PaneState icon={Check} title="Nothing closed yet" text="Conversations you close move here and stay searchable." />,
    }[view] || <PaneState icon={Check} title="Nothing waiting" text={`New email to ${team?.email || teams[0]?.email || 'a shared mailbox'} lands here on its own, within a minute or so.`} />;
  };

  const chip = (label, key, on) => (
    <button key={key} type="button" className="mg-chip" aria-pressed={on} onClick={() => putMany({ [key]: on ? null : '1', p: null })}>{label}</button>
  );

  return (
    <div className={cn('app-ib-page', selected && 'has-sel')}>
      <PageHeader
        eyebrow={folderView ? 'Inbox · mailbox folder' : 'Inbox · team queue'}
        title={title}
        titleClassName="mg-display"
        titleAside={(
          <MailboxSwitcher
            mailboxes={boxes}
            value={folderView ? { kind: 'folder', accountId: mb, folderId: f } : { kind: 'team', inboxId }}
            onChange={switchTo}
            teamCount={!folderView && view === 'all' && meta ? meta.total : (s?.open || 0)}
          />
        )}
        subtitle={<span aria-live="polite">{sub}</span>}
        actions={<>
          {views}
          {/* Admin-only, because only an admin can act on it. */}
          {isAdmin && !folderView && (
            <button type="button" className="mg-btn" aria-label="Set up inboxes and canned responses" onClick={() => setParams({ view: 'setup' }, { replace: true })}>
              <SlidersHorizontal className="size-4" strokeWidth={1.8} aria-hidden="true" />Set up
            </button>
          )}
        </>}
      />

      <div className="app-ib">
        <div ref={panesRef} className={cn('app-ib__panes', selected && 'has-sel')}>
          {/* The list. */}
          <div className="app-ib__pane app-ib__pane--list">
            <section className="mg-glass mg-glass--strong app-ib__glass" data-a="rise" aria-label={`Conversations in ${title}`}>
              <div className="app-ib__tools">
                <div className="app-ib__toolrow">
                  <label className="mg-search">
                    <Search strokeWidth={1.8} aria-hidden="true" />
                    <input
                      ref={searchRef}
                      className="mg-input"
                      type="search"
                      aria-label={folderView ? 'Search this folder' : 'Search conversations'}
                      aria-keyshortcuts="/"
                      placeholder={folderView ? 'Search subject, people, company' : 'Search subject, sender, company'}
                      value={q}
                      onChange={(e) => putMany({ q: e.target.value, p: null })}
                    />
                  </label>
                  <KeysButton />
                </div>
                {folderView && (
                  <div className="app-ib__filters">
                    {chip('Unread', 'unread', unreadOnly)}
                    {chip('Flagged', 'flagged', flaggedOnly)}
                    {currentFolder?.unread_count > 0 && <span className="app-ib__count">{currentFolder.unread_count} unread</span>}
                  </div>
                )}
              </div>

              {list.loading && !list.data ? <ListSkeleton />
                : list.error ? (
                  <PaneState
                    tone="late"
                    title={folderView ? 'Couldn’t load this folder' : 'Couldn’t load the conversations'}
                    text={`${list.error}. New mail is still being collected; nothing is lost.`}
                    action={<button type="button" className="mg-btn mg-btn--sm" onClick={list.refetch}>Try again</button>}
                  />
                ) : rows.length === 0 ? emptyState() : (
                  <div ref={listRef} role="listbox" aria-label="Conversations" onKeyDown={onListKey} className="app-ib__rows">
                    {rows.map((row, i) => (folderView ? (
                      <MessageRow
                        key={row.id}
                        ref={(node) => { rowRefs.current[i] = node; }}
                        row={row}
                        outbound={outboundFolder}
                        selected={String(row.id) === selected}
                        onSelect={(r) => put('t', String(r.id))}
                      />
                    ) : (
                      <ThreadRow
                        key={row.id}
                        ref={(node) => { rowRefs.current[i] = node; }}
                        row={row}
                        selected={String(row.id) === selected}
                        onSelect={(r) => put('c', String(r.id))}
                      />
                    )))}
                  </div>
                )}

              {meta && meta.total > 0 && !list.error && (
                <Pager
                  page={Math.min(page, meta.pages)}
                  pages={meta.pages}
                  total={meta.total}
                  pageSize={meta.page_size}
                  onPage={(n) => {
                    rowRefs.current = [];
                    listRef.current?.scrollTo({ top: 0 });
                    put('p', n > 1 ? String(n) : null);
                  }}
                />
              )}
            </section>
          </div>

          {/* The conversation. On a narrow window it takes the pane, and the back link returns to the list. */}
          <div className="app-ib__pane app-ib__pane--thread">
            <section className="mg-glass mg-glass--strong app-ib__glass" data-a="rise" aria-label="Conversation">
              {selected && folderView ? (
                <ReadingPane threadId={selected} refreshKey={tick} onBack={() => put('t', null)} />
              ) : selected ? (
                <Conversation
                  id={selected}
                  refreshKey={tick}
                  onBack={() => put('c', null)}
                  onChanged={() => { list.refetch(); summary.refetch(); }}
                />
              ) : (
                <PaneState
                  title="Pick a conversation"
                  text={folderView
                    ? `${currentBox ? (currentBox.mine ? 'Your mailbox' : currentBox.email) : 'This mailbox'}, as Outlook has it. What is read, flagged or moved there shows here within a minute.`
                    : notSetUp ? 'Conversations appear here once a team inbox is set up.' : 'Its emails, the company it matches and the reply box open here.'}
                />
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "Meera" from "Meera Iyer (portal)". */
const firstName = (c) => String(c.contact_name || c.from_name || '').replace(/\s*\(portal\)\s*$/i, '').trim();

function Conversation({ id, refreshKey = 0, onBack, onChanged }) {
  const toast = useToast();
  const lookups = useLookups();
  // refreshKey is the page's poll: a reply that arrives while the thread is open shows up in it.
  const conv = useFetch(() => api.raw(`/inbox/${id}`), [id, refreshKey]);
  const c = conv.data?.data;
  const thread = useFetch(() => (c ? api.raw(`/mail/threads/${c.thread_id}`) : Promise.resolve(null)), [c?.thread_id, c?.message_count]);
  const canned = useFetch(() => api.raw('/inbox/canned'));
  const [body, setBody] = useState('');
  // Closed on arrival, and closed again whenever the thread changes: a draft belongs to its conversation.
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const draftRef = useRef(null);

  useEffect(() => { setComposing(false); setBody(''); }, [id]);

  /**
   * Opening a thread is what marks it read (the server does that on the
   * fetch above), so the row keeps its dot until somebody tells the list:
   * once per thread, and only for one that was unread.
   */
  const announced = useRef(null);
  useEffect(() => {
    if (c?.unread && announced.current !== id) {
      announced.current = id;
      onChanged();
    }
  }, [c?.unread, id, onChanged]);

  async function update(patch, ok, undo) {
    setBusy(true);
    try {
      await api.raw(`/inbox/${id}`, { method: 'PATCH', body: patch });
      if (ok) {
        if (undo) {
          sonnerToast.success(ok, {
            action: {
              label: 'Undo',
              onClick: () => api.raw(`/inbox/${id}`, { method: 'PATCH', body: undo }).then(() => { conv.refetch(); onChanged(); }).catch((err) => toast(err.message, 'danger')),
            },
          });
        } else toast(ok, 'success');
      }
      conv.refetch(); onChanged();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function reply(close) {
    setBusy(true);
    try {
      await api.action(`/inbox/${id}/reply`, { body, close });
      toast(close ? 'Reply sent and closed' : 'Reply sent', 'success');
      setBody(''); setComposing(false); conv.refetch(); thread.refetch(); onChanged();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const status = c?.status;
  const close = () => update({ status: 'closed' }, 'Closed', { status: status || 'open' });
  const notAnEnquiry = () => update({ status: 'closed' }, 'Closed as not an enquiry', { status: 'open' });

  // R reply, E close, S snooze — while the conversation is open and nothing is being typed.
  useEffect(() => {
    if (!c) return undefined;
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || dialogOpen() || busy) return;
      const k = e.key.toLowerCase();
      if (k === 'r') { e.preventDefault(); setComposing(true); }
      else if (k === 'e' && status !== 'closed') { e.preventDefault(); close(); }
      else if (k === 's' && status === 'open') { e.preventDefault(); setSnoozing(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  /** A canned response goes in at the cursor and never replaces the draft; the contact's and company's names are filled in. */
  const fill = (text) => text
    .replace(/\{\{\s*contact_name\s*\}\}/g, c.contact_name || c.from_name || 'Sir/Madam')
    .replace(/\{\{\s*company_name\s*\}\}/g, c.company_name || '');
  function insertCanned(x) {
    const text = fill(x.body);
    const el = draftRef.current;
    const at = el && document.activeElement === el ? el.selectionStart : body.length;
    const before = body.slice(0, at);
    const after = body.slice(at);
    const glue = before && !/\n\n$/.test(before) ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    setBody(`${before}${glue}${text}${after}`);
    setComposing(true);
    requestAnimationFrame(() => {
      const box = draftRef.current;
      if (!box) return;
      const pos = before.length + glue.length + text.length;
      box.focus(); box.setSelectionRange(pos, pos);
    });
  }

  if (conv.error) {
    return conv.errorStatus === 404 ? (
      <PaneState
        tone="late"
        icon={Lock}
        title="You can’t open this conversation"
        text="It is in an inbox you are not a member of, or it was removed. Ask an admin to add you to that inbox if you need it."
        action={<button type="button" className="mg-btn mg-btn--sm" onClick={onBack}>Back to the list</button>}
      />
    ) : (
      <PaneState tone="late" title="Couldn’t open this conversation" text={conv.error} action={<button type="button" className="mg-btn mg-btn--sm" onClick={conv.refetch}>Try again</button>} />
    );
  }
  if (!c) return <PaneLoading />;
  const t = thread.data?.data;
  const newestLink = t ? [...t.messages].reverse().find((m) => m.web_link)?.web_link : null;
  const people = [...new Set([...(lookups.sales_people || []), ...(c.assignee ? [c.assignee] : [])])];
  const name = firstName(c) || c.from_email;
  const due = c.response_due_at ? when(c.response_due_at) : null;
  const overdue = status === 'open' && c.response_due_at && new Date(c.response_due_at) < new Date();

  const badges = [];
  if (status === 'closed') badges.push([`Closed${c.closed_at ? ` ${when(c.closed_at)}` : ''}`, 'mg-badge--plain']);
  else if (status === 'snoozed') badges.push([`Snoozed${c.snoozed_until ? ` until ${when(c.snoozed_until)}` : ''}`, 'mg-badge--info']);
  else if (status === 'pending_client') badges.push(['Waiting on the client', 'mg-badge--info']);
  else if (overdue) badges.push([`Overdue · reply was due ${due}`, 'mg-badge--late']);
  else badges.push([due ? `Open · reply due ${due}` : 'Open', 'mg-badge--wait']);
  badges.push([`${c.message_count || 1} message${c.message_count === 1 ? '' : 's'}`, 'mg-badge--plain']);

  // The banner names the button the same as the dialog it opens.
  const sugg = c.suggestion;
  const suggTone = sugg?.kind === 'unknown_company' ? '' : 'mg-banner--wait';
  const suggBtn = sugg?.kind === 'open_deal' ? 'Create enquiry anyway' : 'Create enquiry';

  const more = [
    !c.enquiry_no && !c.entity_id && !c.entity && status !== 'closed' && { label: 'Create an enquiry from this email', icon: Plus, onSelect: () => setConverting(true) },
    status !== 'closed' && { label: 'Close as not an enquiry', icon: Check, onSelect: notAnEnquiry },
    status === 'open' && { label: 'Snooze', icon: Clock, onSelect: () => setSnoozing(true) },
    {
      label: 'Copy a link to this conversation',
      icon: Copy,
      onSelect: () => {
        const url = `${window.location.origin}/inbox?c=${encodeURIComponent(id)}`;
        Promise.resolve(navigator.clipboard?.writeText(url)).then(() => toast('Link copied', 'success'), () => toast(url, 'info'));
      },
    },
    newestLink && { label: 'Open in Outlook', icon: ExternalLink, onSelect: () => window.open(newestLink, '_blank', 'noopener,noreferrer') },
  ];

  return (
    <>
      <div className="app-ib__head">
        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm app-ib__back" onClick={onBack} aria-keyshortcuts="Escape" style={{ alignSelf: 'flex-start', marginLeft: -10 }}>
          <ArrowLeft className="size-4" strokeWidth={2} aria-hidden="true" />All conversations
        </button>
        <div className="app-ib__titlerow">
          <div className="app-ib__titles">
            <h2>{c.subject || '(no subject)'}</h2>
            <div className="app-ib__badges">{badges.map(([label, tone]) => <span key={label} className={cn('mg-badge', tone)}>{label}</span>)}</div>
          </div>
          {/* The things done to a conversation, on the subject's line. */}
          <div className="app-ib__acts">
            {status === 'closed' ? (
              <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => update({ status: 'open' }, 'Reopened')}>
                <RotateCcw className="size-4" strokeWidth={1.8} aria-hidden="true" />Reopen
              </button>
            ) : (
              <>
                {status === 'snoozed' && (
                  <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => update({ status: 'open' }, 'Back in Open')}>
                    <Clock className="size-4" strokeWidth={1.8} aria-hidden="true" />Bring back now
                  </button>
                )}
                <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={close} aria-keyshortcuts="E">
                  <Check className="size-4" strokeWidth={2} aria-hidden="true" />Close
                </button>
                {status !== 'snoozed' && (
                  <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setSnoozing(true)} aria-keyshortcuts="S">
                    <Clock className="size-4" strokeWidth={1.8} aria-hidden="true" />Snooze
                  </button>
                )}
              </>
            )}
            <MoreMenu label="More for this conversation" size="sm" items={more} />
          </div>
        </div>
        <p className="app-ib__meta">
          <span title={c.from_email}>{c.from_name ? `${c.from_name} <${c.from_email}>` : c.from_email}</span>
          {/* Which of our addresses it came to: it decides who the reply is from. */}
          {c.inbox_email && <span>to {c.inbox_email.split('@')[0]}@</span>}
          {c.company_name ? <span><Link to={`/companies/${c.company_id}`}>{c.company_name}</Link></span> : <span className="text-muted-foreground">No company on file</span>}
          {c.enquiry_no && <span><Link to={`/enquiries?q=${encodeURIComponent(c.enquiry_no)}`}>{c.enquiry_no}</Link></span>}
        </p>
        <div className="app-ib__owner">
          <label htmlFor={`owner-${c.id}`} className="mg-label">Owner</label>
          <span className="mg-select-wrap">
            <select
              id={`owner-${c.id}`}
              className="mg-select"
              aria-label="Owner"
              value={c.assignee || ''}
              disabled={busy}
              onChange={(e) => update({ assignee: e.target.value || null }, e.target.value ? `Owner is now ${e.target.value}` : 'Owner removed')}
            >
              <option value="">Nobody (unassigned)</option>
              {people.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </span>
          <span>Saved as soon as you pick. Mine lists what is yours.</span>
        </div>
      </div>

      <div className="app-ib__body">
        {/* One banner, one button: what the tracker found, and the single thing that follows. */}
        {sugg && (
          <div className={cn('mg-banner', suggTone)} role="note">
            <Lightbulb strokeWidth={1.8} aria-hidden="true" />
            <div className="mg-banner__body"><strong>{sugg.headline}</strong>{sugg.detail}</div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setConverting(true)}>{suggBtn}</button>
              <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" disabled={busy} onClick={notAnEnquiry}>Not an enquiry</button>
            </div>
          </div>
        )}
        {thread.error ? (
          <p className="app-msg__note" role="alert">The messages couldn’t be loaded: {thread.error}</p>
        ) : !t ? <div className="mg-skel" style={{ height: 120 }} aria-label="Loading the messages" /> : (
          <>
            {t.visibility !== 'share_everything' && !t.messages.some((m) => m.can_read_live) && (
              <div className="mg-banner" role="note">
                <Lock strokeWidth={1.8} aria-hidden="true" />
                <div className="mg-banner__body">The mailbox shares {t.visibility === 'subject' ? 'subjects only' : 'only who and when'}; the text stays in Outlook.</div>
              </div>
            )}
            {t.messages.map((m, i) => (
              <Message key={m.id} m={m} openByDefault={i >= t.messages.length - 1 || t.messages.length <= 2} />
            ))}
          </>
        )}
      </div>

      {/* Reply, docked at the foot. Reading is the common case, so it is a prompt until it is wanted. */}
      <div className="app-ib__foot">
        {!composing ? (
          <div className="app-ib__prompt">
            <button type="button" onClick={() => setComposing(true)} aria-keyshortcuts="R">Reply to {name}…</button>
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => setComposing(true)}>
              <Reply className="size-4" strokeWidth={2} aria-hidden="true" />Reply
            </button>
          </div>
        ) : (
          <>
            <div className="app-ib__composehead">
              <label htmlFor={`reply-${c.id}`}>Reply from {c.inbox_email || 'the shared address'}</label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="mg-btn mg-btn--sm"><FilePlus className="size-4" strokeWidth={1.8} aria-hidden="true" />Insert a canned response</button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="max-h-[60vh] overflow-y-auto" aria-label="Canned responses">
                  <DropdownMenuLabel>Canned responses</DropdownMenuLabel>
                  {(canned.data?.data ?? []).map((x) => (
                    <DropdownMenuItem key={x.id} className="app-canned" onSelect={() => insertCanned(x)}>
                      <span>{x.name}</span>
                      <span>{fill(x.body).replace(/\{\{\s*my_name\s*\}\}/g, 'your name').replace(/\s+/g, ' ').slice(0, 90)}</span>
                    </DropdownMenuItem>
                  ))}
                  {!(canned.data?.data ?? []).length && <DropdownMenuItem disabled>No canned responses yet</DropdownMenuItem>}
                  <p className="app-pop-note">Added where your cursor is; your draft stays. The contact’s name is filled in.</p>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <textarea
              id={`reply-${c.id}`}
              ref={draftRef}
              className="mg-textarea"
              autoFocus
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your reply"
              style={{ minHeight: 112 }}
            />
            <p className="app-ib__hint">The inbox signature is added when it goes, and {'{{my_name}}'} becomes your name. Replying makes you the owner if nobody is.</p>
            <div className="app-ib__sendrow">
              <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !body.trim()} onClick={() => reply(false)}>
                <Send className="size-4" strokeWidth={1.8} aria-hidden="true" />{busy ? 'Sending…' : 'Send'}
              </button>
              <button type="button" className="mg-btn" disabled={busy || !body.trim()} onClick={() => reply(true)}>Send and close</button>
              <button type="button" className="mg-btn mg-btn--ghost" disabled={busy} onClick={() => { setComposing(false); setBody(''); }}>
                <X className="size-4" strokeWidth={1.8} aria-hidden="true" />Discard draft
              </button>
            </div>
          </>
        )}
      </div>

      {converting && (
        <ConvertDialog
          c={c}
          people={people}
          sources={lookups.lead_sources || []}
          sentAt={t?.messages?.[0]?.sent_at}
          onClose={() => setConverting(false)}
          onDone={() => { setConverting(false); conv.refetch(); onChanged(); }}
        />
      )}
      {snoozing && (
        <SnoozeDialog
          onClose={() => setSnoozing(false)}
          onSnooze={(until) => { setSnoozing(false); update({ status: 'snoozed', snoozed_until: until }, `Snoozed until ${when(until)}`, { status: 'open' }); }}
        />
      )}
    </>
  );
}

