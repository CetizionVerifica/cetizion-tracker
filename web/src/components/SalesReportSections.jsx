import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Download, TriangleAlert } from 'lucide-react';
import { ChartBlock, ChartEmpty, ColBars, Note, RowBars, inr, inrFull } from './charts.jsx';
import { Question, Seg } from './insights/shared.jsx';
import { api } from '../lib/api.js';
import { useMediaQuery } from '../lib/hooks.js';
import { date, money, number } from '../lib/format.js';
import { bucketEnd, bucketStart, drillLink } from '../lib/reportPeriods.js';

/**
 * The Reports section's six questions (docs/sales-report-rework-plan.md §3),
 * drawn from one /api/reports/sales response. Each question is a glass panel
 * titled with its question and opening with the sentence the server wrote
 * from the figures — the same sentence the PDF prints.
 *
 * Every bar is named and labelled with its value, so colour never has to say
 * which is which; Other and Not set take the quiet outlined fill. Every bar,
 * and the first cell of every row in its table twin, opens the records behind
 * it (drillLink), and the list runs the same rules the chart did.
 */

const nPct = (count, pct) => (pct == null ? number(count) : `${number(count)} · ${pct}%`);
const plural = (n, one, many = `${one}s`) => `${number(n)} ${n === 1 ? one : many}`;
const short = (d) => { const s = date(d); return s === '—' ? s : s.slice(0, -5); };

/** The strip under the filters: four numbers, each a door into its section's records. */
export function SummaryStrip({ report, scope }) {
  const converted = report.outcomes.slices.find((s) => s.key === 'converted');
  const tiles = [
    { key: 'e', label: 'Enquiries', figure: number(report.enquiries.total), foot: 'received in the period', to: drillLink('enquiries', scope) },
    { key: 'c', label: 'Converted to PO', figure: nPct(converted.count, converted.pct), foot: 'of those enquiries, by the period\'s end', to: drillLink('enquiries', scope, { outcome: 'converted' }) },
    { key: 'p', label: 'PO value', figure: `${number(report.revenue.total.pos)} · ${inrFull(report.revenue.total.po_value_inr)}`, foot: 'incl. GST, by PO date', to: drillLink('purchase-orders', scope) },
    { key: 'n', label: 'New customers', figure: number(report.customers.tiles.new_customers), foot: 'first-ever PO in the period', to: drillLink('purchase-orders', scope, { customer: 'new' }) },
  ];
  return (
    <section className="mg-glass mg-strip rp-strip2" data-a="rise" aria-label="The period at a glance">
      {tiles.map((t) => (
        <Link key={t.key} className="rp-tile" to={t.to}>
          <span className="mg-label">{t.label}</span>
          <span className="mg-tile__figure mg-num">{t.figure}</span>
          <span className="mg-tile__foot">{t.foot}</span>
        </Link>
      ))}
    </section>
  );
}

/** The section CSVs for the report on screen: same period, grain and owner. */
const csvHref = (name, scope) => api.reportCsvUrl(name, {
  from: scope.from, to: scope.to, ...(scope.grain && { grain: scope.grain }), ...(scope.owner && { owner: scope.owner }),
});

function Csvs({ scope, csv }) {
  return csv.map(([name, label]) => (
    <a key={name} className="mg-btn mg-btn--ghost mg-btn--sm" href={csvHref(name, scope)} download>
      <Download className="size-4" strokeWidth={1.8} aria-hidden="true" />{label}
    </a>
  ));
}

/** A question as Reports asks it: always loaded, with its CSVs beside the title. */
function Section({ n, question, answer, children, wide = false, scope, csv = [] }) {
  return (
    <Question n={n} question={question} answer={answer} wide={wide} data={{}} tools={<Csvs scope={scope} csv={csv} />}>
      {children}
    </Question>
  );
}

/* --------------------------------------------------------- 1. enquiries */

export function EnquiriesSection({ report, scope, onGrain }) {
  const { enquiries } = report;
  const grain = enquiries.grain;
  const linkFor = (b) => (b.key
    ? drillLink('enquiries', { ...scope, from: bucketStart(b.key, grain, scope.from), to: bucketEnd(b.key, grain, scope.to) })
    : null);
  const rows = enquiries.buckets.filter((b) => b.key);
  const undated = enquiries.buckets.find((b) => !b.key && b.enquiries);
  const sources = enquiries.sources.map((s) => `${s.name} ${number(s.enquiries)}`).join(' · ');
  const many = rows.length > 16;

  return (
    <Section n={1} scope={scope} csv={[['enquiries', 'Enquiries (CSV)']]} question="How many enquiries did we receive?" answer={report.narrative.enquiries}>
      {() => (
        <ChartBlock
          title={`Enquiries per ${grain}`}
          meta={`${number(enquiries.total)} in the period${enquiries.average_per_bucket != null ? ` · ${enquiries.average_per_bucket} a ${grain} on average` : ''}`}
          tools={(
            <div className="rp-sel">
              <label className="rp-ctl" htmlFor="r-grain">Group by</label>
              <span className="mg-select-wrap">
                <select className="mg-select" id="r-grain" value={grain} onChange={(e) => onGrain(e.target.value)}>
                  <option value="month">Month</option><option value="week">Week</option><option value="day">Day</option>
                </select>
              </span>
            </div>
          )}
          columns={[grain[0].toUpperCase() + grain.slice(1), 'Enquiries']}
          rows={enquiries.buckets.map((b) => ({ key: b.key ?? 'undated', href: linkFor(b), cells: [b.label, number(b.enquiries)] }))}
          foot={['Total', number(enquiries.total)]}
          empty={enquiries.total ? null : 'Nothing to chart for this period. Try a longer period, such as This FY.'}
          emptyPlain
          note={<Note>{[sources && `By source: ${sources}.`, undated && `The table also counts the ${plural(undated.enquiries, 'enquiry', 'enquiries')} with no date.`].filter(Boolean).join(' ')}</Note>}
        >
          <ColBars
            label={`Enquiries per ${grain}: open a ${grain} for its enquiries`}
            height={170}
            rows={rows.map((b) => ({
              key: b.key,
              label: b.label,
              href: linkFor(b),
              aria: `${b.label}: ${plural(b.enquiries, 'enquiry', 'enquiries')}. Open the list`,
              value: many ? '' : number(b.enquiries),
              segs: [{ v: b.enquiries, tone: 'figure' }],
            }))}
          />
        </ChartBlock>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- 2. outcomes */

const OUTCOME_TONE = { converted: 'figure', pipeline: 'hatch', quoted_not_won: 'soft', lost: 'soft' };

export function OutcomesSection({ report, scope }) {
  const { outcomes } = report;
  const reasons = outcomes.quoted_not_won_reasons.map((r) => `${r.reason} ${r.count}`).join(' · ');
  const months = outcomes.months.filter((m) => m.key && m.enquiries);
  const any = outcomes.slices.some((s) => s.count);

  return (
    <Section n={2} scope={scope} csv={[['outcomes', 'Outcomes (CSV)']]} question="What happened to them?" answer={report.narrative.outcomes}>
      {() => (
        <ChartBlock
          title="Enquiry outcome"
          meta="As things stood at the end of the period. Lost means closed without a quotation."
          legend={[{ tone: 'figure', label: 'Became a PO' }, { tone: 'hatch', label: 'Still open' }, { tone: 'soft', label: 'Closed without a PO' }]}
          columns={['Outcome', 'Enquiries', 'Share']}
          rows={outcomes.slices.map((s) => ({ key: s.key, href: drillLink('enquiries', scope, { outcome: s.key }), cells: [s.label, number(s.count), s.pct == null ? '—' : `${s.pct}%`] }))}
          empty={any ? null : 'No enquiries in this period, so there is nothing to follow.'}
          emptyPlain
          note={(
            <>
              <Note>{`In pipeline: ${number(outcomes.pipeline.not_quoted)} not yet quoted, ${number(outcomes.pipeline.quoted)} quoted and awaiting a decision.`}</Note>
              <Note>{reasons && `Quoted, not won: ${reasons}.`}</Note>
              <Note>{months.length > 1 && `Converted by month: ${months.map((m) => `${m.label} ${m.converted.pct ?? 0}%`).join(' · ')}.`}</Note>
            </>
          )}
        >
          <RowBars
            label="Enquiry outcome: open an outcome for its enquiries"
            lw={120}
            vw={84}
            rows={outcomes.slices.map((s) => ({
              key: s.key,
              label: s.label,
              href: drillLink('enquiries', scope, { outcome: s.key }),
              aria: `${s.label}: ${plural(s.count, 'enquiry', 'enquiries')}${s.pct == null ? '' : `, ${s.pct}%`}. Open the list`,
              value: nPct(s.count, s.pct),
              segs: [{ v: s.count, tone: OUTCOME_TONE[s.key] || 'figure' }],
            }))}
          />
        </ChartBlock>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- 3. sectors */

export function SectorsSection({ report, scope }) {
  const { sectors } = report;
  const other = sectors.rows.find((r) => r.sector === 'Other');
  return (
    <Section n={3} scope={scope} csv={[['sector-pos', 'POs by sector (CSV)']]} question="Which sectors gave us POs?" answer={report.narrative.sectors}>
      {() => (
        <ChartBlock
          title="POs by sector"
          meta="Count, with PO value incl. GST"
          columns={['Sector', 'POs', 'Share', 'PO value']}
          rows={sectors.rows.map((r) => ({ key: r.sector, href: drillLink('purchase-orders', scope, { sector: r.sector }), cells: [r.sector, number(r.pos), r.pct == null ? '—' : `${r.pct}%`, inrFull(r.value_inr)] }))}
          empty={sectors.rows.some((r) => r.pos) ? null : 'No POs in this period, so no sector to show.'}
          emptyPlain
          note={other?.raw.length ? <Note>Other is: {other.raw.map((r) => `${r.name} ${r.pos}`).join(' · ')}. <Link to="/settings/reports">Settings › Report categories</Link> counts a spelling under a headline sector.</Note> : null}
        >
          <RowBars
            label="POs by sector: open a sector for its POs"
            lw={124}
            vw={96}
            rows={sectors.rows.map((r) => ({
              key: r.sector,
              label: r.sector,
              href: drillLink('purchase-orders', scope, { sector: r.sector }),
              aria: `${r.sector}: ${plural(r.pos, 'PO')}, ${inrFull(r.value_inr)}. Open the list`,
              value: `${number(r.pos)} · ${inr(r.value_inr)}`,
              segs: [{ v: r.pos, tone: r.other || r.sector === 'Other' ? 'soft' : 'figure' }],
            }))}
          />
        </ChartBlock>
      )}
    </Section>
  );
}

/* --------------------------------------------------------- 4. services */

export function ServicesSection({ report, scope }) {
  const { services } = report;
  const [by, setBy] = useState('value');
  const key = by === 'value' ? 'value_inr' : 'pos';
  const rows = [...services.rows].sort((a, b) => a.other - b.other || b[key] - a[key]);
  const source = services.sources;

  return (
    <Section n={4} scope={scope} csv={[['services', 'Service lines (CSV)']]} question="Which services sell best?" answer={report.narrative.services}>
      {() => (
        <ChartBlock
          title={`Service lines by ${by === 'value' ? 'PO value' : 'number of POs'}`}
          meta="A PO naming several services splits its value between them"
          tools={<Seg label="Rank service lines by" value={by} width={86} options={[{ value: 'value', label: 'By value' }, { value: 'count', label: 'By count' }]} onChange={setBy} />}
          columns={['Service line', 'POs', 'PO value', 'Share of value']}
          rows={rows.map((r) => ({ key: r.line, href: drillLink('purchase-orders', scope, { service: r.line }), cells: [r.line, number(r.pos), inrFull(r.value_inr), r.pct == null ? '—' : `${r.pct}%`] }))}
          empty={rows.some((r) => r.pos) ? null : 'No POs in this period, so no service to rank.'}
          emptyPlain
          note={<Note>{`A PO counts once in each line it names. Split from: ${number(source.po_services)} PO service lines, ${number(source.quotation_lines)} quotation lines, ${number(source.keywords)} service text.`}</Note>}
        >
          <RowBars
            label="Service lines: open a line for its POs"
            lw={150}
            vw={110}
            format={by === 'value' ? inr : number}
            rows={rows.map((r) => ({
              key: r.line,
              label: r.line,
              href: drillLink('purchase-orders', scope, { service: r.line }),
              aria: `${r.line}: ${inrFull(r.value_inr)}, ${plural(r.pos, 'PO')}. Open the list`,
              value: by === 'value' ? `${inr(r.value_inr)} · ${plural(r.pos, 'PO')}` : `${plural(r.pos, 'PO')} · ${inr(r.value_inr)}`,
              segs: [{ v: r[key], tone: r.other ? 'soft' : 'figure' }],
            }))}
          />
        </ChartBlock>
      )}
    </Section>
  );
}

/* --------------------------------------------------------- 5. customers */

const OUTCOME_LABEL = { converted: 'Converted to PO', pipeline: 'In pipeline', quoted_not_won: 'Quoted, not won', lost: 'Lost' };
const OUTCOME_BADGE = { converted: 'ok', pipeline: 'info', quoted_not_won: 'wait', lost: 'late' };
const SHOWN = 6;

export function CustomersSection({ report, scope }) {
  const { customers } = report;
  const t = customers.tiles;
  const wide = useMediaQuery('(min-width: 720px)');
  const newEnq = customers.new_customer_enquiries;
  const repeat = customers.repeat_orders;
  const tiles = [
    { key: 'n', label: 'New customers', figure: number(t.new_customers), foot: 'first-ever PO in the period', to: drillLink('purchase-orders', scope, { customer: 'new' }) },
    { key: 'e', label: 'Existing customers', figure: number(t.existing_customers), foot: 'ordered before the period too', to: drillLink('purchase-orders', scope, { customer: 'existing' }) },
    { key: 'r', label: 'Repeat orders', figure: number(t.repeat_orders), foot: `${inrFull(t.repeat_value_inr)} of PO value`, to: drillLink('purchase-orders', scope, { customer: 'repeat' }) },
    { key: 's', label: 'Repeat share of value', figure: t.repeat_share_pct == null ? '—' : `${t.repeat_share_pct}%`, foot: `first orders ${inrFull(t.first_order_value_inr)}` },
  ];
  const poLink = (r) => `/purchase-orders?q=${encodeURIComponent(r.po_number)}`;
  return (
    <Section
      n={5}
      wide
      scope={scope}
      csv={[['new-customers', 'New-customer enquiries (CSV)'], ['repeat-orders', 'Repeat orders (CSV)']]}
      question="Who were our new customers, and who came back?"
      answer={report.narrative.customers}
    >
      {() => (
        <>
          <div className="mg-strip rp-instrip">
            {tiles.map((x) => {
              const inner = <><span className="mg-label">{x.label}</span><span className="mg-tile__figure mg-num">{x.figure}</span><span className="mg-tile__foot">{x.foot}</span></>;
              return x.to ? <Link key={x.key} className="rp-tile" to={x.to}>{inner}</Link> : <div key={x.key} className="rp-tile">{inner}</div>;
            })}
          </div>
          <div className="rp-sub">
            <div className="rp-block">
              <div className="rp-bhead">
                <h3 className="rp-btitle">Enquiries from new customers</h3>
                <span className="mg-panel__hint">{number(t.enquiries_from_new)} of {number(t.enquiries_from_new + t.enquiries_from_existing)} · no PO before the enquiry</span>
                <Link className="rp-link" to={drillLink('enquiries', scope, { customer: 'new' })} style={{ marginLeft: 'auto', fontSize: 12.5 }}>Open the list</Link>
              </div>
              {!newEnq.length ? <ChartEmpty plain>No enquiries from new customers in this period.</ChartEmpty> : wide ? (
                <div className="mg-tablewrap rp-twin">
                  <table className="mg-table">
                    <caption className="sr-only">Enquiries from new customers</caption>
                    <thead><tr><th scope="col">Enquiry</th><th scope="col">Client</th><th scope="col">Received</th><th scope="col">Outcome</th></tr></thead>
                    <tbody>
                      {newEnq.slice(0, SHOWN).map((r) => (
                        <tr key={r.enquiry_no}>
                          <td className="strong mg-num">{r.enquiry_no}</td>
                          <td>{r.client}</td>
                          <td className="mg-num">{short(r.date)}</td>
                          <td><span className={`mg-badge mg-badge--${OUTCOME_BADGE[r.outcome] || 'plain'}`}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mg-rows rp-twin">
                  {newEnq.slice(0, SHOWN).map((r) => (
                    <div key={r.enquiry_no} className="mg-row">
                      <span className="mg-row__title">{r.client}</span>
                      <span className="mg-row__state"><span className={`mg-badge mg-badge--${OUTCOME_BADGE[r.outcome] || 'plain'}`}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</span></span>
                      <span className="mg-row__meta" style={{ gridColumn: '1 / -1' }}>{r.enquiry_no} · received {short(r.date)}</span>
                    </div>
                  ))}
                </div>
              )}
              {newEnq.length > SHOWN && <Note>Showing {SHOWN} of {number(newEnq.length)}. <Link to={drillLink('enquiries', scope, { customer: 'new' })}>Open the list</Link> for all of them.</Note>}
            </div>
            <div className="rp-block">
              <div className="rp-bhead">
                <h3 className="rp-btitle">Repeat orders from existing customers</h3>
                <span className="mg-panel__hint">{plural(t.repeat_orders, 'PO')}</span>
                <Link className="rp-link" to={drillLink('purchase-orders', scope, { customer: 'repeat' })} style={{ marginLeft: 'auto', fontSize: 12.5 }}>Open the list</Link>
              </div>
              {!repeat.length ? <ChartEmpty plain>No repeat orders in this period.</ChartEmpty> : wide ? (
                <div className="mg-tablewrap rp-twin">
                  <table className="mg-table">
                    <caption className="sr-only">Repeat orders from existing customers</caption>
                    <thead><tr><th scope="col">Client</th><th scope="col">PO</th><th scope="col" className="num">PO value</th><th scope="col" className="num">Earlier POs</th></tr></thead>
                    <tbody>
                      {repeat.slice(0, SHOWN).map((r) => (
                        <tr key={r.po_number}>
                          <td className="strong">{r.customer}<span className="sub">{r.service}</span></td>
                          <td className="mg-num"><Link className="rp-link" to={poLink(r)}>{r.po_number}</Link><span className="sub">{short(r.po_date)}</span></td>
                          <td className="num strong">{inrFull(r.po_value_inr)}</td>
                          <td className="num">{number(r.previous_orders)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mg-rows rp-twin">
                  {repeat.slice(0, SHOWN).map((r) => (
                    <Link key={r.po_number} className="mg-row" to={poLink(r)}>
                      <span className="mg-row__title">{r.customer}</span>
                      <span className="mg-row__amount mg-num"><span className="rp-rl">PO value</span>{inrFull(r.po_value_inr)}</span>
                      <span className="mg-row__meta" style={{ gridColumn: '1 / -1' }}>{[r.po_number, short(r.po_date), r.service, `${plural(r.previous_orders, 'earlier PO')}`].filter(Boolean).join(' · ')}</span>
                    </Link>
                  ))}
                </div>
              )}
              {repeat.length > SHOWN && <Note>Showing the newest {SHOWN} of {number(repeat.length)}. <Link to={drillLink('purchase-orders', scope, { customer: 'repeat' })}>Open the list</Link> for all of them.</Note>}
            </div>
          </div>
        </>
      )}
    </Section>
  );
}

/* ----------------------------------------------------------- 6. revenue */

export function RevenueSection({ report, scope }) {
  const { revenue } = report;
  const months = revenue.months.filter((m) => m.key);
  const withPos = revenue.months.filter((m) => m.pos);
  const [open, setOpen] = useState(null);

  return (
    <Section n={6} wide scope={scope} csv={[['revenue', 'Months (CSV)'], ['revenue-pos', 'POs (CSV)']]} question="How much did we sell each month?" answer={report.narrative.revenue}>
      {() => (
        <div className="flex flex-col">
          <ChartBlock
            title="PO value incl. GST, per month"
            meta="Counting POs by PO date, in ₹ at the rate on the PO date. Not net of GST."
            columns={['Month', 'POs', 'PO value incl. GST', 'Invoiced', 'Received']}
            rows={revenue.months.map((m) => ({
              key: m.key ?? 'undated',
              href: m.key ? drillLink('purchase-orders', scope, { month: m.key }) : null,
              cells: [m.label, number(m.pos), inrFull(m.po_value_inr), inrFull(m.invoiced_inr), inrFull(m.received_inr)],
            }))}
            foot={['Total', number(revenue.total.pos), inrFull(revenue.total.po_value_inr), inrFull(revenue.total.invoiced_inr), inrFull(revenue.total.received_inr)]}
            empty={withPos.length ? null : 'No POs in this period.'}
            emptyPlain
            note={<Note>Invoiced and received are dated by the invoice and the payment, so they are the billing and cash view of each month, not a split of its PO value.</Note>}
          >
            <ColBars
              label="PO value per month: open a month for its POs"
              height={190}
              format={inr}
              rows={months.map((m) => ({
                key: m.key,
                label: m.label,
                href: drillLink('purchase-orders', scope, { month: m.key }),
                aria: `${m.label}: ${plural(m.pos, 'PO')}, ${inrFull(m.po_value_inr)}. Open the list`,
                value: months.length <= 12 ? inr(m.po_value_inr) : '',
                segs: [{ v: m.po_value_inr, tone: 'figure' }],
              }))}
            />
          </ChartBlock>

          {withPos.length > 0 && (
            <div className="rp-block">
              <div className="rp-bhead"><h3 className="rp-btitle">The sales behind each month</h3><span className="mg-panel__hint">Open a month to see its POs</span></div>
              <div>
                {withPos.map((m) => {
                  const k = m.key ?? 'undated';
                  const on = open === k;
                  return (
                    <div key={k}>
                      <button type="button" className="rp-disc" aria-expanded={on} onClick={() => setOpen(on ? null : k)}>
                        <ChevronRight className="size-4" strokeWidth={1.8} aria-hidden="true" />
                        <strong>{m.label}</strong>
                        <span className="rp-disc__n">{plural(m.pos, 'PO')}</span>
                        <strong className="mg-num">{inrFull(m.po_value_inr)}</strong>
                      </button>
                      {on && <MonthDetail m={m} />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

const poValue = (r) => (r.po_value_inr == null ? (r.po_value == null ? 'No value' : money(r.po_value, r.currency)) : inrFull(r.po_value_inr));

function MonthDetail({ m }) {
  const wide = useMediaQuery('(min-width: 720px)');
  const link = (r) => `/purchase-orders?q=${encodeURIComponent(r.po_number)}`;
  return (
    <div className="rp-month">
      {wide ? (
        <div className="mg-tablewrap rp-twin">
          <table className="mg-table">
            <caption className="sr-only">POs in {m.label}</caption>
            <thead><tr><th scope="col">PO</th><th scope="col">Client</th><th scope="col">Service</th><th scope="col" className="num">PO value</th><th scope="col" className="num">Invoiced</th><th scope="col" className="num">Received</th></tr></thead>
            <tbody>
              {m.detail.map((r) => (
                <tr key={r.po_number}>
                  <td className="strong"><Link className="rp-link" to={link(r)}>{r.po_number}</Link><span className="sub">{r.po_date ? short(r.po_date) : 'No date'}</span></td>
                  <td>{r.client}<span className="sub">{r.sector}</span></td>
                  <td>{r.service}<span className="sub">Owner: {r.owner || '—'}</span></td>
                  <td className="num strong">{poValue(r)}</td>
                  <td className="num">{inrFull(r.invoiced_inr)}</td>
                  <td className="num">{inrFull(r.received_inr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mg-rows rp-twin">
          {m.detail.map((r) => (
            <Link key={r.po_number} className="mg-row" to={link(r)}>
              <span className="mg-row__title">{r.client}</span>
              <span className="mg-row__amount mg-num"><span className="rp-rl">PO value</span>{poValue(r)}</span>
              <span className="mg-row__meta" style={{ gridColumn: '1 / -1' }}>
                {[r.po_number, r.po_date ? short(r.po_date) : 'No date', r.service, r.owner, `Invoiced ${inrFull(r.invoiced_inr)}`, `Received ${inrFull(r.received_inr)}`].filter(Boolean).join(' · ')}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- notes */

/** What limits the figures, each with the list where it can be fixed. */
export function DataNotes({ notes, staleRates }) {
  if (!notes.length && !staleRates?.length) return null;
  return (
    <div className="mg-banner mg-banner--wait mg-glass" role="note" data-a="rise">
      <TriangleAlert aria-hidden="true" />
      <div className="mg-banner__body">
        <strong>About these figures</strong>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {notes.map((n) => (
            <li key={n.key}>{n.text}{n.href && <> <Link className="rp-link" to={n.href}>Fix</Link></>}</li>
          ))}
          {staleRates?.map((r) => (
            <li key={r.currency}>The newest {r.currency} rate is from {date(r.effective_from)}; recent amounts convert at it. <Link className="rp-link" to="/settings/rates">Add rates</Link></li>
          ))}
        </ul>
      </div>
    </div>
  );
}
