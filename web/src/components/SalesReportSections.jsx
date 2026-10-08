import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { AXIS, BAR, BAR_LABEL, ChartCard, ChartTip, GRID, HOVER } from './charts.jsx';
import { ChartContainer, ChartTooltip } from './ui/chart.tsx';
import { Alert, Card, DataTable, Empty, Stat } from './ui.jsx';
import { Button } from './ui/button.tsx';
import { api } from '../lib/api.js';
import { date, money, number } from '../lib/format.js';
import { bucketEnd, bucketStart, drillLink } from '../lib/reportPeriods.js';

/**
 * The Reports section's six questions (docs/sales-report-rework-plan.md §3),
 * drawn from one /api/reports/sales response. Each section is titled with its
 * question and opens with the sentence the server wrote from the figures —
 * the same sentence the PDF prints.
 *
 * Every chart is one series in the primary colour, with Other and Not set in
 * the muted one: each bar is named on its axis and labelled with its count,
 * so colour never has to say which is which. Every bar, and the first cell of
 * every row in its table twin, opens the records behind it (drillLink), and
 * the list runs the same rules the chart did.
 */

const inr = (value) => money(value, 'INR', { compact: true });
const inrFull = (value) => money(value, 'INR');
const nPct = (count, pct) => (pct == null ? number(count) : `${number(count)} · ${pct}%`);
const ROW_CHART = (rows) => Math.max(160, rows * 34 + 24);
const ZERO_BAR = 2;
const fill = (row) => (row.other ? 'var(--forecast)' : 'var(--primary)');

/** The strip under the header: four numbers, each a door into its section's records. */
export function SummaryStrip({ report, scope }) {
  const converted = report.outcomes.slices.find((s) => s.key === 'converted');
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Enquiries" value={number(report.enquiries.total)} meta="received in the period" to={drillLink('enquiries', scope)} />
      <Stat
        label="Converted to PO"
        value={nPct(converted.count, converted.pct)}
        meta="of those enquiries, by the period's end"
        to={drillLink('enquiries', scope, { outcome: 'converted' })}
      />
      <Stat
        label="POs"
        value={`${number(report.revenue.total.pos)} · ${inr(report.revenue.total.po_value_inr)}`}
        meta="incl. GST, by PO date"
        to={drillLink('purchase-orders', scope)}
      />
      <Stat
        label="New clients"
        value={number(report.customers.tiles.new_customers)}
        meta="first-ever PO in the period"
        to={drillLink('purchase-orders', scope, { customer: 'new' })}
      />
    </div>
  );
}

/** The section CSVs for the report on screen: same period, grain and owner. */
const csvHref = (name, scope) => api.reportCsvUrl(name, {
  from: scope.from, to: scope.to, ...(scope.grain && { grain: scope.grain }), ...(scope.owner && { owner: scope.owner }),
});

/** A question, the answer in a sentence, its CSVs, and what shows it. */
function Section({ n, question, answer, children, wide = false, scope, csv = [] }) {
  return (
    <section className={wide ? '@3xl:col-span-2 flex flex-col gap-3' : 'flex flex-col gap-3'} aria-labelledby={`q${n}`}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 id={`q${n}`} className="font-display text-base font-bold text-foreground">{n}. {question}</h2>
          {answer && <p className="mt-0.5 text-[13px] text-muted-foreground">{answer}</p>}
        </div>
        {csv.map(([name, label]) => (
          <a key={name} className="text-[12.5px]" href={csvHref(name, scope)} download>{label}</a>
        ))}
      </div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------- 1. enquiries */

export function EnquiriesSection({ report, scope }) {
  const navigate = useNavigate();
  const { enquiries } = report;
  const grain = enquiries.grain;
  const linkFor = (b) => (b.key
    ? drillLink('enquiries', { ...scope, from: bucketStart(b.key, grain, scope.from), to: bucketEnd(b.key, grain, scope.to) })
    : null);
  const rows = enquiries.buckets.filter((b) => b.key);
  const sources = enquiries.sources.map((s) => `${s.name} ${number(s.enquiries)}`).join(' · ');

  return (
    <Section n={1} scope={scope} csv={[['enquiries', 'CSV']]} question="How many enquiries did we receive?" answer={report.narrative.enquiries}>
      <ChartCard
        title={`Enquiries per ${grain}`}
        meta={`${number(enquiries.total)} in the period${enquiries.average_per_bucket != null ? ` · ${enquiries.average_per_bucket} a ${grain} on average` : ''}`}
        columns={[grain[0].toUpperCase() + grain.slice(1), 'Enquiries']}
        rows={enquiries.buckets.map((b) => ({ key: b.key ?? 'undated', href: linkFor(b), cells: [b.label, number(b.enquiries)] }))}
        footnote={sources ? `By source: ${sources}.` : null}
      >
        <ChartContainer config={{ enquiries: { label: 'Enquiries' } }} className="h-full w-full aspect-auto">
          <BarChart data={rows} margin={{ left: 0, right: 8, top: 16, bottom: 4 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={12} />
            <YAxis {...AXIS} allowDecimals={false} width={32} />
            <ChartTooltip cursor={HOVER} content={<ChartTip format={number} names={{ enquiries: 'enquiries' }} />} />
            <Bar dataKey="enquiries" maxBarSize={BAR.size} radius={BAR.up} fill="var(--primary)" cursor="pointer"
              onClick={(bar) => bar?.payload && navigate(linkFor(bar.payload))}
            >
              {rows.length <= 16 && <LabelList dataKey="enquiries" position="top" {...BAR_LABEL} />}
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartCard>
    </Section>
  );
}

/* ---------------------------------------------------------- 2. outcomes */

export function OutcomesSection({ report, scope }) {
  const navigate = useNavigate();
  const { outcomes } = report;
  const rows = outcomes.slices.map((s) => ({ ...s, display: nPct(s.count, s.pct), other: false }));
  const reasons = outcomes.quoted_not_won_reasons.map((r) => `${r.reason} ${r.count}`).join(' · ');
  const months = outcomes.months.filter((m) => m.key && m.enquiries);

  return (
    <Section n={2} scope={scope} csv={[['outcomes', 'CSV']]} question="What happened to them?" answer={report.narrative.outcomes}>
      <ChartCard
        title="Enquiry outcome"
        meta="As things stood at the end of the period. Lost means closed without a quotation."
        height={ROW_CHART(rows.length)}
        columns={['Outcome', 'Enquiries', 'Share']}
        rows={rows.map((s) => ({
          key: s.key,
          href: drillLink('enquiries', scope, { outcome: s.key }),
          cells: [s.label, number(s.count), s.pct == null ? '—' : `${s.pct}%`],
        }))}
        footnote={[
          `In pipeline: ${number(outcomes.pipeline.not_quoted)} not yet quoted, ${number(outcomes.pipeline.quoted)} quoted and awaiting a decision.`,
          reasons && `Quoted, not won: ${reasons}.`,
          months.length > 1 && `Converted by month: ${months.map((m) => `${m.label} ${m.converted.pct ?? 0}%`).join(' · ')}.`,
        ].filter(Boolean).join(' ')}
      >
        <ChartContainer config={{ count: { label: 'Enquiries' } }} className="h-full w-full aspect-auto">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 72, top: 4, bottom: 4 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis type="number" dataKey="count" {...AXIS} allowDecimals={false} />
            <YAxis type="category" dataKey="label" width={116} {...AXIS} />
            <ChartTooltip cursor={HOVER} content={<ChartTip format={(v, k, p) => p.display} names={{ count: 'enquiries' }} />} />
            <Bar dataKey="count" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--primary)" cursor="pointer"
              onClick={(bar) => bar?.payload && navigate(drillLink('enquiries', scope, { outcome: bar.payload.key }))}
            >
              <LabelList dataKey="display" position="right" {...BAR_LABEL} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartCard>
    </Section>
  );
}

/* ---------------------------------------------------------- 3. sectors */

export function SectorsSection({ report, scope }) {
  const navigate = useNavigate();
  const { sectors } = report;
  const rows = sectors.rows.map((r) => ({ ...r, display: `${number(r.pos)} · ${inr(r.value_inr)}` }));
  const other = sectors.rows.find((r) => r.sector === 'Other');
  const open = (sector) => navigate(drillLink('purchase-orders', scope, { sector }));

  return (
    <Section n={3} scope={scope} csv={[['sector-pos', 'CSV']]} question="Which sectors gave us POs?" answer={report.narrative.sectors}>
      <ChartCard
        title="POs by sector"
        meta="Count, with PO value incl. GST"
        height={ROW_CHART(rows.length)}
        columns={['Sector', 'POs', 'Share', 'PO value']}
        rows={rows.map((r) => ({
          key: r.sector,
          href: drillLink('purchase-orders', scope, { sector: r.sector }),
          cells: [r.sector, number(r.pos), r.pct == null ? '—' : `${r.pct}%`, inr(r.value_inr)],
        }))}
        footnote={other?.raw.length
          ? `Other is: ${other.raw.map((r) => `${r.name} ${r.pos}`).join(' · ')}. Settings → Report categories counts a spelling under a headline sector.`
          : null}
      >
        <ChartContainer config={{ pos: { label: 'POs' } }} className="h-full w-full aspect-auto">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 96, top: 4, bottom: 4 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis type="number" dataKey="pos" {...AXIS} allowDecimals={false} />
            <YAxis type="category" dataKey="sector" width={116} {...AXIS} />
            <ChartTooltip cursor={HOVER} content={<ChartTip format={(v, k, p) => p.display} names={{ pos: 'POs' }} />} />
            <Bar dataKey="pos" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} cursor="pointer" onClick={(bar) => bar?.payload && open(bar.payload.sector)}>
              {rows.map((r) => <Cell key={r.sector} fill={fill(r)} />)}
              <LabelList dataKey="display" position="right" {...BAR_LABEL} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartCard>
    </Section>
  );
}

/* --------------------------------------------------------- 4. services */

export function ServicesSection({ report, scope }) {
  const navigate = useNavigate();
  const { services } = report;
  const [by, setBy] = useState('value');
  const key = by === 'value' ? 'value_inr' : 'pos';
  const rows = [...services.rows]
    .sort((a, b) => a.other - b.other || b[key] - a[key])
    .map((r) => ({ ...r, display: by === 'value' ? `${inr(r.value_inr)} · ${number(r.pos)} PO${r.pos === 1 ? '' : 's'}` : `${number(r.pos)} · ${inr(r.value_inr)}` }));
  const source = services.sources;

  return (
    <Section n={4} scope={scope} csv={[['services', 'CSV']]} question="Which services sell best?" answer={report.narrative.services}>
      <ChartCard
        title={`Service lines by ${by === 'value' ? 'PO value' : 'number of POs'}`}
        meta="A PO naming several services splits its value between them"
        height={ROW_CHART(rows.length)}
        actions={(
          <Button type="button" variant="outline" size="sm" onClick={() => setBy(by === 'value' ? 'count' : 'value')}>
            Rank by {by === 'value' ? 'count' : 'value'}
          </Button>
        )}
        columns={['Service line', 'POs', 'PO value', 'Share of value']}
        rows={rows.map((r) => ({
          key: r.line,
          href: drillLink('purchase-orders', scope, { service: r.line }),
          cells: [r.line, number(r.pos), inr(r.value_inr), r.pct == null ? '—' : `${r.pct}%`],
        }))}
        footnote={`A PO counts once in each line it names. Split from: ${number(source.po_services)} PO service lines, ${number(source.quotation_lines)} quotation lines, ${number(source.keywords)} service text.`}
      >
        <ChartContainer config={{ [key]: { label: by === 'value' ? 'PO value' : 'POs' } }} className="h-full w-full aspect-auto">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 120, top: 4, bottom: 4 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis type="number" dataKey={key} {...AXIS} tickFormatter={by === 'value' ? inr : number} allowDecimals={false} />
            <YAxis type="category" dataKey="line" width={150} {...AXIS} />
            <ChartTooltip cursor={HOVER} content={<ChartTip format={(v, k, p) => p.display} names={{ value_inr: 'PO value', pos: 'POs' }} />} />
            <Bar dataKey={key} maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} cursor="pointer"
              onClick={(bar) => bar?.payload && navigate(drillLink('purchase-orders', scope, { service: bar.payload.line }))}
            >
              {rows.map((r) => <Cell key={r.line} fill={fill(r)} />)}
              <LabelList dataKey="display" position="right" {...BAR_LABEL} />
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartCard>
    </Section>
  );
}

/* --------------------------------------------------------- 5. customers */

export function CustomersSection({ report, scope }) {
  const { customers } = report;
  const t = customers.tiles;
  return (
    <Section n={5} scope={scope} csv={[['new-customers', 'New-customer enquiries CSV'], ['repeat-orders', 'Repeat orders CSV']]} question="New and existing customers" answer={report.narrative.customers} wide>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="New customers" value={number(t.new_customers)} meta="first-ever PO in the period" to={drillLink('purchase-orders', scope, { customer: 'new' })} />
        <Stat label="Existing customers" value={number(t.existing_customers)} meta="ordered before the period too" to={drillLink('purchase-orders', scope, { customer: 'existing' })} />
        <Stat label="Repeat orders" value={number(t.repeat_orders)} meta={`${inr(t.repeat_value_inr)} of PO value`} to={drillLink('purchase-orders', scope, { customer: 'repeat' })} />
        <Stat label="Repeat share of value" value={t.repeat_share_pct == null ? '—' : `${t.repeat_share_pct}%`} meta={`first orders ${inr(t.first_order_value_inr)}`} />
      </div>
      <div className="grid gap-4 @3xl:grid-cols-2">
        <Card
          title="Enquiries from new customers"
          hint={`${number(t.enquiries_from_new)} of ${number(t.enquiries_from_new + t.enquiries_from_existing)} · no PO before the enquiry`}
          actions={<Link className="text-[12.5px]" to={drillLink('enquiries', scope, { customer: 'new' })}>Open the list</Link>}
          flush
        >
          <DataTable
            label="Enquiries from new customers"
            rows={customers.new_customer_enquiries.slice(0, 50)}
            columns={[
              { key: 'enquiry_no', header: 'Enquiry', className: 'mono' },
              { key: 'client', header: 'Client' },
              { key: 'date', header: 'Received', render: (r) => date(r.date) },
              { key: 'outcome', header: 'Outcome', render: (r) => OUTCOME_LABEL[r.outcome] ?? r.outcome },
            ]}
            empty={<Empty title="No enquiries from new customers in this period" />}
          />
        </Card>
        <Card
          title="Repeat orders from existing customers"
          hint={`${number(t.repeat_orders)} PO${t.repeat_orders === 1 ? '' : 's'}`}
          actions={<Link className="text-[12.5px]" to={drillLink('purchase-orders', scope, { customer: 'repeat' })}>Open the list</Link>}
          flush
        >
          <DataTable
            label="Repeat orders from existing customers"
            rows={customers.repeat_orders.slice(0, 50)}
            columns={[
              { key: 'customer', header: 'Client' },
              { key: 'po_number', header: 'PO', className: 'mono' },
              { key: 'po_date', header: 'PO date', render: (r) => date(r.po_date) },
              { key: 'service', header: 'Service' },
              { key: 'po_value_inr', header: 'PO value', align: 'right', render: (r) => inrFull(r.po_value_inr) },
              { key: 'previous_orders', header: 'Earlier POs', align: 'right' },
            ]}
            empty={<Empty title="No repeat orders in this period" />}
          />
        </Card>
      </div>
    </Section>
  );
}

const OUTCOME_LABEL = { converted: 'Converted to PO', pipeline: 'In pipeline', quoted_not_won: 'Quoted, not won', lost: 'Lost' };

/* ----------------------------------------------------------- 6. revenue */

export function RevenueSection({ report, scope }) {
  const navigate = useNavigate();
  const { revenue } = report;
  const months = revenue.months.filter((m) => m.key);
  const open = (month) => navigate(drillLink('purchase-orders', scope, { month }));

  return (
    <Section n={6} scope={scope} csv={[['revenue', 'Months CSV'], ['revenue-pos', 'POs CSV']]} question="Monthly revenue" answer={report.narrative.revenue} wide>
      <ChartCard
        title="PO value incl. GST, per month"
        meta="Counting POs by PO date, in ₹ at the rate on the PO date. Not net of GST."
        columns={['Month', 'POs', 'PO value incl. GST', 'Invoiced', 'Received']}
        rows={revenue.months.map((m) => ({
          key: m.key ?? 'undated',
          href: m.key ? drillLink('purchase-orders', scope, { month: m.key }) : null,
          cells: [m.label, number(m.pos), inr(m.po_value_inr), inr(m.invoiced_inr), inr(m.received_inr)],
        }))}
        footnote="Invoiced and received are dated by the invoice and the payment, so they are the billing and cash view of each month, not a split of its PO value."
      >
        <ChartContainer config={{ po_value_inr: { label: 'PO value' } }} className="h-full w-full aspect-auto">
          <BarChart data={months} margin={{ left: 0, right: 8, top: 16, bottom: 4 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis {...AXIS} tickFormatter={inr} width={56} />
            <ChartTooltip cursor={HOVER} content={<ChartTip format={inrFull} names={{ po_value_inr: 'PO value incl. GST' }} />} />
            <Bar dataKey="po_value_inr" maxBarSize={BAR.size * 2} radius={BAR.up} fill="var(--primary)" cursor="pointer" onClick={(bar) => bar?.payload && open(bar.payload.key)}>
              {months.length <= 12 && <LabelList dataKey="po_value_inr" position="top" formatter={inr} {...BAR_LABEL} />}
            </Bar>
          </BarChart>
        </ChartContainer>
      </ChartCard>

      <Card title="The sales behind each month" hint="Open a month to see its POs" flush>
        {months.every((m) => !m.pos) && <Empty title="No POs in this period" />}
        {revenue.months.filter((m) => m.pos).map((m) => (
          <details key={m.key ?? 'undated'} className="border-b border-border">
            <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-[13px]">
              <span className="w-24 font-medium text-foreground">{m.label}</span>
              <span className="text-muted-foreground">{number(m.pos)} PO{m.pos === 1 ? '' : 's'}</span>
              <span className="num ml-auto">{inrFull(m.po_value_inr)}</span>
            </summary>
            <DataTable
              label={`POs in ${m.label}`}
              rows={m.detail}
              columns={[
                { key: 'po_number', header: 'PO', className: 'mono', render: (r) => <Link to={`/purchase-orders?q=${encodeURIComponent(r.po_number)}`}>{r.po_number}</Link> },
                { key: 'po_date', header: 'Date', render: (r) => date(r.po_date) },
                { key: 'client', header: 'Client' },
                { key: 'sector', header: 'Sector' },
                { key: 'service', header: 'Service' },
                { key: 'owner', header: 'Owner', render: (r) => r.owner || '—' },
                { key: 'po_value_inr', header: 'PO value', align: 'right', render: (r) => (r.po_value_inr == null ? (r.po_value == null ? 'No value' : money(r.po_value, r.currency)) : inrFull(r.po_value_inr)) },
                { key: 'invoiced_inr', header: 'Invoiced', align: 'right', render: (r) => inrFull(r.invoiced_inr) },
                { key: 'received_inr', header: 'Received', align: 'right', render: (r) => inrFull(r.received_inr) },
              ]}
            />
          </details>
        ))}
      </Card>
    </Section>
  );
}

/* ------------------------------------------------------------- notes */

/** What limits the figures, each with the list where it can be fixed. */
export function DataNotes({ notes, staleRates }) {
  if (!notes.length && !staleRates?.length) return null;
  return (
    <Alert tone="warning">
      <div className="flex flex-col gap-1">
        <strong className="font-semibold">About these figures</strong>
        <ul className="list-disc pl-4">
          {notes.map((n) => (
            <li key={n.key}>{n.text}{n.href && <> <Link to={n.href}>Fix</Link></>}</li>
          ))}
          {staleRates?.map((r) => (
            <li key={r.currency}>The newest {r.currency} rate is from {date(r.effective_from)}; recent amounts convert at it.</li>
          ))}
        </ul>
      </div>
    </Alert>
  );
}
