import { useEffect, useState } from 'react';

/**
 * The client portal (#47): a few plain pages for a client contact, outside
 * the staff app. Sign-in is by a one-time link sent to their email.
 *
 * Since #198 it shows the same figures we hold: each PO with its schedule
 * and what is still to bill, and every invoice with taxable value, GST and
 * the total including GST. The sections are exported for the staff
 * "preview as client", which draws them from the preview API instead.
 *
 * Phase 2: the client answers. They confirm an invoice, raise a query on an
 * invoice or a PO, or tell us they paid, and see where each stands. Files
 * go both ways: what our team shares, and what the client uploads.
 */
const BASE = '/api/portal';
async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(json.error?.message || 'Something went wrong'); e.status = r.status; e.fields = json.error?.fields; throw e; }
  return json.data;
}
/** A form post (a file with it) or a delete: the client's answers and uploads (#198). */
async function send(path, { method = 'POST', form } = {}) {
  const r = await fetch(`${BASE}${path}`, { method, credentials: 'same-origin', body: form });
  if (r.status === 204) return null;
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(json.error?.message || 'Something went wrong'); e.status = r.status; e.fields = json.error?.fields; throw e; }
  return json.data;
}
const problem = (ex) => (ex.fields ? Object.values(ex.fields)[0] : ex.message);
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const money =(n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(n)));
// To the paisa, so the client can tick our figure against their own books.
const exact = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n)));
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
// A timestamp (when something was sent or uploaded), on the reader's own day.
const when = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const PORTAL_LABEL = { projects: 'Projects & orders', documents: 'Documents', invoices: 'Invoices', certificates: 'Certificates', contact: 'Contact us' };

export default function Portal({ loginToken }) {
  const [me, setMe] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        if (loginToken) { await call('/login', { token: loginToken }); window.history.replaceState(null, '', '/portal'); }
        setMe(await call('/me'));
      } catch (e) { setMe(null); if (loginToken) setError(e.message); }
    })();
  }, [loginToken]);

  if (me === undefined) return <div className="accept"><div className="accept__card">Loading…</div></div>;
  if (!me) return <SignIn error={error} />;
  return <Home me={me} onOut={async () => { await call('/logout', {}).catch(() => {}); setMe(null); }} />;
}

function SignIn({ error }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error);
  async function go(e) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setSent((await call('/request-link', { email })).message); } catch (ex) { setErr(ex.fields ? Object.values(ex.fields)[0] : ex.message); } finally { setBusy(false); }
  }
  return (
    <div className="accept">
      <form className="accept__card accept__form" onSubmit={go} style={{ maxWidth: 440 }}>
        <h1>Client portal</h1>
        <p className="accept__muted">Enter the email address we have for you. We will send a link that signs you in.</p>
        {sent ? <div className="accept__done accept__done--ok">{sent}</div> : <>
          <label>Email<input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></label>
          {err && <div className="accept__error">{err}</div>}
          <div className="accept__actions"><button type="submit" className="btn btn--primary" disabled={busy}>{busy ? 'Sending…' : 'Send me a link'}</button></div>
        </>}
      </form>
    </div>
  );
}

function Home({ me, onOut }) {
  const [tab, setTab] = useState(me.sections[0]);
  return (
    <div className="accept">
      <div className="accept__card portal">
        <div className="accept__head">
          <div><div className="accept__seller">Client portal</div><h1>{me.company_name}</h1><div className="accept__muted">Signed in as {me.contact_name}</div></div>
          <button type="button" className="btn" onClick={onOut}>Sign out</button>
        </div>
        <div className="portal__tabs">{me.sections.map((s) => <button type="button" key={s} className={`portal__tab ${tab === s ? 'is-on' : ''}`} onClick={() => setTab(s)}>{PORTAL_LABEL[s]}</button>)}</div>
        <PortalSection name={tab} sections={me.sections} />
      </div>
    </div>
  );
}

/**
 * One section of the portal. `load` fetches a section's data (the portal's
 * own API by default; the staff preview passes its own), and `preview`
 * turns links into plain text: files open from the client's own session.
 */
export function PortalSection({ name, sections, load = call, preview = false }) {
  const ctx = { load, preview, sections };
  if (name === 'projects') return <Projects ctx={ctx} />;
  if (name === 'documents') return <Documents ctx={ctx} />;
  if (name === 'invoices') return <Invoices ctx={ctx} />;
  if (name === 'certificates') return <Certificates ctx={ctx} />;
  if (name === 'contact') return preview ? <p className="accept__muted">The client writes to us here; it reaches the shared inbox as a thread on this company.</p> : <Contact />;
  return null;
}

/** A section's data; a new `version` loads it again, keeping what is shown meanwhile. */
function useData(path, load, version = 0) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { load(path).then((data) => setState({ data })).catch((e) => setState({ error: e.message })); }, [path, load, version]);
  return state;
}
const Loading = ({ s }) => (s.loading ? <p className="accept__muted">Loading…</p> : s.error ? <p className="accept__error">{s.error}</p> : null);
/** A file link, or its name in the staff preview, where files are not served. */
const FileLink = ({ ctx, href, children }) => (ctx.preview
  ? <span className="accept__muted" title="Opens in the client's portal">{children}</span>
  : <a href={href}>{children}</a>);

function Projects({ ctx }) {
  const s = useData('/projects', ctx.load);
  if (!s.data) return <Loading s={s} />;
  if (!s.data.length) return <p className="accept__muted">No projects yet.</p>;
  return s.data.map((p) => (
    <div key={p.project_id} className="portal__item">
      <div className="portal__row"><strong>{p.primary_service || p.project_id}</strong><span className="badge">{p.project_stage}</span></div>
      <div className="accept__muted">{p.project_id} · planned {day(p.planned_start_date)} to {day(p.planned_delivery_date)}{p.actual_delivery_date ? ` · delivered ${day(p.actual_delivery_date)}` : ''}</div>
      {p.checklist.length > 0 && <div className="accept__muted">Onboarding: {p.checklist.filter((c) => c.done).length} of {p.checklist.length} steps done</div>}
      {p.visits.map((v, i) => <div key={i}>Visit: {v.title} · {day(v.starts_at)}{v.city ? `, ${v.city}` : ''} ({v.status})</div>)}
      {(p.orders || []).map((o) => <Order key={o.po_number} o={o} ctx={ctx} />)}
    </div>
  ));
}

/** A purchase order: its value with the GST in it, what is billed and still to bill, and its schedule (#198 §3). */
function Order({ o, ctx }) {
  const c = o.currency;
  const invoicesOn = ctx.sections?.includes('invoices');
  const [asking, setAsking] = useState(false);
  return (
    <div className="portal__po">
      <div className="portal__row">
        <strong>PO {o.po_number}{o.po_date ? ` · ${day(o.po_date)}` : ''} · {exact(o.value, c)}</strong>
        {o.has_file && <FileLink ctx={ctx} href={`${BASE}/files/po/${encodeURIComponent(o.po_number)}`}>PO file</FileLink>}
      </div>
      {o.revised_from && <div className="accept__muted">Revised from PO {o.revised_from}</div>}
      {o.services.length > 0 && <div className="accept__muted">Services: {o.services.join(', ')}</div>}
      <div>{Number(o.gst) > 0
        ? <>Value {exact(o.value, c)} including GST {exact(o.gst, c)} (taxable {exact(o.taxable, c)})</>
        : <>Value {exact(o.value, c)}{c !== 'INR' ? ' (no GST)' : ''}</>}
      </div>
      <dl className="portal__figures">
        {[['Billed', o.billed], ['Received', o.received], ['Outstanding', o.outstanding], ['Still to bill', o.to_bill]].map(([label, v]) => (
          <div key={label}><dt>{label}</dt><dd>{exact(v, c)}</dd></div>
        ))}
      </dl>
      <div className="accept__muted">All amounts include GST.</div>
      {o.schedule.length > 0 && (
        <ol className="portal__schedule">
          {o.schedule.map((st) => (
            <li key={st.id}>
              <span>{st.stage_no}. {st.stage_name} · {Math.round(Number(st.stage_percent) * 100)}% · {exact(st.amount, c)}</span>
              <span className="accept__muted">{st.trigger_event === 'On Milestone' && st.milestone_name ? `On ${st.milestone_name}` : st.trigger_event}</span>
              <span>
                {st.invoice_no ? <>Invoice {st.invoice_no}{st.has_pdf && invoicesOn ? <> · <FileLink ctx={ctx} href={`${BASE}/files/invoice/${st.id}`}>PDF</FileLink></> : null} · </> : null}
                <span className="badge">{st.state}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {/* A query on the PO itself, say on the schedule; it is answered with the invoices' queries. */}
      {invoicesOn && !ctx.preview && (asking
        ? <Answer kind="query" about={{ po_number: o.po_number }} title={`A query about PO ${o.po_number}`} onClose={() => setAsking(false)} />
        : <div className="accept__actions"><button type="button" className="btn btn--sm" onClick={() => setAsking(true)}>Raise a query about this PO</button></div>)}
    </div>
  );
}

function Documents({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/documents', ctx.load, version);
  if (!s.data) return <Loading s={s} />;
  const d = s.data;
  const reload = () => setVersion((n) => n + 1);
  const file = (id) => <FileLink ctx={ctx} href={`${BASE}/files/document/${id}`}>Download</FileLink>;
  // Which of their records a file is on.
  const on = (x) => (x.entity === 'purchase_order' ? `PO ${x.entity_id}`
    : x.entity === 'project' ? `project ${x.entity_id}`
    : x.entity === 'payment_stage' ? `invoice ${d.invoices.find((i) => String(i.id) === x.entity_id)?.invoice_no ?? ''}`.trim()
    : 'your account');
  async function remove(u) {
    if (!window.confirm(`Delete "${u.label}"?`)) return;
    try { await send(`/documents/${u.id}`, { method: 'DELETE' }); reload(); } catch (ex) { window.alert(problem(ex)); }
  }
  return (
    <>
      <h2 className="portal__section">From us</h2>
      <div className="portal__scroll">
        <table className="table">
          <thead><tr><th>Document</th><th>Date</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>
            {d.quotations.map((q) => <tr key={q.quotation_no}><td>Quotation {q.quotation_no}{q.revision ? ` rev ${q.revision}` : ''}<div className="accept__muted">{q.service_quoted}</div></td><td>{day(q.quotation_date)}</td><td className="num">{money(q.amount, q.currency)}</td><td><FileLink ctx={ctx} href={`${BASE}/files/quotation/${encodeURIComponent(q.quotation_no)}`}>PDF</FileLink></td></tr>)}
            {d.purchase_orders.map((p) => <tr key={p.po_number}><td>Purchase order {p.po_number}</td><td>{day(p.po_date)}</td><td className="num">{money(p.amount, p.currency)}</td><td>{p.document_id ? file(p.document_id) : ''}</td></tr>)}
            {d.invoices.map((i) => <tr key={i.id}><td>Invoice {i.invoice_no}</td><td>{day(i.invoice_date)}</td><td className="num">{money(i.amount, i.currency)}</td><td>{file(i.document_id)}</td></tr>)}
            {d.deliverables.map((x) => <tr key={x.id}><td>{x.title}{x.reference ? ` (${x.reference})` : ''}</td><td>{day(x.issued_on)}</td><td /><td>{x.document_id ? file(x.document_id) : ''}</td></tr>)}
            {/* Files our team attached to their records and chose to share. */}
            {d.shared.map((x) => <tr key={`a${x.id}`}><td>{x.label || x.file_name}<div className="accept__muted">On {on(x)}</div></td><td>{when(x.created_at)}</td><td /><td>{file(x.document_id)}</td></tr>)}
          </tbody>
        </table>
      </div>

      <h2 className="portal__section">From you</h2>
      {!ctx.preview && <Upload targets={d.targets} onDone={reload} />}
      {d.uploads.length === 0 && <p className="accept__muted">Nothing uploaded yet.{ctx.preview ? '' : ' A signed PO, an amendment or evidence for an audit can go here, on the project or PO it belongs to.'}</p>}
      {d.uploads.map((u) => (
        <div key={u.id} className="portal__item">
          <div className="portal__head">
            <strong>{u.label}</strong>
            <span className="portal__row">
              {file(u.document_id)}
              {u.mine && !u.seen && !ctx.preview && <button type="button" className="btn btn--sm" onClick={() => remove(u)}>Delete</button>}
            </span>
          </div>
          <div className="accept__muted">{u.file_name} · on {on(u)} · {when(u.created_at)}{u.by_name ? ` · by ${u.by_name}` : ''}{u.seen ? ' · seen by our team' : ''}</div>
        </div>
      ))}
    </>
  );
}

/** The client's upload: a file, what it is, and the project or PO it belongs to. */
function Upload({ targets, onDone }) {
  const key = (t) => `${t.entity}:${t.entity_id}`;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(targets[0] ? key(targets[0]) : '');
  const [label, setLabel] = useState('');
  const [chosen, setChosen] = useState(null);
  const [state, setState] = useState({});
  if (!targets.length) return null;
  if (!open) {
    return (
      <div className="accept__actions portal__row">
        <button type="button" className="btn" onClick={() => { setOpen(true); setState({}); }}>Upload a file</button>
        {state.done && <span className="portal__ok" role="status">{state.done}</span>}
      </div>
    );
  }
  async function go(e) {
    e.preventDefault();
    const t = targets.find((x) => key(x) === target);
    const form = new FormData();
    form.set('entity', t.entity); form.set('entity_id', t.entity_id); form.set('label', label); form.set('file', chosen);
    setState({ busy: true });
    try { const r = await send('/documents', { form }); setOpen(false); setLabel(''); setChosen(null); setState({ done: r.message }); onDone(); }
    catch (ex) { setState({ error: problem(ex) }); }
  }
  return (
    <form className="portal__answer" onSubmit={go}>
      <div className="portal__grid">
        <label>For
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => <option key={key(t)} value={key(t)}>{t.entity === 'project' ? `Project: ${t.label}${t.label !== t.entity_id ? ` (${t.entity_id})` : ''}` : t.label}</option>)}
          </select>
        </label>
        <label>What it is<input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} placeholder="Signed PO, PO amendment, audit evidence" /></label>
      </div>
      <label>File<input type="file" required accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx" onChange={(e) => setChosen(e.target.files[0] || null)} /></label>
      <span className="accept__muted">PDF, image, Word or Excel. You can delete an upload until our team has seen it.</span>
      {state.error && <div className="accept__error">{state.error}</div>}
      <div className="accept__actions">
        <button type="submit" className="btn btn--primary" disabled={state.busy || !chosen}>{state.busy ? 'Uploading…' : 'Upload'}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

/** Totals per currency, as the statement adds them up. */
function totalsOf(rows) {
  const out = {};
  for (const i of rows) {
    const t = (out[i.currency || 'INR'] ||= { taxable: 0, gst: 0, amount: 0, paid: 0, tds: 0, outstanding: 0 });
    for (const k of Object.keys(t)) t[k] += Number(i[k] || 0);
  }
  return out;
}

/** An invoice's six figures, labelled, so they read the same on a phone as on a desk. */
function Figures({ t, c }) {
  return (
    <dl className="portal__figures portal__figures--six">
      {[['Taxable', t.taxable], ['GST', t.gst], ['Total', t.amount], ['Paid', t.paid], ['TDS', t.tds], ['Outstanding', t.outstanding]].map(([label, v]) => (
        <div key={label}><dt>{label}</dt><dd className={label === 'Total' ? 'portal__strong' : undefined}>{exact(v, c)}</dd></div>
      ))}
    </dl>
  );
}

// What the client said last about an invoice, and where it stands.
const SAID = { confirmed: 'You confirmed this invoice', query: 'You raised a query', payment_advice: 'You told us you paid' };
const STANDS = { open: 'with our team', matched: 'payment recorded', resolved: 'resolved', rejected: 'answered, see Your requests' };
const saidOf = (a) => (a.kind === 'confirmed' ? `${SAID.confirmed} on ${when(a.at)}.` : `${SAID[a.kind]} on ${when(a.at)}: ${STANDS[a.status]}.`);

function Invoices({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/invoices', ctx.load, version);
  const [po, setPo] = useState('');
  const [answer, setAnswer] = useState(null);   // { kind, id }; id null for a payment across several invoices
  if (!s.data) return <Loading s={s} />;
  const reload = () => setVersion((n) => n + 1);
  const rows = po ? s.data.filter((i) => i.po_number === po) : s.data;
  const pos = [...new Set(s.data.map((i) => i.po_number))];
  const totals = totalsOf(rows);
  const unpaid = s.data.filter((i) => Number(i.outstanding) > 0);
  const form = (kind, invoice) => (
    <Answer kind={kind} invoices={unpaid} invoice={invoice} about={invoice ? { stage_ids: [invoice.id] } : null}
      onClose={() => setAnswer(null)} onDone={reload} />
  );
  return (
    <>
      <div className="portal__head">
        <span>Outstanding, including GST: <strong>{Object.entries(totals).map(([c, t]) => exact(t.outstanding, c)).join(' · ') || exact(0)}</strong></span>
        <span className="portal__row">
          {pos.length > 1 && (
            <select className="input" value={po} onChange={(e) => setPo(e.target.value)} aria-label="Filter by PO">
              <option value="">All POs</option>
              {pos.map((n) => <option key={n} value={n}>PO {n}</option>)}
            </select>
          )}
          {!ctx.preview && unpaid.length > 1 && <button type="button" className="btn" onClick={() => setAnswer({ kind: 'payment_advice', id: null })}>Tell us you've paid</button>}
          {ctx.preview ? <span className="accept__muted">Statement PDF</span> : <a className="btn" href={`${BASE}/invoices/statement.pdf`}>Download statement</a>}
        </span>
      </div>
      {answer?.id === null && form('payment_advice', null)}
      {rows.map((i) => (
        <div key={i.id} className="portal__item">
          <div className="portal__head">
            <strong>Invoice {i.invoice_no}</strong>
            <span className="portal__row">
              {i.has_pdf && <FileLink ctx={ctx} href={`${BASE}/files/invoice/${i.id}`}>PDF</FileLink>}
              <span className="badge">{i.status}</span>
            </span>
          </div>
          <div className="accept__muted">
            PO {i.po_number} · {i.stage_name}{i.project_id ? ` · ${i.project_id}` : ''} · dated {day(i.invoice_date)}{i.invoice_due_date ? ` · due ${day(i.invoice_due_date)}` : ''}
          </div>
          <Figures t={i} c={i.currency} />
          {i.last_action && <div className="portal__said">{saidOf(i.last_action)}</div>}
          {!ctx.preview && (answer?.id === i.id ? form(answer.kind, i) : (
            <div className="accept__actions portal__answers">
              {i.status !== 'Paid' && i.last_action?.kind !== 'confirmed' && <button type="button" className="btn btn--sm" onClick={() => setAnswer({ kind: 'confirmed', id: i.id })}>Confirm</button>}
              <button type="button" className="btn btn--sm" onClick={() => setAnswer({ kind: 'query', id: i.id })}>Raise a query</button>
              {Number(i.outstanding) > 0 && i.status !== 'Payment reported' && <button type="button" className="btn btn--sm" onClick={() => setAnswer({ kind: 'payment_advice', id: i.id })}>Tell us you've paid</button>}
            </div>
          ))}
        </div>
      ))}
      {rows.length > 1 && Object.entries(totals).map(([c, t]) => (
        <div key={c} className="portal__item portal__item--total">
          <strong>Total{Object.keys(totals).length > 1 ? ` (${c})` : ''} · {rows.length} invoices</strong>
          <Figures t={t} c={c} />
        </div>
      ))}
      {!s.data.length && <p className="accept__muted">No invoices yet.</p>}
      {s.data.length > 0 && <p className="accept__muted">Total, paid and outstanding include GST. Received is what was paid plus TDS deducted, so an invoice can be settled with less paid than its total.</p>}
      {!ctx.preview && <Requests version={version} />}
    </>
  );
}

/**
 * The client's answer on an invoice or PO (#198 §4): a confirmation, a
 * query, or a payment they made. Each is a claim our team checks; nothing
 * the client sends changes the figures above until finance records it.
 */
function Answer({ kind, invoices = [], invoice, about, title, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [ids, setIds] = useState(invoice ? [invoice.id] : []);
  const [amount, setAmount] = useState(null);   // null: what is outstanding on the invoices chosen
  const [tds, setTds] = useState('');
  const [paidOn, setPaidOn] = useState(localToday());
  const [reference, setReference] = useState('');
  const [chosen, setChosen] = useState(null);
  const [state, setState] = useState({});
  const picked = invoices.filter((i) => ids.includes(i.id));
  const cur = picked[0]?.currency || invoice?.currency || 'INR';
  const due = Math.round(picked.reduce((sum, i) => sum + Number(i.outstanding || 0), 0) * 100) / 100;

  async function go(e) {
    e.preventDefault(); setState({ busy: true });
    try {
      let r;
      if (kind === 'payment_advice') {
        const form = new FormData();
        form.set('kind', kind); form.set('stage_ids', ids.join(',')); form.set('amount', String(amount ?? due));
        if (tds) form.set('tds_amount', tds);
        form.set('paid_on', paidOn);
        if (reference) form.set('reference', reference);
        if (chosen) form.set('file', chosen);
        r = await send('/actions', { form });
      } else {
        r = await call('/actions', { kind, ...about, note: kind === 'query' ? note : undefined });
      }
      setState({ done: r.message });
      onDone?.();
    } catch (ex) { setState({ error: problem(ex) }); }
  }

  if (state.done) {
    return (
      <div className="portal__answer" role="status">
        <span className="portal__ok">{state.done}</span>
        <div className="accept__actions"><button type="button" className="btn btn--sm" onClick={onClose}>Close</button></div>
      </div>
    );
  }
  const actions = (label) => (
    <>
      {state.error && <div className="accept__error">{state.error}</div>}
      <div className="accept__actions">
        <button type="submit" className="btn btn--primary btn--sm" disabled={state.busy || (kind === 'payment_advice' && !ids.length)}>{state.busy ? 'Sending…' : label}</button>
        <button type="button" className="btn btn--sm" onClick={onClose}>Cancel</button>
      </div>
    </>
  );

  if (kind === 'confirmed') {
    return (
      <form className="portal__answer" onSubmit={go}>
        <span>Confirm that invoice {invoice.invoice_no} for {exact(invoice.amount, cur)} is correct and agreed for payment?</span>
        {actions('Yes, confirm')}
      </form>
    );
  }
  if (kind === 'query') {
    return (
      <form className="portal__answer" onSubmit={go}>
        <label>{title || `A query about invoice ${invoice.invoice_no}`}
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} required maxLength={2000} autoFocus placeholder="What looks wrong, or what you need from us" />
        </label>
        <span className="accept__muted">Our team replies by email.</span>
        {actions('Send query')}
      </form>
    );
  }
  return (
    <form className="portal__answer" onSubmit={go}>
      <strong>Tell us you've paid</strong>
      {!invoice && (
        <fieldset className="portal__picks">
          <legend className="accept__muted">Which invoices this payment covers</legend>
          {invoices.map((i) => (
            <label key={i.id}>
              <input type="checkbox" checked={ids.includes(i.id)} onChange={(e) => setIds(e.target.checked ? [...ids, i.id] : ids.filter((x) => x !== i.id))} />
              Invoice {i.invoice_no} · PO {i.po_number} · outstanding {exact(i.outstanding, i.currency)}
            </label>
          ))}
        </fieldset>
      )}
      <div className="portal__grid">
        <label>Amount paid<input className="input" type="number" min="0.01" step="0.01" required value={amount ?? (due || '')} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>TDS deducted<input className="input" type="number" min="0" step="0.01" value={tds} onChange={(e) => setTds(e.target.value)} placeholder="0" /></label>
        <label>Paid on<input className="input" type="date" required value={paidOn} max={localToday()} onChange={(e) => setPaidOn(e.target.value)} /></label>
        <label>Reference<input className="input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="UTR or cheque number" /></label>
      </div>
      <label>Remittance advice (optional)<input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={(e) => setChosen(e.target.files[0] || null)} /></label>
      <span className="accept__muted">Outstanding on {picked.length === 1 ? 'this invoice' : 'these invoices'}: {exact(due, cur)}. Our finance team checks the payment, then updates the invoice.</span>
      {actions('Send')}
    </form>
  );
}

const ASKED = { confirmed: 'Confirmed', query: 'Query', payment_advice: 'Payment reported' };
const WHERE = {
  confirmed: { resolved: 'Confirmed' },
  query: { open: 'Open', resolved: 'Resolved', rejected: 'Answered' },
  payment_advice: { open: 'Being checked', matched: 'Payment recorded', rejected: 'Not matched' },
};

/** Everything the client has told us, newest first, with our reply. */
function Requests({ version }) {
  const s = useData('/actions', call, version);
  if (!s.data?.length) return null;
  return (
    <>
      <h2 className="portal__section">Your requests</h2>
      {s.data.map((a) => (
        <div key={a.id} className="portal__item">
          <div className="portal__head">
            <strong>{ASKED[a.kind]}{a.invoices.length ? ` · invoice ${a.invoices.map((i) => i.invoice_no).join(', ')}` : a.po_number ? ` · PO ${a.po_number}` : ''}</strong>
            <span className="badge">{WHERE[a.kind][a.status] || a.status}</span>
          </div>
          <div className="accept__muted">
            Sent {when(a.created_at)}
            {a.kind === 'payment_advice' ? ` · ${exact(a.amount)}${Number(a.tds_amount) > 0 ? ` + TDS ${exact(a.tds_amount)}` : ''} paid on ${day(a.paid_on)}${a.reference ? ` · ref ${a.reference}` : ''}` : ''}
          </div>
          {a.note && <div>{a.note}</div>}
          {a.resolution && <div><span className="accept__muted">Our reply:</span> {a.resolution}</div>}
        </div>
      ))}
    </>
  );
}

function Certificates({ ctx }) {
  const s = useData('/certificates', ctx.load);
  if (!s.data) return <Loading s={s} />;
  if (!s.data.length) return <p className="accept__muted">No certificates on record yet.</p>;
  return s.data.map((c) => (
    <div key={c.id} className="portal__item">
      <div className="portal__row"><strong>{c.title}</strong><span className="badge">{c.status === 'expired' ? 'expired' : c.days_left != null && c.days_left <= 90 ? `expires in ${c.days_left} days` : 'valid'}</span></div>
      <div className="accept__muted">{[c.reference, c.issuing_body, c.service_name].filter(Boolean).join(' · ')}</div>
      <div>Valid {day(c.valid_from || c.issued_on)} to {day(c.valid_until)}{c.renewal_due ? ` · renewal due ${day(c.renewal_due)}` : ''}</div>
      {c.scope && <div className="accept__muted">{c.scope}</div>}
      {c.document_id && <FileLink ctx={ctx} href={`${BASE}/files/document/${c.document_id}`}>Download</FileLink>}
    </div>
  ));
}

function Contact() {
  const s = useData('/messages', call);
  const [v, setV] = useState({ subject: '', body: '' });
  const [done, setDone] = useState(null);
  const [err, setErr] = useState(null);
  async function send(e) {
    e.preventDefault(); setErr(null);
    try { setDone((await call('/messages', v)).message); setV({ subject: '', body: '' }); } catch (ex) { setErr(ex.fields ? Object.values(ex.fields)[0] : ex.message); }
  }
  return (
    <>
      <form className="accept__form" onSubmit={send}>
        <label>Subject<input className="input" value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} required /></label>
        <label>Message<textarea className="input" rows={5} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} required /></label>
        {err && <div className="accept__error">{err}</div>}
        {done && <div className="accept__done accept__done--ok">{done}</div>}
        <div className="accept__actions"><button type="submit" className="btn btn--primary">Send</button></div>
      </form>
      {s.data?.length > 0 && <div className="portal__item"><strong>Earlier messages</strong>{s.data.map((m) => <div key={m.id} className="accept__muted">{new Date(m.sent_at).toLocaleString('en-IN')} · {m.direction === 'inbound' ? 'You' : 'Us'}: {m.snippet}</div>)}</div>}
    </>
  );
}
