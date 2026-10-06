import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Badge, Card, DataTable, DocumentLink, Empty, Field, Modal, Tabs, Textarea, useToast } from './ui.jsx';
import { RecordPaymentDialog } from './actions.jsx';
import { EmailThreadDialog } from './EmailThread.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { ago, date, money } from '../lib/format.js';

/**
 * What clients said in the client portal (#198 §4): their queries, and the
 * payments they tell us they made. Each is a claim. A payment advice is
 * matched by recording the receipt it reports (the usual payment dialog,
 * filled from it); a query is answered in its inbox thread and marked
 * resolved. Either can be rejected with a reason the client sees.
 *
 * Out of the way until a client says something, unless a notification
 * linked here (?tab=portal).
 */
export function PortalAnswers({ onPaid }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const linked = params.get('tab') === 'portal';
  const [tab, setTab] = useState('payment_advice');
  const [match, setMatch] = useState(null);     // { advice, stage }
  const [settle, setSettle] = useState(null);   // { action, status }
  const [thread, setThread] = useState(null);
  const { data, error, refetch } = useFetch(() => api.raw('/portal-admin/actions?status=open'), []);
  const rows = data?.data ?? [];
  // Once shown, it stays while the page is open, so matching the last one does not make it vanish.
  const [shown, setShown] = useState(false);
  useEffect(() => { if (rows.length) setShown(true); }, [rows.length]);
  if (!rows.length && !linked && !shown) return null;
  const of = (kind) => rows.filter((a) => a.kind === kind);
  const client = (a) => (
    <><Link to={`/companies/${a.company_id}`}>{a.company_name}</Link>{a.contact_name && <div className="small muted">{a.contact_name}{a.contact_email ? ` · ${a.contact_email}` : ''}</div>}</>
  );
  const about = (a) => (a.invoices.length
    ? a.invoices.map((i) => <div key={i.id} className="mono">{i.invoice_no} <span className="small muted">· <Link to={`/purchase-orders/${encodeURIComponent(i.po_number)}`}>{i.po_number}</Link></span></div>)
    : a.po_number ? <Link className="mono" to={`/purchase-orders/${encodeURIComponent(a.po_number)}`}>PO {a.po_number}</Link> : <span className="muted">—</span>);
  const when = { key: 'created_at', header: 'Sent', render: (a) => <span title={new Date(a.created_at).toLocaleString()}>{ago(a.created_at)}</span> };

  return (
    <Card flush title="From the client portal" hint="What clients told us: queries to answer, and payments to check against the bank. Nothing here changes our figures until you record it.">
      {error && <div className="p-4"><Alert tone="danger"><span>{error}</span></Alert></div>}
      <div className="px-4 pt-2">
        <Tabs active={tab} onChange={setTab} tabs={[
          { key: 'payment_advice', label: 'Payment advice', count: of('payment_advice').length },
          { key: 'query', label: 'Client queries', count: of('query').length },
        ]} />
      </div>
      {tab === 'payment_advice' ? (
        <DataTable
          rows={of('payment_advice')}
          empty={<Empty title="No payments reported" text="When a client tells us they paid, it waits here to be checked." />}
          columns={[
            { key: 'client', header: 'Client', className: 'strong', render: client },
            { key: 'invoices', header: 'Invoices', render: about },
            { key: 'amount', header: 'Reported', align: 'right', render: (a) => <>{money(a.amount, a.invoices[0]?.currency)}{Number(a.tds_amount) > 0 && <div className="small muted">+ TDS {money(a.tds_amount, a.invoices[0]?.currency)}</div>}</> },
            { key: 'paid_on', header: 'Paid on', render: (a) => <>{date(a.paid_on)}{a.reference && <div className="small muted mono">{a.reference}</div>}</> },
            { key: 'file', header: 'Advice', render: (a) => (a.document_id ? <DocumentLink id={a.document_id} name="Remittance" /> : <span className="muted">—</span>) },
            when,
            {
              key: 'act', header: '', align: 'right', render: (a) => {
                const done = new Set((a.payments || []).map((p) => p.stage_id));
                return (
                  <div className="table__actions">
                    {a.invoices.map((i) => (done.has(i.id)
                      ? <Badge key={i.id} tone="success">{a.invoices.length > 1 ? `${i.invoice_no} matched` : 'Matched'}</Badge>
                      : <button key={i.id} type="button" className="btn btn--sm btn--primary" onClick={() => setMatch({ advice: a, stage: i })}>{a.invoices.length > 1 ? `Match ${i.invoice_no}` : 'Match'}</button>))}
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSettle({ action: a, status: 'rejected' })}>Reject</button>
                  </div>
                );
              },
            },
          ]}
        />
      ) : (
        <DataTable
          rows={of('query')}
          empty={<Empty title="No open queries" />}
          columns={[
            { key: 'client', header: 'Client', className: 'strong', render: client },
            { key: 'about', header: 'About', render: about },
            { key: 'note', header: 'Query', className: 'wrap', render: (a) => a.note },
            when,
            {
              key: 'act', header: '', align: 'right', render: (a) => (
                <div className="table__actions">
                  {a.thread_id
                    ? <button type="button" className="btn btn--sm" onClick={() => setThread(a.thread_id)}>Reply</button>
                    : <Link className="btn btn--sm" to={`/companies/${a.company_id}`}>Open company</Link>}
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => setSettle({ action: a, status: 'resolved' })}>Resolved</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setSettle({ action: a, status: 'rejected' })}>Reject</button>
                </div>
              ),
            },
          ]}
        />
      )}

      {match && (
        <RecordPaymentDialog
          stage={match.stage}
          advice={match.advice}
          onClose={() => setMatch(null)}
          onDone={() => { setMatch(null); refetch(); onPaid?.(); }}
        />
      )}
      {settle && <SettleDialog target={settle} onClose={() => setSettle(null)} onDone={() => { setSettle(null); refetch(); toast(settle.status === 'resolved' ? 'Marked resolved' : 'Rejected; the client sees why', 'success'); }} />}
      {thread && <EmailThreadDialog threadId={thread} onClose={() => setThread(null)} />}
    </Card>
  );
}

/** Resolve a query, or reject a query or an advice. The client reads the reason in the portal. */
function SettleDialog({ target, onClose, onDone }) {
  const toast = useToast();
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const rejecting = target.status === 'rejected';
  const what = target.action.kind === 'payment_advice' ? 'payment advice' : 'query';
  async function save() {
    setBusy(true);
    try { await api.action(`/portal-admin/actions/${target.action.id}/resolve`, { status: target.status, resolution }); onDone(); }
    catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal
      title={rejecting ? `Reject this ${what}` : 'Mark the query resolved'}
      subtitle={target.action.company_name}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn--primary" onClick={save} disabled={busy || (rejecting && !resolution.trim())}>{rejecting ? 'Reject' : 'Resolved'}</button></>}
    >
      <Field label={rejecting ? 'Why' : 'Note for the client'} required={rejecting} hint="The client sees this in the portal">
        <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus
          placeholder={rejecting ? (what === 'query' ? 'The rate is right: audits are at 18%.' : 'We have not received this payment; please share the UTR.') : 'Corrected invoice sent on 8 Oct.'} />
      </Field>
    </Modal>
  );
}
