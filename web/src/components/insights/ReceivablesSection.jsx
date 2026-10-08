import { AGE_TONE, ChartBlock, Note, RowBars, inrFull } from '../charts.jsx';
import { date, money, number } from '../../lib/format.js';
import { hrefs, inr, receivablesAnswer, ruleText } from '../../lib/insights.js';
import { ActionList, Question } from './shared.jsx';

const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;

/** 2. What do clients owe us, and how late is it? */
export function ReceivablesSection({ data, loading, onRetry, settings }) {
  const d = data;
  return (
    <Question
      n={2}
      question="What do clients owe us, and how late is it?"
      answer={receivablesAnswer(d)}
      rule={ruleText('receivables', settings)}
      data={d}
      loading={loading}
      onRetry={onRetry}
      skeleton="rows"
    >
      {() => (
        <>
          <ChartBlock
            title="Unpaid invoices by age"
            meta="In ₹, split by whether anything has been paid"
            legend={[
              { tone: 'info', label: 'Not yet due' }, { tone: 'wait', label: '1–60 days late' }, { tone: 'late', label: 'Over 60 days late' },
              { tone: 'figure', label: 'Nothing paid yet' }, { tone: 'soft', label: 'Part paid' },
            ]}
            columns={['Age', 'Invoices', 'Nothing paid', 'Part paid', 'Outstanding']}
            rows={d.buckets.map((b) => ({ key: b.key, href: hrefs.ageing(b.key), cells: [b.label, number(b.count), inrFull(b.invoiced), inrFull(b.part_paid), inrFull(b.amount)] }))}
            foot={['Total', number(d.buckets.reduce((n, b) => n + Number(b.count || 0), 0)), inrFull(d.buckets.reduce((n, b) => n + Number(b.invoiced || 0), 0)), inrFull(d.buckets.reduce((n, b) => n + Number(b.part_paid || 0), 0)), inrFull(d.outstanding)]}
            empty={d.outstanding ? null : 'Nothing to chart: no invoice is unpaid.'}
            note={<Note>{d.unconverted.length
              ? `${plural(d.unconverted.length, 'invoice')} in a currency with no rate for the invoice date ${d.unconverted.length === 1 ? 'is' : 'are'} not in these totals: ${d.unconverted.slice(0, 3).map((u) => `${u.invoice_no} ${money(u.amount, u.currency)}`).join(', ')}.`
              : 'Each band opens the chase queue filtered to it.'}</Note>}
          >
            <RowBars
              label="Unpaid invoices by age: open a band for its chase queue"
              lw={96}
              vw={92}
              format={inr}
              rows={d.buckets.map((b) => {
                const tone = AGE_TONE[b.key] || 'wait';
                return {
                  key: b.key,
                  label: b.label,
                  href: hrefs.ageing(b.key),
                  aria: `${b.label}: ${plural(b.count, 'invoice')}, ${inrFull(b.amount)} outstanding, ${inrFull(b.part_paid)} of it part paid. Open the chase queue`,
                  value: inr(b.amount),
                  segs: [{ v: b.invoiced, tone }, { v: b.part_paid, tone: `${tone}-soft` }],
                };
              })}
            />
          </ChartBlock>

          <ChartBlock
            title="Who owes the most that is late"
            meta="Top clients by overdue amount"
            columns={['Client', 'Overdue', 'Outstanding', 'Oldest']}
            rows={d.top_clients.map((c) => ({ key: String(c.company_id ?? c.company), href: hrefs.client(c.company_id), cells: [c.company, inrFull(c.overdue), inrFull(c.outstanding), `${number(c.oldest_days)} days`] }))}
            empty={d.top_clients.length ? null : 'Nothing invoiced is late. Nice.'}
          >
            <RowBars
              label="Who owes the most that is late: open a client"
              lw={124}
              vw={84}
              format={inr}
              rows={d.top_clients.map((c) => ({
                key: String(c.company_id ?? c.company),
                label: c.company,
                href: hrefs.client(c.company_id),
                aria: `${c.company}: ${inrFull(c.overdue)} late of ${inrFull(c.outstanding)} outstanding, oldest ${plural(c.oldest_days, 'day')}. Open the client`,
                value: inr(c.overdue),
                segs: [{ v: c.overdue, tone: 'late' }],
              }))}
            />
          </ChartBlock>

          <ActionList
            title="Chase first"
            empty="Nothing invoiced is late. Nice."
            more={{ to: '/collections', label: 'Open the chase queue' }}
            rows={d.top.map((s) => {
              const meta = `${plural(s.days_overdue, 'day')} late · due ${date(s.due_on)} · ${s.ref}`;
              return {
                key: String(s.stage_id),
                href: hrefs.invoice(s.stage_id),
                title: `${s.company || '—'} · ${s.invoice_no}`,
                meta,
                value: inrFull(s.amount_inr),
                go: { label: 'Chase', aria: `Chase ${s.company || '—'} · ${s.invoice_no}, ${inrFull(s.amount_inr)}, ${meta}` },
              };
            })}
          />
        </>
      )}
    </Question>
  );
}
