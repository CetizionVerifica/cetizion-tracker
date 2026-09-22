import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, DataTable, Empty, Field, Input, Select, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Connected mailboxes (#29): connect Microsoft 365, choose what is shared,
 * sync now, disconnect, and keep newsletters out.
 */
const VIS = [
  { value: 'metadata', label: 'Who and when only (default)' },
  { value: 'subject', label: 'Subject only' },
  { value: 'share_everything', label: 'Everything (subject and body)' },
];

export default function Mailboxes() {
  const toast = useToast();
  const [params] = useSearchParams();
  const { data, refetch } = useFetch(() => api.raw('/mailboxes'));
  const block = useFetch(() => api.raw('/mailboxes/blocklist'));
  const [pattern, setPattern] = useState('');
  const [busy, setBusy] = useState(null);
  const rows = data?.data ?? [];
  const cfg = data?.configured;

  async function run(id, fn, ok) {
    setBusy(id);
    try { const r = await fn(); if (ok) toast(ok(r), 'success'); refetch(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(null); }
  }
  const patch = (id, body) => run(id, () => api.raw(`/mailboxes/${id}`, { method: 'PATCH', body }), () => 'Saved');

  return (
    <>
      <PageHeader
        title="Mailboxes"
        subtitle="Client email from connected Microsoft 365 mailboxes appears on companies, quotations and enquiries. Mail only between colleagues is never synced."
        actions={<>
          <a className={`btn btn--primary ${cfg?.microsoft ? '' : 'is-disabled'}`} href={cfg?.microsoft ? '/api/mailboxes/connect/microsoft' : undefined} aria-disabled={!cfg?.microsoft}>Connect my mailbox</a>
          <a className={`btn ${cfg?.microsoft ? '' : 'is-disabled'}`} href={cfg?.microsoft ? '/api/mailboxes/connect/microsoft?shared=1' : undefined} aria-disabled={!cfg?.microsoft}>Connect a shared mailbox</a>
          {cfg?.test_mailboxes && <button type="button" className="btn btn--ghost" onClick={() => run('new', () => api.action('/mailboxes/test', { email: `test${Date.now() % 10000}@cetizionverifica.com` }), () => 'Test mailbox added')}>Add test mailbox</button>}
        </>}
      />
      <div className="page stack">
        {params.get('connected') && <Alert tone="success"><span>Connected {params.get('connected')}. The first sync is running.</span></Alert>}
        {params.get('error') && <Alert tone="danger"><span>{params.get('error')}</span></Alert>}
        {cfg && !cfg.microsoft && (
          <Alert tone="warning"><span>Microsoft 365 is not set up on this server yet. The lead needs to register an app in Microsoft Entra ID and set MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI and MAIL_TOKEN_KEY (see .env.example). Until then, only test mailboxes can be used.</span></Alert>
        )}
        {cfg?.microsoft && !cfg.webhook && <Alert tone="info"><span>MAIL_WEBHOOK_URL is not set, so new mail arrives on the five-minute sweep rather than at once.</span></Alert>}

        <Card flush title="Connected">
          <DataTable
            rows={rows}
            empty={<Empty title="No mailbox connected" text="Connect your Microsoft 365 mailbox to see client email on the records it belongs to." />}
            columns={[
              { key: 'email', header: 'Mailbox', className: 'strong', render: (r) => <>{r.email}{r.is_shared && <> <Badge tone="info">shared</Badge></>}{r.provider === 'test' && <> <Badge>test</Badge></>}<div className="small muted">{r.display_name || r.username}</div></> },
              { key: 'status', header: 'Status', render: (r) => <><Badge tone={r.status === 'active' ? 'success' : r.status === 'needs_reconnect' ? 'danger' : ''}>{r.status.replace('_', ' ')}</Badge>{r.last_error && <div className="small" style={{ color: 'var(--danger-fg)' }}>{r.last_error}</div>}</> },
              { key: 'visibility', header: 'Shared with the team', render: (r) => <Select value={r.visibility} placeholder={null} options={VIS} disabled={r.status === 'disconnected'} onChange={(e) => patch(r.id, { visibility: e.target.value })} /> },
              { key: 'import_days', header: 'History', render: (r) => `${r.import_days} days` },
              { key: 'counts', header: 'Synced', render: (r) => `${r.threads} threads · ${r.messages} emails` },
              { key: 'last_synced_at', header: 'Last sync', render: (r) => (r.last_synced_at ? new Date(r.last_synced_at).toLocaleString() : 'never') },
              {
                key: 'act', header: '', align: 'right', render: (r) => r.status !== 'disconnected' && (
                  <div className="table__actions">
                    <button type="button" className="btn btn--sm" disabled={busy === r.id} onClick={() => run(r.id, () => api.action(`/mailboxes/${r.id}/sync`), (x) => `${x.data.stored} new emails`)}>Sync now</button>
                    <button type="button" className="btn btn--sm btn--ghost" disabled={busy === r.id} onClick={() => { if (window.confirm(`Disconnect ${r.email}? Stored email bodies are removed; who and when stays on the records.

The tracker deletes its subscriptions and destroys its copy of the sign-in tokens. Microsoft has no way for us to cancel the permission itself — to withdraw it, the mailbox's owner removes Cetizion Tracker at myaccount.microsoft.com → Apps.`)) run(r.id, () => api.action(`/mailboxes/${r.id}/disconnect`, { remove_bodies: true }), (x) => `Disconnected — ${x.data.upstream}`); }}>Disconnect</button>
                  </div>
                ),
              },
            ]}
          />
        </Card>

        <Card flush title="Never sync" hint="Addresses or whole domains, such as newsletters or personal contacts. Robots like no-reply@ are always skipped.">
          <form className="contact-bar" onSubmit={(e) => { e.preventDefault(); run('block', () => api.action('/mailboxes/blocklist', { pattern }), () => 'Added').then(() => { setPattern(''); block.refetch(); }); }}>
            <Field label=""><Input placeholder="news@vendor.com or vendor.com" value={pattern} onChange={(e) => setPattern(e.target.value)} /></Field>
            <button type="submit" className="btn btn--sm" disabled={!pattern.trim()}>Add</button>
          </form>
          <DataTable rows={block.data?.data ?? []} empty={<div className="small muted" style={{ padding: '10px 18px' }}>Nothing blocked.</div>} columns={[
            { key: 'pattern', header: 'Address or domain', className: 'mono' },
            { key: 'created_by', header: 'Added by', className: 'small muted' },
            { key: 'act', header: '', align: 'right', render: (r) => <button type="button" className="btn btn--sm btn--ghost" onClick={() => api.remove('mailboxes/blocklist', r.id).then(block.refetch)}>Remove</button> },
          ]} />
        </Card>
      </div>
    </>
  );
}
