import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { AXIS, BAR, CASH_BANDS, ChartCard, ChartTip, GRID, HOVER, ZERO_BAR } from '../charts.jsx';
import { ChartContainer, ChartTooltip } from '../ui/chart.tsx';
import { Button } from '../ui/button.tsx';
import { number } from '../../lib/format.js';
import { BASIS_OPTIONS, hrefs, inr, revenueAnswer, ruleText } from '../../lib/insights.js';
import { Section } from './shared.jsx';

/** The weighted pipeline is a hope, not a schedule: its own band, lighter, on top. */
const PIPELINE = { key: 'pipeline', label: 'Pipeline (weighted)', colour: 'var(--info)' };
const ORDER_BANDS = [{ key: 'won', label: 'Ordered (POs)', colour: 'var(--settled)' }];

/** 5. How much money do we expect each month or quarter? */
export function RevenueSection({ data, loading, onRetry, settings, granularity, basis, onBasis, onNavigate }) {
  const d = data;
  const order = d?.basis === 'order';
  const bands = [...(order ? ORDER_BANDS : CASH_BANDS), PIPELINE];
  const periods = d?.periods || [];
  const hasTarget = order && periods.some((p) => p.target !== null);
  const total = (p) => bands.filter((b) => b.key !== 'pipeline').reduce((n, b) => n + Number(p[b.key] || 0), 0);
  const href = (p) => (order ? null : hrefs.period(p, granularity));
  const extras = [];
  if (!order && d?.later && total(d.later) + d.later.pipeline > 0) extras.push(`${inr(total(d.later))} expected after the months shown`);
  if (!order && d?.unscheduled && total(d.unscheduled) > 0) extras.push(`${inr(total(d.unscheduled))} has no date yet`);
  if (d?.unconverted) extras.push(`${number(d.unconverted)} record${d.unconverted === 1 ? '' : 's'} in a currency with no rate left out`);

  return (
    <Section
      wide
      question="How much money do we expect each period?"
      answer={revenueAnswer(d)}
      rule={ruleText('revenue', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
    >
      {() => (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Revenue basis">
            {BASIS_OPTIONS.map((o) => (
              <Button key={o.value} size="sm" variant={basis === o.value ? 'default' : 'outline'} aria-pressed={basis === o.value} onClick={() => onBasis(o.value)}>
                {o.label}
              </Button>
            ))}
          </div>
          <ChartCard
            title={order ? 'Orders by period, and the pipeline ahead' : 'Money expected in, by period'}
            meta={order ? 'POs by their date, open deals weighted by stage at their expected close' : 'Received, invoiced and due, and not yet invoiced; the weighted pipeline on top'}
            height={300}
            columns={['Period', ...bands.map((b) => b.label), ...(hasTarget ? ['Target'] : [])]}
            rows={periods.map((p) => ({
              key: p.period,
              href: href(p) || undefined,
              cells: [p.label, ...bands.map((b) => inr(p[b.key])), ...(hasTarget ? [p.target === null ? '—' : inr(p.target)] : [])],
            }))}
            footnote={[
              order && !hasTarget ? 'No order-intake target is set for these years (Settings → Users → targets).' : null,
              order && hasTarget ? 'The target is the annual order-intake target spread evenly over its twelve months.' : null,
              extras.length ? `${extras.join('; ')}.` : null,
            ].filter(Boolean).join(' ') || null}
          >
            <ChartContainer
              config={Object.fromEntries([...bands.map((b) => [b.key, { label: b.label, color: b.colour }]), ['target', { label: 'Target', color: 'var(--foreground)' }]])}
              className="h-full w-full aspect-auto"
            >
              <ComposedChart data={periods} margin={{ left: 0, right: 8, top: 16, bottom: 4 }}>
                <CartesianGrid {...GRID} vertical={false} />
                <XAxis dataKey="label" {...AXIS} />
                <YAxis {...AXIS} width={56} tickFormatter={inr} />
                <ChartTooltip
                  cursor={HOVER}
                  content={<ChartTip format={inr} names={{ ...Object.fromEntries(bands.map((b) => [b.key, b.label.toLowerCase()])), target: 'target' }} />}
                />
                {bands.map((band, i) => (
                  <Bar
                    key={band.key}
                    dataKey={band.key}
                    stackId="money"
                    fill={band.colour}
                    fillOpacity={band.key === 'pipeline' ? 0.35 : 1}
                    maxBarSize={BAR.size * 2}
                    radius={i === bands.length - 1 ? BAR.up : 0}
                    minPointSize={i === bands.length - 1 ? ZERO_BAR : 0}
                    cursor={order ? undefined : 'pointer'}
                    onClick={(bar) => { const to = bar?.payload && href(bar.payload); if (to) onNavigate(to); }}
                  />
                ))}
                {hasTarget && <Line type="stepAfter" dataKey="target" stroke="var(--foreground)" strokeDasharray="4 4" strokeWidth={1.5} dot={false} />}
              </ComposedChart>
            </ChartContainer>
          </ChartCard>
        </>
      )}
    </Section>
  );
}
