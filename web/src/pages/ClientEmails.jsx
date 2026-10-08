import { useState } from 'react';
import { useToast } from '../components/ui.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard } from '../components/daily.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
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
 *
 * Everyone but HR sees it. A sales user sees the list read-only, with the
 * emails and counts for the records they own; an admin sees every owner's,
 * can narrow the list to one owner, and is the only one who can hold.
 *
 * Mocha Glass: the Emails & jobs pane's pieces (banner, facts panel, glass
 * tables that turn into rows on a phone).
 */

const statusTone = (status) => (status === 'sent' ? 'ok' : status === 'failed' ? 'late' : 'wait');
const statusWord = (status) => (status === 'suppressed' ? 'Held' : status ? status.charAt(0).toUpperCase() + status.slice(1) : '');
const DESCRIPTION = 'Every email the tracker can send to a client and when it goes.';

/** What a client email does right now, in one sentence, as a banner tone. */
function deliverySentence(d) {
  if (d.hold_all) return { tone: 'wait', text: 'Every client email is held. Each one is logged below and none reaches a client.' };
  if (d.environment === 'staging') return { tone: 'info', text: 'This is staging, which never emails a client. The switches below take effect on production.' };
  if (!d.emails_enabled) return { tone: 'info', text: 'Automatic email is off (Emails & jobs), so nothing reaches a client whatever is set here.' };
  if (d.mode === 'log') return { tone: 'info', text: 'Delivery mode is log, so nothing reaches a client whatever is set here. Held emails are still marked as held.' };
  if (d.mode === 'sandbox') return { tone: 'info', text: 'Delivery mode is sandbox: only allowlisted addresses receive mail, so clients do not.' };
  return { tone: 'late', text: `Delivery is live${d.environment === 'production' ? ' on production' : ''}: every kind below that is not held goes to the client.` };
}

export default function ClientEmails() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [owner, setOwner] = useState('');
  const overview = useFetch(() => api.raw(`/client-emails${owner ? `?owner=${owner}` : ''}`), [owner]);
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

  if (overview.error) {
    return (
      <SettingsPane title="Client emails" description={DESCRIPTION}>
        <FailedCard title="Couldn’t load the client emails" text={`${overview.error} Nothing has changed.`} onRetry={overview.refetch} />
      </SettingsPane>
    );
  }
  if (!d) return <SettingsPane title="Client emails" description={DESCRIPTION}><LoadingPanel rows={4} /></SettingsPane>;

  const sentence = deliverySentence(d);
  const labels = Object.fromEntries(d.scenarios.map((s) => [s.key, s.label]));
  const heldCount = d.scenarios.filter((s) => s.held).length;
  const ownerName = d.owners.find((o) => String(o.id) === owner)?.name;
  const canHoldOne = d.can_change && !d.hold_all;
  const holdButton = (s) => (
    <button
      type="button"
      className="mg-btn mg-btn--sm"
      disabled={busy}
      aria-label={`${s.held_here ? 'Release' : 'Hold'} ${s.label}`}
      onClick={() => save({ held: { [s.key]: !s.held_here } }, s.held_here ? `${s.label} released` : `${s.label} held`)}
    >
      {s.held_here ? 'Release' : 'Hold'}
    </button>
  );
  const state = (s) => <Tone tone={s.held ? 'wait' : 'ok'}>{s.held ? 'Held' : 'Goes out'}</Tone>;
  const counts = (s) => `${number(s.last_30_days.sent)} sent · ${number(s.last_30_days.held)} held${s.last_30_days.failed > 0 ? ` · ${number(s.last_30_days.failed)} failed` : ''}`;

  return (
    <>
      <SettingsPane
        title="Client emails"
        description={d.can_change
          ? 'Every email the tracker can send to a client and when it goes. Hold them all, or one kind at a time, and the team’s own email carries on. A held email is logged here and is not sent later.'
          : 'Every email the tracker can send to a client and when it goes, with the ones sent for the records you own. Only an admin can hold them.'}
        actions={d.can_change && (
          <button
            type="button"
            className={d.hold_all ? 'mg-btn' : 'mg-btn mg-btn--primary'}
            disabled={busy}
            onClick={() => save({ hold_all: !d.hold_all }, d.hold_all ? 'Client emails released' : 'Every client email is held')}
          >
            {d.hold_all ? 'Release client emails' : 'Hold all client emails'}
          </button>
        )}
      >
        <MoneyBanner tone={sentence.tone} role={sentence.tone === 'late' ? 'alert' : 'status'}>{sentence.text}</MoneyBanner>

        <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby="ce-delivery">
          <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id="ce-delivery">Delivery</h2><span className="mg-panel__hint">What decides whether a client email leaves.</span></div>
          <dl className="mg-facts">
            <div><dt>Environment</dt><dd>{d.environment}</dd></div>
            <div><dt>Delivery mode</dt><dd>{d.mode}</dd></div>
            <div><dt>Automatic email</dt><dd><Tone tone={d.emails_enabled ? 'ok' : 'late'}>{d.emails_enabled ? 'On' : 'Off'}</Tone></dd></div>
            <div><dt>Client emails</dt><dd><Tone tone={d.hold_all ? 'wait' : heldCount ? 'info' : 'ok'}>{d.hold_all ? 'All held' : heldCount ? `${heldCount} of ${d.scenarios.length} kinds held` : 'None held'}</Tone></dd></div>
          </dl>
        </section>

        <Panel id="ce-kinds" title="What goes to clients" hint={`${d.scenarios.length} kinds. Counts are the last 30 days${d.only_mine ? ', your records' : ownerName ? `, ${ownerName}’s records` : ''}.`}>
          <ListTable
            label="Kinds of client email"
            rows={d.scenarios}
            rowKey={(s) => s.key}
            columns={[
              { key: 'label', header: 'Email', render: (s) => <><b>{s.label}</b><span className="set-sub">{s.automatic ? 'Sent on its own' : 'Sent when someone acts'}</span></> },
              { key: 'when', header: 'When it goes', className: 'app-wrap', width: '38%', render: (s) => <>{s.when}<span className="set-sub" title={s.skips ? `Not sent for: ${s.skips}` : undefined}>To: {s.to}</span></> },
              { key: 'counts', header: 'Last 30 days', render: (s) => <span className="whitespace-nowrap"><span className="mg-num">{counts(s)}</span>{s.last_at && <span className="set-sub">last {ago(s.last_at)}</span>}</span> },
              { key: 'held', header: 'Status', render: (s) => <span className="ce-status">{state(s)}{canHoldOne && holdButton(s)}</span> },
            ]}
            phone={(s) => (
              <PhoneRow title={s.label} meta={[s.when, `To: ${s.to}`, counts(s)].join(' · ')} state={state(s)} wraps>
                {canHoldOne && <span className="set-rowacts">{holdButton(s)}</span>}
              </PhoneRow>
            )}
          />
          {d.can_change && d.hold_all && (
            <div className="set-panel-foot"><span className="text-[12.5px] text-secondary-text">Every kind is held while all client emails are held. Release them to hold one kind at a time.</span></div>
          )}
        </Panel>

        <Panel
          id="ce-recent"
          title="Recent client emails"
          hint={`Newest first. ${number(d.recent.length)} shown${d.only_mine ? ', on records you own' : ''}. Open one to read it.`}
          tools={d.can_change && d.owners.length > 0 && (
            <div className="set-tools">
              <span className="mg-select-wrap">
                <select className="mg-select" aria-label="Show the emails on one owner’s records" value={owner} onChange={(e) => setOwner(e.target.value)}>
                  <option value="">All owners</option>
                  {d.owners.map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
                </select>
              </span>
            </div>
          )}
        >
          {d.recent.length === 0 ? (
            <StateCard inPanel tone="plain" title="No client emails yet" text={d.only_mine ? 'Emails to clients on the records you own appear here, whether they went out or were held.' : 'Each email the tracker composes for a client appears here, whether it went out or was held.'} />
          ) : (
            <ListTable
              label="Recent client emails"
              rows={d.recent}
              columns={[
                { key: 'created_at', header: 'When', width: '110px', render: (r) => <span className="whitespace-nowrap text-secondary-text">{ago(r.created_at)}</span> },
                { key: 'subject', header: 'Email', className: 'app-wrap', width: '36%', render: (r) => <><button type="button" className="set-mail-subject" onClick={() => setOpen(r)}>{r.subject}</button><span className="set-sub">{labels[r.template] || r.template} · to <span className="break-all">{r.to_email}</span></span></> },
                ...(d.can_change ? [{ key: 'owners', header: 'Owner', render: (r) => (r.owners?.length ? <span className="whitespace-nowrap">{r.owners.join(', ')}</span> : <span className="text-muted-foreground">No owner</span>) }] : []),
                { key: 'status', header: 'Status', className: 'app-wrap--sm', render: (r) => <><Tone tone={statusTone(r.status)}>{statusWord(r.status)}</Tone>{r.reason && <span className="set-sub" title={r.reason}>{r.reason}</span>}{r.error && <span className="set-sub font-semibold text-late" title={r.error}>{r.error}</span>}</> },
                { key: 'sent_by', header: 'By', render: (r) => <span className="whitespace-nowrap text-secondary-text">{r.sent_by}</span> },
              ]}
              phone={(r) => (
                <PhoneRow title={r.subject} amount={ago(r.created_at)} meta={[labels[r.template] || r.template, `to ${r.to_email}`, r.reason || r.error].filter(Boolean).join(' · ')} state={<Tone tone={statusTone(r.status)}>{statusWord(r.status)}</Tone>} onClick={() => setOpen(r)} label={`Open the email: ${r.subject}`} wraps />
              )}
            />
          )}
        </Panel>
      </SettingsPane>

      {open && <EmailBody id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}
