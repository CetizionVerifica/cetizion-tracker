import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, FileText, RefreshCw, TriangleAlert, Unplug, X } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { ConfirmDialog, Field, FileDrop, Input, Modal, Select, useToast } from '../components/ui.jsx';
import { Button } from '../components/ui/button.tsx';
import { DialogError, MoneyBanner, shortDate } from '../components/money.jsx';
import { FailedCard, MgTabs, StateCard, plural } from '../components/daily.jsx';
import { SummaryStrip, Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups, useMediaQuery } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';

/**
 * Accounting (#48): what the books say against what the tracker says,
 * draft invoices for due stages, customer mappings, and TDS/GST reports.
 * Every tab has its own loading and error state; removing a mapping asks
 * first.
 */
const STATUS = { amount_differs: ['Amount differs', 'late'], date_differs: ['Date differs', 'wait'], missing_in_books: ['Not in the books', 'wait'], missing_in_tracker: ['Not in the tracker', 'late'], resolved: ['Resolved', 'ok'], matched: ['Matched', 'ok'] };
const PROVIDER = { none: 'Not connected', zoho: 'Zoho Books', tally: 'Tally Prime', file: 'Export files' };
const ACCEPTABLE = ['invoice_date', 'due_date', 'received_on', 'tds_amount', 'payment'];
const fyStart = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };

function TabLoading({ rows = 3 }) {
  return <section className="mg-glass mg-panel" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <div key={i} className="mg-skel" style={{ height: 44, width: i === rows - 1 ? '70%' : undefined }} />)}</section>;
}

export default function Accounting() {
  const [tab, setTab] = useState('differences');
  const status = useFetch(() => api.raw('/accounting/status'), [tab]);
  const s = status.data?.data;
  const open = s ? Object.entries(s.counts).filter(([k]) => !['matched', 'resolved'].includes(k)).reduce((t, [, n]) => t + n, 0) : 0;
  const connected = s && (s.provider === 'zoho' ? s.zoho : s.provider === 'tally' ? s.tally : s.provider === 'file');
  const providerFoot = !s ? null : s.provider === 'zoho' ? (s.zoho ? 'by API' : 'ZOHO_* is not set on the server')
    : s.provider === 'tally' ? (s.tally ? 'Tally reachable by URL' : 'upload day-book exports')
    : s.provider === 'file' ? 'upload exports under Import' : 'choose where the books are in Settings › Assumptions';

  return (
    <>
      <PageHeader title="Accounting" subtitle="The books against the tracker. The books win on invoice and payment details; every difference waits here until it is taken or explained." />
      <div className="app-page">
        {status.error && !s ? (
          <FailedCard title="Couldn't load the books' status" text={status.error} onRetry={status.refetch} />
        ) : (
          <SummaryStrip
            label="The books"
            loading={!s}
            tiles={[
              { key: 'books', label: 'Books', figure: s ? PROVIDER[s.provider] : null, badge: s && s.provider !== 'none' ? (connected ? { tone: 'ok', text: 'Connected' } : { tone: 'wait', text: 'Not set up' }) : undefined, foot: providerFoot },
              { key: 'open', label: 'Open differences', figure: s ? open : null, tone: open ? 'late' : 'ok', badge: open ? { tone: 'late', text: 'To look at' } : undefined, foot: s ? (open ? 'waiting to be taken or explained' : 'nothing to look at') : null },
              { key: 'matched', label: 'Matched', figure: s ? (s.counts.matched || 0) : null, foot: s ? `${s.counts.resolved || 0} of them resolved by hand` : null },
              { key: 'last', label: 'Last activity', figure: s ? (s.last ? s.last.action : 'Nothing yet') : null, foot: s?.last ? `${new Date(s.last.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${s.last.done_by ? `, by ${s.last.done_by}` : ''}` : null },
            ]}
          />
        )}
        {s && s.provider === 'none' && (
          <MoneyBanner tone="wait" icon={Unplug} title="The books are not connected." action={<Link to="/settings/assumptions" className="mg-btn mg-btn--sm">Open Settings</Link>}>
            Choose where the books are (Zoho, Tally or export files) under Settings › Assumptions › The books. Imports still work with exported files.
          </MoneyBanner>
        )}
        <MgTabs label="Accounting" active={tab} onChange={setTab} tabs={[{ key: 'differences', label: 'Differences', count: open || undefined }, { key: 'import', label: 'Import' }, { key: 'drafts', label: 'Draft invoices' }, { key: 'mappings', label: 'Mappings' }, { key: 'reports', label: 'TDS & GST' }]} />
        {tab === 'differences' && <Differences onChanged={status.refetch} provider={s?.provider} />}
        {tab === 'import' && <Import onDone={() => { status.refetch(); setTab('differences'); }} />}
        {tab === 'drafts' && <Drafts provider={s?.provider} />}
        {tab === 'mappings' && <Mappings />}
        {tab === 'reports' && <Reports />}
      </div>
    </>
  );
}

function Differences({ onChanged, provider }) {
  const toast = useToast();
  const wide = useMediaQuery('(min-width: 900px)');
  const [show, setShow] = useState('');
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/accounting/items${show ? `?status=${show}` : ''}`), [show]);
  const [resolving, setResolving] = useState(null);
  const [busy, setBusy] = useState(false);
  async function run(fn, ok) {
    setBusy(true);
    try { const r = await fn(); toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); onChanged(); } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); } finally { setBusy(false); }
  }
  const isDate = (d) => d.field.includes('date') || d.field === 'received_on';
  const describe = (d) => (d.field === 'payment'
    ? `Books: ${money(d.books)} received${d.tds ? ` + ${money(d.tds)} TDS` : ''} on ${shortDate(d.date)}`
    : `${d.field.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())}: tracker ${isDate(d) ? shortDate(d.tracker) : d.tracker ?? '—'}, books ${isDate(d) ? shortDate(d.books) : d.books ?? '—'}${d.note ? ` (${d.note})` : ''}`);
  const diff = (r) => (r.differences.length ? r.differences.map((d, i) => <span key={i} className="block">{describe(d)}</span>)
    : r.status === 'missing_in_books' ? `Tracker: ${money(r.stage_amount ?? r.payment_amount)}`
    : r.status === 'missing_in_tracker' ? `Books: ${money(r.books_taxable ?? r.books_total)} on ${shortDate(r.books_date)}` : '');
  const rows = data?.data ?? [];
  const acts = (r, phone) => r.status !== 'resolved' && r.status !== 'matched' && (
    <span className={phone ? 'app-pinv__btns' : 'app-acts'}>
      {r.differences.some((d) => ACCEPTABLE.includes(d.field)) && <button type="button" className={phone ? 'mg-btn mg-btn--primary' : 'mg-btn mg-btn--primary mg-btn--sm'} disabled={busy} onClick={() => run(() => api.action(`/accounting/items/${r.id}/accept`), 'Books value applied')}>Take books value</button>}
      <button type="button" className={phone ? 'mg-btn' : 'mg-btn mg-btn--sm'} onClick={() => setResolving(r)}>Resolve</button>
    </span>
  );

  return (
    <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="diff-t">
      <div className="app-panel__head">
        <div className="app-panel__titles"><h2 className="mg-panel__title" id="diff-t">Differences</h2><span className="mg-panel__hint">Take the books&apos; value where it can be applied, or fix it by hand and say what was done.</span></div>
        <div className="app-panel__tools">
          <label className="app-filter">Show<span className="mg-select-wrap" style={{ width: 150 }}><select className="mg-select" value={show} onChange={(e) => setShow(e.target.value)}><option value="">Open only</option><option value="resolved">Resolved</option><option value="matched">Matched</option></select></span></label>
          <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => run(() => api.action('/accounting/reconcile'), (r) => `Checked ${r.data.items} items`)}><RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Check again</button>
          {provider === 'zoho' && <button type="button" className="mg-btn mg-btn--sm" disabled={busy} onClick={() => run(() => api.action('/accounting/sync'), (r) => `Pulled ${r.data.pulled} entries`)}><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Pull from Zoho</button>}
        </div>
      </div>
      {loading && !data ? <div className="app-panel__body flex flex-col gap-2.5 p-5" aria-busy="true" aria-label="Loading">{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</div>
        : error ? <div className="app-panel__body p-5"><MoneyBanner tone="late" role="alert" title="Couldn't load the differences." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{error}</MoneyBanner></div>
        : !rows.length ? <StateCard inPanel title={show ? `Nothing ${show}` : 'Nothing to look at'} text={show ? 'Nothing in this list yet.' : 'The books and the tracker agree. Import invoices and payments from the books to compare them again.'} />
        : wide ? (
          <div className="mg-tablewrap app-panel__body">
            <table className="mg-table" aria-label="Differences between the books and the tracker">
              <thead><tr><th>What</th><th>Invoice</th><th>Status</th><th>Difference</th><th>Note</th><th aria-label="Actions" /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><Tone>{String(r.kind).replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())}</Tone></td>
                    <td><span className="mg-num font-bold">{r.invoice_no || r.books_number || '—'}</span><span className="app-sub2">{r.client_name || r.books_customer || ''}</span></td>
                    <td><Tone tone={STATUS[r.status]?.[1]}>{STATUS[r.status]?.[0] || r.status}</Tone></td>
                    <td style={{ whiteSpace: 'normal' }}><div style={{ minWidth: 220 }} className="text-[13px]">{diff(r)}</div></td>
                    <td style={{ whiteSpace: 'normal' }}><div style={{ minWidth: 140 }} className="text-[12.5px] text-secondary-text">{r.note ? `${r.note}${r.resolved_by ? ` · ${r.resolved_by}` : ''}` : <span className="mg-muted">—</span>}</div></td>
                    <td>{acts(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mg-rows app-panel__body">
            {rows.map((r) => (
              <div key={r.id} className="mg-row">
                <span className="mg-row__title">{r.invoice_no || r.books_number || '—'}</span>
                <span className="mg-row__amount"><Tone tone={STATUS[r.status]?.[1]}>{STATUS[r.status]?.[0] || r.status}</Tone></span>
                <span className="mg-row__meta app-pinv__full" style={{ whiteSpace: 'normal' }}>{r.client_name || r.books_customer || ''}{(r.client_name || r.books_customer) ? ' · ' : ''}{diff(r)}</span>
                {acts(r, true)}
              </div>
            ))}
          </div>
        )}
      {resolving && (
        <ResolveDialog item={resolving} onClose={() => setResolving(null)} onSaved={() => { setResolving(null); refetch(); onChanged(); }} />
      )}
    </section>
  );
}

function ResolveDialog({ item, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.action(`/accounting/items/${item.id}/resolve`, { note }); toast('Resolved', 'success'); onSaved(); }
    catch (err) { setError(err.fields ? Object.values(err.fields)[0] : err.message); setBusy(false); }
  }
  return (
    <Modal size="sm" title="Resolve this difference" subtitle={[item.invoice_no || item.books_number, item.client_name || item.books_customer].filter(Boolean).join(' · ')} onClose={onClose}
      footer={<><Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="max-sm:w-full">Cancel</Button><Button type="submit" form="resolve-form" disabled={busy || !note.trim()} className="max-sm:w-full">{busy ? 'Saving…' : error ? 'Try again' : 'Resolve'}</Button></>}>
      <form id="resolve-form" onSubmit={save} className="flex flex-col gap-4">
        <DialogError error={error} what="it" />
        <Field label="What was fixed, or why the two may differ" required><Input value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="Credit note CN-14 raised in the books" /></Field>
      </form>
    </Modal>
  );
}

function Import({ onDone }) {
  const toast = useToast();
  const [kind, setKind] = useState('invoice');
  const [source, setSource] = useState('zoho');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault();
    setBusy(true); setFailure(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.upload(`/accounting/import?kind=${kind}&source=${source}`, fd);
      setResult(r.data); toast(`${r.data.saved} entries read`, 'success');
    } catch (err) { setFailure(err.message); } finally { setBusy(false); }
  }
  return (
    <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="imp-t">
      <div className="app-panel__head"><div className="app-panel__titles"><h2 className="mg-panel__title" id="imp-t">Import from the books</h2><span className="mg-panel__hint">Zoho Books: Sales › Invoices (or Payments Received) › Export. Tally: Day Book › Export as Excel or CSV. Entries seen again replace the old copy.</span></div></div>
      <form className="app-panel__body flex flex-col gap-4 p-5 sm:px-6" onSubmit={go}>
        {failure && <MoneyBanner tone="late" role="alert" title="Couldn't read the file.">{failure} Nothing was imported.</MoneyBanner>}
        <div className="app-form4">
          <Field label="What is in the file"><Select value={kind} placeholder={null} options={[{ value: 'invoice', label: 'Invoices' }, { value: 'payment', label: 'Payments received' }]} onChange={(e) => setKind(e.target.value)} /></Field>
          <Field label="From"><Select value={source} placeholder={null} options={[{ value: 'zoho', label: 'Zoho Books export' }, { value: 'tally', label: 'Tally export (day book sorts itself)' }, { value: 'file', label: 'Another sheet' }]} onChange={(e) => setSource(e.target.value)} /></Field>
          <Field as="div" label="File" required hint="CSV or Excel, up to 10 MB. Dates are read day first."><FileDrop label="File" accept=".csv,.xlsx,.xls" text={file ? file.name : 'Drop the export here, or choose a file'} onFile={setFile} /></Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="mg-btn mg-btn--primary" disabled={!file || busy}>{busy ? 'Reading…' : 'Import and compare'}</button>
          <span className="text-[12.5px] text-muted-foreground">Every entry is compared with the tracker straight away.</span>
        </div>
        {result && (
          <MoneyBanner tone={result.problems.length ? 'wait' : 'ok'} title={`${result.saved} entries read; ${result.reconcile.items} items compared.`}
            action={<button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={onDone}>See the differences</button>}>
            {result.problems.length ? `${plural(result.problems.length, 'row')} skipped: ${result.problems.slice(0, 3).join('; ')}.` : 'No rows were skipped.'}
          </MoneyBanner>
        )}
      </form>
    </section>
  );
}

function Drafts({ provider }) {
  const toast = useToast();
  const wide = useMediaQuery('(min-width: 768px)');
  const { data, loading, error, refetch } = useFetch(() => api.list('payment-stages', { stage_status: 'To Invoice', limit: 200 }));
  const [draft, setDraft] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(false);
  async function preview(id) {
    try { setFailure(null); setDraft((await api.raw(`/accounting/stages/${id}/draft`)).data); } catch (err) { toast(err.message, 'danger'); }
  }
  async function create(body, ok) {
    setBusy(true); setFailure(null);
    try {
      const r = await api.action(`/accounting/stages/${draft.stage_id}/draft`, body);
      toast(ok(r), 'success'); setDraft(null);
    } catch (err) { setFailure(err.message); } finally { setBusy(false); }
  }
  async function downloadXml() {
    const r = await fetch(`/api/accounting/stages/${draft.stage_id}/draft`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'tally_xml' }) });
    if (!r.ok) { setFailure((await r.json().catch(() => ({}))).error?.message || 'Could not build the voucher'); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = `tally-voucher-stage-${draft.stage_id}.xml`; a.click(); URL.revokeObjectURL(url);
  }
  const rows = data?.data ?? [];
  return (
    <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="drafts-t">
      <div className="app-panel__head"><div className="app-panel__titles"><h2 className="mg-panel__title" id="drafts-t">Stages ready to invoice</h2><span className="mg-panel__hint">Preview what the invoice should say, then create it as a draft in the books.</span></div></div>
      {loading && !data ? <div className="app-panel__body flex flex-col gap-2.5 p-5" aria-busy="true" aria-label="Loading">{[0, 1].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</div>
        : error ? <div className="app-panel__body p-5"><MoneyBanner tone="late" role="alert" title="Couldn't load the stages." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{error}</MoneyBanner></div>
        : !rows.length ? <StateCard inPanel title="Nothing to invoice" text="No stage is billable right now." />
        : wide ? (
          <div className="mg-tablewrap app-panel__body">
            <table className="mg-table">
              <thead><tr><th>PO</th><th>Client</th><th>Stage</th><th className="num">Amount</th><th aria-label="Actions" /></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td><Link className="app-link mg-num" to={`/purchase-orders/${encodeURIComponent(r.po_number)}`}>{r.po_number}</Link></td>
                  <td className="font-bold">{r.client_name}</td>
                  <td>{r.stage_no}. {r.stage_name}</td>
                  <td className="num font-bold">{money(r.stage_amount, r.currency)}</td>
                  <td><span className="app-acts"><button type="button" className="mg-btn mg-btn--sm" onClick={() => preview(r.id)}><FileText className="size-4" strokeWidth={1.8} aria-hidden="true" />Draft invoice</button></span></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : (
          <div className="mg-rows app-panel__body">{rows.map((r) => (
            <div key={r.id} className="mg-row">
              <span className="mg-row__title">{r.client_name}</span><span className="mg-row__amount mg-num">{money(r.stage_amount, r.currency)}</span>
              <span className="mg-row__meta">PO {r.po_number} · {r.stage_no}. {r.stage_name}</span>
              <span className="app-pinv__btns"><button type="button" className="mg-btn" onClick={() => preview(r.id)}>Draft invoice</button></span>
            </div>
          ))}</div>
        )}
      {draft && (
        <Modal title="Draft invoice" subtitle={draft.reference} onClose={() => setDraft(null)}
          footer={<>
            <Button type="button" variant="ghost" onClick={() => setDraft(null)} className="max-sm:w-full">Close</Button>
            <Button type="button" variant="outline" onClick={downloadXml} className="max-sm:w-full">Tally voucher (XML)</Button>
            {provider === 'zoho' && <Button type="button" disabled={busy} onClick={() => create({ target: 'zoho' }, (r) => `Draft ${r.data.result.number || ''} created in ${r.data.result.system}`)} className="max-sm:w-full">{busy ? 'Creating…' : 'Create in Zoho Books'}</Button>}
            {provider === 'tally' && <Button type="button" disabled={busy} onClick={() => create({ target: 'tally', push: true }, () => 'Voucher sent to Tally')} className="max-sm:w-full">{busy ? 'Sending…' : 'Send to Tally'}</Button>}
          </>}>
          <div className="flex flex-col gap-4">
            <DialogError error={failure} what="the draft" />
            {draft.problems.length > 0 && <MoneyBanner tone="wait" icon={TriangleAlert} title="Check before you create it.">{draft.problems.join('. ')}.</MoneyBanner>}
            <dl className="mg-facts">
              <div><dt>Customer</dt><dd>{draft.customer.name}{draft.customer.books_name ? ` (books: ${draft.customer.books_name})` : ''}</dd></div>
              <div><dt>GSTIN</dt><dd>{draft.customer.gstin || '—'}</dd></div>
              <div><dt>Supply</dt><dd>{draft.supply}{draft.place_of_supply ? `, state ${draft.place_of_supply}` : ''}</dd></div>
              <div><dt>Taxable</dt><dd className="mg-num">{money(draft.taxable, draft.currency)}</dd></div>
              <div><dt>GST {draft.gst_rate}%</dt><dd className="mg-num">{draft.intra ? `CGST ${money(draft.cgst)} + SGST ${money(draft.sgst)}` : `IGST ${money(draft.igst)}`}</dd></div>
              <div><dt>Total</dt><dd className="mg-num">{money(draft.total, draft.currency)}</dd></div>
            </dl>
            {draft.description && <p className="m-0 text-[13px] text-secondary-text">{draft.description}</p>}
          </div>
        </Modal>
      )}
    </section>
  );
}

function Mappings() {
  const toast = useToast();
  const lookups = useLookups();
  const wide = useMediaQuery('(min-width: 768px)');
  const { data, loading, error, refetch } = useFetch(() => api.raw('/accounting/mappings'));
  const [v, setV] = useState({ kind: 'customer', tracker_ref: '', books_ref: '', books_name: '' });
  const [failure, setFailure] = useState(null);
  const [fields, setFields] = useState({});
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault(); setFailure(null); setFields({});
    try { await api.action('/accounting/mappings', v); toast('Mapping saved', 'success'); setV({ ...v, tracker_ref: '', books_ref: '', books_name: '' }); refetch(); }
    catch (err) { setFields(err.fields || {}); setFailure(err.message); }
  }
  async function remove() {
    setBusy(true);
    try { await api.remove('accounting/mappings', removing.id); toast('Mapping removed', 'success'); setRemoving(null); refetch(); }
    catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); }
  }
  const rows = data?.data ?? [];
  return (
    <>
      <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="map-add-t">
        <div className="app-panel__head"><div className="app-panel__titles"><h2 className="mg-panel__title" id="map-add-t">Add a mapping</h2><span className="mg-panel__hint">Customer: which customer in the books a client is (its Zoho customer id, or the Tally ledger name). Service &quot;default&quot;: the Zoho item used on draft invoices.</span></div></div>
        <form className="app-panel__body flex flex-col gap-4 p-5 sm:px-6" onSubmit={save}>
          {failure && <DialogError error={failure} what="the mapping" />}
          <div className="app-form4">
            <Field label="Kind"><Select value={v.kind} placeholder={null} options={[{ value: 'customer', label: 'Customer' }, { value: 'service', label: 'Service' }, { value: 'ledger', label: 'Ledger' }, { value: 'tax', label: 'Tax' }]} onChange={(e) => setV({ ...v, kind: e.target.value, tracker_ref: '' })} /></Field>
            {v.kind === 'customer'
              ? <Field label="Client" required error={fields.tracker_ref}><Select value={v.tracker_ref} placeholder="Choose a client" options={lookups.companies.map((c) => ({ value: String(c.id), label: c.name }))} onChange={(e) => setV({ ...v, tracker_ref: e.target.value })} /></Field>
              : <Field label="Tracker name" required error={fields.tracker_ref} hint={'Such as "default".'}><Input value={v.tracker_ref} onChange={(e) => setV({ ...v, tracker_ref: e.target.value })} placeholder="default" /></Field>}
            <Field label="Id in the books" required error={fields.books_ref}><Input value={v.books_ref} onChange={(e) => setV({ ...v, books_ref: e.target.value })} /></Field>
            <Field label="Name in the books" error={fields.books_name} hint="Pick from customers in the books with no client yet."><Input list="books-names" value={v.books_name} onChange={(e) => setV({ ...v, books_name: e.target.value })} /><datalist id="books-names">{(data?.unmatched ?? []).map((u) => <option key={u.customer_name} value={u.customer_name} />)}</datalist></Field>
          </div>
          <div className="flex justify-end"><button type="submit" className="mg-btn mg-btn--primary" disabled={!v.tracker_ref || !v.books_ref}>Save mapping</button></div>
        </form>
      </section>
      {data?.unmatched?.length > 0 && (
        <MoneyBanner tone="wait" title={`${plural(data.unmatched.length, 'customer')} in the books ${data.unmatched.length === 1 ? 'has' : 'have'} no matching client.`}>
          {data.unmatched.map((u) => u.customer_name).join(', ')}. Map them above, or add the client first.
        </MoneyBanner>
      )}
      <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="map-t">
        <div className="app-panel__head"><h2 className="mg-panel__title" id="map-t">Mappings</h2>{!loading && !error && <Tone>{plural(rows.length, 'mapping')}</Tone>}</div>
        {loading && !data ? <div className="app-panel__body flex flex-col gap-2.5 p-5" aria-busy="true" aria-label="Loading">{[0, 1].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</div>
          : error ? <div className="app-panel__body p-5"><MoneyBanner tone="late" role="alert" title="Couldn't load the mappings." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{error}</MoneyBanner></div>
          : !rows.length ? <p className="app-panel__note">None yet. Clients are matched by GSTIN or name until they are mapped.</p>
          : wide ? (
            <div className="mg-tablewrap app-panel__body">
              <table className="mg-table">
                <thead><tr><th>Kind</th><th>In the tracker</th><th>Id in the books</th><th>Name in the books</th><th className="num">Remove</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id}>
                    <td><Tone>{String(r.kind).replace(/^./, (x) => x.toUpperCase())}</Tone></td>
                    <td className="font-bold">{r.tracker_name}</td>
                    <td className="mg-num text-secondary-text">{r.books_ref}</td>
                    <td>{r.books_name}</td>
                    <td className="num"><button type="button" className="mg-iconbtn" aria-label={`Remove the mapping for ${r.tracker_name}`} onClick={() => setRemoving(r)}><X strokeWidth={1.8} aria-hidden="true" /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : (
            <div className="mg-rows app-panel__body">{rows.map((r) => (
              <div key={r.id} className="mg-row">
                <span className="mg-row__title">{r.tracker_name}</span>
                <span className="mg-row__amount"><button type="button" className="mg-iconbtn" aria-label={`Remove the mapping for ${r.tracker_name}`} onClick={() => setRemoving(r)}><X strokeWidth={1.8} aria-hidden="true" /></button></span>
                <span className="mg-row__meta">{String(r.kind).replace(/^./, (x) => x.toUpperCase())} · {r.books_ref}{r.books_name ? ` · ${r.books_name}` : ''}</span>
              </div>
            ))}</div>
          )}
      </section>
      {removing && (
        <ConfirmDialog
          title={`Remove the mapping for ${removing.tracker_name}?`}
          message={`${removing.tracker_name} goes back to being matched by GSTIN or name. Draft invoices and checks that used ${removing.books_name || removing.books_ref} stop using it.`}
          confirmLabel="Remove mapping"
          busy={busy}
          onConfirm={remove}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function Reports() {
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(today());
  const wide = useMediaQuery('(min-width: 768px)');
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/accounting/reports/summary?from=${from}&to=${to}`), [from, to]);
  const d = data?.data;
  const agree = (a, b) => (Math.abs(Number(a) - Number(b)) < 1 ? <Tone tone="ok">Agrees with the books</Tone> : <Tone tone="wait">Books: {money(b)}</Tone>);
  return (
    <>
      <section className="mg-glass mg-glass--strong app-panel app-period" data-a="rise" aria-labelledby="period-t">
        <div className="app-period__dates">
          <h2 className="mg-panel__title" id="period-t">Period</h2>
          <div className="flex flex-wrap gap-3">
            <label className="mg-field"><span className="mg-field__label">From</span><input className="mg-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="mg-field"><span className="mg-field__label">To</span><input className="mg-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
        </div>
        <div className="app-mfacts app-period__note"><FileText aria-hidden="true" /><span><b>For the accountant</b><br />These are reports, not filings. Download them and check them against the books before use. The period starts with the financial year.</span></div>
      </section>
      {loading && !d ? <TabLoading rows={4} /> : error ? (
        <MoneyBanner tone="late" role="alert" title="Couldn't load the TDS and GST figures." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{error}</MoneyBanner>
      ) : d && (
        <>
          <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="tds-t">
            <div className="app-panel__head">
              <div className="app-panel__titles"><h2 className="mg-panel__title" id="tds-t">TDS deducted by clients</h2><span className="mg-panel__hint">From payments recorded with TDS, by client and financial-year quarter.</span></div>
              <div className="app-panel__tools"><a className="mg-btn mg-btn--sm" href={`/api/accounting/reports/tds.csv?from=${from}&to=${to}`}><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Download CSV</a></div>
            </div>
            {!d.tds.by_client.length ? <p className="app-panel__note">No TDS in this period.</p> : wide ? (
              <div className="mg-tablewrap app-panel__body">
                <table className="mg-table">
                  <thead><tr><th>Quarter</th><th>Client</th><th>PAN</th><th className="num">Payments</th><th className="num">Received</th><th className="num">TDS</th></tr></thead>
                  <tbody>{d.tds.by_client.map((r, i) => <tr key={i}><td>{r.quarter}</td><td className="font-bold">{r.client}</td><td className="mg-num text-secondary-text">{r.pan || '—'}</td><td className="num">{r.payments}</td><td className="num">{money(r.received)}</td><td className="num font-bold">{money(r.tds)}</td></tr>)}</tbody>
                  <tfoot><tr className="app-total"><td>Total</td><td colSpan={2}>{d.tds.books_total > 0 && agree(d.tds.total, d.tds.books_total)}</td><td className="num">{d.tds.by_client.reduce((t, r) => t + Number(r.payments || 0), 0)}</td><td className="num">{money(d.tds.by_client.reduce((t, r) => t + Number(r.received || 0), 0))}</td><td className="num">{money(d.tds.total)}</td></tr></tfoot>
                </table>
              </div>
            ) : (
              <div className="mg-rows app-panel__body">
                {d.tds.by_client.map((r, i) => <div key={i} className="mg-row"><span className="mg-row__title">{r.client}</span><span className="mg-row__amount mg-num">{money(r.tds)}</span><span className="mg-row__meta">{r.quarter} · {plural(Number(r.payments), 'payment')} · {money(r.received)} received</span></div>)}
                {/* The TDS total shows on a phone too. */}
                <div className="mg-row"><span className="mg-row__title">Total TDS</span><span className="mg-row__amount mg-num">{money(d.tds.total)}</span>{d.tds.books_total > 0 && <span className="mg-row__state">{agree(d.tds.total, d.tds.books_total)}</span>}</div>
              </div>
            )}
          </section>
          <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="gst-t">
            <div className="app-panel__head">
              <div className="app-panel__titles"><h2 className="mg-panel__title" id="gst-t">GST on sales</h2><span className="mg-panel__hint">Invoices raised in the period, split as the GSTR-1 needs them.</span></div>
              <div className="app-panel__tools"><a className="mg-btn mg-btn--sm" href={`/api/accounting/reports/gstr1-b2b.csv?from=${from}&to=${to}`}><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />B2B CSV (GSTR-1 format)</a></div>
            </div>
            <div className="app-panel__body app-gst">
              <div><span className="mg-label">B2B invoices (valid GSTIN)</span><b>{plural(d.gst.b2b.invoices, 'invoice')}</b><span>{money(d.gst.b2b.taxable)} taxable · value {money(d.gst.b2b.value)}</span></div>
              <div><span className="mg-label">Without a valid GSTIN</span><b>{plural(d.gst.b2c.invoices, 'invoice')}</b><span>{money(d.gst.b2c.taxable)} taxable</span></div>
              <div><span className="mg-label">In foreign currency (export)</span><b>{plural(d.gst.foreign_currency.invoices, 'invoice')}</b><span>zero-rated</span></div>
              <div><span className="mg-label">Books, same period</span>{d.gst.books.invoices ? <><b>{money(d.gst.books.taxable)}</b><span>{plural(d.gst.books.invoices, 'invoice')}, taxable</span><span>{agree(d.gst.b2b.taxable + d.gst.b2c.taxable, d.gst.books.taxable)}</span></> : <><b className="font-normal text-muted-foreground">—</b><span>No books entries imported</span></>}</div>
            </div>
            {d.gst.missing_gstin.length > 0 && (
              <div className="px-5 pb-5 sm:px-6">
                <MoneyBanner tone="wait" title={`Add GSTINs on the company records for: ${[...new Set(d.gst.missing_gstin.map((m) => m.client))].join(', ')}.`}>
                  {d.gst.missing_gstin.map((m) => m.invoice_no).join(', ')} {d.gst.missing_gstin.length === 1 ? 'is' : 'are'} reported without a GSTIN until then.
                </MoneyBanner>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

