import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, Loader2, MoreHorizontal, X } from 'lucide-react';
import { cn } from 'cn';
import { Alert, ConfirmDialog, Field, Modal, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ago, number } from '../lib/format.js';

/**
 * Connected mailboxes (#29), as C10 draws it.
 *
 * The design's whole argument is in its last line: the broken mailbox is
 * the row that gets colour, the reason is written underneath it in a
 * sentence, and the fix is one button. A mailbox that has stopped syncing
 * is not a status value to be read off a column — it is mail silently not
 * arriving on records people are looking at, and the page has to say so.
 *
 * The visibility choice stays inline on the row rather than moving into a
 * dialog, because it is the one privacy decision a sales user makes for
 * themselves and it should cost one click to change.
 */

/**
 * The five-column shape, stacked on anything narrower than a laptop.
 *
 * Narrower than the design's fixed widths because this is a settings pane:
 * the app sidebar and the settings rail take 460px before the table starts,
 * and at the design's 140/220/160/120 an ordinary address like
 * shyam@cetizionverifica.com wrapped mid-word in the first column.
 */
const GRID = '@3xl:grid-cols-[minmax(0,1.8fr)_96px_180px_120px_88px]';
const COL_LABEL = 'text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground';
const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';

const VIS = [
  { value: 'metadata', label: 'Who and when only' },
  { value: 'subject', label: 'Subject only' },
  { value: 'share_everything', label: 'Everything' },
];

/** A line in the server-setup card: a requirement, and whether it is met. */
function Ready({ label, ok, okLabel = 'Set', missing = 'Not set' }) {
  return (
    <div className="flex justify-between gap-3 text-[12.5px] text-secondary-text">
      {label}
      <span className={cn('inline-flex items-center gap-1.5 font-semibold', ok ? 'text-settled' : 'text-waiting')}>
        {ok && <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />}
        {ok ? okLabel : missing}
      </span>
    </div>
  );
}

export default function Mailboxes() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { data, loading, refetch } = useFetch(() => api.raw('/mailboxes'));
  const block = useFetch(() => api.raw('/mailboxes/blocklist'));
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  const [tuning, setTuning] = useState(null);
  const [rereading, setRereading] = useState(null);

  const rows = data?.data ?? [];
  const cfg = data?.configured;
  const blocked = block.data?.data ?? [];

  /**
   * `what` is running, not only where.
   *
   * busy used to be an id, so the only sign anything was happening was a
   * button greying out — and a sync or a re-read is minutes of nothing,
   * against a mailbox that looks idle. Naming the work lets the row say
   * which of them it is doing.
   */
  async function run(id, fn, ok, what = 'Working…') {
    setBusy({ id, what });
    try { const r = await fn(); if (ok) toast(ok(r), 'success'); refetch(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(null); }
  }
  /** What this mailbox is doing, or null if it is doing nothing. */
  const doing = (id) => (busy?.id === id ? busy.what : null);
  const patch = (id, body) => run(id, () => api.raw(`/mailboxes/${id}`, { method: 'PATCH', body }), () => 'Saved');

  // Fires once, then clears the parameter so a refresh does not re-announce
  // a connection made ten minutes ago.
  const connected = params.get('connected');
  // Guarded by a ref, not by the parameter: StrictMode mounts the effect
  // twice and both runs read the parameter before either has cleared it,
  // so the announcement arrived in duplicate.
  const announced = useRef(false);
  useEffect(() => {
    if (!connected || announced.current) return;
    announced.current = true;
    toast(`Connected ${connected}. The first sync is running.`, 'success');
    const next = new URLSearchParams(params);
    next.delete('connected');
    setParams(next, { replace: true });
  }, [connected]);

  const connectUrl = (shared) => (cfg?.microsoft ? `/api/mailboxes/connect/microsoft${shared ? '?shared=1' : ''}` : undefined);

  /**
   * What a sync actually did.
   *
   * This said "0 new emails" and stopped, while the response carried a
   * breakdown of everything it threw away and why — `{"no matching
   * client": 3}`, `{"internal only": 12}`. Zero and zero-because are
   * different answers, and only one of them tells somebody what to change:
   * a personal mailbox keeps client mail only, so "no matching client"
   * means connect it as shared, and "internal only" means the message
   * never left the building.
   */
  function syncResult(x) {
    const stored = Number(x.data.stored || 0);
    const skipped = Object.entries(x.data.skipped || {}).filter(([, n]) => n > 0);
    const head = `${number(stored)} new email${stored === 1 ? '' : 's'}`;
    if (!skipped.length) return head;
    return `${head} · skipped ${skipped.map(([why, n]) => `${n} ${why}`).join(', ')}`;
  }

  /**
   * What a re-read actually did.
   *
   * "Done" would be useless here: the answer people need is whether it
   * found anything, and if not, whether that is because there was nothing
   * to fix or because it looked in the wrong window.
   */
  function rereadResult(x) {
    const { updated = 0, seen = 0, messages_held: held = 0 } = x.data || {};
    if (!seen) return 'The mailbox returned nothing for that window — try more days, or reconnect it.';
    if (!updated) return `Nothing to update — the ${number(seen)} message${seen === 1 ? '' : 's'} it re-read are already current.`;
    return `${number(updated)} of ${number(held)} stored message${held === 1 ? '' : 's'} rewritten with the sender's own styling.`;
  }

  /** What the "Synced" column says, which is mostly about whether it is still running. */
  function syncedLine(row) {
    if (row.status === 'needs_reconnect') {
      const when = ago(row.last_synced_at);
      return <span className="text-late">{when ? `stopped ${when}` : 'stopped'}</span>;
    }
    if (row.status === 'disconnected') return <span className="text-muted-foreground">disconnected</span>;
    // The mechanism and the outcome are different facts, and this used to
    // report only the first: with a webhook configured it always said
    // "live, via webhook" and never whether a sync had actually run, so a
    // mailbox that had never fetched anything looked identical to one
    // fetching happily. "never synced" was unreachable.
    const when = ago(row.last_synced_at);
    if (cfg?.webhook) {
      return (
        <>
          live, via webhook
          <span className="text-muted-foreground"> · {when ? `synced ${when}` : 'never synced'}</span>
        </>
      );
    }
    return when ?? 'never synced';
  }

  return (
    <>
      <SettingsPane
        title="Mailboxes"
        description="Client email from a connected mailbox appears on the company, deal and enquiry it belongs to. Mail only between colleagues is never synced."
        actions={<>
          <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={!cfg?.microsoft} asChild={Boolean(cfg?.microsoft)}>
            {cfg?.microsoft ? <a href={connectUrl(true)}>Connect a shared mailbox</a> : <span>Connect a shared mailbox</span>}
          </Button>
          <Button size="sm" className="h-8 px-4 text-[13px]" disabled={!cfg?.microsoft} asChild={Boolean(cfg?.microsoft)}>
            {cfg?.microsoft ? <a href={connectUrl(false)}>Connect my mailbox</a> : <span>Connect my mailbox</span>}
          </Button>
          {cfg?.test_mailboxes && (
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-4 text-[13px]"
              onClick={() => run('new', () => api.action('/mailboxes/test', { email: `test${Date.now() % 10000}@cetizionverifica.com` }), () => 'Test mailbox added')}
            >
              Add test mailbox
            </Button>
          )}
        </>}
      >
        {/* Success is a toast and failure is a banner, because they are read
            differently: "it worked" only needs to be noticed, while a reason
            it did not needs to sit there until somebody has acted on it. */}
        {params.get('error') && <Alert tone="danger"><span>{params.get('error')}</span></Alert>}

        {/* Both Connect buttons are dead until the server is set up, and a
            disabled button that does not say why is the thing this whole
            page exists to stop doing. */}
        {cfg && !cfg.microsoft && (
          <Alert tone="warning">
            <span>
              Microsoft 365 is not set up on this server, so no mailbox can be connected yet. The lead registers an
              app in Microsoft Entra ID and sets <code className="mono">MS_TENANT_ID</code>,{' '}
              <code className="mono">MS_CLIENT_ID</code>, <code className="mono">MS_CLIENT_SECRET</code>,{' '}
              <code className="mono">MS_REDIRECT_URI</code> and <code className="mono">MAIL_TOKEN_KEY</code> — Server
              setup below says which are still missing.
            </span>
          </Alert>
        )}
        {cfg?.microsoft && !cfg.webhook && (
          <Alert tone="info">
            <span>
              <code className="mono">MAIL_WEBHOOK_URL</code> is not set, so new mail arrives on the five-minute sweep
              rather than the moment it lands.
            </span>
          </Alert>
        )}

        <div className="overflow-hidden rounded-[10px] border border-border bg-card">
          <div className={cn('hidden h-9 items-center gap-4 bg-secondary px-5 @3xl:grid', GRID, COL_LABEL)}>
            <span>Mailbox</span><span>Status</span><span>Team sees</span><span>Synced</span><span />
          </div>

          {/* The wait and the answer are different things. Without this the
              "nothing connected" sentence rendered first and was replaced a
              moment later, so a slow request looked exactly like a mailbox
              nobody had set up. */}
          {loading && !data ? <div className="skeleton" style={{ height: 96, margin: 16 }} />
          : rows.length === 0 ? (
            <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">
              No mailbox is connected. Connect your Microsoft 365 mailbox to see client email on the records it belongs to.
            </p>
          ) : rows.map((row, i) => {
            const broken = row.status === 'needs_reconnect';
            return (
              <div key={row.id} className={cn(i < rows.length - 1 && 'border-b border-border', broken && 'bg-late/[0.04]')}>
                <div className={cn('grid gap-3 px-5 py-3 @3xl:items-center @3xl:gap-4', GRID)}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium break-words text-foreground">
                      {row.email}
                      {row.is_shared && <Chip tone="info">shared</Chip>}
                      {row.provider === 'test' && <Chip>test</Chip>}
                    </div>
                    <div className="text-[12px] text-muted-foreground">
                      {/* "Feeds the Inbox" used to be printed for any
                          shared mailbox, true or not — it tested is_shared
                          rather than whether an inbox exists. A shared
                          mailbox with no inboxes row stores every thread
                          and routes none of them, while the page said it
                          was feeding the Inbox. */}
                      {!row.is_shared ? (row.display_name || row.username)
                        : row.feeds_inbox ? 'Feeds the Inbox'
                        : <span className="text-waiting">Shared · no Inbox set up for it yet</span>}
                      {' · '}{row.provider === 'test' ? 'Test' : 'Microsoft 365'}
                      {row.import_days ? ` · ${number(row.import_days)} days of history` : ''}
                    </div>
                  </div>

                  <div>
                    {broken
                      ? <Chip tone="late" icon={AlertTriangle}>Reconnect</Chip>
                      : row.status === 'active'
                        ? <Chip tone="settled" icon={Check}>Active</Chip>
                        : <Chip>{row.status.replace('_', ' ')}</Chip>}
                  </div>

                  <div>
                    <Select value={row.visibility} onValueChange={(v) => patch(row.id, { visibility: v })} disabled={row.status === 'disconnected'}>
                      <SelectTrigger size="sm" className="w-full text-[12.5px]" aria-label={`What the team sees of ${row.email}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VIS.map((v) => <SelectItem key={v.value} value={v.value} className="text-[12.5px]">{v.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="text-[12.5px] text-secondary-text">
                    {number(row.threads)} threads
                    <div className="text-muted-foreground">{syncedLine(row)}</div>
                  </div>

                  <div className="flex items-center gap-1">
                    {row.status !== 'disconnected' && (broken ? (
                      <Button size="sm" className={cn(ROW_BUTTON, 'border border-primary bg-primary/15 text-primary hover:bg-primary/25')} asChild={Boolean(cfg?.microsoft)}>
                        {cfg?.microsoft ? <a href={connectUrl(row.is_shared)}>Reconnect</a> : <span>Reconnect</span>}
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        className={ROW_BUTTON}
                        disabled={Boolean(doing(row.id))}
                        onClick={() => run(row.id, () => api.action(`/mailboxes/${row.id}/sync`), syncResult, 'Fetching new mail…')}
                      >
                        Sync now
                      </Button>
                    ))}
                    {row.status !== 'disconnected' && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`More actions for ${row.email}`}>
                            <MoreHorizontal strokeWidth={2.4} aria-hidden="true" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem className="text-[13px]" onSelect={() => setTuning(row)}>
                            What this mailbox syncs…
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-[13px]" onSelect={() => setRereading(row)}>
                            Re-read stored mail…
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-[13px]" onSelect={() => setDisconnecting(row)}>
                            Disconnect this mailbox
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                {/* The reason lives under the row it belongs to, because a
                    status word on its own never told anybody what to do.
                    Shown for any failure, not only an expired sign-in: a
                    sync that fails on a missing permission or a bad
                    response records last_error and leaves the status
                    'active', so the mailbox looked healthy while quietly
                    fetching nothing, and the one sentence explaining it was
                    stored and rendered to nobody. */}
                {/* Sync and re-read both run for minutes against a mailbox
                    that otherwise looks idle, and a greyed-out button is not
                    an answer to "is it doing anything". It goes under the
                    row rather than beside the button, because the action
                    column is a few characters wide and the sentence was
                    truncating to nothing. aria-live so it is announced and
                    not only drawn; the spin stops entirely under
                    prefers-reduced-motion, as all motion here does. */}
                {doing(row.id) && (
                  <p role="status" aria-live="polite" className="flex items-center gap-2 px-5 pb-3.5 text-[12.5px] text-secondary-text">
                    <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" strokeWidth={2.2} aria-hidden="true" />
                    {doing(row.id)}
                  </p>
                )}

                {(broken || row.last_error) && (
                  <p className="px-5 pb-3.5 text-[12.5px]/[1.6] text-secondary-text @3xl:max-w-[80ch]">
                    <strong className={cn('font-semibold', broken ? 'text-foreground' : 'text-waiting')}>
                      {broken ? 'Why:' : 'Last sync failed:'}
                    </strong>{' '}
                    {row.last_error || 'Microsoft stopped accepting the saved sign-in, which usually means the password changed or the permission was withdrawn.'}
                    {broken && ' Reconnecting takes one sign-in; nothing already synced is lost.'}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 @3xl:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
            <div className="text-[14px] font-semibold text-foreground">Never sync</div>
            <p className="text-[12.5px]/[1.6] text-secondary-text">
              Addresses or whole domains — newsletters, personal contacts. Robots like no-reply@ are always skipped.
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run('block', () => api.action('/mailboxes/blocklist', { pattern }), () => 'Added')
                  .then(() => { setPattern(''); block.refetch(); });
              }}
            >
              <Input
                className="h-8 flex-1 text-[12.5px]"
                placeholder="news@vendor.com or vendor.com"
                aria-label="Address or domain never to sync"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
              />
              <Button type="submit" variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={!pattern.trim()}>Add</Button>
            </form>
            {blocked.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">Nothing blocked.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {blocked.map((b) => (
                  <span key={b.id} className="mono inline-flex h-7 items-center gap-2 rounded-[6px] border border-[#33333a] bg-secondary px-2.5 text-[12.5px] text-secondary-text">
                    {b.pattern}
                    <button
                      type="button"
                      aria-label={`Remove ${b.pattern}`}
                      className="grid text-muted-foreground hover:text-foreground"
                      onClick={() => api.remove('mailboxes/blocklist', b.id).then(block.refetch)}
                    >
                      <X className="size-3" strokeWidth={2.6} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
            <div className="text-[14px] font-semibold text-foreground">Server setup</div>
            <Ready label="Microsoft Entra app" ok={Boolean(cfg?.microsoft)} okLabel="Registered" missing="Not registered" />
            <Ready label="Token encryption key" ok={Boolean(cfg?.token_key)} />
            <Ready label="Webhook URL" ok={Boolean(cfg?.webhook)} okLabel="Live" />
            <p className="mt-1 text-[11.5px]/[1.6] text-muted-foreground">
              Without the webhook, mail arrives on the five-minute sweep instead of at once.{' '}
              <code className="mono">MS_TENANT_ID · MS_CLIENT_ID · MAIL_TOKEN_KEY · MAIL_WEBHOOK_URL</code>
            </p>
          </div>
        </div>
      </SettingsPane>

      {tuning && (
        <SyncSettingsDialog
          row={tuning}
          onClose={() => setTuning(null)}
          onSaved={(message) => { setTuning(null); toast(message, 'success'); refetch(); }}
        />
      )}

      {rereading && (
        <ConfirmDialog
          tone="normal"
          title={`Re-read stored mail for ${rereading.email}?`}
          message={
            'Mail already in the tracker was stripped of its styling by the old rules, and the original was never kept — so it is fetched from the mailbox again and stored as it really looks. '
            + 'Only messages already here are updated: nothing new is imported, no conversation is opened or reopened, and a mailbox that shares only metadata still stores no subject and no body. '
            + 'It reads the last 30 days and makes one request per message, so a busy mailbox will take a few minutes. Running it twice is running it once.'
          }
          confirmLabel="Re-read"
          busy={Boolean(doing(rereading.id))}
          onConfirm={async () => {
            const row = rereading;
            setRereading(null);
            await run(row.id, () => api.action(`/mailboxes/${row.id}/refresh-bodies`, { days: 30 }), rereadResult,
              'Re-reading stored mail…');
          }}
          onClose={() => setRereading(null)}
        />
      )}
      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.email}?`}
          message={
            'Stored email bodies are removed; who and when stays on the records. The tracker deletes its subscriptions and destroys its copy of the sign-in tokens. '
            + 'Microsoft has no way for us to cancel the permission itself — to withdraw it, the mailbox’s owner removes Cetizion Tracker at myaccount.microsoft.com → Apps.'
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

/**
 * What this mailbox actually pulls in.
 *
 * All three of these have been columns on connected_accounts and fields on
 * the PATCH route since #29, and none of them had a control anywhere — so
 * the two commonest complaints about the inbox ("I can't see mail from my
 * own colleagues", "it only goes back a month") were settings the person
 * complaining had no way to reach.
 *
 * They live behind the ⋯ rather than on the row because C10 keeps the row
 * to the one privacy decision a sales user makes for themselves. These are
 * the rarer, duller kind: set once when the mailbox is connected, and
 * almost never again.
 */
function SyncSettingsDialog({ row, onClose, onSaved }) {
  const toast = useToast();
  const [days, setDays] = useState(String(row.import_days ?? 30));
  const [internal, setInternal] = useState(!row.exclude_internal);
  const [contacts, setContacts] = useState(Boolean(row.auto_create_contacts));
  const [busy, setBusy] = useState(false);
  const daysChanged = Number(days) !== Number(row.import_days ?? 30);

  async function save() {
    setBusy(true);
    try {
      await api.raw(`/mailboxes/${row.id}`, {
        method: 'PATCH',
        body: { import_days: Number(days), exclude_internal: !internal, auto_create_contacts: contacts },
      });
      // Changing the window drops the sync cursor, so the older mail only
      // appears on the next pass. Saying "Saved" and leaving an unchanged
      // list on screen reads as a broken setting.
      onSaved(daysChanged ? 'Saved — run Sync now to fetch the older mail' : 'Saved');
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`What ${row.email} syncs`}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Days of history"
          hint={daysChanged
            ? 'Changed: the next sync reads the whole window again. Nothing is stored twice.'
            : 'How far back the first pass reads. After that it follows Microsoft’s cursor.'}
        >
          <Input type="number" min="0" max="365" value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>

        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          <span>
            Keep email between colleagues
            <span className="block text-[12px] text-muted-foreground">
              Off by default: a thread where everybody is on our own domain is skipped, so internal chatter stays out of the client record.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={contacts} onChange={(e) => setContacts(e.target.checked)} />
          <span>
            Create contacts for new senders
            <span className="block text-[12px] text-muted-foreground">
              Adds the person to the company on file the first time they write.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
