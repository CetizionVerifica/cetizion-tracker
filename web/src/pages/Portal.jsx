import { useEffect, useRef, useState } from 'react';
import {
  Award, Banknote, Briefcase, Check, CircleAlert, CircleCheckBig, CircleHelp, Clock, Download, File, FileSpreadsheet,
  FileText, Folder, Link2, Lock, Mail, MessageSquare, Paperclip, Receipt, Send, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import { Modal } from '../components/ui.jsx';
import { ClientHeader, ClientPage, Opening, PROVIDER, initials, useEnter } from '../components/client.jsx';

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
 *
 * Wave 9 (Mocha Glass): the client header, a summary on Projects & orders
 * and Invoices drawn from the figures below it, the answer forms as dialogs
 * (bottom sheets on a phone), and the sections as a bottom bar on a phone.
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
const localToday = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
// To the paisa, so the client can tick our figure against their own books. Rupees as ₹, other currencies by code.
const exact = (n, cur = 'INR') => (n == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', currencyDisplay: (cur || 'INR') === 'INR' ? 'symbol' : 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n)));
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
// A timestamp (when something was sent or uploaded), on the reader's own day.
const when = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const whenTime = (t) => (t ? new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const SIGN = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const curWord = (c) => (c === 'INR' ? 'rupees' : c === 'USD' ? 'US dollars' : c);
/** "Something went wrong" from a server that fell over says less than our own words; a refusal says more. */
const serverDown = (e) => !e.status || e.status >= 500;

export const PORTAL_LABEL = { projects: 'Projects & orders', documents: 'Documents', invoices: 'Invoices', certificates: 'Certificates', contact: 'Contact us' };
/** The tabs' order is fixed, so it never depends on when a section was switched on. */
export const PORTAL_ORDER = ['projects', 'documents', 'invoices', 'certificates', 'contact'];
const SHORT = { projects: 'Orders', documents: 'Documents', invoices: 'Invoices', certificates: 'Certificates', contact: 'Contact' };
const TAB_ICON = { projects: Briefcase, documents: FileText, invoices: Receipt, certificates: Award, contact: MessageSquare };
const WHAT = { projects: 'your projects and orders', documents: 'your documents', invoices: 'your invoices', certificates: 'your certificates', contact: 'your messages' };

/* ------------------------------------------------------------ sign-in */

/** What went wrong with a sign-in link, from the server's words. The server says "expired or was already used" as one. */
function linkProblem(e) {
  if (e.status === 429) return { kind: 'ratelimit' };
  if (/not valid/i.test(e.message)) return { kind: 'invalid' };
  if (/expired|already used/i.test(e.message)) return { kind: 'expired' };
  if (/not available/i.test(e.message)) return { kind: 'withdrawn' };
  return { kind: 'other', text: e.message };
}
const NOTICE = {
  invalid: ['mg-banner--late', 'alert', Link2, 'This link is not valid', 'It may be cut short in the email. Ask for a new one below.'],
  expired: ['mg-banner--wait', 'alert', Clock, 'This sign-in link has expired or was already used', 'Each link works once, for 20 minutes. Enter your email and we will send a fresh one.'],
  withdrawn: ['mg-banner--late', 'alert', CircleAlert, 'Portal access is not available for this address any more', `If you think this is a mistake, reply to the last email from your contact at ${PROVIDER}.`],
  ended: ['', 'status', Clock, 'You were signed out', 'Sessions last 8 hours, and end when your portal access changes. Ask for a new link to carry on.'],
  ratelimit: ['mg-banner--late', 'alert', Clock, 'Too many requests', 'Please wait a few minutes, then ask for a link again.'],
  other: ['mg-banner--late', 'alert', CircleAlert, 'That did not work', ''],
};

function Banner({ tone = '', role = 'status', icon: Icon = CircleAlert, title, children, action }) {
  return (
    <div className={`mg-banner ${tone}`} role={role}>
      <Icon strokeWidth={1.8} aria-hidden="true" />
      <div className="mg-banner__body">{title && <strong>{title}</strong>}{children}</div>
      {action}
    </div>
  );
}

export default function Portal({ loginToken }) {
  const [me, setMe] = useState(undefined);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        if (loginToken) { await call('/login', { token: loginToken }); window.history.replaceState(null, '', '/portal'); }
        setMe(await call('/me'));
      } catch (e) { setMe(null); if (loginToken) setNotice(linkProblem(e)); }
    })();
  }, [loginToken]);

  if (me === undefined) {
    return (
      <ClientPage plain>
        <ClientHeader sub="Client portal" />
        {loginToken ? <Opening title="Signing you in…" text="Checking your link. This takes a moment." /> : <Opening text="Opening your portal…" />}
      </ClientPage>
    );
  }
  if (!me) return <SignIn notice={notice} />;
  return (
    <Home
      me={me}
      onOut={async () => { await call('/logout', {}).catch(() => {}); setNotice(null); setMe(null); }}
      onEnded={() => { setNotice({ kind: 'ended' }); setMe(null); }}
    />
  );
}

function SignIn({ notice: first }) {
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(first);
  const [badEmail, setBadEmail] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const ref = useEnter('sign-in');
  async function go(e) {
    e.preventDefault(); setBusy(true); setBadEmail(false); setNotice(null);
    try { await call('/request-link', { email }); setSentTo(email.trim()); }
    catch (ex) {
      if (ex.fields?.email) setBadEmail(true);
      else if (ex.status === 429) { setNotice({ kind: 'ratelimit' }); setBlocked(true); }
      else setNotice({ kind: 'other', text: ex.message });
    } finally { setBusy(false); }
  }
  const n = notice && NOTICE[notice.kind];
  const withdrawn = notice?.kind === 'withdrawn';
  return (
    <ClientPage plain rootRef={ref}>
      <ClientHeader sub="Client portal" />
      <div className="cl-stage">
        <section className="cl-intro" data-a="rise" aria-labelledby="intro-h">
          <h2 className="mg-display" id="intro-h">Your work with us, <span className="cl-em">in one place.</span></h2>
          <p className="cl-text2" style={{ maxWidth: '46ch', fontSize: 14 }}>The client portal of {PROVIDER}. See where each project stands and what you owe, and answer us without hunting through email.</p>
          <div className="mg-glass mg-panel cl-wide" style={{ gap: 16, maxWidth: 520 }}>
            {[[Briefcase, 'Projects and orders', 'Where each project stands, and what is billed, received and still to bill on every PO.'],
              [Receipt, 'Invoices with GST', "Confirm an invoice, raise a query or tell us you've paid."],
              [Award, 'Documents and certificates', 'Quotations, reports and certificates to download, and a place to upload yours.']].map(([Icon, title, text]) => (
              <div className="cl-feat" key={title}>
                <span className="cl-ico" aria-hidden="true"><Icon strokeWidth={1.8} /></span>
                <div><strong>{title}</strong><div style={{ fontSize: 13, color: 'var(--text2)' }}>{text}</div></div>
              </div>
            ))}
          </div>
        </section>
        <main className="mg-glass mg-glass--strong cl-card" data-a="rise">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="mg-eyebrow">{PROVIDER}</span>
            <h1 className="mg-display">Client <span className="cl-em">portal</span></h1>
            {!sentTo && !withdrawn && <p className="cl-text2">Enter the email address we have for you. We will send a link that signs you in.</p>}
          </div>
          {n && <Banner tone={n[0]} role={n[1]} icon={n[2]} title={n[3]}>{notice.text || n[4]}</Banner>}
          {sentTo ? (
            <div className="cl-sent" role="status">
              <span className="mg-empty__mark cl-ico--ok"><Mail size={26} strokeWidth={1.8} aria-hidden="true" /></span>
              <strong style={{ fontSize: 17 }}>Check your email</strong>
              <p>If <strong style={{ color: 'var(--text)' }}>{sentTo}</strong> belongs to a client with portal access, a sign-in link is on its way. It works once, for 20 minutes.</p>
              <button type="button" className="mg-btn mg-btn--ghost" onClick={() => { setSentTo(null); setEmail(''); }}>Use a different address</button>
            </div>
          ) : !withdrawn && (
            <form onSubmit={go} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label className={`mg-field${badEmail ? ' is-error' : ''}`}>
                <span className="mg-field__label">Email</span>
                <input className="mg-input" type="email" autoComplete="email" required value={email} readOnly={busy} placeholder="name@company.com" style={{ height: 48 }} aria-invalid={badEmail || undefined}
                  onChange={(e) => { setEmail(e.target.value); setBlocked(false); }} autoFocus />
                {badEmail && <span className="mg-field__error">Enter an email address, like name@company.com</span>}
              </label>
              <button type="submit" className={`mg-btn mg-btn--primary mg-btn--lg${busy ? ' is-loading' : ''}`} aria-busy={busy} disabled={busy || blocked} style={{ width: '100%' }}>{busy ? 'Sending…' : 'Send me a link'}</button>
            </form>
          )}
          <p className="cl-lockline"><Lock strokeWidth={1.8} aria-hidden="true" />No password to remember. Each link works once, for 20 minutes, and a session lasts 8 hours.</p>
          <p className="cl-rule">No email from us? Check your spam folder, or ask your contact at {PROVIDER} to add your address.</p>
        </main>
      </div>
    </ClientPage>
  );
}

/* ------------------------------------------------------------ home */

/** Arrow keys move between tabs, as a tablist should. */
function onTabKeys(e, list, current, pick) {
  const i = list.indexOf(current);
  const next = e.key === 'ArrowRight' ? list[(i + 1) % list.length] : e.key === 'ArrowLeft' ? list[(i - 1 + list.length) % list.length]
    : e.key === 'Home' ? list[0] : e.key === 'End' ? list[list.length - 1] : null;
  if (!next) return;
  e.preventDefault(); pick(next);
  const host = e.currentTarget.parentElement;
  requestAnimationFrame(() => host?.querySelector('[aria-selected="true"]')?.focus());
}

function Home({ me, onOut, onEnded }) {
  const tabs = PORTAL_ORDER.filter((s) => me.sections.includes(s));
  const [tab, setTab] = useState(tabs[0]);
  const [ended, setEnded] = useState(false);
  const [unpaid, setUnpaid] = useState(0);
  const ref = useEnter('home');
  const many = tabs.length > 1;
  const count = (s) => (s === 'invoices' && unpaid > 0 ? unpaid : null);
  const bar = !ended && many && (
    <nav className="mg-glass cl-tabbar" aria-label="Portal sections" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      <div role="tablist" aria-label="Portal sections" style={{ display: 'contents' }}>
        {tabs.map((s) => {
          const Icon = TAB_ICON[s];
          return (
            <button key={s} type="button" role="tab" aria-selected={tab === s} aria-controls="portal-panel" aria-label={PORTAL_LABEL[s]} tabIndex={tab === s ? 0 : -1}
              data-jelly onClick={() => setTab(s)} onKeyDown={(e) => onTabKeys(e, tabs, tab, setTab)}>
              <span className="cl-tabbar__drop" aria-hidden="true" />
              <Icon strokeWidth={1.8} aria-hidden="true" />
              <span className="cl-tabbar__label">{SHORT[s]}</span>
              {count(s) && <span className="mg-count" aria-hidden="true">{count(s)}</span>}
            </button>
          );
        })}
      </div>
    </nav>
  );
  return (
    <ClientPage plain={ended || !many} after={bar} rootRef={ref}>
      <ClientHeader sub="Client portal" who={me.contact_name} company={me.company_name} onSignOut={onOut} />
      <section className="cl-title" data-a="rise">
        <div className="cl-title__main">
          <span className="mg-eyebrow">Your client portal</span>
          <h1 className="mg-display">{me.company_name}</h1>
          <p className="cl-title__lead">Signed in as {me.contact_name}. Your projects, orders, invoices, documents and certificates with {PROVIDER}, kept up to date by our team.</p>
        </div>
        <p className="cl-private cl-wide"><ShieldCheck strokeWidth={1.8} aria-hidden="true" />Private to {me.company_name}. Only people we have added can sign in.</p>
      </section>
      {ended ? (
        <section className="mg-glass mg-empty" role="alert" style={{ padding: '56px 24px' }}>
          <span className="mg-empty__mark cl-ico--wait"><Clock size={24} strokeWidth={1.8} aria-hidden="true" /></span>
          <h2 className="mg-empty__title" style={{ fontSize: 18 }}>You have been signed out</h2>
          <p className="mg-empty__text">Sessions last 8 hours, and end when your portal access changes. Ask for a new sign-in link and you will come back here.</p>
          <button type="button" className="mg-btn mg-btn--primary" style={{ marginTop: 8 }} onClick={onEnded}>Get a new sign-in link</button>
        </section>
      ) : !tabs.length ? (
        <section className="mg-glass mg-empty" data-a="rise" style={{ padding: '56px 24px' }}>
          <span className="mg-empty__mark"><Folder size={24} strokeWidth={1.8} aria-hidden="true" /></span>
          <h2 className="mg-empty__title" style={{ fontSize: 18 }}>Nothing is shared here yet</h2>
          <p className="mg-empty__text">{PROVIDER} has not switched on any part of your portal yet. Reply to the email that brought you here and we will set it up.</p>
        </section>
      ) : (
        <>
          {many && (
            <nav className="mg-glass cl-tabs cl-wide" data-a="rise" aria-label="Portal sections">
              <div className="mg-tabs" role="tablist" aria-label="Portal sections">
                {tabs.map((s) => {
                  const Icon = TAB_ICON[s];
                  return (
                    <button key={s} type="button" role="tab" id={`tab-${s}`} aria-selected={tab === s} aria-controls="portal-panel" tabIndex={tab === s ? 0 : -1}
                      onClick={() => setTab(s)} onKeyDown={(e) => onTabKeys(e, tabs, tab, setTab)}>
                      <Icon strokeWidth={1.8} aria-hidden="true" />{PORTAL_LABEL[s]}
                      {count(s) && <span className="mg-count" aria-hidden="true" title={`${count(s)} unpaid`}>{count(s)}</span>}
                    </button>
                  );
                })}
              </div>
            </nav>
          )}
          <div id="portal-panel" role="tabpanel" aria-labelledby={many ? `tab-${tab}` : undefined} aria-label={many ? undefined : PORTAL_LABEL[tab]} className="cl-panel">
            <PortalSection key={tab} name={tab} sections={me.sections} company={me.company_name} contact={me.contact_name}
              onSignedOut={() => setEnded(true)} onUnpaid={setUnpaid} />
          </div>
          <footer className="cl-foot">
            <span>Private to {me.company_name} and {PROVIDER}.</span>
            <span>Sessions last 8 hours. Sign out when you use a shared computer.</span>
          </footer>
        </>
      )}
    </ClientPage>
  );
}

/* ------------------------------------------------------------ the sections, shared with the staff preview */

/**
 * One section of the portal. `load` fetches a section's data (the portal's
 * own API by default; the staff preview passes its own), and `preview`
 * draws it flat inside the staff panel: no answers, and file names rather
 * than links, because files open only from the client's own session.
 */
export function PortalSection({ name, sections, load = call, preview = false, company, contact, onSignedOut, onUnpaid }) {
  const ctx = { load, preview, sections, company: company || 'your company', contact, onSignedOut, onUnpaid,
    card: preview ? 'cl-flat mg-panel' : 'mg-glass mg-panel',
    cardStrong: preview ? 'cl-flat mg-panel' : 'mg-glass mg-glass--strong mg-panel' };
  if (name === 'projects') return <Projects ctx={ctx} />;
  if (name === 'documents') return <Documents ctx={ctx} />;
  if (name === 'invoices') return <Invoices ctx={ctx} />;
  if (name === 'certificates') return <Certificates ctx={ctx} />;
  if (name === 'contact') return <Contact ctx={ctx} />;
  return null;
}

/** A section's data; a new `version` loads it again, keeping what is shown meanwhile. A 401 means the session ended. */
function useData(path, ctx, version = 0) {
  const [state, setState] = useState({ loading: true });
  const { load, onSignedOut, preview } = ctx;
  useEffect(() => {
    let live = true;
    load(path).then((data) => { if (live) setState({ data }); }).catch((e) => {
      if (!live) return;
      if (e.status === 401 && !preview) onSignedOut?.();
      setState((s) => (s.data ? s : { error: e }));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, load, version]);
  return state;
}

/** Loading and failure for a section: a skeleton, then "Couldn't load …" with Try again. */
function Pending({ s, ctx, what, retry }) {
  if (s.loading) {
    return ctx.preview ? (
      <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="mg-skel" style={{ height: 14, width: '30%' }} /><div className="mg-skel" style={{ height: 90 }} /><div className="mg-skel" style={{ height: 52 }} />
        <span className="cl-meta">Loading what the client sees…</span>
      </div>
    ) : (
      <section className="mg-glass mg-panel" aria-busy="true" aria-label={`Loading ${what}`}>
        <div className="mg-skel" style={{ height: 14, width: '28%' }} /><div className="mg-skel" style={{ height: 110 }} /><div className="mg-skel" style={{ height: 56 }} /><div className="mg-skel" style={{ height: 56, width: '82%' }} />
        <span className="cl-meta">Loading {what}…</span>
      </section>
    );
  }
  const e = s.error;
  if (ctx.preview) {
    return (
      <Banner tone="mg-banner--late" role="alert" title="Couldn't load this section" action={<button type="button" className="mg-btn mg-btn--sm" onClick={retry}>Try again</button>}>
        {serverDown(e) ? "The server didn't answer. Nothing changed for the client. Try again." : e.message}
      </Banner>
    );
  }
  if (e.status === 401) return null;
  return (
    <section className="mg-glass mg-empty" role="alert">
      <span className="mg-empty__mark cl-ico--late"><CircleAlert size={24} strokeWidth={1.8} aria-hidden="true" /></span>
      <h2 className="mg-empty__title">Couldn't load {what}</h2>
      <p className="mg-empty__text">{serverDown(e) ? 'Something went wrong on our side. Your records are safe. Try again in a minute, or write to us in Contact us if it keeps happening.' : e.message}</p>
      <button type="button" className="mg-btn mg-btn--sm" onClick={retry}>Try again</button>
    </section>
  );
}

/** A file link, or its name in the staff preview, where files are not served. */
function FileLink({ ctx, href, label, children, icon = true }) {
  if (ctx.preview) return <span className="cl-fname" title="Opens in the client's portal">{children}</span>;
  return <a className="cl-link" href={href} aria-label={label}>{icon && <Download strokeWidth={1.8} aria-hidden="true" />}{children}</a>;
}

function Empty({ ctx, icon: Icon, title, children }) {
  return (
    <section className={`${ctx.card} mg-empty`} data-a="rise" style={{ padding: '48px 24px' }}>
      <span className="mg-empty__mark"><Icon size={24} strokeWidth={1.8} aria-hidden="true" /></span>
      <h2 className="mg-empty__title">{title}</h2>
      <p className="mg-empty__text">{children}</p>
    </section>
  );
}

const spot = (e) => { const el = e.currentTarget, b = el.getBoundingClientRect(); el.style.setProperty('--mx', `${e.clientX - b.left}px`); el.style.setProperty('--my', `${e.clientY - b.top}px`); };

/** The big figure: rupees count up, the paise sit small beside them. */
function HeroFigure({ value, cur }) {
  const v = r2(value), whole = Math.floor(v), cents = String(Math.round((v - whole) * 100)).padStart(2, '0');
  return (
    <div className="mg-hero__figure mg-num">
      {cur === 'INR' ? <span data-count={whole} data-format="inr">{`₹${whole.toLocaleString('en-IN')}`}</span> : <span>{exact(whole, cur).replace(/\.00$/, '')}</span>}
      <span className="cl-hero__cents">.{cents}</span>
    </div>
  );
}

const byCurrency = (rows) => rows.reduce((m, r) => { (m[r.currency || 'INR'] ||= []).push(r); return m; }, {});
const sumOf = (rows, k) => r2(rows.reduce((n, r) => n + Number(r[k] || 0), 0));
const pct = (part, whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

/** "Your live orders": every live PO in rupees (or the one currency there is), the others said in words. */
function ordersSummary(projects) {
  const orders = projects.flatMap((p) => p.orders || []);
  if (!orders.length) return null;
  const groups = byCurrency(orders);
  const cur = groups.INR ? 'INR' : Object.keys(groups)[0];
  const list = groups[cur];
  const names = list.map((o) => `PO ${o.po_number}`);
  let sub = `${names.length <= 3 ? andList(names) : plural(names.length, 'purchase order')}, in ${curWord(cur)}.`;
  for (const [c, rows] of Object.entries(groups)) {
    if (c === cur) continue;
    const noGst = rows.every((o) => !(Number(o.gst) > 0));
    const on = rows.length <= 2 ? andList(rows.map((o) => `PO ${o.po_number}`)) : plural(rows.length, 'PO');
    sub += ` Plus ${exact(sumOf(rows, 'value'), c)} on ${on}${noGst ? `, which ${rows.length === 1 ? 'has' : 'have'} no GST` : ''}.`;
  }
  const value = sumOf(list, 'value');
  return { cur, value, sub, received: sumOf(list, 'received'), outstanding: sumOf(list, 'outstanding'), toBill: sumOf(list, 'to_bill') };
}

const STAGE_TONE = (s) => (/deliver|complet|closed|done/i.test(s || '') ? 'mg-badge--ok' : /plan|onboard|not started|new/i.test(s || '') ? 'mg-badge--info' : 'mg-badge--wait');
const STATE_TONE = { Paid: 'mg-badge--ok', Overdue: 'mg-badge--late', 'Payment reported': 'mg-badge--info', 'Part paid': 'mg-badge--wait', Due: 'mg-badge--wait' };

function Projects({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/projects', ctx, version);
  const ref = useEnter(s.data ? 'projects' : null);
  if (!s.data) return <Pending s={s} ctx={ctx} what={WHAT.projects} retry={() => setVersion((n) => n + 1)} />;
  if (!s.data.length) {
    return <Empty ctx={ctx} icon={Briefcase} title="No projects yet">When we start work for {ctx.company}, each project and its purchase orders show here, with what is billed, received and still to bill.</Empty>;
  }
  const sum = ordersSummary(s.data);
  return (
    <div className="cl-panel" ref={ref}>
      {sum && !ctx.preview && (
        <section className="mg-hero" data-a="rise" onMouseMove={spot} aria-label="Your live orders">
          <div className="cl-sum">
            <div>
              <span className="mg-hero__label">Your live orders, including GST</span>
              <HeroFigure value={sum.value} cur={sum.cur} />
              <span className="mg-hero__sub">{sum.sub}</span>
            </div>
            <div>
              <div className="mg-progress" role="img" style={{ height: 12 }}
                aria-label={`Received ${Math.round(pct(sum.received, sum.value))}%, outstanding ${Math.round(pct(sum.outstanding, sum.value))}%, still to bill ${Math.round(pct(sum.toBill, sum.value))}%`}>
                <span className="mg-progress__done" style={{ width: `${pct(sum.received, sum.value)}%` }} />
                <span className="mg-progress__expected" style={{ width: `${pct(sum.outstanding, sum.value)}%` }} />
                <span className="mg-shimmer" />
              </div>
              <dl className="cl-legend">
                <div><dt><i className="cl-sw cl-sw--received" />Received</dt><dd className="mg-num">{exact(sum.received, sum.cur)}</dd></div>
                <div><dt><i className="cl-sw mg-hatch" />Outstanding</dt><dd className="mg-num">{exact(sum.outstanding, sum.cur)}</dd></div>
                <div><dt><i className="cl-sw cl-sw--tobill" />Still to bill</dt><dd className="mg-num">{exact(sum.toBill, sum.cur)}</dd></div>
              </dl>
            </div>
          </div>
        </section>
      )}
      {sum && ctx.preview && (
        <dl className="cl-figs">
          <div><dt>Live orders ({SIGN[sum.cur] || sum.cur})</dt><dd className="mg-num">{exact(sum.value, sum.cur)}</dd></div>
          <div><dt>Received</dt><dd className="mg-num">{exact(sum.received, sum.cur)}</dd></div>
          <div><dt>Outstanding</dt><dd className="mg-num">{exact(sum.outstanding, sum.cur)}</dd></div>
          <div><dt>Still to bill</dt><dd className="mg-num">{exact(sum.toBill, sum.cur)}</dd></div>
        </dl>
      )}
      {s.data.map((p) => <Project key={p.project_id} p={p} ctx={ctx} />)}
    </div>
  );
}

function Project({ p, ctx }) {
  const done = p.checklist.filter((c) => c.done).length;
  const firstOpen = p.checklist.findIndex((c) => !c.done);
  const [next, ...later] = p.visits;
  return (
    <section className={ctx.card} data-a="rise" aria-label={p.primary_service || p.project_id}>
      <div>
        <div className="cl-card-head"><h2 className="mg-panel__title" style={{ fontSize: 17 }}>{p.primary_service || p.project_id}</h2>{p.project_stage && <span className={`mg-badge ${STAGE_TONE(p.project_stage)}`}>{p.project_stage}</span>}</div>
        <div className="cl-meta" style={{ marginTop: 2 }}>{p.project_id} · planned {day(p.planned_start_date)} to {day(p.planned_delivery_date)}{p.actual_delivery_date ? ` · delivered ${day(p.actual_delivery_date)}` : ''}</div>
      </div>
      {(p.checklist.length > 0 || next) && (
        <div className="cl-twocol">
          {p.checklist.length > 0 && (
            <div>
              <span className="mg-label">Onboarding</span>
              <span style={{ fontWeight: 700 }}>{done} of {p.checklist.length} steps done</span>
              <div className="mg-steps" aria-hidden="true">{p.checklist.map((c, i) => <span key={i} className={c.done ? 'is-done' : i === firstOpen ? 'is-on' : ''} />)}</div>
            </div>
          )}
          {next && (
            <div>
              <span className="mg-label">Next visit</span>
              <span style={{ fontWeight: 700 }}>{next.title} · {day(next.starts_at)}{next.city ? `, ${next.city}` : ''}</span>
              <span className="cl-meta">{next.status === 'confirmed' ? 'Confirmed.' : 'Planned.'}{later.length ? ` Then ${later.map((v) => `${v.title} · ${day(v.starts_at)}${v.city ? `, ${v.city}` : ''} (${v.status})`).join('; ')}.` : ''}</span>
            </div>
          )}
        </div>
      )}
      {(p.orders || []).map((o) => <Order key={o.po_number} o={o} ctx={ctx} project={p} />)}
    </section>
  );
}

/** A purchase order: its value with the GST in it, what is billed and still to bill, and its schedule (#198 §3). */
function Order({ o, ctx, project }) {
  const c = o.currency;
  const invoicesOn = ctx.sections?.includes('invoices');
  const [asking, setAsking] = useState(false);
  const value = Number(o.value) || Number(o.billed) + Number(o.to_bill);
  const figs = [['Billed', o.billed], ['Received', o.received], ['Outstanding', o.outstanding, Number(o.outstanding) > 0 ? 'is-exp' : ''], ['Still to bill', o.to_bill]];
  return (
    <div className="cl-po">
      <div className="cl-po__head">
        <div>
          <h3>PO {o.po_number}{o.po_date ? ` · ${day(o.po_date)}` : ''} · {exact(o.value, c)}</h3>
          <div className="cl-meta">{[o.revised_from && `Revised from PO ${o.revised_from}`, o.services.length > 0 && `Services: ${o.services.join(', ')}`].filter(Boolean).join(' · ')}</div>
        </div>
        {o.has_file && <FileLink ctx={ctx} href={`${BASE}/files/po/${encodeURIComponent(o.po_number)}`} label={`PO file for PO ${o.po_number}`}>PO file</FileLink>}
      </div>
      <p className="cl-po__value">
        {Number(o.gst) > 0
          ? <>Value {exact(o.value, c)} including GST {exact(o.gst, c)} (taxable {exact(o.taxable, c)})</>
          : <>Value {exact(o.value, c)}{c !== 'INR' ? ' (no GST)' : ''}</>}
        {ctx.preview && o.gst_source === 'estimated' && <span className="mg-badge mg-badge--info" title="Staff only. The client does not see this flag.">GST estimated · staff only</span>}
      </p>
      <dl className="cl-figs">
        {figs.map(([label, v, cls]) => <div key={label}><dt>{label}</dt><dd className={`mg-num ${cls || ''}`}>{exact(v, c)}</dd></div>)}
      </dl>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="mg-progress" role="img" aria-label={`Received ${Math.round(pct(o.received, value))}%, outstanding ${Math.round(pct(o.outstanding, value))}%, still to bill ${Math.round(pct(o.to_bill, value))}%`}>
          <span className="mg-progress__done" style={{ width: `${pct(o.received, value)}%` }} />
          <span className="mg-progress__expected" style={{ width: `${pct(o.outstanding, value)}%` }} />
        </div>
        <span className="cl-meta">{c !== 'INR' && !(Number(o.gst) > 0) ? `No GST on this order: it is billed in ${curWord(c)}.` : 'All amounts include GST.'}</span>
      </div>
      {o.schedule.length > 0 && (
        <div>
          <h4 className="mg-label" style={{ margin: '0 0 4px' }}>Payment schedule</h4>
          <ol className="cl-sched">
            {o.schedule.map((st) => (
              <li key={st.id}>
                <span className="cl-n" aria-hidden="true">{st.stage_no}</span>
                <span className="cl-sched__what">{st.stage_name} · {Math.round(Number(st.stage_percent) * 100)}% · {exact(st.amount, c)}</span>
                <span className="cl-sched__trig cl-meta">{st.trigger_event === 'On Milestone' && st.milestone_name ? `On ${st.milestone_name}` : st.trigger_event}</span>
                <span className="cl-sched__inv">
                  <span>{st.invoice_no ? `Invoice ${st.invoice_no}` : 'Not invoiced yet'}</span>
                  {st.invoice_no && st.has_pdf && invoicesOn && <FileLink ctx={ctx} href={`${BASE}/files/invoice/${st.id}`} label={`PDF of invoice ${st.invoice_no}`} icon={false}>PDF</FileLink>}
                </span>
                <span className="cl-sched__state"><span className={`mg-badge ${STATE_TONE[st.state] || ''}`}>{st.state}</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {/* A query on the PO itself, say on the schedule; it is answered with the invoices' queries. */}
      {invoicesOn && !ctx.preview && (
        <div><button type="button" className="mg-btn mg-btn--sm" onClick={() => setAsking(true)}><CircleHelp strokeWidth={1.8} aria-hidden="true" />Raise a query about this PO</button></div>
      )}
      {asking && <AnswerDialog kind="query" po={o} project={project} onClose={() => setAsking(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------ documents */

const FILE_ICON = (name) => (/\.(xlsx?|csv)$/i.test(name || '') ? FileSpreadsheet : File);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : '');

function Documents({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/documents', ctx, version);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const ref = useEnter(s.data ? 'documents' : null);
  if (!s.data) return <Pending s={s} ctx={ctx} what={WHAT.documents} retry={() => setVersion((n) => n + 1)} />;
  const d = s.data;
  const reload = () => setVersion((n) => n + 1);
  const docHref = (id) => `${BASE}/files/document/${id}`;
  // Which of their records a file is on. An invoice without a stored PDF is not in this list, so it is "an invoice".
  const on = (x) => (x.entity === 'purchase_order' ? `PO ${x.entity_id}`
    : x.entity === 'project' ? `project ${x.entity_id}`
    : x.entity === 'payment_stage' ? (() => { const no = d.invoices.find((i) => String(i.id) === x.entity_id)?.invoice_no; return no ? `invoice ${no}` : 'an invoice'; })()
    : 'your account');
  const rows = [
    ...d.quotations.map((q) => ({ key: `q${q.quotation_no}`, doc: `Quotation ${q.quotation_no}${q.revision ? ` rev ${q.revision}` : ''}`, sub: q.service_quoted, kind: 'Quotation', at: q.quotation_date, amt: q.amount != null ? exact(q.amount, q.currency) : '', link: 'PDF', href: `${BASE}/files/quotation/${encodeURIComponent(q.quotation_no)}` })),
    ...d.purchase_orders.map((p) => ({ key: `p${p.po_number}`, doc: `Purchase order ${p.po_number}`, sub: p.project_id ? `On project ${p.project_id}` : '', kind: 'Purchase order', at: p.po_date, amt: p.amount != null ? exact(p.amount, p.currency) : '', link: p.document_id ? 'Download' : null, href: p.document_id && docHref(p.document_id) })),
    ...d.invoices.map((i) => ({ key: `i${i.id}`, doc: `Invoice ${i.invoice_no}`, sub: `PO ${i.po_number} · ${i.stage_name}`, kind: 'Invoice', at: i.invoice_date, amt: exact(i.amount, i.currency), link: 'Download', href: docHref(i.document_id) })),
    ...d.deliverables.map((x) => ({ key: `d${x.id}`, doc: `${x.title}${x.reference ? ` (${x.reference})` : ''}`, sub: '', kind: cap(x.type) || 'Report', at: x.issued_on, amt: '', link: x.document_id ? 'Download' : null, href: x.document_id && docHref(x.document_id) })),
    // Files our team attached to their records and chose to share.
    ...d.shared.map((x) => ({ key: `a${x.id}`, doc: x.label || x.file_name, sub: `On ${on(x)}`, kind: 'Shared file', at: x.created_at, amt: '', link: 'Download', href: docHref(x.document_id) })),
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  const canUpload = !ctx.preview && d.targets.length > 0;
  const fileCell = (r) => (r.link ? <FileLink ctx={ctx} href={r.href} label={`${r.link} ${r.doc}`}>{ctx.preview ? 'File' : r.link}</FileLink> : null);
  return (
    <div className="cl-panel" ref={ref}>
      <section className={ctx.cardStrong} data-a="rise" aria-labelledby="from-us" style={{ paddingBottom: rows.length ? 10 : undefined }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <h2 className="mg-panel__title" id="from-us">From {PROVIDER}</h2>
          <span className="mg-panel__hint">{rows.length ? 'Quotations, orders, invoices, reports and files our team shared, newest first' : 'What our team sends you'}</span>
        </div>
        {rows.length ? (
          <>
            <div className="mg-tablewrap cl-tablewrap cl-wide">
              <table className="mg-table cl-tbl">
                <thead><tr><th>Document</th><th>Kind</th><th className="num">Date</th><th className="num">Amount</th><th className="actions"><span className="sr-only">File</span></th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      <td className="strong wrap">{r.doc}{r.sub && <span className="sub">{r.sub}</span>}</td>
                      <td>{r.kind}</td><td className="num">{r.at ? when(r.at) : '—'}</td><td className="num">{r.amt || '—'}</td>
                      <td className="actions">{fileCell(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cl-narrow cl-rows"><div className="mg-rows">
              {rows.map((r) => (
                <div key={r.key} className="mg-row">
                  <span><span style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{r.doc}</span><span className="mg-row__meta">{r.kind} · {r.at ? when(r.at) : '—'}{r.amt ? ` · ${r.amt}` : ''}</span>{r.sub && <span className="mg-row__meta">{r.sub}</span>}</span>
                  {r.link && (ctx.preview ? <span className="cl-fname">File</span>
                    : <a className="mg-iconbtn" href={r.href} aria-label={`${r.link} ${r.doc}`} style={{ background: 'var(--track)' }}><Download strokeWidth={1.8} aria-hidden="true" /></a>)}
                </div>
              ))}
            </div></div>
          </>
        ) : (
          <div className="mg-empty" style={{ padding: '24px 12px 30px' }}>
            <span className="mg-empty__mark"><FileText size={24} strokeWidth={1.8} aria-hidden="true" /></span>
            <h3 className="mg-empty__title">Nothing from us yet</h3>
            <p className="mg-empty__text">Quotations, purchase orders, invoices, reports and files our team shares with you will show here.</p>
          </div>
        )}
      </section>

      <section className={ctx.card} data-a="rise" aria-labelledby="from-you">
        <div className="mg-panel__head" style={{ flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}><h2 className="mg-panel__title" id="from-you">From you</h2><span className="mg-panel__hint">Files anyone at {ctx.company} uploaded for our team</span></div>
          {canUpload && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => { setUploaded(false); setUploading(true); }}><Upload strokeWidth={1.8} aria-hidden="true" />Upload a file</button>}
        </div>
        {uploaded && <Banner tone="mg-banner--ok" icon={CircleCheckBig} title="Uploaded">Our team will see it on the record. You can delete it until they open it.</Banner>}
        {d.uploads.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {d.uploads.map((u) => {
              const Icon = FILE_ICON(u.file_name);
              return (
                <div key={u.id} className="cl-rowline">
                  <span className="cl-ico" aria-hidden="true"><Icon strokeWidth={1.8} /></span>
                  <div className="cl-rowline__body">
                    <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px' }}>
                      <strong>{u.label}</strong>
                      {u.seen ? <span className="mg-badge mg-badge--ok">Seen by our team</span> : <span className="mg-badge">Not opened yet</span>}
                    </span>
                    <span className="cl-meta">{u.file_name} · on {on(u)} · {when(u.created_at)}{u.by_name ? ` · by ${u.by_name}` : ''}</span>
                  </div>
                  {ctx.preview ? <span className="cl-fname cl-rowline__acts" title="Opens in the client's portal">{u.file_name}</span> : (
                    <div className="cl-actions cl-rowline__acts">
                      <a className="mg-btn mg-btn--sm mg-btn--ghost" href={docHref(u.document_id)} aria-label={`Download ${u.label}`}><Download strokeWidth={1.8} aria-hidden="true" />Download</a>
                      {u.mine && !u.seen && <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost cl-danger" aria-label={`Delete ${u.label}`} onClick={() => setDeleting(u)}><Trash2 strokeWidth={1.8} aria-hidden="true" />Delete</button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mg-empty" style={{ padding: '18px 12px 22px' }}>
            <span className="mg-empty__mark"><Upload size={24} strokeWidth={1.8} aria-hidden="true" /></span>
            <h3 className="mg-empty__title">Nothing uploaded yet</h3>
            <p className="mg-empty__text">{ctx.preview ? 'Nothing uploaded yet.' : d.targets.length ? 'A signed PO, an amendment or evidence for an audit can go here, on the project or PO it belongs to.' : 'Uploads open once there is a project or purchase order to file them on. Our team will let you know.'}</p>
          </div>
        )}
      </section>
      {uploading && <UploadDialog targets={d.targets} onClose={() => setUploading(false)} onDone={() => { setUploading(false); setUploaded(true); reload(); }} />}
      {deleting && <DeleteDialog u={deleting} on={on(deleting)} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); reload(); }} />}
    </div>
  );
}

/** A file field as a drop zone: the name and size once chosen, Choose a file or Change. */
function FileZone({ id, label, required, accept, hint, file, onFile, error, disabled }) {
  const input = useRef(null);
  const [drag, setDrag] = useState(false);
  const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  return (
    <div className={`mg-field${error ? ' is-error' : ''}`}>
      <span className="mg-field__label" id={`${id}-l`}>{label}{required && <span className="req" aria-hidden="true">*</span>}</span>
      <div className={`cl-file${drag ? ' is-drag' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!disabled && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
        <span className="cl-ico" aria-hidden="true">{file ? <FileText strokeWidth={1.8} /> : <Paperclip strokeWidth={1.8} />}</span>
        <span className="cl-file__name">{file ? <><strong>{file.name}</strong><span className="cl-meta">{size(file.size)}</span></> : hint}</span>
        <input ref={input} id={id} type="file" accept={accept} required={required} aria-labelledby={`${id}-l`} disabled={disabled} tabIndex={-1}
          onChange={(e) => onFile(e.target.files[0] || null)} />
        <button type="button" className={`mg-btn mg-btn--sm${file ? ' mg-btn--ghost' : ''}`} disabled={disabled} onClick={() => input.current?.click()}>{file ? 'Change' : 'Choose a file'}</button>
      </div>
      {error && <span className="mg-field__error">{error}</span>}
    </div>
  );
}

/** The two buttons under every answer: Cancel and the one that sends, busy while it sends. */
function Foot({ formId, busy, blocked, label, busyLabel = 'Sending…', cancel = 'Cancel', danger, onClose }) {
  return (
    <>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>{cancel}</button>
      <button type="submit" form={formId} className={`mg-btn ${danger ? 'mg-btn--danger' : 'mg-btn--primary'}${busy ? ' is-loading' : ''}`} aria-busy={busy} disabled={busy || blocked}>{busy ? busyLabel : label}</button>
    </>
  );
}

/** Thank you, said by the server, in the dialog that asked. */
function Done({ title: dialogTitle, message, fallback, onClose }) {
  const [title, ...rest] = String(message || '').split(/(?<=\.)\s+/);
  return (
    <Modal title={dialogTitle} onClose={onClose} size="sm" footer={<button type="button" className="mg-btn mg-btn--primary" onClick={onClose} style={{ minWidth: 140, margin: '0 auto' }}>Close</button>}>
      <div className="cl-dlg__done" role="status">
        <span className="mg-empty__mark cl-ico--ok" style={{ margin: '0 auto' }}><Check size={26} strokeWidth={2} aria-hidden="true" /></span>
        <strong style={{ fontSize: 16 }}>{title || 'Thank you.'}</strong>
        <p>{rest.join(' ') || fallback}</p>
      </div>
    </Modal>
  );
}

function UploadDialog({ targets, onClose, onDone }) {
  const key = (t) => `${t.entity}:${t.entity_id}`;
  const [target, setTarget] = useState(targets[0] ? key(targets[0]) : '');
  const [label, setLabel] = useState('');
  const [chosen, setChosen] = useState(null);
  const [state, setState] = useState({});
  async function go(e) {
    e.preventDefault();
    const t = targets.find((x) => key(x) === target);
    const form = new FormData();
    form.set('entity', t.entity); form.set('entity_id', t.entity_id); form.set('label', label); form.set('file', chosen);
    setState({ busy: true });
    try { await send('/documents', { form }); onDone(); }
    catch (ex) {
      const f = ex.fields || {};
      setState({ fields: { label: f.label, file: f.file || (/larger than/i.test(ex.message) ? `${ex.message}. Upload a smaller copy, or split it.` : null) }, error: !f.label && !f.file && !/larger than/i.test(ex.message) ? ex.message : null });
    }
  }
  const busy = !!state.busy;
  return (
    <Modal title="Upload a file" subtitle="Our team sees it on the PO or project you pick" onClose={busy ? () => {} : onClose} size="sm"
      footer={<Foot formId="portal-upload" busy={busy} blocked={!chosen} label="Upload" busyLabel="Uploading…" onClose={onClose} />}>
      <form id="portal-upload" className="cl-dlg" onSubmit={go} noValidate>
        {state.error && <Banner tone="mg-banner--late" role="alert" title="It wasn't uploaded">{state.error}</Banner>}
        <label className="mg-field">
          <span className="mg-field__label">For<span className="req" aria-hidden="true">*</span></span>
          <span className="mg-select-wrap">
            <select className="mg-select" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
              {targets.map((t) => <option key={key(t)} value={key(t)}>{t.entity === 'project' ? `Project: ${t.label}${t.label !== t.entity_id ? ` (${t.entity_id})` : ''}` : t.label}</option>)}
            </select>
          </span>
        </label>
        <label className={`mg-field${state.fields?.label ? ' is-error' : ''}`}>
          <span className="mg-field__label">What it is<span className="req" aria-hidden="true">*</span></span>
          <input className="mg-input" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} readOnly={busy} placeholder="Signed PO, PO amendment, audit evidence" />
          {state.fields?.label && <span className="mg-field__error">{state.fields.label}</span>}
        </label>
        <FileZone id="portal-upload-file" label="File" required accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx" hint="PDF, image, Word or Excel"
          file={chosen} onFile={(f) => { setChosen(f); setState({}); }} error={state.fields?.file} disabled={busy} />
        <p className="cl-small">PDF, image, Word or Excel. You can delete an upload until our team has seen it.</p>
      </form>
    </Modal>
  );
}

/** Taking back an upload: a confirm, with the reason when our team opened it first. */
function DeleteDialog({ u, on, onClose, onDone }) {
  const [state, setState] = useState({});
  async function go(e) {
    e.preventDefault(); setState({ busy: true });
    try { await send(`/documents/${u.id}`, { method: 'DELETE' }); onDone(); }
    catch (ex) { setState({ error: /already seen/i.test(ex.message) ? 'Our team opened it a moment ago, so it now stays on the record. Ask us in Contact us if it should go.' : ex.message }); }
  }
  const Icon = FILE_ICON(u.file_name);
  return (
    <Modal title={`Delete "${u.label}"?`} subtitle={`Uploaded by you on ${when(u.created_at)}`} onClose={state.busy ? () => {} : onClose} size="sm"
      footer={<Foot formId="portal-delete" busy={!!state.busy} label="Delete upload" busyLabel="Deleting…" cancel="Keep it" danger onClose={onClose} />}>
      <form id="portal-delete" className="cl-dlg" onSubmit={go}>
        {state.error && <Banner tone="mg-banner--late" role="alert" title="Couldn't delete it">{state.error}</Banner>}
        <p style={{ margin: 0, fontSize: 14 }}>It goes from the portal for everyone at your company. Our team has not opened it yet, so nothing on our side changes.</p>
        <div className="cl-rowline cl-filebox">
          <span className="cl-ico" aria-hidden="true"><Icon strokeWidth={1.8} /></span>
          <span className="cl-rowline__body"><strong style={{ fontSize: 13 }}>{u.file_name}</strong><span className="cl-meta">On {on} · {when(u.created_at)} · by you</span></span>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------ invoices */

/** An invoice's six figures, labelled, so they read the same on a phone as on a desk. */
function Figures({ t, c }) {
  const out = Number(t.outstanding);
  return (
    <dl className="cl-figs cl-figs--six">
      {[['Taxable', t.taxable], ['GST', t.gst], ['Total', t.amount, 'is-key'], ['Paid', t.paid], ['TDS', t.tds], ['Outstanding', t.outstanding, out > 0 ? (t.status === 'Overdue' ? 'is-late' : 'is-exp') : '']].map(([label, v, cls]) => (
        <div key={label} className={cls === 'is-key' ? 'is-key' : undefined}><dt>{label}</dt><dd className={`mg-num ${cls && cls !== 'is-key' ? cls : ''}`}>{exact(v, c)}</dd></div>
      ))}
    </dl>
  );
}

/** Totals per currency, as the statement adds them up. */
function totalsOf(rows) {
  const out = {};
  for (const i of rows) {
    const t = (out[i.currency || 'INR'] ||= { taxable: 0, gst: 0, amount: 0, paid: 0, tds: 0, outstanding: 0, n: 0 });
    for (const k of Object.keys(t)) if (k !== 'n') t[k] = r2(t[k] + Number(i[k] || 0));
    t.n += 1;
  }
  return out;
}

// What the client said last about an invoice, and where it stands.
const SAID = { confirmed: 'You confirmed this invoice', query: 'You raised a query', payment_advice: 'You told us you paid' };
const STANDS = { open: 'with our team', matched: 'payment recorded', resolved: 'resolved', rejected: 'answered, see Your requests' };
const saidOf = (a) => (a.kind === 'confirmed' ? `${SAID.confirmed} on ${when(a.at)}.` : `${SAID[a.kind]} on ${when(a.at)}: ${STANDS[a.status]}.`);
const overdueDays = (i) => {
  if (i.status !== 'Overdue' || !i.invoice_due_date) return i.status;
  const n = Math.round((new Date(`${localToday()}T00:00:00`) - new Date(`${String(i.invoice_due_date).slice(0, 10)}T00:00:00`)) / 864e5);
  return n > 0 ? `Overdue · ${plural(n, 'day')}` : 'Overdue';
};

/** "Outstanding, including GST": rupees in the figure, other currencies said in words; overdue, due and being checked beside it. */
function owedSummary(rows) {
  const open = rows.filter((i) => Number(i.outstanding) > 0);
  const groups = byCurrency(open);
  const cur = groups.INR ? 'INR' : Object.keys(groups)[0] || 'INR';
  const list = groups[cur] || [];
  const part = (f) => sumOf(list.filter(f), 'outstanding');
  let sub = list.length ? `On ${plural(list.length, 'invoice')} in ${curWord(cur)}` : 'Nothing outstanding';
  for (const [c, xs] of Object.entries(groups)) if (c !== cur) sub += ` · plus ${exact(sumOf(xs, 'outstanding'), c)} on ${plural(xs.length, 'invoice')}`;
  return { cur, value: sumOf(list, 'outstanding'), sub, overdue: part((i) => i.status === 'Overdue'), checking: part((i) => i.status === 'Payment reported'), due: part((i) => i.status !== 'Overdue' && i.status !== 'Payment reported') };
}

function Invoices({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/invoices', ctx, version);
  const [po, setPo] = useState('');
  const [answer, setAnswer] = useState(null);   // { kind, invoice }; invoice null for a payment across several invoices
  const ref = useEnter(s.data ? 'invoices' : null);
  const unpaidCount = s.data ? s.data.filter((i) => Number(i.outstanding) > 0).length : 0;
  const { onUnpaid } = ctx;
  useEffect(() => { if (s.data) onUnpaid?.(unpaidCount); }, [s.data, unpaidCount, onUnpaid]);
  if (!s.data) return <Pending s={s} ctx={ctx} what={WHAT.invoices} retry={() => setVersion((n) => n + 1)} />;
  const reload = () => setVersion((n) => n + 1);
  if (!s.data.length) {
    return (
      <div className="cl-panel" ref={ref}>
        <Empty ctx={ctx} icon={Receipt} title="No invoices yet">Invoices we raise for {ctx.company} show here with their GST, what is paid and what is outstanding.</Empty>
        {!ctx.preview && <Requests version={version} invoices={s.data} />}
      </div>
    );
  }
  const rows = po ? s.data.filter((i) => i.po_number === po) : s.data;
  const pos = [...new Set(s.data.map((i) => i.po_number))];
  const totals = totalsOf(rows);
  const unpaid = s.data.filter((i) => Number(i.outstanding) > 0);
  const owed = owedSummary(s.data);
  const footnote = 'Total, paid and outstanding include GST. TDS your company deducted counts towards settling an invoice, so an invoice can be settled with less paid than its total.';
  return (
    <div className="cl-panel" ref={ref}>
      {ctx.preview ? (
        <p style={{ margin: 0, fontSize: 14 }}>Outstanding, including GST: <strong className="mg-num">{Object.entries(totalsOf(s.data)).map(([c, t]) => exact(t.outstanding, c)).join(' · ')}</strong></p>
      ) : (
        <section className="mg-hero" data-a="rise" onMouseMove={spot} aria-label="Outstanding">
          <div className="cl-sum">
            <div>
              <span className="mg-hero__label">Outstanding, including GST</span>
              <HeroFigure value={owed.value} cur={owed.cur} />
              <span className="mg-hero__sub">{owed.sub}</span>
            </div>
            <dl className="cl-legend cl-legend--flat">
              <div><dt><i className="cl-sw cl-sw--late" />Overdue</dt><dd className="mg-num">{exact(owed.overdue, owed.cur)}</dd></div>
              <div><dt><i className="cl-sw mg-hatch" />Due soon</dt><dd className="mg-num">{exact(owed.due, owed.cur)}</dd></div>
              <div><dt><i className="cl-sw cl-sw--info" />Paid, being checked</dt><dd className="mg-num">{exact(owed.checking, owed.cur)}</dd></div>
            </dl>
          </div>
        </section>
      )}
      <div className="cl-tools" data-a="rise">
        {pos.length > 1 && (
          <div className="mg-select-wrap">
            <select className="mg-select" value={po} onChange={(e) => setPo(e.target.value)} aria-label="Filter by PO">
              <option value="">All POs</option>
              {pos.map((n) => <option key={n} value={n}>PO {n}</option>)}
            </select>
          </div>
        )}
        <span className="cl-meta cl-tools__count cl-wide">{rows.length === s.data.length ? `${plural(rows.length, 'invoice')}, newest first` : `${rows.length} of ${plural(s.data.length, 'invoice')} · PO ${po}`}</span>
        {!ctx.preview && unpaid.length > 1 && <button type="button" className="mg-btn" onClick={() => setAnswer({ kind: 'payment_advice', invoice: null })}><Banknote strokeWidth={1.8} aria-hidden="true" />Tell us you've paid</button>}
        {ctx.preview ? <span className="cl-fname" title="Opens in the client's portal">Statement PDF</span>
          : <a className="mg-btn" href={`${BASE}/invoices/statement.pdf`}><Download strokeWidth={1.8} aria-hidden="true" />Download statement</a>}
      </div>
      {rows.map((i) => (
        <article key={i.id} className={ctx.card} data-a="rise" aria-label={`Invoice ${i.invoice_no}`}>
          <div className="cl-inv-head">
            <h2 className="mg-panel__title" style={{ fontSize: 16 }}>Invoice {i.invoice_no}</h2>
            {i.has_pdf && <FileLink ctx={ctx} href={`${BASE}/files/invoice/${i.id}`} label={`PDF of invoice ${i.invoice_no}`}>PDF</FileLink>}
            <span className={`mg-badge ${STATE_TONE[i.status] || ''}`}>{overdueDays(i)}</span>
          </div>
          <div className="cl-meta" style={{ marginTop: -6 }}>
            PO {i.po_number} · {i.stage_name}{i.project_id ? ` · ${i.project_id}` : ''} · dated {day(i.invoice_date)}{i.invoice_due_date && i.status !== 'Paid' ? ` · due ${day(i.invoice_due_date)}` : ''}
          </div>
          <Figures t={i} c={i.currency} />
          {i.last_action && <p className="cl-word"><MessageSquare strokeWidth={1.8} aria-hidden="true" />{saidOf(i.last_action)}</p>}
          {!ctx.preview && (
            <div className="cl-actions">
              {i.status !== 'Paid' && i.last_action?.kind !== 'confirmed' && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setAnswer({ kind: 'confirmed', invoice: i })}><Check strokeWidth={2} aria-hidden="true" />Confirm</button>}
              <button type="button" className="mg-btn mg-btn--sm" onClick={() => setAnswer({ kind: 'query', invoice: i })}><CircleHelp strokeWidth={1.8} aria-hidden="true" />Raise a query</button>
              {Number(i.outstanding) > 0 && i.status !== 'Payment reported' && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setAnswer({ kind: 'payment_advice', invoice: i })}><Banknote strokeWidth={1.8} aria-hidden="true" />Tell us you've paid</button>}
            </div>
          )}
        </article>
      ))}
      {rows.length > 1 ? (
        <section className={ctx.card} data-a="rise" aria-label="Totals">
          {Object.entries(totals).map(([c, t]) => (
            <div key={c} className="cl-total">
              <h3 className="mg-label" style={{ margin: 0 }}>Total ({c}) · {plural(t.n, 'invoice')}</h3>
              <Figures t={t} c={c} />
            </div>
          ))}
          <p className="cl-small">{footnote}</p>
        </section>
      ) : <p className="cl-small" style={{ padding: '0 4px' }}>{footnote}</p>}
      {!ctx.preview && <Requests version={version} invoices={s.data} />}
      {answer && <AnswerDialog kind={answer.kind} invoice={answer.invoice} invoices={unpaid} onClose={() => setAnswer(null)} onDone={reload} />}
    </div>
  );
}

const CUR_OF = (invoices, a) => invoices.find((i) => a.invoices.some((x) => x.id === i.id))?.currency || 'INR';

/**
 * The client's answer on an invoice or PO (#198 §4): a confirmation, a
 * query, or a payment they made. Each is a claim our team checks; nothing
 * the client sends changes the figures until finance records it. A dialog,
 * a bottom sheet on a phone; it says thank you in place when it is sent.
 */
function AnswerDialog({ kind, invoices = [], invoice, po, project, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [ids, setIds] = useState(invoice ? [invoice.id] : []);
  const [amount, setAmount] = useState(null);   // null: what is outstanding on the invoices chosen
  const [tds, setTds] = useState('');
  const [paidOn, setPaidOn] = useState(localToday());
  const [reference, setReference] = useState('');
  const [chosen, setChosen] = useState(null);
  const [state, setState] = useState({});
  const pool = invoice ? [invoice] : invoices;
  const picked = pool.filter((i) => ids.includes(i.id));
  const curs = [...new Set(picked.map((i) => i.currency || 'INR'))];
  const mixed = curs.length > 1;
  const cur = curs[0] || invoice?.currency || 'INR';
  const due = r2(picked.reduce((sum, i) => sum + Number(i.outstanding || 0), 0));
  const busy = !!state.busy;
  const fe = state.fields || {};

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
        const about = po ? { po_number: po.po_number } : { stage_ids: [invoice.id] };
        r = await call('/actions', { kind, ...about, note: kind === 'query' ? note : undefined });
      }
      setState({ done: r.message });
      onDone?.();
    } catch (ex) {
      const f = { ...(ex.fields || {}) };
      if (!ex.fields && /larger than/i.test(ex.message)) f.file = ex.message;
      const shown = ['note', 'amount', 'paid_on', 'file', 'tds_amount', 'reference'].some((k) => f[k]);
      setState({ fields: f, error: shown ? null : (f.stage_ids || ex.message) });
    }
  }

  if (state.done) {
    const fallback = kind === 'confirmed' ? 'The invoice now shows that you confirmed it. Our finance team has been told.'
      : kind === 'query' ? 'You can follow it under Your requests.' : 'Until then it shows Payment reported.';
    const title = kind === 'confirmed' ? `Confirm invoice ${invoice.invoice_no}` : kind === 'query' ? (po ? 'Raise a query about this PO' : 'Raise a query') : "Tell us you've paid";
    return <Done title={title} message={state.done} fallback={fallback} onClose={onClose} />;
  }
  const close = busy ? () => {} : onClose;
  const errBanner = (title) => state.error && <Banner tone="mg-banner--late" role="alert" title={title}>{state.error}</Banner>;

  if (kind === 'confirmed') {
    return (
      <Modal title={`Confirm invoice ${invoice.invoice_no}`} subtitle={`PO ${invoice.po_number} · ${invoice.stage_name}${invoice.project_id ? ` · ${invoice.project_id}` : ''}`} onClose={close} size="sm"
        footer={<Foot formId="portal-answer" busy={busy} label="Yes, confirm" onClose={onClose} />}>
        <form id="portal-answer" className="cl-dlg" onSubmit={go}>
          {errBanner("Your confirmation wasn't sent")}
          <p style={{ margin: 0, fontSize: 14 }}>Confirm that invoice <strong>{invoice.invoice_no}</strong> for <strong className="mg-num">{exact(invoice.amount, cur)}</strong> is correct and agreed for payment?</p>
          <dl className="cl-figs">
            <div><dt>Taxable</dt><dd className="mg-num">{exact(invoice.taxable, cur)}</dd></div>
            <div><dt>GST</dt><dd className="mg-num">{exact(invoice.gst, cur)}</dd></div>
            <div className="is-key"><dt>Total</dt><dd className="mg-num">{exact(invoice.amount, cur)}</dd></div>
          </dl>
          <p className="cl-meta" style={{ margin: 0 }}>Our team sees your name and the time. Confirming does not pay the invoice.</p>
        </form>
      </Modal>
    );
  }
  if (kind === 'query') {
    const about = po ? `PO ${po.po_number}` : `invoice ${invoice.invoice_no}`;
    const sub = po ? [`PO ${po.po_number}`, project?.primary_service, exact(po.value, po.currency)].filter(Boolean).join(' · ')
      : `Invoice ${invoice.invoice_no} · ${exact(invoice.amount, invoice.currency)} · ${String(invoice.status).toLowerCase()}`;
    return (
      <Modal title={po ? 'Raise a query about this PO' : 'Raise a query'} subtitle={sub} onClose={close} size="sm"
        footer={<Foot formId="portal-answer" busy={busy} label="Send query" onClose={onClose} />}>
        <form id="portal-answer" className="cl-dlg" onSubmit={go} noValidate>
          {errBanner("Your query wasn't sent")}
          <label className={`mg-field${fe.note ? ' is-error' : ''}`}>
            <span className="mg-field__label">A query about {about}<span className="req" aria-hidden="true">*</span></span>
            <textarea className="mg-textarea" rows={4} value={note} onChange={(e) => setNote(e.target.value)} required maxLength={2000} autoFocus readOnly={busy} placeholder="What looks wrong, or what you need from us" />
            {fe.note && <span className="mg-field__error">{fe.note}</span>}
            <span className="mg-field__hint">Our team replies by email. Up to 2,000 characters.</span>
          </label>
        </form>
      </Modal>
    );
  }
  const sign = SIGN[cur] || cur;
  return (
    <Modal title="Tell us you've paid" subtitle={invoice ? `Invoice ${invoice.invoice_no} · outstanding ${exact(invoice.outstanding, cur)}` : 'One payment that covers several invoices'} onClose={close}
      footer={<Foot formId="portal-answer" busy={busy} blocked={!ids.length || mixed} label="Send" onClose={onClose} />}>
      <form id="portal-answer" className="cl-dlg" onSubmit={go} noValidate>
        {errBanner("Your payment wasn't sent")}
        {!invoice && (
          <fieldset className="cl-picks">
            <legend className="mg-field__label">Which invoices this payment covers</legend>
            {invoices.map((i) => (
              <label key={i.id} className={`mg-check cl-pick${ids.includes(i.id) ? ' is-on' : ''}`}>
                <input type="checkbox" checked={ids.includes(i.id)} disabled={busy} onChange={(e) => { setAmount(null); setIds(e.target.checked ? [...ids, i.id] : ids.filter((x) => x !== i.id)); }} />
                <span><strong>Invoice {i.invoice_no}</strong><span className="cl-meta">PO {i.po_number} · outstanding {exact(i.outstanding, i.currency)}</span></span>
              </label>
            ))}
          </fieldset>
        )}
        {mixed && <Banner tone="mg-banner--wait" role="alert" title="Pick invoices in one currency">One payment can't cover {andList(curs.map(curWord))}. Tell us about each payment separately.</Banner>}
        <div className="mg-grid2">
          <label className={`mg-field${fe.amount ? ' is-error' : ''}`}>
            <span className="mg-field__label">Amount paid<span className="req" aria-hidden="true">*</span></span>
            <span className="mg-affix"><span>{sign}</span><input className="mg-input mg-input--money" type="number" min="0.01" step="0.01" required readOnly={busy} value={amount ?? (due || '')} onChange={(e) => setAmount(e.target.value)} /></span>
            {fe.amount && <span className="mg-field__error">{fe.amount}</span>}
          </label>
          <label className={`mg-field${fe.tds_amount ? ' is-error' : ''}`}>
            <span className="mg-field__label">TDS deducted</span>
            <span className="mg-affix"><span>{sign}</span><input className="mg-input mg-input--money" type="number" min="0" step="0.01" readOnly={busy} value={tds} onChange={(e) => setTds(e.target.value)} placeholder="0" /></span>
            {fe.tds_amount && <span className="mg-field__error">{fe.tds_amount}</span>}
          </label>
          <label className={`mg-field${fe.paid_on ? ' is-error' : ''}`}>
            <span className="mg-field__label">Paid on<span className="req" aria-hidden="true">*</span></span>
            <input className="mg-input" type="date" required value={paidOn} max={localToday()} readOnly={busy} onChange={(e) => setPaidOn(e.target.value)} />
            {fe.paid_on && <span className="mg-field__error">{fe.paid_on}</span>}
          </label>
          <label className={`mg-field${fe.reference ? ' is-error' : ''}`}>
            <span className="mg-field__label">Reference</span>
            <input className="mg-input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} readOnly={busy} placeholder="UTR or cheque number" />
            {fe.reference && <span className="mg-field__error">{fe.reference}</span>}
          </label>
        </div>
        <FileZone id="portal-remittance" label="Remittance advice (optional)" accept="application/pdf,image/png,image/jpeg,image/webp" hint="PDF, PNG, JPEG or WebP"
          file={chosen} onFile={setChosen} error={fe.file} disabled={busy} />
        <p className="cl-small">
          {picked.length ? `Outstanding on ${picked.length === 1 ? 'this invoice' : 'these invoices'}: ${mixed ? curs.map((c) => exact(sumOf(picked.filter((i) => (i.currency || 'INR') === c), 'outstanding'), c)).join(' and ') : exact(due, cur)}.` : 'Pick at least one invoice.'} Our finance team checks the payment, then updates the invoice.
        </p>
      </form>
    </Modal>
  );
}

const ASKED = { confirmed: 'Confirmed', query: 'Query', payment_advice: 'Payment reported' };
const WHERE = {
  confirmed: { resolved: ['Confirmed', 'ok'] },
  query: { open: ['Open', 'wait'], resolved: ['Resolved', 'ok'], rejected: ['Answered', 'info'] },
  payment_advice: { open: ['Being checked', 'info'], matched: ['Payment recorded', 'ok'], rejected: ['Not matched', 'late'] },
};

/** Everything the client has told us, newest first, with our reply. Amounts in their invoices' own currency. */
function Requests({ version, invoices }) {
  const s = useData('/actions', { load: call }, version);
  if (!s.data?.length) return null;
  return (
    <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="req-h">
      <div className="mg-panel__head" style={{ flexWrap: 'wrap' }}><h2 className="mg-panel__title" id="req-h">Your requests</h2><span className="mg-panel__hint">Confirmations, queries and payments you told us about, newest first</span></div>
      <ul className="mg-timeline">
        {s.data.map((a) => {
          const [badge, tone] = WHERE[a.kind]?.[a.status] || [a.status, ''];
          const c = CUR_OF(invoices, a);
          return (
            <li key={a.id}>
              <span className={`mg-timeline__dot${tone ? ` mg-timeline__dot--${tone}` : ''}`} aria-hidden="true" />
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span className="mg-timeline__what">{ASKED[a.kind]}{a.invoices.length ? ` · invoice ${a.invoices.map((i) => i.invoice_no).join(', ')}` : a.po_number ? ` · PO ${a.po_number}` : ''}</span>
                <span className="mg-timeline__meta">
                  Sent {when(a.created_at)}
                  {a.kind === 'payment_advice' ? ` · ${exact(a.amount, c)}${Number(a.tds_amount) > 0 ? ` + TDS ${exact(a.tds_amount, c)}` : ''} paid on ${day(a.paid_on)}${a.reference ? ` · ref ${a.reference}` : ''}` : ''}
                </span>
                {a.note && <span style={{ fontSize: 13, color: 'var(--text2)', overflowWrap: 'anywhere' }}>{a.note}</span>}
                {a.resolution && <span style={{ fontSize: 13 }}><strong>Our reply:</strong> {a.resolution}</span>}
              </div>
              <span><span className={`mg-badge${tone ? ` mg-badge--${tone}` : ''}`}>{badge}</span></span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------ certificates and contact */

function Certificates({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/certificates', ctx, version);
  const ref = useEnter(s.data ? 'certificates' : null);
  if (!s.data) return <Pending s={s} ctx={ctx} what={WHAT.certificates} retry={() => setVersion((n) => n + 1)} />;
  if (!s.data.length) return <Empty ctx={ctx} icon={Award} title="No certificates on record yet">Certificates we issue to {ctx.company} show here with their validity and a copy to download.</Empty>;
  const today = new Date(`${localToday()}T00:00:00`);
  return (
    <div className="cl-grid" ref={ref}>
      {s.data.map((c) => {
        const expired = c.status === 'expired' || (c.days_left != null && c.days_left < 0);
        const soon = !expired && c.days_left != null && c.days_left <= 90;
        const [tone, badge] = expired ? ['late', 'Expired'] : soon ? ['wait', `Expires in ${plural(c.days_left, 'day')}`] : ['ok', 'Valid'];
        const from = c.valid_from || c.issued_on;
        const span = from && c.valid_until ? new Date(`${String(c.valid_until).slice(0, 10)}T00:00:00`) - new Date(`${String(from).slice(0, 10)}T00:00:00`) : 0;
        const used = expired ? 100 : span > 0 ? Math.round(pct(today - new Date(`${String(from).slice(0, 10)}T00:00:00`), span)) : null;
        return (
          <article key={c.id} className={ctx.card} data-a="rise" aria-label={c.title}>
            <div className="cl-cert__top">
              <span className={`cl-ico cl-ico--lg cl-ico--${tone}`} aria-hidden="true"><Award strokeWidth={1.8} /></span>
              <div><h2 className="mg-panel__title" style={{ fontSize: 16, overflowWrap: 'anywhere' }}>{c.title}</h2><span><span className={`mg-badge mg-badge--${tone}`}>{badge}</span></span></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span className="cl-meta">{[c.reference, c.issuing_body, c.service_name].filter(Boolean).join(' · ')}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Valid {day(from)} to {day(c.valid_until)}{c.renewal_due ? ` · renewal due ${day(c.renewal_due)}` : ''}</span>
              {used != null && <div className="mg-progress cl-progress-thin" role="img" aria-label={`${used}% of the validity used`}><span className={`mg-progress__done is-${tone}`} style={{ width: `${used}%` }} /></div>}
            </div>
            {c.scope && <p style={{ margin: 0, fontSize: 13, color: 'var(--text2)' }}><strong style={{ color: 'var(--text)' }}>Scope:</strong> {c.scope}</p>}
            {c.document_id && (
              <div style={{ marginTop: 'auto' }}>
                {ctx.preview ? <span className="cl-fname" title="Opens in the client's portal">Certificate file</span>
                  : <a className="mg-btn mg-btn--sm" href={`${BASE}/files/document/${c.document_id}`} aria-label={`Download ${c.title}`}><Download strokeWidth={1.8} aria-hidden="true" />Download</a>}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function Contact({ ctx }) {
  if (ctx.preview) {
    return (
      <div className="cl-grid cl-grid--contact">
        <section className={ctx.card} aria-labelledby="write-h">
          <h2 className="mg-panel__title" id="write-h">Write to us</h2>
          <p className="cl-small" style={{ fontSize: 13 }}>Contacts see a form with Subject and Message here. What they send lands in the shared inbox as a thread on this company.</p>
        </section>
        <section className={ctx.card} aria-labelledby="earlier-h">
          <h2 className="mg-panel__title" id="earlier-h">Earlier messages</h2>
          <p className="cl-small" style={{ fontSize: 13 }}>Their portal messages and our replies are listed here for them, newest first. The threads are in the shared inbox.</p>
        </section>
      </div>
    );
  }
  return <ContactForm ctx={ctx} />;
}

function ContactForm({ ctx }) {
  const [version, setVersion] = useState(0);
  const s = useData('/messages', ctx, version);
  const [v, setV] = useState({ subject: '', body: '' });
  const [state, setState] = useState({});
  const ref = useEnter('contact');
  async function go(e) {
    e.preventDefault(); if (state.busy) return;
    setState({ busy: true });
    try { const r = await call('/messages', v); setState({ done: r.message }); setV({ subject: '', body: '' }); setVersion((n) => n + 1); }
    catch (ex) { setState({ fields: ex.fields || {}, error: ex.fields ? null : ex.message }); }
  }
  const fe = state.fields || {};
  const failed = state.error || fe.subject || fe.body;
  return (
    <div className="cl-grid cl-grid--contact" ref={ref}>
      <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="write-h">
        <div><h2 className="mg-panel__title" id="write-h">Write to us</h2><span className="mg-panel__hint">Our team replies by email.</span></div>
        {state.done && <Banner tone="mg-banner--ok" icon={CircleCheckBig} title="Message sent">{state.done.replace(/^Thank you\.\s*/, 'Thank you. ')}</Banner>}
        {failed && <Banner tone="mg-banner--late" role="alert" title="Your message wasn't sent">{state.error || 'Fill in what is marked, then send it again.'}</Banner>}
        <form onSubmit={go} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className={`mg-field${fe.subject ? ' is-error' : ''}`}>
            <span className="mg-field__label">Subject<span className="req" aria-hidden="true">*</span></span>
            <input className="mg-input" required value={v.subject} readOnly={!!state.busy} placeholder="What it is about" onChange={(e) => setV({ ...v, subject: e.target.value })} />
            {fe.subject && <span className="mg-field__error">{fe.subject}</span>}
          </label>
          <label className={`mg-field${fe.body ? ' is-error' : ''}`}>
            <span className="mg-field__label">Message<span className="req" aria-hidden="true">*</span></span>
            <textarea className="mg-textarea" rows={5} required value={v.body} readOnly={!!state.busy} placeholder="Tell us what you need" onChange={(e) => setV({ ...v, body: e.target.value })} />
            {fe.body && <span className="mg-field__error">{fe.body}</span>}
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className={`mg-btn mg-btn--primary${state.busy ? ' is-loading' : ''}`} aria-busy={!!state.busy} disabled={!!state.busy}><Send strokeWidth={1.8} aria-hidden="true" />{state.busy ? 'Sending…' : 'Send'}</button>
          </div>
        </form>
      </section>
      <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="earlier-h">
        <div><h2 className="mg-panel__title" id="earlier-h">Earlier messages</h2><span className="mg-panel__hint">Between {ctx.company} and our team, newest first</span></div>
        {s.error && !s.data ? <p className="cl-small" role="alert" style={{ fontSize: 13 }}>Couldn't load earlier messages. <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => setVersion((n) => n + 1)}>Try again</button></p>
          : s.loading ? <div className="mg-skel" style={{ height: 56 }} aria-busy="true" />
          : s.data.length ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {s.data.map((m) => {
                const you = m.direction === 'inbound';
                return (
                  <div key={m.id} className="cl-rowline cl-rowline--top">
                    <span className={`mg-avatar${you ? '' : ' cl-msg-us'}`} aria-hidden="true">{you ? initials(ctx.contact) : 'CV'}</span>
                    <div className="cl-rowline__body">
                      <span style={{ fontSize: 12.5 }}><strong>{you ? 'You' : PROVIDER}</strong> <span className="cl-meta">· {whenTime(m.sent_at)}</span></span>
                      <span style={{ fontSize: 13, color: 'var(--text2)', overflowWrap: 'anywhere' }}>{m.snippet}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : <p className="cl-small" style={{ fontSize: 13 }}>No messages yet. What you send here and our replies will show in this list.</p>}
      </section>
    </div>
  );
}
