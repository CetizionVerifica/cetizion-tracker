import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Alert, DataTable, Empty, Field, Input, KeyValues, Modal, useToast } from '../components/ui.jsx';
import { Chip, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';

/**
 * What the tracker sends on its own (#21): the scheduled jobs, the kill
 * switch, and every email composed, whether it left the server or not.
 *
 * C12 does not draw this pane — it is only named in C9's list of the six
 * screens the settings area absorbed — so it takes the shape the other
 * panes settled on rather than inventing a third one. The log stays a
 * table, because a log is what it is and nothing in the design argues
 * otherwise.
 */

const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';
const LOG_STATUSES = ['sent', 'suppressed', 'failed', 'queued'];

const statusTone = (status) => (status === 'sent' || status === 'done' ? 'settled' : status === 'failed' ? 'late' : 'waiting');

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
      {!bare && <PageHeader title="Emails & jobs" />}

      <div className="flex flex-col gap-5 px-4 pt-6 pb-8 sm:px-8">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.018em] text-foreground">Emails &amp; jobs</h1>
          <p className="mt-1.5 max-w-[66ch] text-[13px]/[1.6] text-secondary-text">
            The reminders and digests the tracker sends on its own, the schedule they run on, and a record of every
            email it composed — including the ones that never left the server.
          </p>
        </div>

        {mode && mode !== 'live' && (
          <Alert tone="warning">
            <span>
              Delivery mode is <strong>{mode}</strong>:{' '}
              {mode === 'log'
                ? 'nothing leaves the server; every email is only logged here.'
                : `only addresses on the allowlist (${(emails.data.allowlist || []).join(', ') || 'none'}) receive mail.`}
              {' '}Set EMAIL_MODE=live on the server to send.
            </span>
          </Alert>
        )}
        {mode === 'live' && !emails.data?.configured && (
          <Alert tone="danger">EMAIL_MODE is live but SMTP_HOST or EMAIL_FROM is not set; emails will be logged as suppressed.</Alert>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <RecordSection title="Automatic email" hint="the kill switch">
            <div className="flex flex-col gap-4 px-5 py-4">
              <KeyValues items={[
                { label: 'Status', value: <Chip tone={enabled ? 'settled' : 'late'}>{enabled ? 'On' : 'Off'}</Chip> },
                { label: 'Delivery mode', value: mode || '…' },
                { label: 'From', value: emails.data?.from || <span className="muted">EMAIL_FROM not set</span> },
                { label: 'Reminder interval', value: interval ? `${interval} days` : '…' },
              ]} />
              <div>
                <Button
                  variant={enabled ? 'secondary' : 'default'}
                  size="sm"
                  className="h-8 px-4 text-[13px]"
                  onClick={toggle}
                >
                  {enabled ? 'Stop automatic email' : 'Enable automatic email'}
                </Button>
              </div>
              <p className="text-[11.5px]/[1.6] text-muted-foreground">
                Off stops every reminder and digest. They are still composed and logged, so you can see what would
                have gone out.
              </p>
            </div>
          </RecordSection>

          <RecordSection title="Send a test email" hint="same log and mode as the rest">
            <form onSubmit={sendTest} className="flex flex-col gap-4 px-5 py-4">
              <Field label="To">
                <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@company.com" required />
              </Field>
              <div>
                <Button type="submit" size="sm" className="h-8 px-4 text-[13px]" disabled={busy || !testTo}>Send test</Button>
              </div>
            </form>
          </RecordSection>
        </div>

        <RecordSection
          title="Scheduled jobs"
          hint="run by the worker on the schedule shown, in the business time zone"
        >
          <DataTable
            rows={jobs.data?.data ?? []}
            columns={[
              { key: 'name', header: 'Job', className: 'mono strong' },
              { key: 'description', header: 'What it does', className: 'wrap' },
              { key: 'cron', header: 'Schedule', className: 'mono small', render: (j) => `${j.cron} (${j.time_zone})` },
              {
                key: 'last', header: 'Last run', render: (j) => (j.last_run ? (
                  <>
                    <Chip tone={statusTone(j.last_run.status)}>{j.last_run.status}</Chip>
                    <div className="small muted">{ago(j.last_run.started_at)} · {j.last_run.started_by}</div>
                    {j.last_run.result && <div className="small muted">{summarise(j.last_run.result)}</div>}
                    {j.last_run.error && <div className="small text-late">{j.last_run.error}</div>}
                  </>
                ) : <span className="muted">never</span>),
              },
              {
                key: 'run', header: '', align: 'right',
                render: (j) => <Button variant="secondary" size="sm" className={ROW_BUTTON} disabled={busy} onClick={() => run(j.name)}>Run now</Button>,
              },
            ]}
          />
        </RecordSection>

        <RecordSection
          title="Email log"
          hint={`every email composed, newest first — ${number(rows.length)} shown`}
          action={
            <Select value={status || 'all'} onValueChange={(v) => setStatus(v === 'all' ? '' : v)}>
              <SelectTrigger size="sm" className="h-7 text-[12.5px]" aria-label="Filter the log by status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-[12.5px]">All statuses</SelectItem>
                {LOG_STATUSES.map((s) => <SelectItem key={s} value={s} className="text-[12.5px]">{s}</SelectItem>)}
              </SelectContent>
            </Select>
          }
        >
          <DataTable
            rows={rows}
            onRowClick={(r) => setOpen(r)}
            columns={[
              { key: 'created_at', header: 'When', className: 'small', render: (r) => ago(r.created_at) },
              { key: 'to_email', header: 'To', className: 'mono small' },
              { key: 'subject', header: 'Subject', className: 'wrap strong' },
              { key: 'template', header: 'Kind', render: (r) => <Chip>{r.template}</Chip> },
              {
                key: 'status', header: 'Status', render: (r) => (
                  <>
                    <Chip tone={statusTone(r.status)}>{r.status}</Chip>
                    {r.reason && <div className="small muted">{r.reason}</div>}
                    {r.error && <div className="small text-late">{r.error}</div>}
                  </>
                ),
              },
              { key: 'sent_by', header: 'By', className: 'small muted' },
            ]}
            empty={<Empty title="No emails yet" text="Run a job or send a test email; everything the tracker composes appears here." />}
          />
        </RecordSection>
      </div>

      {open && <EmailBody id={open.id} onClose={() => setOpen(null)} />}
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
    <Modal
      title={e?.subject || 'Email'}
      subtitle={e ? `To ${e.to_email}${e.cc ? `, cc ${e.cc}` : ''} · ${e.status}${e.reason ? ` (${e.reason})` : ''}` : ''}
      onClose={onClose}
      size="lg"
      footer={<Button variant="secondary" onClick={onClose}>Close</Button>}
    >
      {loading || !e
        ? <div className="skeleton" style={{ height: 120 }} />
        : <pre className="m-0 font-[inherit] whitespace-pre-wrap">{e.body_text}</pre>}
    </Modal>
  );
}
