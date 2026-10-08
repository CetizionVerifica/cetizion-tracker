import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { useShell } from '../components/shell/Shell.jsx';
import { useToast } from '../components/ui.jsx';
import { FailedCard, ListTable, LoadingPanel, Panel, PhoneRow, StateCard, useEntrance } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Notification centre (#44): what needs someone, newest first. The daily
 * job raises them and emails a digest; "Check now" runs the sweep (admins).
 * Every kind the server raises has a name; anything new still reads as words.
 */
const KINDS = {
  task_due: ['Task due', 'info'], task_overdue: ['Task overdue', 'late'], follow_up: ['Follow-up', 'info'],
  follow_up_escalated: ['Follow-up escalated', 'late'], approval: ['Approval', 'wait'], invoice_overdue: ['Overdue invoice', 'late'],
  renewal: ['Renewal', 'ok'], acceptance: ['Client acceptance', 'ok'], inbox: ['Inbox', 'info'], cost_alert: ['Project cost', 'late'],
  visit: ['Visit', 'info'], new_enquiry: ['New enquiry', 'info'], enquiry: ['New enquiry', 'info'], invoice_recorded: ['Invoice recorded', 'ok'],
  invoice_review: ['Invoice to review', 'wait'], po_review: ['PO to review', 'wait'], mailbox: ['Mailbox', 'info'], po_registered: ['PO registered', 'ok'],
  alert: ['System alert', 'late'], portal_action: ['Client portal', 'wait'], portal_upload: ['Client upload', 'info'], questionnaire: ['Questionnaire', 'info'],
  quotation_sent: ['Quotation sent', 'info'], expense_claim: ['Expense claim', 'wait'], travel_vendor: ['Travel desk', 'wait'],
  leave: ['Leave', 'info'], day_off: ['Day off', 'info'], manual: ['Note', 'info'], other: ['Other', 'info'],
};
function kindOf(n) {
  // One kind covers two things: a quotation about to lapse, and a certificate.
  if (n.kind === 'expiring') return n.entity === 'quotation' ? ['Expiring quotation', 'wait'] : ['Expiring certificate', 'wait'];
  if (KINDS[n.kind]) return KINDS[n.kind];
  const words = String(n.kind || 'Other').replace(/_/g, ' ');
  return [words.charAt(0).toUpperCase() + words.slice(1), 'info'];
}
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const whenShort = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export default function Notifications() {
  const { isAdmin, isHr, refetchBell } = useShell();
  const [show, setShow] = useState('unread');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/notifications${show === 'unread' ? '?unread=1' : ''}`), [show]);
  const rows = data?.data ?? [];
  const unread = rows.filter((n) => !n.read_at).length;
  const ref = useEntrance(Boolean(data) || Boolean(error));

  async function act(path, message) {
    setBusy(true);
    try { const r = await api.raw(path, { method: 'POST' }); if (message) toast(message(r.data), 'success'); refetch(); refetchBell?.(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function open(n) {
    if (!n.read_at) await api.raw(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    refetchBell?.();
    if (n.link) navigate(n.link); else refetch();
  }
  const title = (n) => (
    <button type="button" className={`text-left text-inherit hover:underline ${n.read_at ? 'font-medium' : 'font-bold'}`} onClick={() => open(n)}>{n.title}</button>
  );

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle={isHr
          ? 'Travel desk jobs and alerts addressed to you. A digest of what is unread goes out every morning.'
          : 'Tasks, follow-ups, approvals, overdue invoices, renewals, expiring quotations and certificates, client portal messages and questionnaires. A digest of what is unread goes out every morning.'}
        actions={<>
          <div className="mg-seg flex" role="radiogroup" aria-label="Show">
            <span className="mg-seg__thumb" aria-hidden="true" style={{ width: 78, transform: show === 'all' ? 'translateX(78px)' : 'none' }} />
            <button type="button" role="radio" aria-checked={show === 'unread'} onClick={() => setShow('unread')}>Unread</button>
            <button type="button" role="radio" aria-checked={show === 'all'} onClick={() => setShow('all')}>All</button>
          </div>
          {isAdmin && (
            <button type="button" className="mg-btn" disabled={busy} onClick={() => act('/notifications/sweep', (d) => (d.raised.length ? `${d.raised.length} new` : 'Nothing new'))}>
              <RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Check now
            </button>
          )}
          <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !unread} onClick={() => act('/notifications/read-all', (d) => `${d.marked} marked read`)}>Mark all read</button>
        </>}
      />
      <div className="app-page" ref={ref}>
        {error ? (
          <FailedCard title="Couldn’t load notifications" text="The server didn’t answer, so we can’t tell what’s new. This is not an all-clear; try again." onRetry={refetch} />
        ) : loading && !data ? <LoadingPanel /> : (
          <Panel label={show === 'all' ? 'All notifications' : 'Unread notifications'}>
            {rows.length ? (
              <ListTable
                bordered={false}
                label={show === 'all' ? 'All notifications' : 'Unread notifications'}
                rows={rows}
                rowClassName={(n) => (n.read_at ? 'is-read' : undefined)}
                columns={[
                  { key: 'kind', header: 'Kind', width: 180, render: (n) => { const [label, tone] = kindOf(n); return <span className={`mg-badge mg-badge--${tone}`}>{label}</span>; } },
                  { key: 'title', header: 'What', className: 'app-wrap', render: (n) => (
                    <span className="inline-flex items-baseline gap-2">
                      <span aria-hidden="true" className="size-[7px] flex-none -translate-y-px rounded-full" style={{ background: n.read_at ? 'transparent' : 'var(--caramel)' }} />
                      {title(n)}
                    </span>
                  ) },
                  { key: 'body', header: 'Details', className: 'app-say', render: (n) => n.body },
                  { key: 'when', header: 'When', width: 130, className: 'mg-num text-[12.5px] text-secondary-text', render: (n) => when(n.created_at) },
                  { key: 'act', header: '', aria: 'Mark read', width: 120, className: 'actions', render: (n) => !n.read_at && (
                    <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Mark read: ${n.title}`} onClick={() => act(`/notifications/${n.id}/read`)}>Mark read</button>
                  ) },
                ]}
                phone={(n) => {
                  const [label, tone] = kindOf(n);
                  return (
                    <PhoneRow onClick={() => open(n)} label={`${n.read_at ? '' : 'Unread. '}${n.title}`}
                      className={`grid-cols-[10px_minmax(0,1fr)_auto] gap-x-2.5 ${n.read_at ? 'text-secondary-text' : ''}`}
                      title={<span className={n.read_at ? 'font-medium' : 'font-bold'}>{n.title}</span>} wraps
                      amount={<span className="text-[12px] font-semibold text-muted-foreground">{whenShort(n.created_at)}</span>}
                      meta={n.body}
                      state={null}
                    >
                      <span aria-hidden="true" className="mt-[7px] size-2 rounded-full" style={{ gridColumn: 1, gridRow: '1 / span 3', background: n.read_at ? 'transparent' : 'var(--caramel)' }} />
                      <span className="mt-1" style={{ gridColumn: '2 / -1' }}><span className={`mg-badge mg-badge--${tone}`}>{label}</span></span>
                    </PhoneRow>
                  );
                }}
              />
            ) : (
              <StateCard inPanel bordered={false} title={show === 'unread' ? 'All caught up' : 'No notifications yet'}
                text={`New ones appear when the daily check runs${isAdmin ? ', or press Check now.' : '.'}`}>
                {show === 'unread' && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setShow('all')}>See all notifications</button>}
              </StateCard>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
