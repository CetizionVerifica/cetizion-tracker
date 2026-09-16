import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, BarList, Card, DataTable, Empty, ErrorState, Stat } from '../components/ui.jsx';
import { RevenueReport } from '../components/RevenueReport.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, number, percent, today } from '../lib/format.js';

/** Quick ranges on the quotation date. Reports run on the calendar year (Jan–Dec). */
function ranges() {
  const end = today();
  return [
    { key: 'all', label: 'All time', from: '', to: '' },
    { key: 'year', label: 'This calendar year', from: `${end.slice(0, 4)}-01-01`, to: end },
    { key: 'month', label: 'This month', from: `${end.slice(0, 7)}-01`, to: end },
  ];
}

/** Won value in each currency side by side — never added across currencies. */
function Amounts({ list }) {
  if (!list?.length) return <span className="muted">—</span>;
  return list.map((a) => money(a.amount, a.currency)).join(' · ');
}

/** INR value, flagging anything left out of it so the total is never quietly short. */
function InrValue({ value, unconverted, withoutValue }) {
  return (
    <>
      {money(value, 'INR')}
      {unconverted?.length > 0 && (
        <div className="small" style={{ color: 'var(--warn-fg)' }}>
          + <Amounts list={unconverted} /> (rate not set)
        </div>
      )}
      {withoutValue > 0 && <div className="small muted">{withoutValue} PO{withoutValue === 1 ? '' : 's'} with no value</div>}
    </>
  );
}

function CsvButton({ report, params, disabled }) {
  if (disabled) {
    return <button type="button" className="btn btn--sm" disabled>Download CSV</button>;
  }
  return <a className="btn btn--sm" href={api.reportCsvUrl(report, params)} download>Download CSV</a>;
}

const CLIENT_COLUMNS = [
  { key: 'client', header: 'Client group', className: 'strong' },
  { key: 'enquiries', header: 'Enquiries', align: 'right' },
  { key: 'pos', header: 'POs won', align: 'right' },
  { key: 'win_rate', header: 'Win %', align: 'right', render: (row) => percent(row.win_rate) },
  {
    key: 'won_value_inr',
    header: 'Won value (INR)',
    align: 'right',
    render: (row) => <InrValue value={row.won_value_inr} unconverted={row.unconverted} withoutValue={row.pos_without_value} />,
  },
  { key: 'repeat_orders', header: 'Repeat orders', align: 'right' },
];

function ClientTotals({ label, s }) {
  return (
    <>
      <td>{label}</td>
      <td className="num">{number(s.enquiries)}</td>
      <td className="num">{number(s.pos)}</td>
      <td className="num">{percent(s.win_rate)}</td>
      <td className="num"><InrValue value={s.won_value_inr} unconverted={s.unconverted} withoutValue={s.pos_without_value} /></td>
      <td className="num">{number(s.repeat_orders)}</td>
    </>
  );
}

export default function SalesReport() {
  const [period, setPeriod] = useState({ from: '', to: '' });
  const [revenueQuery, setRevenueQuery] = useState({});

  const params = Object.fromEntries(Object.entries(period).filter(([, value]) => value));
  const backwards = Boolean(period.from && period.to && period.from > period.to);
  // The PDF is the whole page: this period, the revenue section's year and
  // filters, and the viewer's time zone for the "generated" stamp.
  const pdfParams = {
    ...params,
    ...Object.fromEntries(Object.entries(revenueQuery).filter(([, value]) => value)),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  // Lists opened from a figure show the same period that figure counts.
  const quotationsUrl = (filters) => `/quotations?${new URLSearchParams({ ...filters, ...params })}`;

  const { data, loading, error, refetch } = useFetch(
    () => (backwards ? null : api.raw(`/dashboard/sales-report?${new URLSearchParams(params)}`)),
    [period.from, period.to]
  );

  const d = backwards ? null : data?.data;
  const sectors = d?.sectors;
  const customers = d?.customers;
  const fx = d?.fx;
  const repeatRows = customers ? customers.rows.filter((row) => row.pos_to_date >= 2) : [];
  const singleRows = customers ? customers.rows.filter((row) => row.pos_to_date < 2) : [];

  return (
    <>
      <PageHeader
        title="Sales reports"
        subtitle="Sector-wise funnel, FX deals, clients and revenue"
        actions={
          backwards || error ? (
            <button type="button" className="btn btn--primary" disabled title="Fix the period or reload the report first">
              Download PDF
            </button>
          ) : (
            <a className="btn btn--primary" href={api.reportPdfUrl(pdfParams)} download>Download PDF</a>
          )
        }
      />

      <div className="page stack">
        <Card flush>
          <div className="toolbar" style={{ borderBottom: 0 }}>
            <span className="small muted">Period</span>
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
            {fx.summary.missing_rates.length > 0 && (
              <Alert tone="warning">
                No exchange rate is set for <strong>{fx.summary.missing_rates.join(', ')}</strong>, so those deals are
                left out of the INR values and shown next to them instead.{' '}
                <Link to="/settings">Set the rate in Settings</Link> (INR for 1 unit).
              </Alert>
            )}

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
                to={quotationsUrl({ status: 'Won - PO Received', sector: '__none__' })}
              />
              <Stat
                label="Clients"
                value={number(customers.summary.total.clients)}
                meta={`${customers.summary.repeat.clients} repeat · ${customers.summary.single.clients} single enquiry`}
              />
            </div>

            <Card
              title="Sector-wise POs"
              hint="Enquiries by enquiry date, the rest by quotation date · Pipeline = Submitted, Under Negotiation or On Hold · Win % = won ÷ (won + lost) · FX deals = won POs not in INR · Values stay in their own currency"
              flush
              actions={<CsvButton report="sectors" params={params} disabled={!sectors.rows.length} />}
            >
              <DataTable
                columns={[
                  {
                    key: 'sector',
                    header: 'Sector',
                    className: 'strong',
                    render: (row) => (row.not_set ? <Link to={quotationsUrl({ sector: '__none__' })}>Not set</Link> : row.sector),
                  },
                  { key: 'enquiries', header: 'Enquiries', align: 'right' },
                  { key: 'pos', header: 'POs won', align: 'right' },
                  { key: 'lost', header: 'Lost', align: 'right' },
                  { key: 'pipeline', header: 'Pipeline', align: 'right' },
                  { key: 'win_rate', header: 'Win %', align: 'right', render: (row) => percent(row.win_rate) },
                  { key: 'amounts', header: 'Won value', align: 'right', render: (row) => <Amounts list={row.amounts} /> },
                  { key: 'fx_deals', header: 'FX deals', align: 'right' },
                ]}
                rows={sectors.rows}
                footer={
                  <>
                    <td>Total</td>
                    <td className="num">{number(sectors.summary.enquiries)}</td>
                    <td className="num">{number(sectors.summary.pos)}</td>
                    <td className="num">{number(sectors.summary.lost)}</td>
                    <td className="num">{number(sectors.summary.pipeline)}</td>
                    <td className="num">{percent(sectors.summary.win_rate)}</td>
                    <td className="num"><Amounts list={sectors.summary.amounts} /></td>
                    <td className="num">{number(sectors.summary.fx_deals)}</td>
                  </>
                }
                empty={<Empty title="No enquiries or quotations in this period" />}
              />
            </Card>

            <Card title="POs by sector" hint="Won quotations, grouped by the sector entered on them">
              <BarList
                items={sectors.rows.filter((row) => row.pos > 0).map((row) => ({ label: row.sector, value: row.pos, extra: row }))}
                valueFormat={(v, item) =>
                  `${v} PO${v === 1 ? '' : 's'} · ${item.extra.customers} customer${item.extra.customers === 1 ? '' : 's'}`
                }
              />
            </Card>

            <Card
              title="FX deals"
              hint="Won POs billed in a currency other than INR · INR value = won value × the rate set in Settings"
              flush
              actions={<CsvButton report="fx" params={params} disabled={!fx.rows.length} />}
            >
              <DataTable
                columns={[
                  { key: 'customer', header: 'Client', className: 'strong', render: (row) => <>{row.customer}<div className="small muted mono">{row.quotation_nos}</div></> },
                  {
                    key: 'sector',
                    header: 'Sector',
                    render: (row) => (row.not_set ? <Link to={quotationsUrl({ status: 'Won - PO Received', sector: '__none__' })}>Not set</Link> : row.sector),
                  },
                  { key: 'currency', header: 'Currency', render: (row) => <Badge tone="info">{row.currency}</Badge> },
                  { key: 'deals', header: 'Won POs', align: 'right' },
                  {
                    key: 'amount',
                    header: 'Won value',
                    align: 'right',
                    render: (row) => (
                      <>
                        {money(row.amount, row.currency)}
                        {row.deals_without_value > 0 && <div className="small muted">{row.deals_without_value} with no value</div>}
                      </>
                    ),
                  },
                  {
                    key: 'rate',
                    header: 'Rate',
                    align: 'right',
                    render: (row) =>
                      row.rate === null ? <Link to="/settings">Not set</Link> : `₹${row.rate} / ${row.currency}`,
                  },
                  {
                    key: 'amount_inr',
                    header: 'Won value (INR)',
                    align: 'right',
                    render: (row) => (row.amount_inr === null ? <span className="muted">Rate not set</span> : money(row.amount_inr, 'INR')),
                  },
                ]}
                rows={fx.rows}
                footer={
                  <>
                    <td colSpan={3}>Total</td>
                    <td className="num">{number(fx.summary.deals)}</td>
                    <td className="num"><Amounts list={fx.summary.amounts} /></td>
                    <td />
                    <td className="num">
                      {money(fx.summary.amount_inr, 'INR')}
                      {fx.summary.missing_rates.length > 0 && (
                        <div className="small" style={{ color: 'var(--warn-fg)' }}>excludes {fx.summary.missing_rates.join(', ')}</div>
                      )}
                    </td>
                  </>
                }
                empty={<Empty title="No FX deals in this period" text="Every won PO in this period is in INR." />}
              />
            </Card>

            <Card
              title="Repeat clients"
              hint="2 or more won POs up to the end of the period · Enquiries = rows on the Enquiries page · Win % = won ÷ (won + lost) · Won value (INR) includes FX deals at the Settings rate · Repeat orders = won POs after the first"
              flush
              actions={<CsvButton report="customers" params={params} disabled={!customers.rows.length} />}
            >
              <DataTable
                columns={CLIENT_COLUMNS}
                rows={repeatRows}
                footer={<ClientTotals label="Total" s={customers.summary.repeat} />}
                empty={<Empty title="No repeat clients in this period" />}
              />
            </Card>

            <Card
              title="Single enquiry clients"
              hint="Every other client: one won PO, quoted but not won yet, or only on the Enquiries page"
              flush
            >
              <DataTable
                columns={CLIENT_COLUMNS}
                rows={singleRows}
                footer={<ClientTotals label="Total" s={customers.summary.single} />}
                empty={<Empty title="No single enquiry clients in this period" />}
              />
            </Card>

            <Card title="Client summary" hint="Each client is counted once, in exactly one group" flush>
              <DataTable
                columns={[
                  { key: 'label', header: 'Client type', className: 'strong' },
                  { key: 'clients', header: 'Clients', align: 'right' },
                  ...CLIENT_COLUMNS.slice(1).map((col) =>
                    col.key === 'won_value_inr'
                      ? { ...col, render: (row) => <InrValue value={row.won_value_inr} unconverted={row.unconverted} withoutValue={row.pos_without_value} /> }
                      : col
                  ),
                ]}
                rows={[
                  { id: 'repeat', label: 'Repeat clients', ...customers.summary.repeat },
                  { id: 'single', label: 'Single enquiry clients', ...customers.summary.single },
                ]}
                footer={
                  <>
                    <td>Total</td>
                    <td className="num">{number(customers.summary.total.clients)}</td>
                    <td className="num">{number(customers.summary.total.enquiries)}</td>
                    <td className="num">{number(customers.summary.total.pos)}</td>
                    <td className="num">{percent(customers.summary.total.win_rate)}</td>
                    <td className="num">
                      <InrValue
                        value={customers.summary.total.won_value_inr}
                        unconverted={customers.summary.total.unconverted}
                        withoutValue={customers.summary.total.pos_without_value}
                      />
                    </td>
                    <td className="num">{number(customers.summary.total.repeat_orders)}</td>
                  </>
                }
              />
            </Card>

          </>
        )}

        {/* Mounted regardless of the sales data, so its year and filters survive a bad period or a failed load. */}
        <RevenueReport onChange={setRevenueQuery} />
      </div>
    </>
  );
}
