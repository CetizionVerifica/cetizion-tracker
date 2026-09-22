import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Badge, Card, Empty, Select, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Notification centre (#44): what needs someone, newest first. The daily
 * job raises them and emails a digest; "Check now" runs the sweep.
 */
const KINDS = {
  task_due: ['Task due', 'info'], task_overdue: ['Task overdue', 'danger'], follow_up: ['Follow-up', 'info'],
  approval: ['Approval', 'warning'], invoice_overdue: ['Overdue invoice', 'danger'], renewal: ['Renewal', 'success'],
  expiring: ['Expiring quotation', 'warning'], acceptance: ['Client acceptance', 'success'], inbox: ['Inbox', 'info'], cost_alert: ['Project cost', 'danger'], visit: ['Visit', 'info'],
};

export default function Notifications() {
  const [show, setShow] = useState('unread');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const { data, loading, refetch } = useFetch(() => api.raw(`/notifications${show === 'unread' ? '?unread=1' : ''}`), [show]);
  const rows = data?.data ?? [];

  async function act(path, message) {
    setBusy(true);
    try { const r = await api.raw(path, { method: 'POST' }); if (message) toast(message(r.data)); refetch(); }
    catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }
  async function open(n) {
    if (!n.read_at) await api.raw(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    if (n.link) navigate(n.link); else refetch();
  }

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Tasks, follow-ups, approvals, overdue invoices, renewals and expiring quotations. A digest of what is unread goes out every morning."
        actions={<>
          <Select value={show} placeholder={null} options={[{ value: 'unread', label: 'Unread' }, { value: 'all', label: 'All' }]} onChange={(e) => setShow(e.target.value)} />
          <button className="btn" disabled={busy} onClick={() => act('/notifications/sweep', (d) => `${d.raised.length} new`)}>Check now</button>
          <button className="btn btn--primary" disabled={busy || !rows.some((n) => !n.read_at)} onClick={() => act('/notifications/read-all', (d) => `${d.marked} marked read`)}>Mark all read</button>
        </>}
      />
      <div className="page stack">
        <Card flush>
          {loading && !data ? <div className="skeleton" style={{ height: 120 }} /> : !rows.length ? (
            <Empty icon="◔" title={show === 'unread' ? 'All caught up' : 'No notifications yet'} text="New ones appear when the daily check runs, or press Check now." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Kind</th><th>What</th><th>Details</th><th>When</th><th /></tr></thead>
                <tbody>
                  {rows.map((n) => {
                    const [label, tone] = KINDS[n.kind] || [n.kind, ''];
                    return (
                      <tr key={n.id} className={n.read_at ? 'muted' : ''} style={{ cursor: 'pointer' }} onClick={() => open(n)}>
                        <td><Badge tone={tone}>{label}</Badge></td>
                        <td className={n.read_at ? '' : 'strong'}>{n.title}</td>
                        <td className="small muted">{n.body}</td>
                        <td className="small">{new Date(n.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td>{!n.read_at && <button className="btn btn--ghost btn--sm" onClick={(e) => { e.stopPropagation(); act(`/notifications/${n.id}/read`); }}>Mark read</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
