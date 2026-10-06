import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, ConfirmDialog, ErrorState, Field, Input, Modal, Select, Stat, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { TravelDocumentsUpload } from '../components/TravelDocumentsUpload.jsx';
import { Checkbox } from '../components/ui/checkbox.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.js';
import { date, money, number } from '../lib/format.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * The review of a travel import (#196 §5.1 step 3): what each tab's columns
 * were read as, the travellers, the trips with their legs, the agency's
 * invoices with their lines, and the credit notes, each with its flags.
 * Red blocks the commit, amber asks for a look, blue says what was decided,
 * and a record already in the tracker (a yellow row) is kept unless "update"
 * is chosen. The filters and colours are the sales importer's (§5.1), and the
 * last step is the Summary, where the commit is.
 */

const FIELD_LABELS = {
  journey_date: 'Date of journey', traveller: 'Traveller', from_place: 'From', to_place: 'To', provider: 'Airline, railway, cab or hotel',
  mode: 'Mode', base_fare: 'Fare', service_charge: 'Service charge', gst_amount: 'GST', line_total: 'Total', booking_date: 'Booked on',
  trip_type: 'Trip type', client_name: 'Client', po_no: 'PO number', invoice_no: 'Agency invoice number', service_request_no: 'Service request no.',
  remarks: 'Remarks', credit_note_no: 'Credit note number', against_invoice: 'Against invoice', check_in: 'Check-in', check_out: 'Check-out',
  pnr: 'PNR or booking ref', travel_id: 'Travel ID', project_id: 'Project ID',
};
const FIELD_OPTIONS = [{ value: 'ignore', label: 'Not read' }, ...Object.entries(FIELD_LABELS).map(([value, label]) => ({ value, label }))];
const TONES = { red: 'late', amber: 'waiting', blue: 'info', duplicate: 'plain' };
const MODES = ['flight', 'train', 'bus', 'cab', 'hotel', 'other'];
const STATUSES = ['booked', 'cancelled', 'partly_refunded'];
/** What a commit wrote, in the words the page uses. */
const WRITTEN = [['trip', 'trips'], ['segment', 'legs'], ['vendor_invoice', 'agency invoices'], ['invoice_line', 'invoice lines'],
  ['credit_note', 'credit notes'], ['traveller', 'new staff']];
const writtenText = (w = {}) => WRITTEN.map(([k, label]) => `${number(w[k] ?? 0)} ${label}`).join(', ');
/** The review tab each kind of item is shown on. */
const STEP_TAB = { traveller: 'travellers', trip: 'trips', segment: 'trips', vendor_invoice: 'invoices', invoice_line: 'invoices', credit_note: 'credits' };
const opts = (list) => list.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

function Flags({ item, omit = [] }) {
  const flags = item.flags.filter((f) => !omit.includes(f.code));
  if (!flags.length && !item.assumptions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {flags.map((f) => (
        <span key={`${f.code}-${f.message}`} title={f.code} className="max-w-full">
          {/* A long message wraps rather than running off a narrow screen. */}
          <Chip tone={TONES[f.level] || 'plain'} className="h-auto min-h-[22px] max-w-full shrink whitespace-normal text-left leading-snug">{f.level === 'duplicate' ? `In the tracker: ${f.message.replace(/^already in the tracker( as| on)? ?/, '')}` : f.message}</Chip>
        </span>
      ))}
      {item.assumptions.map((a) => <span key={a} className="text-[11.5px] text-muted-foreground">Assumed: {a}</span>)}
    </div>
  );
}

/** What each step lets the reviewer change, as the server's item schema does. */
function editFields(step, lookups) {
  const staff = lookups.staff.map((s) => ({ value: String(s.id), label: s.name }));
  switch (step) {
    case 'traveller': return [
      { name: 'staff_id', label: 'Staff member', type: 'select', options: staff, placeholder: 'A new staff row', number: true },
      { name: 'name', label: 'Name for a new staff row' },
    ];
    case 'trip': return [
      { name: 'trip_type_id', label: 'Trip type', type: 'select', number: true, options: lookups.trip_types.map((t) => ({ value: String(t.id), label: `${t.name}${t.chargeable ? ' (chargeable)' : ''}` })) },
      { name: 'po_number', label: 'Billed to PO', type: 'select', options: lookups.purchase_orders.map((p) => ({ value: p.po_number, label: `${p.po_number} — ${p.client_name || ''}` })) },
      { name: 'project_id', label: 'Project (no PO yet)', type: 'select', options: lookups.projects.map((p) => ({ value: p.project_id, label: `${p.project_id} — ${p.client_name}` })) },
      { name: 'client_label', label: 'Client or purpose, when linked to nothing' },
      { name: 'origin', label: 'From' }, { name: 'destination', label: 'Destination' },
      { name: 'travel_start_date', label: 'Travel start', type: 'date' }, { name: 'travel_end_date', label: 'Travel end', type: 'date' },
      { name: 'booking_date', label: 'Booked on', type: 'date' }, { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ];
    case 'segment': return [
      { name: 'mode', label: 'Mode', type: 'select', options: opts(MODES) },
      { name: 'from_place', label: 'From' }, { name: 'to_place', label: 'To (a hotel: the city)' },
      { name: 'start_date', label: 'Date (a hotel: check-in)', type: 'date' }, { name: 'end_date', label: 'Check-out', type: 'date' },
      { name: 'provider', label: 'Airline, railway, cab or hotel' }, { name: 'pnr_or_ref', label: 'PNR or booking ref' },
      { name: 'status', label: 'Status', type: 'select', options: opts(STATUSES) }, { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ];
    case 'vendor_invoice': return [
      { name: 'vendor_invoice_no', label: 'Agency invoice number' }, { name: 'invoice_date', label: 'Invoice date', type: 'date' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ];
    case 'invoice_line': return [
      { name: 'base_fare', label: 'Fare', type: 'number' }, { name: 'service_charge', label: 'Service charge', type: 'number' },
      { name: 'gst_amount', label: 'GST', type: 'number' }, { name: 'line_total', label: 'Total', type: 'number' },
      { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ];
    case 'credit_note': return [
      { name: 'credit_note_no', label: 'Credit note number' }, { name: 'credit_note_date', label: 'Dated', type: 'date' },
      { name: 'kind', label: 'Kind', type: 'select', options: opts(['credit_note', 'cancellation_note']) },
      { name: 'refund_amount', label: 'Refund', type: 'number' }, { name: 'cancellation_charges', label: 'Cancellation charges', type: 'number' },
      { name: 'against_invoice_no', label: 'Against invoice' }, { name: 'remarks', label: 'Remarks', type: 'textarea' },
    ];
    default: return [];
  }
}

function EditItem({ item, lookups, onSave, onClose }) {
  const fields = editFields(item.step, lookups);
  const [form, setForm] = useState(() => Object.fromEntries(fields.map((f) => [f.name, item.payload[f.name] ?? ''])));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    const changed = {};
    for (const f of fields) {
      const was = item.payload[f.name] ?? '';
      if (String(form[f.name]) === String(was)) continue;
      const v = form[f.name];
      changed[f.name] = v === '' ? null : f.number ? Number(v) : f.type === 'number' ? Number(String(v).replace(/,/g, '')) : v;
    }
    setBusy(true);
    try { await onSave({ payload: changed }); onClose(); } catch (err) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title="Correct this row" subtitle={item.tab ? `${item.tab}, row ${item.source_row}` : undefined} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={save}>Save</Button></>}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.name} label={f.label}>
            {f.type === 'select' ? (
              <Select value={String(form[f.name] ?? '')} options={f.options} placeholder={f.placeholder || '—'} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
            ) : f.type === 'textarea' ? (
              <Textarea value={form[f.name] ?? ''} onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
            ) : (
              <Input type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} value={form[f.name] ?? ''}
                onChange={(e) => setForm({ ...form, [f.name]: e.target.value })} />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

export default function TravelImportReview() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const { data, error, refetch } = useFetch(() => api.raw(`/import/travel/${id}`), [id]);
  const [batch, setBatch] = useState(null);
  const [tab, setTab] = useState('trips');
  // The sales importer's filters: show all, new, duplicates or errors; flagged only.
  const [filter, setFilter] = useState({ show: '', flagged: false });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (data?.data) setBatch(data.data); }, [data]);

  const bySeq = useMemo(() => new Map((batch?.items || []).map((it) => [it.seq, it])), [batch]);
  if (error) return <><PageHeader title="Travel import" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (!batch) return <><PageHeader title="Travel import" /><div className="page"><div className="skeleton" style={{ height: 120 }} /></div></>;

  const done = batch.status === 'committed';
  const steps = (step) => batch.items.filter((it) => it.step === step);
  const legsOf = (trip) => steps('segment').filter((s) => s.payload.trip_seq === trip.seq);
  const linesOf = (inv) => steps('invoice_line').filter((l) => l.payload.invoice_seq === inv.seq);
  const typeName = (tid) => lookups.trip_types.find((t) => t.id === tid)?.name;
  const live = (it) => it.included && it.parent_included;
  const worth = (it) => it.flags.some((f) => f.level === 'red' || f.level === 'amber');
  const matches = (it) => !(
    (filter.flagged && !worth(it))
    || (filter.show === 'create' && it.existing_ref)
    || (filter.show === 'dup' && !it.existing_ref)
    || (filter.show === 'errors' && !it.flags.some((f) => f.level === 'red')));
  // A trip or an invoice shows when it, or a leg or line of it, matches.
  const shown = (head, under) => matches(head) || under.some(matches);

  async function call(path, method, body) {
    setBusy(true);
    try {
      const { data: next } = await api.raw(path, { method, body });
      setBatch(next);
      return next;
    } catch (err) {
      toast(err.message, 'danger');
      throw err;
    } finally {
      setBusy(false);
    }
  }
  const patchItem = (it, body) => call(`/import/travel/${batch.id}/items/${it.id}`, 'PATCH', body);
  const patchBatch = (body) => call(`/import/travel/${batch.id}`, 'PATCH', body).catch(() => {});

  async function commit() {
    try {
      const next = await call(`/import/travel/${batch.id}/commit`, 'POST', {});
      toast(`Committed: ${writtenText(next.written)}`, 'success');
    } catch { /* toasted */ }
  }
  async function remove() {
    await api.remove('import/travel', batch.id).then(() => navigate('/settings/import-travel')).catch((err) => toast(err.message, 'danger'));
  }

  const Include = ({ it }) => (done ? null : (
    <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <input type="checkbox" checked={it.included} disabled={busy} onChange={(e) => patchItem(it, { included: e.target.checked }).catch(() => {})} /> Import
    </label>
  ));
  const Actions = ({ it, children, follows = false }) => (
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {it.existing_ref && !done && !follows && (
        <Select className="h-7 w-[170px] text-[12px]" value={it.action} disabled={busy} options={[{ value: 'skip', label: 'Keep the original' }, { value: 'update', label: 'Update from the sheet' }]}
          onChange={(e) => patchItem(it, { action: e.target.value }).catch(() => {})} />
      )}
      {children}
      {!done && <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEditing(it)}>Edit</Button>}
      <Include it={it} />
    </div>
  );
  const known = 'border-l-waiting bg-waiting/[0.06]';
  const rowClass = (it) => `border-b border-l-[3px] border-border px-4 py-3 ${it.existing_ref ? known : 'border-l-transparent'} ${live(it) ? '' : 'opacity-50'}`;
  // A leg or line under a record already in the tracker is marked by its parent, not again.
  const subRow = (it, parent) => `border-t border-border align-top ${it.existing_ref && !parent?.existing_ref ? 'bg-waiting/[0.06]' : ''} ${live(it) ? '' : 'opacity-50'}`;

  async function decideAll(step, action) {
    await call(`/import/travel/${batch.id}/duplicates`, 'POST', { step, action }).catch(() => {});
  }
  const STEP_OF = { travellers: 'traveller', trips: 'trip', invoices: 'vendor_invoice', credits: 'credit_note' };
  // Called, not rendered as a component, so its controls are not remounted on every change.
  const filterBar = ({ step, total, showing }) => {
    const dups = steps(step).filter((it) => it.existing_ref).length;
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Select className="h-8 w-[170px]" value={filter.show} placeholder="Show: all"
          options={[{ value: 'create', label: 'New only' }, { value: 'dup', label: 'Duplicates only' }, { value: 'errors', label: 'Errors only' }]}
          onChange={(e) => setFilter({ ...filter, show: e.target.value })} />
        <div className="flex items-center gap-2" title="Items with an amber or red flag">
          <Checkbox id={`flagged-${step}`} checked={filter.flagged} onCheckedChange={(on) => setFilter({ ...filter, flagged: on === true })} />
          <Label htmlFor={`flagged-${step}`} className="text-[13px] font-normal text-secondary-text">Flagged only</Label>
        </div>
        {dups > 0 && !done && step !== 'traveller' && (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => decideAll(step, 'skip')} title="Every record of this step already in the tracker keeps the tracker's version">Keep all originals</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => decideAll(step, 'update')} title="Every record of this step already in the tracker takes the sheet's values">Update all from sheet</Button>
          </>
        )}
        <span className="num ml-auto text-[12px] text-muted-foreground">{showing} of {total}{dups ? ` · ${dups} in the tracker` : ''}</span>
      </div>
    );
  };
  const none = <p className="px-4 py-5 text-[13px] text-muted-foreground">Nothing here matches the filter.</p>;

  // The Summary step: per kind of record, what the commit does with it.
  const SUMMARY_ROWS = [['traveller', 'Travellers (new staff rows)'], ['trip', 'Trips'], ['segment', 'Legs'], ['vendor_invoice', 'Agency invoices'],
    ['invoice_line', 'Invoice lines'], ['credit_note', 'Credit and cancellation notes']];
  const tally = (step) => {
    const all = steps(step);
    const writes = (it) => live(it) && (step !== 'traveller' || !it.payload.staff_id);
    return {
      create: all.filter((it) => writes(it) && it.action === 'create').length,
      update: all.filter((it) => live(it) && it.action === 'update').length,
      keep: all.filter((it) => live(it) && it.action === 'skip').length,
      out: all.filter((it) => !live(it)).length,
    };
  };
  const reds = batch.items.filter((it) => live(it) && it.flags.some((f) => f.level === 'red'));
  const ambers = batch.items.filter((it) => live(it) && it.flags.some((f) => f.level === 'amber')).length;

  const s = batch.summary || {};
  // Before the commit, what it will add; after, what it wrote.
  const n = (done ? s.written : s.will_create) || {};
  const tabsList = [
    { key: 'columns', label: 'Tabs & columns', count: (batch.mapping?.tabs || []).length },
    { key: 'travellers', label: 'Travellers', count: steps('traveller').length },
    { key: 'trips', label: 'Trips & legs', count: steps('trip').length, warning: s.blocking || undefined, warningTitle: 'Items with a red flag' },
    { key: 'invoices', label: 'Vendor invoices', count: steps('vendor_invoice').length },
    { key: 'credits', label: 'Credit notes', count: steps('credit_note').length },
    { key: 'summary', label: 'Summary' },
  ];
  const openTab = (key) => { setTab(key); if (key === 'summary' || key === 'columns') setFilter({ show: '', flagged: false }); };

  return (
    <>
      <PageHeader
        title={batch.filename}
        subtitle={[batch.vendor_name, done ? `Committed ${date(batch.committed_at)}` : 'Draft: nothing is written until you commit'].filter(Boolean).join(' · ')}
        actions={
          <div className="flex flex-wrap gap-2">
            {done && <TravelDocumentsUpload batchId={batch.id} />}
            {!done && <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete draft</Button>}
            {!done && <Button disabled={busy || s.blocking > 0} onClick={commit}>{s.blocking > 0 ? `${number(s.blocking)} to fix before commit` : 'Commit'}</Button>}
          </div>
        }
      />
      <div className="page stack">
        <div className="auto-grid--stats">
          <Stat label="Rows read" value={number(batch.row_count)} />
          <Stat label={done ? 'Trips written' : 'New trips'} value={number(n.trip ?? 0)} meta={`${number(n.segment ?? 0)} legs ${done ? 'written' : 'to add'}`} tone="brand" />
          <Stat label="Agency invoices" value={number(n.vendor_invoice ?? 0)} meta={`${number(n.invoice_line ?? 0)} lines`} />
          <Stat label="Credit notes" value={number(n.credit_note ?? 0)} />
          <Stat label="Already in the tracker" value={number(s.duplicates ?? 0)} />
          <Stat label="To fix" value={number(s.blocking ?? 0)} tone={s.blocking ? 'warn' : 'ok'} />
        </div>
        {done && batch.summary?.written && (
          <Alert tone="success">Written: {writtenText(batch.summary.written)}. Upload the tickets and invoice PDFs named by their numbers to file them.</Alert>
        )}
        <Tabs tabs={tabsList} active={tab} onChange={openTab} />
        {STEP_OF[tab] && (
          filterBar({ step: STEP_OF[tab], total: steps(STEP_OF[tab]).length,
            showing: STEP_OF[tab] === 'trip' ? steps('trip').filter((t) => shown(t, legsOf(t))).length
              : STEP_OF[tab] === 'vendor_invoice' ? steps('vendor_invoice').filter((i) => shown(i, linesOf(i))).length
                : steps(STEP_OF[tab]).filter(matches).length })
        )}

        {tab === 'columns' && (batch.mapping?.tabs || []).map((t) => (
          <div key={t.name} className="rounded-[10px] border border-border bg-card">
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
              <label className="flex items-center gap-2 text-[13px] font-medium">
                <input type="checkbox" checked={t.included} disabled={busy || done} onChange={(e) => {
                  const chosen = batch.mapping.tabs.filter((x) => (x.name === t.name ? e.target.checked : x.included)).map((x) => x.name);
                  patchBatch({ tabs: chosen });
                }} />
                {t.name}
              </label>
              <span className="text-[12px] text-muted-foreground">{number(t.rows)} rows{t.mode?.why ? ` · ${t.mode.mode}, from ${t.mode.why}` : ''}</span>
            </div>
            <div className="grid gap-2 px-4 py-3 sm:grid-cols-2 lg:grid-cols-3">
              {Object.entries(t.mapping).map(([header, field]) => (
                <Field key={header} label={header} hint={t.ignored.includes(header) && field && field !== 'ignore' ? 'empty in this tab' : undefined}>
                  <Select value={field || 'ignore'} options={FIELD_OPTIONS} disabled={busy || done}
                    onChange={(e) => patchBatch({ column: { header, field: e.target.value } })} />
                </Field>
              ))}
            </div>
          </div>
        ))}

        {tab === 'travellers' && (
          <div className="rounded-[10px] border border-border bg-card">
            {!steps('traveller').some(matches) && none}
            {steps('traveller').filter(matches).map((it) => (
              <div key={it.id} className={rowClass(it)}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium">{it.payload.name} {it.payload.staff_id ? <span className="text-muted-foreground">· staff</span> : <span className="text-muted-foreground">· a new staff row</span>}</div>
                    <div className="text-[12px] text-muted-foreground">Written as: {it.payload.spellings.join(', ')}</div>
                    <Flags item={it} />
                  </div>
                  <Actions it={it} />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'trips' && (
          <div className="rounded-[10px] border border-border bg-card">
            {!steps('trip').some((t) => shown(t, legsOf(t))) && none}
            {steps('trip').filter((t) => shown(t, legsOf(t))).map((trip) => {
              const p = trip.payload;
              const legs = legsOf(trip);
              const others = steps('trip').filter((t) => t.seq !== trip.seq && t.payload.traveller_seq === p.traveller_seq);
              return (
                <div key={trip.id} className={rowClass(trip)}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">
                        {bySeq.get(p.traveller_seq)?.payload.name || p.employee_name} · {p.origin ? `${p.origin} → ` : ''}{p.destination}
                        {' '}<span className="text-muted-foreground">· {date(p.travel_start_date)}{p.travel_end_date && p.travel_end_date !== p.travel_start_date ? ` to ${date(p.travel_end_date)}` : ''}</span>
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        {[typeName(p.trip_type_id) || 'No trip type', p.po_number ? `PO ${p.po_number}` : p.project_id ? `Project ${p.project_id}` : p.client_label || 'linked to nothing',
                          p.cancelled && 'cancelled', trip.tab && `${trip.tab}, row ${trip.source_row}`].filter(Boolean).join(' · ')}
                      </div>
                      <Flags item={trip} />
                    </div>
                    <Actions it={trip} />
                  </div>
                  <div className="mt-2 border-t border-border">
                    {legs.map((leg) => (
                      <div key={leg.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-2 text-[12.5px] last:border-b-0 ${leg.existing_ref && !trip.existing_ref ? 'bg-waiting/[0.06]' : ''} ${live(leg) ? '' : 'opacity-50'}`}>
                        <div className="min-w-0 flex-1 basis-[240px]">
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                            <span className="w-11 shrink-0 capitalize text-muted-foreground">{leg.payload.mode}</span>
                            <span className="font-medium">{leg.payload.mode === 'hotel' ? leg.payload.to_place : `${leg.payload.from_place || '?'} → ${leg.payload.to_place || '?'}`}</span>
                            <span className="whitespace-nowrap text-muted-foreground">{date(leg.payload.start_date)}{leg.payload.end_date ? ` – ${date(leg.payload.end_date)}` : ''}</span>
                            <span className="text-secondary-text">{leg.payload.provider}{leg.payload.status !== 'booked' && <span className="text-waiting"> · {leg.payload.status.replace(/_/g, ' ')}</span>}</span>
                          </div>
                          <Flags item={leg} omit={trip.existing_ref ? ['leg_exists'] : []} />
                        </div>
                        {/* A leg already in the tracker stays on its trip there: no split, no move. */}
                        <Actions it={leg} follows={Boolean(trip.existing_ref)}>
                          {!done && !leg.existing_ref && legs.length > 1 && <Button variant="ghost" size="sm" className="h-7 px-2" disabled={busy} onClick={() => call(`/import/travel/${batch.id}/items/${leg.id}/split`, 'POST', {}).catch(() => {})}>Own trip</Button>}
                          {!done && !leg.existing_ref && others.length > 0 && (
                            <Select className="h-7 w-[150px] text-[12px]" value="" placeholder="Move to…" disabled={busy}
                              options={others.map((o) => ({ value: String(o.seq), label: `${o.payload.destination || '?'} · ${date(o.payload.travel_start_date)}` }))}
                              onChange={(e) => e.target.value && patchItem(leg, { payload: { trip_seq: Number(e.target.value) } }).catch(() => {})} />
                          )}
                        </Actions>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'invoices' && (
          <div className="rounded-[10px] border border-border bg-card">
            {!steps('vendor_invoice').some((i) => shown(i, linesOf(i))) && none}
            {steps('vendor_invoice').filter((i) => shown(i, linesOf(i))).map((inv) => {
              const lines = linesOf(inv);
              const total = lines.reduce((n, l) => n + Number(l.payload.line_total || 0), 0);
              return (
                <div key={inv.id} className={rowClass(inv)}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium mono">{inv.payload.vendor_invoice_no} <span className="text-muted-foreground">· {date(inv.payload.invoice_date)} · {money(total)}</span></div>
                      <Flags item={inv} />
                    </div>
                    <Actions it={inv} />
                  </div>
                  <div className="mt-2 overflow-x-auto"><table className="w-full min-w-[720px] table-fixed text-[12.5px]">
                    <colgroup><col /><col className="w-[96px]" /><col className="w-[96px]" /><col className="w-[96px]" /><col className="w-[104px]" /><col className="w-[150px]" /></colgroup>
                    <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Leg</th><th className="text-right font-normal">Fare</th><th className="text-right font-normal">Service</th><th className="text-right font-normal">GST</th><th className="text-right font-normal">Total</th><th /></tr></thead>
                    <tbody>
                      {lines.map((l) => {
                        const leg = bySeq.get(l.payload.segment_seq);
                        const trip = bySeq.get(l.payload.trip_seq);
                        return (
                          <tr key={l.id} className={subRow(l, inv)}>
                            <td className="py-1.5 pr-3">{bySeq.get(trip?.payload.traveller_seq)?.payload.name || trip?.payload.employee_name} · {leg ? `${leg.payload.from_place ? `${leg.payload.from_place} → ` : ''}${leg.payload.to_place || ''} ${date(leg.payload.start_date)}` : ''}<Flags item={l} /></td>
                            <td className="py-1.5 text-right num">{money(l.payload.base_fare)}</td>
                            <td className="py-1.5 text-right num">{money(l.payload.service_charge)}</td>
                            <td className="py-1.5 text-right num">{money(l.payload.gst_amount)}</td>
                            <td className="py-1.5 text-right num">{money(l.payload.line_total)}</td>
                            <td className="py-1.5 pl-2 text-right"><Actions it={l} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'credits' && (
          <div className="rounded-[10px] border border-border bg-card">
            {steps('credit_note').length === 0 ? <p className="px-4 py-5 text-[13px] text-muted-foreground">No credit or cancellation notes in this workbook.</p>
              : !steps('credit_note').some(matches) && none}
            {steps('credit_note').filter(matches).map((n) => (
              <div key={n.id} className={rowClass(n)}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-medium mono">{n.payload.credit_note_no} <span className="text-muted-foreground">· {n.payload.kind.replace(/_/g, ' ')} · {date(n.payload.credit_note_date)}</span></div>
                    <div className="text-[12px] text-muted-foreground">
                      {[n.payload.against_invoice_no && `against ${n.payload.against_invoice_no}`, `refund ${money(n.payload.refund_amount)}`,
                        n.payload.cancellation_charges != null && `charges kept ${money(n.payload.cancellation_charges)}`].filter(Boolean).join(' · ')}
                    </div>
                    <Flags item={n} />
                  </div>
                  <Actions it={n} />
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'summary' && (
          <div className="stack">
            <div className="overflow-x-auto rounded-[10px] border border-border bg-card">
              <table className="w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr className="text-[12px] text-muted-foreground">
                    <th className="px-4 py-2.5 text-left font-normal">Record</th>
                    <th className="px-3 py-2.5 text-right font-normal">{done ? 'Written new' : 'New'}</th>
                    <th className="px-3 py-2.5 text-right font-normal">Updated from the sheet</th>
                    <th className="px-3 py-2.5 text-right font-normal">Kept as in the tracker</th>
                    <th className="px-4 py-2.5 text-right font-normal">Left out</th>
                  </tr>
                </thead>
                <tbody>
                  {SUMMARY_ROWS.map(([step, label]) => {
                    const t = tally(step);
                    return (
                      <tr key={step} className="border-t border-border">
                        <td className="px-4 py-2">{label}</td>
                        <td className="num px-3 py-2 text-right font-medium">{number(t.create)}</td>
                        <td className="num px-3 py-2 text-right">{number(t.update)}</td>
                        <td className="num px-3 py-2 text-right">{number(t.keep)}</td>
                        <td className="num px-4 py-2 text-right text-muted-foreground">{number(t.out)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!done && (reds.length > 0 ? (
              <Alert tone="danger">
                {number(reds.length)} item{reds.length === 1 ? '' : 's'} still {reds.length === 1 ? 'has' : 'have'} a red flag, so nothing can be committed yet.{' '}
                <button type="button" className="underline" onClick={() => { setTab(STEP_TAB[reds[0].step] || 'trips'); setFilter({ show: 'errors', flagged: false }); }}>Show them</button>
              </Alert>
            ) : (
              <Alert tone="info">
                Ready to commit{ambers ? `: ${number(ambers)} item${ambers === 1 ? '' : 's'} with an amber flag are worth a look first` : ''}. It is one transaction: everything ticked is written, or nothing is.
              </Alert>
            ))}
            {!done && <div><Button disabled={busy || reds.length > 0} onClick={commit}>Commit</Button></div>}
          </div>
        )}
      </div>

      {editing && <EditItem item={editing} lookups={lookups} onSave={(body) => patchItem(editing, body)} onClose={() => setEditing(null)} />}
      {confirmDelete && (
        <ConfirmDialog title="Delete this draft?" message={`The draft from "${batch.filename}" will be removed. Nothing in the tracker changes.`}
          confirmLabel="Delete draft" onConfirm={remove} onClose={() => setConfirmDelete(false)} />
      )}
    </>
  );
}
