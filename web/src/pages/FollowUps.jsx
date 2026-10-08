import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { useAuth } from '../lib/auth.jsx';
import { FailedCard, FilterSelect, ListTable, LoadingPanel, MgTabs, Panel, PhoneRow, StateCard, plural, useEntrance } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date } from '../lib/format.js';

const KINDS = [
  { value: 'enquiry', label: 'Enquiries' },
  { value: 'quotation', label: 'Quotations' },
  { value: 'payment_stage', label: 'Invoices' },
];
const KIND_LABEL = { enquiry: 'Enquiry', quotation: 'Quotation', payment_stage: 'Invoice' };
const REASONS = {
  activity: 'Followed up', closed: 'Closed', paid: 'Paid', on_hold: 'On hold', promised: 'Promised to pay',
  rescheduled: 'Rescheduled', reassigned: 'Reassigned', disabled: 'Expired while off',
};
const TABS = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'escalated', label: 'Escalated' },
  { key: 'resolved', label: 'Resolved' },
];
const CARD = {
  waiting: ['Reminded, inside the grace period', 'The owner has until the respond-by date to log something on the record.'],
  escalated: ['Sent to management', 'Nothing was logged by the respond-by date, so management was told.'],
  resolved: ['Resolved in the last 30 days', 'How each one ended, and whether it went to management first.'],
};
const EMPTY = {
  waiting: ['Nothing waiting', 'Reminders appear here when the daily job sends them, until something is logged on the record.'],
  escalated: ['Nothing escalated', 'Every reminder was answered before its respond-by date.'],
  resolved: ['Nothing resolved yet', 'Follow-ups resolved in the last 30 days appear here.'],
};

/**
 * Follow-ups (docs/follow-up-escalation-plan.md §7.2): the reminders the
 * daily job sent, and the ones that went to management because nothing was
 * logged. A sales user sees their own; an admin sees everyone's.
 */
export default function FollowUps() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'waiting';
  const entity = params.get('entity') || '';
  const owner = params.get('owner') || '';
  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const query = new URLSearchParams({ status: tab, ...(entity && { entity }), ...(owner && isAdmin && { owner }) }).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/follow-ups?${query}`), [query]);
  const summary = useFetch(() => (isAdmin ? api.raw('/follow-ups/summary') : Promise.resolve(null)), [isAdmin]);
  const rows = data?.data ?? [];
  const ref = useEntrance(Boolean(data) || Boolean(error));

  // The owner filter offers the people in the summary, which is everyone
  // with a cycle in the last 30 days or still open.
  const owners = useMemo(() => (summary.data?.data ?? [])
    .filter((s) => s.user_id)
    .map((s) => ({ value: String(s.user_id), label: s.owner })), [summary.data]);
  const totals = useMemo(() => (summary.data?.data ?? []).reduce((t, s) => ({
    reminded: t.reminded + s.reminded, activity: t.activity + s.resolved_by_activity,
    escalated: t.escalated + s.escalated, rescheduled: t.rescheduled + s.rescheduled,
  }), { reminded: 0, activity: 0, escalated: 0, rescheduled: 0 }), [summary.data]);

  const quiet = (r) => (r.idle_days == null ? '—' : plural(r.idle_days, 'working day'));
  const columns = [
    { key: 'number', header: 'Record', render: (r) => <Link className="app-ref" to={withLog(r.link)} aria-label={`Open ${KIND_LABEL[r.entity]} ${r.number} and log a touch`}>{r.number}</Link> },
    { key: 'entity', header: 'Kind', render: (r) => KIND_LABEL[r.entity] },
    { key: 'client', header: 'Client', className: 'app-wrap', render: (r) => <><b>{r.client || '—'}</b>{r.detail && <span className="sub">{r.detail}</span>}</> },
    { key: 'owner', header: 'Owner', render: (r) => r.owner || <span className="mg-badge mg-badge--wait">No owner</span> },
    { key: 'due_on', header: 'Due', className: 'mg-num', render: (r) => date(r.due_on) },
    { key: 'reminded_at', header: 'Reminded', className: 'mg-num', render: (r) => (r.reminded_at ? date(r.reminded_at) : '—') },
    { key: 'respond_by', header: 'Respond by', className: 'mg-num font-bold', render: (r) => (r.respond_by ? <span className={tab === 'escalated' ? 'text-late' : ''}>{date(r.respond_by)}</span> : '—') },
    ...(tab === 'waiting' ? [{ key: 'idle', header: 'Quiet for', num: true, render: quiet }] : []),
    ...(tab === 'escalated' ? [{ key: 'esc', header: 'Escalated', render: (r) => <span className="mg-badge mg-badge--late">{r.escalation_count > 1 ? `${r.escalation_count} times` : 'Once'}</span> }] : []),
    ...(tab === 'resolved' ? [{
      key: 'resolved', header: 'Outcome', render: (r) => (
        <>
          <span className={`mg-badge ${r.resolved_reason === 'activity' ? 'mg-badge--ok' : 'mg-badge--plain'}`}>{REASONS[r.resolved_reason] || r.resolved_reason}</span>
          <span className="sub">{r.escalated_at ? 'after escalation · ' : ''}{date(r.resolved_at)}</span>
        </>
      ),
    }] : []),
  ];
  const phoneState = (r) => (tab === 'resolved'
    ? <span className={`mg-badge ${r.resolved_reason === 'activity' ? 'mg-badge--ok' : 'mg-badge--plain'}`}>{REASONS[r.resolved_reason] || r.resolved_reason}</span>
    : tab === 'escalated' ? <span className="mg-badge mg-badge--late">Escalated</span>
      : <span className="mg-badge mg-badge--wait">Waiting</span>);

  const tiles = [
    { key: 'reminded', label: 'Reminded', n: totals.reminded, meta: 'last 30 days', tab: 'waiting' },
    { key: 'activity', label: 'Followed up', n: totals.activity, meta: 'activity logged', tab: 'resolved', fg: 'text-ok' },
    { key: 'rescheduled', label: 'Rescheduled', n: totals.rescheduled, meta: 'date moved, no contact', tab: 'resolved' },
    { key: 'escalated', label: 'Escalated', n: totals.escalated, meta: 'to management', tab: 'escalated', fg: totals.escalated ? 'text-late' : '' },
  ];

  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle="Enquiries, quotations and overdue invoices the owner was reminded about. Log a call, email, meeting or note on the record by its respond-by date, or it goes to management."
      />
      <div className="app-page" ref={ref}>
        {isAdmin && summary.data && (
          <div className="flex flex-wrap gap-4">
            {tiles.map((t) => (
              <button key={t.key} type="button" className="mg-glass mg-tile flex-[1_1_150px] cursor-pointer text-left" data-a="rise"
                onClick={() => set('tab', t.tab === 'waiting' ? '' : t.tab)} aria-label={`${t.label}: ${t.n}, ${t.meta}. Open ${t.tab}`}>
                <span className="mg-label">{t.label}</span>
                <span key={t.n} className={`mg-tile__figure mg-num ${t.fg || ''}`} data-count={t.n}>{t.n}</span>
                <span className="mg-tile__foot">{t.meta}<span className="ml-auto font-bold text-caramel-text">{TABS.find((x) => x.key === t.tab).label} →</span></span>
              </button>
            ))}
          </div>
        )}

        {error ? (
          <FailedCard title="Couldn’t load follow-ups" text="The server didn’t answer, so we can’t show who was reminded. Nothing has been escalated because of this." onRetry={refetch} />
        ) : (
          <>
            <MgTabs label="Follow-ups by state" active={tab} onChange={(key) => set('tab', key === 'waiting' ? '' : key)}
              tabs={TABS.map((t) => ({ ...t, count: t.key === tab && data ? rows.length : undefined }))} />
            {loading && !data ? <LoadingPanel /> : (
              <Panel id="fu-t" title={CARD[tab][0]} hint={CARD[tab][1]}
                tools={<>
                  <FilterSelect label="Kind" value={entity} onChange={(v) => set('entity', v)} placeholder="Every kind" options={KINDS} />
                  {isAdmin && <FilterSelect label="Owner" value={owner} onChange={(v) => set('owner', v)} placeholder="Everyone" options={[...owners, { value: 'none', label: 'No owner' }]} />}
                </>}>
                {rows.length ? (
                  <ListTable
                    label="Follow-ups"
                    rows={rows}
                    rowKey={(r, i) => r.id ?? `${r.entity}-${r.number}-${i}`}
                    columns={columns}
                    phone={(r) => (
                      <PhoneRow to={withLog(r.link)} label={`${r.client || r.number}: open ${KIND_LABEL[r.entity]} ${r.number} and log a touch`}
                        title={r.client || r.number}
                        amount={<span className="text-[12.5px]">{r.respond_by ? `by ${date(r.respond_by)}` : ''}</span>}
                        meta={`${KIND_LABEL[r.entity]} ${r.number} · ${r.owner || 'No owner'}${tab === 'waiting' ? ` · quiet ${quiet(r)}` : ''}`}
                        state={phoneState(r)} />
                    )}
                  />
                ) : <StateCard inPanel title={EMPTY[tab][0]} text={EMPTY[tab][1]} />}
              </Panel>
            )}
            <p className="m-0 text-[12.5px] text-muted-foreground" data-a="rise">
              Looking for deals whose own next follow-up date has passed? That list is{' '}
              <Link to="/quotations?follow_up=overdue" className="font-bold text-caramel-text">Deals › Follow-up overdue</Link>.
            </p>
          </>
        )}
      </div>
    </>
  );
}

/** Open the record with its "Log a touch" dialog, as the email links do. */
function withLog(link) {
  if (!link) return '#';
  return `${link}${link.includes('?') ? '&' : '?'}log=1`;
}
