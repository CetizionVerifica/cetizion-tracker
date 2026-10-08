import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileText, Plane, Receipt } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { Alert, ConfirmDialog, ErrorState, useToast } from '../components/ui.jsx';
import { Chip, RecordPage, RecordRow, RecordSection, RecordStat } from '../components/record.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { PayVendorDialog } from '../components/actions.jsx';
import { Button } from '../components/ui/button';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';
import { creditNoteFields, vendorInvoiceFields } from './VendorInvoices.jsx';

/**
 * One travel agency invoice (#196 §4.4): the bill, a line for each leg or
 * trip it charges (one bill covers several trips and people), the credit
 * and cancellation notes against it, and what is still to pay.
 */
export default function VendorInvoiceDetail() {
  const { id } = useParams();
  const lookups = useLookups();
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/vendor-invoices/${encodeURIComponent(id)}/full`), [id]);
  const invoice = data?.data?.invoice;
  const lines = data?.data?.lines ?? [];
  const credits = data?.data?.credit_notes ?? [];
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
      changed();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <><PageHeader title="Vendor invoice" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (loading || !invoice) return <><PageHeader title="Vendor invoice" /><div className="page"><div className="skeleton h-[200px]" /></div></>;

  const lineFields = [
    { name: 'vendor_invoice_id', label: 'Invoice', type: 'hidden' },
    { name: 'travel_id', label: 'Trip', type: 'select', required: true, options: lookups.trips.map((t) => ({ value: t.travel_id, label: `${t.travel_id} — ${t.employee_name}${t.destination ? ` (${t.destination})` : ''}` })) },
    { name: 'segment_id', label: 'Leg', type: 'select', options: legs.map((l) => ({ value: String(l.id), label: `${l.travel_id}: ${l.mode} ${l.from_place || ''} → ${l.to_place || ''} ${l.start_date || ''}` })), hint: 'Optional: the leg this line bills' },
    { name: 'base_fare', label: 'Fare', type: 'money' },
    { name: 'service_charge', label: 'Service charge', type: 'money' },
    { name: 'gst_amount', label: 'GST', type: 'money' },
    { name: 'gst_rate', label: 'GST rate (%)', type: 'number' },
    { name: 'line_total', label: 'Line total', type: 'money', hint: 'As the vendor printed it; the invoice total is the sum of the lines' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
  const sum = (key) => lines.reduce((n, l) => n + Number(l[key] || 0), 0);
  const mismatch = lines.filter((l) => l.line_total !== null && [l.base_fare, l.service_charge, l.gst_amount].some((v) => v !== null)
    && Math.abs(Number(l.line_total) - (Number(l.base_fare || 0) + Number(l.service_charge || 0) + Number(l.gst_amount || 0))) > 1);

  return (
    <RecordPage
      parent="Vendor invoices"
      parentTo="/vendor-invoices"
      title={`${invoice.travel_vendor || 'Vendor'} · ${invoice.vendor_invoice_no || invoice.vendor_invoice_id}`}
      mark={<Receipt className="size-5" strokeWidth={1.75} aria-hidden="true" />}
      markTone={invoice.payment_status === 'Overdue' ? 'late' : undefined}
      action={
        <div className="flex gap-2">
          {invoice.payment_status !== 'Paid' && invoice.invoice_amount !== null && (
            <Button size="sm" className="h-8 px-4 text-[13px]" onClick={() => setDialog({ type: 'pay' })}>Pay</Button>
          )}
          <Button size="sm" variant="outline" className="h-8 px-4 text-[13px]" onClick={() => setDialog({ type: 'invoice' })}>Edit invoice</Button>
        </div>
      }
      facts={[
        <span key="ref" className="num text-[12px]">{invoice.vendor_invoice_id}</span>,
        invoice.invoice_date && `Dated ${date(invoice.invoice_date)}`,
        invoice.pay_by && `Pay by ${date(invoice.pay_by)}`,
        <Chip key="status" tone={invoice.payment_status === 'Overdue' ? 'late' : invoice.payment_status === 'Paid' ? 'settled' : 'waiting'}>{invoice.payment_status}</Chip>,
        invoice.vendor_gstin_on_invoice && `GSTIN ${invoice.vendor_gstin_on_invoice}`,
      ]}
      stats={
        <>
          <RecordStat label="Invoice total" value={invoice.invoice_amount === null ? '—' : money(invoice.invoice_amount)} detail={`${lines.length} line${lines.length === 1 ? '' : 's'} · ${invoice.trip_count} trip${invoice.trip_count === 1 ? '' : 's'}`} />
          <RecordStat label="Credit notes" value={money(invoice.credited)} detail={credits.length ? `${credits.length} against this bill` : 'None'} />
          <RecordStat label="To pay" value={money(invoice.net_payable === null ? null : Number(invoice.net_payable) - Number(invoice.amount_paid))} detail={`${money(invoice.amount_paid)} paid of ${money(invoice.net_payable)}`} />
        </>
      }
    >
      {mismatch.length > 0 && (
        <Alert tone="warning">{mismatch.length} line{mismatch.length === 1 ? ' does' : 's do'} not add up: fare + charge + GST is not the line total.</Alert>
      )}

      <RecordSection
        title="Lines"
        hint="one per leg or trip billed"
        action={<Button size="sm" variant="outline" className="h-7 px-3 text-[12.5px]" onClick={() => setDialog({ type: 'line', row: { vendor_invoice_id: invoice.id } })}>Add a line</Button>}
      >
        {lines.length === 0 ? (
          <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No lines yet. Add one per trip or leg this bill charges for.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[12.5px] text-secondary-text">
              <thead>
                <tr className="border-b border-border eyebrow">
                  <th className="px-5 py-2 text-left font-medium">Trip</th>
                  <th className="px-2 py-2 text-left font-medium">Leg</th>
                  <th className="px-2 py-2 text-right font-medium">Fare</th>
                  <th className="px-2 py-2 text-right font-medium">Charge</th>
                  <th className="px-2 py-2 text-right font-medium">GST</th>
                  <th className="px-2 py-2 text-right font-medium">Total</th>
                  <th className="px-2 py-2 text-right font-medium">Credited</th>
                  <th className="px-5 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-border/60">
                    <td className="px-5 py-2"><a className="num underline underline-offset-2" href={`/travel/${encodeURIComponent(l.travel_id)}`}>{l.travel_id}</a><div className="text-muted-foreground">{l.employee_name}</div></td>
                    <td className="px-2 py-2">{l.mode ? <>{l.mode} {l.from_place} → {l.to_place}<div className="text-muted-foreground">{date(l.leg_date)}{l.leg_status !== 'booked' && ` · ${l.leg_status}`}</div></> : <span className="text-muted-foreground">—</span>}</td>
                    <td className="num px-2 py-2 text-right">{money(l.base_fare)}</td>
                    <td className="num px-2 py-2 text-right">{money(l.service_charge)}</td>
                    <td className="num px-2 py-2 text-right">{money(l.gst_amount)}</td>
                    <td className="num px-2 py-2 text-right font-semibold text-foreground">{money(l.line_total)}</td>
                    <td className="num px-2 py-2 text-right">{Number(l.credited) ? money(l.credited) : '—'}</td>
                    <td className="px-5 py-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setDialog({ type: 'line', row: l })}>Edit</Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={() => setDialog({ type: 'delete', resource: 'vendor-invoice-lines', row: l, title: 'Remove this line?', done: 'Line removed.' })}>Remove</Button>
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold text-foreground">
                  <td className="px-5 py-2" colSpan={5}>Total</td>
                  <td className="num px-2 py-2 text-right">{money(sum('line_total'))}</td>
                  <td className="num px-2 py-2 text-right">{money(sum('credited'))}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </RecordSection>

      <RecordSection
        title="Credit and cancellation notes"
        hint="what the agency gave back against this bill"
        action={<Button size="sm" variant="outline" className="h-7 px-3 text-[12.5px]" onClick={() => setDialog({ type: 'credit', row: { vendor_id: invoice.vendor_id, against_invoice_id: invoice.id, kind: 'credit_note' } })}>Add a note</Button>}
      >
        {credits.length === 0 && <p className="px-5 py-4 text-[12.5px] text-muted-foreground">None.</p>}
        {credits.map((c, i) => (
          <RecordRow
            key={c.id}
            icon={FileText}
            last={i === credits.length - 1}
            title={<>{c.kind === 'cancellation_note' ? 'Cancellation note' : 'Credit note'} <span className="num text-[12px]">{c.credit_note_no}</span>
              <span className="block text-[12px] text-muted-foreground">{date(c.credit_note_date)}{c.cancellation_charges ? ` · ${money(c.cancellation_charges)} charged` : ''}{c.document_id && <> · <a className="underline" href={api.documentUrl(c.document_id)} target="_blank" rel="noreferrer">{c.document_name || 'PDF'}</a></>}</span></>}
            amount={money(c.refund_amount)}
          />
        ))}
      </RecordSection>

      <RecordSection title="The bill" hint="the agency's PDF">
        {invoice.document_id ? (
          <RecordRow icon={FileText} title={<a className="underline underline-offset-2" href={api.documentUrl(invoice.document_id)} target="_blank" rel="noreferrer">{invoice.document_name || 'Invoice PDF'}</a>} last />
        ) : (
          <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No PDF on file. Add it with Edit invoice.</p>
        )}
      </RecordSection>

      {trips.length > 0 && (
        <RecordSection title="Trips on this bill">
          {trips.map((t, i) => (
            <RecordRow key={t} icon={Plane} to={`/travel/${encodeURIComponent(t)}`} last={i === trips.length - 1}
              title={<><span className="num text-[12px]">{t}</span> · {lines.find((l) => l.travel_id === t)?.employee_name}</>}
              amount={money(lines.filter((l) => l.travel_id === t).reduce((n, l) => n + Number(l.net_cost || 0), 0))} />
          ))}
        </RecordSection>
      )}

      {dialog?.type === 'invoice' && (
        <RecordForm title="Edit vendor invoice" resource="vendor-invoices" record={invoice} fields={vendorInvoiceFields(lookups)} onClose={close} onSaved={changed} />
      )}
      {dialog?.type === 'line' && (
        <RecordForm title={dialog.row.id ? 'Edit line' : 'Add a line'} resource="vendor-invoice-lines" record={dialog.row} fields={lineFields} onClose={close} onSaved={changed} />
      )}
      {dialog?.type === 'credit' && (
        <RecordForm title="Add a credit or cancellation note" resource="vendor-credit-notes" record={dialog.row} fields={creditNoteFields(lookups, { invoices: [invoice], legs })} onClose={close} onSaved={changed} />
      )}
      {dialog?.type === 'pay' && (
        <PayVendorDialog invoice={invoice} onClose={close} onDone={changed} />
      )}
      {dialog?.type === 'delete' && (
        <ConfirmDialog title={dialog.title} message="This cannot be undone." confirmLabel="Remove" busy={busy} onConfirm={remove} onClose={close} />
      )}
    </RecordPage>
  );
}
