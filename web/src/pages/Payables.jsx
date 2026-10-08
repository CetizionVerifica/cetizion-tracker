import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Download, Filter } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { useToast } from '../components/ui.jsx';
import { PayVendorDialog } from '../components/actions.jsx';
import { ListTable, PhoneRow, RefreshButton, useEntrance } from '../components/daily.jsx';
import { Key, MoneyBanner, MoneyHero, SkelPanel, shortDate } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { count } from '../components/travel.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { money } from '../lib/format.js';

/** The ageing bands, in Collections' words, and their tones. "amount missing" is a gap, never a band. */
const BANDS = [
  { key: 'not due', label: 'Not yet due', tone: 'ok' },
  { key: '0-30', label: '1–30 days', tone: 'wait' },
  { key: '31-60', label: '31–60 days', tone: 'late' },
  { key: '61-90', label: '61–90 days', tone: 'late' },
  { key: '90+', label: 'Over 90 days', tone: 'late' },
  { key: 'date missing', label: 'Date missing', tone: 'wait' },
];
const BAND = Object.fromEntries([...BANDS, { key: 'amount missing', label: 'No amount yet', tone: 'plain' }].map((b) => [b.key, b]));

/**
 * What we owe travel vendors, aged (#76) — the other side of Collections,
 * in the Wave 5/6 shape: a chocolate hero for what is outstanding (overdue
 * solid, not yet due hatched) beside a By age chart whose bands filter the
 * bills, the no-amount banner, then the unpaid bills with Pay on each row.
 * Rupees throughout. A failed load is never "nothing owed".
 */
export default function Payables() {
  const navigate = useNavigate();
  const toast = useToast();
  const { isHr } = useAuth();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/payables'));
  const [bucket, setBucket] = useState(null);
  const [paying, setPaying] = useState(null);
  const p = data?.data;
  const ref = useEntrance(Boolean(p));

  /** Pay needs the bill's credit notes and terms, which the ageing rows don't carry. */
  async function pay(row) {
    try {
      const { data: full } = await api.raw(`/vendor-invoices/${row.id}/full`);
      setPaying(full.invoice);
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const header = (
    <PageHeader
      title="Payables"
      eyebrow={isHr ? 'Records' : 'Money'}
      subtitle="What we owe travel vendors, after credit notes, and how long they have been waiting. Open a bill to see its lines, or pay it from here."
      actions={(
        <>
          <a className="mg-btn" href={api.exportUrl('payables')} download title="The rows below, as a spreadsheet"><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Export CSV</a>
          <RefreshButton onClick={refetch} busy={loading} />
        </>
      )}
    />
  );

  if (error) {
    return (
      <>
        {header}
        <div className="app-page">
          <section className="mg-glass mg-glass--strong mg-empty" role="alert" data-a="rise">
            <span className="mg-empty__mark bg-late-soft text-late" aria-hidden="true">!</span>
            <h2 className="mg-empty__title">Couldn't load what we owe</h2>
            <p className="mg-empty__text">{error} This is not "nothing owed": the figures didn't arrive.</p>
            <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
          </section>
        </div>
      </>
    );
  }
  if (!p) {
    return (
      <>
        {header}
        <div className="app-page" aria-busy="true" aria-label="Loading payables">
          <div className="app-mrow"><SkelPanel rows={3} className="flex-1" /><SkelPanel rows={3} className="flex-1" /></div>
          <SkelPanel rows={5} />
        </div>
      </>
    );
  }

  const withAmount = p.rows.filter((r) => r.outstanding !== null);
  const missing = p.rows.filter((r) => r.bucket === 'amount missing');
  const sumOf = (rows) => rows.reduce((n, r) => n + Number(r.outstanding || 0), 0);
  const overdue = sumOf(withAmount.filter((r) => Number(r.days_overdue) > 0));
  const notDue = sumOf(withAmount.filter((r) => r.bucket === 'not due'));
  const undated = sumOf(withAmount.filter((r) => r.bucket === 'date missing'));
  const total = Number(p.total_outstanding);
  const vendors = new Set(withAmount.map((r) => r.travel_vendor)).size;
  const bandSum = Object.fromEntries(p.buckets.map((b) => [b.bucket, { amount: Number(b.outstanding || 0), n: b.invoices }]));
  const max = Math.max(1, ...BANDS.map((b) => bandSum[b.key]?.amount || 0));
  const shown = bucket ? p.rows.filter((r) => r.bucket === bucket) : p.rows;
  const shownWith = shown.filter((r) => r.outstanding !== null);
  const pct = (n) => (total > 0 ? (100 * n) / total : 0);

  const bill = (r) => r.vendor_invoice_no || r.vendor_invoice_id;
  const payBtn = (r, big) => (r.outstanding === null ? (
    <button type="button" className={cn('mg-btn', !big && 'mg-btn--sm')} aria-disabled="true" title="Enter the amount first" aria-label={`Pay ${bill(r)}: enter the amount first`} onClick={(e) => e.stopPropagation()}>Pay</button>
  ) : (
    <button type="button" className={cn('mg-btn', !big && 'mg-btn--sm', Number(r.days_overdue) > 0 && 'mg-btn--primary')} aria-label={`Pay ${r.travel_vendor} ${money(r.outstanding)} on ${bill(r)}`} onClick={(e) => { e.stopPropagation(); pay(r); }}>Pay</button>
  ));

  return (
    <>
      {header}
      <div className="app-page" ref={ref}>
        {p.rows.length === 0 ? (
          <section className="mg-glass mg-glass--strong mg-empty" data-a="rise">
            <span className="mg-empty__mark bg-ok-soft text-ok" aria-hidden="true">✓</span>
            <h2 className="mg-empty__title">Nothing owed</h2>
            <p className="mg-empty__text">Every travel vendor bill with an invoice number is paid. A new bill shows here until finance pays it.</p>
          </section>
        ) : (
          <>
            <div className="app-mrow">
              <MoneyHero
                label="Total outstanding (INR)"
                figure={money(total)}
                count={total}
                sub={`Owed to ${count(vendors, 'travel vendor')} on ${count(withAmount.length, 'bill')} with an amount, after credit notes.${overdue > 0 ? ` ${money(overdue)} of it is past its pay-by date.` : ' None of it is past its pay-by date.'}`}
                done={pct(overdue)}
                expected={pct(notDue)}
                aria={`${money(overdue)} overdue, ${money(notDue)} not yet due, ${money(undated)} with no pay-by date`}
                legend={(
                  <>
                    <Key>Overdue <strong className="mg-num">{money(overdue)}</strong></Key>
                    <Key swatch="hatch">Not yet due <strong className="mg-num">{money(notDue)}</strong></Key>
                    {undated > 0 && <Key swatch="empty">No date yet <strong className="mg-num">{money(undated)}</strong></Key>}
                  </>
                )}
              />
              <section className="mg-glass mg-panel app-mrow__side" data-a="rise" aria-labelledby="age-t">
                <div className="mg-panel__head flex-wrap">
                  <h2 className="mg-panel__title" id="age-t">By age</h2>
                  <div className="mg-legend">
                    <Key swatch="hatch">Not yet due</Key>
                    <Key swatch={{ background: 'var(--figure)' }}>Overdue</Key>
                    <Key swatch={{ background: 'var(--late)' }}>Over 90 days</Key>
                    <Key swatch={{ background: 'var(--latte)' }}>No date</Key>
                  </div>
                </div>
                <div className="app-age app-age--6" role="group" aria-label="Show one age band">
                  {BANDS.map((b) => {
                    const { amount = 0, n = 0 } = bandSum[b.key] || {};
                    const on = bucket === b.key;
                    return (
                      <button key={b.key} type="button" aria-pressed={on} onClick={() => setBucket(on ? null : b.key)}
                        aria-label={`${b.label}: ${money(amount)}, ${count(n, 'bill')}. ${on ? 'Showing only this band; press again for every band' : 'Show only this band'}`}>
                        <span className={cn('app-age__fig', !amount && 'text-muted-foreground', b.key === '90+' && amount ? 'text-late' : b.key === 'not due' && amount ? 'text-caramel-text' : '')}>{money(amount, 'INR', { compact: true })}</span>
                        <span className="app-age__plot">
                          <span className={cn('app-age__bar', b.key === 'not due' && 'mg-hatch')} data-a="grow"
                            style={{ height: `${amount ? Math.max(8, (100 * amount) / max) : 2}%`, background: !amount ? 'var(--line)' : b.key === 'not due' ? undefined : b.key === '90+' ? 'var(--late)' : b.key === 'date missing' ? 'var(--latte)' : 'var(--figure)' }} />
                        </span>
                        <span className="app-age__label">{b.label}</span>
                        <span className="app-age__n">{count(n, 'bill')}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>

            {missing.length > 0 && (
              <MoneyBanner
                tone="wait"
                title={`${count(missing.length, 'vendor bill')} ${missing.length === 1 ? 'has' : 'have'} no amount, so ${missing.length === 1 ? 'it is' : 'they are'} not in the totals above.`}
                action={<Link className="mg-btn mg-btn--sm" to="/vendor-invoices?payment_status=Enter%20amount">Enter the amounts</Link>}
              >
                {missing.slice(0, 3).map((r) => `${bill(r)} from ${r.travel_vendor}${r.invoice_date ? `, dated ${shortDate(r.invoice_date)}` : ''}`).join('; ')}{missing.length > 3 ? ' and more' : ''}. HR enters the amount from the bill.
              </MoneyBanner>
            )}

            {bucket && (
              <MoneyBanner tone="info" icon={Filter} title={`Showing ${BAND[bucket].label.toLowerCase()} only: ${count(shown.length, 'bill')}.`}
                action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setBucket(null)}>Show all</button>}>
                The totals and chart still cover everything we owe.
              </MoneyBanner>
            )}

            <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="bills-t">
              <div className="app-panel__head">
                <div className="app-panel__titles">
                  <h2 className="mg-panel__title" id="bills-t">Unpaid bills</h2>
                  <span className="mg-panel__hint">Oldest overdue first. Open a bill for its lines and notes.</span>
                </div>
                <div className="app-panel__tools"><Tone>{count(shown.length, 'bill')}</Tone></div>
              </div>
              {shown.length === 0 ? (
                <p className="app-panel__note">No bill in this band.</p>
              ) : (
                <ListTable
                  label="Unpaid travel vendor bills, oldest overdue first"
                  rows={shown}
                  onRowClick={(r) => navigate(`/vendor-invoices/${r.id}`)}
                  columns={[
                    { key: 'no', header: 'Invoice', className: 'nowrap', render: (r) => <><Link className="mg-num font-bold text-foreground no-underline" to={`/vendor-invoices/${r.id}`} aria-label={`Open the bill ${bill(r)} from ${r.travel_vendor}`}>{bill(r)}</Link><span className="sub mg-num">{r.invoice_date ? shortDate(r.invoice_date) : r.vendor_invoice_no ? 'No date yet' : 'No date yet · our reference'}</span></> },
                    { key: 'vendor', header: 'Vendor', className: 'app-wrap--sm', render: (r) => r.travel_vendor },
                    { key: 'trip', header: 'Trip', className: 'app-wrap--sm', render: (r) => (r.travel_id ? <><Link className="app-link mg-num" to={`/travel/${encodeURIComponent(r.travel_id)}`}>{r.travel_id}</Link><span className="sub">{r.employee_name}</span></> : <><b>Several trips</b><span className="sub">{r.employee_name}</span></>) },
                    { key: 'amount', header: 'Amount', num: true, render: (r) => (r.invoice_amount === null ? <Tone tone="wait">Not entered</Tone> : money(r.invoice_amount)) },
                    { key: 'paid', header: 'Paid', num: true, render: (r) => (Number(r.amount_paid) > 0 ? money(r.amount_paid) : <span className="text-muted-foreground">—</span>) },
                    { key: 'out', header: 'Outstanding', num: true, render: (r) => (r.outstanding === null ? <span className="text-muted-foreground">—</span> : <b className={Number(r.days_overdue) > 0 ? 'text-late' : undefined}>{money(r.outstanding)}</b>) },
                    { key: 'payby', header: 'Pay by', className: 'mg-num nowrap', render: (r) => (r.pay_by ? <span className={Number(r.days_overdue) > 0 ? 'text-late' : undefined}>{shortDate(r.pay_by)}</span> : <span className="text-muted-foreground">—</span>) },
                    { key: 'days', header: 'Days overdue', num: true, render: (r) => (Number(r.days_overdue) > 0 ? <b className="text-late">{r.days_overdue}</b> : <span className="text-muted-foreground">—</span>) },
                    { key: 'age', header: 'Ageing', render: (r) => <Tone tone={BAND[r.bucket]?.tone}>{BAND[r.bucket]?.label || r.bucket}</Tone> },
                    { key: 'pay', header: '', className: 'actions', render: (r) => payBtn(r) },
                  ]}
                  phone={(r) => (
                    <PhoneRow
                      title={<Link className="text-inherit no-underline" to={`/vendor-invoices/${r.id}`} aria-label={`Open the bill ${bill(r)} from ${r.travel_vendor}`}>{r.travel_vendor}</Link>}
                      amount={<span className={Number(r.days_overdue) > 0 ? 'text-late' : undefined}>{r.outstanding === null ? 'No amount' : money(r.outstanding)}</span>}
                      meta={[bill(r), [r.travel_id, r.employee_name].filter(Boolean).join(' '), r.pay_by && `pay by ${shortDate(r.pay_by)}`, Number(r.days_overdue) > 0 && `${r.days_overdue} days overdue`].filter(Boolean).join(' · ')}
                      state={<Tone tone={BAND[r.bucket]?.tone}>{BAND[r.bucket]?.label || r.bucket}</Tone>}
                    >
                      <span className="app-rowbtns">{payBtn(r, true)}<Link className="mg-btn mg-btn--ghost" to={`/vendor-invoices/${r.id}`}>Open the bill</Link></span>
                    </PhoneRow>
                  )}
                />
              )}
              {shownWith.length > 0 && (
                <div className="app-linetotal">
                  <span>Total · {count(shownWith.length, 'bill')} with an amount</span>
                  <span className="mg-num">{money(sumOf(shownWith))} outstanding</span>
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {paying && (
        <PayVendorDialog invoice={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); refetch(); }} />
      )}
    </>
  );
}
