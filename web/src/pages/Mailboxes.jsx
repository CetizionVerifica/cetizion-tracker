import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Info, Mail, RefreshCw, Settings2, Unplug, UserRound, X } from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, Field, Modal, useToast } from '../components/ui.jsx';
import { MoreMenu } from '../components/sales.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { AutoEntryPanel } from '../components/AutoEntryPanel.jsx';
import { DailyMisNotice, useMyDailyMis } from '../components/MyDailyMis.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ago, date, number } from '../lib/format.js';
import { useAuth } from '../lib/auth.jsx';

/**
 * Connected mailboxes (#29), in Mocha Glass (Wave 4).
 *
 * The broken mailbox is the row that gets colour, the reason is written
 * underneath it in a sentence, and the fix is one button. The visibility
 * choice stays inline on the row, because it is the one privacy decision a
 * sales user makes for themselves and it should cost one click to change.
 * Under about 860px of pane the table becomes stacked rows, so a tablet
 * still sees the actions.
 */
const VIS = [
  { value: 'metadata', label: 'Who and when only' },
  { value: 'subject', label: 'Subject only' },
  { value: 'share_everything', label: 'Everything' },
];
const VIS_RANK = { metadata: 0, subject: 1, share_everything: 2 };
const visLabel = (v) => VIS.find((x) => x.value === v)?.label || v;

/** How wide an element is, kept current; returns a callback ref and the width. */
function useWidth() {
  const [node, setNode] = useState(null);
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1200 : window.innerWidth - 480));
  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(node);
    setW(node.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, w];
}

function Spinner() {
  return <span className="app-spin" aria-hidden="true" />;
}

export default function Mailboxes() {
  const toast = useToast();
  // The same pane for both roles, showing different things: the server
  // lists only the mailboxes this person may read; the team-wide controls
  // are the admin's (docs/per-user-mailboxes-plan.md §5).
  const { isAdmin, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/mailboxes'));
  const myMis = useMyDailyMis();
  const block = useFetch(() => (isAdmin ? api.raw('/mailboxes/blocklist') : Promise.resolve(null)), [isAdmin]);
  const people = useFetch(() => (isAdmin ? api.users.list() : Promise.resolve(null)), [isAdmin]);
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  const [tuning, setTuning] = useState(null);
  const [rereading, setRereading] = useState(null);
  const [reowning, setReowning] = useState(null);
  const [lowering, setLowering] = useState(null);
  const [panelRef, panelW] = useWidth();
  const wide = panelW >= 860;

  const all = data?.data ?? [];
  // A salesperson's list is their own mailbox(es); the shared one is the team's to run.
  const rows = isAdmin ? all : all.filter((r) => !r.is_shared);
  const cfg = data?.configured;
  const blocked = block.data?.data ?? [];
  const users = (people.data?.data ?? []).filter((u) => u.active && u.email);

  /** `what` is running, not only where: a sync or a re-read is minutes against a mailbox that looks idle. */
  async function run(id, fn, ok, what = 'Working…') {
    setBusy({ id, what });
    try { const r = await fn(); if (ok) toast(ok(r), 'success'); refetch(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(null); }
  }
  const doing = (id) => (busy?.id === id ? busy.what : null);
  const patch = (id, body) => run(id, () => api.raw(`/mailboxes/${id}`, { method: 'PATCH', body }), () => 'Saved');

  /** Storing less removes what is already stored beyond it (E-9), so that asks first. */
  function setVisibility(row, value) {
    if (value === row.visibility) return;
    if (VIS_RANK[value] < VIS_RANK[row.visibility]) setLowering({ row, value });
    else patch(row.id, { visibility: value });
  }

  // Fires once, then clears the parameter so a refresh does not re-announce it.
  const connected = params.get('connected');
  const announced = useRef(false);
  useEffect(() => {
    if (!connected || announced.current) return;
    announced.current = true;
    toast(`Connected ${connected}. The first sync is running.`, 'success');
    const next = new URLSearchParams(params);
    next.delete('connected');
    setParams(next, { replace: true });
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const connectUrl = (shared) => (cfg?.microsoft ? `/api/mailboxes/connect/microsoft${shared ? '?shared=1' : ''}` : undefined);
  const oauthError = params.get('error');
  const dismissError = () => { const next = new URLSearchParams(params); next.delete('error'); setParams(next, { replace: true }); };

  /**
   * What a sync actually did: zero and zero-because are different answers,
   * and only one of them tells somebody what to change.
   */
  function syncResult(x) {
    if (x.data.skipped === 'already syncing') return 'Already syncing — new mail appears in a moment.';
    if (typeof x.data.skipped === 'string') return `Not synced: ${x.data.skipped}`;
    const stored = Number(x.data.stored || 0);
    const skipped = Object.entries(x.data.skipped || {}).filter(([, n]) => n > 0);
    const head = `${number(stored)} new email${stored === 1 ? '' : 's'}`;
    if (!skipped.length) return head;
    return `${head} · skipped ${skipped.map(([why, n]) => `${n} ${why}`).join(', ')}`;
  }

  /** What a re-read did: whether it found anything, and if not, why. */
  function rereadResult(x) {
    const { updated = 0, seen = 0, messages_held: held = 0 } = x.data || {};
    if (!seen) return 'The mailbox returned nothing for that window — try more days, or reconnect it.';
    if (!updated) return `Nothing to update — the ${number(seen)} message${seen === 1 ? '' : 's'} it re-read are already current.`;
    return `${number(updated)} of ${number(held)} stored message${held === 1 ? '' : 's'} rewritten with the sender's own styling.`;
  }

  /** The "Mail" column's second line: mostly whether it is still running. */
  function syncedLine(row) {
    if (row.status === 'needs_reconnect') { const w = ago(row.last_synced_at); return w ? `stopped ${w}` : 'stopped'; }
    if (row.status === 'disconnected') return 'disconnected';
    const w = ago(row.last_synced_at);
    if (cfg?.webhook) return `live, via webhook · ${w ? `synced ${w}` : 'never synced'}`;
    return w ? `synced ${w}` : 'never synced';
  }

  /** Who the mailbox is for, then the provider and the history window. */
  function subLine(row) {
    const who = !row.is_shared
      ? (row.owner ? (isAdmin ? `${row.owner.name}'s` : 'Yours') : 'Unassigned · an admin sets the owner')
      : row.feeds_inbox ? 'Feeds the Inbox' : 'Shared · no Inbox set up for it yet';
    const warn = (!row.is_shared && !row.owner) || (row.is_shared && !row.feeds_inbox);
    return { text: `${who} · ${row.provider === 'test' ? 'Test' : 'Microsoft 365'}${row.import_days ? ` · ${number(row.import_days)} days of history` : ''}`, warn };
  }

  const banners = [];
  if (oauthError) banners.push({ tone: 'late', role: 'alert', icon: AlertCircle, title: 'Microsoft didn’t connect the mailbox.', text: ` ${oauthError}`, dismiss: dismissError });
  if (cfg && !cfg.microsoft) {
    banners.push({
      tone: 'wait', icon: AlertTriangle,
      title: isAdmin ? 'Microsoft 365 is not set up on this server, so no mailbox can be connected yet.' : 'Microsoft 365 is not set up on this server yet, so no mailbox can be connected.',
      text: isAdmin ? ' The lead registers an app in Microsoft Entra ID and sets the server values listed under Server setup below, which also says which are still missing.' : ' Ask an admin to set it up; then the Connect button works.',
    });
  } else if (isAdmin && cfg?.microsoft && !cfg.webhook) {
    banners.push({ tone: '', icon: Info, title: 'New mail arrives on the regular sweep.', text: ' MAIL_WEBHOOK_URL is not set, so mail is fetched about every minute rather than the moment it lands.' });
  }

  const actionsFor = (row, phone) => {
    const broken = row.status === 'needs_reconnect';
    if (row.status === 'disconnected') return null;
    const canReconnect = row.is_shared || !row.user_id || row.user_id === user?.id;
    const size = phone ? '' : ' mg-btn--sm';
    return (
      <>
        {broken ? (
          canReconnect ? (
            cfg?.microsoft
              ? <a className={`mg-btn mg-btn--primary${size}`} href={connectUrl(row.is_shared)}>Reconnect</a>
              : <button type="button" className={`mg-btn mg-btn--primary${size}`} disabled>Reconnect</button>
          ) : <span className="text-[12.5px] text-muted-foreground" style={{ whiteSpace: 'nowrap' }}>{row.owner?.name} reconnects it</span>
        ) : (
          <button
            type="button"
            className={`mg-btn${size}`}
            disabled={Boolean(doing(row.id))}
            onClick={() => run(row.id, () => api.action(`/mailboxes/${row.id}/sync`), syncResult, 'Fetching new mail…')}
          >
            Sync now
          </button>
        )}
        <MoreMenu
          label={`More actions for ${row.email}`}
          size={phone ? 'md' : 'sm'}
          className={phone ? 'ml-auto' : undefined}
          items={[
            { label: 'What this mailbox syncs…', icon: Settings2, onSelect: () => setTuning(row) },
            { label: 'Re-read stored mail…', icon: RefreshCw, onSelect: () => setRereading(row) },
            isAdmin && !row.is_shared && { label: 'Change owner…', icon: UserRound, onSelect: () => setReowning(row) },
            { label: 'Disconnect this mailbox', icon: Unplug, danger: true, onSelect: () => setDisconnecting(row) },
          ]}
        />
      </>
    );
  };

  const whyLine = (row) => {
    const broken = row.status === 'needs_reconnect';
    if (!broken && !row.last_error) return null;
    return (
      <span className={cn('app-ib-why', !broken && 'is-warn')}>
        <strong>{broken ? 'Why:' : 'Last sync failed:'}</strong>{' '}
        {row.last_error || 'Microsoft stopped accepting the saved sign-in, which usually means the password changed or the permission was withdrawn.'}
        {broken && ' Reconnecting takes one sign-in; nothing already synced is lost.'}
      </span>
    );
  };
  const busyLine = (row) => doing(row.id) && (
    <span role="status" aria-live="polite" className="app-ib-busy"><Spinner />{doing(row.id)}</span>
  );
  const status = (row) => {
    const broken = row.status === 'needs_reconnect';
    return broken ? <span className="mg-badge mg-badge--late">Reconnect</span>
      : row.status === 'active' ? <span className="mg-badge mg-badge--ok">Active</span>
        : <span className="mg-badge mg-badge--plain">{row.status === 'disconnected' ? 'Disconnected' : row.status.replace('_', ' ')}</span>;
  };
  const visSelect = (row, phone) => (
    <span className={phone ? 'mg-select-wrap' : 'mg-select-wrap app-vis'}>
      <select
        className="mg-select"
        aria-label={`What ${isAdmin ? 'the team sees' : 'the tracker stores'} of ${row.email}`}
        value={row.visibility}
        disabled={row.status === 'disconnected' || Boolean(doing(row.id))}
        onChange={(e) => setVisibility(row, e.target.value)}
      >
        {VIS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
      </select>
    </span>
  );
  const chips = (row) => (
    <>
      {row.is_shared && <span className="mg-badge mg-badge--info is-sm" style={{ height: 22, fontSize: 11 }}>Shared</span>}
      {row.provider === 'test' && <span className="mg-badge mg-badge--plain is-sm" style={{ height: 22, fontSize: 11 }}>Test</span>}
    </>
  );

  return (
    <>
      <SettingsPane
        title={isAdmin ? 'Mailboxes' : 'My mailbox'}
        description={isAdmin
          ? 'Client email from a connected mailbox appears on the company, deal and enquiry it belongs to. A personal mailbox is read only by its owner; a shared one by the team. Mail only between colleagues is never synced.'
          : 'Connect your work email so enquiries and replies from your clients appear on your records automatically. Only you see your mail; the records it creates are yours.'}
        actions={<>
          {isAdmin && (cfg?.microsoft
            ? <a className="mg-btn" href={connectUrl(true)}>Connect a shared mailbox</a>
            : <button type="button" className="mg-btn" disabled>Connect a shared mailbox</button>)}
          {cfg?.microsoft
            ? <a className="mg-btn mg-btn--primary" href={connectUrl(false)}>Connect my Microsoft 365 mailbox</a>
            : <button type="button" className="mg-btn mg-btn--primary" disabled>Connect my Microsoft 365 mailbox</button>}
          {isAdmin && cfg?.test_mailboxes && (
            <button
              type="button"
              className="mg-btn mg-btn--ghost"
              title="Only on test servers"
              onClick={() => run('new', () => api.action('/mailboxes/test', { email: `test${Date.now() % 10000}@cetizionverifica.com` }), () => 'Test mailbox added')}
            >
              Add test mailbox
            </button>
          )}
        </>}
      >
        {/* What connecting a personal mailbox means for the daily MIS (§B2). */}
        <DailyMisNotice mine={myMis} always />

        {loading && !data ? (
          <>
            <section className="mg-glass mg-panel" aria-busy="true" aria-label="Loading mailboxes" data-a="rise"><div className="mg-skel" style={{ height: 14, width: '22%' }} /><div className="mg-skel" style={{ height: 12, width: '48%' }} /><div className="mg-skel" style={{ height: 64, marginTop: 8 }} /><div className="mg-skel" style={{ height: 64 }} /></section>
            {isAdmin && <section className="mg-glass mg-panel" aria-busy="true" aria-label="Loading the email readers" data-a="rise"><div className="mg-skel" style={{ height: 14, width: '30%' }} /><div className="mg-skel" style={{ height: 12, width: '72%' }} /></section>}
          </>
        ) : error ? (
          <section className="mg-glass mg-empty" role="alert" data-a="rise">
            <span className="mg-empty__mark app-ib__late-mark"><AlertCircle className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
            <h2 className="mg-empty__title">Couldn’t load the mailboxes</h2>
            <p className="mg-empty__text">{error}. Mailboxes keep syncing in the background; nothing is disconnected.</p>
            <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
          </section>
        ) : (
          <section ref={panelRef} className="mg-glass mg-glass--strong app-ib-panel" data-a="rise" aria-labelledby="sec-mb">
            <div className="app-ib-panel__head" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="app-ib-panel__titles">
                <h2 className="mg-panel__title" id="sec-mb">{isAdmin ? 'Connected mailboxes' : 'Your mailbox'}</h2>
                <p className="mg-panel__hint">Each one syncs on its own about every minute; Sync now fetches new mail at once.</p>
              </div>
              {banners.map((b) => (
                <div key={b.title} className={cn('mg-banner', b.tone && `mg-banner--${b.tone}`)} role={b.role || 'note'} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                  <b.icon strokeWidth={1.8} aria-hidden="true" />
                  <div className="mg-banner__body" style={{ flex: '1 1 200px' }}><strong>{b.title}</strong>{b.text}</div>
                  {b.dismiss && <button type="button" className="mg-iconbtn" aria-label="Dismiss this message" onClick={b.dismiss} style={{ width: 36, height: 36 }}><X className="size-4" strokeWidth={1.8} aria-hidden="true" /></button>}
                </div>
              ))}
            </div>

            {rows.length === 0 ? (
              <div className="mg-empty">
                <span className="mg-empty__mark"><Mail className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
                <h3 className="mg-empty__title">{isAdmin ? 'No mailbox is connected' : 'Your mailbox isn’t connected'}</h3>
                <p className="mg-empty__text">{isAdmin ? 'Connect the shared sales mailbox, or your own, to see client email on the records it belongs to.' : 'Connect it with the button above. It takes one Microsoft sign-in, and you choose what the tracker keeps.'}</p>
              </div>
            ) : wide ? (
              <div className="mg-tablewrap">
                <table className="mg-table" aria-label="Connected mailboxes">
                  <thead><tr><th>Mailbox</th><th>Status</th><th>{isAdmin ? 'Team sees' : 'The tracker stores'}</th><th className="num">Mail</th><th className="actions" aria-label="Actions" /></tr></thead>
                  <tbody>
                    {rows.map((row) => {
                      const sub = subLine(row);
                      const broken = row.status === 'needs_reconnect';
                      return (
                        <tr key={row.id} className={broken ? 'is-broken' : undefined}>
                          <td style={{ whiteSpace: 'normal', minWidth: 240 }}>
                            <span className="flex flex-wrap items-center gap-1.5"><strong style={{ overflowWrap: 'anywhere' }}>{row.email}</strong>{chips(row)}</span>
                            <span className={cn('sub', sub.warn && 'is-warn')}>{sub.text}</span>
                            {whyLine(row)}
                            {busyLine(row)}
                          </td>
                          <td>{status(row)}</td>
                          <td>{visSelect(row, false)}</td>
                          <td className="num"><strong>{number(row.threads)} threads</strong><span className={cn('sub', broken && 'is-late')}>{syncedLine(row)}</span></td>
                          <td className="actions"><span className="inline-flex items-center justify-end gap-1.5">{actionsFor(row, false)}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mg-rows">
                {rows.map((row) => {
                  const sub = subLine(row);
                  const broken = row.status === 'needs_reconnect';
                  return (
                    <div key={row.id} className={cn('mg-row', broken && 'is-broken')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                      <span className="flex flex-wrap items-center gap-1.5"><strong style={{ overflowWrap: 'anywhere' }}>{row.email}</strong>{chips(row)}</span>
                      <span className="text-[12.5px]" style={{ color: sub.warn ? 'var(--wait)' : 'var(--muted)' }}>{sub.text}</span>
                      <span className="flex flex-wrap items-center gap-2">{status(row)}<span className="text-[12.5px]" style={{ color: broken ? 'var(--late)' : 'var(--muted)' }}>{number(row.threads)} threads · {syncedLine(row)}</span></span>
                      {whyLine(row)}
                      {busyLine(row)}
                      <Field label={isAdmin ? 'Team sees' : 'The tracker stores'}>{visSelect(row, true)}</Field>
                      <span className="flex flex-wrap items-center gap-2">{actionsFor(row, true)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="app-ib-panel__foot">
              {isAdmin
                ? <>Shared mailboxes become team inboxes, with owners and a reply clock, under Inbox setup. <Link to="/inbox?view=setup">Open inbox setup</Link></>
                : 'Your colleagues’ mailboxes and the shared sales address are managed by an admin.'}
            </p>
          </section>
        )}

        {!isAdmin && (
          <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="sec-explain">
            <h2 className="mg-panel__title" id="sec-explain">What happens to your mail</h2>
            <p className="m-0 max-w-[820px] text-[13.5px]/[1.6] text-secondary-foreground">
              What the tracker stores is your choice: who and when only, the subjects too, or everything. Whatever you
              choose, the readers that turn client email into enquiries, quotations and purchase orders read your Inbox
              and Sent Items only, unless you open your other folders to them under “What this mailbox syncs”. An admin
              sees that your mailbox is connected, not its mail.
            </p>
          </section>
        )}

        <AutoEnquiries />

        <AutoEntryPanel />

        {isAdmin && (
          <div className="app-ib-pair" data-a="rise">
            <section className="mg-glass mg-glass--strong mg-panel" aria-labelledby="sec-never">
              <div className="flex flex-col gap-1"><h2 className="mg-panel__title" id="sec-never">Never sync</h2><p className="mg-panel__hint m-0">Addresses or whole domains, like newsletters or personal contacts. Robots such as no-reply@ are always skipped.</p></div>
              <form
                className="app-ib-block"
                onSubmit={(e) => {
                  e.preventDefault();
                  run('block', () => api.action('/mailboxes/blocklist', { pattern }), () => 'Added')
                    .then(() => { setPattern(''); block.refetch(); });
                }}
              >
                <input className="mg-input" placeholder="news@vendor.com or vendor.com" aria-label="Address or domain never to sync" value={pattern} onChange={(e) => setPattern(e.target.value)} />
                <button type="submit" className="mg-btn" disabled={!pattern.trim()}>Add</button>
              </form>
              <div className="app-ib-chips">
                {blocked.length === 0 ? <span className="text-[13px] text-muted-foreground">Nothing blocked.</span> : blocked.map((b) => (
                  <span key={b.id} className="mg-chip">
                    {b.pattern}
                    <button type="button" className="mg-iconbtn mg-chip__x" aria-label={`Remove ${b.pattern}`} onClick={() => api.remove('mailboxes/blocklist', b.id).then(block.refetch)}>
                      <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </section>
            <section className="mg-glass mg-glass--strong mg-panel" aria-labelledby="sec-server">
              <h2 className="mg-panel__title" id="sec-server">Server setup</h2>
              <dl className="app-ib-server">
                {[
                  ['Microsoft Entra app', cfg?.microsoft, 'Registered', 'Not registered'],
                  ['Token encryption key', cfg?.token_key, 'Set', 'Not set'],
                  ['Webhook URL', cfg?.webhook, 'Live', 'Not set'],
                ].map(([k, ok, yes, no]) => (
                  <div key={k}><dt>{k}</dt><dd><span className={cn('mg-badge', ok ? 'mg-badge--ok' : 'mg-badge--wait')}>{ok ? yes : no}</span></dd></div>
                ))}
              </dl>
              <p className="app-ib-small">Without the webhook, mail arrives on the regular sweep instead of at once. The server reads MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI, MAIL_TOKEN_KEY and MAIL_WEBHOOK_URL.</p>
            </section>
          </div>
        )}
      </SettingsPane>

      {tuning && (
        <SyncSettingsDialog
          row={tuning}
          isOwner={!tuning.is_shared && tuning.user_id != null && tuning.user_id === user?.id}
          onClose={() => setTuning(null)}
          onSaved={(message) => { setTuning(null); toast(message, 'success'); refetch(); }}
        />
      )}

      {reowning && (
        <ChangeOwnerDialog
          row={reowning}
          users={users}
          onClose={() => setReowning(null)}
          onSaved={(message) => { setReowning(null); toast(message, 'success'); refetch(); }}
        />
      )}

      {lowering && (
        <ConfirmDialog
          tone="normal"
          title={`Store less of ${lowering.row.email}?`}
          message={`From now on the tracker keeps ${visLabel(lowering.value).toLowerCase()} of this mailbox. ${lowering.value === 'metadata' ? 'Subjects and message text' : 'Message text'} already stored ${lowering.value === 'metadata' ? 'are' : 'is'} removed from the tracker now; Outlook keeps everything.`}
          confirmLabel="Store less"
          onClose={() => setLowering(null)}
          onConfirm={() => { const { row, value } = lowering; setLowering(null); patch(row.id, { visibility: value }); }}
        />
      )}
      {rereading && (
        <ConfirmDialog
          tone="normal"
          title={`Re-read stored mail for ${rereading.email}?`}
          message={
            'Mail already in the tracker was stripped of its styling by the old rules, so it is fetched from the mailbox again and stored as it really looks. '
            + 'Only messages already here are updated: nothing new is imported, no conversation is opened or reopened, and a mailbox that shares only metadata still stores no subject and no body. '
            + 'It reads the last 30 days and makes one request per message, so a busy mailbox takes a few minutes. Running it twice is running it once.'
          }
          confirmLabel="Re-read"
          busy={Boolean(doing(rereading.id))}
          onConfirm={async () => {
            const row = rereading;
            setRereading(null);
            await run(row.id, () => api.action(`/mailboxes/${row.id}/refresh-bodies`, { days: 30 }), rereadResult, 'Re-reading stored mail… It carries on if you leave the page.');
          }}
          onClose={() => setRereading(null)}
        />
      )}
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.email}?`}
          message={
            'Stored email bodies are removed; who and when stays on the records. The tracker deletes its subscriptions and destroys its copy of the sign-in tokens. '
            + 'Microsoft has no way for us to cancel the permission itself — to withdraw it, the mailbox’s owner removes Cetizion Tracker at myaccount.microsoft.com › Apps.'
          }
          confirmLabel="Disconnect"
          busy={Boolean(doing(disconnecting.id))}
          onClose={() => setDisconnecting(null)}
          onConfirm={async () => {
            const row = disconnecting;
            setDisconnecting(null);
            await run(row.id, () => api.action(`/mailboxes/${row.id}/disconnect`, { remove_bodies: true }), (x) => `Disconnected — ${x.data.upstream}`, 'Disconnecting…');
          }}
        />
      )}
    </>
  );
}

/** One switch in a bordered box, with what it means under it. */
function Option({ label, checked, onChange, children }) {
  return (
    <div className="app-ib-option">
      <label className="mg-switch">{label}<input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} /></label>
      <span className="text-[12px] text-muted-foreground">{children}</span>
    </div>
  );
}

/**
 * What this mailbox actually pulls in: the history window, colleagues'
 * mail, new contacts, which folders, and (for its owner) sending reports.
 * Set once when the mailbox is connected, and almost never again.
 */
function SyncSettingsDialog({ row, isOwner = false, onClose, onSaved }) {
  const toast = useToast();
  const [days, setDays] = useState(String(row.import_days ?? 30));
  const [internal, setInternal] = useState(!row.exclude_internal);
  const [contacts, setContacts] = useState(Boolean(row.auto_create_contacts));
  const [everyFolder, setEveryFolder] = useState(row.read_scope === 'all');
  // The owner's own decision (mis-report-sender-plan.md §A3).
  const [sendReports, setSendReports] = useState(Boolean(row.may_send_reports));
  const [busy, setBusy] = useState(false);
  const daysChanged = Number(days) !== Number(row.import_days ?? 30);
  const daysBad = days === '' || !Number.isInteger(Number(days)) || Number(days) < 0 || Number(days) > 365;

  async function save() {
    if (daysBad) return;
    setBusy(true);
    try {
      await api.raw(`/mailboxes/${row.id}`, {
        method: 'PATCH',
        body: { import_days: Number(days), exclude_internal: !internal, auto_create_contacts: contacts, read_scope: everyFolder ? 'all' : 'inbox_sent', ...(isOwner ? { may_send_reports: sendReports } : {}) },
      });
      // Changing the window drops the sync cursor, so the older mail only appears on the next pass.
      onSaved(daysChanged ? 'Saved — run Sync now to fetch the older mail' : 'Saved');
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`What ${row.email} syncs`}
      subtitle={`${row.is_shared ? 'A shared mailbox' : row.owner ? `${row.owner.name}'s mailbox` : 'A personal mailbox'} · ${row.provider === 'test' ? 'Test' : 'Microsoft 365'}`}
      onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="mg-btn mg-btn--primary" onClick={save} disabled={busy || daysBad}>{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Days of history"
          error={daysBad ? 'Pick a number from 0 to 365.' : null}
          hint={daysChanged
            ? 'Changed: the next sync reads the whole window again. Nothing is stored twice.'
            : 'How far back the first pass reads. After that it follows Microsoft’s changes as they happen.'}
        >
          <input className="mg-input" type="number" min="0" max="365" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} style={{ maxWidth: 160 }} aria-invalid={daysBad || undefined} />
        </Field>
        <Option label="Keep email between colleagues" checked={internal} onChange={setInternal}>
          Off by default: a thread where everybody is on our own domain is skipped, so internal chatter stays out of the client record.
        </Option>
        <Option label="Create contacts for new senders" checked={contacts} onChange={setContacts}>
          Adds the person to the company on file the first time they write.
        </Option>
        {/* Which folders are read (074). A personal mailbox starts on Inbox and Sent Items; a shared one on every folder. */}
        <Option label="Read every folder" checked={everyFolder} onChange={setEveryFolder}>
          {row.is_shared
            ? 'On: Archive and the folders client mail is filed into are read as well as Inbox and Sent Items. Junk, Deleted Items and Drafts never are.'
            : 'Off by default: only your Inbox and Sent Items are synced and read for enquiries, quotations and POs. On opens your Archive and your own folders to them too (never Junk, Deleted Items or Drafts).'}
        </Option>
        {isOwner && (
          <Option label="Allow scheduled reports to be sent from this mailbox" checked={sendReports} onChange={setSendReports}>
            Off by default. On lets an admin choose your mailbox to send the Daily Sales Briefing and the Weekly Sales MIS; they would go out from your address and sit in your Sent Items.
          </Option>
        )}
      </div>
    </Modal>
  );
}

/**
 * Who a personal mailbox belongs to (docs/per-user-mailboxes-plan.md §5.2).
 * Mail read from now on makes records for the new owner; records already
 * made stay where they are.
 */
function ChangeOwnerDialog({ row, users, onClose, onSaved }) {
  const toast = useToast();
  const [userId, setUserId] = useState(row.owner?.id ? String(row.owner.id) : '');
  const [busy, setBusy] = useState(false);
  const chosen = users.find((u) => String(u.id) === userId);

  async function save() {
    setBusy(true);
    try {
      const r = await api.raw(`/mailboxes/${row.id}/owner`, { method: 'PATCH', body: { user_id: userId ? Number(userId) : null } });
      onSaved(r.data?.warning || (chosen ? `${row.email} is now ${chosen.name}'s` : `${row.email} has no owner`));
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      setBusy(false);
    }
  }

  const note = !chosen
    ? 'With nobody as owner, new records it creates are unassigned for an admin to hand out. Records it already created keep their owner.'
    : chosen.role !== 'sales'
      ? 'An admin owning a mailbox makes its new records unassigned, for an admin to hand out. Records it already created keep their owner.'
      : `From now on its new records are ${chosen.name}’s. Records it already created keep their owner; to move those too, use the ownership transfer on the records, which records the handover.`;

  return (
    <Modal
      title={`Who does ${row.email} belong to?`}
      subtitle={`A personal mailbox · now ${row.owner ? `${row.owner.name}'s` : 'nobody’s'}`}
      onClose={onClose}
      footer={<>
        <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="mg-btn mg-btn--primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}
    >
      <div className="flex flex-col gap-3.5">
        <Field label="Owner" hint="Only they see this mailbox's mail, and the records it creates from now on are theirs.">
          <span className="mg-select-wrap">
            <select className="mg-select" aria-label={`Owner of ${row.email}`} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Nobody (unassigned)</option>
              {users.map((u) => <option key={u.id} value={String(u.id)}>{u.name}{u.role === 'admin' ? ' (admin)' : ''}</option>)}
            </select>
          </span>
        </Field>
        <div className="mg-banner" role="note"><Info strokeWidth={1.8} aria-hidden="true" /><div className="mg-banner__body" style={{ fontSize: 13 }}>{note}</div></div>
      </div>
    </Modal>
  );
}

/** The clients registered automatically again while the readers are review-only. */
function AutoClients({ value, busy, onSave }) {
  const [text, setText] = useState(value);
  return (
    <div className="app-readers__save">
      <Field label="Automatic again for" hint="Client names as in the tracker, separated by commas. Leave it empty for none.">
        <input className="mg-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Client One Ltd, Client Two Pvt Ltd" />
      </Field>
      <button type="button" className="mg-btn" disabled={busy || text === value} onClick={() => onSave(text)} style={{ marginBottom: 22 }}>Save</button>
    </div>
  );
}

/** A reader's on/off switch as a pill: the label, then On or Off in words. */
function ReaderSwitch({ label, on, busy, onFlip }) {
  return (
    <label className={cn('mg-switch app-pill-switch', on && 'is-on')}>
      <input type="checkbox" role="switch" checked={on} disabled={busy} onChange={onFlip} aria-label={label} />
      <span>{label}</span>
      <span aria-hidden="true">{on ? 'On' : 'Off'}</span>
    </label>
  );
}

/**
 * Enquiries, POs and invoices made from email (docs/email-enquiries.md):
 * the switches, the AI budget, and per mailbox how far the read of past
 * mail has got and what it found. Admin only — it counts every mailbox's mail.
 */
function AutoEnquiries() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const { data, refetch } = useFetch(() => (isAdmin ? api.raw('/mailboxes/auto-enquiries') : Promise.resolve(null)), [isAdmin]);
  const [busy, setBusy] = useState(null);
  const [rerunning, setRerunning] = useState(null);
  const s = data?.data;
  if (!isAdmin || !s) return null;

  async function act(key, fn, ok) {
    setBusy(key);
    try { await fn(); toast(ok, 'success'); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }
  const toggle = () => act('switch', () => api.update('settings', 'auto_enquiries_enabled', { value: s.enabled ? 'false' : 'true' }),
    s.enabled ? 'Automatic enquiries are off' : 'Automatic enquiries are on');
  const togglePos = () => act('switch-pos', () => api.update('settings', 'auto_po_enabled', { value: s.purchase_orders_enabled ? 'false' : 'true' }),
    s.purchase_orders_enabled ? 'Automatic POs are off' : 'Automatic POs are on');
  const toggleInvoices = () => act('switch-invoices', () => api.update('settings', 'auto_invoice_enabled', { value: s.invoices_enabled ? 'false' : 'true' }),
    s.invoices_enabled ? 'Automatic invoices are off' : 'Automatic invoices are on');
  const toggleReviewOnly = () => act('review-only', () => api.update('settings', 'email_readers_review_only', { value: s.review_only ? 'false' : 'true' }),
    s.review_only ? 'POs and invoices are registered automatically again' : 'POs and invoices now wait for a person');
  const saveAutoClients = (value) => act('auto-clients', () => api.update('settings', 'email_readers_auto_clients', { value: value.trim() || 'none' }), 'Saved');

  /** The PO and invoice reads of past mail, after the enquiry one. */
  function laterProgress(m) {
    const step = (label, finished, reached, started) => {
      if (finished) return `${label} read`;
      if (!started && !reached) return `${label} waiting`;
      const span = s.backfill_days;
      const done = reached ? Math.max(0, Math.min(span, span - (Date.now() - new Date(reached).getTime()) / 864e5)) : 0;
      return `${label}: ${Math.round(done)} of ${span} days`;
    };
    return `${step('POs', m.po_finished_at, m.po_reached, m.po_started_at)} · ${step('Invoices', m.invoice_finished_at, m.invoice_reached, m.invoice_scanned != null)}`;
  }

  /** "212 of 365 days read", from the date the sweep has reached. */
  function progress(m) {
    if (!m.since) return 'Past mail: waiting for the first run';
    if (m.finished_at) return `Past mail: ${s.backfill_days} days read`;
    const span = (Date.now() - new Date(m.since).getTime()) / 864e5;
    const done = m.reached ? Math.max(0, Math.min(span, (new Date(m.reached).getTime() - new Date(m.since).getTime()) / 864e5)) : 0;
    return `Past mail: ${m.folder === 'sentitems' ? 'Inbox read; Sent Items ' : ''}${Math.round(done)} of ${Math.round(span)} days read`;
  }
  const oo = (on) => (on ? 'on' : 'off');
  const used = Number(s.ai?.used_today || 0);
  const limit = Number(s.ai?.daily_limit || 0);

  return (
    <section className="mg-glass mg-glass--strong app-ib-panel" data-a="rise" aria-labelledby="sec-auto">
      <div className="app-readers">
        <div className="app-ib-panel__titles">
          <h2 className="mg-panel__title" id="sec-auto">Automatic enquiries, POs and invoices</h2>
          <p className="mg-panel__hint" style={{ maxWidth: 900, lineHeight: 1.55 }}>
            A client email asking for new work becomes an enquiry by itself, and so does a quotation we email in a conversation with no enquiry.
            A purchase order a client emails is registered against its quotation, and an invoice we email is recorded on its payment stage;
            anything the reader is unsure of goes to review instead. Each mailbox's past {s.backfill_days} days are read once. Only the records' own fields are kept, never the email's text.
          </p>
        </div>
        <div role="group" aria-label="Email readers" className="app-readers__switches">
          <ReaderSwitch label="Enquiries" on={s.enabled} busy={busy === 'switch'} onFlip={toggle} />
          <ReaderSwitch label="POs" on={s.purchase_orders_enabled} busy={busy === 'switch-pos'} onFlip={togglePos} />
          <ReaderSwitch label="Invoices" on={s.invoices_enabled} busy={busy === 'switch-invoices'} onFlip={toggleInvoices} />
          <ReaderSwitch label="Review only" on={s.review_only} busy={busy === 'review-only'} onFlip={toggleReviewOnly} />
        </div>
        {s.review_only && (
          <div className="app-readers__box">
            <p>
              <strong>Review only is on.</strong> Every PO and invoice the readers would register waits in review, saying what they would have done, so the new prompts can be checked against what you enter by hand.
              Turn automatic registration back on client by client here, then switch review only off.
            </p>
            <AutoClients key={(s.auto_clients || []).join(',')} value={(s.auto_clients || []).join(', ')} busy={busy === 'auto-clients'} onSave={saveAutoClients} />
          </div>
        )}
        <div className="flex flex-col gap-2">
          <p>
            Enquiries {oo(s.enabled)}, POs {oo(s.purchase_orders_enabled)}, invoices {oo(s.invoices_enabled)}. Switching one off stops it reading; what it made stays.
            {s.ai.configured ? '' : ' POs and invoices need the AI key: without it they are left unread, and rules alone decide enquiries, with a stricter bar.'}
          </p>
          {s.ai.configured && (
            <div className="app-readers__ai">
              <span>AI reads the emails that pass the rules: <strong className="mg-num" style={{ color: 'var(--text)' }}>{number(used)} of {number(limit)}</strong> calls used today.</span>
              {limit > 0 && (
                <div className="mg-progress" role="img" aria-label={`${number(used)} of ${number(limit)} AI calls used today`}>
                  <span className="mg-progress__done" style={{ width: `${Math.min(100, Math.round((used / limit) * 100))}%` }} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ul className="app-perbox" aria-label="Readers by mailbox">
        {s.mailboxes.length === 0 ? (
          <li className="text-[13px] text-muted-foreground">No mailboxes connected.</li>
        ) : s.mailboxes.map((m) => (
          <li key={m.id}>
            <div className="app-perbox__text">
              <strong>{m.email}{m.is_shared && <span> · shared</span>}</strong>
              <span>
                {progress(m)} · {number(m.created)} created · {number(m.linked)} linked
                {m.quotations_read > 0 && <> · {number(m.quotations_read)} quotation{m.quotations_read === 1 ? '' : 's'} read from PDFs</>}
                {m.quotations_failed > 0 && <> · {number(m.quotations_failed)} PDF{m.quotations_failed === 1 ? '' : 's'} not read</>}
              </span>
              <span>
                {laterProgress(m)} · {number(m.pos_registered)} PO{m.pos_registered === 1 ? '' : 's'} registered
                {m.pos_to_review > 0 && <> · <Link className="app-link" to="/purchase-orders?tab=review">{number(m.pos_to_review)} to review</Link></>}
                {' · '}{number(m.invoices_recorded)} invoice{m.invoices_recorded === 1 ? '' : 's'} recorded
                {m.invoices_to_review > 0 && <> · <Link className="app-link" to="/payment-stages?tab=invoice-review">{number(m.invoices_to_review)} to review</Link></>}
                {m.invoices_waiting > 0 && <> · {number(m.invoices_waiting)} waiting for their PO</>}
              </span>
              {(m.po_last_error || m.invoice_last_error) && <span className="app-perbox__err">Last error: {m.po_last_error || m.invoice_last_error}</span>}
              {m.last_error && <span className="app-perbox__err">Last error {m.updated_at ? ago(m.updated_at) : ''}: {m.last_error}</span>}
            </div>
            <div className="app-perbox__btns">
              <button type="button" className="mg-btn mg-btn--sm" disabled={busy === m.id} onClick={() => setRerunning({ ...m, kind: 'enquiries' })}>Re-read for enquiries</button>
              <button type="button" className="mg-btn mg-btn--sm" disabled={busy === m.id} onClick={() => setRerunning({ ...m, kind: 'pos' })}>For POs</button>
              <button type="button" className="mg-btn mg-btn--sm" disabled={busy === m.id} onClick={() => setRerunning({ ...m, kind: 'invoices' })}>For invoices</button>
            </div>
          </li>
        ))}
      </ul>
      {rerunning && (
        <ConfirmDialog
          title={`Read ${rerunning.email} again for ${rerunning.kind === 'pos' ? 'POs' : rerunning.kind}?`}
          message={rerunning.kind === 'pos'
            ? `Emails judged not to be POs are read again, and the past ${s.backfill_days} days of inbox mail are read again for POs. POs registered, linked, in review or dismissed are kept, so nothing is registered twice. This uses the shared daily AI budget.`
            : rerunning.kind === 'invoices'
              ? `Emails judged not to be invoices are read again, and the past ${s.backfill_days} days of sent mail are read again for invoices. Invoices recorded, linked, in review or dismissed are kept, so nothing is recorded twice. This uses the shared daily AI budget.`
              : `Emails judged not to be enquiries are judged again, and the past ${s.backfill_days} days are read again from the start. Enquiries already created or linked are kept, so nothing is made twice. With an AI key, this uses the shared daily AI budget.`}
          confirmLabel="Read again"
          tone="default"
          onClose={() => setRerunning(null)}
          onConfirm={() => {
            const m = rerunning; setRerunning(null);
            act(m.id, () => api.action(`/mailboxes/${m.id}/auto-enquiries/rerun`, m.kind === 'enquiries' ? {} : { kind: m.kind }), `${m.email} will be read again on the next run`);
          }}
        />
      )}
      <p className="app-ib-panel__foot">
        Started {s.mailboxes.some((m) => m.started_at) ? date(s.mailboxes.filter((m) => m.started_at).map((m) => m.started_at).sort()[0]) : 'on the next run'}.
        {' '}Review what was made under Enquiries › Created from email, <Link to="/purchase-orders?tab=review">Purchase orders › To review</Link> and <Link to="/payment-stages?tab=invoice-review">Payment schedule › Invoices to review</Link>.
      </p>
    </section>
  );
}
