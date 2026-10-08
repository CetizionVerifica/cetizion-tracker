import { FileText, Plane } from 'lucide-react';
import { Sec, Tone } from './sales.jsx';
import { STAGE_TONE, STAGE_WORD, shortDate } from './money.jsx';
import { StateCard } from './daily.jsx';
import { count } from './travel.jsx';
import { api } from '../lib/api.js';
import { money } from '../lib/format.js';
import { travelInvoiceRow, travelInvoiceTotals } from '../lib/travelInvoices.js';

/**
 * The travel invoices raised on a project or a PO (#214 §5.4).
 *
 * Its own section, beside the payment stages and never inside them, because
 * a travel invoice is not a share of the order: it carries its own printed
 * amount, it takes no stage number, and it is left out of every figure that
 * answers a question about the PO's split. The **Travel** badge on each row
 * is what stops one being read as a stage at a glance.
 *
 * The amount shown is the server's `stage_amount`, which for a travel
 * invoice is its own `amount`. Nothing here multiplies anything by a PO
 * value, and no percentage is displayed, because there is none. The status
 * word and its tone come from the shared stage mapping, so a travel invoice
 * reads the same way a PO stage does wherever money is shown.
 *
 * Used by both the project and the PO page with the same props, so the two
 * cannot drift apart. `flat` follows the Timeline's convention: a `Sec`
 * inside a record's tabbed panel, or its own glass panel in a main column.
 */
export function TravelInvoicesSection({ invoices = [], action, showPo = false, flat = false }) {
  const totals = travelInvoiceTotals(invoices);
  const hint = totals.count
    ? `${money(totals.invoiced)} billed · ${money(totals.received)} received`
    : 'Travel is billed on its own invoice, separate from the payment stages';

  const body = invoices.length === 0 ? (
    <StateCard
      inPanel
      bordered={!flat}
      tone="plain"
      icon={Plane}
      title="No travel billed here yet"
      text={'A travel invoice carries its own printed amount, and may be raised on a project with no PO. '
        + 'Raise one and tick the trips it bills.'}
    />
  ) : (
    <div className="mg-tablewrap">
      <table className="mg-table" aria-label="Travel invoices">
        <thead>
          <tr>
            <th>Invoice</th>
            {showPo && <th>PO</th>}
            <th>Trips</th>
            <th className="num">Amount</th>
            <th className="num">Received</th>
            <th>Status</th>
            <th aria-label="Document" />
          </tr>
        </thead>
        <tbody>
          {invoices.map((stage) => {
            const row = travelInvoiceRow(stage);
            return (
              <tr key={row.id}>
                <td style={{ whiteSpace: 'normal' }}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="app-lead mg-num">{row.invoiceNo || '—'}</span>
                    {/* Beside the number, not under it: this badge is what
                        stops a travel invoice being read as a PO stage. */}
                    <Tone>Travel</Tone>
                  </span>
                  <span className="app-sub2">{row.invoiceDate ? shortDate(row.invoiceDate) : 'no date'}</span>
                </td>
                {showPo && (
                  <td className="mg-num">{row.poNumber || <span className="mg-muted">no PO</span>}</td>
                )}
                <td>
                  {row.tripCount === null
                    ? <span className="mg-muted">—</span>
                    : count(row.tripCount, 'trip')}
                </td>
                {/* Its own printed total. No percentage, because a travel
                    invoice is not a share of anything. */}
                <td className="num font-bold">{money(row.amount)}</td>
                <td className="num">{money(row.received)}</td>
                <td><Tone tone={STAGE_TONE[row.status] || 'plain'}>{STAGE_WORD[row.status] || row.status}</Tone></td>
                <td>
                  {row.documentId ? (
                    <a
                      className="app-link inline-flex items-center gap-1"
                      href={api.documentUrl(row.documentId)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FileText className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                      Invoice
                    </a>
                  ) : <span className="mg-muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  if (flat) {
    return (
      <Sec id="travel-invoices" title="Travel invoices" hint={hint} tools={action}>
        <div className="app-box app-box--flush">{body}</div>
      </Sec>
    );
  }
  return (
    <section className="mg-glass mg-glass--strong app-panel" aria-labelledby="travel-invoices-title" data-a="rise">
      <div className="app-panel__head">
        <div className="app-panel__titles">
          <h2 id="travel-invoices-title" className="mg-panel__title">Travel invoices</h2>
          <span className="mg-panel__hint">{hint}</span>
        </div>
        <div className="app-panel__tools">{action}</div>
      </div>
      {body}
    </section>
  );
}
