import { useEffect, useState } from 'react';

/**
 * The client portal (#47): a few plain pages for a client contact, outside
 * the staff app. Sign-in is by a one-time link sent to their email.
 *
 * Since #198 it shows the same figures we hold: each PO with its schedule
 * and what is still to bill, and every invoice with taxable value, GST and
 * the total including GST. The sections are exported for the staff
 * "preview as client", which draws them from the preview API instead.
 */
const BASE = '/api/portal';
async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(json.error?.message || 'Something went wrong'); e.status = r.status; e.fields = json.error?.fields; throw e; }
  return json.data;
}
const money = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(n)));
// To the paisa, so the client can tick our figure against their own books.
const exact = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n)));
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
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
        <div className="accept__seller">Cetizion Verifica</div>
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
          <div><div className="accept__seller">Cetizion Verifica · client portal</div><h1>{me.company_name}</h1><div className="accept__muted">Signed in as {me.contact_name}</div></div>
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

function useData(path, load) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { load(path).then((data) => setState({ data })).catch((e) => setState({ error: e.message })); }, [path, load]);
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
    </div>
  );
}

function Documents({ ctx }) {
  const s = useData('/documents', ctx.load);
  if (!s.data) return <Loading s={s} />;
  const d = s.data;
  const file = (id) => <FileLink ctx={ctx} href={`${BASE}/files/document/${id}`}>Download</FileLink>;
  return (
    <div className="portal__scroll">
      <table className="table">
        <thead><tr><th>Document</th><th>Date</th><th className="num">Amount</th><th /></tr></thead>
        <tbody>
          {d.quotations.map((q) => <tr key={q.quotation_no}><td>Quotation {q.quotation_no}{q.revision ? ` rev ${q.revision}` : ''}<div className="accept__muted">{q.service_quoted}</div></td><td>{day(q.quotation_date)}</td><td className="num">{money(q.amount, q.currency)}</td><td><FileLink ctx={ctx} href={`${BASE}/files/quotation/${encodeURIComponent(q.quotation_no)}`}>PDF</FileLink></td></tr>)}
          {d.purchase_orders.map((p) => <tr key={p.po_number}><td>Purchase order {p.po_number}</td><td>{day(p.po_date)}</td><td className="num">{money(p.amount, p.currency)}</td><td>{p.document_id ? file(p.document_id) : ''}</td></tr>)}
          {d.invoices.map((i) => <tr key={i.id}><td>Invoice {i.invoice_no}</td><td>{day(i.invoice_date)}</td><td className="num">{money(i.amount, i.currency)}</td><td>{file(i.document_id)}</td></tr>)}
          {d.deliverables.map((x) => <tr key={x.id}><td>{x.title}{x.reference ? ` (${x.reference})` : ''}</td><td>{day(x.issued_on)}</td><td /><td>{x.document_id ? file(x.document_id) : ''}</td></tr>)}
        </tbody>
      </table>
    </div>
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

function Invoices({ ctx }) {
  const s = useData('/invoices', ctx.load);
  const [po, setPo] = useState('');
  if (!s.data) return <Loading s={s} />;
  const rows = po ? s.data.filter((i) => i.po_number === po) : s.data;
  const pos = [...new Set(s.data.map((i) => i.po_number))];
  const totals = totalsOf(rows);
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
          {ctx.preview ? <span className="accept__muted">Statement PDF</span> : <a className="btn" href={`${BASE}/invoices/statement.pdf`}>Download statement</a>}
        </span>
      </div>
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
      {s.data?.length > 0 && <div className="portal__item"><strong>Earlier messages</strong>{s.data.map((m) => <div key={m.id} className="accept__muted">{new Date(m.sent_at).toLocaleString('en-IN')} · {m.direction === 'inbound' ? 'You' : 'Cetizion'}: {m.snippet}</div>)}</div>}
    </>
  );
}
