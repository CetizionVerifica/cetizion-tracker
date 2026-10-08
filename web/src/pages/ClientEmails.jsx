import { useState } from 'react';
import { Alert, DataTable, Empty, ErrorState, KeyValues, useToast } from '../components/ui.jsx';
import { Chip, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { SettingsPane } from './SettingsArea.jsx';
import { EmailBody } from './Emails.jsx';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Every kind of email the tracker can send to a client, why each one goes,
 * and the admin's hold on them (server/src/lib/clientEmails.js).
 *
 * The delivery mode and the kill switch on Emails & jobs stop the team's
 * email too. This pane stops only what would reach a client, so production
 * can be live for the team while clients hear nothing until an admin
 * releases them. A held email is still written to the log, which is the
 * table at the bottom: what would have gone out, to whom, and why it did not.
 */

const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';
const statusTone = (status) => (status === 'sent' ? 'settled' : status === 'failed' ? 'late' : 'waiting');
const statusWord = (status) => (status === 'suppressed' ? 'held' : status);

/** What a client email does right now, in one sentence. */
function deliverySentence(d) {
  if (d.hold_all) return { tone: 'warning', text: 'Every client email is held. Each one is logged below and none reaches a client.' };
  if (d.environment === 'staging') return { tone: 'info', text: 'This is staging, which never emails a client. The switches below take effect on production.' };
  if (!d.emails_enabled) return { tone: 'info', text: 'Automatic email is off (Emails & jobs), so nothing reaches a client whatever is set here.' };
  if (d.mode === 'log') return { tone: 'info', text: 'Delivery mode is log, so nothing reaches a client whatever is set here. Held emails are still marked as held.' };
  if (d.mode === 'sandbox') return { tone: 'info', text: 'Delivery mode is sandbox: only allowlisted addresses receive mail, so clients do not.' };
  return { tone: 'danger', text: `Delivery is live${d.environment === 'production' ? ' on production' : ''}: every kind below that is not held goes to the client.` };
}

export default function ClientEmails() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const overview = useFetch(() => api.raw('/client-emails'), []);
  const d = overview.data?.data;

  async function save(body, done) {
    setBusy(true);
    try {
      await api.raw('/client-emails', { method: 'PUT', body });
      toast(done, 'success');
      overview.refetch();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  if (overview.error) return <SettingsPane title="Client emails"><ErrorState message={overview.error} onRetry={overview.refetch} /></SettingsPane>;
  if (!d) return <SettingsPane title="Client emails"><div className="skeleton h-[240px] rounded-lg" /></SettingsPane>;

  const sentence = deliverySentence(d);
  const labels = Object.fromEntries(d.scenarios.map((s) => [s.key, s.label]));
  const heldCount = d.scenarios.filter((s) => s.held).length;

  return (
    <>
      <SettingsPane
        title="Client emails"
        description="Every email the tracker can send to a client and when it goes. Hold them all, or one kind at a time, and the team's own email carries on. A held email is logged here and is not sent later."
        actions={(
          <Button
            variant={d.hold_all ? 'outline' : 'default'}
            size="sm"
            className="h-8 px-4 text-[13px]"
            disabled={busy}
            onClick={() => save({ hold_all: !d.hold_all }, d.hold_all ? 'Client emails released' : 'Every client email is held')}
          >
            {d.hold_all ? 'Release client emails' : 'Hold all client emails'}
          </Button>
        )}
      >
        <Alert tone={sentence.tone}><span>{sentence.text}</span></Alert>

        <RecordSection title="Delivery" hint="what decides whether a client email leaves">
          <div className="px-5 py-4">
            <KeyValues items={[
              { label: 'Environment', value: d.environment },
              { label: 'Delivery mode', value: d.mode },
              { label: 'Automatic email', value: <Chip tone={d.emails_enabled ? 'settled' : 'late'}>{d.emails_enabled ? 'On' : 'Off'}</Chip> },
              { label: 'Client emails', value: <Chip tone={d.hold_all ? 'waiting' : heldCount ? 'info' : 'settled'}>{d.hold_all ? 'All held' : heldCount ? `${heldCount} of ${d.scenarios.length} kinds held` : 'None held'}</Chip> },
            ]} />
          </div>
        </RecordSection>

        <RecordSection title="What goes to clients" hint={`${d.scenarios.length} kinds · counts are the last 30 days`}>
          <DataTable
            label="Kinds of client email"
            rows={d.scenarios}
            columns={[
              {
                key: 'label', header: 'Email', render: (s) => (
                  <>
                    <div className="font-semibold text-foreground">{s.label}</div>
                    <div className="small muted">{s.automatic ? 'Sent on its own' : 'Sent when someone acts'}</div>
                  </>
                ),
              },
              {
                key: 'when', header: 'When it goes', className: 'wrap', render: (s) => (
                  <>
                    <div>{s.when}</div>
                    <div className="small muted">To: {s.to}</div>
                    {s.skips && <div className="small muted">Not sent for: {s.skips}</div>}
                  </>
                ),
              },
              {
                key: 'counts', header: 'Last 30 days', className: 'small', render: (s) => (
                  <>
                    <div className="num whitespace-nowrap">{number(s.last_30_days.sent)} sent</div>
                    <div className="num whitespace-nowrap">{number(s.last_30_days.held)} held</div>
                    {s.last_30_days.failed > 0 && <div className="num text-late">{number(s.last_30_days.failed)} failed</div>}
                    {s.last_at && <div className="muted">last {ago(s.last_at)}</div>}
                  </>
                ),
              },
              {
                key: 'held', header: 'Status', render: (s) => (
                  <Chip tone={s.held ? 'waiting' : 'settled'}>{s.held ? 'Held' : 'Goes out'}</Chip>
                ),
              },
              {
                key: 'action', header: '', align: 'right', render: (s) => (d.hold_all ? (
                  <span className="small muted">Held with all</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className={ROW_BUTTON}
                    disabled={busy}
                    onClick={() => save({ held: { [s.key]: !s.held_here } }, s.held_here ? `${s.label} released` : `${s.label} held`)}
                  >
                    {s.held_here ? 'Release' : 'Hold'}
                  </Button>
                )),
              },
            ]}
          />
        </RecordSection>

        <RecordSection title="Recent client emails" hint={`sent, held or failed, newest first · ${number(d.recent.length)} shown`}>
          <DataTable
            label="Recent client emails"
            rows={d.recent}
            onRowClick={(r) => setOpen(r)}
            columns={[
              { key: 'created_at', header: 'When', className: 'small', render: (r) => ago(r.created_at) },
              { key: 'to_email', header: 'To', className: 'mono small' },
              { key: 'subject', header: 'Subject', className: 'wrap strong' },
              { key: 'template', header: 'Kind', render: (r) => <Chip>{labels[r.template] || r.template}</Chip> },
              {
                key: 'status', header: 'Status', render: (r) => (
                  <>
                    <Chip tone={statusTone(r.status)}>{statusWord(r.status)}</Chip>
                    {r.reason && <div className="small muted">{r.reason}</div>}
                    {r.error && <div className="small text-late">{r.error}</div>}
                  </>
                ),
              },
              { key: 'sent_by', header: 'By', className: 'small muted' },
            ]}
            empty={<Empty title="No client emails yet" text="Each email the tracker composes for a client appears here, whether it went out or was held." />}
          />
        </RecordSection>
      </SettingsPane>

      {open && <EmailBody id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}
