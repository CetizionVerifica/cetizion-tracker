import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Alert, Badge, Card, Select, Stat } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money, today } from '../lib/format.js';

/**
 * Cash-flow forecast (#40): expected money in and out by month, from the
 * payment schedule, the pipeline and the travel bills.
 */
const LABEL = { invoiced: 'Invoiced, due', scheduled: 'To be invoiced', pipeline: 'Pipeline (weighted)', vendors: 'Vendor bills', claims: 'Expense claims' };

export default function Cashflow() {
  const [params] = useSearchParams();
  // Reports links a month of the cash chart here as ?month=2026-10, and
  // Insights a quarter or a year as ?from=2026-10-01&to=2026-12-31: the
  // months open on arrival rather than asking for the same clicks again.
  const [open, setOpen] = useState(() => (params.get('month') ? [params.get('month')] : monthsBetween(params.get('from'), params.get('to'))));
  // Long enough to reach the last month asked for: a financial year from
  // Insights can run 18 months out, and a shorter horizon would fold its
  // last months into "Later". The API stops at 24.
  const [months, setMonths] = useState(() => horizonFor(monthsAhead(open[open.length - 1])));
  const horizons = ['3', '6', '12', ...(['3', '6', '12'].includes(months) ? [] : [months])];
  const { data, loading, error } = useFetch(() => api.raw(`/cashflow?months=${months}`), [months]);
  const d = data?.data;
  const rows = d?.months ?? [];
  const max = Math.max(1, ...rows.map((m) => Math.max(m.inflow_with_pipeline, m.outflow)));
  const totals = rows.filter((m) => m.month !== 'unscheduled').reduce((t, m) => ({ inflow: t.inflow + m.inflow, pipeline: t.pipeline + m.pipeline, outflow: t.outflow + m.outflow }), { inflow: 0, pipeline: 0, outflow: 0 });

  return (
    <>
      <PageHeader
        title="Cash-flow forecast"
        subtitle="Money expected in from invoices, the payment schedule and the weighted pipeline; money out for vendor bills and expense claims. INR only."
        actions={<Select value={months} placeholder={null} options={horizons.map((m) => ({ value: m, label: `${m} months` }))} onChange={(e) => setMonths(e.target.value)} />}
      />
      <div className="page stack">
        {error && <Alert tone="danger"><span>{error}</span></Alert>}
        {d && (
          <div className="auto-grid--stats">
            <Stat label={`In, next ${months} months`} value={money(totals.inflow)} meta="invoiced + scheduled" />
            <Stat label="Pipeline on top" value={money(totals.pipeline)} meta="weighted by probability" />
            <Stat label="Out" value={money(totals.outflow)} meta="vendors + claims" />
            <Stat label="Net" value={money(totals.inflow - totals.outflow)} tone={totals.inflow - totals.outflow < 0 ? 'danger' : ''} />
          </div>
        )}
        <Card title="By month" hint="Bars: expected in (solid), pipeline on top (light), out (red). Click a month for the lines behind it.">
          {loading && !d ? <div className="skeleton" style={{ height: 160 }} /> : (
            <div className="cashflow">
              {rows.map((m) => (
                <div key={m.month} className={`cashflow__row ${open.includes(m.month) ? 'is-open' : ''}`} onClick={() => setOpen(open.length === 1 && open[0] === m.month ? [] : [m.month])}>
                  <div className="cashflow__label">{m.month === 'later' ? 'Later' : m.month === 'unscheduled' ? 'No date yet' : monthLabel(m.month)}</div>
                  <div className="cashflow__bars">
                    <div className="cashflow__bar" title={`In: ${money(m.inflow)}`}><span className="cashflow__in" style={{ width: `${(m.inflow / max) * 100}%` }} /><span className="cashflow__pipe" style={{ width: `${(m.pipeline / max) * 100}%` }} /></div>
                    <div className="cashflow__bar" title={`Out: ${money(m.outflow)}`}><span className="cashflow__out" style={{ width: `${(m.outflow / max) * 100}%` }} /></div>
                  </div>
                  <div className="cashflow__nums">
                    <span>in {money(m.inflow)}{m.pipeline > 0 && <span className="muted"> +{money(m.pipeline)}</span>}</span>
                    <span>out {money(m.outflow)}</span>
                    <span className={m.net < 0 ? 'strong' : 'strong'} style={{ color: m.net < 0 ? 'var(--danger-fg)' : 'var(--ok-fg)' }}>net {money(m.net)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        {rows.filter((m) => open.includes(m.month)).map((m) => (
          <Card key={m.month} flush title={`${m.month === 'later' ? 'Later' : m.month === 'unscheduled' ? 'No date yet' : monthLabel(m.month)}: the lines`} hint="What makes up the month. Overdue invoices count in the current month.">
            <table className="table">
              <thead><tr><th>Kind</th><th>Reference</th><th>Client / vendor</th><th>Note</th><th>When</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {m.items.map((it, i) => (
                  <tr key={i}>
                    <td><Badge tone={it.field === 'vendors' || it.field === 'claims' ? 'danger' : it.field === 'pipeline' ? 'info' : 'success'}>{LABEL[it.field]}</Badge></td>
                    <td className="mono small">{it.ref}</td><td>{it.client}</td><td className="small muted">{it.note}</td><td>{date(it.when)}</td>
                    <td className="num">{money(it.amount)}</td>
                  </tr>
                ))}
                {!m.items.length && <tr><td colSpan={6} className="muted">Nothing expected</td></tr>}
              </tbody>
            </table>
          </Card>
        ))}
        {d?.foreign.length > 0 && (
          <Card flush title="Not in INR" hint="Left out of the totals; set exchange rates on the sales report to see them in rupees.">
            <table className="table"><tbody>{d.foreign.map((f, i) => <tr key={i}><td>{f.kind}</td><td className="mono small">{f.ref}</td><td>{f.client}</td><td className="num">{money(f.amount, f.currency)}</td></tr>)}</tbody></table>
          </Card>
        )}
      </div>
    </>
  );
}

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${y}`;
}

/** Every YYYY-MM from one date's month to another's, or none. */
function monthsBetween(from, to) {
  if (!/^\d{4}-\d{2}/.test(from || '') || !/^\d{4}-\d{2}/.test(to || '')) return [];
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (let i = 0; i < 36; i += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The horizon that shows `needed` months: 6, 12, or as many as needed up to 24. */
function horizonFor(needed) {
  if (needed <= 6) return '6';
  if (needed <= 12) return '12';
  return String(Math.min(needed, 24));
}

/** How many months after this one a YYYY-MM is, counting this one as 1. */
function monthsAhead(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return 0;
  const now = today().slice(0, 7);
  const [y1, m1] = now.split('-').map(Number);
  const [y2, m2] = ym.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}
