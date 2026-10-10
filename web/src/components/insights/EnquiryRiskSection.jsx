import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis, YAxis } from 'recharts';
import { AXIS, BAR, BAR_LABEL, ChartCard, ChartTip, GRID, HOVER, ROW_CHART, ZERO_BAR } from '../charts.jsx';
import { ChartContainer, ChartTooltip } from '../ui/chart.tsx';
import { Button } from '../ui/button.tsx';
import { number } from '../../lib/format.js';
import { enquiryRiskAnswer, hrefs, inr, reasonText, ruleText } from '../../lib/insights.js';
import { ActionList, Section } from './shared.jsx';

/** A decision with no quotation is the one that is lost by waiting. */
const REASON_COLOUR = { decision_near: 'var(--late)', no_reply: 'var(--waiting)', follow_up_missed: 'var(--waiting)', idle: 'var(--forecast)' };

/** 3. Which enquiries need handling before it is too late? */
export function EnquiryRiskSection({ data, loading, onRetry, settings, owner, showOwners, onNavigate, onTouch }) {
  const d = data;
  return (
    <Section
      question="Which enquiries need handling before it is too late?"
      answer={enquiryRiskAnswer(d)}
      rule={ruleText('enquiry_risk', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
    >
      {() => (
        <>
          <ChartCard
            title="At risk, by reason"
            meta="An enquiry can be at risk for more than one reason"
            height={ROW_CHART(d.by_reason.length)}
            columns={['Reason', 'Enquiries']}
            rows={d.by_reason.map((r) => ({ key: r.reason, href: hrefs.risk(owner, r.reason), cells: [r.label, number(r.count)] }))}
          >
            <ChartContainer config={{ count: { label: 'Enquiries' } }} className="h-full w-full aspect-auto">
              <BarChart data={d.by_reason} layout="vertical" margin={{ left: 4, right: 40, top: 4, bottom: 4 }}>
                <CartesianGrid {...GRID} horizontal={false} />
                <XAxis type="number" dataKey="count" {...AXIS} allowDecimals={false} />
                <YAxis type="category" dataKey="label" width={170} {...AXIS} />
                <ChartTooltip cursor={HOVER} content={<ChartTip format={number} names={{ count: 'enquiries' }} />} />
                <Bar dataKey="count" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} cursor="pointer" onClick={(bar) => bar?.payload && onNavigate(hrefs.risk(owner, bar.payload.reason))}>
                  {d.by_reason.map((r) => <Cell key={r.reason} fill={REASON_COLOUR[r.reason]} />)}
                  <LabelList dataKey="count" position="right" {...BAR_LABEL} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>

          <ActionList
            title="Handle first"
            empty="No enquiries at risk. Nice."
            rows={d.top.map((e) => ({
              key: e.number,
              href: hrefs.record(e.link),
              title: `${e.client || '—'} · ${e.number}`,
              meta: [e.detail, showOwners ? e.owner_name : null].filter(Boolean).join(' · ') || 'Open enquiry',
              chips: e.reasons.map(reasonText),
              value: e.value_inr != null ? inr(e.value_inr) : null,
              action: <Button size="sm" variant="outline" onClick={() => onTouch({ entity: 'enquiry', id: e.number })}>Log a touch</Button>,
            }))}
          />
        </>
      )}
    </Section>
  );
}
