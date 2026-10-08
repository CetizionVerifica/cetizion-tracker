import { useState } from 'react';
import { CircleHelp, Copy, Plus } from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, Field, Input, Modal, useToast } from '../components/ui.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard } from '../components/daily.jsx';
import { DialogError, MoneyBanner } from '../components/money.jsx';
import { MoreMenu, Tone } from '../components/sales.jsx';
import { RowActions } from '../components/settings.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';
import { turnedOnMessage } from '../lib/webhookToggle.js';

/**
 * Webhooks (#49), Wave 8.
 *
 * An endpoint that has stopped is a block that takes colour, with what went
 * wrong written under it and the fix beside it. Rarely-used actions (turn
 * off, new signing secret, delete) sit in a More menu, and the two that
 * break a working flow ask first. The delivery log has its filters in a bar,
 * statuses in words, and an empty filtered state that offers Clear filters.
 */

const STATUS = { succeeded: 'Delivered', pending: 'Waiting', held: 'Held', failed: 'Failed' };
const STATUS_TONE = { succeeded: 'ok', pending: 'wait', held: 'plain', failed: 'late' };

/** What an endpoint is doing, in words. */
function health(endpoint) {
  if (!endpoint.active) return { tone: 'plain', label: endpoint.when_inactive === 'queue' ? 'Off, holding' : 'Off, dropping' };
  if (endpoint.failed > 0) return { tone: 'late', label: 'Failing' };
  if (endpoint.pending > 0) return { tone: 'wait', label: 'Retrying' };
  return { tone: 'ok', label: 'Healthy' };
}

export default function Webhooks() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/webhooks'));
  const [endpoint, setEndpoint] = useState('');
  const [status, setStatus] = useState('');
  const deliveries = useFetch(
    () => api.raw(`/webhooks/deliveries?${new URLSearchParams({ ...(endpoint ? { endpoint_id: endpoint } : {}), ...(status ? { status } : {}) })}`),
    [endpoint, status]
  );
  const [form, setForm] = useState(null);
  const [formError, setFormError] = useState(null);
  const [secret, setSecret] = useState(null);
  const [confirm, setConfirm] = useState(null); // { kind: 'delete' | 'off' | 'rotate', row }
  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);

  const rows = data?.data ?? [];
  const types = data?.event_types ?? [];
  const log = deliveries.data?.data ?? [];

  async function run(fn, ok) {
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); deliveries.refetch(); return r; }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); return null; }
  }
  async function save() {
    setBusy(true);
    setFormError(null);
    const body = { name: form.name, url: form.url, events: form.events, min_value: form.min_value === '' ? null : Number(form.min_value), sector: form.sector || null, include_personal_data: form.include_personal_data, when_inactive: form.when_inactive };
    try {
      const r = await (form.id ? api.raw(`/webhooks/${form.id}`, { method: 'PATCH', body }) : api.action('/webhooks', body));
      toast('Saved', 'success');
      refetch(); deliveries.refetch();
      setForm(null);
      if (r.data.secret) setSecret({ name: r.data.name, secret: r.data.secret });
    } catch (err) {
      setFormError(err.fields ? Object.values(err.fields)[0] : err.message);
    } finally { setBusy(false); }
  }
  async function confirmed() {
    const { kind, row } = confirm;
    setBusy(true);
    if (kind === 'delete') await run(() => api.remove('webhooks', row.id), `${row.name} deleted`);
    if (kind === 'off') await run(() => api.raw(`/webhooks/${row.id}`, { method: 'PATCH', body: { active: false } }), `${row.name} is off`);
    if (kind === 'rotate') { const x = await run(() => api.action(`/webhooks/${row.id}/rotate-secret`)); if (x) setSecret({ name: row.name, secret: x.data.secret }); }
    setBusy(false);
    setConfirm(null);
  }

  /** The newest delivery this endpoint made, out of the log we hold. */
  const lastDelivery = (row) => log.find((d) => d.endpoint === row.name) ?? null;
  const newForm = () => { setFormError(null); setForm({ name: '', url: 'https://', events: [], min_value: '', sector: '', include_personal_data: false, when_inactive: 'queue' }); };
  const filtered = endpoint || status;
  const sendDue = () => run(() => api.action('/webhooks/run'), (x) => `${number(x.data.delivered)} delivered`);

  const statusLine = (row, last) => {
    const s = health(row);
    if (s.tone === 'late') {
      return `${number(row.failed)} deliver${row.failed === 1 ? 'y has' : 'ies have'} failed${last?.last_status_code ? `. The last answered ${last.last_status_code}${last.last_error ? `: ${last.last_error}` : ''}` : last?.last_error ? `: ${last.last_error}` : ''}. Retrying for 24 hours, then paused.`;
    }
    if (!row.active) return `Turned off${row.held ? ` · ${number(row.held)} held, sent when it’s turned back on` : ''}`;
    return [last ? `Last delivery ${ago(last.occurred_at)}${last.last_status_code ? ` · ${last.last_status_code}` : ''}` : 'Nothing sent yet', `${number(row.succeeded)} delivered`, row.pending && `${number(row.pending)} retrying`, row.held && `${number(row.held)} held`].filter(Boolean).join(' · ');
  };

  return (
    <>
      <SettingsPane
        title="Webhooks"
        description="Signed calls to n8n or anything else when a record changes. Failures are retried for a day, then paused."
        actions={<>
          <button type="button" className="mg-btn" onClick={() => setGuide(true)}><CircleHelp className="size-4" aria-hidden="true" />How to receive</button>
          <button type="button" className="mg-btn mg-btn--primary" onClick={newForm}><Plus className="size-4" aria-hidden="true" />Add endpoint</button>
        </>}
      >
        {error ? <FailedCard title="Couldn’t load webhooks" text="The server didn’t answer, so nothing is shown. Nothing has changed. Try again in a moment." onRetry={refetch} />
        : loading && !data ? <LoadingPanel rows={3} />
        : rows.length === 0 ? (
          <StateCard tone="plain" title="No endpoints yet" text="Add an n8n webhook address and choose the events it should receive.">
            <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={newForm}>Add endpoint</button>
          </StateCard>
        ) : (
          <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="set-ep">
            <div className="app-panel__head"><div className="app-panel__titles"><h2 className="mg-panel__title" id="set-ep">Endpoints</h2><span className="mg-panel__hint">Every call is signed with X-Cetizion-Signature; the secret is shown once and can be replaced.</span></div></div>
            {rows.map((row) => {
              const s = health(row);
              const failing = s.tone === 'late';
              const last = lastDelivery(row);
              return (
                <div key={row.id} className={cn('set-ep', failing && 'is-failing')}>
                  <div className="set-ep__head"><h3>{row.name}</h3><Tone tone={s.tone}>{s.label}</Tone></div>
                  <div className="set-ep__url">{row.url}</div>
                  <div className="flex flex-wrap gap-1.5">{row.events.map((ev) => <span key={ev} className="mg-badge mg-badge--plain">{ev}</span>)}</div>
                  <div className={cn('set-ep__status', failing && 'is-late')}>{statusLine(row, last)}</div>
                  <div className="set-ep__acts">
                    {failing && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" aria-label={`Retry the failed deliveries to ${row.name}`} onClick={sendDue}>Retry now</button>}
                    {!row.active && <button type="button" className="mg-btn mg-btn--sm" aria-label={`Turn on ${row.name}`} onClick={() => run(() => api.raw(`/webhooks/${row.id}`, { method: 'PATCH', body: { active: true } }), (x) => turnedOnMessage(x.data?.released))}>Turn on</button>}
                    <button type="button" className="mg-btn mg-btn--sm" aria-label={`Send a test to ${row.name}`} onClick={() => run(() => api.action(`/webhooks/${row.id}/test`), (x) => (x.data.status === 'succeeded' ? `Test delivered (${x.data.code})` : `Test failed: ${x.data.error || x.data.code}`))}>Send test</button>
                    <button type="button" className="mg-btn mg-btn--sm" aria-label={`Show the deliveries to ${row.name}`} onClick={() => setEndpoint(String(row.id))}>View log</button>
                    <button type="button" className="mg-btn mg-btn--sm" aria-label={`Edit ${row.name}`} onClick={() => { setFormError(null); setForm({ ...row, min_value: row.min_value ?? '', sector: row.sector || '' }); }}>Edit</button>
                    <MoreMenu size="sm" label={`More for ${row.name}`} items={[
                      row.active && { label: 'Turn off', onSelect: () => setConfirm({ kind: 'off', row }) },
                      { label: 'New signing secret', onSelect: () => setConfirm({ kind: 'rotate', row }) },
                      { label: 'Delete endpoint', danger: true, onSelect: () => setConfirm({ kind: 'delete', row }) },
                    ]} />
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {!error && rows.length > 0 && (
          <Panel
            id="set-dlv"
            title="Deliveries"
            hint="The last 200, newest first. A failed or delivered one can be sent again."
            tools={
              <div className="set-tools">
                <span className="mg-select-wrap">
                  <select className="mg-select" aria-label="Filter by endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
                    <option value="">All endpoints</option>
                    {rows.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
                  </select>
                </span>
                <span className="mg-select-wrap">
                  <select className="mg-select" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="">Any status</option>
                    {Object.entries(STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </span>
                <button type="button" className="mg-btn mg-btn--sm" onClick={sendDue}>Send due now</button>
              </div>
            }
          >
            {deliveries.error ? (
              <StateCard inPanel tone="late" title="Couldn’t load the deliveries" text={deliveries.error}><button type="button" className="mg-btn mg-btn--sm" onClick={deliveries.refetch}>Try again</button></StateCard>
            ) : log.length === 0 ? (
              filtered ? (
                <StateCard inPanel tone="plain" title="No deliveries match these filters" text="Nothing in the last 200 fits them. Clear the filters to see everything.">
                  <button type="button" className="mg-btn mg-btn--sm" onClick={() => { setEndpoint(''); setStatus(''); }}>Clear filters</button>
                </StateCard>
              ) : <p className="app-panel__note">Nothing sent yet.</p>
            ) : (
              <ListTable
                label="Deliveries"
                rows={log}
                columns={[
                  { key: 'when', header: 'When', width: '120px', render: (d) => <span className="whitespace-nowrap text-secondary-text">{ago(d.occurred_at)}</span> },
                  { key: 'event', header: 'Event', render: (d) => <b>{d.event}</b> },
                  { key: 'endpoint', header: 'Endpoint · record', className: 'app-wrap--sm', render: (d) => `${d.endpoint}${d.entity_id ? ` · ${d.entity_id}` : ''}` },
                  { key: 'status', header: 'Status', render: (d) => <Tone tone={STATUS_TONE[d.status]}>{STATUS[d.status] || d.status}</Tone> },
                  { key: 'answer', header: 'Answer', className: 'app-say', render: (d) => <span className={d.status === 'failed' ? 'text-late' : undefined}>{[d.last_status_code, d.last_error].filter(Boolean).join(' · ') || `${number(d.attempts)} ${Number(d.attempts) === 1 ? 'try' : 'tries'}`}</span> },
                  { key: 'act', header: '', className: 'actions', render: (d) => (d.status === 'failed' || d.status === 'succeeded') && (
                    <RowActions><button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Send ${d.event} to ${d.endpoint} again`} onClick={() => run(() => api.action(`/webhooks/deliveries/${d.id}/replay`), (x) => `Replayed: ${STATUS[x.data.status] || x.data.status}`)}>Replay</button></RowActions>
                  ) },
                ]}
                phone={(d) => (
                  <PhoneRow title={d.event} amount={ago(d.occurred_at)} meta={[`${d.endpoint}${d.entity_id ? ` · ${d.entity_id}` : ''}`, [d.last_status_code, d.last_error].filter(Boolean).join(' · ')].filter(Boolean).join(' · ')} state={<Tone tone={STATUS_TONE[d.status]}>{STATUS[d.status] || d.status}</Tone>} wraps>
                    {(d.status === 'failed' || d.status === 'succeeded') && <span className="set-rowacts"><button type="button" className="mg-btn mg-btn--sm" onClick={() => run(() => api.action(`/webhooks/deliveries/${d.id}/replay`), (x) => `Replayed: ${STATUS[x.data.status] || x.data.status}`)}>Replay</button></span>}
                  </PhoneRow>
                )}
              />
            )}
          </Panel>
        )}
      </SettingsPane>

      {form && (
        <Modal size="lg" title={form.id ? `Edit ${form.name}` : 'New endpoint'} subtitle={form.id ? health(form).label : 'Signed calls when the events you pick happen'} onClose={() => setForm(null)}
          footer={<><button type="button" className="mg-btn mg-btn--ghost" onClick={() => setForm(null)} disabled={busy}>Cancel</button><button type="button" className="mg-btn mg-btn--primary" disabled={busy || !form.name.trim() || !form.events.length} onClick={save}>{busy ? 'Saving…' : form.id ? 'Save changes' : 'Add endpoint'}</button></>}>
          <div className="form-grid">
            {formError && <div className="span-all"><DialogError error={formError} what="the endpoint" /></div>}
            <Field label="Name" required><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="n8n: wins to Teams" /></Field>
            <Field label="URL" required hint="https only."><Input type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} /></Field>
            <div className="span-all"><Field as="div" label="Events" required hint="Pick at least one. Each call names its event.">
              <div className="set-chips" role="group" aria-label="Events">{types.map((t) => (
                <button key={t} type="button" className="mg-chip" aria-pressed={form.events.includes(t)} onClick={() => setForm((f) => ({ ...f, events: f.events.includes(t) ? f.events.filter((x) => x !== t) : [...f.events, t] }))}>{t}</button>
              ))}</div>
            </Field></div>
            <Field label="Only values from" hint="Blank: any value."><Input type="number" min="0" value={form.min_value} onChange={(e) => setForm((f) => ({ ...f, min_value: e.target.value }))} /></Field>
            <Field label="Only this sector" hint="Blank: all sectors."><Input value={form.sector} placeholder="All sectors" onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))} /></Field>
            <div className="span-all"><Field as="div" label="Personal data">
              <div className="set-radios" role="radiogroup" aria-label="Personal data">
                {[[false, 'Leave out names, emails and phones'], [true, 'Include them']].map(([v, l]) => <label key={l} className="set-radio"><input type="radio" name="wh-pd" checked={form.include_personal_data === v} onChange={() => setForm((f) => ({ ...f, include_personal_data: v }))} /><span><b>{l}</b></span></label>)}
              </div>
            </Field></div>
            <div className="span-all"><Field as="div" label="While turned off">
              <div className="set-radios" role="radiogroup" aria-label="While turned off">
                {[['queue', 'Hold events, and send them when it’s back on'], ['drop', 'Drop them']].map(([v, l]) => <label key={v} className="set-radio"><input type="radio" name="wh-off" checked={form.when_inactive === v} onChange={() => setForm((f) => ({ ...f, when_inactive: v }))} /><span><b>{l}</b></span></label>)}
              </div>
            </Field></div>
          </div>
        </Modal>
      )}
      {secret && (
        <Modal title={`Signing secret for ${secret.name}`} subtitle="Shown only now. Store it in n8n, for example as CETIZION_WEBHOOK_SECRET, to check each call." onClose={() => setSecret(null)}
          footer={<><button type="button" className="mg-btn" onClick={() => navigator.clipboard?.writeText(secret.secret).then(() => toast('Copied', 'success'))}><Copy className="size-4" aria-hidden="true" />Copy secret</button><button type="button" className="mg-btn mg-btn--primary" onClick={() => setSecret(null)}>Done</button></>}>
          <div className="flex flex-col gap-4">
            <MoneyBanner tone="wait" title="Keep it private.">{' '}Anyone with this secret can forge calls that look like they came from the tracker.</MoneyBanner>
            <Field as="div" label="Secret"><span className="set-secret">{secret.secret}</span></Field>
          </div>
        </Modal>
      )}
      {guide && (
        <Modal title="Receiving these in n8n" subtitle="Four steps, about ten minutes" onClose={() => setGuide(false)} footer={<button type="button" className="mg-btn mg-btn--primary" onClick={() => setGuide(false)}>Done</button>}>
          <ol className="set-steps">
            <li><b>1. Add a Webhook node</b><span>Method POST. Copy its production URL.</span></li>
            <li><b>2. Add the endpoint here</b><span>Paste the URL, pick the events and save. Copy the signing secret: it’s shown once.</span></li>
            <li><b>3. Check the signature</b><span>In a Code node, make an HMAC-SHA256 of the raw body with the secret and compare it with the X-Cetizion-Signature header. Drop the call if they differ.</span></li>
            <li><b>4. Send a test</b><span>Use Send test here. The delivery shows in the log with n8n’s answer.</span></li>
          </ol>
          <p className="mt-3 mb-0 text-[12.5px] text-secondary-text">The full guide is in <a className="set-link" href="https://github.com/CetizionVerifica/cetizion-tracker/blob/main/docs/webhooks-n8n.md" target="_blank" rel="noopener noreferrer">docs/webhooks-n8n.md</a>.</p>
        </Modal>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === 'delete' ? `Delete ${confirm.row.name}?` : confirm.kind === 'off' ? `Turn off ${confirm.row.name}?` : `Replace the signing secret for ${confirm.row.name}?`}
          subtitle={confirm.kind === 'delete' ? `${confirm.row.events.length} event${confirm.row.events.length === 1 ? '' : 's'} · ${health(confirm.row).label.toLowerCase()}` : confirm.kind === 'off' ? (confirm.row.when_inactive === 'queue' ? 'Set to hold events while off' : 'Set to drop events while off') : 'The old secret stops working at once'}
          message={confirm.kind === 'delete' ? `Its delivery history goes too${confirm.row.pending ? `, including the ${number(confirm.row.pending)} deliveries still waiting to retry` : ''}.`
            : confirm.kind === 'off' ? (confirm.row.when_inactive === 'queue' ? 'New events are held and sent when you turn it back on.' : 'New events are dropped while it’s off; nothing is sent later.')
            : 'n8n will reject calls until you paste the new secret there. The new one is shown once, next.'}
          tone={confirm.kind === 'delete' ? 'danger' : 'neutral'}
          confirmLabel={confirm.kind === 'delete' ? 'Delete endpoint' : confirm.kind === 'off' ? 'Turn off' : 'Replace secret'}
          cancelLabel={confirm.kind === 'off' ? 'Keep it on' : confirm.kind === 'delete' ? 'Keep it' : 'Cancel'}
          busy={busy}
          onConfirm={confirmed}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}
