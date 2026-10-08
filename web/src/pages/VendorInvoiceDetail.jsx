import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, ExternalLink, FileText, Pencil, Plane, Plus, Receipt, Trash2, Undo2 } from 'lucide-react';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { RecordMenuItem, RecordPage, RecordStat } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { PayVendorDialog } from '../components/actions.jsx';
import { ListTable, PhoneRow } from '../components/daily.jsx';
import { Sec, Tone, useTab } from '../components/sales.jsx';
import { MoneyBanner, shortDate } from '../components/money.jsx';
import { BILL, RailCard, RailLink, RecordState, StateBadge, TabsPanel, count } from '../components/travel.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { fileSize, money } from '../lib/format.js';
import { billNext, creditNoteFields, vendorInvoiceFields } from './VendorInvoices.jsx';

/**
 * One travel agency invoice (#196 §4.4), in the Wave 6 bill page shape: the
 * header with its facts and Pay, three figures (total, credit notes, to pay
 * with its bar), then Lines / Credit notes / Documents as tabs beside the
 * bill's PDF and the trips it covers. A bill with no amount leads with
 * "Enter the amount"; lines that don't add up say so; credit notes can be
 * edited and removed; the bill can be deleted from its own page.
 */
export default function VendorInvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const lookups = useLookups();
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useTab(['lines', 'notes', 'docs']);
  const { data, loading, error, errorStatus, refetch } = useFetch(() => api.raw(`/vendor-invoices/${encodeURIComponent(id)}/full`), [id]);
  const invoice = data?.data?.invoice;
  const lines = data?.data?.lines ?? [];
  const credits = data?.data?.credit_notes ?? [];
  const files = data?.data?.documents ?? [];
  const trips = [...new Set(lines.map((l) => l.travel_id))];
  const { data: legData } = useFetch(
    () => (trips.length ? Promise.all(trips.map((t) => api.list('travel-segments', { travel_id: t }))) : Promise.resolve([])),
    [trips.join(',')]
  );
  const legs = (legData || []).flatMap((r) => r?.data ?? []);
  const close = () => setDialog(null);
  const changed = () => { close(); refetch(); };

  async function remove() {
    setBusy(true);
    try {
      await api.remove(dialog.resource, dialog.row.id);
      toast(dialog.done, 'success');
      if (dialog.resource === 'vendor-invoices') { navigate('/vendor-invoices'); return; }
      changed();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (error || loading || !invoice) {
    return <RecordState parent="Vendor invoices" parentTo="/vendor-invoices" crumb={invoice?.vendor_invoice_no || `bill ${id}`} noun="vendor invoice" loading={!error} missing={errorStatus === 404} error={error} onRetry={refetch} />;
  }

  const no = invoice.vendor_invoice_no || invoice.vendor_invoice_id;
  const noAmount = invoice.invoice_amount === null;
  const outstanding = noAmount ? null : Math.max(Number(invoice.net_payable) - Number(invoice.amount_paid || 0), 0);
  const paidShare = noAmount || !Number(invoice.net_payable) ? 0 : Math.min(100, (100 * Number(invoice.amount_paid || 0)) / Number(invoice.net_payable));
  const overdue = invoice.payment_status === 'Overdue';

  const lineFields = [
    { name: 'vendor_invoice_id', label: 'Invoice', type: 'hidden' },
    { name: 'travel_id', label: 'Trip', type: 'select', required: true, options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })) },
    { name: 'segment_id', label: 'Leg', type: 'select', options: legs.map((l) => ({ value: String(l.id), label: `${l.travel_id}: ${l.mode} ${l.from_place || ''} → ${l.to_place || ''} ${l.start_date ? shortDate(l.start_date) : ''}` })), hint: 'Optional: the leg this line bills' },
    { name: 'base_fare', label: 'Fare', type: 'money' },
    { name: 'service_charge', label: 'Service charge', type: 'money' },
    { name: 'gst_amount', label: 'GST', type: 'money' },
    { name: 'gst_rate', label: 'GST rate (%)', type: 'number' },
    { name: 'line_total', label: 'Line total', type: 'money', span: 2, hint: 'As the vendor printed it; the invoice total is the sum of the lines' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
  const sum = (key) => lines.reduce((n, l) => n + Number(l[key] || 0), 0);
  const partsOf = (l) => Number(l.base_fare || 0) + Number(l.service_charge || 0) + Number(l.gst_amount || 0);
  const isOff = (l) => l.line_total !== null && [l.base_fare, l.service_charge, l.gst_amount].some((v) => v !== null) && Math.abs(Number(l.line_total) - partsOf(l)) > 1;
  const mismatch = lines.filter(isOff);
  const tripCost = (t) => lines.filter((l) => l.travel_id === t).reduce((n, l) => n + Number(l.net_cost || 0), 0);
  const legLine = (l) => (l.mode ? `${l.mode[0].toUpperCase()}${l.mode.slice(1)} ${l.from_place ? `${l.from_place} → ` : ''}${l.to_place || ''}`.trim() : 'The whole trip');

  const tabs = [
    { key: 'lines', label: 'Lines', count: lines.length || undefined },
    { key: 'notes', label: 'Credit notes', count: credits.length || undefined },
    { key: 'docs', label: 'Documents', count: (invoice.document_id ? 1 : 0) + files.length || undefined },
  ];
  const newNote = () => setDialog({ type: 'credit', row: { vendor_id: invoice.vendor_id, against_invoice_id: invoice.id, kind: 'credit_note' } });

  return (
    <>
      <RecordPage
        parent="Vendor invoices"
        parentTo="/vendor-invoices"
        crumb={no}
        eyebrow="Travel vendor invoice"
        title={`${invoice.travel_vendor || 'Vendor'} · ${no}`}
        mark={<Receipt className="size-5" strokeWidth={1.75} aria-hidden="true" />}
        markTone={overdue ? 'late' : undefined}
        badges={(
          <>
            {overdue && invoice.days_overdue > 0
              ? <Tone tone="late">Overdue · {count(invoice.days_overdue, 'day')}</Tone>
              : <StateBadge map={BILL} value={invoice.payment_status} />}
            <Tone>{count(invoice.trip_count, 'trip')}</Tone>
          </>
        )}
        action={(
          <>
            {noAmount
              ? <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'invoice' })}><Pencil className="size-4" strokeWidth={1.8} aria-hidden="true" />Enter the amount</button>
              : <button type="button" className="mg-btn" onClick={() => setDialog({ type: 'invoice' })}><Pencil className="size-4" strokeWidth={1.8} aria-hidden="true" />Edit invoice</button>}
            {invoice.payment_status !== 'Paid' && !noAmount && (
              <button type="button" className="mg-btn mg-btn--primary" onClick={() => setDialog({ type: 'pay' })}>Pay {money(outstanding)}</button>
            )}
          </>
        )}
        menu={(
          <>
            <RecordMenuItem onSelect={() => setDialog({ type: 'line', row: { vendor_invoice_id: invoice.id } })}>Add a line</RecordMenuItem>
            <RecordMenuItem onSelect={newNote}>Add a credit or cancellation note</RecordMenuItem>
            <RecordMenuItem danger onSelect={() => setDialog({ type: 'delete', resource: 'vendor-invoices', row: invoice, title: `Delete ${no}?`, text: `${invoice.travel_vendor || 'Vendor'} · ${noAmount ? 'no amount' : money(invoice.invoice_amount)}. This cannot be undone. Its ${count(lines.length, 'line')} go with it, and ${trips.length > 1 ? `its ${trips.length} trips no longer count` : 'its trip no longer counts'} this cost.${Number(invoice.amount_paid) > 0 ? ` ${money(invoice.amount_paid)} was paid on it.` : ''}`, confirm: 'Delete bill', done: 'Bill deleted.' })}>Delete this bill</RecordMenuItem>
          </>
        )}
        factsGrid={[
          { label: 'Reference', value: invoice.vendor_invoice_id },
          { label: 'Dated', value: invoice.invoice_date ? shortDate(invoice.invoice_date) : null },
          { label: 'Pay by', value: invoice.pay_by ? <span className={overdue ? 'text-late' : undefined}>{shortDate(invoice.pay_by)}{overdue && invoice.days_overdue ? `, ${count(invoice.days_overdue, 'day')} ago` : ''}</span> : null },
          { label: 'GSTIN', value: invoice.vendor_gstin_on_invoice },
          { label: 'Place of supply', value: invoice.place_of_supply },
          { label: 'Payment terms', value: invoice.payment_terms_days != null ? `${invoice.payment_terms_days} days, for the record` : null },
          { label: 'Raised', value: invoice.raised_in_time ? (invoice.raised_in_time === 'On time' ? 'On time' : invoice.raised_in_time.replace(/Late \((\d+)d\)/, '$1 days late')) : null },
        ]}
        stats={(
          <>
            <RecordStat
              label="Invoice total"
              value={noAmount ? <span className="text-caramel-text">Not entered</span> : money(invoice.invoice_amount)}
              detail={noAmount ? 'Enter it from the bill' : `${count(lines.length, 'line')} · ${count(invoice.trip_count, 'trip')}`}
            />
            <RecordStat
              label="Credit notes"
              value={Number(invoice.credited) > 0 ? money(invoice.credited) : <span className="text-secondary-text">None</span>}
              detail={credits.length ? `${credits.length} against this bill` : 'Nothing given back yet'}
            />
            <div className="mg-glass mg-tile" data-a="rise">
              <span className="mg-label">To pay</span>
              <span className={`mg-tile__figure mg-num ${overdue ? 'text-late' : ''}`}>{noAmount ? '—' : money(outstanding)}</span>
              {!noAmount && Number(invoice.net_payable) > 0 && (
                <span className="mg-progress app-paybar" role="img" aria-label={`${money(invoice.amount_paid)} paid, ${money(outstanding)} still to pay`}>
                  <span className="mg-progress__done" style={{ width: `${paidShare}%` }} />
                  <span className="mg-progress__expected" style={{ width: `${100 - paidShare}%` }} />
                </span>
              )}
              <span className="mg-tile__foot"><span>{noAmount ? 'Known once the amount is in' : `${money(invoice.amount_paid)} paid of ${money(invoice.net_payable)}`}</span></span>
            </div>
          </>
        )}
        notice={(
          <>
            {noAmount && (
              <MoneyBanner tone="wait" title="This bill has no amount yet." action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'invoice' })}>Enter the amount</button>}>
                It can't be paid, chased or counted against {trips.length > 1 ? 'its trips' : 'its trip'} until the figure from the bill is in. {billNext(invoice).text.replace(/^HR: /, '')}.
              </MoneyBanner>
            )}
            {mismatch.length > 0 && (
              <MoneyBanner tone="wait" title={`${count(mismatch.length, 'line')} ${mismatch.length === 1 ? "doesn't" : "don't"} add up.`} action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => { setTab('lines'); setDialog({ type: 'line', row: mismatch[0] }); }}>Check the line</button>}>
                Fare, charge and GST should make the line total: {mismatch.map((l) => `${l.travel_id} adds to ${money(partsOf(l))}, the total says ${money(l.line_total)}`).join('; ')}.
              </MoneyBanner>
            )}
          </>
        )}
        bodyClassName="app-w6"
        rail={(
          <>
            <RailCard title="The bill" hint="The agency's PDF">
              {invoice.document_id ? (
                <div className="app-pdf">
                  <span className="app-pdf__page" aria-hidden="true"><i /><i /><i /><i /></span>
                  <div className="min-w-0">
                    <b>{invoice.document_name || 'Invoice PDF'}</b>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <a className="mg-btn mg-btn--sm" href={api.documentUrl(invoice.document_id)} target="_blank" rel="noreferrer"><ExternalLink className="size-4" strokeWidth={1.8} aria-hidden="true" />Open PDF</a>
                      <a className="mg-btn mg-btn--ghost mg-btn--sm" href={api.documentUrl(invoice.document_id)} download><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Download</a>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="app-w6card__note">No PDF on file. Add it with {noAmount ? 'Enter the amount' : 'Edit invoice'}, or upload it from Trips named {no.replace(/\//g, '-')}.pdf and it files itself.</p>
              )}
            </RailCard>
            <RailCard title="Trips on this bill">
              {trips.length === 0 ? (
                <p className="app-w6card__note">{invoice.travel_id ? `${invoice.travel_id}, chosen on the bill.` : 'No trip yet. Add a line per trip this bill charges for.'}</p>
              ) : (
                <div className="pb-1">
                  {trips.map((t) => {
                    const l = lines.find((x) => x.travel_id === t);
                    return (
                      <RailLink key={t} to={`/travel/${encodeURIComponent(t)}`} icon={Plane} label={`Open trip ${t}, ${l?.employee_name || ''}`}
                        title={`${t} · ${l?.employee_name || ''}`}
                        sub={[l?.destination, l?.travel_start_date && shortDate(l.travel_start_date)].filter(Boolean).join(' · ')}
                        end={noAmount ? '—' : money(tripCost(t))} />
                    );
                  })}
                  {!noAmount && trips.length > 1 && (
                    <div className="app-raillink app-raillink--total"><span /><span className="app-raillink__title">{count(trips.length, 'trip')}, net of credit notes</span><span className="app-raillink__end">{money(invoice.net_payable)}</span></div>
                  )}
                </div>
              )}
            </RailCard>
          </>
        )}
      >
        <TabsPanel id="bill" label={`${no}: lines, credit notes and documents`} tabs={tabs} active={tab} onChange={setTab}>
          {tab === 'lines' && (
            <Sec id="bill-lines" title="Lines" hint="One per leg or trip billed"
              tools={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setDialog({ type: 'line', row: { vendor_invoice_id: invoice.id } })}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add a line</button>}>
              {lines.length === 0 ? (
                <p className="app-tabnote">No lines yet. Add one per trip or leg this bill charges for; with lines, the bill's total follows them.</p>
              ) : (
                <div className="app-box app-box--flush">
                  <ListTable
                    label="Lines on this bill"
                    bordered={false}
                    rows={lines}
                    rowClassName={(l) => (isOff(l) ? 'app-gaprow' : undefined)}
                    columns={[
                      { key: 'trip', header: 'Trip', render: (l) => <><Link className="app-link mg-num" to={`/travel/${encodeURIComponent(l.travel_id)}`}>{l.travel_id}</Link><span className="sub">{l.employee_name}</span></> },
                      { key: 'leg', header: 'Leg', className: 'app-wrap--sm', render: (l) => <>{legLine(l)}<span className="sub">{[l.leg_date && shortDate(l.leg_date), l.leg_status && l.leg_status !== 'booked' && (l.leg_status === 'cancelled' ? 'cancelled' : 'partly refunded')].filter(Boolean).join(' · ') || '—'}</span></> },
                      { key: 'fare', header: 'Fare', num: true, render: (l) => money(l.base_fare) },
                      { key: 'chg', header: 'Charge', num: true, render: (l) => money(l.service_charge) },
                      { key: 'gst', header: 'GST', num: true, render: (l) => money(l.gst_amount) },
                      { key: 'total', header: 'Total', num: true, render: (l) => <><b>{money(l.line_total)}</b>{isOff(l) && <span className="sub text-caramel-text">Parts add to {money(partsOf(l))}</span>}</> },
                      { key: 'cred', header: 'Credited', num: true, render: (l) => (Number(l.credited) ? <span className="text-ok">− {money(l.credited)}</span> : <span className="text-muted-foreground">—</span>) },
                      {
                        key: 'act', header: '', className: 'actions', render: (l) => (
                          <span className="app-rowacts">
                            <button type="button" className="mg-iconbtn" aria-label={`Edit the ${l.travel_id} line`} title="Edit" onClick={() => setDialog({ type: 'line', row: l })}><Pencil strokeWidth={1.8} aria-hidden="true" /></button>
                            <button type="button" className="mg-iconbtn" aria-label={`Remove the ${l.travel_id} line`} title="Remove" onClick={() => setDialog({ type: 'delete', resource: 'vendor-invoice-lines', row: l, title: 'Remove this line?', text: `${l.travel_id} · ${legLine(l)} · ${money(l.line_total)}. This cannot be undone. The bill's total drops by this much, and so does the trip's cost.`, confirm: 'Remove line', done: 'Line removed.' })}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                          </span>
                        ),
                      },
                    ]}
                    phone={(l) => <PhoneRow title={`${l.travel_id} · ${l.employee_name}`} amount={money(l.line_total)} meta={`${legLine(l)} · fare ${money(l.base_fare)} · charge ${money(l.service_charge)} · GST ${money(l.gst_amount)}${isOff(l) ? ` · parts add to ${money(partsOf(l))}` : ''}`} state={Number(l.credited) ? <Tone tone="ok">{money(l.credited)} credited</Tone> : null} onClick={() => setDialog({ type: 'line', row: l })} label={`Edit the ${l.travel_id} line`} />}
                  />
                  <div className="app-linetotal">
                    <span>Total · {count(lines.length, 'line')}</span>
                    <span className="mg-num">{money(sum('line_total'))}</span>
                    {Number(sum('credited')) > 0 && <span className="mg-num text-ok">− {money(sum('credited'))} credited</span>}
                  </div>
                </div>
              )}
            </Sec>
          )}

          {tab === 'notes' && (
            <Sec id="bill-notes" title="Credit and cancellation notes" hint="What the agency gave back against this bill"
              tools={<button type="button" className="mg-btn mg-btn--sm" onClick={newNote}><Plus className="size-4" strokeWidth={2} aria-hidden="true" />Add a note</button>}>
              {credits.length === 0 ? (
                <p className="app-tabnote">None against this bill. When the agency refunds a cancelled leg or credits the bill, add its note; it comes off what we owe.</p>
              ) : (
                <div>
                  {credits.map((c) => {
                    const leg = legs.find((l) => l.id === c.segment_id);
                    return (
                      <div key={c.id} className="app-line">
                        <span className="app-line__mark is-ok"><Undo2 strokeWidth={1.8} aria-hidden="true" /></span>
                        <div className="app-line__text">
                          <span className="app-line__title">{c.credit_note_no}</span>
                          <span className="app-line__meta">{[c.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note', c.credit_note_date && shortDate(c.credit_note_date), leg && `${leg.travel_id} ${leg.mode} ${leg.from_place || ''} → ${leg.to_place || ''}`.trim(), Number(c.cancellation_charges) > 0 && `charges ${money(c.cancellation_charges)}`].filter(Boolean).join(' · ')}</span>
                          {c.document_id && <a className="app-line__meta app-link" href={api.documentUrl(c.document_id)} target="_blank" rel="noreferrer">{c.document_name || 'The note\'s PDF'}</a>}
                        </div>
                        <div className="app-line__end">
                          <span className="app-line__amount text-ok">− {money(c.refund_amount)}</span>
                          <button type="button" className="mg-iconbtn" aria-label={`Edit ${c.credit_note_no}`} title="Edit" onClick={() => setDialog({ type: 'credit', row: c })}><Pencil strokeWidth={1.8} aria-hidden="true" /></button>
                          <button type="button" className="mg-iconbtn" aria-label={`Remove ${c.credit_note_no}`} title="Remove" onClick={() => setDialog({ type: 'delete', resource: 'vendor-credit-notes', row: c, title: `Remove ${c.credit_note_no}?`, text: `${money(c.refund_amount)} back on this bill. This cannot be undone. What we owe on the bill goes up by ${money(c.refund_amount)}${c.segment_id ? ', and the leg it named is no longer marked by it' : ''}.`, confirm: 'Remove note', done: 'Credit note removed.' })}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Sec>
          )}

          {tab === 'docs' && (
            <Sec id="bill-docs" title="Documents" hint="The bill's PDF, and any other copy filed against it">
              <div>
                {invoice.document_id ? (
                  <div className="app-line">
                    <span className="app-line__mark"><FileText strokeWidth={1.8} aria-hidden="true" /></span>
                    <div className="app-line__text">
                      <a className="app-line__title" href={api.documentUrl(invoice.document_id)} target="_blank" rel="noreferrer" aria-label={`Open ${invoice.document_name || 'the invoice PDF'} in a new tab`}>{invoice.document_name || 'Invoice PDF'}</a>
                      <span className="app-line__meta">The bill's own PDF · replace it with {noAmount ? 'Enter the amount' : 'Edit invoice'}</span>
                    </div>
                    <div className="app-line__end"><Tone>Invoice PDF</Tone></div>
                  </div>
                ) : (
                  <div className="app-line">
                    <span className="app-line__mark is-gap"><FileText strokeWidth={1.8} aria-hidden="true" /></span>
                    <div className="app-line__text">
                      <span className="app-line__title">The invoice PDF: not on file yet</span>
                      <span className="app-line__meta">Add it with {noAmount ? 'Enter the amount' : 'Edit invoice'}, or upload {no.replace(/\//g, '-')}.pdf from Trips</span>
                    </div>
                    <div className="app-line__end"><Tone tone="wait">Needed</Tone></div>
                  </div>
                )}
                {files.map((f) => (
                  <div key={f.id} className="app-line">
                    <span className="app-line__mark"><FileText strokeWidth={1.8} aria-hidden="true" /></span>
                    <div className="app-line__text">
                      <a className="app-line__title" href={api.documentUrl(f.document_id)} target="_blank" rel="noreferrer" aria-label={`Open ${f.label || f.file_name} in a new tab`}>{f.label || f.file_name}</a>
                      <span className="app-line__meta">{[f.size_bytes && fileSize(f.size_bytes), f.created_at && `filed ${shortDate(f.created_at)}`].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="app-line__end">
                      <Tone tone="info">Attachment</Tone>
                      <button type="button" className="mg-iconbtn" aria-label={`Remove ${f.label || f.file_name}`} title="Remove" onClick={() => setDialog({ type: 'delete', resource: 'attachments', row: f, title: 'Remove this file from the bill?', text: `${f.label || f.file_name}. This cannot be undone; upload it again if you need it back.`, confirm: 'Remove file', done: 'File removed.' })}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </Sec>
          )}
        </TabsPanel>
      </RecordPage>

      {dialog?.type === 'invoice' && (
        <RecordForm
          title={noAmount ? 'Enter the amount' : 'Edit vendor invoice'}
          subtitle={`${invoice.travel_vendor || 'Vendor'} · ${no}${lines.length ? ` · ${count(lines.length, 'line')}` : ''}`}
          size="lg"
          resource="vendor-invoices"
          record={invoice}
          fields={vendorInvoiceFields(lookups, invoice)}
          onClose={close}
          onSaved={changed}
        />
      )}
      {dialog?.type === 'line' && (
        <RecordForm
          title={dialog.row.id ? 'Edit line' : 'Add a line'}
          subtitle={dialog.row.id ? `${dialog.row.travel_id} · ${no}` : `On ${no} · the bill's total follows its lines`}
          submitLabel={dialog.row.id ? undefined : 'Add line'}
          resource="vendor-invoice-lines"
          record={dialog.row}
          fields={lineFields}
          onClose={close}
          onSaved={changed}
        />
      )}
      {dialog?.type === 'credit' && (
        <RecordForm
          title={dialog.row.id ? 'Edit credit note' : 'Add a credit or cancellation note'}
          subtitle={dialog.row.id ? `${dialog.row.credit_note_no} · ${money(dialog.row.refund_amount)} refunded` : `Against ${no}: it comes off what we owe on this bill`}
          submitLabel={dialog.row.id ? undefined : 'Add note'}
          size="lg"
          resource="vendor-credit-notes"
          record={dialog.row}
          fields={creditNoteFields(lookups, { invoices: [invoice], legs })}
          onClose={close}
          onSaved={changed}
        />
      )}
      {dialog?.type === 'pay' && (
        <PayVendorDialog invoice={invoice} onClose={close} onDone={changed} />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog title={dialog.title} message={dialog.text} confirmLabel={dialog.confirm} busy={busy} onConfirm={remove} onClose={close} />
      )}
    </>
  );
}
