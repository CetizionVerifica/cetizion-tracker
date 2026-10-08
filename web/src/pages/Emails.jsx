import { useState } from 'react';
import { ConfirmDialog, Field, Input, Modal, useToast } from '../components/ui.jsx';
import { ListTable, Panel, PhoneRow, StateCard } from '../components/daily.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { RowActions } from '../components/settings.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';

/**
 * What the tracker sends on its own (#21), Wave 8: the automatic-email
 * switch (stopping it asks first), a test email, the scheduled jobs with
 * their names and schedules in words (the cron as a sub-line) and a
 * "Running…" on the row that runs, and every email composed, whether it
 * left the server or not.
 */

const LOG = { sent: ['Sent', 'ok'], suppressed: ['Logged only', 'info'], failed: ['Failed', 'late'], queued: ['Waiting', 'wait'] };
const RUN = { done: ['OK', 'ok'], failed: ['Failed', 'late'], running: ['Running', 'info'] };
const MODE = { log: 'Log only', allowlist: 'Allowlist only', live: 'Live' };

/** "payment-reminders" → "Payment reminders". */
const jobName = (n) => { const s = String(n).replace(/[-_.]+/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const DOW = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const at = (h, m) => `${Number(h)}:${String(m).padStart(2, '0')}`;
/** The common cron shapes in words; anything else stays as written. */
function cronWords(cron) {
  const p = String(cron || '').trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [m, h, dom, mon, dow] = p;
  if (dom !== '*' || mon !== '*') return cron;
  if (m === '*' && h === '*' && dow === '*') return 'Every minute';
  if (/^\*\/\d+$/.test(m) && h === '*' && dow === '*') return `Every ${m.slice(2)} minutes`;
  if (/^\d+$/.test(m) && h === '*' && dow === '*') return m === '0' ? 'Every hour' : `Every hour at :${m.padStart(2, '0')}`;
  if (/^\d+$/.test(m) && /^\*\/\d+$/.test(h) && dow === '*') return `Every ${h.slice(2)} hours`;
  if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    if (dow === '*') return `Every day at ${at(h, m)}`;
    if (dow === '1-5') return `Weekdays at ${at(h, m)}`;
    if (/^\d$/.test(dow)) return `${DOW[Number(dow) % 7]} at ${at(h, m)}`;
  }
  return cron;
}

export default function Emails() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(() => new Set());
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [allJobs, setAllJobs] = useState(false);
  const jobs = useFetch(() => api.raw('/jobs'), []);
  const settings = useFetch(() => api.raw('/settings'), []);
  const emails = useFetch(() => api.raw(`/emails${status ? `?status=${status}` : ''}`), [status]);
  const rows = emails.data?.data ?? [];
  const jobRows = jobs.data?.data ?? [];
  const enabled = (settings.data?.data ?? []).find((s) => s.key === 'emails_enabled')?.value !== 'false';
  const interval = (settings.data?.data ?? []).find((s) => s.key === 'reminder_interval_days')?.value;

  async function toggle() {
    setBusy(true);
    try {
      await api.update('settings', 'emails_enabled', { value: enabled ? 'false' : 'true' });
      toast(enabled ? 'Automatic email stopped' : 'Automatic email enabled', 'success');
      settings.refetch();
      setStopping(false);
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function run(name) {
    setRunning((s) => new Set(s).add(name));
    try {
      const { data } = await api.action(`/jobs/${name}/run`);
      toast(data.status === 'done' ? `${jobName(name)} ran: ${summarise(data.result)}` : `${jobName(name)} failed: ${data.error}`, data.status === 'done' ? 'success' : 'danger');
      jobs.refetch(); emails.refetch();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setRunning((s) => { const n = new Set(s); n.delete(name); return n; }); }
  }
  async function sendTest(e) {
    e.preventDefault(); setTesting(true);
    try {
      const { data } = await api.action('/emails/test', { to: testTo });
      toast(data.status === 'sent' ? `Sent to ${testTo}` : `Logged as ${(LOG[data.status]?.[0] || data.status).toLowerCase()}: ${data.reason || ''}`, data.status === 'sent' ? 'success' : 'info');
      emails.refetch();
    } catch (err) { toast(err.fields?.to || err.message, 'danger'); }
    finally { setTesting(false); }
  }

  const mode = emails.data?.mode;
  const days = (n) => `${n} ${Number(n) === 1 ? 'day' : 'days'}`;
  const shownJobs = allJobs ? jobRows : jobRows.slice(0, 8);
  const lastRun = (j) => {
    const r = j.last_run;
    if (running.has(j.name)) return { tone: 'info', word: 'Running', sub: 'Started just now' };
    if (!r) return { tone: 'plain', word: 'Never run', sub: '' };
    const [word, tone] = RUN[r.status] || [r.status, 'plain'];
    return { tone, word, sub: [ago(r.started_at), r.started_by, r.result && summarise(r.result)].filter(Boolean).join(' · '), err: r.error };
  };

  return (
    <>
      <SettingsPane
        title="Emails & jobs"
        description="The reminders and digests the tracker sends on its own, the schedule they run on, and a record of every email it composed, including the ones that never left the server."
      >
        {mode && mode !== 'live' && (
          <MoneyBanner tone="wait" title={mode === 'log' ? 'Delivery mode is Log only: nothing leaves the server.' : 'Delivery mode is Allowlist only.'}>
            {' '}{mode === 'log' ? 'Every email is written to the log below instead.' : `Only addresses on the allowlist (${(emails.data.allowlist || []).join(', ') || 'none'}) receive mail.`} Set EMAIL_MODE=live on the server to send.
          </MoneyBanner>
        )}
        {mode === 'live' && !emails.data?.configured && (
          <MoneyBanner tone="late" role="alert" title="EMAIL_MODE is live but SMTP_HOST or EMAIL_FROM is not set.">{' '}Emails will be logged as not sent until both are set.</MoneyBanner>
        )}

        <div className="set-two">
          <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="set-ae">
            <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-ae">Automatic email</h2><span className="mg-panel__hint">The switch for every reminder and digest.</span></div>
            <dl className="mg-facts">
              <div><dt>Status</dt><dd>{settings.data ? <Tone tone={enabled ? 'ok' : 'late'}>{enabled ? 'On' : 'Off'}</Tone> : '…'}</dd></div>
              <div><dt>Delivery mode</dt><dd>{mode ? MODE[mode] || mode : '…'}</dd></div>
              <div><dt>From</dt><dd className="break-words">{emails.data ? (emails.data.from || <span className="font-medium text-muted-foreground">EMAIL_FROM not set</span>) : '…'}</dd></div>
              <div><dt>Reminder interval</dt><dd>{interval ? days(interval) : '…'}</dd></div>
            </dl>
            <div className="flex flex-wrap items-center gap-2.5">
              {enabled
                ? <button type="button" className="mg-btn" disabled={!settings.data} onClick={() => setStopping(true)}>Stop automatic email</button>
                : <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={toggle}>{busy ? 'Turning on…' : 'Enable automatic email'}</button>}
            </div>
            <p className="m-0 text-[12.5px] text-secondary-text">Off stops every reminder and digest. They’re still composed and logged here, so you can see what would have gone out.</p>
          </section>
          <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="set-te">
            <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="set-te">Send a test email</h2><span className="mg-panel__hint">Same log and delivery mode as the rest.</span></div>
            <form onSubmit={sendTest} className="flex flex-col gap-3.5">
              <Field label="To" required><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@company.com" required /></Field>
              <div><button type="submit" className="mg-btn" disabled={testing || !testTo}>{testing ? 'Sending…' : 'Send test'}</button></div>
            </form>
          </section>
        </div>

        <Panel id="set-jobs" title="Scheduled jobs" hint="Run by the worker on the schedule shown, in India time. Each job runs on its own, so one running doesn’t hold up the rest.">
          {jobs.error ? <StateCard inPanel tone="late" title="Couldn’t load the jobs" text={jobs.error}><button type="button" className="mg-btn mg-btn--sm" onClick={jobs.refetch}>Try again</button></StateCard>
          : jobs.loading && !jobs.data ? <div className="app-panel__body flex flex-col gap-2.5 p-5">{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</div>
          : (
            <>
              <ListTable
                label="Scheduled jobs"
                rows={shownJobs}
                rowKey={(j) => j.name}
                columns={[
                  { key: 'name', header: 'Job', render: (j) => <><b>{jobName(j.name)}</b><span className="set-sub">{j.name}</span></> },
                  { key: 'description', header: 'What it does', className: 'app-say', width: '28%', render: (j) => j.description },
                  { key: 'cron', header: 'Schedule', render: (j) => <span className="whitespace-nowrap">{cronWords(j.cron)}<span className="set-sub">{j.cron}{j.time_zone && j.time_zone !== 'Asia/Kolkata' ? ` (${j.time_zone})` : ''}</span></span> },
                  { key: 'last', header: 'Last run', className: 'app-wrap', render: (j) => { const l = lastRun(j); return <><Tone tone={l.tone}>{l.word}</Tone>{l.sub && <span className="set-sub">{l.sub}</span>}{l.err && <span className="set-sub text-late font-semibold">{l.err}</span>}</>; } },
                  { key: 'run', header: '', className: 'actions', render: (j) => <RowActions><button type="button" className="mg-btn mg-btn--sm" aria-label={`Run ${jobName(j.name)} now`} disabled={running.has(j.name)} onClick={() => run(j.name)}>{running.has(j.name) ? 'Running…' : 'Run now'}</button></RowActions> },
                ]}
                phone={(j) => { const l = lastRun(j); return (
                  <PhoneRow title={jobName(j.name)} meta={[cronWords(j.cron), l.sub, l.err].filter(Boolean).join(' · ')} state={<Tone tone={l.tone}>{l.word}</Tone>} wraps>
                    <span className="set-rowacts"><button type="button" className="mg-btn mg-btn--sm" disabled={running.has(j.name)} onClick={() => run(j.name)}>{running.has(j.name) ? 'Running…' : 'Run now'}</button></span>
                  </PhoneRow>
                ); }}
              />
              {jobRows.length > 8 && (
                <div className="set-panel-foot"><span>Showing {shownJobs.length} of {jobRows.length} jobs</span><button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => setAllJobs((v) => !v)}>{allJobs ? 'Show fewer' : `Show all ${jobRows.length}`}</button></div>
              )}
            </>
          )}
        </Panel>

        <Panel
          id="set-log"
          title="Email log"
          hint={`Every email composed, newest first. ${number(rows.length)} shown. Open one to read it.`}
          tools={
            <div className="set-tools">
              <span className="mg-select-wrap">
                <select className="mg-select" aria-label="Filter the log by status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All statuses</option>
                  {Object.entries(LOG).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </span>
            </div>
          }
        >
          {emails.error ? <StateCard inPanel tone="late" title="Couldn’t load the email log" text={emails.error}><button type="button" className="mg-btn mg-btn--sm" onClick={emails.refetch}>Try again</button></StateCard>
          : emails.loading && !emails.data ? <div className="app-panel__body flex flex-col gap-2.5 p-5">{[0, 1, 2].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</div>
          : rows.length === 0 ? (
            status
              ? <StateCard inPanel tone="plain" title="No emails with this status" text="Pick All statuses to see everything."><button type="button" className="mg-btn mg-btn--sm" onClick={() => setStatus('')}>Clear the filter</button></StateCard>
              : <StateCard inPanel tone="plain" title="No emails yet" text="Run a job or send a test email; everything the tracker composes appears here." />
          ) : (
            <ListTable
              label="Email log"
              rows={rows}
              columns={[
                { key: 'created_at', header: 'When', width: '110px', render: (r) => <span className="whitespace-nowrap text-secondary-text">{ago(r.created_at)}</span> },
                { key: 'to_email', header: 'To', className: 'app-wrap--sm', render: (r) => <span className="break-all text-secondary-text">{r.to_email}</span> },
                { key: 'subject', header: 'Subject', className: 'app-wrap', width: '34%', render: (r) => <button type="button" className="set-mail-subject" onClick={() => setOpen(r)}>{r.subject}</button> },
                { key: 'template', header: 'Kind', render: (r) => <span className="whitespace-nowrap">{jobName(r.template)}</span> },
                { key: 'status', header: 'Status', render: (r) => <><Tone tone={LOG[r.status]?.[1] || 'plain'}>{LOG[r.status]?.[0] || r.status}</Tone>{r.error && <span className="set-sub text-late">{r.error}</span>}</> },
                { key: 'sent_by', header: 'By', render: (r) => <span className="whitespace-nowrap text-secondary-text">{r.sent_by}</span> },
              ]}
              phone={(r) => (
                <PhoneRow title={r.subject} amount={ago(r.created_at)} meta={`${r.to_email} · ${jobName(r.template)} · by ${r.sent_by}`} state={<Tone tone={LOG[r.status]?.[1] || 'plain'}>{LOG[r.status]?.[0] || r.status}</Tone>} onClick={() => setOpen(r)} label={`Open the email: ${r.subject}`} wraps />
              )}
            />
          )}
        </Panel>
      </SettingsPane>

      {open && <EmailBody id={open.id} onClose={() => setOpen(null)} />}
      {stopping && (
        <ConfirmDialog
          title="Stop automatic email?"
          subtitle="Reminders and digests, for everyone"
          message="Every reminder and digest stops going out from now. They’re still composed and logged here, so you can see what would have gone out. Turn it back on at any time."
          tone="neutral"
          confirmLabel="Stop automatic email"
          cancelLabel="Keep it on"
          busy={busy}
          onConfirm={toggle}
          onClose={() => setStopping(false)}
        />
      )}
    </>
  );
}

function summarise(result) {
  if (!result) return '';
  if (Array.isArray(result.sent)) return `${result.sent.length} reminder${result.sent.length === 1 ? '' : 's'}, ${result.skipped?.length ?? 0} skipped`;
  if (result.to) return `${result.status} to ${result.to}: ${result.to_invoice} to invoice, ${result.overdue} overdue`;
  if (result.skipped) return String(result.skipped);
  return JSON.stringify(result).slice(0, 80);
}

function EmailBody({ id, onClose }) {
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/emails/${id}`), [id]);
  const e = data?.data;
  return (
    <Modal
      title={e?.subject || 'Email'}
      subtitle={e ? `To ${e.to_email}${e.cc ? ` · cc ${e.cc}` : ''} · ${LOG[e.status]?.[0] || e.status}${e.reason ? ` (${e.reason})` : ''}` : ''}
      onClose={onClose}
      size="lg"
      footer={<button type="button" className="mg-btn mg-btn--primary" onClick={onClose}>Close</button>}
    >
      {error ? <MoneyBanner tone="late" role="alert" title="Couldn’t open this email." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{' '}{error}</MoneyBanner>
        : loading || !e ? <div className="mg-skel" style={{ height: 160 }} />
        : <pre className="set-pre">{e.body_text}</pre>}
    </Modal>
  );
}
