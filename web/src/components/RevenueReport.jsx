import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Card, DataTable, Empty, ErrorState } from './ui.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { date, money, number, today } from '../lib/format.js';

const inr = (value) => (value === null || value === undefined ? <span className="muted">—</span> : money(value, 'INR'));
const warn = { color: 'var(--warn-fg)' };

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
      {row.not_registered > 0 && <div className="small" style={warn}>{row.not_registered} without PO</div>}
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

const INVOICING_COLUMNS = [
  { key: 'label', header: 'Month', className: 'strong' },
  { key: 'pos', header: 'POs', align: 'right', render: (row) => <PoCount row={row} /> },
  { key: 'po_value_inr', header: 'PO value (INR)', align: 'right', render: (row) => inr(row.po_value_inr) },
  { key: 'invoiced_inr', header: 'Invoiced (INR)', align: 'right', render: (row) => inr(row.invoiced_inr) },
  { key: 'received_inr', header: 'Received (INR)', align: 'right', render: (row) => inr(row.received_inr) },
  { key: 'due_now_inr', header: 'Due now (INR)', align: 'right', render: (row) => inr(row.due_now_inr) },
  { key: 'balance_inr', header: 'Balance (INR)', align: 'right', render: (row) => inr(row.balance_inr) },
];

/** A Total row that renders each cell exactly like the column above it. */
const totalRow = (columns, total) =>
  columns.map((col, i) => (
    <td key={col.key} className={col.align === 'right' ? 'num' : ''}>
      {i === 0 ? 'Total' : col.render ? col.render(total) : number(total[col.key])}
    </td>
  ));

/**
 * Order intake, invoicing and collections for each month of a calendar
 * year, narrowed by sector and sales person. Pick a month to see its orders.
 */
export function RevenueReport({ onChange }) {
  const lookups = useLookups();
  const thisYear = Number(today().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [filters, setFilters] = useState({ sector: '', sales_person: '' });
  const [openMonth, setOpenMonth] = useState('');

  const allParams = {
    from: `${year}-01-01`,
    to: `${year}-12-31`,
    ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
  };
  const qs = new URLSearchParams(allParams).toString();
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/dashboard/revenue-report?${qs}`), [qs]);
  // A month belongs to a year; changing the sector or sales person keeps it open.
  useEffect(() => setOpenMonth(''), [year]);
  // The page's PDF download uses the same year and filters as this section.
  useEffect(() => {
    onChange?.({ year, ...filters });
  }, [year, filters.sector, filters.sales_person]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = data?.data;
  const years = [...new Set([thisYear, ...(report?.years || [])])].sort((a, b) => b - a);
  const selected = report?.months.find((m) => m.month === openMonth);
  const missingRates = report
    ? [...new Set([...report.total.order_unconverted.map((a) => a.currency), ...report.total.po_missing_rates])].sort()
    : [];
  const filtered = Boolean(filters.sector || filters.sales_person);
  const toggleMonth = (row) => setOpenMonth(row.month === openMonth ? '' : row.month);

  return (
    <>
      <Card flush>
        <div className="toolbar" style={{ borderBottom: 0 }}>
          <strong>Revenue</strong>
          <span className="small muted">Calendar year · orders by their won quotation's date</span>
          <div className="spacer" />
          <select className="select" aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>Year: {y}</option>)}
          </select>
          <select className="select" aria-label="Month" value={openMonth} onChange={(e) => setOpenMonth(e.target.value)}>
            <option value="">Month: all</option>
            {(report?.months || []).map((m) => (
              <option key={m.month} value={m.month}>{m.label} ({m.orders_won} won)</option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Sector"
            value={filters.sector}
            onChange={(e) => setFilters((f) => ({ ...f, sector: e.target.value }))}
          >
            <option value="">Sector: all</option>
            <option value="__none__">Not set</option>
            {lookups.sectors.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select
            className="select"
            aria-label="Sales person"
            value={filters.sales_person}
            onChange={(e) => setFilters((f) => ({ ...f, sales_person: e.target.value }))}
          >
            <option value="">Sales person: all</option>
            {lookups.sales_people.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {(filtered || openMonth) && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => { setFilters({ sector: '', sales_person: '' }); setOpenMonth(''); }}
            >
              Clear
            </button>
          )}
        </div>
      </Card>

      {error && <ErrorState message={error} onRetry={refetch} />}
      {loading && !report && <div className="skeleton" style={{ height: 92 }} />}

      {report && (
        <>
          {report.total.not_registered > 0 && (
            <Alert tone="warning">
              <strong>
                No PO registered yet for {report.total.not_registered} of {report.total.orders_won} won orders in {year}
              </strong>
              , so their PO value, invoiced and received are not in the invoicing table yet.
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                {report.total.no_project > 0 && (
                  <li>
                    {report.total.no_project} have no project yet: <Link to="/worklist">register the project on the Action list</Link>, then add its PO.
                  </li>
                )}
                {report.total.not_registered - report.total.no_project > 0 && (
                  <li>
                    {report.total.not_registered - report.total.no_project} have a project but no PO yet: pick their month and
                    use <strong>Add PO</strong>.
                  </li>
                )}
              </ul>
            </Alert>
          )}
          {missingRates.length > 0 && (
            <Alert tone="warning">
              No exchange rate is set for <strong>{missingRates.join(', ')}</strong>, so those amounts are left out of the INR
              figures. <Link to="/settings">Set the rate in Settings</Link>.
            </Alert>
          )}

          <Card
            title={`Order intake by month · ${year}`}
            hint="Orders won = quotations marked Won - PO Received, by quotation date · Average deal = order intake ÷ orders with a value · Pick a month to see its orders"
            flush
            actions={<CsvButton report="orders" params={allParams} disabled={!report.total.orders_won} />}
          >
            <DataTable
              columns={ORDER_COLUMNS}
              rows={report.months.map((m) => ({ ...m, id: m.month }))}
              onRowClick={toggleMonth}
              footer={totalRow(ORDER_COLUMNS, report.total)}
            />
          </Card>

          <Card
            title={`Invoicing & collections by month · ${year}`}
            hint="For the orders won in each month · PO value, invoiced, received and due now come from each order's purchase order · Balance = PO value − received"
            flush
            actions={<CsvButton report="invoicing" params={allParams} disabled={!report.total.orders_won} />}
          >
            <DataTable
              columns={INVOICING_COLUMNS}
              rows={report.months.map((m) => ({ ...m, id: m.month }))}
              onRowClick={toggleMonth}
              footer={totalRow(INVOICING_COLUMNS, report.total)}
            />
          </Card>

          {selected && (
            <Card
              title={`Orders won in ${selected.label}`}
              hint={`${selected.orders_won} order${selected.orders_won === 1 ? '' : 's'}${filtered ? ' matching the filters' : ''}`}
              flush
              actions={
                <>
                  <CsvButton
                    report="revenue-detail"
                    params={{ ...allParams, from: `${selected.month}-01`, to: lastDay(selected.month) }}
                    disabled={!selected.orders_won}
                  />
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setOpenMonth('')}>Close</button>
                </>
              }
            >
              <DataTable
                columns={[
                  { key: 'quotation_no', header: 'Quotation', className: 'mono', render: (r) => <>{r.quotation_no}<div className="small muted">{date(r.quotation_date)}</div></> },
                  { key: 'client', header: 'Client', className: 'strong', render: (r) => <>{r.client}<div className="small muted">{r.sector}{r.sales_person ? ` · ${r.sales_person}` : ''}</div></> },
                  {
                    key: 'order_value_inr',
                    header: 'Order value',
                    align: 'right',
                    render: (r) => (
                      <>
                        {r.quotation_value === null ? <span className="muted">No value</span> : money(r.quotation_value, r.currency)}
                        {r.currency !== 'INR' && r.quotation_value !== null && (
                          <div className="small muted">{r.order_value_inr === null ? 'rate not set' : money(r.order_value_inr, 'INR')}</div>
                        )}
                      </>
                    ),
                  },
                  {
                    key: 'po_numbers',
                    header: 'PO',
                    render: (r) =>
                      r.po_count > 0 ? (
                        <span className="mono">{r.po_numbers}</span>
                      ) : r.project_id ? (
                        <Link to={`/projects/${encodeURIComponent(r.project_id)}`}>Add PO</Link>
                      ) : (
                        <Link to="/worklist">Register project</Link>
                      ),
                  },
                  { key: 'po_value_inr', header: 'PO value (INR)', align: 'right', render: (r) => inr(r.po_value_inr) },
                  { key: 'invoiced_inr', header: 'Invoiced', align: 'right', render: (r) => inr(r.invoiced_inr) },
                  { key: 'received_inr', header: 'Received', align: 'right', render: (r) => inr(r.received_inr) },
                  { key: 'due_now_inr', header: 'Due now', align: 'right', render: (r) => inr(r.due_now_inr) },
                  { key: 'balance_inr', header: 'Balance', align: 'right', render: (r) => inr(r.balance_inr) },
                  { key: 'payment_status', header: 'Status', render: (r) => (r.payment_status ? <Badge>{r.payment_status}</Badge> : <span className="muted">—</span>) },
                ]}
                rows={report.rows.filter((r) => r.month === selected.month)}
                empty={<Empty title={`No orders won in ${selected.label}`} text={filtered ? 'Try clearing the sector or sales person filter.' : undefined} />}
              />
            </Card>
          )}
        </>
      )}
    </>
  );
}

function lastDay(month) {
  const [year, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
