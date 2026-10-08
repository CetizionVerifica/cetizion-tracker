import { Link } from 'react-router-dom';
import { ChartBlock, ColBars, Note, inrFull } from '../charts.jsx';
import { number } from '../../lib/format.js';
import { BASIS_OPTIONS, GRANULARITY_OPTIONS, HORIZON_OPTIONS, hrefs, inr, revenueAnswer, ruleText } from '../../lib/insights.js';
import { PillSelect, Question, Seg } from './shared.jsx';

const total = (p) => Number(p.received || 0) + Number(p.invoiced || 0) + Number(p.scheduled || 0);
const sumOf = (list, key) => list.reduce((n, p) => n + Number(p[key] || 0), 0);

/** 5. How much money do we expect each period? Basis, grouping and months sit with it. */
export function RevenueSection({ data, loading, onRetry, settings, granularity, horizon, basis, onBasis, onGranularity, onHorizon }) {
  const d = data;
  const order = d?.basis === 'order';
  const periods = d?.periods || [];
  const hasTarget = order && periods.some((p) => p.target !== null);
  const extras = [];
  if (!order && d?.later && total(d.later) + Number(d.later.pipeline || 0) > 0) extras.push(`${inrFull(total(d.later))} expected after the months shown`);
  if (!order && d?.unscheduled && total(d.unscheduled) > 0) extras.push(`${inrFull(total(d.unscheduled))} has no date yet`);
  if (d?.unconverted) extras.push(`${number(d.unconverted)} record${d.unconverted === 1 ? '' : 's'} in a currency with no rate left out`);
  const pipe = sumOf(periods, 'pipeline');
  const target = periods.find((p) => p.target !== null)?.target;

  return (
    <Question
      n={5}
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
          <div className="rp-q5bar">
            <Seg label="Revenue basis" value={basis} options={BASIS_OPTIONS} onChange={onBasis} />
            <PillSelect id="q5-group" label="Group by" value={granularity} onChange={onGranularity} options={GRANULARITY_OPTIONS} />
            <PillSelect
              id="q5-months"
              label={order ? 'Months shown' : 'Months ahead'}
              value={horizon}
              onChange={onHorizon}
              options={HORIZON_OPTIONS.map((h) => ({ value: h, label: h }))}
            />
          </div>
          <div className="rp-q5">
            {order ? (
              <ChartBlock
                title="Orders by period, and the pipeline ahead"
                meta="POs by their date, open deals weighted by stage at their expected close"
                legend={[{ tone: 'figure', label: 'Ordered (POs)' }, { tone: 'pipe', label: 'Pipeline, weighted' }, ...(hasTarget ? [{ tone: 'line', label: 'Order-intake target' }] : [])]}
                columns={['Period', 'Ordered (POs)', 'Pipeline (weighted)', ...(hasTarget ? ['Target'] : [])]}
                rows={periods.map((p) => ({ key: p.period, cells: [p.label, inrFull(p.won), inrFull(p.pipeline), ...(hasTarget ? [p.target === null ? '—' : inrFull(p.target)] : [])] }))}
                empty={periods.some((p) => p.won || p.pipeline) ? null : 'This fills in when POs are dated in these months, or deals have an expected close.'}
                emptyPlain
                note={<Note>{[
                  hasTarget ? 'The target is the annual order-intake target spread evenly over its twelve months.' : 'No order-intake target is set for these years (Settings → Users → targets).',
                  `Order basis looks back as well as ahead, so it shows the last ${horizon} months and the next ${horizon}.`,
                  d.unconverted ? `${number(d.unconverted)} record${d.unconverted === 1 ? '' : 's'} in a currency with no rate left out.` : null,
                ].filter(Boolean).join(' ')}</Note>}
              >
                <ColBars
                  label="Orders by period, and the pipeline ahead"
                  height={220}
                  format={inr}
                  rows={periods.map((p) => ({
                    key: p.period,
                    label: p.label,
                    aria: `${p.label}: ${inrFull(p.won)} ordered, ${inrFull(p.pipeline)} weighted pipeline${p.target != null ? `, target ${inrFull(p.target)}` : ''}`,
                    value: inr(Number(p.won) + Number(p.pipeline)),
                    segs: [{ v: p.won, tone: 'figure' }, { v: p.pipeline, tone: 'pipe' }],
                    target: p.target,
                  }))}
                />
              </ChartBlock>
            ) : (
              <ChartBlock
                title="Money expected in, by period"
                meta="Received, invoiced and due, and not yet invoiced; the weighted pipeline on top"
                legend={[{ tone: 'figure', label: 'Received' }, { tone: 'wait', label: 'Invoiced, due' }, { tone: 'hatch', label: 'Not yet invoiced' }, { tone: 'pipe', label: 'Pipeline, weighted' }]}
                columns={['Period', 'Received', 'Invoiced, due', 'Not yet invoiced', 'Pipeline (weighted)']}
                rows={periods.map((p) => ({ key: p.period, href: hrefs.period(p, granularity), cells: [p.label, inrFull(p.received), inrFull(p.invoiced), inrFull(p.scheduled), inrFull(p.pipeline)] }))}
                empty={periods.some((p) => total(p) || p.pipeline) ? null : 'This fills in when POs have payment stages with dates, or deals have an expected close.'}
                emptyPlain
                note={<Note>{extras.length ? <>{extras.join('; ')}. <Link to="/cashflow">Open cash flow</Link></> : <Link to="/cashflow">Open cash flow</Link>}</Note>}
              >
                <ColBars
                  label={`Money expected in, by period: open a ${granularity === 'month' ? 'month' : 'period'} in cash flow`}
                  height={220}
                  format={inr}
                  rows={periods.map((p) => ({
                    key: p.period,
                    label: p.label,
                    href: hrefs.period(p, granularity),
                    aria: `${p.label}: ${inrFull(total(p))} expected (received ${inrFull(p.received)}, invoiced and due ${inrFull(p.invoiced)}, not yet invoiced ${inrFull(p.scheduled)}), plus ${inrFull(p.pipeline)} weighted pipeline. Open cash flow`,
                    value: inr(total(p)),
                    segs: [{ v: p.received, tone: 'figure' }, { v: p.invoiced, tone: 'wait' }, { v: p.scheduled, tone: 'hatch' }, { v: p.pipeline, tone: 'pipe' }],
                  }))}
                />
              </ChartBlock>
            )}
            <div className="rp-side">
              {order ? (
                <>
                  <Side swatch={{ background: 'var(--figure)' }} label="Ordered (POs)" value={inrFull(sumOf(periods, 'won'))} />
                  <Side swatch="is-pipe" label="Pipeline, weighted" sub="Open deals at their expected close" value={inrFull(pipe)} />
                  {hasTarget && <Side swatch="is-line" label="Order-intake target" sub="A month, from the annual target" value={inrFull(target)} />}
                </>
              ) : (
                <>
                  <Side swatch={{ background: 'var(--figure)' }} label="Received" value={inrFull(sumOf(periods, 'received'))} />
                  <Side swatch={{ background: 'var(--wait)' }} label="Invoiced, due" value={inrFull(sumOf(periods, 'invoiced'))} />
                  <Side swatch="is-hatch" label="Not yet invoiced" sub="Billable when stages are delivered" value={inrFull(sumOf(periods, 'scheduled'))} />
                  <div className="rp-side__row rp-side__total"><span /><span>Expected in the bank</span><strong className="mg-num">{inrFull(periods.reduce((n, p) => n + total(p), 0))}</strong></div>
                </>
              )}
            </div>
          </div>
          {!order && pipe > 0 && (
            <div className="rp-pipe">
              <i className="rp-seg--pipe" aria-hidden="true" />
              <span><strong className="mg-num">{inrFull(pipe)}</strong> more if the weighted pipeline lands. It sits on top of each bar and is never counted in the expected total.</span>
            </div>
          )}
        </>
      )}
    </Question>
  );
}

function Side({ swatch, label, sub, value }) {
  return (
    <div className="rp-side__row rp-legend">
      <i className={typeof swatch === 'string' ? swatch : undefined} style={typeof swatch === 'object' ? swatch : undefined} aria-hidden="true" />
      <span>{label}{sub && <span className="rp-side__s">{sub}</span>}</span>
      <strong className="mg-num">{value}</strong>
    </div>
  );
}
