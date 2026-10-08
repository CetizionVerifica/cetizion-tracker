import { ChartBlock, RowBars, inrFull } from '../charts.jsx';
import { number } from '../../lib/format.js';
import { enquiryRiskAnswer, hrefs, reasonText, ruleText } from '../../lib/insights.js';
import { ActionList, Question } from './shared.jsx';

/** A decision with no quotation is the one that is lost by waiting. */
const REASON_TONE = { decision_near: 'late', no_reply: 'wait', follow_up_missed: 'wait', idle: 'info' };
const plural = (n) => `${number(n)} ${n === 1 ? 'enquiry' : 'enquiries'}`;

/** 3. Which enquiries need handling before it is too late? */
export function EnquiryRiskSection({ data, loading, onRetry, settings, owner, showOwners, onTouch }) {
  const d = data;
  return (
    <Question
      n={3}
      wide
      question="Which enquiries need handling before it is too late?"
      answer={enquiryRiskAnswer(d)}
      rule={ruleText('enquiry_risk', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
      skeleton="rows"
    >
      {() => (
        <div className="rp-sub">
          <ChartBlock
            title="At risk, by reason"
            meta="An enquiry can be at risk for more than one reason"
            legend={[{ tone: 'late', label: 'Decision near' }, { tone: 'wait', label: 'Waiting on us' }, { tone: 'info', label: 'Gone quiet' }]}
            columns={['Reason', 'Enquiries']}
            rows={d.by_reason.map((r) => ({ key: r.reason, href: hrefs.risk(owner, r.reason), cells: [r.label, number(r.count)] }))}
            empty={d.count ? null : 'No enquiries at risk.'}
          >
            <RowBars
              label="At risk, by reason: open a reason for its enquiries"
              lw={170}
              vw={92}
              rows={d.by_reason.map((r) => ({
                key: r.reason,
                label: r.label,
                href: hrefs.risk(owner, r.reason),
                aria: `${r.label}: ${plural(r.count)}. Open the list`,
                value: plural(r.count),
                segs: [{ v: r.count, tone: REASON_TONE[r.reason] || 'wait' }],
              }))}
            />
          </ChartBlock>

          <ActionList
            title="Handle first"
            empty="No enquiries at risk. Nice."
            more={{ to: hrefs.risk(owner), label: `All ${number(d.count)} at risk` }}
            rows={d.top.map((e) => ({
              key: e.number,
              href: hrefs.record(e.link),
              title: `${e.client || '—'} · ${e.number}`,
              meta: [e.detail, showOwners ? e.owner_name : null].filter(Boolean).join(' · ') || 'Open enquiry',
              chips: e.reasons.map((r) => ({ tone: REASON_TONE[r.reason] || 'wait', text: reasonText(r) })),
              value: e.value_inr != null ? inrFull(e.value_inr) : null,
              action: (
                <button type="button" className="mg-btn mg-btn--sm" aria-label={`Log a touch for ${e.number}`}
                  onClick={() => onTouch({ entity: 'enquiry', id: e.number, sub: [e.number, e.client, e.detail].filter(Boolean).join(' · ') })}
                >Log a touch</button>
              ),
            }))}
          />
        </div>
      )}
    </Question>
  );
}
