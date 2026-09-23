import { Link } from 'react-router-dom';
import { Alert, Badge, Card, DataTable, ErrorState } from './ui.jsx';
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
  { key: 'orders_won', header: 'Orders won', align: 'right' },
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

/** A Total row that renders each cell exactly like the column above it. */
const totalRow = (columns, total) =>
  columns.map((col, i) => (
    <td key={col.key} className={col.align === 'right' ? 'num' : ''}>
      {i === 0 ? 'Total' : col.render ? col.render(total) : number(total[col.key])}
    </td>
  ));

/**
 * Revenue for the period chosen above the page: order intake from won
 * quotations, and invoicing, collections and payment status from purchase
 * orders — matching the Purchase orders list. Uses the same period as every
 * other section on the page, and the same period the PDF download covers.
 */
// `showStaleNotice` is off where this sits inside another page that carries
// the notice itself: one banner about the exchange rates, not two.
export function RevenueReport({ period, showStaleNotice = true }) {
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(period).filter(([, v]) => v))).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/dashboard/revenue-report?${qs}`), [qs]);

  const report = data?.data;
  const label = periodLabel(period);
  const missingRates = report
    ? [...new Set([...report.orders.total.order_unconverted.map((a) => a.currency), ...report.invoicing.total.missing_rates])].sort()
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
          {showStaleNotice && report.stale_rates?.length > 0 && (
            <Alert tone="warning">
              The newest exchange rate held for <strong>{report.stale_rates.map((r) => r.currency).join(', ')}</strong> is not
              from this week, so recent figures convert at an older number: {report.stale_rates.map((r) => r.note).join('; ')}.{' '}
              <Link to="/settings">Check the rates in Settings</Link>.
            </Alert>
          )}
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
            title={`Order intake by month · ${label}`}
            hint="Quotations marked Won - PO Received, by quotation date · converted at the rate in force on the quotation date · Average deal = order intake ÷ orders with a value"
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
        </>
      )}
    </>
  );
}
