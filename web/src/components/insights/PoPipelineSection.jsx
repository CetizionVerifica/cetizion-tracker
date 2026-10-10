import { Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts';
import { AXIS, BAR, BAR_LABEL, ChartCard, ChartTip, FunnelBars, GRID, HOVER, ROW_CHART, ZERO_BAR } from '../charts.jsx';
import { ChartContainer, ChartTooltip } from '../ui/chart.tsx';
import { number } from '../../lib/format.js';
import { hrefs, inr, poAnswer, ruleText } from '../../lib/insights.js';
import { Section } from './shared.jsx';

/** Deals are a forecast (grey into blue); a PO is money we are owed (amber, then green). */
const STEP_COLOUR = { 'po-to-bill': 'var(--waiting)', 'po-billed': 'var(--settled)' };

/** 4. Which deals are about to become POs, and which POs are not fully billed? */
export function PoPipelineSection({ data, loading, onRetry, settings, owner, onNavigate }) {
  const d = data;
  const stepHref = (s) => (s.stage_id ? hrefs.stage(owner, s.stage_id) : s.key === 'po-to-bill' ? '/purchase-orders?live=1' : '/collections');
  const steps = (d?.stages || []).map((s, i, all) => ({
    ...s,
    colour: STEP_COLOUR[s.key] || (s.stage_id === d.awaiting_stage_id ? 'var(--primary)' : i < all.length - 3 ? 'var(--forecast)' : 'var(--info)'),
  }));
  const months = d?.awaiting_po_by_month || [];
  return (
    <Section
      question="Which deals are about to become POs, and which POs are not fully billed?"
      answer={poAnswer(d)}
      rule={ruleText('po_pipeline', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
    >
      {() => (
        <>
          <ChartCard
            title="From quotation to bill"
            meta="Open deals by stage, then live POs"
            height={ROW_CHART(steps.length)}
            columns={['Step', 'Count', 'Value', 'Weighted']}
            rows={steps.map((s) => ({ key: s.key, href: stepHref(s), cells: [s.label, number(s.count), inr(s.value), inr(s.weighted)] }))}
            footnote={`Deal values are gross; a PO step shows what is still to bill, or billed and still to collect.${d?.without_rate ? ` ${number(d.without_rate)} record${d.without_rate === 1 ? '' : 's'} in a currency with no rate ${d.without_rate === 1 ? 'is' : 'are'} counted but not valued.` : ''}`}
          >
            <FunnelBars rows={steps} format={inr} valueName="value" onOpen={(s) => onNavigate(stepHref(s))} />
          </ChartCard>

          {d?.awaiting_stage_id && (
            <ChartCard
              title="Awaiting a PO, by expected close"
              meta="The verbal-yes stage, by the month the PO is expected"
              height={220}
              columns={['Month', 'Deals', 'Value']}
              rows={months.map((m) => ({ key: m.month, href: hrefs.awaitingMonth(owner, d.awaiting_stage_id, m.month), cells: [m.label, number(m.count), inr(m.value)] }))}
            footnote={months.length ? null : 'No deal is at the verbal-yes stage just now.'}
            >
              <ChartContainer config={{ value: { label: 'Value' } }} className="h-full w-full aspect-auto">
                <BarChart data={months} margin={{ left: 0, right: 4, top: 16, bottom: 4 }}>
                  <CartesianGrid {...GRID} vertical={false} />
                  <XAxis dataKey="label" {...AXIS} interval={0} />
                  <YAxis {...AXIS} width={56} tickFormatter={inr} />
                  <ChartTooltip cursor={HOVER} content={<ChartTip format={inr} names={{ value: 'value' }} />} />
                  <Bar dataKey="value" maxBarSize={BAR.size * 2} radius={BAR.up} minPointSize={ZERO_BAR} fill="var(--primary)" cursor="pointer" onClick={(bar) => bar?.payload && onNavigate(hrefs.awaitingMonth(owner, d.awaiting_stage_id, bar.payload.month))}>
                    <LabelList dataKey="value" position="top" formatter={inr} {...BAR_LABEL} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            </ChartCard>
          )}

          <ChartCard
            title="Live POs by payment status"
            meta="Not cancelled, not revised, not fully paid"
            height={ROW_CHART(Math.max((d?.po_status || []).length, 1))}
            columns={['Status', 'POs', 'Value', 'Still to bill']}
            rows={(d?.po_status || []).map((s) => ({ key: s.status, href: hrefs.poStatus(s.status), cells: [s.status, number(s.count), inr(s.value), inr(s.to_bill)] }))}
          >
            <ChartContainer config={{ count: { label: 'POs' } }} className="h-full w-full aspect-auto">
              <BarChart data={d?.po_status || []} layout="vertical" margin={{ left: 4, right: 40, top: 4, bottom: 4 }}>
                <CartesianGrid {...GRID} horizontal={false} />
                <XAxis type="number" dataKey="count" {...AXIS} allowDecimals={false} />
                <YAxis type="category" dataKey="status" width={110} {...AXIS} />
                <ChartTooltip cursor={HOVER} content={<ChartTip format={number} names={{ count: 'POs' }} />} />
                <Bar dataKey="count" maxBarSize={BAR.size} radius={BAR.right} minPointSize={ZERO_BAR} fill="var(--info)" cursor="pointer" onClick={(bar) => bar?.payload && onNavigate(hrefs.poStatus(bar.payload.status))}>
                  <LabelList dataKey="count" position="right" {...BAR_LABEL} />
                </Bar>
              </BarChart>
            </ChartContainer>
          </ChartCard>
        </>
      )}
    </Section>
  );
}
