import { useEffect, useState } from 'react';
import { Check, CircleAlert, CircleCheckBig, Clock, Download, Link2, Lock, MessageSquare } from 'lucide-react';
import { ClientHeader, ClientPage, useEnter } from '../components/client.jsx';
import { sentence } from '../lib/format.js';

/**
 * The page a client opens from an acceptance link (#53, C18).
 *
 * No sign-in, no app chrome, one quotation. It has to read on a phone,
 * opened from a corporate inbox, by somebody who has never seen this system
 * and never will again. So it shows the figure, the terms and one decision,
 * and it never mentions anything but this quotation, because the person
 * reading it has no account here and no business seeing anyone else's.
 *
 * Wave 9 (Mocha Glass): the quotation on the left, the total and the
 * decision beside it (under it on a tablet or phone), Download PDF kept
 * after an answer, and on a phone a "Review and accept" bar with the total.
 */
const BASE = '/api/public/accept';

async function call(path, body) {
  const r = await fetch(`${BASE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(json.error?.message || 'Something went wrong. Please try again.');
    e.fields = json.error?.fields;
    e.status = r.status;
    throw e;
  }
  return json.data;
}

const fmtMoney = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', currencyDisplay: (cur || 'INR') === 'INR' ? 'symbol' : 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n)));
const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export default function AcceptQuotation({ token }) {
  const [state, setState] = useState({ loading: true });
  const [mode, setMode] = useState(null);  // 'accept' | 'changes'
  const [form, setForm] = useState({ name: '', email: '', agree: false, comment: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);  // { banner } or { field, text }
  const [attempt, setAttempt] = useState(0);
  const ref = useEnter(state.loading ? null : state.data ? 'quote' : 'dead');

  useEffect(() => {
    call(token).then((d) => setState({ data: d })).catch((e) => setState({ dead: e.message, status: e.status }));
  }, [token, attempt]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call(`${token}/${mode === 'accept' ? 'accept' : 'changes'}`, form);
      setState({ data: await call(token) });
      setMode(null);
    } catch (err) {
      if (err.status === 409) setError({ banner: 'This quotation has already been answered', text: `${sentence(err.message)} Reload the page to see the answer.` });
      else if (err.fields?.comment) setError({ field: 'comment', text: mode === 'changes' ? 'Please tell us what should change.' : err.fields.comment });
      else if (err.fields?.name) setError({ field: 'name', text: err.fields.name });
      else if (err.fields?.email) setError({ field: 'email', text: err.fields.email });
      else setError({ banner: mode === 'accept' ? "Your answer wasn't sent" : "Your request wasn't sent", text: err.fields ? Object.values(err.fields)[0] : err.message });
    } finally {
      setBusy(false);
    }
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const go = (m) => { setMode(m); setError(null); if (m) requestAnimationFrame(() => document.getElementById('decide')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); };

  if (state.loading) {
    return (
      <ClientPage plain>
        <ClientHeader sub="Quotation" />
        <div className="cl-cols" aria-busy="true" aria-label="Loading the quotation">
          <section className="mg-glass mg-glass--strong mg-panel">
            <div className="mg-skel" style={{ height: 12, width: '22%' }} /><div className="mg-skel" style={{ height: 36, width: '60%' }} /><div className="mg-skel" style={{ height: 40 }} />
            <div className="mg-skel" style={{ height: 52 }} /><div className="mg-skel" style={{ height: 52 }} /><div className="mg-skel" style={{ height: 52, width: '80%' }} />
            <span className="cl-meta">Opening your quotation…</span>
          </section>
          <div className="cl-side"><section className="mg-glass mg-panel"><div className="mg-skel" style={{ height: 12, width: '40%' }} /><div className="mg-skel" style={{ height: 54 }} /><div className="mg-skel" style={{ height: 48 }} /></section></div>
        </div>
      </ClientPage>
    );
  }

  if (state.dead) {
    const rate = state.status === 429;
    return (
      <ClientPage plain rootRef={ref}>
        <ClientHeader sub="Quotation" />
        <div className="cl-dead">
          <main className="mg-glass mg-glass--strong mg-empty" data-a="rise">
            <span className="mg-empty__mark cl-ico--wait">{rate ? <Clock size={24} strokeWidth={1.8} aria-hidden="true" /> : <Link2 size={24} strokeWidth={1.8} aria-hidden="true" />}</span>
            <h1 className="mg-display">{rate ? 'Too many requests' : 'This link is not available'}</h1>
            <p className="mg-empty__text" style={{ fontSize: 14 }}>{rate ? 'Please wait a few minutes, then open the link again.' : state.dead}</p>
            <p className="mg-empty__text">{rate ? 'Your quotation is safe. Nothing was answered.' : 'If you were expecting a quotation, reply to the email that brought you here and we will send a fresh link.'}</p>
            {rate && <button type="button" className="mg-btn" style={{ marginTop: 6 }} onClick={() => { setState({ loading: true }); setAttempt((n) => n + 1); }}>Try again</button>}
          </main>
        </div>
      </ClientPage>
    );
  }

  const { quotation: q, seller, status } = state.data;
  const open = status === 'sent' || status === 'viewed';
  const accepted = status === 'accepted';
  const changed = status === 'changes_requested';
  const reference = `${q.quotation_no}${q.revision ? ` revision ${q.revision}` : ''}`;
  const pdf = `${BASE}/${token}/pdf`;
  const total = Number(q.total) || 0;
  const whole = Math.floor(total), cents = String(Math.round((total - whole) * 100)).padStart(2, '0');
  const [statusText, statusTone] = accepted ? ['Accepted', 'mg-badge--ok'] : changed ? ['Changes requested', 'mg-badge--info'] : open ? ['Waiting for your answer', 'mg-badge--wait'] : [String(status).replace(/_/g, ' '), ''];
  const PdfButton = () => (
    <a className="mg-btn" href={pdf} target="_blank" rel="noopener noreferrer"><Download strokeWidth={1.8} aria-hidden="true" />Download PDF</a>
  );
  const fieldErr = (k) => error?.field === k && <span className="mg-field__error">{error.text}</span>;

  return (
    <ClientPage plain={!open || !!mode} rootRef={ref}
      after={open && !mode && (
        <div className="mg-glass cl-dock">
          <div className="cl-dock__fig"><span className="mg-label">Total with GST</span><strong className="mg-num">{fmtMoney(q.total, q.currency)}</strong></div>
          <a href="#decide" className="mg-btn mg-btn--primary mg-btn--lg" onClick={(e) => { e.preventDefault(); document.getElementById('decide')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}>Review and accept</a>
        </div>
      )}>
      <ClientHeader sub={`Quotation ${q.quotation_no}`} badge={`For ${q.client_name}`} />
      <div className="cl-cols">
        <main className="mg-glass mg-glass--strong mg-panel cl-quote" data-a="rise">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="mg-eyebrow">Quotation from {seller.name}</span>
            <h1 className="mg-display">Quotation for <span className="cl-em">{q.client_name}</span></h1>
            <p className="cl-text2">{reference} · {fmtDate(q.quotation_date)} · valid until {fmtDate(q.valid_until)}</p>
          </div>
          <dl className="mg-facts">
            {q.contact_name && <div><dt>Prepared for</dt><dd>{q.contact_name}</dd></div>}
            {q.sales_person && <div><dt>Prepared by</dt><dd>{q.sales_person}</dd></div>}
            <div><dt>Valid until</dt><dd>{fmtDate(q.valid_until)}</dd></div>
            <div><dt>Status</dt><dd><span className={`mg-badge ${statusTone}`}>{statusText}</span></dd></div>
          </dl>
          {accepted && (
            <div className="mg-banner mg-banner--ok" role="status">
              <CircleCheckBig strokeWidth={1.8} aria-hidden="true" />
              <div className="mg-banner__body"><strong>Accepted by {state.data.decided_by_name} on {new Date(state.data.decided_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</strong>Thank you. We will be in touch about the purchase order.</div>
            </div>
          )}
          {changed && (
            <div className="mg-banner" role="status">
              <MessageSquare strokeWidth={1.8} aria-hidden="true" />
              <div className="mg-banner__body"><strong>Your request went to our team</strong>Thank you. Your requested changes went to our team, who will send a revised quotation.</div>
            </div>
          )}
          {q.service_quoted && (
            <div>
              <h2 className="mg-label" style={{ margin: '0 0 6px' }}>Service quoted</h2>
              <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{q.service_quoted}</p>
            </div>
          )}
          {q.lines.length > 0 && (
            <>
              <div className="mg-tablewrap cl-quote__lines cl-wide">
                <table className="mg-table cl-tbl">
                  <thead><tr><th scope="col">Item</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Rate</th><th scope="col" className="num">GST</th><th scope="col" className="num">Amount</th></tr></thead>
                  <tbody>
                    {q.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="strong wrap">{l.description}{Number(l.discount_percent) > 0 && <span className="sub" style={{ color: 'var(--caramel-text)', fontWeight: 700 }}>{Number(l.discount_percent)}% off</span>}</td>
                        <td className="num">{Number(l.qty)}{l.unit && <span className="sub">{l.unit}</span>}</td>
                        <td className="num">{fmtMoney(l.rate, q.currency)}</td>
                        <td className="num">{Number(l.gst_rate)}%</td>
                        <td className="num" style={{ fontWeight: 700 }}>{fmtMoney(l.amount, q.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="cl-narrow cl-quote__rows"><div className="mg-rows">
                {q.lines.map((l, i) => (
                  <div key={i} className="mg-row">
                    <span className="mg-row__title">{l.description}</span>
                    <span className="mg-row__amount mg-num">{fmtMoney(l.amount, q.currency)}</span>
                    <span className="mg-row__meta">{Number(l.qty)}{l.unit ? ` ${l.unit}` : ''} × {fmtMoney(l.rate, q.currency)} · GST {Number(l.gst_rate)}%</span>
                    <span className="mg-row__state">{Number(l.discount_percent) > 0 && <span className="mg-badge mg-badge--wait mg-badge--plain">{Number(l.discount_percent)}% off</span>}</span>
                  </div>
                ))}
              </div></div>
            </>
          )}
          <dl className="cl-tot mg-num">
            {q.subtotal != null && <><dt>Subtotal</dt><dd>{fmtMoney(q.subtotal, q.currency)}</dd></>}
            {q.tax_total != null && <><dt>GST</dt><dd>{fmtMoney(q.tax_total, q.currency)}</dd></>}
            <dt className="is-total">Total</dt><dd className="is-total">{fmtMoney(q.total, q.currency)}</dd>
          </dl>
          {q.terms && (
            <div className="cl-terms">
              <h2 className="mg-panel__title">Terms</h2>
              {/* Open, not folded into a disclosure. These are the terms
                  somebody is about to agree to; hiding them behind a triangle
                  makes the agreement weaker and the page no shorter. */}
              <p>{q.terms}</p>
            </div>
          )}
          <p className="cl-lockline" style={{ paddingTop: 14, borderTop: '1px solid var(--line)' }}><Lock strokeWidth={1.8} aria-hidden="true" />This link is personal to you and expires with the quotation. Your name, the time and your network address are recorded with your answer.</p>
        </main>

        <aside className="cl-side" aria-label="Your decision">
          <section className="mg-hero" data-a="rise" aria-label="Total"
            onMouseMove={(e) => { const el = e.currentTarget, b = el.getBoundingClientRect(); el.style.setProperty('--mx', `${e.clientX - b.left}px`); el.style.setProperty('--my', `${e.clientY - b.top}px`); }}>
            <span className="mg-hero__label">Total, including GST</span>
            <div className="mg-hero__figure mg-num" style={{ fontSize: 50 }}>
              {(q.currency || 'INR') === 'INR' ? <span data-count={whole} data-format="inr">{`₹${whole.toLocaleString('en-IN')}`}</span> : <span>{fmtMoney(whole, q.currency).replace(/\.00$/, '')}</span>}
              <span className="cl-hero__cents">.{cents}</span>
            </div>
            <span className="mg-hero__sub">{q.subtotal != null && q.tax_total != null ? `${fmtMoney(q.subtotal, q.currency)} plus GST ${fmtMoney(q.tax_total, q.currency)} · ` : ''}valid until {fmtDate(q.valid_until)}</span>
          </section>
          <section className="mg-glass mg-glass--strong mg-panel cl-decide" id="decide" data-a="rise" aria-labelledby="decide-h">
            {open && !mode && (
              <>
                <h2 className="mg-panel__title" id="decide-h" style={{ fontSize: 17 }}>Accept this quotation</h2>
                <p className="cl-text2">Your name is recorded with the date. {seller.name} will ask for a purchase order next.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button type="button" className="mg-btn mg-btn--primary mg-btn--lg" onClick={() => go('accept')}><Check strokeWidth={2} aria-hidden="true" />Accept quotation</button>
                  <PdfButton />
                  <button type="button" className="mg-btn mg-btn--ghost" onClick={() => go('changes')}><MessageSquare strokeWidth={1.8} aria-hidden="true" />Ask a question or request a change</button>
                </div>
              </>
            )}
            {mode && (
              <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <h2 className="mg-panel__title" id="decide-h" style={{ fontSize: 17 }}>{mode === 'accept' ? 'Accept this quotation' : 'Ask a question or request a change'}</h2>
                {error?.banner && (
                  <div className="mg-banner mg-banner--late" role="alert">
                    <CircleAlert strokeWidth={1.8} aria-hidden="true" />
                    <div className="mg-banner__body"><strong>{error.banner}</strong>{error.text}</div>
                  </div>
                )}
                <label className={`mg-field${error?.field === 'name' ? ' is-error' : ''}`}>
                  <span className="mg-field__label">Your name<span className="req" aria-hidden="true">*</span></span>
                  <input className="mg-input" id="accept-name" value={form.name} onChange={set('name')} required autoFocus autoComplete="name" readOnly={busy} />
                  {fieldErr('name')}
                </label>
                <label className={`mg-field${error?.field === 'email' ? ' is-error' : ''}`}>
                  <span className="mg-field__label">Your email{mode === 'accept' ? ' (optional)' : ''}</span>
                  <input className="mg-input" id="accept-email" type="email" value={form.email} onChange={set('email')} autoComplete="email" readOnly={busy} />
                  {fieldErr('email') || (mode === 'accept' && <span className="mg-field__hint">So our team can reply to the right person.</span>)}
                </label>
                <label className={`mg-field${error?.field === 'comment' ? ' is-error' : ''}`}>
                  <span className="mg-field__label">{mode === 'accept' ? 'Anything to add (optional)' : 'What should change?'}{mode === 'changes' && <span className="req" aria-hidden="true">*</span>}</span>
                  <textarea className="mg-textarea" id="accept-comment" rows={mode === 'accept' ? 2 : 4} value={form.comment} onChange={set('comment')} required={mode === 'changes'} readOnly={busy}
                    placeholder={mode === 'accept' ? 'A PO number, a preferred start date' : 'A line to add or remove, a date, a question about the terms'} />
                  {fieldErr('comment')}
                </label>
                {mode === 'accept' && (
                  <label className={`cl-tick${form.agree ? ' is-on' : ''}`}>
                    <span className="mg-check"><input type="checkbox" id="accept-agree" checked={form.agree} disabled={busy} onChange={(e) => setForm((f) => ({ ...f, agree: e.target.checked }))} /></span>
                    <span>I am authorised to accept <strong>{reference}</strong> for <strong className="mg-num">{fmtMoney(q.total, q.currency)}</strong>, on the terms above, on behalf of <strong>{q.client_name}</strong>.</span>
                  </label>
                )}
                <div className="cl-decide__row">
                  <button type="submit" className={`mg-btn mg-btn--primary${busy ? ' is-loading' : ''}`} aria-busy={busy} disabled={busy || (mode === 'accept' && !form.agree)}>
                    {busy ? 'Sending…' : mode === 'accept' ? 'Accept quotation' : 'Send it'}
                  </button>
                  <button type="button" className="mg-btn mg-btn--ghost" onClick={() => go(null)} disabled={busy}>Back</button>
                </div>
                {mode === 'accept' && !form.agree && <span className="cl-meta">Tick the box to accept.</span>}
              </form>
            )}
            {!open && (
              <>
                <h2 className="mg-panel__title" id="decide-h" style={{ fontSize: 17 }}>{accepted ? 'Accepted. Thank you.' : changed ? 'Request sent. Thank you.' : 'This quotation is closed'}</h2>
                <p className="cl-text2">{accepted ? 'Keep a copy of the quotation you accepted. Our team will ask for a purchase order next.' : changed ? 'Our team will send a revised quotation. Keep this copy until then.' : 'It can no longer be answered through this link.'}</p>
                <PdfButton />
              </>
            )}
          </section>
        </aside>
      </div>
    </ClientPage>
  );
}
