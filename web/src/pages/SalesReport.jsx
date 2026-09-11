import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, BarList, Card, DataTable, Empty, ErrorState, Stat, Tabs } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money, number, today } from '../lib/format.js';

const CUSTOMER_TYPES = ['Repeat customer', 'New customer', 'No order yet'];
const TYPE_TONE = { 'Repeat customer': 'success', 'New customer': 'info', 'No order yet': 'neutral' };

/** Quick ranges on the quotation date. The financial year starts in April. */
function ranges() {
  const end = today();
  const [year, month] = end.split('-').map(Number);
  const fyStart = month >= 4 ? year : year - 1;
  return [
    { key: 'all', label: 'All time', from: '', to: '' },
    { key: 'fy', label: 'This financial year', from: `${fyStart}-04-01`, to: end },
    { key: 'month', label: 'This month', from: `${end.slice(0, 7)}-01`, to: end },
  ];
}

/** Won value in each currency side by side — never added across currencies. */
function Amounts({ list }) {
  if (!list?.length) return <span className="muted">—</span>;
  return list.map((a) => money(a.amount, a.currency)).join(' · ');
}

function CsvButton({ report, params, disabled }) {
  if (disabled) {
    return <button type="button" className="btn btn--sm" disabled>Download CSV</button>;
  }
  return <a className="btn btn--sm" href={api.reportCsvUrl(report, params)} download>Download CSV</a>;
}

export default function SalesReport() {
  const [period, setPeriod] = useState({ from: '', to: '' });
  const [type, setType] = useState('all');

  const params = Object.fromEntries(Object.entries(period).filter(([, value]) => value));
  const backwards = Boolean(period.from && period.to && period.from > period.to);

  const { data, loading, error, refetch } = useFetch(
    () => (backwards ? null : api.raw(`/dashboard/sales-report?${new URLSearchParams(params)}`)),
    [period.from, period.to]
  );

  const d = backwards ? null : data?.data;
  const sectors = d?.sectors;
  const customers = d?.customers;
  const customerRows = customers
    ? customers.rows.filter((row) => type === 'all' || row.customer_type === type)
    : [];

  return (
    <>
      <PageHeader title="Sales reports" subtitle="Won POs by sector, and new vs repeat customers" />

      <div className="page stack">
        <Card flush>
          <div className="toolbar" style={{ borderBottom: 0 }}>
            <span className="small muted">Quotation date</span>
            <input
              type="date"
              className="input"
              style={{ width: 'auto' }}
              aria-label="From date"
              value={period.from}
              onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
            />
            <span className="small muted">to</span>
            <input
              type="date"
              className="input"
              style={{ width: 'auto' }}
              aria-label="To date"
              value={period.to}
              onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
            />
            <div className="spacer" />
            {ranges().map((range) => (
              <button
                key={range.key}
                type="button"
                className={`btn btn--sm ${period.from === range.from && period.to === range.to ? 'btn--primary' : ''}`}
                onClick={() => setPeriod({ from: range.from, to: range.to })}
              >
                {range.label}
              </button>
            ))}
          </div>
        </Card>

        {backwards && <Alert tone="danger">The start date is after the end date.</Alert>}
        {error && !backwards && <ErrorState message={error} onRetry={refetch} />}
        {loading && !d && !backwards && <div className="skeleton" style={{ height: 92 }} />}

        {d && (
          <>
            <div className="grid grid--stats">
              <Stat
                label="Won POs"
                value={number(sectors.summary.pos)}
                meta={<Amounts list={sectors.summary.amounts} />}
                tone="brand"
              />
              <Stat label="Sectors" value={number(sectors.summary.sectors)} meta="With at least one won PO" />
              <Stat
                label="POs without a sector"
                value={number(sectors.summary.pos_without_sector)}
                meta={sectors.summary.pos_without_sector > 0 ? 'Set the sector on these quotations' : 'Every won PO has a sector'}
                tone={sectors.summary.pos_without_sector > 0 ? 'warn' : 'ok'}
                to="/quotations?sector=__none__"
              />
              <Stat
                label="Customers quoted"
                value={number(customers.summary.customers)}
                meta={`${customers.summary.repeat} repeat · ${customers.summary.new} new · ${customers.summary.no_order} no order yet`}
              />
            </div>

            <div className="grid grid--2">
              <Card title="POs by sector" hint="Won quotations, grouped by the sector entered on them">
                <BarList
                  items={sectors.rows.map((row) => ({ label: row.sector, value: row.pos, extra: row }))}
                  valueFormat={(v, item) =>
                    `${v} PO${v === 1 ? '' : 's'} · ${item.extra.customers} customer${item.extra.customers === 1 ? '' : 's'}`
                  }
                />
              </Card>

              <Card
                title="Sector-wise POs"
                hint="Values stay in their own currency"
                flush
                actions={<CsvButton report="sectors" params={params} disabled={!sectors.rows.length} />}
              >
                <DataTable
                  columns={[
                    {
                      key: 'sector',
                      header: 'Sector',
                      className: 'strong',
                      render: (row) => (row.not_set ? <Link to="/quotations?sector=__none__">Not set</Link> : row.sector),
                    },
                    { key: 'pos', header: 'POs', align: 'right' },
                    { key: 'customers', header: 'Customers', align: 'right' },
                    { key: 'amounts', header: 'Won value', align: 'right', render: (row) => <Amounts list={row.amounts} /> },
                  ]}
                  rows={sectors.rows}
                  empty={<Empty title="No won POs in this period" />}
                />
              </Card>
            </div>

            <Card
              title="Customer analysis"
              hint="Repeat = 2 or more won orders up to the end of the period · New = exactly 1 · The same spelling counts as one client"
              flush
              actions={<CsvButton report="customers" params={params} disabled={!customers.rows.length} />}
            >
              <Tabs
                tabs={[
                  { key: 'all', label: 'All', count: customers.rows.length },
                  ...CUSTOMER_TYPES.map((t) => ({
                    key: t,
                    label: t,
                    count: customers.rows.filter((row) => row.customer_type === t).length,
                  })),
                ]}
                active={type}
                onChange={setType}
              />
              <DataTable
                columns={[
                  { key: 'customer', header: 'Customer', className: 'strong' },
                  { key: 'sector', header: 'Sector' },
                  { key: 'customer_type', header: 'Type', render: (row) => <Badge tone={TYPE_TONE[row.customer_type]}>{row.customer_type}</Badge> },
                  { key: 'quotations', header: 'Quotations', align: 'right' },
                  { key: 'orders', header: 'Won', align: 'right' },
                  { key: 'orders_to_date', header: 'Won to date', align: 'right' },
                  { key: 'amounts', header: 'Won value', align: 'right', render: (row) => <Amounts list={row.amounts} /> },
                  { key: 'last_quotation_date', header: 'Last quotation', render: (row) => date(row.last_quotation_date) },
                ]}
                rows={customerRows}
                empty={<Empty title="No customers of this type in the period" />}
              />
            </Card>
          </>
        )}
      </div>
    </>
  );
}
