import { useEffect, useState } from 'react';

/**
 * The client portal (#47): a few plain pages for a client contact, outside
 * the staff app. Sign-in is by a one-time link sent to their email.
 */
const BASE = '/api/portal';
async function call(path, body) {
  const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(json.error?.message || 'Something went wrong'); e.status = r.status; e.fields = json.error?.fields; throw e; }
  return json.data;
}
const money = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(n)));
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const LABEL = { projects: 'Projects', documents: 'Documents', invoices: 'Invoices', certificates: 'Certificates', contact: 'Contact us' };

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
        <div className="portal__tabs">{me.sections.map((s) => <button type="button" key={s} className={`portal__tab ${tab === s ? 'is-on' : ''}`} onClick={() => setTab(s)}>{LABEL[s]}</button>)}</div>
        {tab === 'projects' && <Projects />}
        {tab === 'documents' && <Documents />}
        {tab === 'invoices' && <Invoices />}
        {tab === 'certificates' && <Certificates />}
        {tab === 'contact' && <Contact />}
      </div>
    </div>
  );
}

function useData(path) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => { call(path).then((data) => setState({ data })).catch((e) => setState({ error: e.message })); }, [path]);
  return state;
}
const Loading = ({ s }) => (s.loading ? <p className="accept__muted">Loading…</p> : s.error ? <p className="accept__error">{s.error}</p> : null);

function Projects() {
  const s = useData('/projects');
  if (!s.data) return <Loading s={s} />;
  if (!s.data.length) return <p className="accept__muted">No projects yet.</p>;
  return s.data.map((p) => (
    <div key={p.project_id} className="portal__item">
      <div className="portal__row"><strong>{p.primary_service || p.project_id}</strong><span className="badge">{p.project_stage}</span></div>
      <div className="accept__muted">{p.project_id} · planned {day(p.planned_start_date)} to {day(p.planned_delivery_date)}{p.actual_delivery_date ? ` · delivered ${day(p.actual_delivery_date)}` : ''}</div>
      {p.checklist.length > 0 && <div className="accept__muted">Onboarding: {p.checklist.filter((c) => c.done).length} of {p.checklist.length} steps done</div>}
      {p.visits.map((v, i) => <div key={i}>Visit: {v.title} · {day(v.starts_at)}{v.city ? `, ${v.city}` : ''} ({v.status})</div>)}
    </div>
  ));
}

function Documents() {
  const s = useData('/documents');
  if (!s.data) return <Loading s={s} />;
  const d = s.data;
  const file = (id) => <a href={`${BASE}/files/document/${id}`}>Download</a>;
  return (
    <table className="table">
      <thead><tr><th>Document</th><th>Date</th><th className="num">Amount</th><th /></tr></thead>
      <tbody>
        {d.quotations.map((q) => <tr key={q.quotation_no}><td>Quotation {q.quotation_no}{q.revision ? ` rev ${q.revision}` : ''}<div className="accept__muted">{q.service_quoted}</div></td><td>{day(q.quotation_date)}</td><td className="num">{money(q.amount, q.currency)}</td><td><a href={`${BASE}/files/quotation/${encodeURIComponent(q.quotation_no)}`}>PDF</a></td></tr>)}
        {d.purchase_orders.map((p) => <tr key={p.po_number}><td>Purchase order {p.po_number}</td><td>{day(p.po_date)}</td><td className="num">{money(p.amount, p.currency)}</td><td>{p.document_id ? file(p.document_id) : ''}</td></tr>)}
        {d.invoices.map((i) => <tr key={i.id}><td>Invoice {i.invoice_no}</td><td>{day(i.invoice_date)}</td><td className="num">{money(i.amount, i.currency)}</td><td>{file(i.document_id)}</td></tr>)}
        {d.deliverables.map((x) => <tr key={x.id}><td>{x.title}{x.reference ? ` (${x.reference})` : ''}</td><td>{day(x.issued_on)}</td><td /><td>{x.document_id ? file(x.document_id) : ''}</td></tr>)}
      </tbody>
    </table>
  );
}

function Invoices() {
  const s = useData('/invoices');
  if (!s.data) return <Loading s={s} />;
  const open = s.data.reduce((t, i) => t + Number(i.outstanding), 0);
  return (
    <>
      <div className="portal__row"><span>Outstanding: <strong>{money(open)}</strong></span><a className="btn" href={`${BASE}/invoices/statement.pdf`}>Download statement</a></div>
      <table className="table">
        <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th className="num">Amount</th><th className="num">Paid</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
        <tbody>{s.data.map((i) => <tr key={i.id}><td>{i.invoice_no}<div className="accept__muted">{i.po_number} · {i.stage_name}</div></td><td>{day(i.invoice_date)}</td><td>{day(i.invoice_due_date)}</td><td className="num">{money(i.amount, i.currency)}</td><td className="num">{money(i.received, i.currency)}</td><td className="num">{money(i.outstanding, i.currency)}</td><td>{i.status}</td></tr>)}</tbody>
      </table>
      {!s.data.length && <p className="accept__muted">No invoices yet.</p>}
    </>
  );
}

function Certificates() {
  const s = useData('/certificates');
  if (!s.data) return <Loading s={s} />;
  if (!s.data.length) return <p className="accept__muted">No certificates on record yet.</p>;
  return s.data.map((c) => (
    <div key={c.id} className="portal__item">
      <div className="portal__row"><strong>{c.title}</strong><span className="badge">{c.status === 'expired' ? 'expired' : c.days_left != null && c.days_left <= 90 ? `expires in ${c.days_left} days` : 'valid'}</span></div>
      <div className="accept__muted">{[c.reference, c.issuing_body, c.service_name].filter(Boolean).join(' · ')}</div>
      <div>Valid {day(c.valid_from || c.issued_on)} to {day(c.valid_until)}{c.renewal_due ? ` · renewal due ${day(c.renewal_due)}` : ''}</div>
      {c.scope && <div className="accept__muted">{c.scope}</div>}
      {c.document_id && <a href={`${BASE}/files/document/${c.document_id}`}>Download</a>}
    </div>
  ));
}

function Contact() {
  const s = useData('/messages');
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
