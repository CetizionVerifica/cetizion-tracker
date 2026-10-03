import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { PageHeader } from '../App.jsx';
import { AGE_COLOUR, AXIS, BAR, BAR_LABEL, CASH_BANDS, ChartCard, ChartTip, GRID, HOVER, ROW_CHART, ZERO_BAR } from '../components/charts.jsx';
import { ChartContainer, ChartTooltip } from '../components/ui/chart.tsx';
import { Alert, Input, Select } from '../components/ui.jsx';
import {
  CustomersSection, DataNotes, EnquiriesSection, OutcomesSection, RevenueSection, SectorsSection, ServicesSection, SummaryStrip,
} from '../components/SalesReportSections.jsx';
import { useAuth } from '../lib/auth.jsx';
import { PRESETS, defaultGrain, localToday, presetPeriod, readReportQuery } from '../lib/reportPeriods.js';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { date, money, number, percent } from '../lib/format.js';

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
const inr = (value) => money(value, 'INR', { compact: true });

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

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`${date(from)} – ${date(to)} · All figures in ₹ at the rate on each record's own date. Every bar opens the records behind it.`}
        actions={(
          <>
            <Select
              value={custom ? 'custom' : preset}
              placeholder={null}
              aria-label="Period"
              options={PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(e) => choosePreset(e.target.value)}
            />
            {(custom || preset === 'custom') && (
              <>
                <Input type="date" aria-label="From" value={from} max={to} onChange={(e) => e.target.value && update({ from: e.target.value, grain: '' })} />
                <Input type="date" aria-label="To" value={to} min={from} onChange={(e) => e.target.value && update({ to: e.target.value, grain: '' })} />
              </>
            )}
            <Select
              value={grain || d?.grain || defaultGrain(from, to)}
              placeholder={null}
              aria-label="Group enquiries by"
              options={[{ value: 'day', label: 'Group by: day' }, { value: 'week', label: 'Group by: week' }, { value: 'month', label: 'Group by: month' }]}
              onChange={(e) => update({ grain: e.target.value === defaultGrain(from, to) ? '' : e.target.value })}
            />
            {isAdmin && (
              <Select
                value={owner}
                placeholder="Owner: everyone"
                aria-label="Owner"
                options={(users.data?.data || []).map((u) => ({ value: String(u.id), label: `Owner: ${u.name}` }))}
                onChange={(e) => update({ owner: e.target.value })}
              />
            )}
            <a
              className="btn"
              href={api.reportPdfUrl({ from, to, ...(grain && { grain }), ...(owner && { owner }) })}
              download
              title="These six questions for this period, as a PDF"
            >
              Download PDF
            </a>
            {isAdmin && <Link className="btn" to="/reports/scheduled" title="The daily briefing and weekly MIS the tracker emails">Scheduled reports</Link>}
          </>
        )}
      />
      <div className="page stack">
        {report.error && <Alert tone="danger"><span>{report.error}</span></Alert>}
        {report.loading && !d && <Loading height={480} />}
        {d && (
          <>
            <SummaryStrip report={d} scope={scope} />
            <DataNotes notes={d.notes} staleRates={d.stale_rates} />
            <div className="@container">
              <div className="grid gap-6 @3xl:grid-cols-2">
                <EnquiriesSection report={d} scope={scope} />
                <OutcomesSection report={d} scope={scope} />
                <SectorsSection report={d} scope={scope} />
                <ServicesSection report={d} scope={scope} />
                <CustomersSection report={d} scope={scope} />
                <RevenueSection report={d} scope={scope} />
              </div>
            </div>
          </>
        )}
        <MoreAnalysis from={from} to={to} owner={owner} />
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
function MoreAnalysis({ from, to, owner }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer py-2 text-[15px] font-semibold text-foreground">
        More analysis: pipeline, ageing, cash, win rate
      </summary>
      {open && <AnalysisCharts />}
      {open && <DetailedDownloads from={from} to={to} owner={owner} />}
    </details>
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
    <div className="mt-4 rounded-[10px] border border-border px-4 py-3 text-[13px]">
      <div className="font-medium text-foreground">Detailed tables for {date(from)} – {date(to)}</div>
      <ul className="mt-1.5 grid gap-1 @3xl:grid-cols-2">
        {DETAILED_CSVS.map(([name, label]) => (
          <li key={name}><a href={api.reportCsvUrl(name, { from, to, ...(owner && { owner }) })} download>{label} (CSV)</a></li>
        ))}
      </ul>
    </div>
  );
}

function AnalysisCharts() {
  const navigate = useNavigate();
  const [horizon, setHorizon] = useState('6');
  const [dimension, setDimension] = useState('owner');

  const pipeline = useFetch(() => api.raw('/pipeline'), []);
  const collections = useFetch(() => api.raw('/collections'), []);
  const cashflow = useFetch(() => api.raw(`/cashflow?months=${horizon}`), [horizon]);
  const winRate = useFetch(() => api.raw('/reports/win-rate?quarters=5'), []);
  const conversion = useFetch(() => api.raw(`/reports/conversion?by=${dimension}`), [dimension]);
  const quotedWon = useFetch(() => api.raw(`/reports/quoted-won?months=${horizon}`), [horizon]);
  const byStatus = useFetch(() => api.raw('/reports/by-status'), []);

  const errors = [pipeline.error, collections.error, cashflow.error, winRate.error, conversion.error, quotedWon.error, byStatus.error].filter(Boolean);

  return (
    <div className="stack mt-3">
      {/* Two controls, and each one genuinely reframes a chart: the
          horizon moves the cash bands and the months on quoted-vs-won,
          the dimension regroups the win-rate bars. */}
      <div className="flex flex-wrap gap-2">
        <Select
          className="w-auto"
          value={horizon}
          placeholder={null}
          aria-label="Months shown"
          options={[{ value: '3', label: 'Months: 3' }, { value: '6', label: 'Months: 6' }, { value: '12', label: 'Months: 12' }]}
          onChange={(e) => setHorizon(e.target.value)}
        />
        <Select
          className="w-auto"
          value={dimension}
          placeholder={null}
          aria-label="Win rate grouped by"
          options={[{ value: 'owner', label: 'Win rate by: owner' }, { value: 'sector', label: 'Win rate by: sector' }, { value: 'service', label: 'Win rate by: service' }]}
          onChange={(e) => setDimension(e.target.value)}
        />
      </div>
      {errors.map((message, i) => <Alert key={i} tone="danger"><span>{message}</span></Alert>)}

      {/* Two columns when the page itself is wide enough for them, not when
          the window is. The container has to be an ancestor of the thing
          that queries it: both classes on one element is a query against
          nothing. */}
      <div className="@container">
        <div className="grid gap-4 @3xl:grid-cols-2">
          <PipelineChart state={pipeline} onOpen={(stageId) => navigate(`/quotations?stage_id=${stageId}`)} />
          <AgeingChart state={collections} onOpen={(bucket) => navigate(`/collections?bucket=${encodeURIComponent(bucket)}`)} />
          <CashChart state={cashflow} horizon={horizon} onOpen={(month) => navigate(`/cashflow?month=${month}`)} />
          <WinRateChart state={winRate} />
          <QuotedWonChart state={quotedWon} horizon={horizon} onOpen={(month) => navigate(`/quotations?month=${month}`)} />
          <ConversionChart state={conversion} />
          <StatusChart state={byStatus} onOpen={(status) => navigate(`/quotations?status=${encodeURIComponent(status)}`)} />
        </div>
      </div>
    </div>
  );
}

function Loading({ height }) {
  return <Skeleton style={{ height }} className="w-full" />;
}

/* ---------------------------------------------------------------- pipeline */

function PipelineChart({ state, onOpen }) {
  const d = state.data?.data;
  const stages = (d?.stages || []).filter((s) => s.type === 'open' || s.type === 'paused');
  const rows = stages.map((s) => ({ ...s, label: s.name }));
  const weighted = rows.reduce((sum, s) => sum + Number(s.weighted || 0), 0);
  const gross = rows.reduce((sum, s) => sum + Number(s.value || 0), 0);

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title="Pipeline by stage"
      meta="Open deals, weighted by the stage's own probability"
      height={ROW_CHART(rows.length)}
      columns={['Stage', 'Deals', 'Chance', 'Weighted', 'Gross']}
      rows={rows.map((s) => ({
        key: s.id,
        href: `/quotations?stage_id=${s.id}`,
        cells: [s.name, number(s.count), `${s.probability}%`, inr(s.weighted), inr(s.value)],
      }))}
      footnote={`Weighted total ${inr(weighted)} of ${inr(gross)} gross. Deals quoted in another currency are counted but not summed.`}
    >
      <ChartContainer
        config={Object.fromEntries(rows.map((s) => [`stage-${s.id}`, { label: s.name }]))}
        className="h-full w-full aspect-auto"
      >
        <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" dataKey="weighted" {...AXIS} tickFormatter={inr} />
          <YAxis type="category" dataKey="label" width={116} {...AXIS} />
          <ChartTooltip cursor={HOVER} content={<ChartTip format={inr} names={{ weighted: 'weighted' }} />} />
          <Bar dataKey="weighted" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--primary)" cursor="pointer" onClick={(bar) => bar?.payload && onOpen(bar.payload.id)}>
            <LabelList dataKey="weighted" position="right" formatter={inr} {...BAR_LABEL} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------- ageing */

function AgeingChart({ state, onOpen }) {
  const d = state.data?.data;
  const rows = useMemo(() => {
    if (!d) return [];
    const counts = Object.fromEntries(d.buckets.map((b) => [b.key, 0]));
    for (const client of d.clients) for (const stage of client.stages) counts[stage.bucket] = (counts[stage.bucket] || 0) + 1;
    return d.buckets.map((b) => ({ ...b, amount: d.totals.buckets[b.key] || 0, invoices: counts[b.key] || 0 }));
  }, [d]);

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title="Collections ageing"
      meta="Invoiced and not yet paid, by how late it is"
      height={ROW_CHART(rows.length)}
      columns={['Age', 'Invoices', 'Outstanding']}
      rows={rows.map((b) => ({
        key: b.key,
        href: `/collections?bucket=${encodeURIComponent(b.key)}`,
        cells: [b.label, number(b.invoices), inr(b.amount)],
      }))}
      footnote={`Each band opens the chase queue filtered to it. Red is used only for money that is properly late.${d?.foreign?.length ? ` ${d.foreign.length} invoice${d.foreign.length === 1 ? '' : 's'} in another currency ${d.foreign.length === 1 ? 'is' : 'are'} not in these totals.` : ''}`}
    >
      <ChartContainer config={{ amount: { label: 'Outstanding' } }} className="h-full w-full aspect-auto">
        <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" dataKey="amount" {...AXIS} tickFormatter={inr} />
          <YAxis type="category" dataKey="label" width={116} {...AXIS} />
          <ChartTooltip cursor={HOVER} content={<ChartTip format={inr} names={{ amount: 'outstanding' }} />} />
          <Bar dataKey="amount" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} cursor="pointer" onClick={(bar) => bar?.payload && onOpen(bar.payload.key)}>
            {rows.map((b) => <Cell key={b.key} fill={AGE_COLOUR[b.key] || 'var(--forecast)'} />)}
            <LabelList dataKey="amount" position="right" formatter={inr} {...BAR_LABEL} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------- cash */

function CashChart({ state, horizon, onOpen }) {
  const d = state.data?.data;
  // Only the dated months: "later" and "no date yet" are real, and they are
  // on the Cash-flow page, but a column with no month on the axis is not a
  // month and would read as one.
  const rows = (d?.months || []).filter((m) => /^\d{4}-\d{2}$/.test(m.month)).map((m) => ({ ...m, label: monthLabel(m.month) }));

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title={`Cash expected, next ${horizon} months`}
      meta="From stage due dates and the triggers on stages not yet invoiced"
      height={260}
      columns={['Month', 'Received', 'Invoiced, due', 'Not yet invoiced', 'Total']}
      rows={rows.map((m) => ({
        key: m.month,
        href: `/cashflow?month=${m.month}`,
        cells: [m.label, inr(m.received), inr(m.invoiced), inr(m.scheduled), inr(m.received + m.invoiced + m.scheduled)],
      }))}
      footnote="Grey is what becomes billable if deliveries land on their planned dates — a forecast, and labelled as one. The weighted pipeline is not in these columns; it is on the Cash-flow page."
    >
      <ChartContainer
        config={Object.fromEntries(CASH_BANDS.map((b) => [b.key, { label: b.label, color: b.colour }]))}
        className="h-full w-full aspect-auto"
      >
        <BarChart data={rows} margin={{ left: 0, right: 4, top: 16, bottom: 4 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={0} />
          <YAxis {...AXIS} width={56} tickFormatter={inr} />
          <ChartTooltip
            cursor={HOVER}
            content={<ChartTip format={inr} names={Object.fromEntries(CASH_BANDS.map((b) => [b.key, b.label.toLowerCase()]))} />}
          />
          {CASH_BANDS.map((band, i) => (
            <Bar
              key={band.key}
              dataKey={band.key}
              stackId="cash"
              fill={band.colour}
              maxBarSize={BAR.size}
              // Only the top band is rounded: a stack is one bar, so the
              // corners belong to the column, not to each band in it.
              radius={i === CASH_BANDS.length - 1 ? BAR.up : 0}
              // The top band carries the month's total, so it keeps a
              // sliver even at zero — otherwise an empty month is a gap
              // with no number, which reads as missing rather than nil.
              minPointSize={i === CASH_BANDS.length - 1 ? ZERO_BAR : 0}
              cursor="pointer"
              onClick={(bar) => bar?.payload && onOpen(bar.payload.month)}
            >
              {i === CASH_BANDS.length - 1 && (
                <LabelList
                  position="top"
                  {...BAR_LABEL}
                  valueAccessor={(entry) => inr(entry.payload.received + entry.payload.invoiced + entry.payload.scheduled)}
                />
              )}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* ---------------------------------------------------------------- win rate */

function WinRateChart({ state }) {
  const d = state.data?.data;
  const rows = (d?.quarters || []).map((q) => ({ ...q, rate: q.win_rate === null ? 0 : Math.round(q.win_rate * 100) }));

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title="Win rate by quarter"
      meta="Deals closed, won ÷ (won + lost)"
      height={260}
      columns={['Quarter', 'Won', 'Lost', 'Win rate']}
      rows={rows.map((q) => ({
        key: q.key,
        cells: [q.label, number(q.won), number(q.lost), q.win_rate === null ? 'nothing closed' : percent(q.win_rate)],
      }))}
      footnote={`Bars, not a line — five points is too few for a trend to be honest. The current quarter is the only coloured one.${d?.foreign ? ` ${d.foreign} closed deal${d.foreign === 1 ? '' : 's'} quoted in another currency count here but not in any rupee total.` : ''}`}
    >
      <ChartContainer config={{ rate: { label: 'Win rate' } }} className="h-full w-full aspect-auto">
        <BarChart data={rows} margin={{ left: 0, right: 4, top: 16, bottom: 4 }}>
          <CartesianGrid {...GRID} vertical={false} />
          {/* No interval={0} here. sales-tracker forces every tick because its
              labels are three characters; "Q2 FY25-26" is ten, and forcing
              them made five quarters run into one another at sidebar width.
              Letting Recharts drop every other label is the honest fallback:
              a tick it cannot fit is a tick nobody can read. */}
          <XAxis dataKey="label" {...AXIS} />
          <YAxis {...AXIS} width={40} domain={[0, 100]} tickFormatter={(value) => `${value}%`} />
          <ChartTooltip cursor={HOVER} content={<ChartTip format={(value) => `${value}%`} names={{ rate: 'win rate' }} />} />
          <Bar dataKey="rate" maxBarSize={BAR.size} radius={BAR.up} minPointSize={ZERO_BAR}>
            {rows.map((q) => <Cell key={q.key} fill={q.current ? 'var(--primary)' : 'var(--forecast)'} />)}
            {/* No bar and no percentage for a quarter that closed nothing:
                "0%" would read as "we lost them all". */}
            <LabelList
              position="top"
              {...BAR_LABEL}
              valueAccessor={(entry) => (entry.payload.win_rate === null ? 'none closed' : `${entry.payload.rate}%`)}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* ------------------------------------------------- quoted against won */

/**
 * Two series, because the gap between them is the finding.
 *
 * A month where both fell is a quiet month; a month where quoting held and
 * winning fell is a problem, and one bar cannot tell you which it was.
 */
function QuotedWonChart({ state, horizon, onOpen }) {
  const d = state.data?.data;
  const rows = (d?.months || []).map((m) => ({ ...m, label: monthLabel(m.month) }));
  const quoted = rows.reduce((sum, m) => sum + Number(m.quoted || 0), 0);
  const won = rows.reduce((sum, m) => sum + Number(m.won || 0), 0);

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title="Quoted against won"
      meta={`The last ${horizon} months · quoted in the lighter bar, won in the accent`}
      height={280}
      columns={['Month', 'Deals', 'Quoted', 'Won', 'Share won']}
      rows={rows.map((m) => ({
        key: m.month,
        href: `/quotations?month=${m.month}`,
        cells: [m.label, number(m.deals), inr(m.quoted), inr(m.won), m.quoted > 0 ? percent(m.won / m.quoted) : '—'],
      }))}
      footnote={`${inr(won)} won of ${inr(quoted)} quoted over the period.${d?.foreign ? ` ${number(d.foreign)} quoted in another currency are counted but not summed.` : ''}`}
    >
      <ChartContainer config={{ quoted: { label: 'Quoted' }, won: { label: 'Won' } }} className="h-full w-full aspect-auto">
        <BarChart data={rows} barGap={2} margin={{ left: 0, right: 4, top: 16, bottom: 4 }}>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis dataKey="label" {...AXIS} interval={0} />
          <YAxis {...AXIS} width={56} tickFormatter={inr} />
          <ChartTooltip cursor={HOVER} content={<ChartTip format={inr} names={{ quoted: 'quoted', won: 'won' }} />} />
          <Bar dataKey="quoted" maxBarSize={BAR.paired} radius={BAR.up} minPointSize={ZERO_BAR} fill="var(--forecast)" cursor="pointer" onClick={(bar) => bar?.payload && onOpen(bar.payload.month)} />
          <Bar dataKey="won" maxBarSize={BAR.paired} radius={BAR.up} minPointSize={ZERO_BAR} fill="var(--primary)" cursor="pointer" onClick={(bar) => bar?.payload && onOpen(bar.payload.month)} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* ------------------------------------------------------- win rate by X */

/**
 * The quarterly rate says whether the team is improving. This says where it
 * is already winning, which is the question asked before deciding what to
 * chase next.
 */
function ConversionChart({ state }) {
  const d = state.data?.data;
  const rows = (d?.groups || []).map((g) => ({ ...g, label: g.key, rate: g.win_rate === null ? 0 : g.win_rate * 100 }));

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title={`Win rate by ${d?.label?.toLowerCase() || 'owner'}`}
      meta="Decided deals only — won over won plus lost"
      height={ROW_CHART(rows.length)}
      columns={[d?.label || 'Owner', 'Won', 'Lost', 'Win rate']}
      rows={rows.map((g) => ({ key: g.key, cells: [g.key, number(g.won), number(g.lost), g.win_rate === null ? '—' : percent(g.win_rate)] }))}
      footnote="A rate is a count, so a deal in any currency counts in it."
    >
      <ChartContainer config={Object.fromEntries(rows.map((g) => [g.key, { label: g.key }]))} className="h-full w-full aspect-auto">
        <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 96, top: 4, bottom: 4 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" dataKey="rate" domain={[0, 100]} {...AXIS} tickFormatter={(value) => `${value}%`} />
          <YAxis type="category" dataKey="label" width={116} {...AXIS} />
          <ChartTooltip cursor={HOVER} content={<ChartTip format={(value) => `${Math.round(value)}%`} names={{ rate: 'win rate' }} />} />
          <Bar dataKey="rate" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--primary)">
            <LabelList
              position="right"
              {...BAR_LABEL}
              valueAccessor={(entry) => (entry?.payload ? `${Math.round(entry.payload.rate)}% · ${entry.payload.won}W ${entry.payload.lost}L` : '')}
            />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

/* --------------------------------------------------- open deals by status */

/**
 * The pipeline chart is by stage — where the team moved a deal to. This is
 * by status, which is what the record says it is. They drift, and a deal
 * parked at On Hold is invisible on a board that only shows progress.
 */
function StatusChart({ state, onOpen }) {
  const d = state.data?.data;
  const rows = (d?.statuses || []).map((r) => ({ ...r, label: r.status }));
  const total = rows.reduce((sum, r) => sum + Number(r.deals || 0), 0);

  if (state.loading && !d) return <Loading height={320} />;

  return (
    <ChartCard
      title="Open deals by status"
      meta="What each record says it is, which is not always where its stage puts it"
      height={ROW_CHART(rows.length)}
      columns={['Status', 'Deals', 'Value']}
      rows={rows.map((r) => ({ key: r.status, href: `/quotations?status=${encodeURIComponent(r.status)}`, cells: [r.status, number(r.deals), inr(r.value)] }))}
      footnote={`${number(total)} open deals.${d?.foreign ? ` ${number(d.foreign)} quoted in another currency are counted but not summed.` : ''}`}
    >
      <ChartContainer config={Object.fromEntries(rows.map((r) => [r.status, { label: r.status }]))} className="h-full w-full aspect-auto">
        <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }}>
          <CartesianGrid {...GRID} horizontal={false} />
          <XAxis type="number" dataKey="deals" {...AXIS} allowDecimals={false} />
          <YAxis type="category" dataKey="label" width={136} {...AXIS} />
          <ChartTooltip cursor={HOVER} content={<ChartTip format={number} names={{ deals: 'open deals' }} />} />
          <Bar dataKey="deals" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--info)" cursor="pointer" onClick={(bar) => bar?.payload && onOpen(bar.payload.status)}>
            <LabelList dataKey="deals" position="right" formatter={number} {...BAR_LABEL} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}
