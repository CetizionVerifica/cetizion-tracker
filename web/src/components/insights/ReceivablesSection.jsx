import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { AGE_COLOUR, AXIS, BAR, BAR_LABEL, ChartCard, ChartTip, GRID, HOVER, ROW_CHART, ZERO_BAR } from '../charts.jsx';
import { ChartContainer, ChartTooltip } from '../ui/chart.tsx';
import { buttonVariants } from '../ui/button.tsx';
import { date, money, number } from '../../lib/format.js';
import { hrefs, inr, receivablesAnswer, ruleText } from '../../lib/insights.js';
import { ActionList, Section } from './shared.jsx';

// Both parts take the band's colour, so late is red however much has been
// paid; the part-paid share is the paler one.
const PART = [
  { key: 'invoiced', label: 'Nothing paid yet', colour: 'var(--waiting)', opacity: 1 },
  { key: 'part_paid', label: 'Part paid', colour: 'var(--waiting)', opacity: 0.45 },
];

/** 2. What do clients owe us, and how late is it? */
export function ReceivablesSection({ data, loading, onRetry, settings, onNavigate }) {
  const d = data;
  return (
    <Section
      question="What do clients owe us, and how late is it?"
      answer={receivablesAnswer(d)}
      rule={ruleText('receivables', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
    >
      {() => (
        <>
          <ChartCard
            title="Unpaid invoices by age"
            meta="In ₹, split by whether anything has been paid"
            height={ROW_CHART(d.buckets.length)}
            columns={['Age', 'Invoices', 'Nothing paid', 'Part paid', 'Outstanding']}
            rows={d.buckets.map((b) => ({ key: b.key, href: hrefs.ageing(b.key), cells: [b.label, number(b.count), inr(b.invoiced), inr(b.part_paid), inr(b.amount)] }))}
            footnote={d.unconverted.length ? `${number(d.unconverted.length)} invoice${d.unconverted.length === 1 ? '' : 's'} in a currency with no rate for the invoice date ${d.unconverted.length === 1 ? 'is' : 'are'} not in these totals: ${d.unconverted.slice(0, 3).map((u) => `${u.invoice_no} ${money(u.amount, u.currency)}`).join(', ')}.` : 'Each band opens the chase queue filtered to it.'}
          >
            <ChartContainer config={Object.fromEntries(PART.map((p) => [p.key, { label: p.label, color: p.colour }]))} className="h-full w-full aspect-auto">
              <BarChart data={d.buckets} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }}>
                <CartesianGrid {...GRID} horizontal={false} />
                <XAxis type="number" {...AXIS} tickFormatter={inr} />
                <YAxis type="category" dataKey="label" width={104} {...AXIS} />
                <ChartTooltip cursor={HOVER} content={<ChartTip format={inr} names={Object.fromEntries(PART.map((p) => [p.key, p.label.toLowerCase()]))} />} />
                {PART.map((p, i) => (
                  <Bar
                    key={p.key}
                    dataKey={p.key}
                    stackId="age"
                    fill={p.colour}
                    fillOpacity={p.opacity}
                    maxBarSize={BAR.size}
                    radius={i === PART.length - 1 ? BAR.right : 0}
                    minPointSize={i === PART.length - 1 ? ZERO_BAR : 0}
                    cursor="pointer"
                    onClick={(bar) => bar?.payload && onNavigate(hrefs.ageing(bar.payload.key))}
                  >
                    {d.buckets.map((b) => <Cell key={b.key} fill={AGE_COLOUR[b.key] || p.colour} />)}
                    {i === PART.length - 1 && <LabelList position="right" {...BAR_LABEL} valueAccessor={(entry) => inr(entry.payload.amount)} />}
                  </Bar>
                ))}
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ChartCard
            title="Who owes the most that is late"
            meta="Top clients by overdue amount"
            height={ROW_CHART(Math.max(d.top_clients.length, 1))}
            columns={['Client', 'Overdue', 'Outstanding', 'Oldest']}
            rows={d.top_clients.map((c) => ({ key: String(c.company_id ?? c.company), href: hrefs.client(c.company_id), cells: [c.company, inr(c.overdue), inr(c.outstanding), `${number(c.oldest_days)} days`] }))}
          >
            <ChartContainer config={{ overdue: { label: 'Overdue' } }} className="h-full w-full aspect-auto">
              <BarChart data={d.top_clients} layout="vertical" margin={{ left: 4, right: 64, top: 4, bottom: 4 }}>
                <CartesianGrid {...GRID} horizontal={false} />
                <XAxis type="number" dataKey="overdue" {...AXIS} tickFormatter={inr} />
                <YAxis type="category" dataKey="company" width={130} {...AXIS} />
                <ChartTooltip cursor={HOVER} content={<ChartTip format={inr} names={{ overdue: 'overdue' }} />} />
                <Bar dataKey="overdue" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--late)" cursor="pointer" onClick={(bar) => bar?.payload && onNavigate(hrefs.client(bar.payload.company_id))}>
                  <LabelList dataKey="overdue" position="right" formatter={inr} {...BAR_LABEL} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ActionList
            title="Chase first"
            empty="Nothing invoiced is late. Nice."
            rows={d.top.map((s) => ({
              key: String(s.stage_id),
              href: hrefs.invoice(s.stage_id),
              title: `${s.company || '—'} · ${s.invoice_no}`,
              meta: `${number(s.days_overdue)} days late · due ${date(s.due_on)} · ${s.ref}`,
              value: inr(s.amount_inr),
              action: <Link className={buttonVariants({ size: 'sm', variant: 'outline' })} to={hrefs.invoice(s.stage_id)}>Chase</Link>,
            }))}
          />
        </>
      )}
    </Section>
  );
}
