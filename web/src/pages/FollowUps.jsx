import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, DataTable, Empty, Select, Stat, Tabs } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
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
  const { data, loading, error } = useFetch(() => api.raw(`/follow-ups?${query}`), [query]);
  const summary = useFetch(() => (isAdmin ? api.raw('/follow-ups/summary') : Promise.resolve(null)), [isAdmin]);
  const rows = data?.data ?? [];

  // The owner filter offers the people in the summary, which is everyone
  // with a cycle in the last 30 days or still open.
  const owners = useMemo(() => (summary.data?.data ?? [])
    .filter((s) => s.user_id)
    .map((s) => ({ value: String(s.user_id), label: s.owner })), [summary.data]);
  const totals = useMemo(() => (summary.data?.data ?? []).reduce((t, s) => ({
    reminded: t.reminded + s.reminded, activity: t.activity + s.resolved_by_activity,
    escalated: t.escalated + s.escalated, rescheduled: t.rescheduled + s.rescheduled,
  }), { reminded: 0, activity: 0, escalated: 0, rescheduled: 0 }), [summary.data]);

  const columns = [
    { key: 'number', header: 'Record', className: 'strong', render: (r) => <Link className="mono" to={withLog(r.link)}>{r.number}</Link> },
    { key: 'entity', header: 'Kind', render: (r) => KIND_LABEL[r.entity] },
    { key: 'client', header: 'Client', className: 'wrap', render: (r) => <>{r.client || <span className="muted">—</span>}{r.detail && <div className="small muted">{r.detail}</div>}</> },
    { key: 'owner', header: 'Owner', render: (r) => r.owner || <Badge tone="warning">No owner</Badge> },
    { key: 'due_on', header: 'Due', render: (r) => date(r.due_on) },
    { key: 'reminded_at', header: 'Reminded', render: (r) => (r.reminded_at ? date(r.reminded_at) : <span className="muted">—</span>) },
    { key: 'respond_by', header: 'Respond by', render: (r) => (r.respond_by ? date(r.respond_by) : <span className="muted">—</span>) },
    ...(tab === 'resolved'
      ? [{ key: 'resolved', header: 'Outcome', render: (r) => <><Badge tone={r.resolved_reason === 'activity' ? 'success' : 'neutral'}>{REASONS[r.resolved_reason] || r.resolved_reason}</Badge>{r.escalated_at && <div className="small muted">after escalation</div>}<div className="small muted">{date(r.resolved_at)}</div></> }]
      : [
        { key: 'idle_days', header: 'Quiet for', align: 'right', render: (r) => (r.idle_days === null || r.idle_days === undefined ? '—' : `${r.idle_days} working day${r.idle_days === 1 ? '' : 's'}`) },
        { key: 'status', header: 'Status', render: (r) => (r.status === 'escalated'
          ? <><Badge tone="danger">Escalated</Badge>{r.escalation_count > 1 && <div className="small muted">{r.escalation_count} times</div>}</>
          : <Badge tone="warning">Waiting</Badge>) },
      ]),
  ];

  return (
    <>
      <PageHeader
        title="Follow-ups"
        subtitle="Enquiries, quotations and overdue invoices the owner was reminded about. Log a call, email, meeting or note on the record by its respond-by date, or it goes to management."
      />
      <div className="page stack">
        {error && <Alert tone="danger"><span>{error}</span></Alert>}
        {isAdmin && summary.data && (
          <div className="auto-grid--stats">
            <Stat label="Reminded" value={totals.reminded} meta="last 30 days" />
            <Stat label="Followed up" value={totals.activity} tone="success" meta="activity logged" />
            <Stat label="Rescheduled" value={totals.rescheduled} meta="date moved, no contact" />
            <Stat label="Escalated" value={totals.escalated} tone={totals.escalated ? 'danger' : ''} meta="to management" />
          </div>
        )}
        <Tabs active={tab} onChange={(key) => set('tab', key === 'waiting' ? '' : key)} tabs={TABS} />
        <Card
          flush
          title={tab === 'waiting' ? 'Reminded, inside the grace period' : tab === 'escalated' ? 'Sent to management' : 'Resolved in the last 30 days'}
          actions={
            <div className="card__actions">
              <Select value={entity} placeholder="Every kind" options={KINDS} onChange={(e) => set('entity', e.target.value)} aria-label="Kind" />
              {isAdmin && <Select value={owner} placeholder="Everyone" options={[...owners, { value: 'none', label: 'No owner' }]} onChange={(e) => set('owner', e.target.value)} aria-label="Owner" />}
            </div>
          }
        >
          <DataTable
            rows={rows}
            loading={loading && !data}
            label="Follow-ups"
            columns={columns}
            empty={<Empty title={tab === 'escalated' ? 'Nothing escalated' : tab === 'resolved' ? 'Nothing resolved yet' : 'Nothing waiting'} text={tab === 'waiting' ? 'Reminders appear here when the daily job sends them, until something is logged on the record.' : undefined} />}
          />
        </Card>
      </div>
    </>
  );
}

/** Open the record with its "Log a touch" dialog, as the email links do. */
function withLog(link) {
  if (!link) return '#';
  return `${link}${link.includes('?') ? '&' : '?'}log=1`;
}
