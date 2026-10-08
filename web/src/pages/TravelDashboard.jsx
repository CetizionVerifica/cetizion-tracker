import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Chip } from '../components/record.jsx';
import { Card, Stat, BarList, ErrorState } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, number } from '../lib/format.js';

export default function TravelDashboard() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/travel'));

  if (error) {
    return (
      <>
        <PageHeader title="Travel dashboard" />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }

  const d = data?.data;

  return (
    <>
      <PageHeader title="Travel dashboard" subtitle="Company travel cost and where it sits in the pay cycle" />

      <div className="page stack">
        {loading && <div className="skeleton h-[92px]" />}

        {d && (
          <>
            <div className="auto-grid--stats">
              <Stat label="Total travel cost" value={money(d.snapshot.total_cost)} meta={`${number(d.snapshot.trips)} trips · agency bills plus staff claims`} />
              <Stat
                label="Owed to agencies"
                value={money(Number(d.snapshot.vendor_cost) - Number(d.snapshot.vendor_paid))}
                meta={`${money(d.snapshot.vendor_paid)} paid of ${money(d.snapshot.vendor_cost)}`}
                tone={Number(d.snapshot.vendor_cost) > Number(d.snapshot.vendor_paid) ? 'warn' : ''}
                to="/payables"
              />
              <Stat
                label="Owed to staff"
                value={money(Number(d.snapshot.employee_claims) - Number(d.snapshot.employee_reimbursed))}
                meta={`${money(d.snapshot.employee_reimbursed)} reimbursed of ${money(d.snapshot.employee_claims)}`}
                tone={Number(d.snapshot.employee_claims) > Number(d.snapshot.employee_reimbursed) ? 'warn' : ''}
                to="/expense-claims"
              />
              <Stat
                label="Not billed to clients"
                value={money(d.attention.unbilled_value)}
                meta={`${number(d.attention.unbilled_chargeable)} chargeable trips`}
                tone={d.attention.unbilled_chargeable ? 'warn' : ''}
                to="/travel"
              />
            </div>

            {(d.attention.missing_documents > 0 || d.attention.unbilled_chargeable > 0) && (
              <section aria-label="Needs you" className="flex flex-col gap-3">
                <h2 className="font-display text-base font-bold text-foreground">Needs you</h2>
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  {d.attention.missing_documents > 0 && (
                    <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
                      <Chip tone="waiting">Documents missing</Chip>
                      <span className="min-w-0 flex-1 text-[14px] text-foreground">
                        <strong className="font-semibold">{number(d.attention.missing_documents)} trips</strong> have no ticket or agency invoice on file.
                      </span>
                      <Link className="btn btn--sm" to="/travel">Open trips</Link>
                    </div>
                  )}
                  {d.attention.unbilled_chargeable > 0 && (
                    <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5 last:border-b-0">
                      <Chip tone="info">Not billed</Chip>
                      <span className="min-w-0 flex-1 text-[14px] text-foreground">
                        <strong className="font-semibold">{number(d.attention.unbilled_chargeable)} chargeable trips</strong> are not on a client invoice yet, worth {money(d.attention.unbilled_value)}.
                      </span>
                      <Link className="btn btn--sm" to="/travel">Open trips</Link>
                    </div>
                  )}
                </div>
              </section>
            )}

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
