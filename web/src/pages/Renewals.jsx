import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarSearch, Plus } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ConfirmDialog, DataTable, Field, Input, Modal, Textarea, useToast } from '../components/ui.jsx';
import { FailedCard, FilterSelect, plural, StateCard } from '../components/daily.jsx';
import { SalesViews, SummaryStrip, Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * Renewals (#28): what each client holds, when it comes round again, and
 * the renewal quotations opened for it. Fed by delivered POs whose
 * service renews; anything the tracker never saw delivered is added by hand.
 */
const STATUS = {
  active: { label: 'Active', tone: 'plain' },
  renewal_open: { label: 'Renewal open', tone: 'info' },
  renewed: { label: 'Renewed', tone: 'ok' },
  lapsed: { label: 'Lapsed', tone: 'late' },
  cancelled: { label: 'Stopped', tone: 'plain' },
};
const SHOW = [
  { value: 'active,renewal_open', label: 'Active and open' },
  { value: 'active', label: 'Active' },
  { value: 'renewal_open', label: 'Renewal open' },
  { value: 'renewed', label: 'Renewed' },
  { value: 'lapsed', label: 'Lapsed' },
  { value: 'cancelled', label: 'Stopped tracking' },
  { value: '', label: 'All engagements' },
];

export default function Renewals() {
  const toast = useToast();
  const lookups = useLookups();
  const [status, setStatus] = useState('active,renewal_open');
  const [due, setDue] = useState(null);   // 30 | 90: the strip's "due in" figures, over the active ones
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/renewals${status ? `?status=${status}` : ''}`), [status]);
  const all = data?.data ?? [];
  const rows = due ? all.filter((r) => r.days_to_due >= 0 && r.days_to_due <= due) : all;
  const t = data?.totals;

  async function run(path, body, ok) {
    setBusy(true);
    try { const { data: r } = await api.action(path, body); toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); return r; }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); return null; }
    finally { setBusy(false); }
  }

  // A figure filters the list to what it counts; pressing it again shows the default.
  const pick = (nextStatus, nextDue = null) => () => {
    const same = status === nextStatus && due === nextDue;
    setStatus(same ? 'active,renewal_open' : nextStatus);
    setDue(same ? null : nextDue);
  };
  const on = (s, d = null) => status === s && due === d;

  const dueCell = (r) => (
    <>
      {date(r.next_due_on)}
      {r.status !== 'renewed' && r.status !== 'cancelled' && r.days_to_due != null && (
        <span className="mt-1 block">
          <Tone tone={r.days_to_due < 0 ? 'late' : r.days_to_due <= 30 ? 'wait' : 'plain'}>
            {r.days_to_due < 0 ? `${plural(-r.days_to_due, 'day')} ago` : `in ${plural(r.days_to_due, 'day')}`}
          </Tone>
        </span>
      )}
    </>
  );
  const statusOf = (r) => STATUS[r.status] || { label: r.status.replace('_', ' '), tone: 'plain' };
  const acts = (r) => (
    <span className="app-rowacts">
      {r.status === 'active' && <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => run(`/renewals/${r.id}/open`, {}, (x) => `Renewal quotation ${x.quotation_no} drafted`)}>Open renewal</button>}
      {(r.status === 'active' || r.status === 'renewal_open') && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setCancelling(r)}>Stop tracking</button>}
    </span>
  );

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Renewals"
        subtitle="Recurring services and when they come round again. A renewal quotation opens ahead of the due date, with a task for the owner."
        nav={<SalesViews />}
        actions={<>
          <button type="button" className="mg-btn" disabled={busy} onClick={() => run('/renewals/discover', {}, (r) => `${r.length} new engagement${r.length === 1 ? '' : 's'} found`)}>
            <CalendarSearch className="size-4" strokeWidth={1.8} aria-hidden="true" />Find delivered work
          </button>
          <button type="button" className="mg-btn mg-btn--primary" onClick={() => setAdding(true)}>
            <Plus className="size-4" strokeWidth={2} aria-hidden="true" />New engagement
          </button>
        </>}
      />
      <div className="app-page">
        {(t || loading) && !error && (
          <SummaryStrip
            label="Renewals at a glance"
            loading={!t}
            tiles={[
              { key: 'active', label: 'Active', figure: t?.active, foot: 'tracked engagements', onClick: pick('active'), pressed: on('active') },
              { key: 'd30', label: 'Due in 30 days', figure: t?.due_30, tone: t?.due_30 > 0 ? 'wait' : undefined, foot: 'act on these now', onClick: pick('active,renewal_open', 30), pressed: on('active,renewal_open', 30) },
              { key: 'd90', label: 'Due in 90 days', figure: t?.due_90, foot: 'renewal opens soon', onClick: pick('active,renewal_open', 90), pressed: on('active,renewal_open', 90) },
              { key: 'open', label: 'Renewals open', figure: t?.open, foot: 'quotation drafted', onClick: pick('renewal_open'), pressed: on('renewal_open') },
              { key: 'renewed', label: 'Renewed', figure: t?.renewed, tone: t?.renewed > 0 ? 'ok' : undefined, foot: 'came round and renewed', onClick: pick('renewed'), pressed: on('renewed') },
              { key: 'lapsed', label: 'Lapsed', figure: t?.lapsed, tone: t?.lapsed > 0 ? 'late' : undefined, foot: 'due date passed', onClick: pick('lapsed'), pressed: on('lapsed') },
            ]}
          />
        )}

        {error ? (
          <FailedCard title="Couldn't load the engagements" text={error} onRetry={refetch} />
        ) : (
          <section className="mg-glass mg-glass--strong app-panel" aria-labelledby="eng-title" data-a="rise">
            <div className="app-panel__head">
              <div className="app-panel__titles">
                <h2 id="eng-title" className="mg-panel__title">Engagements</h2>
                <span className="mg-panel__hint">Each is one client holding one service for one cycle. Its renewal opens when the due date is within the service’s lead time.</span>
              </div>
              <div className="app-panel__tools">
                {due && <button type="button" className="mg-chip" aria-pressed="true" aria-label={`Due in ${due} days. Remove this filter`} onClick={() => setDue(null)}>Due in {due} days ×</button>}
                <FilterSelect label="Show" value={status} onChange={(v) => { setStatus(v); setDue(null); }} options={SHOW} width={190} />
              </div>
            </div>
            <DataTable
              rows={rows}
              loading={loading && !data}
              label="Engagements"
              phone={(r) => (
                <div className="mg-row">
                  <span className="mg-row__title" style={{ whiteSpace: 'normal' }}>{r.company_id ? <Link to={`/companies/${r.company_id}`} className="text-inherit no-underline">{r.company_name || r.client_name}</Link> : r.client_name}</span>
                  <span className="mg-row__amount">{date(r.next_due_on)}</span>
                  <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{r.service_name} · cycle {r.cycle}{r.owner && <> · {r.owner}</>}{r.renewal_quotation_no && <> · {r.renewal_quotation_no}</>}</span>
                  <span className="mg-row__state"><Tone tone={statusOf(r).tone}>{statusOf(r).label}</Tone></span>
                  {(r.status === 'active' || r.status === 'renewal_open') && <span className="col-span-2 mt-2 flex justify-end">{acts(r)}</span>}
                </div>
              )}
              columns={[
                { key: 'client', header: 'Client', className: 'strong', render: (r) => (r.company_id ? <Link className="font-bold text-foreground no-underline" to={`/companies/${r.company_id}`}>{r.company_name || r.client_name}</Link> : r.client_name) },
                { key: 'service_name', header: 'Service', className: 'wrap', min: 160, render: (r) => <>{r.service_name}<span className="app-sub">cycle {r.cycle}{r.renewal_interval_months ? ` · every ${r.renewal_interval_months} months` : ''}</span></> },
                { key: 'from', header: 'From', render: (r) => (r.po_number || r.original_quotation_no ? <>{r.po_number && <Link className="app-ref" to={`/purchase-orders/${encodeURIComponent(r.po_number)}`}>{r.po_number}</Link>}{r.original_quotation_no && <span className="app-sub"><Link className="text-muted-foreground" to={`/quotations/${encodeURIComponent(r.original_quotation_no)}`}>{r.original_quotation_no}</Link></span>}</> : <span className="text-muted-foreground">Added by hand</span>) },
                { key: 'next_due_on', header: 'Due', render: dueCell },
                { key: 'status', header: 'Status', render: (r) => <Tone tone={statusOf(r).tone}>{statusOf(r).label}</Tone> },
                { key: 'renewal', header: 'Renewal quotation', render: (r) => (r.renewal_quotation_no ? <><Link className="app-ref" to={`/quotations/${encodeURIComponent(r.renewal_quotation_no)}`}>{r.renewal_quotation_no}</Link><span className="app-sub">{r.renewal_status}{r.renewal_value ? ` · ${money(r.renewal_value, r.renewal_currency)}` : ''}</span></> : <span className="text-muted-foreground">—</span>) },
                { key: 'owner', header: 'Owner', render: (r) => r.owner || <span className="text-muted-foreground">—</span> },
                { key: 'act', header: '', align: 'right', render: acts },
              ]}
              empty={due || status !== 'active,renewal_open' ? (
                <StateCard inPanel tone="plain" title="Nothing matches that" text={due ? `No engagement is due in the next ${due} days.` : `No engagement is ${SHOW.find((s) => s.value === status)?.label.toLowerCase() || 'in that state'}.`}>
                  <button type="button" className="mg-btn mg-btn--sm" onClick={() => { setStatus('active,renewal_open'); setDue(null); }}>Show active and open</button>
                </StateCard>
              ) : (
                <StateCard inPanel tone="plain" title="No engagements yet" text="Set a renewal interval on the services in the catalogue, then press Find delivered work; or add a client's current certificate or rating by hand.">
                  <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setAdding(true)}><Plus className="size-4" aria-hidden="true" />New engagement</button>
                </StateCard>
              )}
            />
          </section>
        )}
      </div>
      {adding && <ManualDialog lookups={lookups} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refetch(); }} />}
      {cancelling && (
        <ConfirmDialog
          title={`Stop tracking ${cancelling.company_name || cancelling.client_name}'s ${cancelling.service_name}?`}
          message="No renewal will be opened for it, and it moves to Stopped tracking. It can be added again later."
          confirmLabel="Stop tracking"
          cancelLabel="Keep tracking"
          busy={busy}
          onConfirm={async () => { if (await run(`/renewals/${cancelling.id}/cancel`, {}, 'Stopped tracking it')) setCancelling(null); }}
          onClose={() => setCancelling(null)}
        />
      )}
    </>
  );
}

function ManualDialog({ lookups, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState({ client_name: '', service_name: '', valid_until: '', owner: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [failed, setFailed] = useState(null);
  const set = (k, val) => { setV((s) => ({ ...s, [k]: val })); setErrors((e) => ({ ...e, [k]: undefined })); };
  async function save(e) {
    e.preventDefault(); setBusy(true); setFailed(null);
    const missing = Object.fromEntries([['client_name', 'Name the client'], ['service_name', 'Name the service'], ['valid_until', 'Say when it expires or is next due']].filter(([k]) => !String(v[k]).trim()));
    if (Object.keys(missing).length) { setErrors(missing); setBusy(false); return; }
    try { await api.action('/renewals/manual', v); toast('Engagement added', 'success'); onSaved(); }
    catch (err) { setErrors(err.fields || {}); setFailed(err.fields ? 'Some fields need a look.' : err.message); setBusy(false); }
  }
  return (
    <Modal title="Add an engagement" subtitle="A certificate or rating the client already holds, so its renewal is tracked from now on." onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="engagement-form" className="mg-btn mg-btn--primary" disabled={busy}>{busy ? 'Adding…' : 'Add engagement'}</button>
    </>}>
      <form id="engagement-form" onSubmit={save} className="form-grid" noValidate>
        {failed && <div className="span-all mg-banner mg-banner--late" role="alert"><div className="mg-banner__body"><strong>Couldn't add it.</strong>{failed}</div></div>}
        <Field label="Client" required error={errors.client_name}><Input list="eng-clients" value={v.client_name} error={errors.client_name} onChange={(e) => set('client_name', e.target.value)} /><datalist id="eng-clients">{lookups.clients.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Service" required error={errors.service_name}><Input list="eng-services" value={v.service_name} error={errors.service_name} onChange={(e) => set('service_name', e.target.value)} /><datalist id="eng-services">{lookups.services.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Valid until" required hint="When it expires or is next due" error={errors.valid_until}><Input type="date" value={v.valid_until} error={errors.valid_until} onChange={(e) => set('valid_until', e.target.value)} /></Field>
        <Field label="Owner"><Input list="eng-people" value={v.owner} onChange={(e) => set('owner', e.target.value)} /><datalist id="eng-people">{lookups.sales_people.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <div className="span-all"><Field label="Notes"><Textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field></div>
      </form>
    </Modal>
  );
}
