import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { CircleCheck, FileSpreadsheet } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ConfirmDialog, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { DialogError, MoneyBanner, SkelPanel } from '../components/money.jsx';
import { FailedCard } from '../components/daily.jsx';
import { RecordTabs, SummaryStrip } from '../components/sales.jsx';
import { count } from '../components/travel.jsx';
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
const sentence = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
/** What a flag's colour means, as its tooltip (never the internal code). */
const FLAG_WORD = { red: 'Must be fixed before the commit', amber: 'Worth a look before the commit', blue: 'What the import decided', duplicate: 'Already in the tracker' };
const MODES = ['flight', 'train', 'bus', 'cab', 'hotel', 'other'];
const STATUSES = ['booked', 'cancelled', 'partly_refunded'];
/** What a commit wrote, in the words the page uses. */
const WRITTEN = [['trip', 'trip'], ['segment', 'leg'], ['vendor_invoice', 'agency invoice'], ['invoice_line', 'invoice line'],
  ['credit_note', 'credit note'], ['traveller', 'new staff member', 'new staff']];
const writtenText = (w = {}) => WRITTEN.map(([k, one, many]) => count(w[k] ?? 0, one, many)).join(', ');
/** The review tab each kind of item is shown on. */
const STEP_TAB = { traveller: 'travellers', trip: 'trips', segment: 'trips', vendor_invoice: 'invoices', invoice_line: 'invoices', credit_note: 'credits' };
const opts = (list) => list.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1).replace(/_/g, ' ') }));
const STEP_WORD = { traveller: 'A traveller', trip: 'A trip', segment: 'A leg', vendor_invoice: 'An agency invoice', invoice_line: 'An invoice line', credit_note: 'A credit note' };

function Flags({ item, omit = [] }) {
  const flags = item.flags.filter((f) => !omit.includes(f.code));
  if (!flags.length && !item.assumptions.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1.5">
      {flags.map((f) => (
        <span key={`${f.code}-${f.message}`} title={FLAG_WORD[f.level]} className="max-w-full">
          {/* A long message wraps rather than running off a narrow screen. */}
          <Chip tone={TONES[f.level] || 'plain'} className="h-auto min-h-[22px] max-w-full shrink whitespace-normal text-left leading-snug">{f.level === 'duplicate' ? `In the tracker: ${f.message.replace(/^already in the tracker( as| on)? ?/, '')}` : sentence(f.message)}</Chip>
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
    <Modal title="Correct this row" subtitle={[STEP_WORD[item.step], item.tab && `${item.tab}, row ${item.source_row}`].filter(Boolean).join(' · ') || undefined} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button disabled={busy} aria-busy={busy || undefined} onClick={save}>{busy ? 'Saving…' : error ? 'Try again' : 'Save the row'}</Button></>}>
      <DialogError error={error} what="the row" />
      {item.flags.length > 0 && <div className="mb-3"><Flags item={item} /></div>}
      <div className="mg-grid2">
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
  const [askCommit, setAskCommit] = useState(false);
  const [committing, setCommitting] = useState(false);
  useEffect(() => { if (data?.data) setBatch(data.data); }, [data]);

  const bySeq = useMemo(() => new Map((batch?.items || []).map((it) => [it.seq, it])), [batch]);
  if (error) return <><PageHeader title="Travel import" eyebrow="Settings › Import travel" /><div className="app-page"><FailedCard title="Couldn't load this import" text={`${error} The draft is unchanged; try again.`} onRetry={refetch}><Link className="mg-btn mg-btn--sm" to="/settings/import-travel">Back to Import travel</Link></FailedCard></div></>;
  if (!batch) return <><PageHeader title="Travel import" eyebrow="Settings › Import travel" subtitle="Loading the review…" /><div className="app-page" aria-busy="true"><SkelPanel rows={1} /><SkelPanel rows={6} /></div></>;

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
    setCommitting(true);
    try {
      const next = await call(`/import/travel/${batch.id}/commit`, 'POST', {});
      toast(`Committed: ${writtenText(next.written)}`, 'success');
      setAskCommit(false);
    } catch { /* toasted; the confirm stays open with Try again */ } finally {
      setCommitting(false);
    }
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
  const rowClass = (it) => `app-irow ${it.existing_ref ? 'is-known' : ''} ${live(it) ? '' : 'is-out'}`;

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
  const none = (
    <div className="mg-empty">
      <h3 className="mg-empty__title">Nothing here matches the filter</h3>
      <p className="mg-empty__text">Show all, or untick Flagged only, to see every row of this step.</p>
      <button type="button" className="mg-btn mg-btn--sm" onClick={() => setFilter({ show: '', flagged: false })}>Show all</button>
    </div>
  );

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

  const failed = batch.status === 'failed';
  const toWrite = Object.values(n).reduce((sum, v) => sum + Number(v || 0), 0);
  const tabsForPanel = tabsList.map((t) => ({ key: t.key, label: t.label, count: t.warning ? undefined : t.count || undefined, warning: t.warning }));

  return (
    <>
      <PageHeader
        title={batch.filename}
        eyebrow="Settings › Import travel"
        subtitle={[batch.vendor_name, failed ? 'Could not be read' : done ? `Committed ${date(batch.committed_at)}` : 'Draft: nothing is written until you commit'].filter(Boolean).join(' · ')}
        actions={
          <div className="flex flex-wrap gap-2">
            {done && <TravelDocumentsUpload batchId={batch.id} />}
            {!done && <Button variant="ghost" onClick={() => setConfirmDelete(true)}>Delete draft</Button>}
            {!done && !failed && <Button disabled={busy || s.blocking > 0} onClick={() => setAskCommit(true)}>{s.blocking > 0 ? `${count(s.blocking, 'row')} to fix before commit` : 'Commit'}</Button>}
          </div>
        }
      />
      <div className="app-page">
        {failed && (
          <MoneyBanner tone="late" role="alert" title="This workbook couldn't be read, so there is nothing to review."
            action={<Link className="mg-btn mg-btn--sm" to="/settings/import-travel">Upload a corrected workbook</Link>}>
            {batch.error || 'No tab had the columns the import needs.'} Fix the workbook and upload it again; this draft can be deleted.
          </MoneyBanner>
        )}
        {!failed && (
          <SummaryStrip
            label="What this workbook holds"
            tiles={[
              { key: 'rows', label: 'Rows read', figure: number(batch.row_count) },
              { key: 'trips', label: done ? 'Trips written' : 'New trips', figure: number(n.trip ?? 0), foot: `${count(n.segment ?? 0, 'leg')} ${done ? 'written' : 'to add'}` },
              { key: 'inv', label: 'Agency invoices', figure: number(n.vendor_invoice ?? 0), foot: count(n.invoice_line ?? 0, 'line') },
              { key: 'cn', label: 'Credit notes', figure: number(n.credit_note ?? 0) },
              { key: 'dup', label: 'Already in the tracker', figure: number(s.duplicates ?? 0), foot: s.duplicates ? 'kept unless you update them' : null },
              { key: 'fix', label: 'To fix', figure: number(s.blocking ?? 0), tone: s.blocking ? 'late' : undefined, foot: s.blocking ? 'red flags block the commit' : 'nothing blocks the commit' },
            ]}
          />
        )}
        {done && batch.summary?.written && (
          <MoneyBanner tone="ok" icon={CircleCheck} title={`Committed: ${writtenText(batch.summary.written)}.`}
            action={<TravelDocumentsUpload batchId={batch.id} className="mg-btn mg-btn--sm" />}>
            Upload the tickets and invoice PDFs named by their numbers and they file themselves.
          </MoneyBanner>
        )}
        {!failed && (
        <section className="mg-glass mg-glass--strong app-tabpanel" data-a="rise" aria-label="The review">
        <RecordTabs id="tir" label="Review steps" tabs={tabsForPanel.map((t) => ({ ...t, label: t.warning ? <>{t.label}<span className="mg-count app-count--late" title="Rows with a red flag">{t.warning}</span></> : t.label }))} active={tab} onChange={openTab} />
        <div className="app-tabbody" id="tir-panel" role="tabpanel" aria-labelledby={`tir-tab-${tab}`}>
        {STEP_OF[tab] && (
          filterBar({ step: STEP_OF[tab], total: steps(STEP_OF[tab]).length,
            showing: STEP_OF[tab] === 'trip' ? steps('trip').filter((t) => shown(t, legsOf(t))).length
              : STEP_OF[tab] === 'vendor_invoice' ? steps('vendor_invoice').filter((i) => shown(i, linesOf(i))).length
                : steps(STEP_OF[tab]).filter(matches).length })
        )}

        {tab === 'columns' && (batch.mapping?.tabs || []).map((t) => (
          <div key={t.name} className="app-ibox">
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
          <div className="app-ibox">
            {steps('traveller').length === 0 ? <p className="app-tabnote px-4 py-5">No travellers to check in this workbook: every name matched the staff list, or no row named one.</p>
              : !steps('traveller').some(matches) && none}
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
          <div className="app-ibox">
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
          <div className="app-ibox">
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
                  {/* Lines as rows that wrap: the leg, its amounts (labelled, so no header is
                      needed when they drop below it on a narrow screen), its buttons. */}
                  <div className="mt-2 border-t border-border">
                    {lines.map((l) => {
                      const leg = bySeq.get(l.payload.segment_seq);
                      const trip = bySeq.get(l.payload.trip_seq);
                      return (
                        <div key={l.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border py-2 text-[12.5px] last:border-b-0 ${l.existing_ref && !inv.existing_ref ? 'bg-waiting/[0.06]' : ''} ${live(l) ? '' : 'opacity-50'}`}>
                          <div className="min-w-0 flex-1 basis-[200px]">
                            <div><span className="font-medium">{bySeq.get(trip?.payload.traveller_seq)?.payload.name || trip?.payload.employee_name}</span>
                              {leg && <span className="text-secondary-text"> · {leg.payload.from_place ? `${leg.payload.from_place} → ` : ''}{leg.payload.to_place || ''} · {date(leg.payload.start_date)}</span>}</div>
                            <Flags item={l} />
                          </div>
                          <dl className="grid grid-cols-4 gap-x-3 text-right">
                            {[['Fare', l.payload.base_fare], ['Service', l.payload.service_charge], ['GST', l.payload.gst_amount], ['Total', l.payload.line_total]].map(([label, v]) => (
                              <div key={label} className="min-w-[64px]">
                                <dt className="text-[11px] text-muted-foreground">{label}</dt>
                                <dd className={`num m-0 ${label === 'Total' ? 'font-semibold' : ''}`}>{money(v)}</dd>
                              </div>
                            ))}
                          </dl>
                          <Actions it={l} follows={Boolean(inv.existing_ref)} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'credits' && (
          <div className="app-ibox">
            {steps('credit_note').length === 0 ? <p className="app-tabnote px-4 py-5">No credit or cancellation notes in this workbook. A note in a later upload is matched to the invoice it reverses.</p>
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
          <div className="flex flex-col gap-4">
            <div className="app-ibox overflow-x-auto">
              <table className="mg-table">
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col" className="num">{done ? 'Written new' : 'New'}</th>
                    <th scope="col" className="num">Updated from the sheet</th>
                    <th scope="col" className="num">Kept as in the tracker</th>
                    <th scope="col" className="num">Left out</th>
                  </tr>
                </thead>
                <tbody>
                  {SUMMARY_ROWS.map(([step, label]) => {
                    const t = tally(step);
                    return (
                      <tr key={step}>
                        <td><b>{label}</b></td>
                        <td className="num"><b>{number(t.create)}</b></td>
                        <td className="num">{number(t.update)}</td>
                        <td className="num">{number(t.keep)}</td>
                        <td className="num text-muted-foreground">{number(t.out)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!done && (reds.length > 0 ? (
              <MoneyBanner tone="late" title={`${count(reds.length, 'row')} still ${reds.length === 1 ? 'has' : 'have'} a red flag, so nothing can be committed yet.`}
                action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => { setTab(STEP_TAB[reds[0].step] || 'trips'); setFilter({ show: 'errors', flagged: false }); }}>Show them</button>}>
                Correct each row, or untick it to leave it out.
              </MoneyBanner>
            ) : (
              // G2-2: the ready state, with the one commit path.
              <MoneyBanner tone="ok" icon={CircleCheck} title="Ready to commit."
                action={<button type="button" className="mg-btn mg-btn--primary mg-btn--sm" disabled={busy} onClick={() => setAskCommit(true)}>Commit</button>}>
                {ambers ? `${count(ambers, 'row')} with an amber flag ${ambers === 1 ? 'is' : 'are'} worth a look first. ` : ''}It is one transaction: everything ticked is written, or nothing is.
              </MoneyBanner>
            ))}
          </div>
        )}
        </div>
        </section>
        )}
      </div>

      {askCommit && (
        <ConfirmDialog
          title={`Commit ${count(toWrite, 'record')}?`}
          message={`${writtenText(n)}${s.duplicates ? `, and ${count(s.duplicates, 'record')} already in the tracker kept or updated as chosen` : ''}. It is one transaction: everything ticked is written, or nothing is.`}
          confirmLabel="Commit"
          busyLabel={`Committing ${count(toWrite, 'record')}…`}
          tone="primary"
          busy={committing}
          onConfirm={commit}
          onClose={() => !committing && setAskCommit(false)}
        >
          {ambers > 0 && <div className="mt-3"><MoneyBanner tone="wait" title={`${count(ambers, 'row')} with an amber flag.`}>Worth a look first; they don't block the commit.</MoneyBanner></div>}
        </ConfirmDialog>
      )}
      {editing && <EditItem item={editing} lookups={lookups} onSave={(body) => patchItem(editing, body)} onClose={() => setEditing(null)} />}
      {confirmDelete && (
        <ConfirmDialog title="Delete this draft?" message={`The draft from "${batch.filename}" will be removed. Nothing in the tracker changes.`}
          confirmLabel="Delete draft" onConfirm={remove} onClose={() => setConfirmDelete(false)} />
      )}
    </>
  );
}
