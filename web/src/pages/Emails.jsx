import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, DataTable, Empty, Field, Input, KeyValues, Modal, Select, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * What the tracker sends on its own (#21): the scheduled jobs, the kill
 * switch, and every email composed, whether it left the server or not.
 */
export default function Emails({ bare = false }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const jobs = useFetch(() => api.raw('/jobs'), []);
  const settings = useFetch(() => api.raw('/settings'), []);
  const emails = useFetch(() => api.raw(`/emails${status ? `?status=${status}` : ''}`), [status]);
  const rows = emails.data?.data ?? [];
  const enabled = (settings.data?.data ?? []).find((s) => s.key === 'emails_enabled')?.value !== 'false';
  const interval = (settings.data?.data ?? []).find((s) => s.key === 'reminder_interval_days')?.value;

  async function toggle() {
    try {
      await api.update('settings', 'emails_enabled', { value: enabled ? 'false' : 'true' });
      toast(enabled ? 'Automatic email stopped' : 'Automatic email enabled', 'success');
      settings.refetch();
    } catch (err) { toast(err.message, 'danger'); }
  }
  async function run(name) {
    setBusy(true);
    try {
      const { data } = await api.action(`/jobs/${name}/run`);
      toast(data.status === 'done' ? `${name} ran: ${summarise(data.result)}` : `${name} failed: ${data.error}`, data.status === 'done' ? 'success' : 'danger');
      jobs.refetch(); emails.refetch();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function sendTest(e) {
    e.preventDefault(); setBusy(true);
    try {
      const { data } = await api.action('/emails/test', { to: testTo });
      toast(data.status === 'sent' ? `Sent to ${testTo}` : `Logged as ${data.status}: ${data.reason || ''}`, data.status === 'sent' ? 'success' : 'info');
      emails.refetch();
    } catch (err) { toast(err.fields?.to || err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const mode = emails.data?.mode;
  return (
    <>
      {!bare && <PageHeader title="Emails & jobs" subtitle="Reminders and digests the tracker sends on its own, and the record of every email" />}
      <div className="page stack">
        {mode && mode !== 'live' && (
          <Alert tone="warning">
            <span>Delivery mode is <strong>{mode}</strong>: {mode === 'log' ? 'nothing leaves the server; every email is only logged here.' : `only addresses on the allowlist (${(emails.data.allowlist || []).join(', ') || 'none'}) receive mail.`} Set EMAIL_MODE=live on the server to send.</span>
          </Alert>
        )}
        {mode === 'live' && !emails.data?.configured && <Alert tone="danger">EMAIL_MODE is live but SMTP_HOST or EMAIL_FROM is not set; emails will be logged as suppressed.</Alert>}

        <div className="auto-grid grid--2">
          <Card title="Automatic email" hint="The kill switch. Off stops every reminder and digest; they are still logged so you can see what would have gone.">
            <KeyValues items={[
              { label: 'Status', value: <Badge tone={enabled ? 'success' : 'danger'}>{enabled ? 'On' : 'Off'}</Badge> },
              { label: 'Delivery mode', value: mode || '…' },
              { label: 'From', value: emails.data?.from || <span className="muted">EMAIL_FROM not set</span> },
              { label: 'Reminder interval', value: interval ? `${interval} days (Settings)` : '…' },
            ]} />
            <div style={{ marginTop: 14 }}>
              <button type="button" className={`btn ${enabled ? '' : 'btn--primary'}`} onClick={toggle}>{enabled ? 'Stop automatic email' : 'Enable automatic email'}</button>
            </div>
          </Card>
          <Card title="Send a test email" hint="Goes through the same log and mode as everything else.">
            <form onSubmit={sendTest} className="stack">
              <Field label="To"><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@company.com" required /></Field>
              <div><button type="submit" className="btn btn--primary" disabled={busy || !testTo}>Send test</button></div>
            </form>
          </Card>
        </div>

        <Card flush title="Scheduled jobs" hint="Run by the worker process on the schedule shown, in the business time zone. Run now runs the job from here, for a check or after a fix.">
          <DataTable
            rows={jobs.data?.data ?? []}
            columns={[
              { key: 'name', header: 'Job', className: 'mono strong' },
              { key: 'description', header: 'What it does', className: 'wrap' },
              { key: 'cron', header: 'Schedule', className: 'mono small', render: (j) => `${j.cron} (${j.time_zone})` },
              { key: 'last', header: 'Last run', render: (j) => j.last_run ? <><Badge tone={j.last_run.status === 'done' ? 'success' : j.last_run.status === 'failed' ? 'danger' : 'info'}>{j.last_run.status}</Badge><div className="small muted">{new Date(j.last_run.started_at).toLocaleString()} · {j.last_run.started_by}</div>{j.last_run.result && <div className="small muted">{summarise(j.last_run.result)}</div>}{j.last_run.error && <div className="small" style={{ color: 'var(--danger-fg)' }}>{j.last_run.error}</div>}</> : <span className="muted">never</span> },
              { key: 'run', header: '', align: 'right', render: (j) => <button type="button" className="btn btn--sm" disabled={busy} onClick={() => run(j.name)}>Run now</button> },
            ]}
          />
        </Card>

        <Card flush title="Email log" hint="Every email the tracker composed, newest first." actions={
          <div className="card__actions">
            <Select value={status} placeholder="Status: all" options={['sent', 'suppressed', 'failed', 'queued']} onChange={(e) => setStatus(e.target.value)} />
            <span className="small muted">{rows.length} shown</span>
          </div>
        }>
          <DataTable
            rows={rows}
            onRowClick={(r) => setOpen(r)}
            columns={[
              { key: 'created_at', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
              { key: 'to_email', header: 'To', className: 'mono small' },
              { key: 'subject', header: 'Subject', className: 'wrap strong' },
              { key: 'template', header: 'Kind', render: (r) => <Badge>{r.template}</Badge> },
              { key: 'status', header: 'Status', render: (r) => <><Badge tone={r.status === 'sent' ? 'success' : r.status === 'failed' ? 'danger' : 'warning'}>{r.status}</Badge>{r.reason && <div className="small muted">{r.reason}</div>}{r.error && <div className="small" style={{ color: 'var(--danger-fg)' }}>{r.error}</div>}</> },
              { key: 'sent_by', header: 'By', className: 'small muted' },
            ]}
            empty={<Empty title="No emails yet" text="Run a job or send a test email; everything the tracker composes appears here." />}
          />
        </Card>
      </div>

      {open && (
        <EmailBody id={open.id} onClose={() => setOpen(null)} />
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
  const { data, loading } = useFetch(() => api.raw(`/emails/${id}`), [id]);
  const e = data?.data;
  return (
    <Modal title={e?.subject || 'Email'} subtitle={e ? `To ${e.to_email}${e.cc ? `, cc ${e.cc}` : ''} · ${e.status}${e.reason ? ` (${e.reason})` : ''}` : ''} onClose={onClose} size="lg" footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      {loading || !e ? <div className="skeleton" style={{ height: 120 }} /> : <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{e.body_text}</pre>}
    </Modal>
  );
}
