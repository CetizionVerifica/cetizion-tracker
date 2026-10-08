import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { Key, MoneyHero, shortDate } from '../components/money.jsx';
import { FailedCard, StateCard, plural } from '../components/daily.jsx';
import { Tone } from '../components/sales.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups, useMediaQuery } from '../lib/hooks.js';
import { money } from '../lib/format.js';

/**
 * Profitability report (#39): margin by project, client, service line,
 * sector or owner, for POs received in a period. Wave 5 shape: the margin
 * as a hero, four figures beside it, then the table with its totals row.
 * The margin badge uses the alert in Settings, not a fixed 20%.
 */
const GROUPS = [{ value: 'project', label: 'By project' }, { value: 'service', label: 'By service line' }, { value: 'client', label: 'By client' }, { value: 'sector', label: 'By sector' }, { value: 'owner', label: 'By sales owner' }];

export default function Profitability() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const alert = Number(lookups.settings?.margin_alert_percent ?? 20) || 20;
  const wide = useMediaQuery('(min-width: 900px)');
  const [group, setGroup] = useState('service');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ group, ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString();
  const { data, loading, error, errorStatus, refetch } = useFetch(() => api.raw(`/profitability?${qs}`), [qs]);
  const rows = data?.data ?? [];
  const sum = (k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0);
  const revenue = sum('revenue');
  const margin = sum('margin');
  const cost = sum('total_cost');
  const committed = sum('cost_committed');
  const paid = Math.max(cost - committed, 0);
  const pct = revenue > 0 ? (100 * margin) / revenue : null;
  const gaps = rows.reduce((t, r) => t + Number(r.gaps ?? (Number(r.cost_gaps || 0) + Number(r.revenue_gaps || 0))), 0);
  const projects = group === 'project' ? rows.length : rows.reduce((t, r) => t + Number(r.projects || 0), 0);
  const under = rows.filter((r) => r.margin_percent != null && Number(r.margin_percent) < alert);
  const loss = rows.filter((r) => r.margin_percent != null && Number(r.margin_percent) < 0);
  const unit = group === 'project' ? 'project' : GROUPS.find((g) => g.value === group).label.replace('By ', '').replace('sales ', '');
  const tone = (p) => (p == null ? 'plain' : p < 0 ? 'late' : p < alert ? 'wait' : 'ok');
  const forbidden = errorStatus === 403;

  const filters = (
    <div className="app-hfilters">
      <label className="mg-field"><span className="mg-label">Group</span>
        <span className="mg-select-wrap"><select className="mg-select" value={group} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}</select></span>
      </label>
      <label className="mg-field"><span className="mg-label">POs from</span><input className="mg-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="mg-field"><span className="mg-label">POs to</span><input className="mg-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
    </div>
  );

  const pctBadge = (r) => (r.margin_percent == null ? <span className="mg-muted">—</span> : <Tone tone={tone(Number(r.margin_percent))}>{r.margin_percent}%</Tone>);
  const cols = group === 'project' ? [
    { h: 'Project', c: (r) => <><span className="app-lead">{r.project_name || r.primary_service || r.project_id}</span><span className="app-sub2">{r.project_id}</span></> },
    { h: 'Client', c: (r) => <>{r.client_name}<span className="app-sub2">{r.primary_service}</span></> },
    { h: 'Revenue', n: true, c: (r) => money(r.revenue) },
    { h: 'Paid cost', n: true, c: (r) => money(r.cost_paid) },
    { h: 'Committed', n: true, c: (r) => (Number(r.cost_committed) ? <span className="mg-money--expected">{money(r.cost_committed)}</span> : <span className="mg-muted">—</span>) },
    { h: 'Margin', n: true, c: (r) => <b className={Number(r.margin) < 0 ? 'text-late' : undefined}>{money(r.margin)}</b> },
    { h: 'Margin %', c: pctBadge },
    { h: 'Planned vs actual cost', n: true, c: (r) => (r.estimated_cost == null ? <span className="mg-muted">—</span> : <>{money(r.estimated_cost)} → <b className={Number(r.total_cost) > Number(r.estimated_cost) ? 'text-late' : undefined}>{money(r.total_cost)}</b></>) },
    { h: 'Gaps', c: (r) => (Number(r.cost_gaps) + Number(r.revenue_gaps) > 0 ? <Tone tone="wait">{plural(Number(r.cost_gaps) + Number(r.revenue_gaps), 'gap')}</Tone> : <span className="mg-muted">—</span>) },
  ] : [
    { h: GROUPS.find((g) => g.value === group).label.replace('By ', '').replace(/^./, (x) => x.toUpperCase()), c: (r) => <span className="app-lead">{r.name}</span> },
    { h: 'Projects', n: true, c: (r) => r.projects },
    { h: 'Revenue', n: true, c: (r) => money(r.revenue) },
    { h: 'Cost', n: true, c: (r) => money(r.total_cost) },
    { h: 'Margin', n: true, c: (r) => <b className={Number(r.margin) < 0 ? 'text-late' : undefined}>{money(r.margin)}</b> },
    { h: 'Margin %', c: pctBadge },
    { h: 'Avg per project', n: true, c: (r) => (r.average_margin_percent == null ? '—' : `${r.average_margin_percent}%`) },
    { h: 'Planned vs actual cost', n: true, c: (r) => (r.estimated_cost == null ? <span className="mg-muted">—</span> : `${money(r.estimated_cost)} → ${money(r.actual_cost_where_estimated)}`) },
    { h: 'Gaps', c: (r) => (r.gaps > 0 ? <Tone tone="wait">{plural(r.gaps, 'gap')}</Tone> : <span className="mg-muted">—</span>) },
  ];

  return (
    <>
      <PageHeader title="Profitability" subtitle="Margin on delivered work: PO value against travel, claims and other delivery costs, in INR. Periods follow the PO date." actions={!forbidden && filters} />
      <div className="app-page">
        {forbidden ? (
          <StateCard tone="plain" icon={Lock} title="Margins are for admins" text="What the business earns on a project is shown to admins only, unless an admin opens it to sales in Settings.">
            <Link to="/" className="mg-btn mg-btn--sm">Back to Today</Link>
          </StateCard>
        ) : error ? (
          <FailedCard title="Couldn't load the margins" text={`No figures are shown rather than wrong ones. (${error})`} onRetry={refetch} />
        ) : loading && !data ? (
          <div aria-busy="true" aria-label="Loading the margins" className="flex flex-col gap-[18px]">
            <div className="app-mrow">
              <section className="mg-glass mg-panel" style={{ flex: '1 1 400px', minHeight: 230 }}><div className="mg-skel" style={{ height: 56, width: '70%' }} /><div className="mg-skel" style={{ height: 10, marginTop: 'auto' }} /></section>
              <section className="mg-glass mg-panel" style={{ flex: '1.35 1 520px', minHeight: 230 }}><div className="mg-skel" style={{ height: 50 }} /><div className="mg-skel" style={{ height: 50 }} /></section>
            </div>
            <section className="mg-glass mg-panel">{[0, 1, 2, 3].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</section>
          </div>
        ) : !rows.length ? (
          <StateCard tone="plain" title="Nothing delivered in this period" text="Margin is counted when a project is delivered. Widen the dates, or group by something else." />
        ) : (
          <>
            <div className="app-mrow">
              <MoneyHero
                label="Margin on delivered work"
                figure={money(margin)}
                count={margin}
                figureAside={pct == null ? null : `${pct.toFixed(1)}%`}
                sub={`On ${money(revenue)} of revenue from ${plural(projects, 'delivered project')}${from || to ? `, POs dated ${from ? shortDate(from) : 'the start'} to ${to ? shortDate(to) : 'today'}` : ''}. Gaps are left out until they have amounts.`}
                done={revenue ? (100 * paid) / revenue : 0}
                expected={revenue ? (100 * committed) / revenue : 0}
                aria={`Paid cost ${money(paid)}, committed ${money(committed)}, margin ${money(margin)}`}
                legend={<>
                  <Key swatch={{ background: 'var(--on-hero)' }}>Paid cost <strong>{money(paid)}</strong></Key>
                  <Key swatch="hatch">Committed <strong>{money(committed)}</strong></Key>
                  <Key swatch="empty">Margin <strong>{money(margin)}</strong></Key>
                </>}
              />
              <section className="mg-glass app-mrow__side app-quad" data-a="rise" aria-label="Revenue, cost, gaps and the margin alert">
                <div><span className="mg-label">Revenue</span><span className="mg-tile__figure mg-num">{money(revenue)}</span><span className="mg-tile__foot">PO value of {plural(projects, 'delivered project')}.</span></div>
                <div><span className="mg-label">Cost</span><span className="mg-tile__figure mg-num">{money(cost)}</span><span className="mg-tile__foot"><span className="mg-money--expected font-bold">{money(committed)}</span> committed, not paid yet</span></div>
                <div><span className="mg-label">Gaps</span><span className={cn('mg-tile__figure mg-num', gaps && 'text-late')}>{gaps}</span><span className="mg-tile__foot">Costs or POs with no amount or rate, left out of the margin.</span></div>
                <div><span className="mg-label">Under the margin alert</span><span className={cn('mg-tile__figure mg-num', under.length && 'is-wait-text')}>{plural(under.length, unit)}</span><span className="mg-tile__foot">Below {alert}% margin{loss.length ? ` · ${loss.length} at a loss` : ''}</span></div>
              </section>
            </div>

            <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="prof-t">
              <div className="app-panel__head">
                <h2 className="mg-panel__title" id="prof-t">{GROUPS.find((g) => g.value === group).label}</h2>
                <Tone>{plural(rows.length, unit)}</Tone>
                <span className="mg-panel__hint">{group === 'project' ? 'Lowest margin first. Open a project for its costs.' : 'Highest margin first.'}</span>
                <span className="mg-legend ml-auto"><Key swatch={{ background: 'var(--late)' }}>Below 0%</Key><Key swatch={{ background: 'var(--caramel)' }}>Below {alert}%, the margin alert in Settings</Key></span>
              </div>
              {wide ? (
                <div className="mg-tablewrap app-panel__body">
                  <table className="mg-table" aria-label={`Margin ${GROUPS.find((g) => g.value === group).label.toLowerCase()}`}>
                    <thead><tr>{cols.map((c) => <th key={c.h} className={c.n ? 'num' : undefined}>{c.h}</th>)}</tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={r.project_id || r.name || i} className={group === 'project' ? 'is-clickable' : undefined} onClick={group === 'project' ? (e) => { if (!e.target.closest('a,button')) navigate(`/projects/${r.project_id}`); } : undefined}>
                          {cols.map((c) => <td key={c.h} className={c.n ? 'num' : undefined}>{c.c(r)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="app-total">
                        <td>All {group === 'project' ? 'delivered projects' : `${unit}s`}</td>
                        {group !== 'project' && <td className="num">{projects}</td>}
                        {group === 'project' && <td />}
                        <td className="num">{money(revenue)}</td>
                        {group === 'project' ? <><td className="num">{money(sum('cost_paid'))}</td><td className="num">{money(committed)}</td></> : <td className="num">{money(cost)}</td>}
                        <td className="num">{money(margin)}</td>
                        <td>{pct == null ? '—' : `${pct.toFixed(1)}%`}</td>
                        {group !== 'project' && <td />}
                        <td className="num">{sum('estimated_cost') ? `${money(sum('estimated_cost'))} → ${money(group === 'project' ? rows.filter((r) => r.estimated_cost != null).reduce((t, r) => t + Number(r.total_cost || 0), 0) : sum('actual_cost_where_estimated'))}` : '—'}</td>
                        <td>{gaps || '—'}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <div className="mg-rows app-panel__body">
                  {rows.map((r, i) => {
                    const title = group === 'project' ? `${r.client_name} · ${r.project_id}` : r.name;
                    const inner = (
                      <>
                        <span className="mg-row__title" style={{ whiteSpace: 'normal' }}>{title}</span>
                        <span className={cn('mg-row__amount mg-num', Number(r.margin) < 0 && 'text-late')}>{money(r.margin)}</span>
                        <span className="mg-row__meta" style={{ whiteSpace: 'normal' }}>{money(r.revenue)} revenue · {money(r.total_cost)} cost{(r.gaps || Number(r.cost_gaps) + Number(r.revenue_gaps)) ? ` · ${plural(r.gaps ?? Number(r.cost_gaps) + Number(r.revenue_gaps), 'gap')}` : ''}</span>
                        <span className="mg-row__state">{pctBadge(r)}</span>
                      </>
                    );
                    return group === 'project'
                      ? <Link key={r.project_id} to={`/projects/${r.project_id}`} className="mg-row app-row no-underline">{inner}</Link>
                      : <div key={r.name || i} className="mg-row">{inner}</div>;
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
