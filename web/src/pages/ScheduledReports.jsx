import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CircleAlert, Clock, ExternalLink, Eye, FileText, Info, Lock, Mail, RefreshCw, Send, TriangleAlert, X } from 'lucide-react';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { useEntrance } from '../components/daily.jsx';
import { PageHeader } from '../App.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch, useMediaQuery } from '../lib/hooks.js';
import { ago, date } from '../lib/format.js';
import { recipientLists } from '../lib/addresses.js';
import PersonalMisCard from '../components/PersonalMisPreview.jsx';

/**
 * Reports → Scheduled reports (docs/mis-reports-plan.md §5): the Daily Sales
 * Briefing and the Weekly Sales MIS the tracker builds from its own records
 * and emails from the chosen sender with the PDF attached.
 *
 * Two cards, one per report: the on/off switch, a preview of the figures
 * and the email as of any date, the PDF, and Send now. Below them the
 * settings both share (recipients, the Overdue threshold and the sender,
 * mis-report-sender-plan.md §A2, saved together), Finance's debtors list,
 * and the run history with each PDF and Resend. Admin only; the routes are
 * behind requireAdmin on the server, and anybody else is told so.
 */

const KINDS = [
  { kind: 'daily_briefing', settingKey: 'mis_daily_enabled', title: 'Daily Sales Briefing', when: 'Every day at 08:56 IST, for the previous day', what: 'What happened yesterday, the pending invoices, POs and quotations with Overdue marked, and the top five actions for today.' },
  { kind: 'weekly_mis', settingKey: 'mis_weekly_enabled', title: 'Weekly Sales MIS Report', when: 'Every Monday at 08:54 IST, for the previous Monday to Sunday', what: 'The eight management questions: enquiries per day with first-response times, outcomes, sector-wise and service-wise sales, customers, invoiced and received, receivables over 90 days, pending follow-ups, conversion and speed.' },
];
const TITLE = { ...Object.fromEntries(KINDS.map((k) => [k.kind, k.title])), personal_daily: 'Daily MIS' };

const setting = (list, key) => (list ?? []).find((s) => s.key === key)?.value ?? '';
// A text setting saved as "none" (a setting cannot be blank) reads as empty.
const optional = (list, key) => { const v = setting(list, key).trim(); return v.toLowerCase() === 'none' ? '' : v; };
/** How a run or a send went, in a few words: "from mis@x via sales@x", "by SMTP from tracker@x". */
const howSent = (r) => {
  if (r.sent_via === 'graph') return `from ${r.sent_from || 'the mailbox'}${r.sent_through_email && r.sent_through_email !== r.sent_from ? ` via ${r.sent_through_email}` : ''}`;
  if (r.sent_via === 'smtp') return `by SMTP${r.sent_from ? ` from ${r.sent_from}` : ''}`;
  return r.sent_via || '';
};
// To and Cc as the server sends them: each address once, nobody copied who is already in To (#195).
const recipientsIn = (list) => recipientLists(setting(list, 'mis_to'), setting(list, 'mis_cc'));
const errText = (err) => (err.fields ? Object.values(err.fields)[0] : err.message);

function Icon({ as: I, size = 16 }) {
  return <I className="shrink-0" style={{ width: size, height: size }} strokeWidth={1.8} aria-hidden="true" />;
}

function ReportCard({ kind, settingKey, title, when, what, settings, onChanged }) {
  const toast = useToast();
  const enabled = setting(settings, settingKey) === 'true';
  // "As of": the report is run as if this were today, so a past period can
  // be looked at, or sent again. Blank means today.
  const [asOf, setAsOf] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [sending, setSending] = useState(false);
  const q = asOf ? `?date=${asOf}` : '';
  const people = recipientsIn(settings);
  const nobody = !people.to.length;
  const id = `rep-${kind}`;

  async function act(what, fn, ok) {
    setBusy(what);
    try { const r = await fn(); if (ok) { const [msg, tone] = ok(r); toast(msg, tone); } onChanged(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }
  const load = () => act('preview', async () => { const r = await api.raw(`/mis-reports/${kind}/preview${q}`); setPreview(r.data); });
  const toggle = () => act('switch', () => api.update('settings', settingKey, { value: enabled ? 'false' : 'true' }), () => [enabled ? `${title} switched off` : `${title} switched on`, 'success']);
  const send = () => act('send', () => api.action(`/mis-reports/${kind}/send`, asOf ? { date: asOf } : {}), (r) => {
    const run = r.data;
    if (run.status !== 'sent') return [`Not sent: ${run.error}`, 'danger'];
    return run.sent_via === 'log'
      ? [`Logged only (${run.suppressed || 'delivery is off'}); nothing left the server`, 'info']
      : [`Sent to ${run.recipients.join(', ')} ${howSent(run)}${run.error ? ` (${run.error})` : ''}`, 'success'];
  });

  return (
    <section className="mg-glass mg-panel rp-card" data-a="rise" aria-labelledby={id}>
      <div className="mg-panel__head">
        <h2 className="mg-panel__title" id={id}>{title}</h2>
        <span className={`mg-badge ${enabled ? 'mg-badge--ok' : ''}`}>{enabled ? 'On' : 'Off'}</span>
        <label className="mg-switch" style={{ marginLeft: 'auto' }}>
          <input type="checkbox" role="switch" aria-label={`Send the ${title} on schedule`} checked={enabled} disabled={busy === 'switch'} onChange={toggle} />
          <span className="rp-ctl">Sends on schedule</span>
        </label>
      </div>
      <div className="rp-when"><Icon as={Clock} />{when}</div>
      <p className="rp-what">{what}</p>
      <label className="mg-field">
        <span className="mg-field__label">As of</span>
        <input className="mg-input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        <span className="mg-field__hint">Leave blank for today. Pick a date to run it as if it were that day.</span>
      </label>
      <div className="rp-btnrow">
        <button type="button" className="mg-btn mg-btn--sm" disabled={busy === 'preview'} onClick={load}>
          <Icon as={Eye} />{busy === 'preview' ? 'Building…' : 'Preview figures and email'}
        </button>
        <a className="mg-btn mg-btn--ghost mg-btn--sm" href={`/api/mis-reports/${kind}/preview.pdf${q}`} target="_blank" rel="noreferrer"><Icon as={ExternalLink} />Open the PDF</a>
        <button type="button" className="mg-btn mg-btn--primary mg-btn--sm rp-end" disabled={busy === 'send' || nobody} aria-describedby={nobody ? `${id}-why` : undefined} onClick={() => setSending(true)}>
          <Icon as={Send} />{busy === 'send' ? 'Sending…' : 'Send now'}
        </button>
      </div>
      {nobody && <p className="rp-note" id={`${id}-why`} style={{ textAlign: 'right', marginTop: -6 }}>Set the recipients below before sending.</p>}
      {preview && (
        <div className="rp-preview" role="region" aria-label={`Preview of the ${title}`}>
          <div className="rp-preview__meta">
            <span className="mg-badge mg-badge--info">Preview</span>
            <span>Period {date(preview.period.from)}{preview.period.to !== preview.period.from ? ` – ${date(preview.period.to)}` : ''}</span>
            <span><FileText className="mr-1 inline size-3.5 align-[-2px]" strokeWidth={1.8} aria-hidden="true" />{preview.file_name}</span>
            <span>to: {preview.settings.to.length ? preview.settings.to.join(', ') : <em>nobody yet — set the recipients below</em>}</span>
            <button type="button" className="mg-iconbtn" aria-label="Close the preview" onClick={() => setPreview(null)} style={{ marginLeft: 'auto', width: 36, height: 36 }}><X className="size-4" strokeWidth={1.8} aria-hidden="true" /></button>
          </div>
          <strong style={{ fontSize: 14 }}>{preview.email.subject}</strong>
          <pre className="rp-pre"><span>{preview.email.text}</span></pre>
        </div>
      )}
      {sending && (
        <ConfirmDialog
          tone="normal"
          title={`Send the ${title} now?`}
          message={`It goes to ${people.to.join(', ') || 'nobody — set the recipients first'}${people.cc.length ? `, copying ${people.cc.join(', ')}` : ''}, with the PDF attached, for ${asOf ? `the period as of ${date(asOf)}` : kind === 'daily_briefing' ? 'yesterday' : 'last week'}. A period already sent is sent again.`}
          confirmLabel="Send"
          busyLabel="Sending…"
          busy={busy === 'send'}
          onClose={() => setSending(false)}
          onConfirm={() => { setSending(false); send(); }}
        />
      )}
    </section>
  );
}

const STATE = { active: '', needs_reconnect: ' — needs reconnecting', disconnected: ' — disconnected', missing: ' — no longer connected' };

/**
 * Who both reports go to and from, saved with one Save: To, Cc, the Overdue
 * threshold, the mailbox they go through (mis-report-sender-plan.md §A2), an
 * optional Send As address and display name. A line says what the next
 * report will go from, and a test goes to the admin's own address. Edits
 * not yet saved stay put while something else on the page is saved.
 */
function RecipientsCard({ settings, mailboxes, onChanged }) {
  const toast = useToast();
  const described = useFetch(() => api.raw('/mis-reports/sender'), []);
  const info = described.data?.data;
  const savedSender = setting(settings, 'mis_sender_account_id');
  const initial = () => ({
    to: recipientsIn(settings).to.join(', '),
    cc: recipientsIn(settings).cc.join(', '),
    overdue: setting(settings, 'mis_overdue_days') || '7',
    // A non-numeric value ('none', blank) is the SMTP sender.
    sender: /^\d+$/.test(savedSender) ? savedSender : 'smtp',
    sendAs: optional(settings, 'mis_sender_address'),
    name: optional(settings, 'mis_sender_name'),
  });
  const [saved, setSaved] = useState(initial);
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(null);
  const [test, setTest] = useState(null);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const dirty = Object.keys(v).some((k) => v[k] !== saved[k]);

  // Shared mailboxes, and personal ones whose owner allowed it (§A3). One
  // that needs reconnecting stays listed, marked, so the saved choice never
  // shows blank.
  const live = (mailboxes ?? []).filter((m) => m.status !== 'disconnected');
  const shared = live.filter((m) => m.is_shared);
  const personal = live.filter((m) => !m.is_shared && m.may_send_reports);
  const listed = new Set([...shared, ...personal].map((m) => String(m.id)));
  const orphan = v.sender !== 'smtp' && !listed.has(v.sender) ? (info?.through ?? { id: Number(v.sender), email: `Mailbox ${v.sender}`, status: 'missing' }) : null;
  const label = (m) => `${m.email || `Mailbox ${m.id}`}${STATE[m.status] ?? ` — ${m.status}`}`;

  async function save() {
    setBusy('save');
    const put = (key, value) => api.update('settings', key, { value: value.trim() || 'none' });
    try {
      // Saved cleaned (#195): each address once, and Cc without anybody already in To.
      const clean = recipientLists(v.to, v.cc);
      const overdue = String(Math.min(90, Math.max(1, Number(v.overdue) || 7)));
      await put('mis_to', clean.to.join(', '));
      await put('mis_cc', clean.cc.join(', '));
      await put('mis_overdue_days', overdue);
      await put('mis_sender_account_id', v.sender === 'smtp' ? '' : v.sender);
      await put('mis_sender_address', v.sendAs);
      await put('mis_sender_name', v.name);
      const next = { ...v, to: clean.to.join(', '), cc: clean.cc.join(', '), overdue };
      setV(next); setSaved(next);
      toast('Recipients and sender saved', 'success'); onChanged(); described.refetch();
    } catch (err) { toast(errText(err), 'danger'); }
    finally { setBusy(null); }
  }
  async function sendTest() {
    setBusy('test'); setTest(null);
    try { setTest((await api.action('/mis-reports/sender/test', {})).data); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }

  const from = info ? `${info.name ? `${info.name} <${info.from}>` : info.from}` : null;
  return (
    <section className="mg-glass mg-panel rp-card" data-a="rise" aria-labelledby="rcp-t">
      <div className="mg-panel__head"><h2 className="mg-panel__title" id="rcp-t">Recipients and sender</h2></div>
      <p className="rp-what">Both reports go to the same people, from the mailbox chosen here, so they land in its Sent Items. If that mailbox cannot send, the report goes by the server's SMTP sender instead and admins are told.</p>
      <div className="rp-form">
        <label className="mg-field rp-span">
          <span className="mg-field__label">To</span>
          <input className="mg-input" value={v.to} onChange={set('to')} placeholder="md@company.com, sales-head@company.com" />
          <span className="mg-field__hint">Comma-separated. Each address is kept once.</span>
        </label>
        <label className="mg-field rp-span">
          <span className="mg-field__label">Cc</span>
          <input className="mg-input" value={v.cc} onChange={set('cc')} />
          <span className="mg-field__hint">Comma-separated, or blank. Anyone already in To is left out.</span>
        </label>
        <label className="mg-field">
          <span className="mg-field__label">Mark Overdue after</span>
          <span className="rp-days"><input className="mg-input" type="number" min="1" max="90" value={v.overdue} onChange={set('overdue')} /><span className="rp-ctl">days</span></span>
          <span className="mg-field__hint">How long a pending item has waited, 1 to 90.</span>
        </label>
        <label className="mg-field">
          <span className="mg-field__label">Send from</span>
          <span className="mg-select-wrap">
            <select className="mg-select" value={v.sender} onChange={set('sender')}>
              <option value="smtp">The server's SMTP sender</option>
              {orphan && <option value={String(orphan.id)}>{label(orphan)}</option>}
              {shared.map((m) => <option key={m.id} value={String(m.id)}>{label(m)} · shared</option>)}
              {personal.map((m) => <option key={m.id} value={String(m.id)}>{label(m)} · {m.owner?.name || 'personal'}</option>)}
            </select>
          </span>
          <span className="mg-field__hint">A shared mailbox, or a personal one whose owner allowed it.</span>
        </label>
        <label className="mg-field">
          <span className="mg-field__label">Send as</span>
          <input className="mg-input" value={v.sendAs} onChange={set('sendAs')} placeholder="mis@company.com" />
          <span className="mg-field__hint">Optional. Needs Send As on it in Microsoft 365.</span>
        </label>
        <label className="mg-field">
          <span className="mg-field__label">Display name</span>
          <input className="mg-input" value={v.name} onChange={set('name')} placeholder="Cetizion MIS" />
          <span className="mg-field__hint">Optional. The name beside the address.</span>
        </label>
      </div>
      {info && (info.problem ? (
        <div className="mg-banner mg-banner--late" role="status">
          <TriangleAlert aria-hidden="true" />
          <div className="mg-banner__body">
            <strong>{info.problem}.</strong>
            Until it is fixed, the reports go {info.smtp_configured ? <>by SMTP from <strong>{info.smtp_from}</strong></> : <>nowhere: no SMTP sender is set up on the server</>}.
            {info.through?.status === 'needs_reconnect' && <> <Link className="rp-link" to="/settings/mailboxes">Reconnect it</Link>.</>}
          </div>
        </div>
      ) : (
        <p className="rp-note" style={{ fontSize: 12.5, color: 'var(--text2)' }}>
          The next report goes {info.via === 'mailbox'
            ? <>from <strong>{from}</strong>{info.through?.email && info.from !== info.through.email ? <> through {info.through.email}</> : null}</>
            : info.from ? <>by SMTP from <strong>{from}</strong>{info.send_as && info.send_as !== info.from ? <> (the SMTP sender cannot send as {info.send_as})</> : null}</> : <>nowhere: no SMTP sender is set up on the server</>}
          {dirty ? ', as last saved.' : '.'}
        </p>
      ))}
      <div className="rp-saverow">
        {dirty && <><span className="mg-badge mg-badge--wait">Unsaved changes</span><span className="rp-note">Kept until you save, even when something else on this page is saved.</span></>}
        <button type="button" className="mg-btn mg-btn--sm" disabled={busy === 'test'} onClick={sendTest}><Icon as={Mail} />{busy === 'test' ? 'Sending…' : 'Send a test to me'}</button>
        <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" disabled={busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
      {test && (
        <p className={`rp-note ${test.status === 'sent' ? 'text-ok' : test.status === 'failed' ? 'is-late-text' : ''}`} role="status" style={{ fontSize: 12.5 }}>
          {test.status === 'sent'
            ? `Sent to ${test.to} ${test.via === 'graph' ? `from ${test.from}` : `by SMTP from ${test.from}`}.${test.error ? ` The mailbox could not send: ${test.error}` : ''}`
            : test.status === 'failed' ? `Not sent: ${test.error}` : `Logged only (${test.suppressed || 'delivery is off'}); nothing left the server.`}
        </p>
      )}
    </section>
  );
}

/** What finds Finance's Sundry Debtors list in the shared mailboxes (docs/mis-briefing-fix-plan.md §3a). */
function DebtorsList({ settings, onChanged }) {
  const toast = useToast();
  const [phrases, setPhrases] = useState(setting(settings, 'receivables_list_phrases') || 'sundry debtors,debtors,outstanding,receivable');
  const saved = setting(settings, 'receivables_list_senders');
  const [senders, setSenders] = useState(saved && saved !== 'none' ? saved : '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      // A setting cannot be saved blank: no senders is "none", anyone at our own domains.
      await api.update('settings', 'receivables_list_phrases', { value: phrases.trim() || 'sundry debtors' });
      await api.update('settings', 'receivables_list_senders', { value: senders.trim() || 'none' });
      toast('Debtors list settings saved', 'success'); onChanged();
    } catch (err) { toast(errText(err), 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <section className="mg-glass mg-panel rp-card" data-a="rise" aria-labelledby="debt-t">
      <div className="mg-panel__head"><h2 className="mg-panel__title" id="debt-t">Finance's debtors list</h2></div>
      <p className="rp-what">The daily briefing reconciles the receivables with the newest Sundry Debtors list Finance emailed to a shared mailbox in the last 14 days, as an Excel file or a PDF. Each list is read once. One whose rows do not add up to its grand total is not used, and the briefing says so.</p>
      <label className="mg-field">
        <span className="mg-field__label">Subject or file name has</span>
        <input className="mg-input" value={phrases} onChange={(e) => setPhrases(e.target.value)} />
        <span className="mg-field__hint">Any of these words, comma-separated</span>
      </label>
      <label className="mg-field">
        <span className="mg-field__label">Sent by</span>
        <input className="mg-input" value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="accounts@company.com" />
        <span className="mg-field__hint">Comma-separated, or blank for anyone at our own email domains</span>
      </label>
      <div className="rp-saverow"><button type="button" className="mg-btn mg-btn--primary mg-btn--sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
    </section>
  );
}

function RunStatus({ r }) {
  if (r.status === 'sent') return <span className="mg-badge mg-badge--ok">sent · {howSent(r)}</span>;
  if (r.status === 'failed') return <span className="mg-badge mg-badge--late">failed</span>;
  if (r.sent_via === 'log') return <span className="mg-badge mg-badge--wait">logged only</span>;
  return <span className="mg-badge">{r.status}</span>;
}

function Runs({ runs, loading, error, onRetry, onChanged }) {
  const toast = useToast();
  const wide = useMediaQuery('(min-width: 768px)');
  const [resending, setResending] = useState(null);
  const [busy, setBusy] = useState(false);
  async function resend(run) {
    setBusy(true);
    try {
      // The period is the run's; "as of" the day after it ended rebuilds exactly that period.
      const next = new Date(`${String(run.period_to).slice(0, 10)}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      const path = run.kind === 'personal_daily' ? `/mis-reports/personal/${run.user_id}/send` : `/mis-reports/${run.kind}/send`;
      const r = await api.action(path, { date: next.toISOString().slice(0, 10) });
      toast(r.data.status === 'sent' ? `Sent again to ${r.data.recipients.join(', ')}` : `Not sent: ${r.data.error}`, r.data.status === 'sent' ? 'success' : 'danger');
      onChanged();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); setResending(null); }
  }
  const period = (r) => (r.period_from === r.period_to ? date(r.period_from) : `${date(r.period_from)} – ${date(r.period_to)}`);
  const name = (r) => (r.person ? `${TITLE[r.kind]} · ${r.person}` : TITLE[r.kind]);
  const note = (r) => r.error || (r.kind === 'personal_daily' ? 'Written by AI' : r.ai_used ? 'With AI commentary' : '');
  const canResend = (r) => r.kind !== 'personal_daily' || r.user_id;
  const actions = (r, big) => (
    <>
      {r.document_id && <a className="mg-btn mg-btn--ghost mg-btn--sm" style={big ? { flex: 1 } : undefined} href={`/api/mis-reports/runs/${r.id}/pdf`} target="_blank" rel="noreferrer" aria-label={`Open the PDF of the ${name(r)} for ${period(r)}`}>PDF</a>}
      {canResend(r) && <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" style={big ? { flex: 1 } : undefined} onClick={() => setResending(r)} aria-label={`Resend the ${name(r)} for ${period(r)}`}>Resend</button>}
    </>
  );

  return (
    <section className="mg-glass mg-panel rp-card rp-runs rp-full" data-a="rise" aria-labelledby="runs-t" style={{ paddingBottom: runs.length && wide ? 0 : undefined }}>
      <div className="mg-panel__head"><h2 className="mg-panel__title" id="runs-t">Sent so far</h2><span className="mg-panel__hint">Newest first. Resend rebuilds a report from the records as they are now.</span></div>
      {error ? (
        <div className="mg-banner mg-banner--late" role="alert"><CircleAlert aria-hidden="true" /><div className="mg-banner__body"><strong>Couldn't load what was sent</strong>{error}</div><button type="button" className="mg-btn mg-btn--sm" onClick={onRetry}>Try again</button></div>
      ) : loading && !runs.length ? (
        [0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)
      ) : !runs.length ? (
        <div className="mg-empty" style={{ padding: '28px 24px 34px' }}>
          <span className="mg-empty__mark"><Mail className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h3 className="mg-empty__title">Nothing has been sent yet</h3>
          <p className="mg-empty__text">The first Daily Sales Briefing goes out at 08:56 IST, once someone is in To.</p>
        </div>
      ) : wide ? (
        <div className="mg-tablewrap" style={{ margin: '0 -24px', borderRadius: '0 0 26px 26px' }}>
          <table className="mg-table">
            <caption className="sr-only">Reports sent so far</caption>
            <thead><tr><th scope="col" style={{ paddingLeft: 24 }}>Report</th><th scope="col">Status</th><th scope="col">To</th><th scope="col">When</th><th scope="col">Note</th><th scope="col" aria-label="Actions" /></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="strong" style={{ paddingLeft: 24 }}>{name(r)}<span className="sub">for {period(r)}</span></td>
                  <td><RunStatus r={r} /></td>
                  <td className="rp-wrap">{(r.recipients || []).join(', ') || '—'}</td>
                  <td className="mg-num" style={{ color: 'var(--text2)' }}>{ago(r.created_at)} · {r.triggered_by}</td>
                  <td className="rp-wrap">{note(r)}</td>
                  <td style={{ paddingRight: 16 }}><span className="flex justify-end gap-1">{actions(r)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mg-rows">
          {runs.map((r) => (
            <div key={r.id} className="mg-row">
              <span className="mg-row__title">{name(r)}</span>
              <span className="mg-row__state"><RunStatus r={r} /></span>
              <span className="mg-row__meta" style={{ gridColumn: '1 / -1' }}>
                for {period(r)} · {ago(r.created_at)} · {r.triggered_by}{(r.recipients || []).length ? ` · to ${r.recipients.join(', ')}` : ''}
                {note(r) && <><br />{note(r)}</>}
              </span>
              <span style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, marginTop: 8 }}>{actions(r, true)}</span>
            </div>
          ))}
        </div>
      )}
      {resending && (
        <ConfirmDialog
          tone="normal"
          title={`Send the ${TITLE[resending.kind]}${resending.person ? ` for ${resending.person}` : ''} for ${period(resending)} again?`}
          message="It is rebuilt from the records as they are now, so figures may differ from the first send, and goes to the current recipients."
          confirmLabel="Resend"
          busyLabel="Sending…"
          busy={busy}
          onClose={() => setResending(null)}
          onConfirm={() => resend(resending)}
        />
      )}
    </section>
  );
}

export default function ScheduledReports() {
  const { isAdmin } = useAuth();
  return (
    <>
      <PageHeader
        eyebrow="Reports"
        title="Scheduled reports"
        subtitle="The Daily Sales Briefing and the Weekly Sales MIS, built from the tracker's records and emailed from the chosen sender with the PDF attached."
        actions={<Link className="mg-btn" to="/reports"><ArrowLeft className="size-4" strokeWidth={1.8} aria-hidden="true" />Back to Reports</Link>}
      />
      {isAdmin ? <Admin /> : (
        <div className="app-page">
          <section className="mg-glass mg-empty" style={{ padding: '72px 24px' }}>
            <span className="mg-empty__mark" style={{ width: 64, height: 64 }}><Lock className="size-[26px]" strokeWidth={1.8} aria-hidden="true" /></span>
            <h2 className="mg-empty__title" style={{ fontSize: 18 }}>Scheduled reports are for admins</h2>
            <p className="mg-empty__text">Admins choose who gets the Daily Sales Briefing and the Weekly Sales MIS. Ask an admin to add you, or to change what they cover.</p>
            <Link className="mg-btn mg-btn--primary" to="/reports" style={{ marginTop: 8 }}><ArrowLeft className="size-4" strokeWidth={1.8} aria-hidden="true" />Back to Reports</Link>
          </section>
        </div>
      )}
    </>
  );
}

function Admin() {
  const settings = useFetch(() => api.raw('/settings'), []);
  const mailboxes = useFetch(() => api.raw('/mailboxes'), []);
  const runs = useFetch(() => api.raw('/mis-reports/runs'), []);
  const refetch = () => { settings.refetch(); runs.refetch(); };
  const list = settings.data?.data;
  const ref = useEntrance(Boolean(list));
  const emailsOn = setting(list, 'emails_enabled') !== 'false';

  if (settings.error && !list) {
    return (
      <div className="app-page">
        <section className="mg-glass mg-empty" role="alert" style={{ padding: '64px 24px' }}>
          <span className="mg-empty__mark" style={{ color: 'var(--late)', background: 'var(--late-soft)' }}><CircleAlert className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h2 className="mg-empty__title">Couldn't load the report settings</h2>
          <p className="mg-empty__text">{settings.error} The schedules, recipients and sent list aren't shown. Nothing was changed and the schedule still runs.</p>
          <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}><RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Try again</button>
        </section>
      </div>
    );
  }
  if (!list) {
    return (
      <div className="app-page">
        <div className="rp-grid" aria-busy="true" aria-label="Loading the report settings">
          {[0, 1, 2, 3].map((i) => (
            <section key={i} className="mg-glass mg-panel rp-card">
              <div className="mg-skel" style={{ height: 16, width: '46%' }} /><div className="mg-skel" style={{ height: 12, width: '70%' }} />
              <div className="mg-skel" style={{ height: 44 }} /><div className="mg-skel" style={{ height: 36, width: '60%' }} />
            </section>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="app-page" ref={ref}>
      {!emailsOn && (
        <div className="mg-banner mg-banner--wait mg-glass" role="note" data-a="rise">
          <TriangleAlert aria-hidden="true" />
          <div className="mg-banner__body"><strong>Automatic email is switched off</strong>A report is still composed and logged, but nothing is sent until it is switched on in Settings › Emails &amp; jobs.</div>
          <Link className="mg-btn mg-btn--sm" to="/settings/emails">Open Emails &amp; jobs</Link>
        </div>
      )}
      <div className="mg-banner mg-glass" role="note" data-a="rise">
        <Info aria-hidden="true" />
        <div className="mg-banner__body">The figures come from the same definitions as the Reports page, in ₹ at the rate on each record's date. The schedule sends each period once; Send now and Resend always send.</div>
      </div>
      <div className="rp-grid">
        {KINDS.map((k) => <ReportCard key={k.kind} {...k} settings={list} onChanged={refetch} />)}
        <RecipientsCard settings={list} mailboxes={mailboxes.data?.data} onChanged={refetch} />
        <DebtorsList settings={list} onChanged={refetch} />
        <PersonalMisCard enabled={setting(list, 'personal_mis_enabled') === 'true'} recipients={recipientsIn(list)} onChanged={refetch} />
        <Runs runs={runs.data?.data ?? []} loading={runs.loading} error={runs.error} onRetry={runs.refetch} onChanged={refetch} />
      </div>
    </div>
  );
}
