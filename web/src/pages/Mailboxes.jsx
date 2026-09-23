import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Check, MoreHorizontal, X } from 'lucide-react';
import { cn } from 'cn';
import { Alert, ConfirmDialog, useToast } from '../components/ui.jsx';
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
const GRID = 'lg:grid-cols-[minmax(0,1.6fr)_120px_200px_150px_96px]';
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
  const [params] = useSearchParams();
  const { data, refetch } = useFetch(() => api.raw('/mailboxes'));
  const block = useFetch(() => api.raw('/mailboxes/blocklist'));
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);

  const rows = data?.data ?? [];
  const cfg = data?.configured;
  const blocked = block.data?.data ?? [];

  async function run(id, fn, ok) {
    setBusy(id);
    try { const r = await fn(); if (ok) toast(ok(r), 'success'); refetch(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(null); }
  }
  const patch = (id, body) => run(id, () => api.raw(`/mailboxes/${id}`, { method: 'PATCH', body }), () => 'Saved');

  const connectUrl = (shared) => (cfg?.microsoft ? `/api/mailboxes/connect/microsoft${shared ? '?shared=1' : ''}` : undefined);

  /** What the "Synced" column says, which is mostly about whether it is still running. */
  function syncedLine(row) {
    if (row.status === 'needs_reconnect') {
      const when = ago(row.last_synced_at);
      return <span className="text-late">{when ? `stopped ${when}` : 'stopped'}</span>;
    }
    if (row.status === 'disconnected') return <span className="text-muted-foreground">disconnected</span>;
    if (cfg?.webhook) return 'live, via webhook';
    return ago(row.last_synced_at) ?? 'never synced';
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
              variant="ghost"
              size="sm"
              className="h-8 px-4 text-[13px]"
              onClick={() => run('new', () => api.action('/mailboxes/test', { email: `test${Date.now() % 10000}@cetizionverifica.com` }), () => 'Test mailbox added')}
            >
              Add test mailbox
            </Button>
          )}
        </>}
      >
        {params.get('connected') && <Alert tone="success"><span>Connected {params.get('connected')}. The first sync is running.</span></Alert>}
        {params.get('error') && <Alert tone="danger"><span>{params.get('error')}</span></Alert>}

        <div className="overflow-hidden rounded-[10px] border border-border bg-card">
          <div className={cn('hidden h-9 items-center gap-4 bg-secondary px-5 lg:grid', GRID, COL_LABEL)}>
            <span>Mailbox</span><span>Status</span><span>Team sees</span><span>Synced</span><span />
          </div>

          {rows.length === 0 ? (
            <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">
              No mailbox is connected. Connect your Microsoft 365 mailbox to see client email on the records it belongs to.
            </p>
          ) : rows.map((row, i) => {
            const broken = row.status === 'needs_reconnect';
            return (
              <div key={row.id} className={cn(i < rows.length - 1 && 'border-b border-border', broken && 'bg-late/[0.04]')}>
                <div className={cn('grid gap-3 px-5 py-3 lg:items-center lg:gap-4', GRID)}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium break-words text-foreground">
                      {row.email}
                      {row.is_shared && <Chip tone="info">shared</Chip>}
                      {row.provider === 'test' && <Chip>test</Chip>}
                    </div>
                    <div className="text-[12px] text-muted-foreground">
                      {row.is_shared ? 'Feeds the Inbox' : (row.display_name || row.username)}
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
                        disabled={busy === row.id}
                        onClick={() => run(row.id, () => api.action(`/mailboxes/${row.id}/sync`), (x) => `${number(x.data.stored)} new emails`)}
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
                          <DropdownMenuItem className="text-[13px]" onSelect={() => setDisconnecting(row)}>
                            Disconnect this mailbox
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </div>

                {/* The reason lives under the row it belongs to, because a
                    status word on its own never told anybody what to do. */}
                {broken && (
                  <p className="px-5 pb-3.5 text-[12.5px]/[1.6] text-secondary-text lg:max-w-[80ch]">
                    <strong className="font-semibold text-foreground">Why:</strong>{' '}
                    {row.last_error || 'Microsoft stopped accepting the saved sign-in, which usually means the password changed or the permission was withdrawn.'}
                    {' '}Reconnecting takes one sign-in; nothing already synced is lost.
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
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

      {disconnecting && (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.email}?`}
          message={
            'Stored email bodies are removed; who and when stays on the records. The tracker deletes its subscriptions and destroys its copy of the sign-in tokens. '
            + 'Microsoft has no way for us to cancel the permission itself — to withdraw it, the mailbox’s owner removes Cetizion Tracker at myaccount.microsoft.com → Apps.'
          }
          confirmLabel="Disconnect"
          busy={busy === disconnecting.id}
          onClose={() => setDisconnecting(null)}
          onConfirm={async () => {
            const row = disconnecting;
            setDisconnecting(null);
            await run(row.id, () => api.action(`/mailboxes/${row.id}/disconnect`, { remove_bodies: true }), (x) => `Disconnected — ${x.data.upstream}`);
          }}
        />
      )}
    </>
  );
}
