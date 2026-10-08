import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Globe, X } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { Key, MoneyHero, shortDate } from '../components/money.jsx';
import { FailedCard, plural } from '../components/daily.jsx';
import { Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useFetch, useMediaQuery } from '../lib/hooks.js';
import { money, today } from '../lib/format.js';

/**
 * Cash-flow forecast (#40): expected money in and out by month, from the
 * payment schedule, the pipeline and the travel bills. Wave 5 shape: the
 * horizon as a labelled switch, the hero for what comes in, four figures
 * beside it, the months as a chart (or a table), and the lines behind the
 * month that is open.
 */
const LABEL = { invoiced: 'Invoiced, due', scheduled: 'To be invoiced', pipeline: 'Pipeline (weighted)', vendors: 'Vendor bills', claims: 'Expense claims' };
const TONE = { invoiced: 'ok', scheduled: 'ok', pipeline: 'info', vendors: 'late', claims: 'late' };
const OUT = new Set(['vendors', 'claims']);

export default function Cashflow() {
  const [params] = useSearchParams();
  // Reports links a month of the cash chart here as ?month=2026-10, and
  // Insights a quarter or a year as ?from=2026-10-01&to=2026-12-31: the
  // months open on arrival rather than asking for the same clicks again.
  const [open, setOpen] = useState(() => (params.get('month') ? [params.get('month')] : monthsBetween(params.get('from'), params.get('to'))));
  // Long enough to reach the last month asked for; the API stops at 24.
  const [months, setMonths] = useState(() => horizonFor(monthsAhead(open[open.length - 1])));
  const [view, setView] = useState('chart');
  const horizons = ['3', '6', '12', ...(['3', '6', '12'].includes(months) ? [] : [months])];
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/cashflow?months=${months}`), [months]);
  const d = data?.data;
  const rows = d?.months ?? [];
  const dated = rows.filter((m) => m.month !== 'unscheduled');
  const horizon = rows.filter((m) => m.month !== 'unscheduled' && m.month !== 'later');
  const later = rows.find((m) => m.month === 'later');
  const undated = rows.find((m) => m.month === 'unscheduled');
  const totals = dated.reduce((t, m) => ({ inflow: t.inflow + m.inflow, invoiced: t.invoiced + m.invoiced, scheduled: t.scheduled + m.scheduled, pipeline: t.pipeline + m.pipeline, outflow: t.outflow + m.outflow }), { inflow: 0, invoiced: 0, scheduled: 0, pipeline: 0, outflow: 0 });
  const net = totals.inflow - totals.outflow;
  // The month that is open (the first one by default: this month).
  const shownMonth = rows.find((m) => open.includes(m.month)) ? open : (rows[0] ? [rows[0].month] : []);
  const pick = (key) => setOpen(shownMonth.length === 1 && shownMonth[0] === key ? [] : [key]);
  const first = horizon[0]?.month;
  const last = horizon[horizon.length - 1]?.month;

  return (
    <>
      <PageHeader
        title="Cash-flow forecast"
        subtitle="Money expected in from invoices, the payment schedule and the weighted pipeline; money out for vendor bills and expense claims. INR only."
        actions={
          <div className="app-horizon" role="radiogroup" aria-label="Horizon">
            <span className="mg-label" aria-hidden="true">Horizon</span>
            <div className="mg-seg">
              {horizons.map((m) => (
                <button key={m} type="button" role="radio" aria-checked={months === m} onClick={() => setMonths(m)} className={months === m ? 'app-seg-on' : undefined}>{m} months</button>
              ))}
            </div>
          </div>
        }
      />
      <div className="app-page">
        {error && !d ? (
          // A failed load is never shown as ₹0.
          <FailedCard title="Couldn't load the forecast" text={`No figures are shown rather than wrong ones. (${error})`} onRetry={refetch} />
        ) : loading && !d ? (
          <div aria-busy="true" aria-label="Loading the forecast" className="flex flex-col gap-[18px]">
            <div className="app-mrow">
              <section className="mg-glass mg-panel" style={{ flex: '1 1 400px', minHeight: 230 }}><div className="mg-skel" style={{ height: 56, width: '70%' }} /><div className="mg-skel" style={{ height: 10, marginTop: 'auto' }} /></section>
              <section className="mg-glass mg-panel" style={{ flex: '1.35 1 520px', minHeight: 230 }}><div className="mg-skel" style={{ height: 50 }} /><div className="mg-skel" style={{ height: 50 }} /></section>
            </div>
            <section className="mg-glass mg-panel" style={{ minHeight: 280, flexDirection: 'row', alignItems: 'flex-end', gap: 14 }}>{[160, 120, 80, 100, 50, 60].map((h, i) => <div key={i} className="mg-skel" style={{ flex: 1, height: h }} />)}</section>
          </div>
        ) : !rows.some((m) => m.inflow || m.outflow || m.pipeline) ? (
          <section className="mg-glass mg-empty" data-a="rise" style={{ padding: '56px 24px' }}>
            <h2 className="mg-empty__title">Nothing expected in or out</h2>
            <p className="mg-empty__text">No open invoices, stages, pipeline, vendor bills or claims fall in the next {months} months. They show here as soon as they exist.</p>
          </section>
        ) : (
          <>
            <div className="app-mrow">
              <MoneyHero
                label={`In, next ${months} months`}
                figure={money(totals.inflow)}
                count={totals.inflow}
                sub={`Invoiced and to be invoiced, ${monthLabel(first)} to ${monthLabel(last)}${later?.inflow ? `, plus ${money(later.inflow)} dated later` : ''}. Stages with no date yet are not counted here.`}
                done={totals.inflow ? (100 * totals.invoiced) / totals.inflow : 0}
                expected={totals.inflow ? (100 * totals.scheduled) / totals.inflow : 0}
                aria={`${money(totals.invoiced)} invoiced and due, ${money(totals.scheduled)} to be invoiced`}
                legend={<>
                  <Key swatch={{ background: 'var(--on-hero)' }}>Invoiced, due <strong>{money(totals.invoiced)}</strong></Key>
                  <Key swatch="hatch">To be invoiced <strong>{money(totals.scheduled)}</strong></Key>
                </>}
              />
              <section className="mg-glass app-mrow__side app-quad" data-a="rise" aria-label="Pipeline, out, net and not counted">
                <div><span className="mg-label">Pipeline on top</span><span className="mg-tile__figure mg-num is-wait-text">{money(totals.pipeline)}</span><span className="mg-tile__foot">Open deals, weighted by probability. Not in the In figure.</span></div>
                <div><span className="mg-label">Out</span><span className="mg-tile__figure mg-num">{money(totals.outflow)}</span><span className="mg-tile__foot">Vendor bills and approved expense claims still to pay.</span></div>
                <div><span className="mg-label">Net</span><span className={cn('mg-tile__figure mg-num', net < 0 ? 'text-late' : 'text-ok')}>{money(net)}</span><span className="mg-tile__foot">In minus out. Pipeline not counted.</span></div>
                <div><span className="mg-label">Not counted in In</span><span className="mg-tile__figure mg-num">{money(undated?.inflow || 0)}</span><span className="mg-tile__foot">{undated?.inflow ? `${plural(undated.items.filter((i) => !OUT.has(i.field)).length, 'stage')} with no date yet` : 'Every stage has a date'}</span></div>
              </section>
            </div>

            <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="months-t">
              <div className="app-panel__head">
                <div className="app-panel__titles">
                  <h2 className="mg-panel__title" id="months-t">By month</h2>
                  <span className="mg-panel__hint">Open a month for the lines behind it. Overdue invoices count in the current month. Net is in minus out; the pipeline is not counted in it.</span>
                </div>
                <div className="app-panel__tools">
                  <span className="mg-legend"><Key swatch={{ background: 'var(--figure)' }}>In</Key><Key swatch="hatch">Pipeline, weighted</Key><Key swatch={{ background: 'var(--latte)' }}>Out</Key></span>
                  <div className="mg-seg" role="radiogroup" aria-label="Show the months as">
                    <button type="button" role="radio" aria-checked={view === 'chart'} className={view === 'chart' ? 'app-seg-on' : undefined} onClick={() => setView('chart')}>Chart</button>
                    <button type="button" role="radio" aria-checked={view === 'table'} className={view === 'table' ? 'app-seg-on' : undefined} onClick={() => setView('table')}>Table</button>
                  </div>
                </div>
              </div>
              {view === 'chart' ? <MonthChart rows={rows} open={shownMonth} onPick={pick} /> : <MonthTable rows={rows} open={shownMonth} onPick={pick} />}
            </section>

            {rows.filter((m) => shownMonth.includes(m.month)).map((m) => <MonthLines key={m.month} m={m} onClose={() => setOpen([])} />)}

            {d.foreign.length > 0 && (
              <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="fx-t">
                <div className="app-panel__head">
                  <span className="app-portal-card__mark" aria-hidden="true"><Globe strokeWidth={1.8} /></span>
                  <div className="app-panel__titles">
                    <span className="flex flex-wrap items-center gap-2"><h2 className="mg-panel__title" id="fx-t">Not in INR</h2><Tone tone="wait">{plural(d.foreign.length, 'item')} left out</Tone></span>
                    <span className="mg-panel__hint">Left out of every total above. Set exchange rates in Settings › Exchange rates to see them in rupees.</span>
                  </div>
                  <div className="app-panel__tools"><Link className="mg-btn mg-btn--sm" to="/settings/rates">Set exchange rates<ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" /></Link></div>
                </div>
                <div className="mg-tablewrap app-panel__body">
                  <table className="mg-table">
                    <thead><tr><th>Kind</th><th>Reference</th><th>Client</th><th className="num">Amount, in its currency</th></tr></thead>
                    <tbody>{d.foreign.map((f, i) => <tr key={i}><td><Tone tone={f.kind === 'quotation' ? 'info' : 'ok'}>{f.kind === 'quotation' ? 'Pipeline' : f.kind === 'stage' ? 'Invoiced or to be' : f.kind}</Tone></td><td className="mg-num font-bold">{f.ref}</td><td>{f.client}</td><td className="num font-bold">{f.currency} {Number(f.amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}</td></tr>)}</tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

function monthName(m) {
  if (m.month === 'later') return 'Later';
  if (m.month === 'unscheduled') return 'No date yet';
  return monthLabel(m.month);
}

/** In (solid) with the pipeline hatched on top, and out beside it; figures under each month. */
function MonthChart({ rows, open, onPick }) {
  const max = Math.max(1, ...rows.map((m) => Math.max(m.inflow + m.pipeline, m.outflow)));
  const thisYear = today().slice(0, 4);
  return (
    <div className="app-cf app-panel__body" role="group" aria-label="Money in and out by month">
      {rows.map((m, i) => {
        const label = m.month === 'later' || m.month === 'unscheduled' ? monthName(m)
          : (i === 0 || m.month.slice(5) === '01' || m.month.slice(0, 4) !== thisYear && i === 0) ? monthLabel(m.month) : MONTHS[Number(m.month.slice(5)) - 1];
        return (
          <button key={m.month} type="button" className="app-cf__col" aria-pressed={open.includes(m.month)} onClick={() => onPick(m.month)}
            aria-label={`${monthName(m)}: in ${money(m.inflow)}, pipeline ${money(m.pipeline)}, out ${money(m.outflow)}, net ${money(m.net)}. ${open.includes(m.month) ? 'Lines shown' : 'Show the lines'}`}>
            <span className="app-cf__month">{label}</span>
            <span className="app-cf__plot" aria-hidden="true">
              <span className="app-cf__stack">
                {m.pipeline > 0 && <span className="mg-hatch app-cf__pipe" style={{ height: `${(100 * m.pipeline) / max}%` }} />}
                <span className="app-cf__in" style={{ height: `${(100 * m.inflow) / max}%` }} />
              </span>
              <span className="app-cf__out" style={{ height: `${(100 * m.outflow) / max}%` }} />
            </span>
            <span className="app-cf__nums mg-num">
              <b>{money(m.inflow, 'INR', { compact: true })}</b>
              <span className="is-wait-text">{m.pipeline ? `+${money(m.pipeline, 'INR', { compact: true })}` : '—'}</span>
              <span>{m.outflow ? `−${money(m.outflow, 'INR', { compact: true })}` : '—'}</span>
              <b className={m.net < 0 ? 'text-late' : 'text-ok'}>{m.net < 0 ? '−' : ''}{money(Math.abs(m.net), 'INR', { compact: true })}</b>
            </span>
          </button>
        );
      })}
      <span className="app-cf__key mg-num" aria-hidden="true"><span>In</span><span>Pipeline</span><span>Out</span><span>Net</span></span>
    </div>
  );
}

function MonthTable({ rows, open, onPick }) {
  return (
    <div className="mg-tablewrap app-panel__body">
      <table className="mg-table" aria-label="Money in and out by month">
        <thead><tr><th>Month</th><th className="num">In</th><th className="num">Pipeline on top</th><th className="num">Out</th><th className="num">Net</th><th aria-label="Lines" /></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.month} className={cn(open.includes(m.month) && 'app-open')}>
              <td className="font-bold">{monthName(m)}</td>
              <td className="num">{money(m.inflow)}</td>
              <td className="num is-wait-text">{m.pipeline ? `+${money(m.pipeline)}` : '—'}</td>
              <td className="num">{m.outflow ? `−${money(m.outflow)}` : '—'}</td>
              <td className={cn('num font-bold', m.net < 0 ? 'text-late' : 'text-ok')}>{money(m.net)}</td>
              <td><button type="button" className="mg-btn mg-btn--sm" aria-pressed={open.includes(m.month)} onClick={() => onPick(m.month)}>{open.includes(m.month) ? 'Hide lines' : 'Show lines'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MonthLines({ m, onClose }) {
  const wide = useMediaQuery('(min-width: 768px)');
  const name = monthName(m);
  const inSum = m.items.filter((i) => !OUT.has(i.field) && i.field !== 'pipeline').reduce((t, i) => t + i.amount, 0);
  const outSum = m.items.filter((i) => OUT.has(i.field)).reduce((t, i) => t + i.amount, 0);
  const pipe = m.items.filter((i) => i.field === 'pipeline').reduce((t, i) => t + i.amount, 0);
  return (
    <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby={`lines-${m.month}`}>
      <div className="app-panel__head">
        <h2 className="mg-panel__title" id={`lines-${m.month}`}>{name === 'Later' || name === 'No date yet' ? name : monthLong(m.month)}: the lines</h2>
        <Tone>{plural(m.items.length, 'line')}</Tone>
        <span className="mg-panel__hint">What makes up the month. Overdue invoices count in the current month.</span>
        <button type="button" className="mg-iconbtn ml-auto" aria-label={`Close the lines for ${name}`} onClick={onClose}><X strokeWidth={1.8} aria-hidden="true" /></button>
      </div>
      {m.items.length === 0 ? <p className="app-panel__note">Nothing expected in or out this month.</p> : !wide ? (
        <div className="mg-rows app-panel__body">
          {m.items.map((it, i) => (
            <div key={i} className="mg-row">
              <span className="mg-row__title" style={{ whiteSpace: 'normal' }}>{it.ref}</span>
              <span className={cn('mg-row__amount mg-num', it.field === 'pipeline' && 'is-wait-text')}>{OUT.has(it.field) ? '−' : ''}{money(it.amount)}</span>
              <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{[it.client, it.note, it.when ? shortDate(it.when) : null].filter(Boolean).join(' · ')}</span>
              <span className="mg-row__state"><Tone tone={TONE[it.field]}>{LABEL[it.field]}</Tone></span>
            </div>
          ))}
          <div className="mg-row"><span className="mg-row__title" style={{ whiteSpace: 'normal' }}>Net{pipe ? ', pipeline not counted' : ''}</span><span className="mg-row__amount mg-num">{money(inSum - outSum)}</span></div>
        </div>
      ) : (
        <div className="mg-tablewrap app-panel__body">
          <table className="mg-table">
            <thead><tr><th>Kind</th><th>Reference</th><th>Client / vendor</th><th>Note</th><th>When</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {m.items.map((it, i) => (
                <tr key={i}>
                  <td><Tone tone={TONE[it.field]}>{LABEL[it.field]}</Tone></td>
                  <td className="mg-num font-bold">{it.ref}</td>
                  <td>{it.client}</td>
                  <td className="text-secondary-text" style={{ whiteSpace: 'normal' }}><div style={{ minWidth: 160 }}>{it.note}</div></td>
                  <td className="whitespace-nowrap">{it.when ? shortDate(it.when) : '—'}</td>
                  <td className={cn('num font-bold', it.field === 'pipeline' && 'is-wait-text')}>{OUT.has(it.field) ? '−' : ''}{money(it.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={5} className="font-bold">Net: in {money(inSum)} minus out {money(outSum)}{pipe ? ` (pipeline ${money(pipe)} not counted)` : ''}</td><td className={cn('num font-bold', inSum - outSum < 0 ? 'text-late' : '')}>{money(inSum - outSum)}</td></tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthLabel(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '';
  const [y, m] = ym.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
function monthLong(ym) {
  const [y, m] = ym.split('-');
  return `${LONG[Number(m) - 1]} ${y}`;
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
