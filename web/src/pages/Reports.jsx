import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, ChevronDown, CircleAlert, Download, FileSpreadsheet, RefreshCw } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { AGE_TONE, ChartBlock, ColBars, Note, RowBars, inr, inrFull } from '../components/charts.jsx';
import {
  CustomersSection, DataNotes, EnquiriesSection, OutcomesSection, RevenueSection, SectorsSection, ServicesSection, SummaryStrip,
} from '../components/SalesReportSections.jsx';
import { PillSelect, SectionFailed } from '../components/insights/shared.jsx';
import { useEntrance } from '../components/daily.jsx';
import { useAuth } from '../lib/auth.jsx';
import { PRESETS, defaultGrain, localToday, presetPeriod, readReportQuery } from '../lib/reportPeriods.js';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, number, percent } from '../lib/format.js';

/**
 * Reports: six questions about a period on top (docs/sales-report-rework-
 * plan.md, components/SalesReportSections.jsx), and below them the seven
 * charts of #22 under More analysis — each with a table twin, each bar a
 * link into the list it counts.
 *
 * Every figure here is INR. A deal or an invoice in another currency is not
 * converted at a made-up rate and not silently dropped either — it is
 * counted where the number is a count, left out where the number is money,
 * and said so under the chart that leaves it out.
 *
 * The period control drives the six questions only. The charts under More
 * analysis are about now — what is open, what is owed, what is coming — and
 * keep the one horizon that genuinely changes them.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;
const presetLabel = (key) => (key === 'custom' ? 'Custom dates' : PRESETS.find((p) => p.key === key)?.label || key);
const clock = (t) => t && new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

export default function Reports() {
  const { isAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const today = localToday();
  const { from, to, grain, owner, preset } = readReportQuery(searchParams, today);
  const [custom, setCustom] = useState(preset === 'custom');
  const scope = { from, to, owner, grain };

  const query = new URLSearchParams({ from, to, ...(grain && { grain }), ...(owner && { owner }) });
  const report = useFetch(() => api.raw(`/reports/sales?${query}`), [query.toString()]);
  const users = useFetch(() => (isAdmin ? api.users.list() : Promise.resolve({ data: [] })), [isAdmin]);
  const d = report.data?.data;
  const ref = useEntrance(Boolean(d));

  // What the figures on screen are for, so "Updating" can say what it is leaving.
  const shown = useRef(null);
  const [updated, setUpdated] = useState(null);
  const current = custom || preset === 'custom' ? `${date(from)} – ${date(to)}` : presetLabel(preset);
  useEffect(() => { if (d && !report.loading) { shown.current = current; setUpdated(Date.now()); } }, [d, report.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const updating = report.loading && Boolean(d);

  /** Every control writes the address bar; the page reads it back. */
  const update = (next) => {
    const merged = { from, to, grain, owner, ...next };
    setSearchParams(Object.fromEntries(Object.entries(merged).filter(([, v]) => v)), { replace: true });
  };
  const choosePreset = (key) => {
    if (key === 'custom') { setCustom(true); return; }
    setCustom(false);
    // A new period starts at its own default grain, not the last one picked.
    update({ ...presetPeriod(key, today), grain: '' });
  };
  const ownerName = (users.data?.data || []).find((u) => String(u.id) === owner)?.name;
  const showCustom = custom || preset === 'custom';

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Reports"
        subtitle={`${date(from)} – ${date(to)} · ${ownerName ? `${ownerName}'s records` : isAdmin ? 'Everyone\'s records' : 'Your records'}. All figures in ₹ at the rate on each record's own date. Open any bar for the records behind it.`}
        actions={(
          <>
            {isAdmin && (
              <Link className="mg-btn" to="/reports/scheduled" title="The daily briefing and weekly MIS the tracker emails">
                <CalendarClock className="size-4" strokeWidth={1.8} aria-hidden="true" />Scheduled reports
              </Link>
            )}
            <a
              className="mg-btn mg-btn--primary"
              href={api.reportPdfUrl({ from, to, ...(grain && { grain }), ...(owner && { owner }) })}
              download
              title="These six questions for this period, as a PDF"
            >
              <Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Download PDF
            </a>
          </>
        )}
      />
      <div className="app-page" ref={ref}>
        <section className="mg-glass rp-filters" data-a="rise" aria-label="Report filters">
          <div className="rp-sel">
            <label className="rp-ctl" htmlFor="r-period">Period</label>
            <span className="mg-select-wrap">
              <select className="mg-select" id="r-period" value={showCustom ? 'custom' : preset} onChange={(e) => choosePreset(e.target.value)}>
                {PRESETS.map((p) => <option key={p.key} value={p.key}>{presetLabel(p.key)}</option>)}
              </select>
            </span>
          </div>
          {showCustom && (
            <>
              <div className="rp-sel">
                <label className="rp-ctl" htmlFor="r-from">From</label>
                <input className="mg-input" id="r-from" type="date" value={from} max={to} onChange={(e) => e.target.value && update({ from: e.target.value, grain: '' })} />
              </div>
              <div className="rp-sel">
                <label className="rp-ctl" htmlFor="r-to">To</label>
                <input className="mg-input" id="r-to" type="date" value={to} min={from} onChange={(e) => e.target.value && update({ to: e.target.value, grain: '' })} />
              </div>
            </>
          )}
          {isAdmin && (
            <PillSelect
              id="r-owner"
              label="Owner"
              value={owner}
              onChange={(v) => update({ owner: v })}
              options={[{ value: '', label: 'Everyone' }, ...(users.data?.data || []).map((u) => ({ value: String(u.id), label: u.name }))]}
            />
          )}
          <span className="rp-ctl rp-filters__status" role="status">{updating || (report.loading && !d) ? 'Fetching new figures' : updated ? `Updated ${clock(updated)}` : ''}</span>
          <button type="button" className="mg-btn mg-btn--sm" onClick={report.refetch} disabled={report.loading}>
            <RefreshCw className={`size-4 ${report.loading ? 'animate-spin' : ''}`} strokeWidth={1.8} aria-hidden="true" />{report.loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </section>

        {updating && shown.current && shown.current !== current && (
          <div className="mg-banner mg-glass" role="status">
            <RefreshCw className="animate-spin" aria-hidden="true" />
            <div className="mg-banner__body"><strong>Updating to {current}</strong>The figures below are still {shown.current} until the new ones arrive.</div>
          </div>
        )}

        {report.error && !d ? (
          <section className="mg-glass mg-empty" data-a="rise" role="alert" style={{ padding: '64px 24px' }}>
            <span className="mg-empty__mark" style={{ color: 'var(--late)', background: 'var(--late-soft)' }}><CircleAlert className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
            <h2 className="mg-empty__title">Couldn't load the report</h2>
            <p className="mg-empty__text">{report.error} Nothing has changed in your records; try again.</p>
            <button type="button" className="mg-btn mg-btn--sm" onClick={report.refetch}><RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Try again</button>
          </section>
        ) : !d ? (
          <div className="flex flex-col gap-[18px]" aria-busy="true" aria-label="Loading the report">
            <section className="mg-glass mg-panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 26 }}>
              {[0, 1, 2, 3].map((i) => <div key={i} className="mg-skel" style={{ height: 70 }} />)}
            </section>
            <div className="rp-grid">
              {[0, 1, 2, 3].map((i) => (
                <section key={i} className="mg-glass rp-q"><div className="mg-skel" style={{ height: 20, width: '60%' }} /><div className="mg-skel" style={{ height: 14, width: '80%' }} /><div className="mg-skel" style={{ height: 200 }} /></section>
              ))}
            </div>
          </div>
        ) : (
          <>
            <SummaryStrip report={d} scope={scope} />
            <DataNotes notes={d.notes} staleRates={d.stale_rates} />
            <div className="rp-grid">
              <EnquiriesSection report={d} scope={scope} onGrain={(g) => update({ grain: g === defaultGrain(from, to) ? '' : g })} />
              <OutcomesSection report={d} scope={scope} />
              <SectorsSection report={d} scope={scope} />
              <ServicesSection report={d} scope={scope} />
              <CustomersSection report={d} scope={scope} />
              <RevenueSection report={d} scope={scope} />
            </div>
          </>
        )}
        <MoreAnalysis from={from} to={to} owner={owner} isAdmin={isAdmin} />
      </div>
    </>
  );
}

/**
 * The charts Reports had before the six questions (#22): pipeline, ageing,
 * cash, win rate and conversion. They answer "where do things stand now",
 * not "what happened in the period", so they keep their own two controls
 * and sit below, folded until opened.
 */
function MoreAnalysis({ from, to, owner, isAdmin }) {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="more-t" className="flex flex-col gap-[18px]">
      <button type="button" className="mg-glass rp-fold" data-a="rise" aria-expanded={open} aria-controls="more-body" onClick={() => setOpen(!open)}>
        <span className="rp-fold__icon" aria-hidden="true"><ChevronDown className="size-[18px]" strokeWidth={1.8} /></span>
        <span className="min-w-0">
          <span className="rp-fold__t" id="more-t">More analysis</span>
          <span className="rp-fold__s">Pipeline · collections ageing · cash expected · win rate by quarter · quoted against won · win rate by owner · open deals by status</span>
        </span>
        <span className="mg-badge" style={{ marginLeft: 'auto' }}>7 charts</span>
      </button>
      {open && (
        <div id="more-body" className="flex flex-col gap-[18px]">
          <AnalysisCharts isAdmin={isAdmin} />
          <DetailedDownloads from={from} to={to} owner={owner} />
        </div>
      )}
    </section>
  );
}

/**
 * The detailed tables the old Sales reports page offered, as CSVs for the
 * period and owner above. The six questions replaced that page; these
 * answer the questions it asked that they do not.
 */
const DETAILED_CSVS = [
  ['sectors', 'Sector funnel: enquiries, quoted, lost and win rate'],
  ['customers', 'Clients: repeat or single, deals to date'],
  ['fx', 'Deals in another currency, and the rates used'],
  ['orders', 'Order intake per month'],
  ['invoicing', 'Invoicing and collections per month'],
  ['payment-status', 'POs by payment status'],
  ['overdue', 'Overdue invoices by client'],
];

function DetailedDownloads({ from, to, owner }) {
  return (
    <section className="mg-glass rp-q" aria-labelledby="dl-t">
      <div className="rp-bhead">
        <h2 className="rp-btitle" id="dl-t">Detailed tables for {date(from)} – {date(to)}</h2>
        <span className="mg-panel__hint">Each downloads a CSV for this period and owner</span>
      </div>
      <ul className="rp-dl">
        {DETAILED_CSVS.map(([name, label]) => (
          <li key={name}>
            <a href={api.reportCsvUrl(name, { from, to, ...(owner && { owner }) })} download>
              <FileSpreadsheet className="size-4" strokeWidth={1.8} aria-hidden="true" />{label}<span>CSV</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AnalysisCharts({ isAdmin }) {
  const [horizon, setHorizon] = useState('6');
  const [dimension, setDimension] = useState('owner');

  const pipeline = useFetch(() => api.raw('/pipeline'), []);
  const collections = useFetch(() => api.raw('/collections'), []);
  const cashflow = useFetch(() => api.raw(`/cashflow?months=${horizon}`), [horizon]);
  const winRate = useFetch(() => api.raw('/reports/win-rate?quarters=5'), []);
  const conversion = useFetch(() => api.raw(`/reports/conversion?by=${dimension}`), [dimension]);
  const quotedWon = useFetch(() => api.raw(`/reports/quoted-won?months=${horizon}`), [horizon]);
  const byStatus = useFetch(() => api.raw('/reports/by-status'), []);

  return (
    <>
      {/* Two controls, and each one genuinely reframes a chart: the
          horizon moves the cash bands and the months on quoted-vs-won,
          the dimension regroups the win-rate bars. */}
      <div className="rp-morebar">
        <PillSelect id="m-months" label="Months shown" value={horizon} onChange={setHorizon} options={['3', '6', '12'].map((h) => ({ value: h, label: h }))} />
        <span className="rp-note">
          Changes Cash expected and Quoted against won.{' '}
          {isAdmin ? 'These charts show everyone\'s records: the owner above does not apply here.' : 'Your deals only, except Cash expected, which is the whole company\'s.'}
        </span>
      </div>
      <div className="rp-grid">
        <Card state={pipeline}><PipelineChart state={pipeline} /></Card>
        <Card state={collections}><AgeingChart state={collections} /></Card>
        <Card state={cashflow}><CashChart state={cashflow} horizon={horizon} /></Card>
        <Card state={winRate}><WinRateChart state={winRate} /></Card>
        <Card state={quotedWon}><QuotedWonChart state={quotedWon} horizon={horizon} /></Card>
        <Card state={conversion}><ConversionChart state={conversion} dimension={dimension} onDimension={setDimension} /></Card>
        <Card state={byStatus} wide><StatusChart state={byStatus} /></Card>
      </div>
    </>
  );
}

/** One More-analysis chart in its own panel, with its own loading and failed state (H-1). */
function Card({ state, wide, children }) {
  const d = state.data?.data;
  return (
    <section className={`mg-glass rp-q rp-card${wide ? ' rp-full' : ''}`} data-a="rise" aria-busy={state.loading && !d ? true : undefined}>
      {state.error && !d ? (
        <SectionFailed message={`${state.error}.`} onRetry={state.refetch} />
      ) : state.loading && !d ? (
        <>
          <div className="mg-skel" style={{ height: 18, width: '50%' }} />
          <div className="mg-skel" style={{ height: 12, width: '75%' }} />
          {[80, 60, 70, 40, 55].map((w) => <div key={w} className="mg-skel" style={{ height: 22, width: `${w}%` }} />)}
        </>
      ) : children}
    </section>
  );
}

/* ---------------------------------------------------------------- pipeline */

function PipelineChart({ state }) {
  const d = state.data?.data;
  const rows = (d?.stages || []).filter((s) => s.type === 'open' || s.type === 'paused');
  const weighted = rows.reduce((sum, s) => sum + Number(s.weighted || 0), 0);
  const gross = rows.reduce((sum, s) => sum + Number(s.value || 0), 0);
  return (
    <ChartBlock
      title="Pipeline by stage"
      meta="Open deals, weighted by the stage's own probability"
      legend={[{ tone: 'hatch', label: 'Weighted value: expected, not yet won' }]}
      columns={['Stage', 'Deals', 'Chance', 'Weighted', 'Gross']}
      rows={rows.map((s) => ({ key: s.id, href: `/quotations?stage_id=${s.id}`, cells: [s.name, number(s.count), `${s.probability}%`, inrFull(s.weighted), inrFull(s.value)] }))}
      empty={rows.some((s) => s.count) ? null : 'No open deals just now.'}
      emptyPlain
      note={<Note>{`Weighted total ${inrFull(weighted)} of ${inrFull(gross)} gross. Deals quoted in another currency are counted but not summed.`}</Note>}
    >
      <RowBars
        label="Pipeline by stage: open a stage for its deals"
        lw={110}
        vw={84}
        format={inr}
        rows={rows.map((s) => ({
          key: s.id,
          label: s.name,
          href: `/quotations?stage_id=${s.id}`,
          aria: `${s.name}: ${plural(s.count, 'deal')} at ${s.probability}%, ${inrFull(s.weighted)} weighted of ${inrFull(s.value)}. Open the list`,
          value: inr(s.weighted),
          segs: [{ v: s.weighted, tone: 'hatch' }],
        }))}
      />
    </ChartBlock>
  );
}

/* ---------------------------------------------------------------- ageing */

function AgeingChart({ state }) {
  const d = state.data?.data;
  const rows = useMemo(() => {
    if (!d) return [];
    const counts = Object.fromEntries(d.buckets.map((b) => [b.key, 0]));
    for (const client of d.clients) for (const stage of client.stages) counts[stage.bucket] = (counts[stage.bucket] || 0) + 1;
    return d.buckets.map((b) => ({ ...b, amount: d.totals.buckets[b.key] || 0, invoices: counts[b.key] || 0 }));
  }, [d]);
  return (
    <ChartBlock
      title="Collections ageing"
      meta="Invoiced and not yet paid, by how late it is"
      legend={[{ tone: 'info', label: 'Not yet due' }, { tone: 'wait', label: '1–60 days late' }, { tone: 'late', label: 'Over 60 days late' }]}
      columns={['Age', 'Invoices', 'Outstanding']}
      rows={rows.map((b) => ({ key: b.key, href: `/collections?bucket=${encodeURIComponent(b.key)}`, cells: [b.label, number(b.invoices), inrFull(b.amount)] }))}
      note={<Note>{`Each band opens the chase queue filtered to it. Red is used only for money that is properly late.${d?.foreign?.length ? ` ${plural(d.foreign.length, 'invoice')} in another currency ${d.foreign.length === 1 ? 'is' : 'are'} not in these totals.` : ''}`}</Note>}
    >
      <RowBars
        label="Collections ageing: open a band for its chase queue"
        lw={96}
        vw={92}
        format={inr}
        rows={rows.map((b) => ({
          key: b.key,
          label: b.label,
          href: `/collections?bucket=${encodeURIComponent(b.key)}`,
          aria: `${b.label}: ${plural(b.invoices, 'invoice')}, ${inrFull(b.amount)}. Open the chase queue`,
          value: inrFull(b.amount),
          segs: [{ v: b.amount, tone: AGE_TONE[b.key] || 'info' }],
        }))}
      />
    </ChartBlock>
  );
}

/* ---------------------------------------------------------------- cash */

function CashChart({ state, horizon }) {
  const d = state.data?.data;
  // Only the dated months: "later" and "no date yet" are real, and they are
  // on the Cash-flow page, but a column with no month on the axis is not a
  // month and would read as one.
  const rows = (d?.months || []).filter((m) => /^\d{4}-\d{2}$/.test(m.month)).map((m) => ({ ...m, label: monthLabel(m.month) }));
  const firm = (m) => Number(m.received) + Number(m.invoiced) + Number(m.scheduled);
  return (
    <ChartBlock
      title={`Cash expected, next ${horizon} months`}
      meta="From stage due dates and the triggers on stages not yet invoiced"
      legend={[{ tone: 'figure', label: 'Received' }, { tone: 'wait', label: 'Invoiced, due' }, { tone: 'hatch', label: 'Not yet invoiced (forecast)' }]}
      columns={['Month', 'Received', 'Invoiced, due', 'Not yet invoiced', 'Total']}
      rows={rows.map((m) => ({ key: m.month, href: `/cashflow?month=${m.month}`, cells: [m.label, inrFull(m.received), inrFull(m.invoiced), inrFull(m.scheduled), inrFull(firm(m))] }))}
      empty={rows.some((m) => firm(m)) ? null : 'Nothing is due or scheduled in these months.'}
      emptyPlain
      note={<Note>Hatched is what becomes billable if deliveries land on their planned dates: a forecast, and labelled as one. The weighted pipeline is not in these columns; it is on the <Link to="/cashflow">Cash flow</Link> page.</Note>}
    >
      <ColBars
        label="Cash expected: open a month in cash flow"
        height={150}
        format={inr}
        rows={rows.map((m) => ({
          key: m.month,
          label: m.label,
          href: `/cashflow?month=${m.month}`,
          aria: `${m.label}: ${inrFull(firm(m))} (received ${inrFull(m.received)}, invoiced ${inrFull(m.invoiced)}, not yet invoiced ${inrFull(m.scheduled)}). Open cash flow`,
          value: inr(firm(m)),
          segs: [{ v: m.received, tone: 'figure' }, { v: m.invoiced, tone: 'wait' }, { v: m.scheduled, tone: 'hatch' }],
        }))}
      />
    </ChartBlock>
  );
}

/* ---------------------------------------------------------------- win rate */

function WinRateChart({ state }) {
  const d = state.data?.data;
  const rows = d?.quarters || [];
  return (
    <ChartBlock
      title="Win rate by quarter"
      meta="Deals closed, won ÷ (won + lost)"
      legend={[{ tone: 'figure', label: 'This quarter, so far' }, { tone: 'soft', label: 'Earlier quarters' }]}
      columns={['Quarter', 'Won', 'Lost', 'Win rate']}
      rows={rows.map((q) => ({ key: q.key, cells: [q.label, number(q.won), number(q.lost), q.win_rate === null ? 'nothing closed' : percent(q.win_rate)] }))}
      empty={rows.some((q) => q.won || q.lost) ? null : 'No deal was won or lost in these quarters, so there is no rate yet.'}
      emptyPlain
      note={<Note>{`Bars, not a line: five points is too few for a trend to be honest. A summary only, so the bars don't open a list.${d?.foreign ? ` ${plural(d.foreign, 'closed deal')} quoted in another currency count here but not in any rupee total.` : ''}`}</Note>}
    >
      {/* No bar and no percentage for a quarter that closed nothing: "0%" would read as "we lost them all". */}
      <ColBars
        label="Win rate by quarter"
        height={150}
        integer={false}
        format={(v) => `${Math.round(v * 100)}%`}
        rows={rows.map((q) => ({
          key: q.key,
          label: q.label,
          aria: `${q.label}: ${q.win_rate === null ? 'nothing closed' : `${percent(q.win_rate)}, ${number(q.won)} won, ${number(q.lost)} lost`}`,
          value: q.win_rate === null ? 'none closed' : percent(q.win_rate),
          segs: [{ v: q.win_rate === null ? 0 : q.win_rate, tone: q.current ? 'figure' : 'soft' }],
        }))}
      />
    </ChartBlock>
  );
}

/* ------------------------------------------------- quoted against won */

/**
 * Two series, because the gap between them is the finding: a month where
 * quoting held and winning fell is a problem, and one bar cannot say which.
 */
function QuotedWonChart({ state, horizon }) {
  const d = state.data?.data;
  const rows = (d?.months || []).map((m) => ({ ...m, label: monthLabel(m.month) }));
  const quoted = rows.reduce((sum, m) => sum + Number(m.quoted || 0), 0);
  const won = rows.reduce((sum, m) => sum + Number(m.won || 0), 0);
  return (
    <ChartBlock
      title="Quoted against won"
      meta={`The last ${horizon} months · quoted in the lighter bar, won in the darker`}
      legend={[{ tone: 'soft', label: 'Quoted' }, { tone: 'figure', label: 'Won' }]}
      columns={['Month', 'Deals', 'Quoted', 'Won', 'Share won']}
      rows={rows.map((m) => ({ key: m.month, href: `/quotations?month=${m.month}`, cells: [m.label, number(m.deals), inrFull(m.quoted), inrFull(m.won), m.quoted > 0 ? percent(m.won / m.quoted) : '—'] }))}
      empty={quoted || won ? null : 'Nothing was quoted in these months.'}
      emptyPlain
      note={<Note>{`${inrFull(won)} won of ${inrFull(quoted)} quoted over the period. Labels above each pair are the quoted value.${d?.foreign ? ` ${number(d.foreign)} quoted in another currency are counted but not summed.` : ''}`}</Note>}
    >
      <ColBars
        label="Quoted against won: open a month for its quotations"
        height={150}
        format={inr}
        rows={rows.map((m) => ({
          key: m.month,
          label: m.label,
          href: `/quotations?month=${m.month}`,
          aria: `${m.label}: ${inrFull(m.quoted)} quoted, ${inrFull(m.won)} won. Open the list`,
          value: inr(m.quoted),
          bars: [[{ v: m.quoted, tone: 'soft' }], [{ v: m.won, tone: 'figure' }]],
        }))}
      />
    </ChartBlock>
  );
}

/* ------------------------------------------------------- win rate by X */

/**
 * The quarterly rate says whether the team is improving. This says where it
 * is already winning, which is the question asked before deciding what to
 * chase next.
 */
function ConversionChart({ state, dimension, onDimension }) {
  const d = state.data?.data;
  const rows = d?.groups || [];
  return (
    <ChartBlock
      title={`Win rate by ${d?.label?.toLowerCase() || dimension}`}
      meta="Decided deals only: won over won plus lost"
      tools={(
        <PillSelect id="m-dim" label="Group by" value={dimension} onChange={onDimension}
          options={[{ value: 'owner', label: 'Owner' }, { value: 'sector', label: 'Sector' }, { value: 'service', label: 'Service' }]}
        />
      )}
      columns={[d?.label || 'Owner', 'Won', 'Lost', 'Win rate']}
      rows={rows.map((g) => ({ key: g.key, cells: [g.key, number(g.won), number(g.lost), g.win_rate === null ? '—' : percent(g.win_rate)] }))}
      empty={rows.some((g) => g.won || g.lost) ? null : 'No deal has been won or lost yet, so there is no rate to compare.'}
      emptyPlain
      note={<Note>A rate is a count, so a deal in any currency counts in it. A summary only, so the bars don't open a list.</Note>}
    >
      <RowBars
        label={`Win rate by ${d?.label?.toLowerCase() || dimension}`}
        lw={110}
        vw={120}
        max={1}
        integer={false}
        format={(v) => `${Math.round(v * 100)}%`}
        rows={rows.map((g) => ({
          key: g.key,
          label: g.key,
          aria: `${g.key}: ${g.win_rate === null ? 'nothing decided' : `${percent(g.win_rate)}, ${number(g.won)} won, ${number(g.lost)} lost`}`,
          value: g.win_rate === null ? '—' : `${percent(g.win_rate)} · ${number(g.won)} won, ${number(g.lost)} lost`,
          segs: [{ v: g.win_rate ?? 0, tone: 'figure' }],
        }))}
      />
    </ChartBlock>
  );
}

/* --------------------------------------------------- open deals by status */

/**
 * The pipeline chart is by stage — where the team moved a deal to. This is
 * by status, which is what the record says it is. They drift, and a deal
 * parked at On Hold is invisible on a board that only shows progress.
 */
function StatusChart({ state }) {
  const d = state.data?.data;
  const rows = d?.statuses || [];
  const total = rows.reduce((sum, r) => sum + Number(r.deals || 0), 0);
  return (
    <ChartBlock
      title="Open deals by status"
      meta="What each record says it is, which is not always where its stage puts it"
      columns={['Status', 'Deals', 'Value']}
      rows={rows.map((r) => ({ key: r.status, href: `/quotations?status=${encodeURIComponent(r.status)}`, cells: [r.status, number(r.deals), inrFull(r.value)] }))}
      empty={total ? null : 'No open deals just now.'}
      emptyPlain
      note={<Note>{`${plural(total, 'open deal')}.${d?.foreign ? ` ${number(d.foreign)} quoted in another currency are counted but not summed.` : ''}`}</Note>}
    >
      <RowBars
        label="Open deals by status: open a status for its deals"
        lw={140}
        vw={96}
        rows={rows.map((r) => ({
          key: r.status,
          label: r.status,
          href: `/quotations?status=${encodeURIComponent(r.status)}`,
          aria: `${r.status}: ${plural(r.deals, 'deal')}, ${inrFull(r.value)}. Open the list`,
          value: `${number(r.deals)} · ${inr(r.value)}`,
          segs: [{ v: r.deals, tone: 'figure' }],
        }))}
      />
    </ChartBlock>
  );
}
