import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, DataTable, Empty, Field, Input, KeyValues, Modal, Select, Stat, Tabs, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money, today } from '../lib/format.js';

/**
 * Accounting (#48): what the books say against what the tracker says,
 * draft invoices for due stages, customer mappings, and TDS/GST reports.
 */
const STATUS = { amount_differs: ['Amount differs', 'danger'], date_differs: ['Date differs', 'warning'], missing_in_books: ['Not in the books', 'warning'], missing_in_tracker: ['Not in the tracker', 'danger'], resolved: ['Resolved', 'success'], matched: ['Matched', 'success'] };
const fyStart = () => { const t = today(); const y = Number(t.slice(0, 4)) - (Number(t.slice(5, 7)) < 4 ? 1 : 0); return `${y}-04-01`; };

export default function Accounting() {
  const [tab, setTab] = useState('differences');
  const status = useFetch(() => api.raw('/accounting/status'), [tab]);
  const s = status.data?.data;
  const open = s ? Object.entries(s.counts).filter(([k]) => !['matched', 'resolved'].includes(k)).reduce((t, [, n]) => t + n, 0) : 0;
  return (
    <>
      <PageHeader title="Accounting" subtitle="The books against the tracker. The books win on invoice and payment details; every difference waits here until it is taken or explained." />
      <div className="page stack">
        {s && (
          <div className="auto-grid--stats">
            <Stat label="Books" value={{ none: 'Not connected', zoho: 'Zoho Books', tally: 'Tally Prime', file: 'Export files' }[s.provider]} meta={s.provider === 'zoho' ? (s.zoho ? 'API set up' : 'ZOHO_* not set') : s.provider === 'tally' ? (s.tally ? 'Tally reachable by URL' : 'upload day-book exports') : s.provider === 'file' ? 'upload exports under Import' : 'set accounting_provider in Settings'} />
            <Stat label="Open differences" value={open} tone={open ? 'danger' : 'ok'} />
            <Stat label="Matched" value={s.counts.matched || 0} meta={`${s.counts.resolved || 0} resolved by hand`} />
            <Stat label="Last activity" value={s.last ? s.last.action : '—'} meta={s.last ? new Date(s.last.created_at).toLocaleString() : ''} />
          </div>
        )}
        <Tabs active={tab} onChange={setTab} tabs={[{ key: 'differences', label: 'Differences', count: open }, { key: 'import', label: 'Import' }, { key: 'drafts', label: 'Draft invoices' }, { key: 'mappings', label: 'Mappings' }, { key: 'reports', label: 'TDS & GST' }]} />
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
  const [show, setShow] = useState('');
  const { data, refetch } = useFetch(() => api.raw(`/accounting/items${show ? `?status=${show}` : ''}`), [show]);
  const [resolving, setResolving] = useState(null);
  async function run(fn, ok) {
    try { const r = await fn(); toast(typeof ok === 'function' ? ok(r) : ok, 'success'); refetch(); onChanged(); } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  const describe = (d) => (d.field === 'payment' ? `Books: ${money(d.books)} received${d.tds ? ` + ${money(d.tds)} TDS` : ''} on ${date(d.date)}` : `${d.field.replace('_', ' ')}: tracker ${d.field.includes('date') || d.field === 'received_on' ? date(d.tracker) : d.tracker ?? '—'}, books ${d.field.includes('date') || d.field === 'received_on' ? date(d.books) : d.books ?? '—'}${d.note ? ` (${d.note})` : ''}`);
  return (
    <Card flush title="Differences" hint="Take the books' value where it can be applied, or fix it by hand and say what was done."
      actions={<div className="card__actions">
        <Select value={show} placeholder="Open only" options={[{ value: 'resolved', label: 'Resolved' }, { value: 'matched', label: 'Matched' }]} onChange={(e) => setShow(e.target.value)} />
        <button type="button" className="btn btn--sm" onClick={() => run(() => api.action('/accounting/reconcile'), (r) => `Checked ${r.data.items} items`)}>Check again</button>
        {provider === 'zoho' && <button type="button" className="btn btn--sm btn--primary" onClick={() => run(() => api.action('/accounting/sync'), (r) => `Pulled ${r.data.pulled} entries`)}>Pull from Zoho</button>}
      </div>}>
      <DataTable rows={data?.data ?? []} empty={<Empty icon="✓" title="Nothing to look at" text="Import invoices and payments from the books to compare them." />} columns={[
        { key: 'kind', header: 'What', render: (r) => <Badge>{r.kind}</Badge> },
        { key: 'ref', header: 'Invoice', className: 'mono', render: (r) => r.invoice_no || r.books_number || '—' },
        { key: 'client', header: 'Client', render: (r) => r.client_name || r.books_customer || '—' },
        { key: 'status', header: 'Status', render: (r) => <Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge> },
        { key: 'diff', header: 'Difference', className: 'wrap small', render: (r) => (r.differences.length ? r.differences.map((d, i) => <div key={i}>{describe(d)}</div>) : r.status === 'missing_in_books' ? `Tracker: ${money(r.stage_amount ?? r.payment_amount)}` : r.status === 'missing_in_tracker' ? `Books: ${money(r.books_taxable ?? r.books_total)} on ${date(r.books_date)}` : '') },
        { key: 'note', header: 'Note', className: 'small muted wrap', render: (r) => (r.note ? `${r.note}${r.resolved_by ? ` · ${r.resolved_by}` : ''}` : '') },
        {
          key: 'act', header: '', align: 'right', render: (r) => r.status !== 'resolved' && r.status !== 'matched' && (
            <div className="table__actions">
              {(r.differences.some((d) => ['invoice_date', 'due_date', 'received_on', 'tds_amount', 'payment'].includes(d.field))) && <button type="button" className="btn btn--sm" onClick={() => run(() => api.action(`/accounting/items/${r.id}/accept`), 'Books value applied')}>Take books value</button>}
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setResolving(r)}>Resolve</button>
            </div>
          ),
        },
      ]} />
      {resolving && (
        <ResolveDialog item={resolving} onClose={() => setResolving(null)} onSave={(note) => run(() => api.action(`/accounting/items/${resolving.id}/resolve`, { note }), 'Resolved').then(() => setResolving(null))} />
      )}
    </Card>
  );
}

function ResolveDialog({ item, onClose, onSave }) {
  const [note, setNote] = useState('');
  return (
    <Modal size="sm" title="Resolve this difference" subtitle={`${item.invoice_no || item.books_number || ''}: say what was fixed, or why the two may differ.`} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn--primary" disabled={!note.trim()} onClick={() => onSave(note)}>Resolve</button></>}>
      <Field label="Note" required><Input value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

function Import({ onDone }) {
  const toast = useToast();
  const [kind, setKind] = useState('invoice');
  const [source, setSource] = useState('zoho');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.upload(`/accounting/import?kind=${kind}&source=${source}`, fd);
      setResult(r.data); toast(`${r.data.saved} entries read`, 'success');
    } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); }
  }
  return (
    <Card title="Import from the books" hint="Zoho Books: Sales › Invoices (or Payments Received) › Export. Tally: Day Book › Export as Excel or CSV. Entries seen again replace the old copy.">
      <div className="form-grid">
        <Field label="What is in the file"><Select value={kind} placeholder={null} options={[{ value: 'invoice', label: 'Invoices' }, { value: 'payment', label: 'Payments received' }]} onChange={(e) => setKind(e.target.value)} /></Field>
        <Field label="From"><Select value={source} placeholder={null} options={[{ value: 'zoho', label: 'Zoho Books export' }, { value: 'tally', label: 'Tally export (day book sorts itself)' }, { value: 'file', label: 'Another sheet' }]} onChange={(e) => setSource(e.target.value)} /></Field>
        <div className="span-all"><Field label="File" hint="CSV or Excel, up to 10 MB. Dates are read day first."><input type="file" className="input" accept=".csv,.xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field></div>
      </div>
      <div className="card__actions" style={{ marginTop: 12 }}><button type="button" className="btn btn--primary" disabled={!file || busy} onClick={go}>{busy ? 'Reading…' : 'Import and compare'}</button></div>
      {result && (
        <div className="stack" style={{ marginTop: 12 }}>
          <Alert tone={result.problems.length ? 'warning' : 'success'}><span>{result.saved} entries read; {result.reconcile.items} items compared.{result.problems.length ? ` ${result.problems.length} rows skipped: ${result.problems.slice(0, 3).join('; ')}` : ''}</span></Alert>
          <button type="button" className="btn" onClick={onDone}>See the differences</button>
        </div>
      )}
    </Card>
  );
}

function Drafts({ provider }) {
  const toast = useToast();
  const { data } = useFetch(() => api.list('payment-stages', { stage_status: 'To Invoice', limit: 200 }));
  const [draft, setDraft] = useState(null);
  async function preview(id) {
    try { setDraft((await api.raw(`/accounting/stages/${id}/draft`)).data); } catch (err) { toast(err.message, 'danger'); }
  }
  async function create(target) {
    try {
      const r = await api.action(`/accounting/stages/${draft.stage_id}/draft`, { target });
      toast(`Draft ${r.data.result.number || ''} created in ${r.data.result.system}`, 'success'); setDraft(null);
    } catch (err) { toast(err.message, 'danger'); }
  }
  async function downloadXml() {
    const r = await fetch(`/api/accounting/stages/${draft.stage_id}/draft`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'tally_xml' }) });
    if (!r.ok) { toast((await r.json().catch(() => ({}))).error?.message || 'Could not build the voucher', 'danger'); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = `tally-voucher-stage-${draft.stage_id}.xml`; a.click(); URL.revokeObjectURL(url);
  }
  return (
    <Card flush title="Stages ready to invoice" hint="Preview what the invoice should say, then create it as a draft in the books.">
      <DataTable rows={data?.data ?? []} empty={<Empty title="Nothing to invoice" />} columns={[
        { key: 'po_number', header: 'PO', className: 'mono' },
        { key: 'client_name', header: 'Client', className: 'strong' },
        { key: 'stage_name', header: 'Stage' },
        { key: 'stage_amount', header: 'Amount', align: 'right', render: (r) => money(r.stage_amount, r.currency) },
        { key: 'act', header: '', align: 'right', render: (r) => <button type="button" className="btn btn--sm" onClick={() => preview(r.id)}>Draft invoice</button> },
      ]} />
      {draft && (
        <Modal title="Draft invoice" subtitle={draft.reference} onClose={() => setDraft(null)}
          footer={<>
            <button type="button" className="btn" onClick={() => setDraft(null)}>Close</button>
            <button type="button" className="btn" onClick={downloadXml}>Tally voucher (XML)</button>
            {provider === 'zoho' && <button type="button" className="btn btn--primary" onClick={() => create('zoho')}>Create in Zoho Books</button>}
            {provider === 'tally' && <button type="button" className="btn btn--primary" onClick={() => api.action(`/accounting/stages/${draft.stage_id}/draft`, { target: 'tally', push: true }).then(() => { toast('Voucher sent to Tally', 'success'); setDraft(null); }).catch((e) => toast(e.message, 'danger'))}>Send to Tally</button>}
          </>}>
          {draft.problems.length > 0 && <Alert tone="warning"><span>{draft.problems.join('. ')}.</span></Alert>}
          <KeyValues items={[
            { label: 'Customer', value: `${draft.customer.name}${draft.customer.books_name ? ` (books: ${draft.customer.books_name})` : ''}` },
            { label: 'GSTIN', value: draft.customer.gstin },
            { label: 'Supply', value: `${draft.supply}${draft.place_of_supply ? `, state ${draft.place_of_supply}` : ''}` },
            { label: 'Taxable', value: money(draft.taxable, draft.currency) },
            { label: `GST ${draft.gst_rate}%`, value: draft.intra ? `CGST ${money(draft.cgst)} + SGST ${money(draft.sgst)}` : `IGST ${money(draft.igst)}` },
            { label: 'Total', value: <strong>{money(draft.total, draft.currency)}</strong> },
            { label: 'Description', value: draft.description },
          ]} />
        </Modal>
      )}
    </Card>
  );
}

function Mappings() {
  const toast = useToast();
  const lookups = useLookups();
  const { data, refetch } = useFetch(() => api.raw('/accounting/mappings'));
  const [v, setV] = useState({ kind: 'customer', tracker_ref: '', books_ref: '', books_name: '' });
  async function save() {
    try { await api.action('/accounting/mappings', v); toast('Saved', 'success'); setV({ ...v, tracker_ref: '', books_ref: '', books_name: '' }); refetch(); } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
  }
  return (
    <>
      <Card title="Add a mapping" hint="Customer: which customer in the books a client is (its Zoho customer id, or Tally ledger name). Service 'default': the Zoho item used on draft invoices.">
        <div className="form-grid">
          <Field label="Kind"><Select value={v.kind} placeholder={null} options={['customer', 'service', 'ledger', 'tax']} onChange={(e) => setV({ ...v, kind: e.target.value, tracker_ref: '' })} /></Field>
          {v.kind === 'customer'
            ? <Field label="Client"><Select value={v.tracker_ref} options={lookups.companies.map((c) => ({ value: String(c.id), label: c.name }))} onChange={(e) => setV({ ...v, tracker_ref: e.target.value })} /></Field>
            : <Field label="Tracker name"><Input value={v.tracker_ref} onChange={(e) => setV({ ...v, tracker_ref: e.target.value })} placeholder="default" /></Field>}
          <Field label="Id in the books"><Input value={v.books_ref} onChange={(e) => setV({ ...v, books_ref: e.target.value })} /></Field>
          <Field label="Name in the books"><Input list="books-names" value={v.books_name} onChange={(e) => setV({ ...v, books_name: e.target.value })} /><datalist id="books-names">{(data?.unmatched ?? []).map((u) => <option key={u.customer_name} value={u.customer_name} />)}</datalist></Field>
        </div>
        <div className="card__actions" style={{ marginTop: 12 }}><button type="button" className="btn btn--primary" disabled={!v.tracker_ref || !v.books_ref} onClick={save}>Save</button></div>
      </Card>
      {data?.unmatched?.length > 0 && <Alert tone="warning"><span>Customers in the books with no matching client: {data.unmatched.map((u) => u.customer_name).join(', ')}.</span></Alert>}
      <Card flush title="Mappings">
        <DataTable rows={data?.data ?? []} empty={<div className="small muted px-[18px] py-3">None yet. Clients are matched by GSTIN or name until mapped.</div>} columns={[
          { key: 'kind', header: 'Kind', render: (r) => <Badge>{r.kind}</Badge> },
          { key: 'tracker_name', header: 'In the tracker', className: 'strong' },
          { key: 'books_ref', header: 'Id in the books', className: 'mono' },
          { key: 'books_name', header: 'Name in the books' },
          { key: 'act', header: '', align: 'right', render: (r) => <button type="button" className="btn btn--sm btn--ghost" onClick={() => api.remove('accounting/mappings', r.id).then(refetch)}>✕</button> },
        ]} />
      </Card>
    </>
  );
}

function Reports() {
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(today());
  const { data } = useFetch(() => api.raw(`/accounting/reports/summary?from=${from}&to=${to}`), [from, to]);
  const d = data?.data;
  const agree = (a, b) => (Math.abs(Number(a) - Number(b)) < 1 ? <Badge tone="success">agrees with the books</Badge> : <Badge tone="warning">books: {money(b)}</Badge>);
  return (
    <>
      <Card title="Period" actions={<div className="card__actions"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>}>
        <p className="small muted">For the accountant: these are reports, not filings. Download them and check them against the books before use.</p>
      </Card>
      {d && (
        <>
          <Card flush title="TDS deducted by clients" hint="From payments recorded with TDS, by client and financial-year quarter."
            actions={<a className="btn btn--sm" href={`/api/accounting/reports/tds.csv?from=${from}&to=${to}`}>Download CSV</a>}>
            <DataTable rows={d.tds.by_client} empty={<div className="small muted px-[18px] py-3">No TDS in this period.</div>} columns={[
              { key: 'quarter', header: 'Quarter' }, { key: 'client', header: 'Client', className: 'strong' }, { key: 'pan', header: 'PAN', className: 'mono' },
              { key: 'payments', header: 'Payments', align: 'right' }, { key: 'received', header: 'Received', align: 'right', render: (r) => money(r.received) },
              { key: 'tds', header: 'TDS', align: 'right', render: (r) => money(r.tds) },
            ]} footer={<><td colSpan={5} className="strong">Total</td><td className="num strong">{money(d.tds.total)} {d.tds.books_total > 0 && agree(d.tds.total, d.tds.books_total)}</td></>} />
          </Card>
          <Card title="GST on sales" hint="Invoices raised in the period, split as the GSTR-1 needs them."
            actions={<a className="btn btn--sm" href={`/api/accounting/reports/gstr1-b2b.csv?from=${from}&to=${to}`}>B2B CSV (GSTR-1 format)</a>}>
            <KeyValues items={[
              { label: 'B2B invoices (valid GSTIN)', value: `${d.gst.b2b.invoices} · taxable ${money(d.gst.b2b.taxable)} · value ${money(d.gst.b2b.value)}` },
              { label: 'Without a valid GSTIN', value: `${d.gst.b2c.invoices} · taxable ${money(d.gst.b2c.taxable)}` },
              { label: 'In foreign currency (export)', value: d.gst.foreign_currency.invoices },
              { label: 'Books, same period', value: d.gst.books.invoices ? <>{d.gst.books.invoices} invoices · taxable {money(d.gst.books.taxable)} {agree(d.gst.b2b.taxable + d.gst.b2c.taxable, d.gst.books.taxable)}</> : 'no books entries imported' },
            ]} />
            {d.gst.missing_gstin.length > 0 && <Alert tone="warning"><span>Add GSTINs on the company records for: {d.gst.missing_gstin.map((m) => `${m.client} (${m.invoice_no})`).join(', ')}.</span></Alert>}
          </Card>
        </>
      )}
    </>
  );
}
