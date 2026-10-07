import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, ConfirmDialog, DataTable, Field, Input, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { PageHeader } from '../App.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ago, date } from '../lib/format.js';
import { recipientLists } from '../lib/addresses.js';

/**
 * Reports → Scheduled reports (docs/mis-reports-plan.md §5): the Daily Sales
 * Briefing and the Weekly Sales MIS the tracker builds from its own records
 * and emails from the chosen sender with the PDF attached.
 *
 * Two cards, one per report: the on/off switch, a preview of the figures
 * and the email as of any date, the PDF, and Send now. Below them the
 * settings both share (recipients, the Overdue threshold), the Sender
 * (mis-report-sender-plan.md §A2), and the run history with each PDF and
 * Resend. Admin only; the routes are behind requireAdmin on the server.
 */

const KINDS = [
  { kind: 'daily_briefing', settingKey: 'mis_daily_enabled', title: 'Daily Sales Briefing', when: 'Every day at 08:56 IST, for the previous day', what: 'What happened yesterday, the pending invoices, POs and quotations with Overdue marked, and the top five actions for today.' },
  { kind: 'weekly_mis', settingKey: 'mis_weekly_enabled', title: 'Weekly Sales MIS Report', when: 'Every Monday at 08:54 IST, for the previous Monday to Sunday', what: 'The eight management questions: enquiries per day with first-response times, outcomes, sector-wise and service-wise sales, customers, invoiced and received, receivables over 90 days, pending follow-ups, conversion and speed.' },
];
const TITLE = Object.fromEntries(KINDS.map((k) => [k.kind, k.title]));

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

  async function act(what, fn, ok) {
    setBusy(what);
    try { const r = await fn(); if (ok) toast(ok(r), 'success'); onChanged(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }
  const load = () => act('preview', async () => { const r = await api.raw(`/mis-reports/${kind}/preview${q}`); setPreview(r.data); });
  const toggle = () => act('switch', () => api.update('settings', settingKey, { value: enabled ? 'false' : 'true' }), () => (enabled ? `${title} switched off` : `${title} switched on`));
  const send = () => act('send', () => api.action(`/mis-reports/${kind}/send`, asOf ? { date: asOf } : {}), (r) => {
    const run = r.data;
    if (run.status !== 'sent') return `Not sent: ${run.error}`;
    return run.sent_via === 'log' ? `Logged only (${run.suppressed || 'delivery is off'}); nothing left the server` : `Sent to ${run.recipients.join(', ')} ${howSent(run)}${run.error ? ` (${run.error})` : ''}`;
  });

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            {title}
            <Chip tone={enabled ? 'settled' : undefined}>{enabled ? 'On' : 'Off'}</Chip>
          </div>
          <div className="text-[12px] text-muted-foreground">{when}</div>
          <p className="mt-1 text-[12.5px]/[1.6] text-secondary-text">{what}</p>
        </div>
        <Button variant={enabled ? 'secondary' : 'default'} size="sm" className="h-8 px-4 text-[13px]" disabled={busy === 'switch'} onClick={toggle}>
          {enabled ? 'Switch off' : 'Switch on'}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="As of" hint="Run it as if this were today">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 text-[12.5px]" />
        </Field>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={busy === 'preview'} onClick={load}>{busy === 'preview' ? 'Building…' : 'Preview figures and email'}</Button>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" asChild>
          <a href={`/api/mis-reports/${kind}/preview.pdf${q}`} target="_blank" rel="noreferrer">Open the PDF</a>
        </Button>
        <Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy === 'send'} onClick={() => setSending(true)}>{busy === 'send' ? 'Sending…' : 'Send now'}</Button>
      </div>
      {preview && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <div className="text-[12.5px] text-secondary-text">
            Period <strong>{date(preview.period.from)}{preview.period.to !== preview.period.from ? ` – ${date(preview.period.to)}` : ''}</strong>
            {' · '}attachment <code className="mono">{preview.file_name}</code>
            {' · '}to: {preview.settings.to.length ? preview.settings.to.join(', ') : <em>nobody yet — set the recipients below</em>}
          </div>
          <div className="text-[13px] font-medium text-foreground">{preview.email.subject}</div>
          <pre className="max-h-[420px] overflow-auto rounded-[8px] bg-secondary p-3 text-[12px]/[1.5] whitespace-pre-wrap text-secondary-text">{preview.email.text}</pre>
        </div>
      )}
      {sending && (
        <ConfirmDialog
          tone="normal"
          title={`Send the ${title} now?`}
          message={`It goes to ${recipientsIn(settings).to.join(', ') || 'nobody — set the recipients first'}${recipientsIn(settings).cc.length ? `, copying ${recipientsIn(settings).cc.join(', ')}` : ''}, with the PDF attached, for ${asOf ? `the period as of ${date(asOf)}` : kind === 'daily_briefing' ? 'yesterday' : 'last week'}. A period already sent is sent again.`}
          confirmLabel="Send"
          busy={busy === 'send'}
          onClose={() => setSending(false)}
          onConfirm={() => { setSending(false); send(); }}
        />
      )}
    </div>
  );
}

function SharedSettings({ settings, onChanged }) {
  const toast = useToast();
  const [to, setTo] = useState(recipientsIn(settings).to.join(', '));
  const [cc, setCc] = useState(recipientsIn(settings).cc.join(', '));
  const [overdue, setOverdue] = useState(setting(settings, 'mis_overdue_days') || '7');
  const [busy, setBusy] = useState(false);

  // A setting cannot be saved blank, so an emptied list is saved as "none",
  // which the reports read as no addresses.
  const save = async (key, value) => api.update('settings', key, { value: value.trim() || 'none' });
  async function saveAll() {
    setBusy(true);
    try {
      // Saved cleaned (#195): each address once, and Cc without anybody already in To.
      const clean = recipientLists(to, cc);
      await save('mis_to', clean.to.join(', ')); await save('mis_cc', clean.cc.join(', '));
      setTo(clean.to.join(', ')); setCc(clean.cc.join(', '));
      await save('mis_overdue_days', String(Math.max(1, Number(overdue) || 7)));
      toast('Saved', 'success'); onChanged();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="text-[14px] font-semibold text-foreground">Recipients</div>
      <p className="text-[12.5px]/[1.6] text-secondary-text">Both reports go to the same people.</p>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <Field label="To" hint="Comma-separated"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="md@company.com, sales-head@company.com" /></Field>
        <Field label="Cc" hint="Comma-separated, or blank"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
        <Field label="Mark Overdue after" hint="Days a pending item has waited">
          <Input type="number" min="1" max="90" value={overdue} onChange={(e) => setOverdue(e.target.value)} />
        </Field>
      </div>
      <div><Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy} onClick={saveAll}>{busy ? 'Saving…' : 'Save'}</Button></div>
    </div>
  );
}

const STATE = { active: '', needs_reconnect: ' — needs reconnecting', disconnected: ' — disconnected', missing: ' — no longer connected' };

/**
 * Who both reports go from (mis-report-sender-plan.md §A2): the mailbox
 * they go through, an optional Send As address and display name, a line
 * saying what the next report will go from, and a test to the admin's own
 * address. The fallback is fixed: SMTP, and admins are told.
 */
function SenderCard({ settings, mailboxes, onChanged }) {
  const toast = useToast();
  const described = useFetch(() => api.raw('/mis-reports/sender'), []);
  const info = described.data?.data;
  // A non-numeric value ('none', blank) is the SMTP sender.
  const saved = setting(settings, 'mis_sender_account_id');
  const sender = /^\d+$/.test(saved) ? saved : 'smtp';
  const [sendAs, setSendAs] = useState(optional(settings, 'mis_sender_address'));
  const [name, setName] = useState(optional(settings, 'mis_sender_name'));
  const [busy, setBusy] = useState(null);
  const [test, setTest] = useState(null);
  // Shared mailboxes, and personal ones whose owner allowed it (§A3). One
  // that needs reconnecting stays listed, marked, so the saved choice never
  // shows blank.
  const live = (mailboxes ?? []).filter((m) => m.status !== 'disconnected');
  const shared = live.filter((m) => m.is_shared);
  const personal = live.filter((m) => !m.is_shared && m.may_send_reports);
  const listed = new Set([...shared, ...personal].map((m) => String(m.id)));
  const orphan = sender !== 'smtp' && !listed.has(sender) ? (info?.through ?? { id: Number(sender), email: `Mailbox ${sender}`, status: 'missing' }) : null;
  const label = (m) => `${m.email || `Mailbox ${m.id}`}${STATE[m.status] ?? ` — ${m.status}`}`;

  async function choose(v) {
    setBusy('choose');
    try { await api.update('settings', 'mis_sender_account_id', { value: v === 'smtp' ? 'none' : v }); toast('Saved', 'success'); onChanged(); described.refetch(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(null); }
  }
  async function save() {
    setBusy('save');
    try {
      await api.update('settings', 'mis_sender_address', { value: sendAs.trim() || 'none' });
      await api.update('settings', 'mis_sender_name', { value: name.trim() || 'none' });
      toast('Saved', 'success'); onChanged(); described.refetch();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
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
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="text-[14px] font-semibold text-foreground">Sender</div>
      <p className="text-[12.5px]/[1.6] text-secondary-text">Both reports go from here. Through a mailbox, they land in its Sent Items. If the mailbox cannot send, the report goes by the server's SMTP sender instead and admins are told.</p>
      <div className="grid gap-3 @3xl:grid-cols-3">
        <Field label="Send through" hint="A shared mailbox, or a personal one whose owner allowed it">
          <Select value={sender} onValueChange={choose} disabled={busy === 'choose'}>
            <SelectTrigger className="w-full text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="smtp" className="text-[13px]">The server's SMTP sender</SelectItem>
              {orphan && <SelectItem value={String(orphan.id)} className="text-[13px]">{label(orphan)}</SelectItem>}
              {shared.map((m) => <SelectItem key={m.id} value={String(m.id)} className="text-[13px]">{label(m)} · shared</SelectItem>)}
              {personal.map((m) => <SelectItem key={m.id} value={String(m.id)} className="text-[13px]">{label(m)} · {m.owner?.name || 'personal'}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Send as" hint="Optional. Needs Send As on it in Microsoft 365">
          <Input value={sendAs} onChange={(e) => setSendAs(e.target.value)} placeholder="mis@company.com" />
        </Field>
        <Field label="Display name" hint="Optional. The name beside the address">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cetizion MIS" />
        </Field>
      </div>
      {info && (
        info.problem
          ? <Alert tone="danger"><span><strong>{info.problem}.</strong> Until it is fixed, the reports go {info.smtp_configured ? <>by SMTP from <strong>{info.smtp_from}</strong></> : <>nowhere: no SMTP sender is set up on the server</>}.{info.through?.status === 'needs_reconnect' && <> <Link to="/settings/mailboxes">Reconnect it</Link>.</>}</span></Alert>
          : <p className="text-[12.5px] text-secondary-text">
              The next report goes {info.via === 'mailbox'
                ? <>from <strong>{from}</strong>{info.through?.email && info.from !== info.through.email ? <> through {info.through.email}</> : null}</>
                : info.from ? <>by SMTP from <strong>{from}</strong>{info.send_as && info.send_as !== info.from ? <> (the SMTP sender cannot send as {info.send_as})</> : null}</> : <>nowhere: no SMTP sender is set up on the server</>}.
            </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={busy === 'test'} onClick={sendTest}>{busy === 'test' ? 'Sending…' : 'Send a test to me'}</Button>
        {test && (
          <span className={`text-[12.5px] ${test.status === 'sent' ? 'text-settled' : test.status === 'failed' ? 'text-late' : 'text-secondary-text'}`}>
            {test.status === 'sent'
              ? `Sent to ${test.to} ${test.via === 'graph' ? `from ${test.from}` : `by SMTP from ${test.from}`}.${test.error ? ` The mailbox could not send: ${test.error}` : ''}`
              : test.status === 'failed' ? `Not sent: ${test.error}` : `Logged only (${test.suppressed || 'delivery is off'}); nothing left the server.`}
          </span>
        )}
      </div>
    </div>
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
      toast('Saved', 'success'); onChanged();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="text-[14px] font-semibold text-foreground">Finance's debtors list</div>
      <p className="text-[12.5px]/[1.6] text-secondary-text">The daily briefing reconciles the receivables with the newest Sundry Debtors list Finance emailed to a shared mailbox in the last 14 days, as an Excel file or a PDF. Each list is read once. One whose rows do not add up to its grand total is not used, and the briefing says so.</p>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <Field label="Subject or file name has" hint="Any of these words, comma-separated"><Input value={phrases} onChange={(e) => setPhrases(e.target.value)} /></Field>
        <Field label="Sent by" hint="Comma-separated, or blank for anyone at our own email domains"><Input value={senders} onChange={(e) => setSenders(e.target.value)} placeholder="accounts@company.com" /></Field>
      </div>
      <div><Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button></div>
    </div>
  );
}

function Runs({ runs, onChanged }) {
  const toast = useToast();
  const [resending, setResending] = useState(null);
  const [busy, setBusy] = useState(false);
  async function resend(run) {
    setBusy(true);
    try {
      // The period is the run's; "as of" the day after it ended rebuilds exactly that period.
      const next = new Date(`${String(run.period_to).slice(0, 10)}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
      const r = await api.action(`/mis-reports/${run.kind}/send`, { date: next.toISOString().slice(0, 10) });
      toast(r.data.status === 'sent' ? `Sent again to ${r.data.recipients.join(', ')}` : `Not sent: ${r.data.error}`, r.data.status === 'sent' ? 'success' : 'danger');
      onChanged();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); setResending(null); }
  }
  const period = (r) => (r.period_from === r.period_to ? date(r.period_from) : `${date(r.period_from)} – ${date(r.period_to)}`);
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="px-5 pt-4 text-[14px] font-semibold text-foreground">Sent so far</div>
      <DataTable
        rows={runs}
        empty="Nothing has been sent yet."
        columns={[
          { key: 'kind', header: 'Report', render: (r) => TITLE[r.kind] },
          { key: 'period', header: 'Period', render: period },
          { key: 'status', header: 'Status', render: (r) => (r.status === 'sent' ? <Chip tone="settled">{`sent · ${howSent(r)}`}</Chip> : r.status === 'failed' ? <Chip tone="late">failed</Chip> : r.sent_via === 'log' ? <Chip tone="waiting">logged only</Chip> : <Chip>{r.status}</Chip>) },
          { key: 'recipients', header: 'To', className: 'wrap', render: (r) => (r.recipients || []).join(', ') || '—' },
          { key: 'created_at', header: 'When', render: (r) => `${ago(r.created_at)} · ${r.triggered_by}` },
          { key: 'error', header: 'Note', className: 'wrap small', render: (r) => r.error || (r.ai_used ? 'AI commentary' : '') },
          {
            key: 'actions', header: '', render: (r) => (
              <span className="flex gap-1">
                {r.document_id && <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px]" asChild><a href={`/api/mis-reports/runs/${r.id}/pdf`} target="_blank" rel="noreferrer">PDF</a></Button>}
                <Button variant="ghost" size="sm" className="h-7 px-2 text-[12.5px]" onClick={() => setResending(r)}>Resend</Button>
              </span>
            ),
          },
        ]}
      />
      {resending && (
        <ConfirmDialog
          tone="normal"
          title={`Send the ${TITLE[resending.kind]} for ${period(resending)} again?`}
          message="It is rebuilt from the records as they are now, so figures may differ from the first send, and goes to the current recipients."
          confirmLabel="Resend"
          busy={busy}
          onClose={() => setResending(null)}
          onConfirm={() => resend(resending)}
        />
      )}
    </div>
  );
}

export default function ScheduledReports() {
  const settings = useFetch(() => api.raw('/settings'), []);
  const mailboxes = useFetch(() => api.raw('/mailboxes'), []);
  const runs = useFetch(() => api.raw('/mis-reports/runs'), []);
  const refetch = () => { settings.refetch(); runs.refetch(); };
  const list = settings.data?.data;
  // What was last saved, so a card re-reads it after a save or a reload.
  const saved = (list || []).map((s) => `${s.key}=${s.value}`).join('|');
  const emailsOn = setting(list, 'emails_enabled') !== 'false';
  return (
    <>
      <PageHeader
        title="Scheduled reports"
        subtitle="The Daily Sales Briefing and the Weekly Sales MIS, built from the tracker's records and emailed from the chosen sender with the PDF attached."
        actions={<Link className="btn" to="/reports">Back to Reports</Link>}
      />
      <div className="page stack @container">
        {!emailsOn && (
          <Alert tone="warning"><span>Automatic email is switched off under Settings → Emails &amp; jobs, so a report is composed and logged but not sent.</span></Alert>
        )}
        <Alert tone="info">
          <span>The figures come from the same definitions as the Reports page, in ₹ at the rate on each record's date. Each period is sent once by the schedule; Send now and Resend always send.</span>
        </Alert>
        {list && (
          <div className="grid gap-4 lg:grid-cols-2">
            {KINDS.map((k) => <ReportCard key={k.kind} {...k} settings={list} onChanged={refetch} />)}
          </div>
        )}
        {/* Each card is rebuilt from what was saved, under a key of its own. When the
            two shared one, React drew the recipients card twice, and the copy on
            screen stopped taking what was typed. */}
        {list && <SharedSettings key={`recipients:${saved}`} settings={list} onChanged={refetch} />}
        {list && <SenderCard key={`sender:${saved}`} settings={list} mailboxes={mailboxes.data?.data} onChanged={refetch} />}
        {list && <DebtorsList key={`debtors:${saved}`} settings={list} onChanged={refetch} />}
        <Runs runs={runs.data?.data ?? []} onChanged={refetch} />
      </div>
    </>
  );
}
