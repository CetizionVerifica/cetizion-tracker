import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import {
  Alert, ConfirmDialog, DocumentLink, Empty, ErrorState, Field, Input, Modal, Select, Textarea, useToast,
} from '../components/ui.jsx';
import { Chip, flowSteps, initialsOf, RecordFlow, RecordMenuItem, RecordPage, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { RecordForm } from '../components/RecordForm.jsx';
import { ConvertQuotationDialog } from '../components/actions.jsx';
import { RegisterPoDialog } from '../components/RegisterPoDialog.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { AcceptanceLinks } from '../components/AcceptanceLinks.jsx';
import { EmailOrigin } from '../components/EmailOrigin.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { withEmailResult } from '../lib/emailResult.js';
import { date, money } from '../lib/format.js';
import { quotationFields } from './Quotations.jsx';

/**
 * One deal, as C4 draws it.
 *
 * The header used to carry eight buttons — Send, Client accepted, Revise,
 * Ask approval, Register PO, Project only, Edit and PDF — which made every
 * one of them equally easy to press and none of them obviously the right
 * one. C4's answer is a rail you read in a glance, one sentence saying
 * where the deal is, and one button that moves it on. The rest are in the
 * menu, and the small print under the button names them so nobody hunts.
 *
 * The ladder is INFERRED, not recorded. The app keeps only the live
 * pipeline stage and `stage_changed_at`, so there is no history to read a
 * deal's path from. Every rung is therefore derived from a fact that is
 * actually stored — an enquiry row, `sent_at`, a purchase order, money
 * invoiced, money received. The design's second rung is "Qualified", but
 * nothing here records qualification, so this one says "Quoted", which is
 * true of every quotation that has a priced line.
 */

const FLOW_BUTTON = 'h-8 px-4 text-[13px]';
const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';
const FACT_LABEL = 'eyebrow';

const trim = (n) => String(Math.round(Number(n) * 100) / 100);

/**
 * The tax part of the totals line: CGST and SGST within the state, IGST
 * outside it (#23). A quotation loaded before the split existed still
 * shows its single stored figure rather than nothing.
 */
function gstSummary(gst, taxTotal, cur) {
  if (!gst?.bands?.length) return `GST ${money(taxTotal, cur)}`;
  if (gst.zero_rated) return 'GST zero-rated (export)';
  if (!gst.intra) return gst.bands.map((b) => `IGST ${trim(b.rate)}% ${money(b.igst, cur)}`).join(' · ');
  return gst.bands.map((b) => `CGST ${trim(b.rate / 2)}% ${money(b.cgst, cur)} · SGST ${trim(b.rate / 2)}% ${money(b.sgst, cur)}`).join(' · ');
}

/** A cell in the facts grid under the lines. */
function GridFact({ label, children }) {
  return (
    <div className="min-w-0">
      <div className={FACT_LABEL}>{label}</div>
      <div className="mt-1.5 text-[13px] text-foreground">{children}</div>
    </div>
  );
}

function statusTone(status, expired) {
  if (expired || /lost/i.test(status)) return 'late';
  if (/won/i.test(status)) return 'settled';
  if (/negotiation|hold/i.test(status)) return 'waiting';
  return 'info';
}

export default function QuotationDetail() {
  const { key } = useParams();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const lookups = useLookups();
  const [editing, setEditing] = useState(false);
  const [line, setLine] = useState(null);         // 'new' | line record
  const [removing, setRemoving] = useState(null);
  const [revising, setRevising] = useState(false);
  const [sending, setSending] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [converting, setConverting] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [deciding, setDeciding] = useState(null);   // 'approved' | 'rejected'
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useFetch(() => api.raw(`/quotations/${encodeURIComponent(key)}/full`), [key]);
  const q = data?.data;

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

  if (error) return <><PageHeader title="Quotation" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (loading || !q) return <><PageHeader title="Quotation" /><div className="page"><div className="skeleton h-[240px]" /></div></>;

  const cur = q.currency;
  const open = ['Draft', 'Submitted', 'Under Negotiation', 'On Hold'].includes(q.status);
  const won = q.status === 'Won - PO Received';
  const approvalBlocked = q.approval_status === 'pending' || q.approval_status === 'rejected';
  const total = q.line_count ? q.total : q.quotation_value;

  const invoiced = q.purchase_orders.reduce((sum, p) => sum + Number(p.total_invoiced || 0), 0);
  const received = q.purchase_orders.reduce((sum, p) => sum + Number(p.total_received || 0), 0);
  const ordered = q.purchase_orders.reduce((sum, p) => sum + Number(p.po_value || 0), 0);

  // The sales flow of web/CLAUDE.md §4, each rung read off a fact the
  // database holds. Negotiation counts as passed once a sent deal is won
  // or ordered; a deal won without ever being sent leaves it hollow rather
  // than pretending it happened.
  const hasOrder = q.purchase_orders.length > 0;
  const reached = [
    { label: 'Enquiry', done: Boolean(q.enquiry) },
    { label: 'Quoted', done: q.line_count > 0 || Number(q.quotation_value) > 0 },
    { label: 'Sent', done: Boolean(q.sent_at) },
    { label: 'Negotiation', done: (won || hasOrder) && Boolean(q.sent_at) },
    { label: 'Won', done: won || hasOrder },
    { label: 'Project', done: Boolean(q.project_id) },
    { label: 'Order', done: hasOrder },
    { label: 'Invoiced', done: invoiced > 0 },
    { label: 'Paid', done: ordered > 0 && received >= ordered - 0.5 },
  ];
  const steps = flowSteps(reached);

  function verdict() {
    if (q.approval_status === 'pending') {
      return `The discount is waiting for approval${q.approval_reason ? ` — ${q.approval_reason}` : ''}. Nothing goes to the client until that is decided.`;
    }
    if (q.approval_status === 'rejected') {
      return `The discount was rejected${q.approved_by ? ` by ${q.approved_by}` : ''}${q.approval_note ? `: ${q.approval_note}` : ''}. Revise the discount or the terms, then ask again.`;
    }
    // Once an order exists the deal has moved past the quotation, so what
    // happened to the money is the headline. Asking `!sent_at` first told
    // a won, invoiced deal that it had not been sent yet, which is true
    // and useless.
    if (won || q.purchase_orders.length) {
      if (!q.purchase_orders.length) return 'Won, but no purchase order is registered against it yet.';
      if (invoiced === 0) return `${money(ordered, cur)} ordered across ${q.purchase_orders.length} purchase order${q.purchase_orders.length === 1 ? '' : 's'}, none of it invoiced yet.`;
      if (received < ordered - 0.5) return `${money(invoiced, cur)} invoiced and ${money(received, cur)} collected of ${money(ordered, cur)} ordered.`;
      return 'Everything ordered against this deal has been invoiced and collected.';
    }
    if (!q.sent_at) {
      return q.line_count
        ? `Not sent yet. ${q.line_count} line${q.line_count === 1 ? '' : 's'} totalling ${money(total, cur)}.`
        : 'Not sent yet, and nothing is priced — the quoted value typed on the form is all that stands behind it.';
    }
    if (q.expired && open) {
      return `Sent on ${date(q.quotation_date)}, and it passed its validity date on ${date(q.valid_until)}. Revise it to reopen with a fresh date, or mark it lost.`;
    }
    if (open) {
      const waiting = q.accepted_at
        ? `Accepted by ${q.accepted_by_name} — waiting on the purchase order.`
        : 'Waiting on the client to accept or send a purchase order.';
      return `Sent on ${date(q.quotation_date)}${q.valid_until ? `, valid until ${date(q.valid_until)}` : ''}. ${waiting}`;
    }
    return `This deal is ${q.status}.`;
  }

  /**
   * The single move, chosen by what is actually blocking the deal.
   *
   * The button and the small print under it are both read off this one
   * value, because deciding them separately let the note explain
   * registering a PO while the button said "Send to the client".
   */
  const move = q.approval_status === 'pending' ? (isAdmin ? 'approve' : null)
    : open && !approvalBlocked && !q.sent_at ? 'send'
    : open && !q.purchase_orders.length ? 'register'
    : won && !q.project_id ? 'project'
    : null;

  const MOVES = {
    approve: { label: 'Approve the discount', onClick: () => setDeciding('approved') },
    send: { label: 'Send to the client', onClick: () => setSending(true) },
    register: { label: 'Register the PO', onClick: () => setRegistering(true) },
    project: { label: 'Create the project', onClick: () => setConverting(true) },
  };

  function primary() {
    if (!move) return null;
    const { label, onClick } = MOVES[move];
    return <Button size="sm" className={FLOW_BUTTON} disabled={busy} onClick={onClick}>{label}</Button>;
  }

  function secondary() {
    if (move === 'approve') {
      return <Button variant="secondary" size="sm" className={FLOW_BUTTON} disabled={busy} onClick={() => setDeciding('rejected')}>Reject</Button>;
    }
    if (!won) return <Button variant="secondary" size="sm" className={FLOW_BUTTON} onClick={() => setRevising(true)}>Revise</Button>;
    return null;
  }

  /** The small print: what the button does, and where the rest went. */
  function note() {
    const rest = 'Everything else this deal can do is in the ⋯ menu.';
    if (move === 'register') {
      return `Registering asks for the PO number, value, terms and the payment split, then creates ${q.project_id || 'the project'}, its onboarding tasks and the payment stages. Send, Client accepted, Revise and Ask approval are in the ⋯ menu.`;
    }
    if (move === 'send') return `Sending marks it as sent and can email the PDF to ${q.contact?.email || 'the client'}. ${rest}`;
    if (move === 'project') return `Creating the project opens it with its onboarding tasks, without a purchase order. ${rest}`;
    return rest;
  }

  return (
    <>
      <RecordPage
        parent="Deals"
        parentTo="/quotations"
        title={q.service_quoted || q.quotation_no}
        mark={false}
        facts={[
          <span className="inline-flex min-w-0 items-center gap-2 text-foreground">
            <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-secondary text-[9px] font-semibold text-settled">
              {initialsOf(q.client_name)}
            </span>
            {q.company_id
              ? <Link to={`/companies/${q.company_id}`} className="min-w-0 truncate text-foreground no-underline hover:text-primary">{q.client_name}</Link>
              : <span className="min-w-0 truncate">{q.client_name}</span>}
          </span>,
          <span className="mono text-[12.5px] text-foreground">{money(total, cur)}</span>,
          <span className="mono text-[12.5px]">{q.quotation_no}{q.revision > 0 && ` · Rev ${q.revision}`}</span>,
          <Chip tone={statusTone(q.status, q.expired)}>{q.expired && open ? 'Expired' : q.status}</Chip>,
          q.approval_status === 'pending' && <Chip tone="waiting">Discount awaiting approval</Chip>,
        ]}
        action={
          <Button variant="secondary" size="sm" className={FLOW_BUTTON} asChild>
            <a href={`/api/quotations/${encodeURIComponent(q.quotation_no)}/pdf`} target="_blank" rel="noopener noreferrer">PDF</a>
          </Button>
        }
        menu={
          <>
            <RecordMenuItem onSelect={() => setEditing(true)}>Edit the quotation</RecordMenuItem>
            {open && !approvalBlocked && <RecordMenuItem onSelect={() => setSending(true)}>Send to the client</RecordMenuItem>}
            {open && !q.accepted_at && <RecordMenuItem onSelect={() => setAccepting(true)}>Record client acceptance</RecordMenuItem>}
            {!won && <RecordMenuItem onSelect={() => setRevising(true)}>Revise</RecordMenuItem>}
            {open && q.approval_status !== 'pending' && <RecordMenuItem onSelect={() => setRequesting(true)}>Ask for approval</RecordMenuItem>}
            {!q.purchase_orders.length && <RecordMenuItem onSelect={() => setRegistering(true)}>Register the PO</RecordMenuItem>}
            {won && !q.project_id && <RecordMenuItem onSelect={() => setConverting(true)}>Create the project only</RecordMenuItem>}
          </>
        }
        flow={
          <RecordFlow
            steps={steps}
            verdict={verdict()}
            actions={<>{primary()}{secondary()}</>}
            note={note()}
          />
        }
      >
        {/* Read from the PDF we emailed (docs/email-enquiries.md): a person
            checks it against that PDF once, and says so. */}
        {q.read_from_email && !q.read_from_email.checked && (
          <Alert tone="warning">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span>
                <strong>Check the lines and totals against the PDF</strong>{q.document_id ? '' : ' (the PDF itself could not be stored)'}: they were read automatically.{' '}
                {q.read_from_email.no_lines ? 'Lines could not be read, so the totals are the ones printed on the PDF.' : ''}
              </span>
              <Button variant="secondary" size="sm" className={ROW_BUTTON} disabled={busy} onClick={() => act('email-read-checked', {}, 'Marked checked')}>Mark checked</Button>
            </span>
          </Alert>
        )}
        <EmailOrigin entity="quotation" id={q.quotation_no} />

        {q.approval_status === 'approved' && (
          <Alert tone="success">
            <span><strong>Approved</strong>{q.approved_by ? ` by ${q.approved_by}` : ''}{q.approval_decided_at ? ` on ${new Date(q.approval_decided_at).toLocaleDateString()}` : ''}{q.approval_note ? `: ${q.approval_note}` : ''}.</span>
          </Alert>
        )}

        <RecordSection
          title="Lines"
          hint={q.lines.length ? `${q.lines.length} · the total drives the deal amount` : 'none priced yet'}
          action={!won && <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setLine('new')}>Add line</Button>}
        >
          {q.lines.length === 0 ? (
            <Empty
              title="No lines yet"
              text="Add the services being quoted with their rates. Until then the quoted value typed on the form stands."
              action={!won && <Button size="sm" className={ROW_BUTTON} onClick={() => setLine('new')}>Add line</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary hover:bg-secondary">
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-5')}>Description</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3 text-right')}>Qty</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3 text-right')}>Rate</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3 text-right')}>Disc</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3 text-right')}>GST</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-5 text-right')}>Amount</TableHead>
                  {!won && <TableHead className="h-9 w-24 px-3" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.lines.map((l) => (
                  <TableRow key={l.id} className="h-9">
                    <TableCell className="px-5 text-[13px] text-foreground">
                      {l.description}
                      {l.service_name && l.service_name !== l.description && (
                        <div className="text-[12px] text-muted-foreground">{l.service_name}</div>
                      )}
                    </TableCell>
                    <TableCell className="mono px-3 text-right text-[13px] text-secondary-text">{Number(l.qty)} {l.unit || ''}</TableCell>
                    <TableCell className="mono px-3 text-right text-[13px] text-secondary-text">{money(l.rate, cur)}</TableCell>
                    <TableCell className="mono px-3 text-right text-[13px] text-secondary-text">
                      {Number(l.discount_percent) ? `${Number(l.discount_percent)}%` : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="mono px-3 text-right text-[13px] text-secondary-text">{Number(l.gst_rate)}%</TableCell>
                    <TableCell className="mono px-5 text-right text-[13px] font-medium text-foreground">{money(l.amount, cur)}</TableCell>
                    {!won && (
                      <TableCell className="px-3 text-right whitespace-nowrap">
                        <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setLine(l)}>Edit</Button>
                        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Remove line" onClick={() => setRemoving(l)}>✕</Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                <TableRow className="bg-secondary hover:bg-secondary">
                  <TableCell colSpan={5} className="px-5 text-[12.5px] text-secondary-text">
                    Subtotal {money(q.subtotal, cur)} · {gstSummary(q.gst, q.tax_total, cur)}
                    {q.gst?.problems?.length > 0 && (
                      <div className="mt-1 text-[11.5px] text-muted-foreground">{q.gst.problems.join(' ')}</div>
                    )}
                  </TableCell>
                  <TableCell className="mono px-5 text-right text-[14px] font-semibold text-foreground">{money(q.total, cur)}</TableCell>
                  {!won && <TableCell />}
                </TableRow>
              </TableBody>
            </Table>
          )}
        </RecordSection>

        <Card className="gap-0 rounded-lg border-border py-0 shadow-none">
          <CardContent className="grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
            <GridFact label="Contact">
              {q.contact ? (
                <>
                  {q.contact.name}
                  {q.contact.email && <div className="text-[12px] break-words text-secondary-text">{q.contact.email}</div>}
                </>
              ) : (q.contact_person || <span className="text-muted-foreground">—</span>)}
            </GridFact>
            <GridFact label="Owner">{q.sales_person || <span className="text-muted-foreground">—</span>}</GridFact>
            <GridFact label="Quoted">{date(q.quotation_date)}</GridFact>
            <GridFact label="Valid until">
              <span className={q.expired ? 'text-late' : undefined}>{q.valid_until ? date(q.valid_until) : '—'}</span>
            </GridFact>
            <GridFact label="Sector">{q.sector || <span className="text-muted-foreground">—</span>}</GridFact>
            <GridFact label="Country">{q.country || <span className="text-muted-foreground">—</span>}</GridFact>
            <GridFact label="Revision">Rev {q.revision || 0}</GridFact>
            <GridFact label="Approval">
              <Chip tone={q.approval_status === 'approved' ? 'settled' : q.approval_status === 'pending' ? 'waiting' : q.approval_status === 'rejected' ? 'late' : 'plain'}>
                {q.approval_status === 'not_needed' ? 'Not required' : q.approval_status.replace('_', ' ')}
              </Chip>
            </GridFact>
            <GridFact label="Enquiry">
              {q.enquiry
                ? <Link className="mono" to={`/enquiries?q=${encodeURIComponent(q.enquiry.enquiry_no)}`}>{q.enquiry.enquiry_no}</Link>
                : <span className="text-muted-foreground">—</span>}
            </GridFact>
            <GridFact label="Project">
              {q.project_id
                ? <Link className="mono" to={`/projects/${encodeURIComponent(q.project_id)}`}>{q.project_id}</Link>
                : <span className="text-muted-foreground">—</span>}
            </GridFact>
            <GridFact label="Client copy"><DocumentLink id={q.document_id} name={q.document_name} /></GridFact>
            <GridFact label="Orders">
              {q.purchase_orders.length
                ? q.purchase_orders.map((po) => (
                    <div key={po.po_number}>
                      <Link className="mono" to={`/purchase-orders/${encodeURIComponent(po.po_number)}`}>{po.po_number}</Link>
                    </div>
                  ))
                : <span className="text-muted-foreground">none yet</span>}
            </GridFact>
          </CardContent>
        </Card>

        {q.terms && (
          <RecordSection title="Terms">
            <div className="px-5 py-4 text-[13px]/[1.7] whitespace-pre-wrap text-secondary-text">{q.terms}</div>
          </RecordSection>
        )}

        {q.revisions.length > 0 && (
          <RecordSection title={`Revisions · ${q.revisions.length}`} hint="earlier versions, as they stood before each revision">
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary hover:bg-secondary">
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-5')}>Rev</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3')}>Replaced on</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3 text-right')}>Was</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-3')}>Why</TableHead>
                  <TableHead className={cn(FACT_LABEL, 'h-9 px-5')}>By</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.revisions.map((r) => (
                  <TableRow key={r.id} className="h-9">
                    <TableCell className="px-5 text-[13px] text-foreground">Rev {r.revision}</TableCell>
                    <TableCell className="px-3 text-[13px] text-secondary-text">{new Date(r.created_at).toLocaleString()}</TableCell>
                    <TableCell className="mono px-3 text-right text-[13px] text-secondary-text">
                      {money(r.snapshot.total ?? r.snapshot.quotation_value, r.snapshot.currency)}
                    </TableCell>
                    <TableCell className="px-3 text-[13px] text-secondary-text">{r.note}</TableCell>
                    <TableCell className="px-5 text-[12px] text-muted-foreground">{r.created_by}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </RecordSection>
        )}

        <AcceptanceLinks quotation={q} canSend={open && !approvalBlocked && !q.accepted_at} onChanged={refetch} />
        <Timeline entity="quotation" id={q.quotation_no} />
      </RecordPage>

      {editing && (
        <RecordForm title="Edit quotation" resource="quotations" fields={quotationFields(lookups).filter((f) => !f.auto)} record={q} onClose={() => setEditing(false)} onSaved={() => { invalidateLookups(); refetch(); }} />
      )}
      {line && (
        <LineForm quotation={q} line={line === 'new' ? null : line} catalogue={lookups.catalogue} settings={q.settings} onClose={() => setLine(null)} onSaved={() => { setLine(null); refetch(); }} />
      )}
      {removing && (
        <ConfirmDialog title="Remove this line?" message="The totals update straight away." confirmLabel="Remove" busy={busy} onClose={() => setRemoving(null)} onConfirm={async () => { setBusy(true); try { await api.remove('quotation-lines', removing.id); setRemoving(null); refetch(); } catch (err) { toast(err.message, 'danger'); } finally { setBusy(false); } }} />
      )}
      {revising && (
        <ReviseDialog busy={busy} onClose={() => setRevising(false)} onConfirm={async (note) => { const r = await act('revise', { note }, (x) => `Now revision ${x.revision}, valid until ${date(x.valid_until)}`); if (r) setRevising(false); }} />
      )}
      {sending && (
        <SendDialog quotation={q} busy={busy} onClose={() => setSending(false)} onConfirm={async (body) => { const r = await act('send', body, (x) => (x.email ? `Marked sent; email ${x.email.status}${x.email.reason ? ` (${x.email.reason})` : ''}` : 'Marked as sent')); if (r) setSending(false); }} />
      )}
      {accepting && (
        <AcceptDialog quotation={q} busy={busy} onClose={() => setAccepting(false)} onConfirm={async (name) => { const r = await act('accept', { accepted_by_name: name }, 'Acceptance recorded'); if (r) setAccepting(false); }} />
      )}
      {requesting && (
        <ReasonDialog title="Ask for approval" label="What needs approving" placeholder="Special payment terms: 100% on delivery" busy={busy} onClose={() => setRequesting(false)} onConfirm={async (reason) => { const r = await act('approval/request', { reason }, (x) => `Sent for approval${x.email ? ` (email ${x.email.status})` : ''}`); if (r) setRequesting(false); }} />
      )}
      {deciding && (
        <ReasonDialog title={deciding === 'approved' ? 'Approve this quotation' : 'Reject this quotation'} label="Note" optional busy={busy} onClose={() => setDeciding(null)} onConfirm={async (note) => { const r = await act('approval/decide', { decision: deciding, note }, (x) => withEmailResult(`Quotation ${deciding}`, x.email)); if (r) setDeciding(null); }} />
      )}
      {registering && (
        <RegisterPoDialog quotation={q} onClose={() => setRegistering(false)} onDone={() => { invalidateLookups(); refetch(); }} />
      )}
      {converting && (
        <ConvertQuotationDialog quotation={q} onClose={() => setConverting(false)} onDone={() => { setConverting(false); invalidateLookups(); refetch(); }} />
      )}
    </>
  );
}

/** A line: pick a catalogue service to fill the rate and GST, or type a one-off. */
function LineForm({ quotation, line, catalogue, settings, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState(() => line ? { ...line } : { service_id: '', description: '', qty: 1, unit: 'engagement', rate: '', discount_percent: 0, gst_rate: settings?.gst_rate_default || 18, sort_order: (quotation.lines?.length || 0) + 1 });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const set = (k, val) => setV((s) => ({ ...s, [k]: val }));
  const pickService = (id) => {
    const svc = catalogue.find((c) => String(c.id) === String(id));
    setV((s) => ({ ...s, service_id: id, description: svc ? svc.name : s.description, rate: svc?.default_rate ?? s.rate, gst_rate: svc?.gst_rate ?? s.gst_rate, unit: svc?.unit || s.unit }));
  };
  const amount = Math.round(Number(v.qty || 0) * Number(v.rate || 0) * (1 - Number(v.discount_percent || 0) / 100) * 100) / 100;

  async function submit(e) {
    e.preventDefault(); setBusy(true); setErrors({});
    const payload = { quotation_id: quotation.id, service_id: v.service_id || null, description: v.description, qty: v.qty, unit: v.unit, rate: v.rate, discount_percent: v.discount_percent, gst_rate: v.gst_rate, sort_order: v.sort_order };
    try {
      if (line) await api.update('quotation-lines', line.id, payload); else await api.create('quotation-lines', payload);
      onSaved();
    } catch (err) { setErrors(err.fields || {}); toast(err.message, 'danger'); setBusy(false); }
  }
  return (
    <Modal title={line ? 'Edit line' : 'Add line'} subtitle={quotation.quotation_no} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" form="line-form" disabled={busy}>{busy ? 'Saving…' : 'Save line'}</Button></>}>
      <form id="line-form" onSubmit={submit} className="form-grid">
        <div className="span-all"><Field label="Service from the catalogue" hint="Fills the description, rate and GST; edit anything after"><Select value={String(v.service_id || '')} placeholder="One-off line (not in the catalogue)" options={catalogue.map((c) => ({ value: String(c.id), label: `${c.name}${c.default_rate ? ` · ${money(c.default_rate, c.currency)}` : ''}` }))} onChange={(e) => pickService(e.target.value)} /></Field></div>
        <div className="span-all"><Field label="Description" required error={errors.description}><Textarea rows={2} value={v.description} onChange={(e) => set('description', e.target.value)} /></Field></div>
        <Field label="Quantity" error={errors.qty}><Input type="number" step="any" min="0.01" value={v.qty} onChange={(e) => set('qty', e.target.value)} /></Field>
        <Field label="Unit"><Select value={v.unit || ''} placeholder="—" options={['engagement', 'site', 'day', 'audit', 'report', 'year']} onChange={(e) => set('unit', e.target.value)} /></Field>
        <Field label={`Rate (${quotation.currency})`} error={errors.rate}><Input type="number" step="0.01" min="0" value={v.rate} onChange={(e) => set('rate', e.target.value)} /></Field>
        <Field label="Discount %" error={errors.discount_percent} hint={settings?.discount_approval_threshold_percent ? `Above ${settings.discount_approval_threshold_percent}% needs approval` : undefined}><Input type="number" step="0.5" min="0" max="100" value={v.discount_percent} onChange={(e) => set('discount_percent', e.target.value)} /></Field>
        <Field label="GST %" error={errors.gst_rate}><Input type="number" step="0.5" min="0" max="100" value={v.gst_rate} onChange={(e) => set('gst_rate', e.target.value)} /></Field>
        <Field label="Order"><Input type="number" step="1" value={v.sort_order} onChange={(e) => set('sort_order', e.target.value)} /></Field>
        <div className="span-all small muted">Line amount before GST: <strong>{money(amount, quotation.currency)}</strong></div>
      </form>
    </Modal>
  );
}

function ReasonDialog({ title, label, placeholder, optional, busy, onClose, onConfirm }) {
  const [text, setText] = useState('');
  return (
    <Modal title={title} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button disabled={busy || (!optional && !text.trim())} onClick={() => onConfirm(text.trim())}>{busy ? 'Saving…' : 'Confirm'}</Button></>}>
      <Field label={label} required={!optional}><Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} /></Field>
    </Modal>
  );
}

function ReviseDialog({ busy, onClose, onConfirm }) {
  const [note, setNote] = useState('');
  return (
    <Modal title="Revise this quotation" subtitle="The current version is kept in the history. The revision number goes up, the date and validity restart, and it counts as not yet sent." onClose={onClose} footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button disabled={busy} onClick={() => onConfirm(note)}>{busy ? 'Revising…' : 'Revise'}</Button></>}>
      <Field label="What changed" hint="Kept with the old version"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Client asked for two sites instead of one" /></Field>
    </Modal>
  );
}

function SendDialog({ quotation, busy, onClose, onConfirm }) {
  const [email, setEmail] = useState(Boolean(quotation.contact?.email));
  const [to, setTo] = useState(quotation.contact?.email || '');
  const [message, setMessage] = useState('');
  return (
    <Modal title="Send this quotation" subtitle="Marks it as sent. Tick the box to also email the PDF to the client; the email is logged under Emails & jobs." onClose={onClose} footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button disabled={busy || (email && !to)} onClick={() => onConfirm({ email, to: email ? to : undefined, message })}>{busy ? 'Sending…' : email ? 'Send email and mark sent' : 'Mark as sent'}</Button></>}>
      <div className="stack">
        <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} /> Email the PDF to the client</label>
        {email && <Field label="To" required><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="client@company.com" /></Field>}
        {email && <Field label="Message" hint="Blank: a standard covering note"><Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}

function AcceptDialog({ quotation, busy, onClose, onConfirm }) {
  const [name, setName] = useState(quotation.contact?.name || quotation.contact_person || '');
  return (
    <Modal title="Client accepted" subtitle="Records who said yes and when. The quotation moves to Under Negotiation until the PO arrives." onClose={onClose} footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button disabled={busy || !name.trim()} onClick={() => onConfirm(name.trim())}>{busy ? 'Saving…' : 'Record acceptance'}</Button></>}>
      <Field label="Accepted by" required><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
    </Modal>
  );
}
