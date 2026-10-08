import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  CircleAlert, CircleCheck, Clock, FileText, Pencil, Plus, Trash2, TriangleAlert,
} from 'lucide-react';
import {
  ConfirmDialog, DocumentLink, Field, Input, Modal, Select, Textarea, useToast,
} from '../components/ui.jsx';
import { flowSteps, RecordFlow, RecordMenuItem, RecordPage } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { ConvertQuotationDialog } from '../components/actions.jsx';
import { RegisterPoDialog } from '../components/RegisterPoDialog.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { AcceptanceLinks, LinkDialog } from '../components/AcceptanceLinks.jsx';
import { QuestionnaireTab } from '../components/QuestionnaireCard.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { plural } from '../components/daily.jsx';
import { RecordState } from '../components/travel.jsx';
import { RecordTabs, Sec, Tone, useTab } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { invalidateLookups, useFetch, useLookups, useMediaQuery } from '../lib/hooks.js';
import { withEmailResult } from '../lib/emailResult.js';
import { date, money } from '../lib/format.js';
import { dealTone, quotationFields } from './Quotations.jsx';
import { LostDialog } from './Pipeline.jsx';

/**
 * One deal, as the Wave 3 canvas draws it.
 *
 * The header used to carry eight buttons — Send, Client accepted, Revise,
 * Ask approval, Register PO, Project only, Edit and PDF — which made every
 * one of them equally easy to press and none of them obviously the right
 * one. The answer is a ladder you read in a glance, one sentence saying
 * where the deal is, and one button that moves it on. The rest are in the
 * ⋯ menu, and the small print under the button names them so nobody hunts.
 *
 * The ladder is INFERRED, not recorded. The app keeps only the live
 * pipeline stage and `stage_changed_at`, so there is no history to read a
 * deal's path from. Every rung is therefore derived from a fact that is
 * actually stored — an enquiry row, `sent_at`, a purchase order, money
 * invoiced, money received. The design's second rung is "Qualified", but
 * nothing here records qualification, so this one says "Quoted", which is
 * true of every quotation that has a priced line.
 */

const trim = (n) => String(Math.round(Number(n) * 100) / 100);

/**
 * The tax part of the totals line: CGST and SGST within the state, IGST
 * outside it (#23), zero-rated for an export. A quotation loaded before the
 * split existed still shows its single stored figure rather than nothing.
 */
function gstSummary(gst, taxTotal, cur) {
  if (!gst?.bands?.length) return `GST ${money(taxTotal, cur)}`;
  if (gst.zero_rated) return 'GST zero-rated (export)';
  if (!gst.intra) return gst.bands.map((b) => `IGST ${trim(b.rate)}% ${money(b.igst, cur)}`).join(' · ');
  return gst.bands.map((b) => `CGST ${trim(b.rate / 2)}% ${money(b.cgst, cur)} · SGST ${trim(b.rate / 2)}% ${money(b.sgst, cur)}`).join(' · ');
}

const OPEN = ['Draft', 'Submitted', 'Under Negotiation', 'On Hold'];

export default function QuotationDetail() {
  const { key } = useParams();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const lookups = useLookups();
  const wide = useMediaQuery('(min-width: 768px)');
  const [editing, setEditing] = useState(false);
  const [line, setLine] = useState(null);         // 'new' | line record
  const [removing, setRemoving] = useState(null);
  const [revising, setRevising] = useState(false);
  const [sending, setSending] = useState(false);
  const [linking, setLinking] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [deciding, setDeciding] = useState(null);   // 'approved' | 'rejected'
  const [losing, setLosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [linksVersion, setLinksVersion] = useState(0);

  const { data, loading, fresh, error, errorStatus, refetch } = useFetch(() => api.raw(`/quotations/${encodeURIComponent(key)}/full`), [key]);
  const q = data?.data;
  const acceptances = useFetch(() => api.raw(`/quotations/${encodeURIComponent(key)}/acceptances`), [key, q?.revision, q?.accepted_at, linksVersion]);
  const links = acceptances.data?.data ?? [];

  const tabKeys = ['lines', 'details', 'acceptance', ...(q?.revisions?.length ? ['revisions'] : []), ...(q?.enquiry?.enquiry_no ? ['questionnaire'] : []), 'activity'];
  const [tab, setTab] = useTab(tabKeys);

  async function act(path, body, okMessage) {
    setBusy(true);
    try {
      const { data: r } = await api.action(`/quotations/${encodeURIComponent(key)}/${path}`, body);
      toast(typeof okMessage === 'function' ? okMessage(r) : okMessage, 'success');
      invalidateLookups();
      refetch();
      return r;
    } catch (err) {
      toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger');
      return null;
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <RecordState parent="Deals" parentTo="/quotations" crumb={key} noun="deal" missing={errorStatus === 404} error={error} onRetry={refetch} />;
  }
  if ((loading && !fresh) || !q) {
    return (
      <div className="app-page" aria-busy="true" aria-label="Loading the deal">
        <div className="app-rec__bar"><span className="mg-skel" style={{ height: 14, width: 160 }} /></div>
        <div className="mg-glass mg-glass--strong mg-record"><span className="mg-skel" style={{ height: 12, width: 180 }} /><span className="mg-skel" style={{ height: 32, width: '50%' }} /><span className="mg-skel" style={{ height: 44 }} /></div>
        <div className="mg-glass mg-glass--strong app-flow"><span className="mg-skel" style={{ height: 34 }} /><span className="mg-skel" style={{ height: 18, width: '70%' }} /></div>
        <div className="mg-glass mg-glass--strong app-flow"><span className="mg-skel" style={{ height: 200 }} /></div>
      </div>
    );
  }

  const cur = q.currency;
  const open = OPEN.includes(q.status);
  const won = q.status === 'Won - PO Received';
  const lost = /lost/i.test(q.status || '');
  const pending = q.approval_status === 'pending';
  const rejected = q.approval_status === 'rejected';
  const approvalBlocked = pending || rejected;
  const total = q.line_count ? q.total : q.quotation_value;
  const beforeGst = q.line_count ? q.subtotal : q.quotation_value;
  const stage = (lookups.pipeline_stages || []).find((s) => String(s.id) === String(q.stage_id));
  const lostStage = (lookups.pipeline_stages || []).find((s) => s.type === 'lost');
  const probability = q.probability ?? stage?.probability;

  const invoiced = q.purchase_orders.reduce((sum, p) => sum + Number(p.total_invoiced || 0), 0);
  const received = q.purchase_orders.reduce((sum, p) => sum + Number(p.total_received || 0), 0);
  const ordered = q.purchase_orders.reduce((sum, p) => sum + Number(p.po_value || 0), 0);

  // Six facts the database actually holds, in the order they happen.
  const reached = [
    { label: 'Enquiry', done: Boolean(q.enquiry), since: q.enquiry?.enquiry_no },
    { label: 'Quoted', done: q.line_count > 0 || Number(q.quotation_value) > 0, since: q.line_count ? plural(q.line_count, 'line') : undefined },
    { label: 'Sent', done: Boolean(q.sent_at), since: q.sent_at ? date(q.sent_at) : rejected ? 'discount rejected' : pending ? 'approval first' : undefined, blocked: rejected },
    { label: 'Won, PO in', done: q.purchase_orders.length > 0, since: q.purchase_orders.length ? plural(q.purchase_orders.length, 'PO') : q.accepted_at ? `accepted ${date(q.accepted_at)}` : undefined },
    { label: 'Invoiced', done: invoiced > 0, since: invoiced > 0 ? money(invoiced, cur, { compact: true }) : undefined },
    { label: 'Collected', done: ordered > 0 && received >= ordered - 0.5, since: received > 0 ? money(received, cur, { compact: true }) : undefined },
  ];
  const steps = flowSteps(reached);

  function verdict() {
    if (pending) {
      return `The discount is waiting for approval${q.approval_reason ? `: ${q.approval_reason}` : ''}. Nothing goes to the client until that is decided.`;
    }
    if (rejected) {
      return `The discount was rejected${q.approved_by ? ` by ${q.approved_by}` : ''}${q.approval_note ? `: ${q.approval_note}` : ''}. Revise the discount or the terms, then ask again.`;
    }
    // Once an order exists the deal has moved past the quotation, so what
    // happened to the money is the headline.
    if (won || q.purchase_orders.length) {
      if (!q.purchase_orders.length) return q.project_id ? `Won, with ${q.project_id} open; no purchase order is registered against it yet.` : 'Won, but no purchase order is registered against it yet, and there is no project.';
      if (invoiced === 0) return `${money(ordered, cur)} ordered across ${plural(q.purchase_orders.length, 'purchase order')}, none of it invoiced yet.`;
      if (received < ordered - 0.5) return `${money(invoiced, cur)} invoiced and ${money(received, cur)} collected of ${money(ordered, cur)} ordered.`;
      return 'Everything ordered against this deal has been invoiced and collected.';
    }
    if (lost) return `This deal was lost${q.lost_reason ? `: ${q.lost_reason}` : ''}. Revise it to reopen it as a draft.`;
    if (!q.sent_at) {
      return q.line_count
        ? `Not sent yet. ${plural(q.line_count, 'line')} totalling ${money(total, cur)}.`
        : 'Not sent yet, and nothing is priced: the quoted value typed on the form is all that stands behind it.';
    }
    if (q.expired && open) {
      return `Sent on ${date(q.quotation_date)}, and it passed its validity date on ${date(q.valid_until)}. Revise it to reopen with a fresh date, or mark it lost.`;
    }
    if (open) {
      const waiting = q.accepted_at
        ? `${q.accepted_by_name || 'The client'} accepted it on ${date(q.accepted_at)}, so it is waiting on the purchase order.`
        : 'Waiting on the client to accept or send a purchase order.';
      return `Sent on ${date(q.quotation_date)}${q.valid_until ? `, valid until ${date(q.valid_until)}` : ''}. ${waiting}`;
    }
    return `This deal is ${q.status}.`;
  }

  /**
   * The single move, chosen by what is actually blocking the deal, so the
   * button agrees with the sentence beside it: a rejected discount leads to
   * Revise, never to Register the PO.
   */
  const move = pending ? (isAdmin ? 'approve' : null)
    : rejected ? 'revise'
    : open && !q.sent_at ? 'send'
    : open && !q.purchase_orders.length ? 'register'
    : won && !q.project_id ? 'project'
    : null;

  const MOVES = {
    approve: { label: 'Approve the discount', onClick: () => setDeciding('approved') },
    revise: { label: 'Revise', onClick: () => setRevising(true) },
    send: { label: 'Send to the client', onClick: () => setSending(true) },
    register: { label: 'Register the PO', onClick: () => setRegistering(true) },
    project: { label: 'Create the project', onClick: () => setConverting(true) },
  };

  // The ⋯ menu, built once so the small print can name exactly what is in it.
  const menuItems = [
    { key: 'edit', label: 'Edit the quotation', on: true, onSelect: () => setEditing(true) },
    { key: 'send', label: q.sent_at ? 'Send again' : 'Send to the client', on: open && !approvalBlocked && move !== 'send', onSelect: () => setSending(true) },
    { key: 'link', label: 'Send for acceptance', on: open && !approvalBlocked && !q.accepted_at, onSelect: () => setLinking(true) },
    { key: 'accept', label: 'Record client acceptance', on: open && !q.accepted_at, onSelect: () => setAccepting(true) },
    { key: 'revise', label: 'Revise', on: !won && move !== 'revise', onSelect: () => setRevising(true) },
    { key: 'approval', label: 'Ask for approval', on: open && !pending, onSelect: () => setRequesting(true) },
    { key: 'register', label: 'Register the PO', on: !q.purchase_orders.length && !pending && !lost && move !== 'register', onSelect: () => setRegistering(true) },
    { key: 'project', label: 'Create the project only', on: won && !q.project_id && move !== 'project', onSelect: () => setConverting(true) },
    { key: 'lost', label: 'Mark as lost', on: open && Boolean(lostStage), danger: true, onSelect: () => setLosing(true) },
  ].filter((i) => i.on);

  function primary() {
    if (!move) return null;
    const { label, onClick } = MOVES[move];
    return <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={onClick}>{label}</button>;
  }

  function secondary() {
    if (move === 'approve') {
      return <button type="button" className="mg-btn" disabled={busy} onClick={() => setDeciding('rejected')}>Reject</button>;
    }
    if (!won && move !== 'revise') return <button type="button" className="mg-btn" onClick={() => setRevising(true)}>Revise</button>;
    return null;
  }

  /** The small print: what the button does, and which menu items exist. */
  function note() {
    const shown = new Set(['Revise', move && MOVES[move].label]);
    const rest = menuItems.map((i) => i.label).filter((l) => !shown.has(l) && l !== 'Edit the quotation');
    const listed = rest.length > 1 ? `${rest.slice(0, -1).join(', ')} and ${rest[rest.length - 1]}` : rest[0];
    const tail = listed ? ` ${listed} ${rest.length === 1 ? 'is' : 'are'} under More actions.` : '';
    if (move === 'register') return `Registering asks for the PO number, value, terms and the payment split, then creates ${q.project_id || 'the project'}, its onboarding tasks and the payment stages.${tail}`;
    if (move === 'send') return `Sending marks it as sent and can email the PDF to ${q.contact?.email || 'the client'}.${tail}`;
    if (move === 'project') return `Creating the project opens it with its onboarding tasks, without a purchase order.${tail}`;
    if (move === 'approve') return `Approving lets it go to the client; rejecting sends it back for a revision.${tail}`;
    if (move === 'revise') return `Revising keeps this version in the history, restarts the date and validity, and runs the discount check again.${tail}`;
    if (!isAdmin && pending) return `An admin approves or rejects the discount.${tail}`;
    return tail.trim() || null;
  }

  const approvalBanner = q.approval_status === 'approved' ? (
    <div className="mg-banner mg-banner--ok" role="status"><CircleCheck aria-hidden="true" /><div className="mg-banner__body"><strong>Discount approved.</strong>{q.approved_by ? `${q.approved_by} approved it` : 'Approved'}{q.approval_decided_at ? ` on ${date(q.approval_decided_at)}` : ''}{q.approval_note ? `: ${q.approval_note}` : '.'}</div></div>
  ) : pending ? (
    <div className="mg-banner mg-banner--wait" role="status"><Clock aria-hidden="true" /><div className="mg-banner__body"><strong>Discount waiting for approval.</strong>{q.approval_reason || 'Asked for approval.'}{q.approval_requested_by ? ` Asked by ${q.approval_requested_by}` : ''}{q.approval_requested_at ? ` on ${date(q.approval_requested_at)}` : ''}. {isAdmin ? 'You decide.' : 'An admin decides.'}</div></div>
  ) : rejected ? (
    <div className="mg-banner mg-banner--late" role="status"><CircleAlert aria-hidden="true" /><div className="mg-banner__body"><strong>Discount rejected.</strong>{q.approved_by ? `${q.approved_by} rejected it` : 'Rejected'}{q.approval_decided_at ? ` on ${date(q.approval_decided_at)}` : ''}{q.approval_note ? `: ${q.approval_note}` : '.'}</div></div>
  ) : null;

  const lineMeta = (l) => [
    `${Number(l.qty)} ${l.unit || ''} × ${money(l.rate, cur)}`.replace(/\s+×/, ' ×'),
    Number(l.discount_percent) ? `${Number(l.discount_percent)}% off` : null,
    `GST ${Number(l.gst_rate)}%`,
  ].filter(Boolean).join(' · ');

  const linesTab = (
    <Sec
      id="deal-lines"
      title="Lines"
      hint={q.lines.length ? `${plural(q.lines.length, 'line')} · their total is the deal value` : 'none priced yet'}
      tools={!won && q.lines.length > 0 && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setLine('new')}><Plus className="size-4" aria-hidden="true" />Add line</button>}
    >
      {won && <p className="m-0 text-[12.5px] text-muted-foreground">The deal is won, so its lines are kept as they were sold. Raise a new deal for extra scope.</p>}
      {q.lines.length === 0 ? (
        <div className="mg-empty app-box">
          <span className="mg-empty__mark"><FileText className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
          <h4 className="mg-empty__title">No lines yet</h4>
          <p className="mg-empty__text">Add the services being quoted with their rates. Until then the quoted value typed on the form stands{Number(q.quotation_value) ? ` (${money(q.quotation_value, cur)})` : ''}.</p>
          {!won && <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setLine('new')}><Plus className="size-4" aria-hidden="true" />Add line</button>}
        </div>
      ) : wide ? (
        <div className="app-box"><div className="mg-tablewrap"><table className="mg-table">
          <caption className="sr-only">Lines of {q.quotation_no}</caption>
          <thead><tr>
            <th scope="col">Description</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Rate</th>
            <th scope="col" className="num">Discount</th><th scope="col" className="num">GST</th><th scope="col" className="num">Amount</th>
            {!won && <th scope="col" className="actions" aria-label="Actions" />}
          </tr></thead>
          <tbody>
            {q.lines.map((l) => (
              <tr key={l.id}>
                <td style={{ whiteSpace: 'normal' }}><div style={{ minWidth: 180 }}><b>{l.description}</b>{l.service_name && l.service_name !== l.description && <span className="app-sub">{l.service_name}</span>}</div></td>
                <td className="num">{Number(l.qty)} {l.unit || ''}</td>
                <td className="num">{money(l.rate, cur)}</td>
                <td className="num">{Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : <span className="text-muted-foreground">—</span>}</td>
                <td className="num">{Number(l.gst_rate)}%</td>
                <td className="num"><b>{money(l.amount, cur)}</b></td>
                {!won && (
                  <td className="actions"><span className="app-rowacts">
                    <button type="button" className="mg-iconbtn" aria-label={`Edit the line ${l.description}`} title="Edit line" onClick={() => setLine(l)}><Pencil strokeWidth={1.8} aria-hidden="true" /></button>
                    <button type="button" className="mg-iconbtn" aria-label={`Remove the line ${l.description}`} title="Remove line" onClick={() => setRemoving(l)}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                  </span></td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            <td colSpan={5} style={{ whiteSpace: 'normal', fontWeight: 600 }}>
              <span className="text-[12.5px] text-secondary-text">Subtotal {money(q.subtotal, cur)} · {gstSummary(q.gst, q.tax_total, cur)}</span>
              {q.gst?.problems?.length > 0 && <span className="app-sub" style={{ fontWeight: 500 }}>{q.gst.problems.join(' ')}</span>}
            </td>
            <td className="num" style={{ fontSize: 15 }}>{money(q.total, cur)}<span className="app-sub">with GST</span></td>
            {!won && <td />}
          </tr></tfoot>
        </table></div></div>
      ) : (
        <div className="app-box"><div className="mg-rows">
          {q.lines.map((l) => (
            <div key={l.id} className="mg-row">
              <span className="mg-row__title" style={{ whiteSpace: 'normal' }}>{l.description}</span>
              <span className="mg-row__amount mg-num">{money(l.amount, cur)}</span>
              <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{lineMeta(l)}</span>
              {!won && <span className="mg-row__state app-rowacts">
                <button type="button" className="mg-iconbtn" style={{ width: 44, height: 44 }} aria-label={`Edit the line ${l.description}`} onClick={() => setLine(l)}><Pencil strokeWidth={1.8} aria-hidden="true" /></button>
                <button type="button" className="mg-iconbtn" style={{ width: 44, height: 44 }} aria-label={`Remove the line ${l.description}`} onClick={() => setRemoving(l)}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
              </span>}
            </div>
          ))}
          <div className="mg-row">
            <span className="mg-row__title">With GST</span>
            <span className="mg-row__amount mg-num">{money(q.total, cur)}</span>
            <span className="mg-row__meta" style={{ whiteSpace: 'normal', gridColumn: '1 / -1' }}>Subtotal {money(q.subtotal, cur)} · {gstSummary(q.gst, q.tax_total, cur)}</span>
          </div>
        </div></div>
      )}
    </Sec>
  );

  const fact = (label, value) => ({ label, value });
  const none = <span className="font-normal text-muted-foreground">None yet</span>;
  const detailsTab = (
    <div className="grid gap-6 lg:grid-cols-2">
      <Sec id="deal-about" title="About the quotation" tools={<button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setEditing(true)}>Edit the quotation</button>}>
        <dl className="mg-facts" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          {[
            fact('Contact', q.contact ? <>{q.contact.name}{q.contact.email && <span className="block text-[12px] font-normal text-secondary-text [overflow-wrap:anywhere]">{q.contact.email}</span>}</> : q.contact_person),
            fact('Owner', q.sales_person),
            fact('Quoted', date(q.quotation_date)),
            fact('Valid until', q.valid_until ? <span className={q.expired ? 'text-late' : undefined}>{date(q.valid_until)}{q.expired ? ' · expired' : ''}</span> : null),
            fact('Sector', q.sector),
            fact('Country', q.country),
            fact('Revision', `Rev ${q.revision || 0}`),
            fact('Approval', <Tone tone={q.approval_status === 'approved' ? 'ok' : pending ? 'wait' : rejected ? 'late' : 'plain'}>{q.approval_status === 'not_needed' ? 'Not required' : q.approval_status.replace('_', ' ')}</Tone>),
            fact('Enquiry', q.enquiry ? <Link className="app-ref" to={`/enquiries?q=${encodeURIComponent(q.enquiry.enquiry_no)}`}>{q.enquiry.enquiry_no}</Link> : null),
            fact('Project', q.project_id ? <Link className="app-ref" to={`/projects/${encodeURIComponent(q.project_id)}`}>{q.project_id}</Link> : none),
            fact('Client copy', q.document_id ? <DocumentLink id={q.document_id} name={q.document_name} /> : null),
            fact('Orders', q.purchase_orders.length ? q.purchase_orders.map((po) => <Link key={po.po_number} className="app-ref mr-2" to={`/purchase-orders/${encodeURIComponent(po.po_number)}`}>{po.po_number}</Link>) : none),
          ].map((f) => <div key={f.label} className="min-w-0"><dt>{f.label}</dt><dd>{f.value ?? <span className="font-normal text-muted-foreground">—</span>}</dd></div>)}
        </dl>
      </Sec>
      <div className="flex min-w-0 flex-col gap-6">
        <Sec id="deal-pipe" title="Pipeline" hint="what the Pipeline board shows" tools={<button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" onClick={() => setEditing(true)}>Change</button>}>
          <dl className="mg-facts" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            {[
              fact('Stage', stage?.name),
              fact('Probability', probability != null ? `${probability}%` : null),
              fact('Expected close', q.expected_close_date ? date(q.expected_close_date) : null),
              fact('Next step', q.next_step),
            ].map((f) => <div key={f.label} className="min-w-0"><dt>{f.label}</dt><dd>{f.value ?? <span className="font-normal text-muted-foreground">—</span>}</dd></div>)}
          </dl>
          <p className="m-0 text-[12px] text-muted-foreground">The stage moves on the Pipeline board; Change edits the probability, the expected close and the next step.</p>
        </Sec>
        <Sec id="deal-terms" title="Terms">
          {q.terms
            ? <div className="app-soft whitespace-pre-wrap text-[13px] leading-[1.7] text-secondary-text">{q.terms}</div>
            : <p className="m-0 text-[13px] text-muted-foreground">No terms of its own: the PDF prints the default terms from Settings.</p>}
        </Sec>
      </div>
    </div>
  );

  const revisionsTab = (
    <Sec id="deal-revs" title="Revisions" hint="earlier versions, as they stood before each revision">
      <div className="app-box"><div className="mg-tablewrap"><table className="mg-table">
        <caption className="sr-only">Revisions of {q.quotation_no}</caption>
        <thead><tr><th scope="col">Rev</th><th scope="col">Replaced on</th><th scope="col" className="num">Was</th><th scope="col">Why</th><th scope="col">By</th></tr></thead>
        <tbody>
          {q.revisions.map((r) => (
            <tr key={r.id}>
              <td><b>Rev {r.revision}</b></td>
              <td>{date(r.created_at)}</td>
              <td className="num">{money(r.snapshot.total ?? r.snapshot.quotation_value, r.snapshot.currency)}</td>
              <td style={{ whiteSpace: 'normal' }}><div style={{ minWidth: 180 }}>{r.note || <span className="text-muted-foreground">No reason given</span>}</div></td>
              <td className="text-muted-foreground">{r.created_by}</td>
            </tr>
          ))}
        </tbody>
      </table></div></div>
    </Sec>
  );

  const TABS = [
    { key: 'lines', label: 'Lines', count: q.lines.length },
    { key: 'details', label: 'Details' },
    { key: 'acceptance', label: 'Client acceptance', count: links.length || undefined },
    ...(q.revisions.length ? [{ key: 'revisions', label: 'Revisions', count: q.revisions.length }] : []),
    ...(q.enquiry?.enquiry_no ? [{ key: 'questionnaire', label: 'Questionnaire' }] : []),
    { key: 'activity', label: 'Activity' },
  ];

  return (
    <>
      <RecordPage
        parent="Deals"
        parentTo="/quotations"
        crumb={q.quotation_no}
        eyebrow={`Deal · ${q.quotation_no}${q.revision > 0 ? ` · Rev ${q.revision}` : ''}`}
        title={q.service_quoted || q.quotation_no}
        mark={false}
        badges={<>
          <Tone tone={dealTone(q.status, q.expired && open)}>{q.expired && open ? 'Expired' : q.status}</Tone>
          {pending && <Tone tone="wait">Discount waiting</Tone>}
          {rejected && <Tone tone="late">Discount rejected</Tone>}
          {q.accepted_at && <Tone tone="ok">Accepted {date(q.accepted_at)}</Tone>}
        </>}
        factsGrid={[
          fact('Client', q.company_id ? <Link to={`/companies/${q.company_id}`}>{q.client_name}</Link> : q.client_name),
          fact('Value before GST', money(beforeGst, cur)),
          fact('With GST', q.line_count ? money(q.total, cur) : null),
          fact('Owner', q.sales_person),
          fact('Valid until', q.valid_until ? <span className={q.expired ? 'text-late' : undefined}>{date(q.valid_until)}</span> : null),
          fact('Stage', stage ? `${stage.name}${probability != null ? ` · ${probability}%` : ''}` : null),
          fact('Expected close', q.expected_close_date ? date(q.expected_close_date) : null),
        ]}
        headExtra={q.read_from_email && !q.read_from_email.checked && (
          // Read from the PDF we emailed (docs/email-enquiries.md): a person
          // checks it against that PDF once, and says so.
          <div className="mg-banner mg-banner--wait" role="status">
            <TriangleAlert aria-hidden="true" />
            <div className="mg-banner__body">
              <strong>Check the lines and totals against the PDF{q.document_id ? '' : ' (the PDF itself could not be stored)'}.</strong>
              They were read automatically from an email. {q.read_from_email.no_lines ? 'Lines could not be read, so the totals are the ones printed on the PDF.' : ''}
            </div>
            <button type="button" className="mg-btn mg-btn--sm self-center" disabled={busy} onClick={() => act('email-read-checked', {}, 'Marked checked')}>Mark checked</button>
          </div>
        )}
        action={
          <a className="mg-btn" href={`/api/quotations/${encodeURIComponent(q.quotation_no)}/pdf`} target="_blank" rel="noopener noreferrer">
            <FileText className="size-4" strokeWidth={1.8} aria-hidden="true" />PDF
          </a>
        }
        menu={menuItems.map((i) => <Fragment key={i.key}>{i.danger && <div className="mg-menu__sep" role="separator" />}<RecordMenuItem danger={i.danger} onSelect={i.onSelect}>{i.label}</RecordMenuItem></Fragment>)}
        flow={
          <RecordFlow
            banner={approvalBanner}
            steps={steps}
            verdict={verdict()}
            actions={(primary() || secondary()) && <>{primary()}{secondary()}</>}
            note={note()}
          />
        }
      >
        <EmailOrigin entity="quotation" id={q.quotation_no} />
        <section className="mg-glass mg-glass--strong app-tabpanel" data-a="rise" aria-label="The deal">
          <RecordTabs id="deal" label="The deal" tabs={TABS} active={tab} onChange={setTab} />
          <div className="app-tabbody" id="deal-panel" role="tabpanel" aria-labelledby={`deal-tab-${tab}`}>
            {tab === 'lines' && linesTab}
            {tab === 'details' && detailsTab}
            {tab === 'acceptance' && (
              <AcceptanceLinks quotation={q} rows={links} loading={acceptances.loading && !acceptances.data} failed={acceptances.error} onRetry={acceptances.refetch} canSend={open && !approvalBlocked && !q.accepted_at} onSend={() => setLinking(true)} onChanged={() => { setLinksVersion((n) => n + 1); refetch(); }} />
            )}
            {tab === 'revisions' && revisionsTab}
            {tab === 'questionnaire' && q.enquiry?.enquiry_no && <QuestionnaireTab enquiryNo={q.enquiry.enquiry_no} />}
            {tab === 'activity' && <Timeline entity="quotation" id={q.quotation_no} flat />}
          </div>
        </section>
      </RecordPage>

      {editing && (
        <RecordForm title="Edit the quotation" subtitle={`${q.quotation_no} · ${q.client_name}`} size="lg" resource="quotations" fields={quotationFields(lookups, { edit: true }).filter((f) => !f.auto)} record={q} onClose={() => setEditing(false)} onSaved={() => { invalidateLookups(); refetch(); }} />
      )}
      {line && (
        <LineForm quotation={q} line={line === 'new' ? null : line} catalogue={lookups.catalogue} settings={q.settings} onClose={() => setLine(null)} onSaved={() => { setLine(null); refetch(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Remove this line?" message={`${removing.description}, ${money(removing.amount, cur)}. The totals update straight away.`} confirmLabel="Remove line" busy={busy} onClose={() => setRemoving(null)} onConfirm={async () => { setBusy(true); try { await api.remove('quotation-lines', removing.id); setRemoving(null); refetch(); } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); } }} />
      )}
      {revising && (
        <ReviseDialog quotation={q} busy={busy} onClose={() => setRevising(false)} onConfirm={async (note) => { const r = await act('revise', { note }, (x) => `Now revision ${x.revision}, valid until ${date(x.valid_until)}`); if (r) setRevising(false); }} />
      )}
      {sending && (
        <SendDialog quotation={q} busy={busy} onClose={() => setSending(false)} onConfirm={async (body) => { const r = await act('send', body, (x) => (x.email ? `Marked sent; email ${x.email.status}${x.email.reason ? ` (${x.email.reason})` : ''}` : 'Marked as sent')); if (r) setSending(false); }} />
      )}
      {linking && (
        <LinkDialog quotation={q} onClose={() => setLinking(false)} onDone={() => { setLinksVersion((n) => n + 1); refetch(); }} />
      )}
      {accepting && (
        <AcceptDialog quotation={q} busy={busy} onClose={() => setAccepting(false)} onConfirm={async (name) => { const r = await act('accept', { accepted_by_name: name }, 'Acceptance recorded'); if (r) setAccepting(false); }} />
      )}
      {requesting && (
        <ReasonDialog title="Ask for approval" subtitle={`${q.quotation_no} · ${q.client_name}. An admin is told, and nothing goes to the client until they decide.`} label="What needs approving" placeholder="Special payment terms: 100% on delivery" confirmLabel="Ask for approval" busyLabel="Asking…" busy={busy} onClose={() => setRequesting(false)} onConfirm={async (reason) => { const r = await act('approval/request', { reason }, (x) => `Sent for approval${x.email ? ` (email ${x.email.status})` : ''}`); if (r) setRequesting(false); }} />
      )}
      {deciding && (
        <ReasonDialog
          title={deciding === 'approved' ? 'Approve the discount' : 'Reject the discount'}
          subtitle={`${q.quotation_no} · ${q.client_name}${q.approval_reason ? `. Asked: ${q.approval_reason}` : ''}`}
          label="Note"
          optional
          confirmLabel={deciding === 'approved' ? 'Approve the discount' : 'Reject the discount'}
          busyLabel={deciding === 'approved' ? 'Approving…' : 'Rejecting…'}
          danger={deciding === 'rejected'}
          busy={busy}
          onClose={() => setDeciding(null)}
          onConfirm={async (note) => { const r = await act('approval/decide', { decision: deciding, note }, (x) => withEmailResult(`Discount ${deciding}`, x.email)); if (r) setDeciding(null); }}
        />
      )}
      {registering && (
        <RegisterPoDialog quotation={q} onClose={() => setRegistering(false)} onDone={() => { invalidateLookups(); refetch(); }} />
      )}
      {converting && (
        <ConvertQuotationDialog quotation={q} onClose={() => setConverting(false)} onDone={() => { setConverting(false); invalidateLookups(); refetch(); }} />
      )}
      {losing && lostStage && (
        <LostDialog
          card={q}
          reasons={lookups.lost_reasons}
          onClose={() => setLosing(false)}
          onConfirm={async (extra) => {
            try {
              await api.action(`/pipeline/${encodeURIComponent(q.quotation_no)}/move`, { stage_id: lostStage.id, ...extra });
              toast(`${q.quotation_no} marked as lost`, 'success');
              setLosing(false); invalidateLookups(); refetch();
            } catch (err) { toast(err.fields ? Object.values(err.fields)[0] : err.message, 'danger'); }
          }}
        />
      )}
    </>
  );
}

/** A line: pick a catalogue service to fill the rate and GST, or type a one-off. */
function LineForm({ quotation, line, catalogue, settings, onClose, onSaved }) {
  const [v, setV] = useState(() => line ? { ...line } : { service_id: '', description: '', qty: 1, unit: 'engagement', rate: '', discount_percent: 0, gst_rate: settings?.gst_rate_default || 18, sort_order: (quotation.lines?.length || 0) + 1 });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [failed, setFailed] = useState(null);
  const set = (k, val) => { setV((s) => ({ ...s, [k]: val })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const pickService = (id) => {
    const svc = catalogue.find((c) => String(c.id) === String(id));
    setV((s) => ({ ...s, service_id: id, description: svc ? svc.name : s.description, rate: svc?.default_rate ?? s.rate, gst_rate: svc?.gst_rate ?? s.gst_rate, unit: svc?.unit || s.unit }));
  };
  const amount = Math.round(Number(v.qty || 0) * Number(v.rate || 0) * (1 - Number(v.discount_percent || 0) / 100) * 100) / 100;
  const threshold = Number(settings?.discount_approval_threshold_percent || 0);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErrors({}); setFailed(null);
    const payload = { quotation_id: quotation.id, service_id: v.service_id || null, description: v.description, qty: v.qty, unit: v.unit, rate: v.rate, discount_percent: v.discount_percent, gst_rate: v.gst_rate, sort_order: v.sort_order };
    try {
      if (line) await api.update('quotation-lines', line.id, payload); else await api.create('quotation-lines', payload);
      onSaved();
    } catch (err) { setErrors(err.fields || {}); setFailed(err.fields ? `${Object.keys(err.fields).length === 1 ? 'One field needs' : 'Some fields need'} a look.` : err.message); setBusy(false); }
  }
  return (
    <Modal title={line ? 'Edit line' : 'Add line'} subtitle={`${quotation.quotation_no} · ${quotation.client_name}`} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" form="line-form" className="mg-btn mg-btn--primary" disabled={busy}>{busy ? 'Saving…' : failed && !Object.keys(errors).length ? 'Try again' : line ? 'Save line' : 'Add line'}</button>
    </>}>
      <form id="line-form" onSubmit={submit} className="form-grid">
        {failed && <div className="span-all mg-banner mg-banner--late" role="alert"><CircleAlert aria-hidden="true" /><div className="mg-banner__body"><strong>Couldn't save the line.</strong>{failed}</div></div>}
        <div className="span-all"><Field label="Service from the catalogue" hint="Fills the description, rate and GST; edit anything after"><Select value={String(v.service_id || '')} placeholder="One-off line (not in the catalogue)" options={catalogue.map((c) => ({ value: String(c.id), label: `${c.name}${c.default_rate ? ` · ${money(c.default_rate, c.currency)}` : ''}` }))} onChange={(e) => pickService(e.target.value)} /></Field></div>
        <div className="span-all"><Field label="Description" required error={errors.description}><Textarea rows={2} value={v.description} error={errors.description} onChange={(e) => set('description', e.target.value)} /></Field></div>
        <Field label="Quantity" error={errors.qty}><Input type="number" step="any" min="0.01" value={v.qty} error={errors.qty} onChange={(e) => set('qty', e.target.value)} /></Field>
        <Field label="Unit"><Select value={v.unit || ''} placeholder="—" options={['engagement', 'site', 'day', 'audit', 'report', 'year']} onChange={(e) => set('unit', e.target.value)} /></Field>
        <Field label={`Rate (${quotation.currency})`} error={errors.rate}><Input type="number" step="0.01" min="0" value={v.rate} error={errors.rate} onChange={(e) => set('rate', e.target.value)} /></Field>
        <Field label="Discount %" error={errors.discount_percent} hint={threshold ? `Above ${threshold}% needs approval` : undefined}><Input type="number" step="0.5" min="0" max="100" value={v.discount_percent} error={errors.discount_percent} onChange={(e) => set('discount_percent', e.target.value)} /></Field>
        <Field label="GST %" error={errors.gst_rate}><Input type="number" step="0.5" min="0" max="100" value={v.gst_rate} error={errors.gst_rate} onChange={(e) => set('gst_rate', e.target.value)} /></Field>
        <Field label="Order"><Input type="number" step="1" value={v.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field>
        <div className="span-all app-soft flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span>Line amount before GST</span><b className="mg-num text-[15px]">{money(amount, quotation.currency)}</b>
          {threshold > 0 && Number(v.discount_percent) > threshold && <span className="w-full text-[12px] text-caramel-text">This discount is above {threshold}%: the deal will need an admin’s approval before it is sent.</span>}
        </div>
      </form>
    </Modal>
  );
}

function ReasonDialog({ title, subtitle, label, placeholder, optional, confirmLabel = 'Confirm', busyLabel = 'Saving…', danger, busy, onClose, onConfirm }) {
  const [text, setText] = useState('');
  const off = !optional && !text.trim();
  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className={danger ? 'mg-btn mg-btn--danger' : 'mg-btn mg-btn--primary'} disabled={busy || off} aria-describedby={off ? 'reason-why' : undefined} onClick={() => onConfirm(text.trim())}>{busy ? busyLabel : confirmLabel}</button>
      {off && <span id="reason-why" className="app-why">Say {label.toLowerCase()} to send it.</span>}
    </>}>
      <Field label={label} required={!optional} hint={optional ? 'Optional. Kept with the decision and emailed to whoever asked' : undefined}><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} /></Field>
    </Modal>
  );
}

function ReviseDialog({ quotation, busy, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  return (
    <Modal title="Revise this quotation" subtitle={`${quotation.quotation_no}, now Rev ${quotation.revision || 0}. The current version is kept in the history. The revision number goes up, the date and validity restart, and it counts as not yet sent.`} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="mg-btn mg-btn--primary" disabled={busy} onClick={() => onConfirm(note)}>{busy ? 'Revising…' : `Make Rev ${(quotation.revision || 0) + 1}`}</button>
    </>}>
      <Field label="What changed" hint="Kept with the old version"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Client asked for two sites instead of one" /></Field>
    </Modal>
  );
}

function SendDialog({ quotation, busy, onClose, onConfirm }) {
  const [email, setEmail] = useState(Boolean(quotation.contact?.email));
  const [to, setTo] = useState(quotation.contact?.email || '');
  const [message, setMessage] = useState('');
  const off = email && !to;
  return (
    <Modal title="Send this quotation" subtitle={`${quotation.quotation_no} · ${quotation.client_name}. Marks it as sent. Tick the box to also email the PDF; the email is logged under Emails & jobs.`} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="mg-btn mg-btn--primary" disabled={busy || off} onClick={() => onConfirm({ email, to: email ? to : undefined, message })}>{busy ? 'Sending…' : email ? 'Send email and mark sent' : 'Mark as sent'}</button>
      {off && <span className="app-why">Type the address to email it, or untick the box.</span>}
    </>}>
      <div className="stack">
        <label className="mg-check"><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the PDF to the client</label>
        {email && <Field label="To" required hint={quotation.contact?.email ? undefined : 'No email on the contact yet: type one'}><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@company.com" /></Field>}
        {email && <Field label="Message" hint="Blank: a standard covering note"><Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

function AcceptDialog({ quotation, busy, onClose, onConfirm }) {
  const [name, setName] = useState(quotation.contact?.name || quotation.contact_person || '');
  return (
    <Modal title="Record client acceptance" subtitle={`${quotation.quotation_no} · ${quotation.client_name}. Records who said yes and when. The deal moves to Under Negotiation until the PO arrives.`} onClose={onClose} footer={<>
      <button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !name.trim()} onClick={() => onConfirm(name.trim())}>{busy ? 'Saving…' : 'Record acceptance'}</button>
    </>}>
      <Field label="Accepted by" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}
