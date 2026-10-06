import { PageHeader } from '../App.jsx';
import { Card, Stat, BarList, ErrorState } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, number } from '../lib/format.js';

export default function TravelDashboard() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/travel'));

  if (error) {
    return (
      <>
        <PageHeader title="Travel spend" />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  const d = data?.data;

  return (
    <>
      <PageHeader title="Travel spend" subtitle="Company travel cost and where it sits in the pay cycle" />

      <div className="page stack">
        {loading && <div className="skeleton" style={{ height: 92 }} />}

        {d && (
          <>
            <div className="auto-grid--stats">
              <Stat label="Trips logged" value={number(d.snapshot.trips)} tone="brand" />
              <Stat label="Total travel cost" value={money(d.snapshot.total_cost)} meta="Vendor bills plus employee claims" />
              <Stat label="Vendor invoiced" value={money(d.snapshot.vendor_cost)} meta={`${money(d.snapshot.vendor_paid)} paid`} />
              <Stat label="Employee claims" value={money(d.snapshot.employee_claims)} meta={`${money(d.snapshot.employee_reimbursed)} reimbursed`} />
              <Stat
                label="Unpaid vendor balance"
                value={money(Number(d.snapshot.vendor_cost) - Number(d.snapshot.vendor_paid))}
                tone={Number(d.snapshot.vendor_cost) > Number(d.snapshot.vendor_paid) ? 'warn' : 'ok'}
              />
              <Stat
                label="Unreimbursed to staff"
                value={money(Number(d.snapshot.employee_claims) - Number(d.snapshot.employee_reimbursed))}
                tone={Number(d.snapshot.employee_claims) > Number(d.snapshot.employee_reimbursed) ? 'warn' : 'ok'}
              />
            </div>

            <div className="auto-grid--stats">
              <Stat label="Trips missing documents" value={number(d.attention.missing_documents)} meta="A ticket or the vendor's invoice not on file"
                tone={d.attention.missing_documents ? 'warn' : 'ok'} to="/travel" />
              <Stat label="Chargeable, not yet billed" value={number(d.attention.unbilled_chargeable)} meta={`${money(d.attention.unbilled_value)} to bill to clients`}
                tone={d.attention.unbilled_chargeable ? 'warn' : 'ok'} to="/travel" />
            </div>

            <div className="auto-grid grid--2">
              <Card title="Spend by mode" hint="The agency's bills, net of credit notes, by what was booked">
                <BarList items={d.by_mode.map((m) => ({ ...m, label: m.label.charAt(0).toUpperCase() + m.label.slice(1) }))} valueFormat={(v, item) => `${money(v)} · ${item.count} line(s)`} />
              </Card>

              <Card title="Spend by trip type" hint="Total trip cost, chargeable and not">
                <BarList items={d.by_trip_type} valueFormat={(v, item) => `${money(v)} · ${item.count} trip(s)`} />
              </Card>

              <Card title="Spend by travel vendor" hint="Total trip cost booked through each vendor">
                <BarList items={d.by_vendor} valueFormat={(v, item) => `${money(v)} · ${item.count} trip(s)`} />
              </Card>

              <Card title="Trips by month" hint="Count and cost of trips starting each month">
                <BarList items={d.by_month.map((m) => ({ label: m.label, value: m.count, extra: m.value }))} valueFormat={(v, item) => `${v} trip(s) · ${money(item.extra)}`} />
              </Card>

              <Card title="Vendor invoice status" hint="Where each bill sits in the pay cycle">
                <BarList
                  items={d.vendor_invoice_status.map((s) => ({ label: s.label, value: s.count, extra: s.value }))}
                  valueFormat={(v, item) => `${v} · ${money(item.extra)}`}
                />
              </Card>

              <Card title="Employee claim status">
                <BarList
                  items={d.claim_status.map((s) => ({ label: s.label, value: s.count, extra: s.value }))}
                  valueFormat={(v, item) => `${v} · ${money(item.extra)}`}
                />
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}
