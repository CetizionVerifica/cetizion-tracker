import { ChartBlock, ColBars, Note, RowBars, inrFull } from '../charts.jsx';
import { number } from '../../lib/format.js';
import { hrefs, inr, poAnswer, ruleText } from '../../lib/insights.js';
import { Question } from './shared.jsx';

const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

/** 4. Which deals are about to become POs, and which POs are not fully billed? */
export function PoPipelineSection({ data, loading, onRetry, settings, owner }) {
  const d = data;
  const stepHref = (s) => (s.stage_id ? hrefs.stage(owner, s.stage_id) : s.key === 'po-to-bill' ? '/purchase-orders?live=1' : '/collections');
  // A deal is expected money (hatched); a PO to bill is ours (figure); billed is waiting on the client.
  const toneOf = (s) => (s.key === 'po-to-bill' ? 'figure' : s.key === 'po-billed' ? 'wait' : 'hatch');
  const months = d?.awaiting_po_by_month || [];
  const status = d?.po_status || [];
  return (
    <Question
      n={4}
      wide
      question="Which deals are about to become POs, and which POs are not fully billed?"
      answer={poAnswer(d)}
      rule={ruleText('po_pipeline', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
      skeleton="rows"
    >
      {() => (
        <div className="rp-q4">
          <ChartBlock
            title="From quotation to bill"
            meta="Open deals by stage, then live POs"
            legend={[{ tone: 'hatch', label: 'Open deals, not yet won' }, { tone: 'figure', label: 'POs still to bill' }, { tone: 'wait', label: 'Billed, awaiting payment' }]}
            columns={['Step', 'Count', 'Value', 'Weighted']}
            rows={d.stages.map((s) => ({ key: s.key, href: stepHref(s), cells: [s.label, number(s.count), inrFull(s.value), inrFull(s.weighted)] }))}
            empty={d.stages.some((s) => s.count) ? null : 'Nothing to chart: no open deals and no live POs.'}
            note={<Note>{`Deal values are gross; a PO step shows what is still to bill, or billed and still to collect.${d.without_rate ? ` ${plural(d.without_rate, 'record')} in a currency with no rate ${d.without_rate === 1 ? 'is' : 'are'} counted but not valued.` : ''}`}</Note>}
          >
            <RowBars
              label="From quotation to bill: open a step for its records"
              lw={170}
              vw={92}
              format={inr}
              rows={d.stages.map((s) => ({
                key: s.key,
                label: `${s.label} (${number(s.count)})`,
                href: stepHref(s),
                aria: `${s.label}: ${number(s.count)}, ${inrFull(s.value)}${s.stage_id ? `, ${inrFull(s.weighted)} weighted` : ''}. Open the list`,
                value: inr(s.value),
                segs: [{ v: s.value, tone: toneOf(s) }],
              }))}
            />
          </ChartBlock>

          {d.awaiting_stage_id && (
            <ChartBlock
              title="Awaiting a PO, by expected close"
              meta="The verbal-yes stage, by the month the PO is expected"
              legend={[{ tone: 'hatch', label: 'Expected, not yet ordered' }]}
              columns={['Month', 'Deals', 'Value']}
              rows={months.map((m) => ({ key: m.month, href: hrefs.awaitingMonth(owner, d.awaiting_stage_id, m.month), cells: [m.label, number(m.count), inrFull(m.value)] }))}
              empty={months.length ? null : 'No deal is at the verbal-yes stage just now.'}
              emptyPlain
            >
              <ColBars
                label="Awaiting a PO, by expected close: open a month for its deals"
                height={130}
                format={inr}
                rows={months.map((m) => ({
                  key: m.month,
                  label: m.label,
                  href: hrefs.awaitingMonth(owner, d.awaiting_stage_id, m.month),
                  aria: `${m.label}: ${plural(m.count, 'deal')}, ${inrFull(m.value)}. Open the list`,
                  value: inr(m.value),
                  segs: [{ v: m.value, tone: 'hatch' }],
                }))}
              />
            </ChartBlock>
          )}

          <ChartBlock
            title="Live POs by payment status"
            meta="Not cancelled, not revised, not fully paid"
            columns={['Status', 'POs', 'Value', 'Still to bill']}
            rows={status.map((s) => ({ key: s.status, href: hrefs.poStatus(s.status), cells: [s.status, number(s.count), inrFull(s.value), inrFull(s.to_bill)] }))}
            empty={status.length ? null : 'No live PO is waiting on billing or payment.'}
          >
            <RowBars
              label="Live POs by payment status: open a status for its POs"
              lw={120}
              vw={64}
              rows={status.map((s) => ({
                key: s.status,
                label: s.status,
                href: hrefs.poStatus(s.status),
                aria: `${s.status}: ${plural(s.count, 'PO')}, ${inrFull(s.value)}, ${inrFull(s.to_bill)} still to bill. Open the list`,
                value: plural(s.count, 'PO'),
                segs: [{ v: s.count, tone: 'figure' }],
              }))}
            />
          </ChartBlock>
        </div>
      )}
    </Question>
  );
}
