import { Link } from 'react-router-dom';
import { cn } from 'cn';
import { Alert, Badge, Card, DataTable, Empty, ErrorState } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, number, percent, periodLabel } from '../lib/format.js';

const rateTitle = (details = []) => details.length
  ? details.map((item) => `${item.currency}: ₹${item.rate} from ${item.effective_from}`).join('\n')
  : undefined;
const inr = (value, details) => (value === null || value === undefined
  ? <span className="muted">—</span>
  : <span title={rateTitle(details)}>{money(value, 'INR')}</span>);
const warn = { color: 'var(--warn-fg)' };

function CsvButton({ report, params, disabled }) {
  if (disabled) return <button type="button" className="btn btn--sm" disabled>Download CSV</button>;
  return <a className="btn btn--sm" href={api.reportCsvUrl(report, params)} download>Download CSV</a>;
}

function Intake({ row }) {
  return (
    <>
      {inr(row.order_intake_inr, row.rate_details)}
      {row.order_unconverted.length > 0 && (
        <div className="small" style={warn}>
          + {row.order_unconverted.map((a) => money(a.amount, a.currency)).join(' · ')} (rate not set)
        </div>
      )}
      {row.orders_without_value > 0 && <div className="small muted">{row.orders_without_value} with no value</div>}
    </>
  );
}

/**
 * What the currency itself gained or lost between billing and collection:
 * the amount received times the difference between the rate on the payment
 * date and the rate on the invoice date. Always zero on INR POs.
 */
function GainLoss({ row }) {
  const value = row.fx_gain_loss_inr;
  if (!value) return <span className="muted">—</span>;
  const tone = value > 0 ? { color: 'var(--ok-fg)' } : warn;
  return (
    <span style={tone} title="Received × (rate on the payment date − rate on the invoice date)">
      {value > 0 ? '+' : '−'}{money(Math.abs(value), 'INR')}
    </span>
  );
}

/** An INR amount, or the native currency with a "rate not set" note when it could not be converted. */
function OverdueAmount({ inrValue, amount, currency }) {
  if (inrValue !== null && inrValue !== undefined) return <span>{money(inrValue, 'INR')}</span>;
  return (
    <>
      <span style={warn}>{money(amount, currency)}</span>
      <div className="small muted">rate not set</div>
    </>
  );
}

/** The Total row's version: a summary already carries its own converted total plus what was left out. */
function OverdueTotalAmount({ totalInr, unconverted }) {
  return (
    <>
      {money(totalInr, 'INR')}
      {unconverted.length > 0 && (
        <div className="small" style={warn}>+ {unconverted.map((a) => money(a.amount, a.currency)).join(' · ')} (rate not set)</div>
      )}
    </>
  );
}

function PoCount({ row }) {
  return (
    <>
      {number(row.pos)}
      {row.pos_unconverted > 0 && <div className="small" style={warn}>{row.pos_unconverted} rate not set</div>}
      {row.stages_unconverted > 0 && (
        <div className="small" style={warn}>{row.stages_unconverted} stage{row.stages_unconverted === 1 ? '' : 's'} with no rate on their date</div>
      )}
    </>
  );
}

const ORDER_COLUMNS = [
  { key: 'label', header: 'Month', className: 'strong' },
  { key: 'orders_won', header: 'Quotations won', align: 'right' },
  { key: 'order_intake_inr', header: 'Order intake (INR)', align: 'right', render: (row) => <Intake row={row} /> },
  { key: 'average_deal_inr', header: 'Average deal (INR)', align: 'right', render: (row) => inr(row.average_deal_inr, row.rate_details) },
];

const PO_MONEY_COLUMNS = [
  { key: 'pos', header: 'POs', align: 'right', render: (row) => <PoCount row={row} /> },
  { key: 'po_value_inr', header: 'PO value (INR)', align: 'right', render: (row) => inr(row.po_value_inr, row.rate_details) },
  { key: 'invoiced_inr', header: 'Invoiced (INR)', align: 'right', render: (row) => inr(row.invoiced_inr, row.invoice_rate_details) },
  { key: 'received_inr', header: 'Received (INR)', align: 'right', render: (row) => inr(row.received_inr, row.payment_rate_details) },
  { key: 'due_now_inr', header: 'Due now (INR)', align: 'right', render: (row) => inr(row.due_now_inr, row.invoice_rate_details) },
  { key: 'to_bill_inr', header: 'To bill (INR)', align: 'right', render: (row) => inr(row.to_bill_inr, row.invoice_rate_details) },
  { key: 'fx_gain_loss_inr', header: 'FX gain / loss', align: 'right', render: (row) => <GainLoss row={row} /> },
];

const INVOICING_COLUMNS = [{ key: 'label', header: 'Month', className: 'strong' }, ...PO_MONEY_COLUMNS];

const OVERDUE_COLUMNS = [
  { key: 'client', header: 'Client', className: 'strong' },
  {
    key: 'po_number',
    header: 'PO',
    render: (row) => (row.po_number
      ? <Link className="mono" to={`/purchase-orders/${encodeURIComponent(row.po_number)}`}>{row.po_number}</Link>
      : ''),
  },
  { key: 'invoice_no', header: 'Invoice', className: 'mono' },
  { key: 'due_date', header: 'Due date' },
  { key: 'days_overdue', header: 'Days overdue', align: 'right', render: (row) => (row.days_overdue != null ? number(row.days_overdue) : '') },
  {
    key: 'received_inr',
    header: 'Received (INR)',
    align: 'right',
    render: (row) => ('due_now_amount' in row
      ? <OverdueAmount inrValue={row.received_inr} amount={row.amount_received} currency={row.currency} />
      : <OverdueTotalAmount totalInr={row.received_inr} unconverted={row.received_unconverted} />),
  },
  {
    key: 'due_inr',
    header: 'Due (INR)',
    align: 'right',
    render: (row) => ('due_now_amount' in row
      ? <OverdueAmount inrValue={row.due_inr} amount={row.due_now_amount} currency={row.currency} />
      : <OverdueTotalAmount totalInr={row.due_inr} unconverted={row.due_unconverted} />),
  },
];

/** A Total row that renders each cell exactly like the column above it. */
const totalRow = (columns, total) =>
  columns.map((col, i) => (
    <td key={col.key} className={cn('px-3 py-2 align-top text-[13px]', col.align === 'right' && 'num text-right')}>
      {i === 0 ? 'Total' : col.render ? col.render(total) : number(total[col.key])}
    </td>
  ));

/**
 * Revenue for the period chosen above the page: quotations won, by
 * quotation date; invoicing, collections and payment status from purchase
 * orders — matching the Purchase orders list, by their own PO date. The two
 * are read from different tables and can disagree: a deal can be marked won
 * with no PO registered yet, or its PO can land in a different month. Uses
 * the same period as every other section on the page, and the same period
 * the PDF download covers.
 */
export function RevenueReport({ period }) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(period).filter(([, v]) => v))).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/dashboard/revenue-report?${qs}`), [qs]);

  const report = data?.data;
  const label = periodLabel(period);
  const missingRates = report
    ? [...new Set([
        ...report.orders.total.order_unconverted.map((a) => a.currency),
        ...report.invoicing.total.missing_rates,
        ...report.overdue_by_client.total.missing_rates,
      ])].sort()
    : [];
  const poListUrl = (status) => `/purchase-orders?${new URLSearchParams({ payment_status: status, ...period })}`;

  const statusColumns = [
    {
      key: 'status',
      header: 'Payment status',
      render: (row) => <Link to={poListUrl(row.status)}><Badge>{row.status}</Badge></Link>,
    },
    ...PO_MONEY_COLUMNS,
  ];

  return (
    <>
      {error && <ErrorState message={error} onRetry={refetch} />}
      {loading && !report && <div className="skeleton" style={{ height: 92 }} />}

      {report && (
        <>
          {missingRates.length > 0 && (
            <Alert tone="warning">
              No exchange rate covers the dates of some <strong>{missingRates.join(', ')}</strong> amounts, so those are left out of the
              INR figures. <Link to="/settings">Add the rate in Settings</Link>, dated from when it applied.
            </Alert>
          )}
          {report.undated_pos.length > 0 && (
            <Alert tone="warning">
              <strong>
                {report.undated_pos.length} purchase order{report.undated_pos.length === 1 ? ' has' : 's have'} no PO date
              </strong>
              , so {report.undated_pos.length === 1 ? 'it is' : 'they are'} not in the invoicing or payment status figures:{' '}
              {report.undated_pos.map((po, i) => (
                <span key={po}>
                  {i > 0 && ', '}
                  <Link className="mono" to={`/purchase-orders/${encodeURIComponent(po)}`}>{po}</Link>
                </span>
              ))}
              . Add the PO date on the PO to include {report.undated_pos.length === 1 ? 'it' : 'them'}.
            </Alert>
          )}

          <Card
            title={`Quotations won by month · ${label}`}
            hint="Quotations marked Won - PO Received, by quotation date — not the same as the POs registered below, which can land in a different month · converted at the rate in force on the quotation date · Average deal = order intake ÷ orders with a value"
            flush
            actions={<CsvButton report="orders" params={period} disabled={!report.orders.total.orders_won} />}
          >
            <DataTable
              columns={ORDER_COLUMNS}
              rows={report.orders.months.map((m) => ({ ...m, id: m.month ?? 'undated' }))}
              footer={totalRow(ORDER_COLUMNS, report.orders.total)}
            />
          </Card>

          <Card
            title={`Invoicing & collections by month · ${label}`}
            hint="Every purchase order by its PO date, as on the Purchase orders page · Due now = invoiced − received, on invoices actually raised · To bill = due to be invoiced but not yet billed · each stage converted at the rate on its own invoice or payment date · FX gain / loss = what the currency moved between the two"
            flush
            actions={<CsvButton report="invoicing" params={period} disabled={!report.invoicing.total.pos} />}
          >
            <DataTable
              columns={INVOICING_COLUMNS}
              rows={report.invoicing.months.map((m) => ({ ...m, id: m.month ?? 'undated' }))}
              footer={totalRow(INVOICING_COLUMNS, report.invoicing.total)}
            />
            {/* The two rates once, for the whole period, under this table's Total. */}
            <div className="toolbar revenue-rates" style={{ borderBottom: 0, justifyContent: 'flex-end' }}>
              <span>
                Collection rate <strong>{percent(report.invoicing.total.collection_rate)}</strong>{' '}
                <span className="small muted">
                  received ÷ invoiced ({money(report.invoicing.total.received_inr)} of {money(report.invoicing.total.invoiced_inr)})
                </span>
              </span>
              <span>
                Invoiced <strong>{percent(report.invoicing.total.invoiced_rate)}</strong>{' '}
                <span className="small muted">
                  of PO value ({money(report.invoicing.total.invoiced_inr)} of {money(report.invoicing.total.po_value_inr)})
                </span>
              </span>
            </div>
          </Card>

          <Card
            title={`Payment status · ${label}`}
            hint="Purchase orders dated in the period, by their status on the Purchase orders page · Pending = invoiced, not yet overdue · Click a status to open those POs"
            flush
            actions={<CsvButton report="payment-status" params={period} disabled={!report.payment_status.total.pos} />}
          >
            <DataTable
              columns={statusColumns}
              rows={report.payment_status.rows.map((row) => ({ ...row, id: row.status }))}
              footer={totalRow(statusColumns, report.payment_status.total)}
            />
          </Card>

          <Card
            title={`Overdue by client · ${label}`}
            hint="Every invoice overdue today, on a purchase order dated in the period · Due = invoiced − received on that invoice"
            flush
            actions={<CsvButton report="overdue" params={period} disabled={!report.overdue_by_client.total.invoices} />}
          >
            <DataTable
              columns={OVERDUE_COLUMNS}
              rows={report.overdue_by_client.rows.map((row, i) => ({ ...row, id: `${row.po_number}-${row.invoice_no ?? i}` }))}
              footer={totalRow(OVERDUE_COLUMNS, report.overdue_by_client.total)}
              empty={<Empty title="Nothing overdue in this period" />}
            />
          </Card>
        </>
      )}
    </>
  );
}
