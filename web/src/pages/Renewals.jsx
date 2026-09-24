import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, ConfirmDialog, DataTable, Empty, Field, Input, Modal, Select, Stat, Textarea, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * Renewals (#28): what each client holds, when it comes round again, and
 * the renewal quotations opened for it. Fed by delivered POs whose
 * service renews; anything the tracker never saw delivered is added by hand.
 */
export default function Renewals() {
  const toast = useToast();
  const lookups = useLookups();
  const [status, setStatus] = useState('active,renewal_open');
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/renewals${status ? `?status=${status}` : ''}`), [status]);
  const rows = data?.data ?? [];
  const t = data?.totals;

  async function run(path, body, ok) {
    setBusy(true);
    try { const { data: r } = await api.action(path, body); toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); return r; }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); return null; }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader
        title="Renewals"
        subtitle="Recurring services and when they come round again. A renewal quotation opens ahead of the due date, with a task for the owner."
        actions={<><button type="button" className="btn" disabled={busy} onClick={() => run('/renewals/discover', {}, (r) => `${r.length} new engagement${r.length === 1 ? '' : 's'} found`)}>Find delivered work</button><button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>+ Engagement</button></>}
      />
      <div className="page stack">
        {error && <Alert tone="danger"><span>{error}</span></Alert>}
        {t && (
          <div className="auto-grid--stats">
            <Stat label="Active" value={t.active} meta="tracked engagements" />
            <Stat label="Due in 30 days" value={t.due_30} tone={t.due_30 > 0 ? 'warn' : ''} />
            <Stat label="Due in 90 days" value={t.due_90} />
            <Stat label="Renewals open" value={t.open} meta="quotation drafted" />
            <Stat label="Renewed" value={t.renewed} />
            <Stat label="Lapsed" value={t.lapsed} tone={t.lapsed > 0 ? 'danger' : ''} />
          </div>
        )}
        <Card flush title="Engagements" hint="Each is one client holding one service for one cycle. Renewal opens when the due date is within the service's lead time." actions={
          <div className="card__actions">
            <Select value={status} placeholder="All" options={[{ value: 'active,renewal_open', label: 'Active and open' }, { value: 'active', label: 'Active' }, { value: 'renewal_open', label: 'Renewal open' }, { value: 'renewed', label: 'Renewed' }, { value: 'lapsed', label: 'Lapsed' }, { value: 'cancelled', label: 'Cancelled' }]} onChange={(e) => setStatus(e.target.value)} />
          </div>
        }>
          <DataTable
            rows={rows}
            loading={loading && !data}
            columns={[
              { key: 'client', header: 'Client', className: 'strong', render: (r) => (r.company_id ? <Link to={`/companies/${r.company_id}`}>{r.company_name || r.client_name}</Link> : r.client_name) },
              { key: 'service_name', header: 'Service', className: 'wrap', render: (r) => <>{r.service_name}<div className="small muted">cycle {r.cycle}{r.renewal_interval_months ? ` · every ${r.renewal_interval_months} months` : ''}</div></> },
              { key: 'from', header: 'From', className: 'mono small', render: (r) => <>{r.po_number && <Link to={`/purchase-orders/${encodeURIComponent(r.po_number)}`}>{r.po_number}</Link>}{r.original_quotation_no && <div><Link to={`/quotations/${encodeURIComponent(r.original_quotation_no)}`}>{r.original_quotation_no}</Link></div>}</> },
              { key: 'next_due_on', header: 'Due', render: (r) => <>{date(r.next_due_on)}<div className="small" style={{ color: r.days_to_due < 0 ? 'var(--danger-fg)' : r.days_to_due <= 30 ? 'var(--warn-fg)' : undefined }}>{r.days_to_due < 0 ? `${-r.days_to_due} days ago` : `in ${r.days_to_due} days`}</div></> },
              { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status === 'renewed' ? 'success' : r.status === 'renewal_open' ? 'info' : r.status === 'lapsed' ? 'danger' : r.status === 'cancelled' ? 'neutral' : 'warning'}>{r.status.replace('_', ' ')}</Badge> },
              { key: 'renewal', header: 'Renewal quotation', render: (r) => (r.renewal_quotation_no ? <><Link className="mono" to={`/quotations/${encodeURIComponent(r.renewal_quotation_no)}`}>{r.renewal_quotation_no}</Link><div className="small muted">{r.renewal_status}{r.renewal_value ? ` · ${money(r.renewal_value, r.renewal_currency)}` : ''}</div></> : <span className="muted">—</span>) },
              { key: 'owner', header: 'Owner', render: (r) => r.owner || <span className="muted">—</span> },
              { key: 'act', header: '', align: 'right', render: (r) => <div className="table__actions">{r.status === 'active' && <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => run(`/renewals/${r.id}/open`, {}, (x) => `Renewal quotation ${x.quotation_no} drafted`)}>Open renewal</button>}{(r.status === 'active' || r.status === 'renewal_open') && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setCancelling(r)}>Cancel</button>}</div> },
            ]}
            empty={<Empty title="No engagements yet" text="Set a renewal interval on the services in the catalogue, then press Find delivered work; or add a client's current certificate or rating by hand." action={<button type="button" className="btn btn--primary" onClick={() => setAdding(true)}>+ Engagement</button>} />}
          />
        </Card>
      </div>
      {adding && <ManualDialog lookups={lookups} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refetch(); }} />}
      {cancelling && <ConfirmDialog title={`Stop tracking ${cancelling.client_name}'s ${cancelling.service_name}?`} message="No renewal will be opened for it. This can be added again later." confirmLabel="Cancel engagement" busy={busy} onConfirm={async () => { if (await run(`/renewals/${cancelling.id}/cancel`, {}, 'Engagement cancelled')) setCancelling(null); }} onClose={() => setCancelling(null)} />}
    </>
  );
}

function ManualDialog({ lookups, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState({ client_name: '', service_name: '', valid_until: '', owner: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try { await api.action('/renewals/manual', v); toast('Engagement added', 'success'); onSaved(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title="Add an engagement" subtitle="A certificate or rating the client already holds, so its renewal is tracked from now on." onClose={onClose} footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="engagement-form" className="btn btn--primary" disabled={busy}>Save</button></>}>
      <form id="engagement-form" onSubmit={save} className="form-grid">
        <Field label="Client" required><Input list="eng-clients" value={v.client_name} onChange={(e) => set('client_name', e.target.value)} /><datalist id="eng-clients">{lookups.clients.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Service" required><Input list="eng-services" value={v.service_name} onChange={(e) => set('service_name', e.target.value)} /><datalist id="eng-services">{lookups.services.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Valid until" required hint="When it expires or is next due"><Input type="date" value={v.valid_until} onChange={(e) => set('valid_until', e.target.value)} /></Field>
        <Field label="Owner"><Input list="eng-people" value={v.owner} onChange={(e) => set('owner', e.target.value)} /><datalist id="eng-people">{lookups.sales_people.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <div className="span-all"><Field label="Notes"><Textarea rows={2} value={v.notes} onChange={(e) => set('notes', e.target.value)} /></Field></div>
      </form>
    </Modal>
  );
}
