import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Card, Stat, BarList, ErrorState, Badge, DataTable, Empty } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, number, percent, date } from '../lib/format.js';

export default function Overview() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/overview'));
  const work = useFetch(() => api.raw('/dashboard/worklist'));
  const visitsToday = useFetch(() => api.raw('/visits/today'));

  if (error) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  const d = data?.data;
  const w = work.data?.data;
  const collection = d?.finance.invoiced ? d.finance.received / d.finance.invoiced : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Pipeline, delivery, collections and travel spend — all live"
        actions={<Link className="btn btn--primary" to="/worklist">Open action list</Link>}
      />

      <div className="page stack">
        {loading && <LoadingTiles />}

        {d && (
          <>
            {/* What needs a person today, before anything else */}
            <div className="grid grid--stats">
              <Stat
                label="Overdue payment stages"
                value={number(d.finance.overdue)}
                meta={d.finance.overdue > 0 ? `${money(d.finance.overdue_amount)} to chase` : 'Nothing overdue'}
                tone={d.finance.overdue > 0 ? 'danger' : 'ok'}
                to="/payment-stages?status=Overdue"
              />
              <Stat
                label="Stages to invoice"
                value={number(d.finance.to_invoice)}
                meta={d.finance.to_invoice > 0 ? `${money(d.finance.to_invoice_amount)} waiting on finance` : 'Finance is up to date'}
                tone={d.finance.to_invoice > 0 ? 'warn' : 'ok'}
                to="/payment-stages"
              />
              <Stat
                label="Vendor bills to pay"
                value={number(d.travel.vendor_to_pay)}
                meta={d.travel.vendor_overdue > 0 ? `${d.travel.vendor_overdue} past month-end` : money(d.travel.vendor_to_pay_amount)}
                tone={d.travel.vendor_overdue > 0 ? 'danger' : d.travel.vendor_to_pay > 0 ? 'warn' : 'ok'}
                to="/vendor-invoices"
              />
              <Stat
                label="Claims to action"
                value={number(d.travel.claims_pending + d.travel.claims_to_pay)}
                meta={`${d.travel.claims_pending} to approve · ${d.travel.claims_to_pay} to reimburse`}
                tone={d.travel.claims_pending + d.travel.claims_to_pay > 0 ? 'warn' : 'ok'}
                to="/expense-claims"
              />
            </div>

            <div className="grid grid--stats">
              <Stat label="Quotations" value={number(d.sales.quotations)} meta={`${d.sales.won} won · ${d.sales.open} open`} tone="brand" to="/quotations" />
              <Stat label="Quoted value (₹ only)" value={money(d.sales.value_inr, 'INR', { compact: true })} meta={`${money(d.sales.won_value_inr, 'INR', { compact: true })} won`} />
              <Stat label="Live projects" value={number(d.portfolio.projects)} meta={`${d.portfolio.purchase_orders} purchase orders`} to="/projects" />
              <Stat label="Contract value" value={money(d.portfolio.contract_value, 'INR', { compact: true })} meta="Across all registered POs" />
              <Stat label="Invoiced" value={money(d.finance.invoiced, 'INR', { compact: true })} meta={`${money(d.finance.received, 'INR', { compact: true })} received`} />
              <Stat label="Collection rate" value={percent(collection)} meta={`${money(d.finance.outstanding, 'INR', { compact: true })} outstanding`} tone={collection >= 0.8 ? 'ok' : collection > 0 ? 'warn' : ''} />
            </div>

            {visitsToday.data?.data?.length > 0 && (
              <Card title="Visits today" hint="Audits and site visits under way" actions={<Link className="btn btn--sm" to="/schedule">Schedule</Link>}>
                <ul className="plain-list">
                  {visitsToday.data.data.map((v) => (
                    <li key={v.id}><span className="strong">{v.title}</span> · {v.client_name}{v.city ? `, ${v.city}` : ''} · {v.assignees.map((a) => a.name).join(', ') || 'nobody assigned'} <Badge>{v.status}</Badge></li>
                  ))}
                </ul>
              </Card>
            )}

            {d.sales.won_without_project > 0 && (
              <Card
                title="Won quotations without a project"
                hint={
                  d.sales.won_without_project > 5
                    ? `Showing 5 of ${d.sales.won_without_project} — nothing can be invoiced against these yet`
                    : 'These were marked won but never registered — nothing can be invoiced against them yet'
                }
                actions={<Link className="btn btn--sm" to="/worklist">Register them</Link>}
              >
                <DataTable
                  columns={[
                    { key: 'quotation_no', header: 'Quotation', className: 'mono' },
                    { key: 'client_name', header: 'Client', className: 'strong' },
                    { key: 'service_quoted', header: 'Service', className: 'wrap' },
                    { key: 'quotation_value', header: 'Value', align: 'right', render: (r) => money(r.quotation_value, r.currency) },
                  ]}
                  rows={(w?.won_without_project || []).slice(0, 5)}
                  loading={work.loading}
                  empty={<Empty title="All won quotations are registered" />}
                />
              </Card>
            )}

            <div className="grid grid--2">
              <Card title="Projects by stage" hint="Where the delivery portfolio sits right now">
                <BarList
                  items={d.projects_by_stage.map((s) => ({ label: s.label, value: s.count, extra: s.value }))}
                  valueFormat={(v, item) => `${v} · ${money(item.extra, 'INR', { compact: true })}`}
                />
              </Card>

              <Card title="Pipeline by quotation status" hint="Counts and quoted value in rupees">
                <BarList
                  items={d.pipeline_by_status.map((s) => ({ label: s.label, value: s.count, extra: s.value }))}
                  valueFormat={(v, item) => `${v} · ${money(item.extra, 'INR', { compact: true })}`}
                />
              </Card>
            </div>

            <Card title="Most quoted services" hint="Top 12 by number of quotations">
              <BarList
                items={d.top_services.map((s) => ({ label: s.label, value: s.count, extra: s }))}
                valueFormat={(v, item) => `${v} quoted · ${item.extra.won} won`}
              />
            </Card>

            {w?.late_deliveries?.length > 0 && (
              <Card title="Deliveries past their planned date" hint="Escalate to the project manager">
                <DataTable
                  columns={[
                    { key: 'project_id', header: 'Project', render: (r) => <Link to={`/projects/${r.project_id}`} className="mono">{r.project_id}</Link> },
                    { key: 'client_name', header: 'Client', className: 'strong' },
                    { key: 'project_manager', header: 'Manager' },
                    { key: 'planned_delivery_date', header: 'Planned', render: (r) => date(r.planned_delivery_date) },
                    { key: 'days_late', header: 'Days late', align: 'right', render: (r) => <Badge tone="danger">{r.days_late}</Badge> },
                    { key: 'project_stage', header: 'Stage', render: (r) => <Badge>{r.project_stage}</Badge> },
                  ]}
                  rows={w.late_deliveries}
                />
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}

function LoadingTiles() {
  return (
    <div className="grid grid--stats">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 92 }} />
      ))}
    </div>
  );
}
