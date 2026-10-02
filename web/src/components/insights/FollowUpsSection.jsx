import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { AXIS, BAR, BAR_LABEL, ChartCard, ChartTip, GRID, HOVER, ROW_CHART, ZERO_BAR } from '../charts.jsx';
import { ChartContainer, ChartTooltip } from '../ui/chart.tsx';
import { Button } from '../ui/button.tsx';
import { date, number } from '../../lib/format.js';
import { followUpAnswer, hrefs, inr, ruleText } from '../../lib/insights.js';
import { ActionList, Section } from './shared.jsx';

/** Later is worse: amber until a week, then red. */
const BAND_COLOUR = { '0-3': 'var(--waiting)', '4-7': 'var(--waiting)', '8-14': 'var(--late)', '15+': 'var(--late)' };
const WHY = { task: 'task date missed', follow_up_date: 'follow-up date missed', idle: 'no word since it was sent' };

/** 1. Which quotations are past their follow-up date? */
export function FollowUpsSection({ data, loading, onRetry, settings, owner, showOwners, onNavigate, onTouch }) {
  const d = data;
  return (
    <Section
      question="Which quotations are past their follow-up date?"
      answer={followUpAnswer(d)}
      rule={ruleText('follow_ups', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
    >
      {() => (
        <>
          <ChartCard
            title="By days past the date"
            meta="Open quotations, counted"
            height={220}
            columns={['Past the date by', 'Quotations', 'Value']}
            rows={d.buckets.map((b) => ({ key: b.key, href: hrefs.followUps(owner, b.key), cells: [b.label, number(b.count), inr(b.value)] }))}
            footnote={d.unconverted ? `${number(d.unconverted)} quoted in a currency with no rate for its date: counted, not in the value.` : null}
          >
            <ChartContainer config={{ count: { label: 'Quotations' } }} className="h-full w-full aspect-auto">
              <BarChart data={d.buckets} margin={{ left: 0, right: 4, top: 16, bottom: 4 }}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="label" {...AXIS} interval={0} />
                <YAxis {...AXIS} width={32} allowDecimals={false} />
                <ChartTooltip cursor={HOVER} content={<ChartTip format={number} names={{ count: 'quotations' }} />} />
                <Bar dataKey="count" maxBarSize={BAR.size * 2} radius={BAR.up} minPointSize={ZERO_BAR} cursor="pointer" onClick={(bar) => bar?.payload && onNavigate(hrefs.followUps(owner, bar.payload.key))}>
                  {d.buckets.map((b) => <Cell key={b.key} fill={BAND_COLOUR[b.key]} />)}
                  <LabelList dataKey="count" position="top" {...BAR_LABEL} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          {showOwners && d.by_owner.length > 0 && (
            <ChartCard
              title="By owner"
              meta="Whose quotations are waiting"
              height={ROW_CHART(d.by_owner.length)}
              columns={['Owner', 'Quotations', 'Value']}
              rows={d.by_owner.map((o) => ({ key: String(o.owner_user_id ?? 'none'), href: hrefs.followUpOwner(o.owner_user_id), cells: [o.owner_name, number(o.count), inr(o.value)] }))}
            >
              <ChartContainer config={{ count: { label: 'Quotations' } }} className="h-full w-full aspect-auto">
                <BarChart data={d.by_owner} layout="vertical" margin={{ left: 4, right: 40, top: 4, bottom: 4 }}>
                  <CartesianGrid {...GRID} horizontal={false} />
                  <XAxis type="number" dataKey="count" {...AXIS} allowDecimals={false} />
                  <YAxis type="category" dataKey="owner_name" width={116} {...AXIS} />
                  <ChartTooltip cursor={HOVER} content={<ChartTip format={number} names={{ count: 'quotations' }} />} />
                  <Bar dataKey="count" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--primary)" cursor="pointer" onClick={(bar) => bar?.payload && onNavigate(hrefs.followUpOwner(bar.payload.owner_user_id))}>
                    <LabelList dataKey="count" position="right" {...BAR_LABEL} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            </ChartCard>
          )}

          <ActionList
            title="Follow up first"
            empty="No quotations past follow-up. Nice."
            rows={d.top.map((q) => ({
              key: q.number,
              href: hrefs.record(q.link),
              title: `${q.client || '—'} · ${q.number}`,
              meta: `${q.days_overdue ? `${number(q.days_overdue)} day${q.days_overdue === 1 ? '' : 's'} past ${date(q.due_on)}` : 'due today'} · ${WHY[q.why] || 'follow-up due'}${showOwners && q.owner_name ? ` · ${q.owner_name}` : ''}`,
              value: q.value_inr != null ? inr(q.value_inr) : null,
              action: <Button size="sm" variant="outline" onClick={() => onTouch({ entity: 'quotation', id: q.number })}>Log a touch</Button>,
            }))}
          />
        </>
      )}
    </Section>
  );
}
