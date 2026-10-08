import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, CircleAlert, FileText, MessageSquareText } from 'lucide-react';
import { Field, Modal, Textarea, useToast } from './ui.jsx';
import { Button } from './ui/button.tsx';
import { RecordPaymentDialog } from './actions.jsx';
import { EmailThreadDialog } from './EmailThread.jsx';
import { DialogError } from './money.jsx';
import { MgTabs } from './daily.jsx';
import { Tone } from './sales.jsx';
import { api } from '../lib/api.js';
import { useFetch, useMediaQuery } from '../lib/hooks.js';
import { ago, date, money } from '../lib/format.js';

/**
 * What clients said in the client portal (#198 §4): their queries, and the
 * payments they tell us they made. Each is a claim. A payment advice is
 * matched by recording the receipt it reports (the usual payment dialog,
 * filled from it); a query is answered in its inbox thread and marked
 * resolved. Either can be rejected with a reason the client sees.
 *
 * Out of the way until a client says something, unless a notification
 * linked here (?tab=portal); once shown it stays, so matching the last one
 * does not make the card vanish. A failed load says so, never "nothing".
 *
 * `companyId` narrows it to one client (the company's Client portal tab),
 * where it always shows.
 */
export function PortalAnswers({ onPaid, companyId, version = 0 }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const linked = params.get('tab') === 'portal';
  const wide = useMediaQuery('(min-width: 768px)');
  const [tab, setTab] = useState('payment_advice');
  const [match, setMatch] = useState(null);     // { advice, stage }
  const [settle, setSettle] = useState(null);   // { action, status }
  const [thread, setThread] = useState(null);
  const { data, error, refetch } = useFetch(() => api.raw('/portal-admin/actions?status=open'), [version]);
  const rows = (data?.data ?? []).filter((a) => !companyId || String(a.company_id) === String(companyId));
  const [shown, setShown] = useState(false);
  useEffect(() => { if (rows.length) setShown(true); }, [rows.length]);
  const ref = useRef(null);
  // Landing from the bell: bring the card into view once it is there.
  useEffect(() => { if (linked && ref.current) ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' }); }, [linked, Boolean(data)]);
  if (!companyId && !rows.length && !linked && !shown && !error) return null;
  const of = (kind) => rows.filter((a) => a.kind === kind);
  const advice = of('payment_advice');
  const queries = of('query');

  const who = (a) => [a.contact_name, a.contact_email].filter(Boolean).join(' · ');
  const client = (a) => (
    <><Link to={`/companies/${a.company_id}`} className="font-bold text-foreground no-underline">{a.company_name}</Link>{who(a) && <span className="app-sub2">{who(a)}</span>}</>
  );
  const poLink = (po) => <Link className="app-link" to={`/purchase-orders/${encodeURIComponent(po)}`}>PO {po}</Link>;
  const about = (a) => (a.invoices.length
    ? a.invoices.map((i) => <span key={i.id} className="block mg-num text-[12.5px]">{i.invoice_no} · {poLink(i.po_number)}</span>)
    : a.po_number ? <span className="block text-[12.5px]">No invoice named · {poLink(a.po_number)}</span> : <span className="mg-muted">—</span>);
  const sent = (a) => <span title={new Date(a.created_at).toLocaleString()} className="whitespace-nowrap text-secondary-text">{ago(a.created_at)}</span>;
  const done = (a) => new Set((a.payments || []).map((p) => p.stage_id));
  const matchButtons = (a, phone) => a.invoices.map((i) => (done(a).has(i.id)
    ? <Tone key={i.id} tone="ok">{a.invoices.length > 1 ? `${i.invoice_no} matched` : 'Matched'}</Tone>
    : <button key={i.id} type="button" className={phone ? 'mg-btn mg-btn--primary app-grow' : 'mg-btn mg-btn--primary mg-btn--sm'} onClick={() => setMatch({ advice: a, stage: i })}>{a.invoices.length > 1 ? `Match ${i.invoice_no}` : 'Match'}</button>));
  const waiting = rows.length;

  return (
    <section ref={ref} id="portal" className="mg-glass mg-glass--strong app-portal-card" data-a="rise" aria-labelledby="portal-t">
      <div className="app-portal-card__head">
        <span className="app-portal-card__mark" aria-hidden="true"><MessageSquareText strokeWidth={1.8} /></span>
        <h2 className="mg-panel__title" id="portal-t">From the client portal</h2>
        {!error && <Tone tone={waiting ? 'info' : 'ok'}>{waiting ? `${waiting} waiting on a person` : 'All settled'}</Tone>}
      </div>
      <p className="mg-panel__hint">
        {waiting || error
          ? 'What clients told us: queries to answer, and payments to check against the bank. Nothing here changes our figures until you record it.'
          : 'Every payment report and query from the portal has been answered. New ones show up here.'}
      </p>
      {error ? (
        <div className="px-4 pt-3.5 pb-5 sm:px-6">
          <div className="mg-banner mg-banner--late" role="alert">
            <CircleAlert aria-hidden="true" />
            <div className="mg-banner__body"><strong>Couldn&apos;t load what clients told us.</strong>Their payment reports and queries are safe in the portal. Try again, and nothing will be matched twice.</div>
            <button type="button" className="mg-btn mg-btn--sm self-center" onClick={refetch}>Try again</button>
          </div>
        </div>
      ) : (
        <>
          <MgTabs
            label="From the client portal"
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'payment_advice', label: 'Payment advice', count: advice.length },
              { key: 'query', label: 'Client queries', count: queries.length },
            ]}
          />
          {tab === 'payment_advice' ? (
            !advice.length ? (
              <Quiet title="No payments reported" text="When a client tells us they paid, it waits here to be checked." />
            ) : wide ? (
              <div className="mg-tablewrap app-panel__body">
                <table className="mg-table" aria-label="Payments clients report">
                  <thead><tr><th>Client</th><th>Invoices</th><th className="num">Reported</th><th>Paid on</th><th>Advice</th><th>Sent</th><th aria-label="Actions" /></tr></thead>
                  <tbody>
                    {advice.map((a) => (
                      <tr key={a.id}>
                        <td className="py-2.5">{client(a)}</td>
                        <td className="py-2.5">{about(a)}</td>
                        <td className="num font-bold">{money(a.amount, a.invoices[0]?.currency)}{Number(a.tds_amount) > 0 && <span className="app-sub2">+ TDS {money(a.tds_amount, a.invoices[0]?.currency)}</span>}</td>
                        <td className="mg-num">{date(a.paid_on)}{a.reference && <span className="app-sub2">{a.reference}</span>}</td>
                        <td>{a.document_id
                          ? <a className="app-link inline-flex items-center gap-1.5" href={api.documentUrl(a.document_id)} target="_blank" rel="noopener noreferrer" aria-label={`View the remittance from ${a.company_name}`}><FileText className="size-[15px]" strokeWidth={1.8} aria-hidden="true" />View</a>
                          : <span className="mg-muted">—</span>}</td>
                        <td>{sent(a)}</td>
                        <td><span className="app-acts">{matchButtons(a)}<button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setSettle({ action: a, status: 'rejected' })}>Reject</button></span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mg-rows app-panel__body">
                {advice.map((a) => (
                  <div key={a.id} className="mg-row">
                    <span className="mg-row__title">{a.company_name}</span>
                    <span className="mg-row__amount mg-num">{money(a.amount, a.invoices[0]?.currency)}</span>
                    <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{[a.invoices.map((i) => i.invoice_no).join(', ') || 'No invoice named', `paid ${date(a.paid_on)}`, a.reference].filter(Boolean).join(' · ')}</span>
                    <span className="mg-row__state"><Tone tone="info">To check</Tone></span>
                    <span className="app-pinv__btns">{matchButtons(a, true)}<button type="button" className="mg-btn mg-btn--ghost" onClick={() => setSettle({ action: a, status: 'rejected' })}>Reject</button></span>
                  </div>
                ))}
              </div>
            )
          ) : !queries.length ? (
            <Quiet title="No open queries" text="When a client asks something in the portal, it waits here for an answer." />
          ) : wide ? (
            <div className="mg-tablewrap app-panel__body">
              <table className="mg-table" aria-label="Client queries">
                <thead><tr><th>Client</th><th>About</th><th>Query</th><th>Sent</th><th aria-label="Actions" /></tr></thead>
                <tbody>
                  {queries.map((a) => (
                    <tr key={a.id}>
                      <td className="py-2.5">{client(a)}</td>
                      <td className="py-2.5">{about(a)}</td>
                      <td className="py-2.5 text-secondary-text" style={{ whiteSpace: 'normal' }}><div style={{ minWidth: 240, maxWidth: 420 }}>{a.note}</div></td>
                      <td>{sent(a)}</td>
                      <td><span className="app-acts">
                        {a.thread_id
                          ? <button type="button" className="mg-btn mg-btn--sm" onClick={() => setThread(a.thread_id)}>Reply</button>
                          : <Link className="mg-btn mg-btn--sm" to={`/companies/${a.company_id}`}>Open company</Link>}
                        <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setSettle({ action: a, status: 'resolved' })}>Mark resolved</button>
                        <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setSettle({ action: a, status: 'rejected' })}>Reject</button>
                      </span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="mg-rows app-panel__body">
              {queries.map((a) => (
                <div key={a.id} className="mg-row">
                  <span className="mg-row__title">{a.company_name}</span>
                  <span className="mg-row__amount text-[12.5px] text-muted-foreground">{ago(a.created_at)}</span>
                  <span className="mg-row__meta app-pinv__full" style={{ whiteSpace: 'normal', color: 'var(--text2)', fontSize: 13 }}>{a.note}</span>
                  <span className="mg-row__meta app-pinv__full" style={{ whiteSpace: 'normal' }}>{a.invoices.map((i) => i.invoice_no).join(', ') || (a.po_number ? `PO ${a.po_number}` : '')}</span>
                  <span className="app-pinv__btns">
                    <button type="button" className="mg-btn mg-btn--primary" onClick={() => setSettle({ action: a, status: 'resolved' })}>Mark resolved</button>
                    {a.thread_id
                      ? <button type="button" className="mg-btn app-grow" onClick={() => setThread(a.thread_id)}>Reply</button>
                      : <Link className="mg-btn app-grow" to={`/companies/${a.company_id}`}>Open company</Link>}
                    <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setSettle({ action: a, status: 'rejected' })}>Reject</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {match && (
        <RecordPaymentDialog
          stage={match.stage}
          advice={match.advice}
          onClose={() => setMatch(null)}
          onDone={() => { setMatch(null); refetch(); onPaid?.(); }}
        />
      )}
      {settle && <SettleDialog target={settle} onClose={() => setSettle(null)} onDone={() => { const s = settle; setSettle(null); refetch(); onPaid?.(); toast(s.status === 'resolved' ? 'Marked resolved' : 'Rejected; the client sees why', 'success'); }} />}
      {thread && <EmailThreadDialog threadId={thread} onClose={() => setThread(null)} />}
    </section>
  );
}

function Quiet({ title, text }) {
  return (
    <div className="mg-empty app-panel__body" style={{ padding: '28px 24px 30px' }}>
      <span className="mg-empty__mark bg-ok-soft text-ok"><Check className="size-6" strokeWidth={2} aria-hidden="true" /></span>
      <h3 className="mg-empty__title">{title}</h3>
      <p className="mg-empty__text">{text}</p>
    </div>
  );
}

/** Resolve a query, or reject a query or an advice. The client reads the reason in the portal. */
function SettleDialog({ target, onClose, onDone }) {
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const rejecting = target.status === 'rejected';
  const what = target.action.kind === 'payment_advice' ? 'payment advice' : 'query';
  const a = target.action;
  const sub = [a.company_name, a.invoices.map((i) => i.invoice_no).join(', ') || (a.po_number ? `PO ${a.po_number}` : null), a.kind === 'payment_advice' ? `${money(a.amount)} reported` : null].filter(Boolean).join(' · ');
  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await api.action(`/portal-admin/actions/${a.id}/resolve`, { status: target.status, resolution }); onDone(); }
    catch (err) { setError(err.fields ? Object.values(err.fields)[0] : err.message); setBusy(false); }
  }
  return (
    <Modal
      title={rejecting ? `Reject this ${what}` : 'Mark the query resolved'}
      subtitle={sub}
      onClose={onClose}
      size="sm"
      footer={<>
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy} className="max-sm:w-full">Cancel</Button>
        <Button type="submit" form="settle-form" variant={rejecting ? 'destructive' : 'default'} disabled={busy || (rejecting && !resolution.trim())} className="max-sm:w-full">
          {busy ? 'Saving…' : error ? 'Try again' : rejecting ? 'Reject' : 'Mark resolved'}
        </Button>
      </>}
    >
      <form id="settle-form" onSubmit={save} className="flex flex-col gap-4">
        <DialogError error={error} what={rejecting ? 'the rejection' : 'it'} />
        {a.note && <div className="app-mfacts"><MessageSquareText aria-hidden="true" /><span>“{a.note}”</span></div>}
        <Field label={rejecting ? 'Why' : 'Note for the client'} required={rejecting} hint="The client sees this in the portal.">
          <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus
            placeholder={rejecting ? (what === 'query' ? 'The rate is right: audits are at 18%.' : 'We have not received this payment; please share the UTR.') : 'Corrected invoice sent on 8 Oct.'} />
        </Field>
      </form>
    </Modal>
  );
}
