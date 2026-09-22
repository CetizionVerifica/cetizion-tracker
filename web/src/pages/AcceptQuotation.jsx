import { useEffect, useState } from 'react';

/**
 * The page a client opens from an acceptance link (#53). No sign-in, no
 * app chrome, one quotation: review it, then accept or ask for changes.
 */
const BASE = '/api/public/accept';

async function call(path, body) {
  const r = await fetch(`${BASE}/${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(json.error?.message || 'Something went wrong. Please try again.'); e.fields = json.error?.fields; throw e; }
  return json.data;
}

const fmtMoney = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 2 }).format(Number(n)));
const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

export default function AcceptQuotation({ token }) {
  const [state, setState] = useState({ loading: true });
  const [mode, setMode] = useState(null);  // 'accept' | 'changes'
  const [form, setForm] = useState({ name: '', email: '', agree: false, comment: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    call(token).then((d) => setState({ data: d })).catch((e) => setState({ dead: e.message }));
  }, [token]);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      await call(`${token}/${mode === 'accept' ? 'accept' : 'changes'}`, form);
      setState({ data: await call(token) }); setMode(null);
    } catch (err) { setError(err.fields ? Object.values(err.fields)[0] : err.message); }
    finally { setBusy(false); }
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  if (state.loading) return <div className="accept"><div className="accept__card">Loading…</div></div>;
  if (state.dead) return <div className="accept"><div className="accept__card"><h1>Link not available</h1><p>{state.dead}</p></div></div>;
  const { quotation: q, seller, status } = state.data;

  return (
    <div className="accept">
      <div className="accept__card">
        <div className="accept__head">
          <div>
            <div className="accept__seller">{seller.name}</div>
            <h1>Quotation {q.quotation_no}{q.revision ? ` (rev ${q.revision})` : ''}</h1>
            <div className="accept__muted">For {q.client_name}{q.contact_name ? `, attention ${q.contact_name}` : ''} · dated {fmtDate(q.quotation_date)} · valid until {fmtDate(q.valid_until)}</div>
          </div>
          <a className="btn" href={`${BASE}/${token}/pdf`} target="_blank" rel="noopener noreferrer">View PDF</a>
        </div>

        {q.service_quoted && <p><strong>{q.service_quoted}</strong></p>}
        {q.lines.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">Disc.</th><th className="num">GST</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {q.lines.map((l, i) => (
                  <tr key={i}><td className="wrap">{l.description}</td><td className="num">{Number(l.qty)}{l.unit ? ` ${l.unit}` : ''}</td><td className="num">{fmtMoney(l.rate, q.currency)}</td><td className="num">{Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : '—'}</td><td className="num">{Number(l.gst_rate)}%</td><td className="num">{fmtMoney(l.amount, q.currency)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="accept__totals">
          {q.subtotal != null && <div><span>Subtotal</span><span>{fmtMoney(q.subtotal, q.currency)}</span></div>}
          {q.tax_total != null && <div><span>GST</span><span>{fmtMoney(q.tax_total, q.currency)}</span></div>}
          <div className="accept__total"><span>Total</span><span>{fmtMoney(q.total, q.currency)}</span></div>
        </div>
        {q.terms && <details className="accept__terms"><summary>Terms and conditions</summary><div style={{ whiteSpace: 'pre-wrap' }}>{q.terms}</div></details>}

        {status === 'accepted' && <div className="accept__done accept__done--ok">Accepted by {state.data.decided_by_name} on {new Date(state.data.decided_at).toLocaleString('en-IN')}. Thank you. We will be in touch about the purchase order.</div>}
        {status === 'changes_requested' && <div className="accept__done">Thank you. Your requested changes were sent to our team, who will share a revised quotation.</div>}

        {(status === 'sent' || status === 'viewed') && !mode && (
          <div className="accept__actions">
            <button type="button" className="btn btn--primary" onClick={() => setMode('accept')}>Accept quotation</button>
            <button type="button" className="btn" onClick={() => setMode('changes')}>Request changes</button>
          </div>
        )}

        {mode && (
          <form className="accept__form" onSubmit={submit}>
            <h2>{mode === 'accept' ? 'Accept this quotation' : 'Request changes'}</h2>
            <label>Your full name<input className="input" value={form.name} onChange={set('name')} required autoFocus /></label>
            <label>Your email<input className="input" type="email" value={form.email} onChange={set('email')} /></label>
            {mode === 'changes' && <label>What should change?<textarea className="input" rows={4} value={form.comment} onChange={set('comment')} required /></label>}
            {mode === 'accept' && <>
              <label>Comments (optional)<textarea className="input" rows={2} value={form.comment} onChange={set('comment')} /></label>
              <label className="accept__tick"><input type="checkbox" checked={form.agree} onChange={set('agree')} /> I accept quotation {q.quotation_no}{q.revision ? ` revision ${q.revision}` : ''} for {fmtMoney(q.total, q.currency)} on the terms above, on behalf of {q.client_name}.</label>
            </>}
            {error && <div className="accept__error">{error}</div>}
            <div className="accept__actions">
              <button type="submit" className="btn btn--primary" disabled={busy || (mode === 'accept' && !form.agree)}>{busy ? 'Sending…' : mode === 'accept' ? 'Accept' : 'Send request'}</button>
              <button type="button" className="btn" onClick={() => { setMode(null); setError(null); }} disabled={busy}>Back</button>
            </div>
          </form>
        )}
        <p className="accept__muted accept__foot">This page shows one quotation only. Your name, the time and your network address are recorded with your answer.</p>
      </div>
    </div>
  );
}
