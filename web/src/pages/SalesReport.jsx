import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, BarList, Card, DataTable, Empty, ErrorState, Stat } from '../components/ui.jsx';
import { RevenueReport } from '../components/RevenueReport.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money, number, percent, today } from '../lib/format.js';

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

/**
 * Which rate converted a figure, and whose day it is. Each PO converts at the
 * rate of its own PO date — not today's, and not "unchanged since": a weekend
 * or holiday, when the ECB publishes nothing, uses the last working day's.
 */
const rateTitle = (details = []) => (details.length
  ? ["Converted at the rate of each PO's own date:", ...details.map((d) => `${d.currency}: ₹${d.rate} — rate of ${date(d.effective_from)}`)].join('\n')
  : undefined);

/** INR value, flagging anything left out of it so the total is never quietly short. */
function InrValue({ value, unconverted, withoutValue, rateDetails }) {
  return (
    <>
      <span title={rateTitle(rateDetails)}>{money(value, 'INR')}</span>
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
    render: (row) => <InrValue value={row.won_value_inr} unconverted={row.unconverted} withoutValue={row.pos_without_value} rateDetails={row.rate_details} />,
  },
  { key: 'repeat_orders', header: 'Repeat orders', align: 'right' },
];

function ClientTotals({ label, s }) {
  return (
    <>
      <td className="px-3 py-2 align-top text-[13px]">{label}</td>
      <td className="num px-3 py-2 align-top text-[13px] text-right">{number(s.enquiries)}</td>
      <td className="num px-3 py-2 align-top text-[13px] text-right">{number(s.pos)}</td>
      <td className="num px-3 py-2 align-top text-[13px] text-right">{percent(s.win_rate)}</td>
      <td className="num px-3 py-2 align-top text-[13px] text-right"><InrValue value={s.won_value_inr} unconverted={s.unconverted} withoutValue={s.pos_without_value} rateDetails={s.rate_details} /></td>
      <td className="num px-3 py-2 align-top text-[13px] text-right">{number(s.repeat_orders)}</td>
    </>
  );
}

export default function SalesReport() {
  const [period, setPeriod] = useState({ from: '', to: '' });

  const params = Object.fromEntries(Object.entries(period).filter(([, value]) => value));
  const backwards = Boolean(period.from && period.to && period.from > period.to);
  // The PDF is the whole page, including revenue, for this same period, plus
  // the viewer's time zone for the "generated" stamp.
  const pdfParams = { ...params, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
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
  // The server decides the type (salesReport.js customerReport), so the page never disagrees with it.
  const repeatRows = customers ? customers.rows.filter((row) => row.client_type === 'Repeat client') : [];
  const singleRows = customers ? customers.rows.filter((row) => row.client_type !== 'Repeat client') : [];

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
            {fx.summary.stale_rates?.length > 0 && (
              <Alert tone="warning">
                The newest exchange rate held for{' '}
                <strong>{fx.summary.stale_rates.map((r) => r.currency).join(', ')}</strong> is not from this week, so recent
                deals convert at an older number: {fx.summary.stale_rates.map((r) => r.note).join('; ')}.{' '}
                <Link to="/settings">Check the rates in Settings</Link>.
              </Alert>
            )}

            {fx.summary.missing_rates.length > 0 && (
              <Alert tone="warning">
                No exchange rate covers the date of some <strong>{fx.summary.missing_rates.join(', ')}</strong> deals, so those are
                left out of the INR values and shown next to them instead.{' '}
                <Link to="/settings">Add the rate in Settings</Link> (INR for 1 unit, from the date it applied).
              </Alert>
            )}
            {sectors.summary.undated_pos.length > 0 && (
              <Alert tone="warning">
                <strong>
                  {sectors.summary.undated_pos.length} purchase order{sectors.summary.undated_pos.length === 1 ? ' has' : 's have'} no PO date
                </strong>
                , so {sectors.summary.undated_pos.length === 1 ? 'it is' : 'they are'} left out of every PO figure on this page for the
                period chosen — sector-wise, FX deals, clients and revenue:{' '}
                {sectors.summary.undated_pos.map((po, i) => (
                  <span key={po}>
                    {i > 0 && ', '}
                    <Link className="mono" to={`/purchase-orders/${encodeURIComponent(po)}`}>{po}</Link>
                  </span>
                ))}
                . Add the PO date on the PO to include {sectors.summary.undated_pos.length === 1 ? 'it' : 'them'}.
              </Alert>
            )}
            {sectors.summary.currency_mismatch_pos.length > 0 && (
              <Alert tone="warning">
                <strong>
                  {sectors.summary.currency_mismatch_pos.length} purchase order{sectors.summary.currency_mismatch_pos.length === 1 ? ' is' : 's are'} in
                  a different currency from {sectors.summary.currency_mismatch_pos.length === 1 ? 'its' : 'their'} quotation
                </strong>
                , so the value may be read in the wrong currency:{' '}
                {sectors.summary.currency_mismatch_pos.map((po, i) => (
                  <span key={po.po_number}>
                    {i > 0 && ', '}
                    <Link className="mono" to={`/purchase-orders/${encodeURIComponent(po.po_number)}`}>{po.po_number}</Link>
                    {` (${po.currency}; quotation in ${po.quotation_currency})`}
                  </span>
                ))}
                . Open the PO and check its currency.
              </Alert>
            )}
            {sectors.summary.won_without_po > 0 && (
              <Alert tone="warning">
                <strong>
                  {sectors.summary.won_without_po} quotation{sectors.summary.won_without_po === 1 ? ' is' : 's are'} marked won with no
                  purchase order registered
                </strong>
                , so {sectors.summary.won_without_po === 1 ? 'it is' : 'they are'} not counted as won, lost or pipeline below.{' '}
                <Link to={quotationsUrl({ status: 'Won - PO Received' })}>Register the purchase order</Link> to count it.
              </Alert>
            )}

            <div className="auto-grid--stats">
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
              hint="Enquiries by enquiry date, POs won by PO date, lost and pipeline by quotation date · Pipeline = Submitted, Under Negotiation or On Hold · Win % = deals won ÷ (deals won + lost), several POs on one quotation counting as one deal · FX deals = won POs not in INR · Values stay in their own currency"
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
                    <td className="px-3 py-2 align-top text-[13px]">Total</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(sectors.summary.enquiries)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(sectors.summary.pos)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(sectors.summary.lost)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(sectors.summary.pipeline)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{percent(sectors.summary.win_rate)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right"><Amounts list={sectors.summary.amounts} /></td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(sectors.summary.fx_deals)}</td>
                  </>
                }
                empty={<Empty title="No enquiries or quotations in this period" />}
              />
            </Card>

            <Card title="POs by sector" hint="Registered purchase orders, grouped by the sector of the quotation they fulfil">
              <BarList
                items={sectors.rows.filter((row) => row.pos > 0).map((row) => ({ label: row.sector, value: row.pos, extra: row }))}
                valueFormat={(v, item) =>
                  `${v} PO${v === 1 ? '' : 's'} · ${item.extra.customers} customer${item.extra.customers === 1 ? '' : 's'}`
                }
              />
            </Card>

            <Card
              title="FX deals"
              hint="Registered POs billed in a currency other than INR · INR value = won value × the rate in force on the PO date"
              flush
              actions={<CsvButton report="fx" params={params} disabled={!fx.rows.length} />}
            >
              <DataTable
                columns={[
                  { key: 'customer', header: 'Client', className: 'strong', render: (row) => <>{row.customer}<div className="small muted mono">{row.po_numbers}</div></> },
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
                    header: 'Rate used',
                    align: 'right',
                    render: (row) =>
                      row.rate === null
                        ? <Link to="/settings">Not set</Link>
                        : (
                          <>
                            ₹{row.rate} / {row.currency}
                            <div className="small muted">rate of {date(row.rate_effective_from)}</div>
                          </>
                        ),
                  },
                  {
                    key: 'amount_inr',
                    header: 'Won value (INR)',
                    align: 'right',
                    render: (row) => (row.amount_inr === null
                      ? <span className="muted">Rate not set</span>
                      : <span title={rateTitle([{ currency: row.currency, rate: row.rate, effective_from: row.rate_effective_from }])}>{money(row.amount_inr, 'INR')}</span>),
                  },
                ]}
                rows={fx.rows}
                footer={
                  <>
                    <td colSpan={3} className="px-3 py-2 align-top text-[13px]">Total</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(fx.summary.deals)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right"><Amounts list={fx.summary.amounts} /></td>
                    <td className="px-3 py-2 align-top text-[13px]" />
                    <td className="num px-3 py-2 align-top text-[13px] text-right">
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
              hint="2 or more deals won up to the end of the period — a deal is a quotation with a PO, so phase POs on one quotation are one deal · Enquiries = rows on the Enquiries page · Win % = deals won ÷ (deals won + lost), several POs on one quotation counting as one deal · Won value (INR) includes FX deals at the rate in force on each PO date · Repeat orders = deals after the first"
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
                      ? { ...col, render: (row) => <InrValue value={row.won_value_inr} unconverted={row.unconverted} withoutValue={row.pos_without_value} rateDetails={row.rate_details} /> }
                      : col
                  ),
                ]}
                rows={[
                  { id: 'repeat', label: 'Repeat clients', ...customers.summary.repeat },
                  { id: 'single', label: 'Single enquiry clients', ...customers.summary.single },
                ]}
                footer={
                  <>
                    <td className="px-3 py-2 align-top text-[13px]">Total</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(customers.summary.total.clients)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(customers.summary.total.enquiries)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(customers.summary.total.pos)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{percent(customers.summary.total.win_rate)}</td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">
                      <InrValue
                        value={customers.summary.total.won_value_inr}
                        unconverted={customers.summary.total.unconverted}
                        withoutValue={customers.summary.total.pos_without_value}
                      />
                    </td>
                    <td className="num px-3 py-2 align-top text-[13px] text-right">{number(customers.summary.total.repeat_orders)}</td>
                  </>
                }
              />
            </Card>

          </>
        )}

        {/* Mounted regardless of the sales data above, so a failed load there does not also hide revenue. */}
        {/* The banner at the top names the FX deals' stale rates; revenue adds any other currency it converts. */}
        {!backwards && <RevenueReport period={params} staleShownAbove={(fx?.summary.stale_rates ?? []).map((r) => r.currency)} />}
      </div>
    </>
  );
}
