import { ChartBlock, ColBars, Note, RowBars, inrFull } from '../charts.jsx';
import { date, number } from '../../lib/format.js';
import { followUpAnswer, hrefs, inr, ruleText } from '../../lib/insights.js';
import { ActionList, Question } from './shared.jsx';

/** Later is worse: amber until a week, then red. */
const BAND_TONE = { '0-3': 'wait', '4-7': 'wait', '8-14': 'late', '15+': 'late' };
const WHY = { task: 'task date missed', follow_up_date: 'follow-up date missed', idle: 'no word since it was sent' };
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

/** 1. Which quotations are past their follow-up date? */
export function FollowUpsSection({ data, loading, onRetry, settings, owner, showOwners, onTouch }) {
  const d = data;
  return (
    <Question
      n={1}
      question="Which quotations are past their follow-up date?"
      answer={followUpAnswer(d)}
      rule={ruleText('follow_ups', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
    >
      {() => (
        <>
          <ChartBlock
            title="By days past the date"
            meta="Open quotations, counted"
            legend={[{ tone: 'wait', label: 'Up to a week past' }, { tone: 'late', label: 'More than a week past' }]}
            columns={['Past the date by', 'Quotations', 'Value']}
            rows={d.buckets.map((b) => ({ key: b.key, href: hrefs.followUps(owner, b.key), cells: [b.label, number(b.count), inrFull(b.value)] }))}
            foot={['Total', number(d.count), inrFull(d.value_inr)]}
            empty={d.count ? null : 'Nothing to chart: every quotation is inside its follow-up date.'}
            note={<Note>{d.unconverted ? `${number(d.unconverted)} quoted in a currency with no rate for its date: counted, not in the value.` : null}</Note>}
          >
            <ColBars
              label="By days past the date: open a band for its quotations"
              height={150}
              rows={d.buckets.map((b) => ({
                key: b.key,
                label: b.label,
                href: hrefs.followUps(owner, b.key),
                aria: `${b.label} past the date: ${plural(b.count, 'quotation')}, ${inrFull(b.value)}. Open the list`,
                value: `${number(b.count)} · ${inr(b.value)}`,
                segs: [{ v: b.count, tone: BAND_TONE[b.key] || 'late' }],
              }))}
            />
          </ChartBlock>

          {showOwners && d.by_owner.length > 0 && (
            <ChartBlock
              title="By owner"
              meta="Whose quotations are waiting"
              columns={['Owner', 'Quotations', 'Value']}
              rows={d.by_owner.map((o) => ({ key: String(o.owner_user_id ?? 'none'), href: hrefs.followUpOwner(o.owner_user_id), cells: [o.owner_name, number(o.count), inrFull(o.value)] }))}
            >
              <RowBars
                label="By owner: open a bar for that owner's overdue quotations"
                lw={96}
                vw={118}
                rows={d.by_owner.map((o) => ({
                  key: String(o.owner_user_id ?? 'none'),
                  label: o.owner_name,
                  href: hrefs.followUpOwner(o.owner_user_id),
                  aria: `${o.owner_name}: ${plural(o.count, 'overdue quotation')}, ${inrFull(o.value)}. Open the list`,
                  value: `${number(o.count)} · ${inr(o.value)}`,
                  segs: [{ v: o.count, tone: 'figure' }],
                }))}
              />
            </ChartBlock>
          )}

          <ActionList
            title="Follow up first"
            empty="No quotations past follow-up. Nice."
            more={{ to: hrefs.followUps(owner), label: `All ${number(d.count)} overdue` }}
            rows={d.top.map((q) => ({
              key: q.number,
              href: hrefs.record(q.link),
              title: `${q.client || '—'} · ${q.number}`,
              meta: `${q.days_overdue ? `${plural(q.days_overdue, 'day')} past ${date(q.due_on)}` : 'due today'} · ${WHY[q.why] || 'follow-up due'}${showOwners && q.owner_name ? ` · ${q.owner_name}` : ''}`,
              value: q.value_inr != null ? inrFull(q.value_inr) : null,
              action: (
                <button type="button" className="mg-btn mg-btn--sm" aria-label={`Log a touch for ${q.number}`}
                  onClick={() => onTouch({ entity: 'quotation', id: q.number, sub: [q.number, q.client, q.value_inr != null ? inrFull(q.value_inr) : null].filter(Boolean).join(' · ') })}
                >Log a touch</button>
              ),
            }))}
          />
        </>
      )}
    </Question>
  );
}
