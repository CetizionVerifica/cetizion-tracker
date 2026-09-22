import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, ConfirmDialog, DataTable, Empty, Field, Input, Modal, Select, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Webhooks (#49): endpoints, what they listen to, delivery history with
 * replay, and a test button. Secrets are shown once.
 */
const TONE = { succeeded: 'success', pending: 'info', held: 'warning', failed: 'danger' };

export default function Webhooks() {
  const toast = useToast();
  const { data, refetch } = useFetch(() => api.raw('/webhooks'));
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState('');
  const deliveries = useFetch(() => api.raw(`/webhooks/deliveries?${new URLSearchParams({ ...(endpoint ? { endpoint_id: endpoint } : {}), ...(status ? { status } : {}) })}`), [endpoint, status]);
  const [form, setForm] = useState(null);
  const [secret, setSecret] = useState(null);
  const [removing, setRemoving] = useState(null);
  const rows = data?.data ?? [];
  const types = data?.event_types ?? [];

  async function run(fn, ok) {
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); deliveries.refetch(); return r; }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); return null; }
  }
  async function save() {
    const body = { name: form.name, url: form.url, events: form.events, min_value: form.min_value === '' ? null : Number(form.min_value), sector: form.sector || null, include_personal_data: form.include_personal_data, when_inactive: form.when_inactive };
    const r = await run(() => (form.id ? api.raw(`/webhooks/${form.id}`, { method: 'PATCH', body }) : api.action('/webhooks', body)), 'Saved');
    if (r) { setForm(null); if (r.data.secret) setSecret({ name: r.data.name, secret: r.data.secret }); }
  }

  return (
    <>
      <PageHeader title="Webhooks" subtitle="Tell n8n or other systems when something happens in the tracker. Every call is signed; failures are retried for a day."
        actions={<>
          <a className="btn" href="https://github.com/CetizionVerifica/cetizion-tracker/blob/main/docs/webhooks-n8n.md" target="_blank" rel="noopener noreferrer">How to receive</a>
          <button type="button" className="btn btn--primary" onClick={() => setForm({ name: '', url: 'https://', events: [], min_value: '', sector: '', include_personal_data: false, when_inactive: 'queue' })}>+ Endpoint</button>
        </>} />
      <div className="page stack">
        <Card flush title="Endpoints">
          <DataTable rows={rows} empty={<Empty title="No endpoints yet" text="Add an n8n webhook URL and choose the events it should get." />} columns={[
            { key: 'name', header: 'Endpoint', className: 'strong wrap', render: (r) => <>{r.name}<div className="small muted mono">{r.url}</div></> },
            { key: 'events', header: 'Events', className: 'wrap small', render: (r) => r.events.join(', ') },
            { key: 'filters', header: 'Only', className: 'small', render: (r) => [r.min_value != null && `value ≥ ${r.min_value}`, r.sector && r.sector, r.include_personal_data && 'with personal data'].filter(Boolean).join(' · ') || '—' },
            { key: 'counts', header: 'Deliveries', className: 'small', render: (r) => <>{r.succeeded} ok{r.pending ? ` · ${r.pending} retrying` : ''}{r.held ? ` · ${r.held} held` : ''}{r.failed ? <> · <span style={{ color: 'var(--danger-fg)' }}>{r.failed} failed</span></> : ''}</> },
            { key: 'active', header: 'On', render: (r) => <Badge tone={r.active ? 'success' : ''}>{r.active ? 'on' : `off, ${r.when_inactive === 'queue' ? 'holding' : 'dropping'}`}</Badge> },
            {
              key: 'act', header: '', align: 'right', render: (r) => (
                <div className="table__actions">
                  <button type="button" className="btn btn--sm" onClick={() => run(() => api.action(`/webhooks/${r.id}/test`), (x) => (x.data.status === 'succeeded' ? `Test delivered (${x.data.code})` : `Test failed: ${x.data.error || x.data.code}`))}>Send test</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => run(() => api.raw(`/webhooks/${r.id}`, { method: 'PATCH', body: { active: !r.active } }), r.active ? 'Turned off' : 'Turned on')}>{r.active ? 'Turn off' : 'Turn on'}</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setForm({ ...r, min_value: r.min_value ?? '', sector: r.sector || '' })}>Edit</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={async () => { const x = await run(() => api.action(`/webhooks/${r.id}/rotate-secret`)); if (x) setSecret({ name: r.name, secret: x.data.secret }); }}>New secret</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRemoving(r)}>✕</button>
                </div>
              ),
            },
          ]} />
        </Card>

        <Card flush title="Deliveries" hint="The last 200. A failed delivery can be sent again."
          actions={<div className="card__actions">
            <Select value={endpoint} placeholder="All endpoints" options={rows.map((r) => ({ value: String(r.id), label: r.name }))} onChange={(e) => setEndpoint(e.target.value)} />
            <Select value={status} placeholder="Any status" options={['succeeded', 'pending', 'held', 'failed']} onChange={(e) => setStatus(e.target.value)} />
            <button type="button" className="btn btn--sm" onClick={() => run(() => api.action('/webhooks/run'), (x) => `${x.data.delivered} delivered`)}>Send due now</button>
          </div>}>
          <DataTable rows={deliveries.data?.data ?? []} empty={<div className="small muted" style={{ padding: '12px 18px' }}>Nothing sent yet.</div>} columns={[
            { key: 'occurred_at', header: 'When', className: 'small', render: (r) => new Date(r.occurred_at).toLocaleString() },
            { key: 'event', header: 'Event', className: 'mono small' },
            { key: 'ref', header: 'Record', className: 'small', render: (r) => r.entity_id },
            { key: 'endpoint', header: 'Endpoint' },
            { key: 'status', header: 'Status', render: (r) => <Badge tone={TONE[r.status]}>{r.status}</Badge> },
            { key: 'attempts', header: 'Tries', align: 'right' },
            { key: 'answer', header: 'Last answer', className: 'small wrap', render: (r) => [r.last_status_code, r.last_error, r.last_response && r.last_response.slice(0, 80)].filter(Boolean).join(' · ') || '—' },
            { key: 'act', header: '', align: 'right', render: (r) => (r.status === 'failed' || r.status === 'succeeded') && <button type="button" className="btn btn--sm btn--ghost" onClick={() => run(() => api.action(`/webhooks/deliveries/${r.id}/replay`), (x) => `Replayed: ${x.data.status}`)}>Replay</button> },
          ]} />
        </Card>
      </div>

      {form && (
        <Modal size="lg" title={form.id ? `Edit ${form.name}` : 'New endpoint'} onClose={() => setForm(null)}
          footer={<><button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button><button type="button" className="btn btn--primary" disabled={!form.name.trim() || !form.events.length} onClick={save}>Save</button></>}>
          <div className="form-grid">
            <Field label="Name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="n8n: wins to Teams" /></Field>
            <Field label="URL" required hint="https only"><Input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} /></Field>
            <div className="span-all"><Field label="Events" required>
              <div className="chips">{types.map((t) => <label key={t} className={`chip ${form.events.includes(t) ? 'is-on' : ''}`}><input type="checkbox" checked={form.events.includes(t)} onChange={() => setForm((f) => ({ ...f, events: f.events.includes(t) ? f.events.filter((x) => x !== t) : [...f.events, t] }))} /> {t}</label>)}</div>
            </Field></div>
            <Field label="Only values from" hint="Blank: any value"><Input type="number" min="0" value={form.min_value} onChange={(e) => setForm((f) => ({ ...f, min_value: e.target.value }))} /></Field>
            <Field label="Only this sector" hint="Blank: all sectors"><Input value={form.sector} onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))} /></Field>
            <Field label="Personal data"><Select value={form.include_personal_data ? 'yes' : 'no'} placeholder={null} options={[{ value: 'no', label: 'Leave out names, emails and phones' }, { value: 'yes', label: 'Include them' }]} onChange={(e) => setForm((f) => ({ ...f, include_personal_data: e.target.value === 'yes' }))} /></Field>
            <Field label="While turned off"><Select value={form.when_inactive} placeholder={null} options={[{ value: 'queue', label: 'Hold events, send them when back on' }, { value: 'drop', label: 'Drop them' }]} onChange={(e) => setForm((f) => ({ ...f, when_inactive: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
      {secret && (
        <Modal title={`Signing secret for ${secret.name}`} subtitle="Shown only now. Store it in n8n (for example as CETIZION_WEBHOOK_SECRET) to check each call." onClose={() => setSecret(null)}
          footer={<><button type="button" className="btn" onClick={() => navigator.clipboard?.writeText(secret.secret).then(() => toast('Copied', 'success'))}>Copy</button><button type="button" className="btn btn--primary" onClick={() => setSecret(null)}>Done</button></>}>
          <Alert tone="warning"><span>Anyone with this secret can forge calls that look like the tracker.</span></Alert>
          <Field label="Secret"><Input readOnly value={secret.secret} onFocus={(e) => e.target.select()} className="mono" /></Field>
        </Modal>
      )}
      {removing && <ConfirmDialog title={`Delete ${removing.name}?`} message="Its delivery history goes too." onConfirm={() => run(() => api.remove('webhooks', removing.id), 'Deleted').then(() => setRemoving(null))} onClose={() => setRemoving(null)} />}
    </>
  );
}
