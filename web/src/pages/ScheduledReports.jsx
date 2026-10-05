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

/**
 * Reports → Scheduled reports (docs/mis-reports-plan.md §5): the Daily Sales
 * Briefing and the Weekly Sales MIS the tracker builds from its own records
 * and emails from the sales mailbox with the PDF attached.
 *
 * Two cards, one per report: the on/off switch, a preview of the figures
 * and the email as of any date, the PDF, and Send now. Below them the
 * settings both share (recipients, the sender mailbox, the Overdue
 * threshold) and the run history with each PDF and Resend. Admin only; the
 * routes are behind requireAdmin on the server.
 */

const KINDS = [
  { kind: 'daily_briefing', settingKey: 'mis_daily_enabled', title: 'Daily Sales Briefing', when: 'Every day at 08:56 IST, for the previous day', what: 'What happened yesterday, the pending invoices, POs and quotations with Overdue marked, and the top five actions for today.' },
  { kind: 'weekly_mis', settingKey: 'mis_weekly_enabled', title: 'Weekly Sales MIS Report', when: 'Every Monday at 08:54 IST, for the previous Monday to Sunday', what: 'The eight management questions: enquiries per day with first-response times, outcomes, sector-wise and service-wise sales, customers, invoiced and received, receivables over 90 days, pending follow-ups, conversion and speed.' },
];
const TITLE = Object.fromEntries(KINDS.map((k) => [k.kind, k.title]));

const setting = (list, key) => (list ?? []).find((s) => s.key === key)?.value ?? '';
// The addresses in a To/Cc setting, as the server reads them: a setting cannot be blank, so "none" means nobody.
const addresses = (v) => String(v ?? '').split(/[,;]/).map((a) => a.trim()).filter((a) => a.includes('@'));

// "Tue 06 Oct, 08:56 IST": a run time in the business time zone, whatever the browser's.
const runTime = (iso, timeZone = 'Asia/Kolkata') => (iso
  ? `${new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(',', '')} IST`
  : '—');
const runStatus = (r) => (r.status === 'sent' ? `sent${r.sent_via === 'log' ? ' (logged only)' : ''}` : r.status);

/** What the schedule has done and will do for one report, and anything wrong with it. */
function ScheduleLine({ status }) {
  if (!status) return null;
  const last = status.last_scheduled_run;
  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] bg-secondary px-3 py-2 text-[12.5px]/[1.5] text-secondary-text">
      <div>
        Next run <strong>{status.enabled ? runTime(status.next_run, status.timezone) : 'none while it is off'}</strong>
        {' · '}last scheduled attempt {last
          ? <>{ago(last.created_at)} for {date(last.period_from)}: <strong>{runStatus(last)}</strong>{last.error ? ` (${last.error})` : ''}</>
          : <em>none recorded</em>}
      </div>
      {status.warnings.map((w) => <div key={w} className="text-late">{w}</div>)}
    </div>
  );
}

function ReportCard({ kind, settingKey, title, when, what, settings, schedule, onChanged }) {
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
    return run.sent_via === 'log' ? `Logged only (${run.suppressed || 'delivery is off'}); nothing left the server` : `Sent to ${run.recipients.join(', ')} via ${run.sent_via === 'graph' ? 'the sales mailbox' : 'SMTP'}`;
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
      <ScheduleLine status={schedule} />
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
          message={`It goes to ${addresses(setting(settings, 'mis_to')).join(', ') || 'nobody — set the recipients first'}${addresses(setting(settings, 'mis_cc')).length ? `, copying ${addresses(setting(settings, 'mis_cc')).join(', ')}` : ''}, with the PDF attached, for ${asOf ? `the period as of ${date(asOf)}` : kind === 'daily_briefing' ? 'yesterday' : 'last week'}. A period already sent is sent again.`}
          confirmLabel="Send"
          busy={busy === 'send'}
          onClose={() => setSending(false)}
          onConfirm={() => { setSending(false); send(); }}
        />
      )}
    </div>
  );
}

function SharedSettings({ settings, mailboxes, onChanged }) {
  const toast = useToast();
  const [to, setTo] = useState(addresses(setting(settings, 'mis_to')).join(', '));
  const [cc, setCc] = useState(addresses(setting(settings, 'mis_cc')).join(', '));
  const [overdue, setOverdue] = useState(setting(settings, 'mis_overdue_days') || '7');
  // A non-numeric value ('none', blank) is the SMTP sender.
  const sender = /^\d+$/.test(setting(settings, 'mis_sender_account_id')) ? setting(settings, 'mis_sender_account_id') : 'smtp';
  const [busy, setBusy] = useState(false);
  const shared = (mailboxes ?? []).filter((m) => m.is_shared && m.status === 'active');

  // A setting cannot be saved blank, so an emptied list is saved as "none",
  // which the reports read as no addresses.
  const save = async (key, value) => api.update('settings', key, { value: value.trim() || 'none' });
  async function saveAll() {
    setBusy(true);
    try {
      await save('mis_to', to); await save('mis_cc', cc); await save('mis_overdue_days', String(Math.max(1, Number(overdue) || 7)));
      toast('Saved', 'success'); onChanged();
    } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function chooseSender(v) {
    try { await api.update('settings', 'mis_sender_account_id', { value: v === 'smtp' ? 'none' : v }); toast('Saved', 'success'); onChanged(); }
    catch (err) { toast(err.message, 'danger'); }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="text-[14px] font-semibold text-foreground">Recipients and sender</div>
      <p className="text-[12.5px]/[1.6] text-secondary-text">Both reports go to the same people, from the shared sales mailbox so they land in its Sent Items. If that mailbox cannot send, the report goes by the server's SMTP sender instead and admins are told.</p>
      <div className="grid gap-3 @3xl:grid-cols-2">
        <Field label="To" hint="Comma-separated"><Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="md@company.com, sales-head@company.com" /></Field>
        <Field label="Cc" hint="Comma-separated, or blank"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
        <Field label="Mark Overdue after" hint="Days a pending item has waited">
          <Input type="number" min="1" max="90" value={overdue} onChange={(e) => setOverdue(e.target.value)} />
        </Field>
        <Field label="Send from" hint="A shared mailbox that is connected and active">
          <Select value={sender} onValueChange={chooseSender}>
            <SelectTrigger className="w-full text-[13px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="smtp" className="text-[13px]">The server's SMTP sender</SelectItem>
              {shared.map((m) => <SelectItem key={m.id} value={String(m.id)} className="text-[13px]">{m.email}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div><Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy} onClick={saveAll}>{busy ? 'Saving…' : 'Save'}</Button></div>
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
      <div className="px-5 pt-4 text-[14px] font-semibold text-foreground">Run history</div>
      <p className="px-5 text-[12.5px] text-secondary-text">Every run, sent or not: a scheduled run that was switched off or had already been sent is listed as skipped, with the reason.</p>
      <DataTable
        rows={runs}
        empty="Nothing has run yet."
        columns={[
          { key: 'kind', header: 'Report', render: (r) => TITLE[r.kind] },
          { key: 'period', header: 'Period', render: period },
          { key: 'status', header: 'Status', render: (r) => (r.status === 'sent' ? <Chip tone="settled">{`sent · ${r.sent_via === 'graph' ? 'sales mailbox' : r.sent_via}`}</Chip> : r.status === 'failed' ? <Chip tone="late">failed</Chip> : r.sent_via === 'log' ? <Chip tone="waiting">logged only</Chip> : <Chip>{r.status}</Chip>) },
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
  const schedule = useFetch(() => api.raw('/mis-reports/schedule'), []);
  const refetch = () => { settings.refetch(); runs.refetch(); schedule.refetch(); };
  const sched = schedule.data?.data;
  const list = settings.data?.data;
  const emailsOn = setting(list, 'emails_enabled') !== 'false';
  return (
    <>
      <PageHeader
        title="Scheduled reports"
        subtitle="The Daily Sales Briefing and the Weekly Sales MIS, built from the tracker's records and emailed from the sales mailbox with the PDF attached."
        actions={<Link className="btn" to="/reports">Back to Reports</Link>}
      />
      <div className="page stack @container">
        {!emailsOn && (
          <Alert tone="warning"><span>Automatic email is switched off under Settings → Emails &amp; jobs, so a report is composed and logged but not sent.</span></Alert>
        )}
        {sched && !sched.worker.ok && (
          <Alert tone="warning"><span>The worker has not run a scheduled job {sched.worker.last_seen ? `since ${ago(sched.worker.last_seen)}` : 'on this database yet'}. The tracker sends a report the worker missed itself, {sched.reports[0]?.catch_up_minutes ?? 20} minutes after its time, but follow-ups, reminders and the other jobs wait for the worker: start it from the current image with the API's environment.</span></Alert>
        )}
        <Alert tone="info">
          <span>The figures come from the same definitions as the Reports page, in ₹ at the rate on each record's date. Each period is sent once by the schedule; Send now and Resend always send.</span>
        </Alert>
        {list && (
          <div className="grid gap-4 lg:grid-cols-2">
            {KINDS.map((k) => <ReportCard key={k.kind} {...k} settings={list} schedule={sched?.reports.find((r) => r.kind === k.kind)} onChanged={refetch} />)}
          </div>
        )}
        {list && <SharedSettings key={list.map((s) => `${s.key}=${s.value}`).join('|')} settings={list} mailboxes={mailboxes.data?.data} onChanged={refetch} />}
        <Runs runs={runs.data?.data ?? []} onChanged={refetch} />
      </div>
    </>
  );
}
