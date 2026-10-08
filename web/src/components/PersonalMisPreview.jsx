import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, ConfirmDialog, Field, Input, useToast } from './ui.jsx';
import { Chip } from './record.jsx';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ago, date } from '../lib/format.js';

/**
 * Reports → Scheduled reports → Personal daily MIS
 * (mis-report-sender-plan.md §B6): the on/off switch, who it goes for and
 * why not for the others, and for any one person the preview (their day as
 * the tracker and their mailbox record it, beside the report the AI writes
 * from it and what the checks dropped), the PDF, Send now and their runs.
 */

const STATE = { ready: 'mailbox connected', no_mailbox: 'no mailbox connected', mailbox_needs_reconnect: 'mailbox needs reconnecting', exempt: 'exempt' };
const STATE_CHIP = {
  ready: ['settled', 'will be sent'], exempt: [undefined, 'exempt'],
  no_mailbox: ['waiting', 'no mailbox'], mailbox_needs_reconnect: ['late', 'mailbox needs reconnecting'],
};
const COUNT_LABEL = {
  emails_sent: ['email sent', 'emails sent'], emails_received: ['email received', 'emails received'], calls: ['call or meeting', 'calls and meetings'],
  records_created: ['record created', 'records created'], tasks_done: ['task done', 'tasks done'], overdue: ['overdue', 'overdue'],
};
const counted = (k, n) => `${n} ${(COUNT_LABEL[k] || [k, k])[n === 1 ? 0 : 1]}`;
const SECTION = { actions: 'Actions taken', highlights: 'Highlights', commitments: 'Commitments', owed_replies: 'Replies owed', awaiting: 'Awaiting', not_in_tracker: 'In email, not in the tracker', waiting: 'Waiting on them', today: 'Today', for_management: 'For management' };

const label = (s) => String(s || '').replace(/[._]/g, ' ');

function Heading({ children }) {
  return <div className="mt-3 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase first:mt-0">{children}</div>;
}

function Lines({ items, render, empty = 'None' }) {
  if (!items?.length) return <div className="text-[12.5px] text-muted-foreground">{empty}</div>;
  return <ul className="flex flex-col gap-1 text-[12.5px]/[1.5] text-secondary-text">{items.map((x, i) => <li key={x.id || x.key || x.ref || x.thread_id || i}>{render(x)}</li>)}</ul>;
}

const Ref = ({ to, children }) => (to ? <Link to={to}>{children}</Link> : children);

function Facts({ facts }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(facts.counts).map(([k, v]) => <Chip key={k}>{counted(k, v)}</Chip>)}
      </div>
      {facts.redacted && <p className="text-[12px] text-muted-foreground">The text of {facts.person.name}'s mail is theirs: the AI reads it for their report, and it is not shown here.</p>}
      <Heading>What they did in the tracker</Heading>
      <Lines items={facts.acts} render={(a) => <><span className="mono">{a.time}</span> {label(a.kind)}{a.entity ? <> · <Ref to={a.link}>{a.record_name || `${label(a.entity)} ${a.entity_id}`}</Ref></> : null}</>} />
      <Heading>Emails they sent</Heading>
      <Lines items={facts.sent} render={(m) => <><span className="mono">{m.time}</span> to {m.to.join(', ') || 'a client'}{m.company ? ` (${m.company})` : ''}{m.subject ? `: ${m.subject}` : ''}{m.from_tracker ? ' · from the tracker' : ''}</>} />
      <Heading>Threads</Heading>
      <Lines items={facts.threads} render={(t) => <><Ref to={t.link}>{t.subject || '(no subject)'}</Ref>{t.company ? ` · ${t.company}` : ''} · {t.messages.length} message{t.messages.length === 1 ? '' : 's'}{t.waiting_on === 'them' ? ' · they owe a reply' : t.waiting_on === 'client' ? ' · awaiting the client' : ''}</>} />
      <Heading>Waiting on them</Heading>
      <Lines items={facts.waiting} render={(w) => <><Ref to={w.link}>{w.reference}</Ref> · {w.client} · {w.days} days{w.no_action_yesterday ? <> · <strong>no action yesterday</strong></> : null}</>} />
      <Heading>Their day ahead</Heading>
      <Lines items={facts.today_items} render={(t) => <>{t.kind === 'visit' ? `Visit ${t.time || ''}` : t.overdue ? 'Overdue task' : 'Task'}: {t.title}</>} />
      {facts.left_out?.length > 0 && (
        <>
          <Heading>Left out</Heading>
          <Lines items={facts.left_out} render={(l) => <>{l.count} · {l.reason}</>} />
        </>
      )}
    </div>
  );
}

function Report({ ai }) {
  if (!ai) return <p className="text-[12.5px] text-muted-foreground">Press Preview with AI to see the report the AI writes from these facts. It is one counted AI call (two when it has to be asked again).</p>;
  const r = ai.report;
  return (
    <div className="flex flex-col gap-1">
      {ai.ok
        ? <Alert tone="success"><span>The report passed the checks{ai.checks?.asked === 2 ? ', on the second asking' : ''}.</span></Alert>
        : <Alert tone="danger"><span><strong>This report would not be sent:</strong> {ai.why}.</span></Alert>}
      {r && (
        <>
          <Heading>Summary</Heading>
          <p className="text-[12.5px]/[1.6] text-secondary-text">{r.summary.text}</p>
          <Heading>{SECTION.actions}</Heading>
          <Lines items={r.actions} render={(a) => <><span className="mono">{a.at}</span> <Ref to={a.link}>{a.text}</Ref></>} />
          {['highlights', 'commitments', 'owed_replies', 'awaiting'].map((k) => (
            <div key={k}>
              <Heading>{SECTION[k]}</Heading>
              <Lines items={r.mailbox[k]} render={(x) => <Ref to={x.link}>{x.text}{x.due ? ` (by ${date(x.due)})` : ''}</Ref>} />
            </div>
          ))}
          <Heading>{SECTION.not_in_tracker}</Heading>
          <Lines items={r.not_in_tracker} render={(x) => <Ref to={x.link}>{x.text}</Ref>} />
          <Heading>{SECTION.waiting}</Heading>
          <Lines items={r.waiting} render={(x) => <><Ref to={x.link}>{x.text}</Ref>{x.no_action_yesterday ? <> · <strong>no action yesterday</strong></> : null}</>} />
          <Heading>{SECTION.today}</Heading>
          <Lines items={r.today} render={(x) => <Ref to={x.link}>{x.text}</Ref>} />
          <Heading>{SECTION.for_management}</Heading>
          <Lines items={r.for_management.map((text, i) => ({ id: String(i), text }))} render={(x) => x.text} />
        </>
      )}
      {(ai.checks?.dropped?.length > 0 || ai.checks?.missing?.length > 0) && (
        <>
          <Heading>What the checks took out</Heading>
          <Lines items={ai.checks.dropped} render={(d) => <>{SECTION[d.section] || d.section}: {d.why}{d.item?.text ? ` · "${d.item.text}"` : typeof d.item === 'string' ? ` · "${d.item}"` : ''}</>} />
          {ai.checks.missing?.length > 0 && <p className="text-[12.5px] text-late">Left out by the AI: {ai.checks.missing.join(', ')}</p>}
        </>
      )}
    </div>
  );
}

/** One person's runs, newest first. */
function PersonRuns({ userId, version }) {
  const runs = useFetch(() => api.raw(`/mis-reports/runs?kind=personal_daily&user_id=${userId}`), [userId, version]);
  const list = runs.data?.data ?? [];
  if (!list.length) return <div className="text-[12.5px] text-muted-foreground">No report has been sent for them yet.</div>;
  return (
    <ul className="flex flex-col gap-1 text-[12.5px] text-secondary-text">
      {list.slice(0, 10).map((r) => (
        <li key={r.id}>
          {date(r.period_from)} · {r.status === 'sent' ? <Chip tone="settled">sent</Chip> : r.status === 'failed' ? <Chip tone="late">failed</Chip> : r.sent_via === 'log' ? <Chip tone="waiting">logged only</Chip> : <Chip>{r.status}</Chip>}
          {' '}{ago(r.created_at)} · {r.triggered_by}{r.error ? ` · ${r.error}` : ''}
          {r.document_id && <> · <a href={`/api/mis-reports/runs/${r.id}/pdf`} target="_blank" rel="noreferrer">PDF</a></>}
        </li>
      ))}
    </ul>
  );
}

export default function PersonalMisCard({ enabled = false, recipients = { to: [], cc: [] }, onChanged = () => {} }) {
  const toast = useToast();
  const people = useFetch(() => api.raw('/mis-reports/personal/people'), []);
  const list = people.data?.data ?? [];
  const [who, setWho] = useState('');
  const [asOf, setAsOf] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const [sending, setSending] = useState(false);
  const [version, setVersion] = useState(0);
  const person = list.find((p) => String(p.id) === who) || null;
  const counts = list.reduce((acc, p) => ({ ...acc, [p.state]: (acc[p.state] || 0) + 1 }), {});
  const unseen = list.filter((p) => p.state === 'ready' && !p.daily_mis_notice_seen_at).length;

  async function load(ai) {
    if (!who) { toast('Choose a person first', 'danger'); return; }
    setBusy(ai ? 'ai' : 'facts');
    try {
      const params = new URLSearchParams();
      if (asOf) params.set('date', asOf);
      if (ai) params.set('ai', '1');
      const q = params.toString();
      setResult((await api.raw(`/mis-reports/personal/${who}/preview${q ? `?${q}` : ''}`)).data);
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }

  async function toggle() {
    setBusy('switch');
    try {
      await api.update('settings', 'personal_mis_enabled', { value: enabled ? 'false' : 'true' });
      toast(enabled ? 'The personal daily MIS is switched off' : 'The personal daily MIS is switched on', 'success');
      onChanged();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); }
  }

  async function send() {
    setBusy('send');
    try {
      const r = (await api.action(`/mis-reports/personal/${who}/send`, asOf ? { date: asOf } : {})).data;
      if (r.status === 'sent') toast(`${person?.name}'s report sent to ${r.recipients.join(', ')}${r.error ? ` (${r.error})` : ''}`, 'success');
      else toast(r.sent_via === 'log' ? `Logged only (${r.suppressed || 'delivery is off'}); nothing left the server` : `Not sent: ${r.error || r.skipped}`, r.sent_via === 'log' ? 'success' : 'danger');
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(null); setVersion((v) => v + 1); onChanged(); }
  }

  const pdfQuery = asOf ? `?date=${asOf}` : '';
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
            Personal daily MIS
            <Chip tone={enabled ? 'settled' : undefined}>{enabled ? 'On' : 'Off'}</Chip>
          </div>
          <div className="text-[12px] text-muted-foreground">Tuesday to Saturday at 08:40 IST, for the previous working day; tried again at 09:10 and 09:40</div>
          <p className="mt-1 text-[12.5px]/[1.6] text-secondary-text">
            Each sales and admin user's day, written by AI from their mailbox and their records in the tracker, sent from their own mailbox to the recipients below with them copied. Every line must cite one of their facts, nothing may be left out, and the counts must be the tracker's; a report that fails is not sent. No report for a weekend, a holiday or a day of leave.
          </p>
        </div>
        <Button variant={enabled ? 'secondary' : 'default'} size="sm" className="h-8 px-4 text-[13px]" disabled={busy === 'switch'} onClick={toggle}>
          {enabled ? 'Switch off' : 'Switch on'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 text-[12.5px]">
        {Object.entries(STATE_CHIP).filter(([k]) => counts[k]).map(([k, [tone, text]]) => <Chip key={k} tone={tone}>{counts[k]} {text}</Chip>)}
        {enabled && unseen > 0 && <span className="text-[12px] text-muted-foreground">{unseen} of them {unseen === 1 ? 'has' : 'have'} not yet seen the notice that it is sent.</span>}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Person">
          <Select value={who} onValueChange={(v) => { setWho(v); setResult(null); }}>
            <SelectTrigger className="h-8 w-[300px] text-[13px]"><SelectValue placeholder="Choose a person" /></SelectTrigger>
            <SelectContent>
              {list.map((p) => <SelectItem key={p.id} value={String(p.id)} className="text-[13px]">{p.name} · {STATE[p.state] || p.state}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="As of" hint="The report covers the working day before">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 text-[12.5px]" />
        </Field>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={busy !== null} onClick={() => load(false)}>{busy === 'facts' ? 'Gathering…' : 'Show the facts'}</Button>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={busy !== null} onClick={() => load(true)}>{busy === 'ai' ? 'Writing…' : 'Preview with AI'}</Button>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={!who} asChild={Boolean(who)}>
          {who ? <a href={`/api/mis-reports/personal/${who}/preview.pdf${pdfQuery}`} target="_blank" rel="noreferrer">Open the PDF</a> : <span>Open the PDF</span>}
        </Button>
        <Button size="sm" className="h-8 px-4 text-[13px]" disabled={!who || busy !== null} onClick={() => setSending(true)}>{busy === 'send' ? 'Sending…' : 'Send now'}</Button>
      </div>
      {person && (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <div className="text-[13px] font-medium text-foreground">{person.name}'s reports</div>
          {person.state === 'mailbox_needs_reconnect' && <Alert tone="warning"><span>Their mailbox needs reconnecting, so the schedule skips them; Send now goes by SMTP.</span></Alert>}
          <PersonRuns userId={person.id} version={version} />
        </div>
      )}
      {result && (
        <div className="grid gap-4 border-t border-border pt-3 @3xl:grid-cols-2">
          <div>
            <div className="mb-2 text-[13px] font-medium text-foreground">The facts · {result.facts.person.name} · {date(result.facts.day)}</div>
            <Facts facts={result.facts} />
          </div>
          <div>
            <div className="mb-2 text-[13px] font-medium text-foreground">The AI's report</div>
            <Report ai={result.ai} />
          </div>
        </div>
      )}
      {sending && person && (
        <ConfirmDialog
          tone="normal"
          title={`Send ${person.name}'s daily MIS now?`}
          message={`The AI writes it for the working day before ${asOf ? date(asOf) : 'today'}, and it goes from ${person.mailbox?.email || 'the SMTP sender'} to ${recipients.to.join(', ') || 'nobody — set the recipients first'}, copying ${[...recipients.cc, person.email].filter(Boolean).join(', ')}, with the PDF attached. A day already sent is sent again. A report that fails the checks is not sent.`}
          confirmLabel="Send"
          busy={busy === 'send'}
          onClose={() => setSending(false)}
          onConfirm={() => { setSending(false); send(); }}
        />
      )}
    </div>
  );
}
