import { useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { cn } from 'cn';
import { Alert, ConfirmDialog, Field, Input, Modal, Select as LegacySelect, useToast } from '../components/ui.jsx';
import { Chip, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Webhooks (#49), on C12's shape.
 *
 * The endpoints were a seven-column table in which "3 failed" was a
 * number in a cell. An integration that has stopped is the same kind of
 * fact as a mailbox that has stopped — something downstream is not
 * happening and nobody has been told why — so it gets the same treatment
 * C10 gives: the broken one is the block that takes colour, what went
 * wrong is written underneath it, and the fix is a button beside it.
 *
 * The delivery log stays, because replaying one delivery is a real job
 * and a log is the right shape for it. "View log" filters it to the
 * endpoint you were looking at rather than making you find it again.
 */

const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';

/** What an endpoint is doing, in one word. */
function health(endpoint) {
  if (!endpoint.active) return { tone: 'plain', label: endpoint.when_inactive === 'queue' ? 'Off, holding' : 'Off, dropping' };
  if (endpoint.failed > 0) return { tone: 'late', label: 'Failing', icon: AlertTriangle };
  if (endpoint.pending > 0) return { tone: 'waiting', label: 'Retrying' };
  return { tone: 'settled', label: 'Healthy', icon: Check };
}

export default function Webhooks() {
  const toast = useToast();
  const { data, loading, refetch } = useFetch(() => api.raw('/webhooks'));
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState('');
  const deliveries = useFetch(
    () => api.raw(`/webhooks/deliveries?${new URLSearchParams({ ...(endpoint ? { endpoint_id: endpoint } : {}), ...(status ? { status } : {}) })}`),
    [endpoint, status]
  );
  const [form, setForm] = useState(null);
  const [secret, setSecret] = useState(null);
  const [removing, setRemoving] = useState(null);

  const rows = data?.data ?? [];
  const types = data?.event_types ?? [];
  const log = deliveries.data?.data ?? [];

  async function run(fn, ok) {
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); deliveries.refetch(); return r; }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); return null; }
  }
  async function save() {
    const body = { name: form.name, url: form.url, events: form.events, min_value: form.min_value === '' ? null : Number(form.min_value), sector: form.sector || null, include_personal_data: form.include_personal_data, when_inactive: form.when_inactive };
    const r = await run(() => (form.id ? api.raw(`/webhooks/${form.id}`, { method: 'PATCH', body }) : api.action('/webhooks', body)), 'Saved');
    if (r) { setForm(null); if (r.data.secret) setSecret({ name: r.data.name, secret: r.data.secret }); }
  }

  /** The newest delivery this endpoint made, out of the log we hold. */
  const lastDelivery = (row) => log.find((d) => d.endpoint === row.name) ?? null;

  return (
    <>
      <SettingsPane
        title="Webhooks"
        description="Signed POSTs to n8n or anything else when a record changes. Every call is signed; failures are retried for a day and then paused."
        actions={<>
          <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" asChild>
            <a href="https://github.com/CetizionVerifica/cetizion-tracker/blob/main/docs/webhooks-n8n.md" target="_blank" rel="noopener noreferrer">How to receive</a>
          </Button>
          <Button
            size="sm"
            className="h-8 px-4 text-[13px]"
            onClick={() => setForm({ name: '', url: 'https://', events: [], min_value: '', sector: '', include_personal_data: false, when_inactive: 'queue' })}
          >
            Add endpoint
          </Button>
        </>}
      >

        <div className="overflow-hidden rounded-[10px] border border-border bg-card">
          {loading && !data ? <div className="skeleton" style={{ height: 96, margin: 16 }} />
          : rows.length === 0 ? (
            <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">
              No endpoints yet. Add an n8n webhook URL and choose the events it should receive.
            </p>
          ) : rows.map((row, i) => {
            const state = health(row);
            const failing = state.tone === 'late';
            const last = lastDelivery(row);
            return (
              <div
                key={row.id}
                className={cn('p-4', i < rows.length - 1 && 'border-b border-border', failing && 'bg-late/[0.04]')}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{row.name}</span>
                  <Chip tone={state.tone} icon={state.icon}>{state.label}</Chip>
                </div>
                <div className="mono mt-1 text-[11.5px] break-words text-muted-foreground">{row.url}</div>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {row.events.map((event) => (
                    <span key={event} className="mono inline-flex h-[22px] items-center rounded-[6px] border border-[#33333a] bg-secondary px-2 text-[11px] font-medium text-secondary-text">
                      {event}
                    </span>
                  ))}
                </div>

                {failing ? (
                  /* Same move as the broken mailbox: the reason in a
                     sentence, under the thing it is about. */
                  <p className="mt-2 max-w-[70ch] text-[12.5px]/[1.6] text-secondary-text">
                    {number(row.failed)} deliver{row.failed === 1 ? 'y has' : 'ies have'} failed
                    {last?.last_status_code ? <> — the last answered <span className="mono">{last.last_status_code}</span></> : ''}
                    {last?.last_error ? `: ${last.last_error}` : ''}. Retrying for 24 hours, then paused.
                  </p>
                ) : (
                  <div className="mt-2 text-[12px] text-muted-foreground">
                    {last
                      ? <>Last delivery {ago(last.occurred_at)}{last.last_status_code ? ` · ${last.last_status_code}` : ''} · {number(row.succeeded)} delivered</>
                      : 'Nothing sent yet.'}
                    {row.pending ? ` · ${number(row.pending)} retrying` : ''}
                    {row.held ? ` · ${number(row.held)} held` : ''}
                  </div>
                )}

                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {failing && (
                    <Button size="sm" className={ROW_BUTTON} onClick={() => run(() => api.action('/webhooks/run'), (x) => `${number(x.data.delivered)} delivered`)}>
                      Retry now
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => run(() => api.action(`/webhooks/${row.id}/test`), (x) => (x.data.status === 'succeeded' ? `Test delivered (${x.data.code})` : `Test failed: ${x.data.error || x.data.code}`))}>
                    Send test
                  </Button>
                  <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setEndpoint(String(row.id))}>View log</Button>
                  <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setForm({ ...row, min_value: row.min_value ?? '', sector: row.sector || '' })}>Edit</Button>
                  <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => run(() => api.raw(`/webhooks/${row.id}`, { method: 'PATCH', body: { active: !row.active } }), row.active ? 'Turned off' : 'Turned on')}>
                    {row.active ? 'Turn off' : 'Turn on'}
                  </Button>
                  <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={async () => { const x = await run(() => api.action(`/webhooks/${row.id}/rotate-secret`)); if (x) setSecret({ name: row.name, secret: x.data.secret }); }}>
                    New secret
                  </Button>
                  <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`Delete ${row.name}`} onClick={() => setRemoving(row)}>✕</Button>
                </div>
              </div>
            );
          })}
        </div>

        <p className="max-w-[70ch] text-[11.5px]/[1.6] text-muted-foreground">
          Every payload is signed with <code className="mono">X-Cetizion-Signature</code>; the secret is shown once and
          can be rotated.
        </p>

        <RecordSection
          title="Deliveries"
          hint="the last 200 — a failed delivery can be sent again"
          action={
            <div className="flex flex-wrap items-center gap-2">
              <Select value={endpoint || 'all'} onValueChange={(v) => setEndpoint(v === 'all' ? '' : v)}>
                <SelectTrigger size="sm" className="h-7 text-[12.5px]" aria-label="Filter by endpoint"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-[12.5px]">All endpoints</SelectItem>
                  {rows.map((r) => <SelectItem key={r.id} value={String(r.id)} className="text-[12.5px]">{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={status || 'any'} onValueChange={(v) => setStatus(v === 'any' ? '' : v)}>
                <SelectTrigger size="sm" className="h-7 text-[12.5px]" aria-label="Filter by status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any" className="text-[12.5px]">Any status</SelectItem>
                  {['succeeded', 'pending', 'held', 'failed'].map((s) => <SelectItem key={s} value={s} className="text-[12.5px]">{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => run(() => api.action('/webhooks/run'), (x) => `${number(x.data.delivered)} delivered`)}>Send due now</Button>
            </div>
          }
        >
          {log.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] text-muted-foreground">Nothing sent yet.</p>
          ) : log.map((d, i) => (
            <div key={d.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-[12.5px]', i < log.length - 1 && 'border-b border-border')}>
              <span className="w-[150px] shrink-0 text-muted-foreground">{ago(d.occurred_at)}</span>
              <span className="mono w-[180px] shrink-0 truncate text-foreground">{d.event}</span>
              <span className="min-w-0 flex-1 truncate text-secondary-text">{d.endpoint}{d.entity_id ? ` · ${d.entity_id}` : ''}</span>
              <Chip tone={d.status === 'failed' ? 'late' : d.status === 'succeeded' ? 'settled' : 'waiting'}>{d.status}</Chip>
              <span className="w-[130px] shrink-0 truncate text-muted-foreground">
                {[d.last_status_code, d.last_error].filter(Boolean).join(' · ') || `${number(d.attempts)} tries`}
              </span>
              {(d.status === 'failed' || d.status === 'succeeded') && (
                <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => run(() => api.action(`/webhooks/deliveries/${d.id}/replay`), (x) => `Replayed: ${x.data.status}`)}>Replay</Button>
              )}
            </div>
          ))}
        </RecordSection>
      </SettingsPane>

      {form && (
        <Modal size="lg" title={form.id ? `Edit ${form.name}` : 'New endpoint'} onClose={() => setForm(null)}
          footer={<><Button variant="secondary" onClick={() => setForm(null)}>Cancel</Button><Button disabled={!form.name.trim() || !form.events.length} onClick={save}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="n8n: wins to Teams" /></Field>
            <Field label="URL" required hint="https only"><Input value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} /></Field>
            <div className="span-all"><Field label="Events" required>
              <div className="chips">{types.map((t) => <label key={t} className={`chip ${form.events.includes(t) ? 'is-on' : ''}`}><input type="checkbox" checked={form.events.includes(t)} onChange={() => setForm((f) => ({ ...f, events: f.events.includes(t) ? f.events.filter((x) => x !== t) : [...f.events, t] }))} /> {t}</label>)}</div>
            </Field></div>
            <Field label="Only values from" hint="Blank: any value"><Input type="number" min="0" value={form.min_value} onChange={(e) => setForm((f) => ({ ...f, min_value: e.target.value }))} /></Field>
            <Field label="Only this sector" hint="Blank: all sectors"><Input value={form.sector} onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))} /></Field>
            <Field label="Personal data"><LegacySelect value={form.include_personal_data ? 'yes' : 'no'} placeholder={null} options={[{ value: 'no', label: 'Leave out names, emails and phones' }, { value: 'yes', label: 'Include them' }]} onChange={(e) => setForm((f) => ({ ...f, include_personal_data: e.target.value === 'yes' }))} /></Field>
            <Field label="While turned off"><LegacySelect value={form.when_inactive} placeholder={null} options={[{ value: 'queue', label: 'Hold events, send them when back on' }, { value: 'drop', label: 'Drop them' }]} onChange={(e) => setForm((f) => ({ ...f, when_inactive: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
      {secret && (
        <Modal title={`Signing secret for ${secret.name}`} subtitle="Shown only now. Store it in n8n (for example as CETIZION_WEBHOOK_SECRET) to check each call." onClose={() => setSecret(null)}
          footer={<><Button variant="secondary" onClick={() => navigator.clipboard?.writeText(secret.secret).then(() => toast('Copied', 'success'))}>Copy</Button><Button onClick={() => setSecret(null)}>Done</Button></>}>
          <Alert tone="warning"><span>Anyone with this secret can forge calls that look like the tracker.</span></Alert>
          <Field label="Secret"><Input readOnly value={secret.secret} onFocus={(e) => e.target.select()} className="mono" /></Field>
        </Modal>
      )}
      {removing && <ConfirmDialog title={`Delete ${removing.name}?`} message="Its delivery history goes too." onConfirm={() => run(() => api.remove('webhooks', removing.id), 'Deleted').then(() => setRemoving(null))} onClose={() => setRemoving(null)} />}
    </>
  );
}
