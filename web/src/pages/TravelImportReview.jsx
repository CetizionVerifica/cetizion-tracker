import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, ConfirmDialog, ErrorState, Field, Input, Modal, Select, Stat, Tabs, Textarea, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { TravelDocumentsUpload } from '../components/TravelDocumentsUpload.jsx';
import { api } from '../lib/api.js';
import { date, money, number } from '../lib/format.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * The review of a travel import (#196 §5.1 step 3): what each tab's columns
 * were read as, the travellers, the trips with their legs, the agency's
 * invoices with their lines, and the credit notes, each with its flags.
 * Red blocks the commit, amber asks for a look, blue says what was decided,
 * and a record already in the tracker is kept unless "update" is chosen.
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
const opts = (list) => list.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }));

function Flags({ item }) {
  if (!item.flags.length && !item.assumptions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {item.flags.map((f) => (
        <span key={`${f.code}-${f.message}`} title={f.code}>
          <Chip tone={TONES[f.level] || 'plain'}>{f.level === 'duplicate' ? `In the tracker: ${f.message.replace(/^already in the tracker( as| on)? ?/, '')}` : f.message}</Chip>
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
  const Actions = ({ it, children }) => (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {it.existing_ref && !done && (
        <Select className="h-7 w-[170px] text-[12px]" value={it.action} disabled={busy} options={[{ value: 'skip', label: 'Keep the original' }, { value: 'update', label: 'Update from the sheet' }]}
          onChange={(e) => patchItem(it, { action: e.target.value }).catch(() => {})} />
      )}
      {children}
      {!done && <Button variant="ghost" size="sm" onClick={() => setEditing(it)}>Edit</Button>}
      <Include it={it} />
    </div>
  );
  const rowClass = (it) => `border-b border-border px-4 py-3 ${live(it) ? '' : 'opacity-50'}`;

  const s = batch.summary || {};
  // Before the commit, what it will add; after, what it wrote.
  const n = (done ? s.written : s.will_create) || {};
  const tabsList = [
    { key: 'columns', label: 'Tabs & columns', count: (batch.mapping?.tabs || []).length },
    { key: 'travellers', label: 'Travellers', count: steps('traveller').length },
    { key: 'trips', label: 'Trips & legs', count: steps('trip').length, warning: s.blocking || undefined, warningTitle: 'Items with a red flag' },
    { key: 'invoices', label: 'Vendor invoices', count: steps('vendor_invoice').length },
    { key: 'credits', label: 'Credit notes', count: steps('credit_note').length },
  ];

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
        <Tabs tabs={tabsList} active={tab} onChange={setTab} />

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
            {steps('traveller').map((it) => (
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
            {steps('trip').map((trip) => {
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
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-[12.5px]">
                      <tbody>
                        {legs.map((leg) => (
                          <tr key={leg.id} className={`border-t border-border align-top ${live(leg) ? '' : 'opacity-50'}`}>
                            <td className="py-1.5 pr-3 capitalize">{leg.payload.mode}</td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">{leg.payload.mode === 'hotel' ? leg.payload.to_place : `${leg.payload.from_place || '?'} → ${leg.payload.to_place || '?'}`}</td>
                            <td className="py-1.5 pr-3 whitespace-nowrap">{date(leg.payload.start_date)}{leg.payload.end_date ? ` – ${date(leg.payload.end_date)}` : ''}</td>
                            <td className="py-1.5 pr-3">{leg.payload.provider}{leg.payload.status !== 'booked' && <span className="text-waiting"> · {leg.payload.status.replace(/_/g, ' ')}</span>}
                              <Flags item={leg} /></td>
                            <td className="w-[380px] py-1.5 text-right">
                              {/* A leg already in the tracker stays on its trip there: no split, no move. */}
                              <Actions it={leg}>
                                {!done && !leg.existing_ref && legs.length > 1 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => call(`/import/travel/${batch.id}/items/${leg.id}/split`, 'POST', {}).catch(() => {})}>Own trip</Button>}
                                {!done && !leg.existing_ref && others.length > 0 && (
                                  <Select className="h-7 w-[150px] text-[12px]" value="" placeholder="Move to…" disabled={busy}
                                    options={others.map((o) => ({ value: String(o.seq), label: `${o.payload.destination || '?'} · ${date(o.payload.travel_start_date)}` }))}
                                    onChange={(e) => e.target.value && patchItem(leg, { payload: { trip_seq: Number(e.target.value) } }).catch(() => {})} />
                                )}
                              </Actions>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'invoices' && (
          <div className="rounded-[10px] border border-border bg-card">
            {steps('vendor_invoice').map((inv) => {
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
                          <tr key={l.id} className={`border-t border-border align-top ${live(l) ? '' : 'opacity-50'}`}>
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
            {steps('credit_note').length === 0 && <p className="px-4 py-5 text-[13px] text-muted-foreground">No credit or cancellation notes in this workbook.</p>}
            {steps('credit_note').map((n) => (
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
      </div>

      {editing && <EditItem item={editing} lookups={lookups} onSave={(body) => patchItem(editing, body)} onClose={() => setEditing(null)} />}
      {confirmDelete && (
        <ConfirmDialog title="Delete this draft?" message={`The draft from "${batch.filename}" will be removed. Nothing in the tracker changes.`}
          confirmLabel="Delete draft" onConfirm={remove} onClose={() => setConfirmDelete(false)} />
      )}
    </>
  );
}
