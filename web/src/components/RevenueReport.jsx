import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, DataTable, ErrorState } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, number, percent, today } from '../lib/format.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inr = (value) => (value === null || value === undefined ? <span className="muted">—</span> : money(value, 'INR'));
const warn = { color: 'var(--warn-fg)' };

const lastDay = (year, month) => String(new Date(Date.UTC(year, Number(month), 0)).getUTCDate()).padStart(2, '0');

function CsvButton({ report, params, disabled }) {
  if (disabled) return <button type="button" className="btn btn--sm" disabled>Download CSV</button>;
  return <a className="btn btn--sm" href={api.reportCsvUrl(report, params)} download>Download CSV</a>;
}

function Intake({ row }) {
  return (
    <>
      {inr(row.order_intake_inr)}
      {row.order_unconverted.length > 0 && (
        <div className="small" style={warn}>
          + {row.order_unconverted.map((a) => money(a.amount, a.currency)).join(' · ')} (rate not set)
        </div>
      )}
      {row.orders_without_value > 0 && <div className="small muted">{row.orders_without_value} with no value</div>}
    </>
  );
}

function PoCount({ row }) {
  return (
    <>
      {number(row.pos)}
      {row.pos_unconverted > 0 && <div className="small" style={warn}>{row.pos_unconverted} rate not set</div>}
    </>
  );
}

const ORDER_COLUMNS = [
  { key: 'label', header: 'Month', className: 'strong' },
  { key: 'orders_won', header: 'Orders won', align: 'right' },
  { key: 'order_intake_inr', header: 'Order intake (INR)', align: 'right', render: (row) => <Intake row={row} /> },
  { key: 'average_deal_inr', header: 'Average deal (INR)', align: 'right', render: (row) => inr(row.average_deal_inr) },
];

const PO_MONEY_COLUMNS = [
  { key: 'pos', header: 'POs', align: 'right', render: (row) => <PoCount row={row} /> },
  { key: 'po_value_inr', header: 'PO value (INR)', align: 'right', render: (row) => inr(row.po_value_inr) },
  { key: 'invoiced_inr', header: 'Invoiced (INR)', align: 'right', render: (row) => inr(row.invoiced_inr) },
  { key: 'received_inr', header: 'Received (INR)', align: 'right', render: (row) => inr(row.received_inr) },
  { key: 'due_now_inr', header: 'Due now (INR)', align: 'right', render: (row) => inr(row.due_now_inr) },
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
 * Revenue for a calendar year, or one month of it: order intake from won
 * quotations, and invoicing, collections and payment status from purchase
 * orders — matching the Purchase orders list.
 */
export function RevenueReport({ onChange }) {
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [month, setMonth] = useState(''); // '01'–'12', or '' for the whole year

  const period = month
    ? { from: `${year}-${month}-01`, to: `${year}-${month}-${lastDay(year, month)}` }
    : { from: `${year}-01-01`, to: `${year}-12-31` };
  const qs = new URLSearchParams(period).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/dashboard/revenue-report?${qs}`), [qs]);

  // The page's PDF download uses the same year and month as this section.
  useEffect(() => {
    onChange?.({ year, month });
  }, [year, month]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = data?.data;
  const years = [...new Set([thisYear, ...(report?.years || [])])].sort((a, b) => b - a);
  const periodLabel = month ? `${MONTHS[Number(month) - 1]} ${year}` : String(year);
  const missingRates = report
    ? [...new Set([...report.orders.total.order_unconverted.map((a) => a.currency), ...report.invoicing.total.missing_rates])].sort()
    : [];
  // Clicking a month row narrows every table to that month.
  const pickMonth = (row) => row.month && setMonth(row.month.slice(5, 7));
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
      <Card flush>
        <div className="toolbar" style={{ borderBottom: 0 }}>
          <strong>Revenue</strong>
          <span className="small muted">Order intake from won quotations · invoicing, collections and payment status from purchase orders</span>
          <div className="spacer" />
          <select className="select" aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>Year: {y}</option>)}
          </select>
          <select className="select" aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Month: all</option>
            {MONTHS.map((name, i) => {
              const value = String(i + 1).padStart(2, '0');
              return <option key={value} value={value}>{name} {year}</option>;
            })}
          </select>
          {month && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMonth('')}>
              Clear
            </button>
          )}
        </div>
      </Card>

      {error && <ErrorState message={error} onRetry={refetch} />}
      {loading && !report && <div className="skeleton" style={{ height: 92 }} />}

      {report && (
        <>
          {missingRates.length > 0 && (
            <Alert tone="warning">
              No exchange rate is set for <strong>{missingRates.join(', ')}</strong>, so those amounts are left out of the INR
              figures. <Link to="/settings">Set the rate in Settings</Link>.
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
            title={`Order intake by month · ${periodLabel}`}
            hint="Quotations marked Won - PO Received, by quotation date · Average deal = order intake ÷ orders with a value · Click a month to show only that month"
            flush
            actions={<CsvButton report="orders" params={period} disabled={!report.orders.total.orders_won} />}
          >
            <DataTable
              columns={ORDER_COLUMNS}
              rows={report.orders.months.map((m) => ({ ...m, id: m.month ?? 'undated' }))}
              onRowClick={month ? undefined : pickMonth}
              footer={totalRow(ORDER_COLUMNS, report.orders.total)}
            />
          </Card>

          <Card
            title={`Invoicing & collections by month · ${periodLabel}`}
            hint="Every purchase order by its PO date, as on the Purchase orders page · Due now = invoiced − received"
            flush
            actions={<CsvButton report="invoicing" params={period} disabled={!report.invoicing.total.pos} />}
          >
            <DataTable
              columns={INVOICING_COLUMNS}
              rows={report.invoicing.months.map((m) => ({ ...m, id: m.month ?? 'undated' }))}
              onRowClick={month ? undefined : pickMonth}
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
            title={`Payment status · ${periodLabel}`}
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
