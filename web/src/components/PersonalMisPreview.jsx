import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Field, Input, useToast } from './ui.jsx';
import { Chip } from './record.jsx';
import { Button } from './ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

/**
 * The personal daily MIS, before it is sent to anyone
 * (mis-report-sender-plan.md §C4 phase 3): one person's day as the
 * tracker and their mailbox record it, beside the report the AI writes
 * from it and what the checks dropped. Nothing here sends.
 */

const STATE = { ready: 'mailbox connected', no_mailbox: 'no mailbox connected', mailbox_needs_reconnect: 'mailbox needs reconnecting' };
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
      <Lines items={facts.acts} render={(a) => <><span className="mono">{a.time}</span> {label(a.kind)}{a.entity ? <> · <Ref to={a.link}>{label(a.entity)} {a.entity_id}</Ref></> : null}</>} />
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
  if (!ai) return <p className="text-[12.5px] text-muted-foreground">Press Write with AI to see the report the AI writes from these facts. It is one counted AI call (two when it has to be asked again).</p>;
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

export default function PersonalMisPreview() {
  const toast = useToast();
  const people = useFetch(() => api.raw('/mis-reports/personal/people'), []);
  const list = people.data?.data ?? [];
  const [who, setWho] = useState('');
  const [asOf, setAsOf] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);

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

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-5">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
        Personal daily MIS
        <Chip>Preview only</Chip>
      </div>
      <p className="text-[12.5px]/[1.6] text-secondary-text">
        One person's previous working day: what they did in the tracker, the email they sent and received with clients, and what is waiting on them, beside the report the AI writes from it. Every line the AI writes must cite one of these facts, nothing may be left out, and the counts must be the tracker's; a report that fails is not sent. Nothing is sent from here.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Person">
          <Select value={who} onValueChange={(v) => { setWho(v); setResult(null); }}>
            <SelectTrigger className="h-8 w-[280px] text-[13px]"><SelectValue placeholder="Choose a person" /></SelectTrigger>
            <SelectContent>
              {list.map((p) => <SelectItem key={p.id} value={String(p.id)} className="text-[13px]">{p.name} · {STATE[p.state] || p.state}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="As of" hint="The report covers the working day before">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="h-8 text-[12.5px]" />
        </Field>
        <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" disabled={busy !== null} onClick={() => load(false)}>{busy === 'facts' ? 'Gathering…' : 'Show the facts'}</Button>
        <Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy !== null} onClick={() => load(true)}>{busy === 'ai' ? 'Writing…' : 'Write with AI'}</Button>
      </div>
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
    </div>
  );
}
