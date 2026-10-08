import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, CircleAlert, RefreshCw } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { EnquiryRiskSection } from '../components/insights/EnquiryRiskSection.jsx';
import { FollowUpsSection } from '../components/insights/FollowUpsSection.jsx';
import { PoPipelineSection } from '../components/insights/PoPipelineSection.jsx';
import { ReceivablesSection } from '../components/insights/ReceivablesSection.jsx';
import { RevenueSection } from '../components/insights/RevenueSection.jsx';
import { TouchDialog } from '../components/Timeline.jsx';
import { inrFull } from '../components/charts.jsx';
import { useEntrance } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { number } from '../lib/format.js';
import { hrefs, queryString, readFilters, tones } from '../lib/insights.js';

/**
 * Insights (docs/insights-dashboard-plan.md): five questions, each answered
 * with a chart that clicks through to the records behind it.
 *
 * The filters live in the address bar, so a link carries them. A sales user
 * sees their own records; an admin sees everyone's, or one owner's.
 * Everything is in ₹ at the rate on each record's own date.
 */
const clock = (t) => t && new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });

export default function Insights() {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const { isAdmin } = useAuth();
  const qs = queryString({ owner: filters.owner, granularity: filters.granularity, horizon: filters.horizon, basis: filters.basis });
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/insights${qs}`), [qs]);
  const d = data?.data;
  // The hero is always the next three months on cash basis, whatever Q5 shows.
  const heroOwn = filters.basis === 'cash' && filters.granularity === 'month';
  const heroQs = queryString({ owner: filters.owner, granularity: 'month', horizon: '3', basis: 'cash' });
  const heroFetch = useFetch(() => (heroOwn ? Promise.resolve(null) : api.raw(`/insights${heroQs}`)), [heroOwn, heroQs]);
  const heroRev = heroOwn ? d?.revenue : heroFetch.data?.data?.revenue;
  const [touch, setTouch] = useState(null);
  const [updated, setUpdated] = useState(null);
  useEffect(() => { if (d && !loading) setUpdated(Date.now()); }, [d, loading]);
  const ref = useEntrance(Boolean(d));

  // Back on the tab after logging a call elsewhere: the numbers should know.
  // At most once a minute, so flicking between windows is not a reload each time.
  const lastFocus = useRef(Date.now());
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastFocus.current < 60_000) return;
      lastFocus.current = Date.now();
      refetch();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refetch]);

  const set = (key, value, fallback) => {
    const next = new URLSearchParams(params);
    if (!value || value === fallback) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };

  const owner = filters.owner;
  const showOwners = Boolean(d?.scope?.unrestricted);
  const shared = { loading, onRetry: refetch, settings: d?.settings, owner };
  const ownerName = d?.owners?.find((o) => String(o.id) === owner)?.name;
  const busy = loading && Boolean(d);
  const allFailed = d && ['follow_ups', 'receivables', 'enquiry_risk', 'po_pipeline', 'revenue'].every((k) => d[k]?.error);

  return (
    <>
      <PageHeader
        eyebrow="Overview"
        title="Insights"
        subtitle={`${ownerName ? `${ownerName}'s records. ` : isAdmin ? 'Everyone\'s records. ' : 'Your records. '}All figures in ₹ at the rate on each record's own date. Every bar opens the list behind it.`}
        actions={(
          <>
            {isAdmin && (
              <div className="rp-sel">
                <label className="rp-ctl" htmlFor="ins-owner">Whose records</label>
                <span className="mg-select-wrap">
                  <select className="mg-select" id="ins-owner" value={owner} onChange={(e) => set('owner', e.target.value, '')}>
                    <option value="">Everyone</option>
                    {(d?.owners || []).map((o) => <option key={o.id} value={String(o.id)}>{o.name}</option>)}
                  </select>
                </span>
              </div>
            )}
            <span className="rp-ctl" role="status" style={{ color: 'var(--muted)', fontWeight: 600 }}>
              {busy ? 'Fetching new figures' : updated ? `Updated ${clock(updated)}` : ''}
            </span>
            <button type="button" className="mg-btn mg-btn--sm" onClick={refetch} aria-disabled={loading || undefined} disabled={loading}>
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.8} aria-hidden="true" />{busy ? 'Refreshing…' : 'Refresh'}
            </button>
          </>
        )}
      />
      <div className="app-page" ref={ref}>
        {error && !d ? (
          <section className="mg-glass mg-empty" data-a="rise" role="alert" style={{ padding: '72px 24px' }}>
            <span className="mg-empty__mark" style={{ color: 'var(--late)', background: 'var(--late-soft)' }}><CircleAlert className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
            <h2 className="mg-empty__title">Couldn't load insights</h2>
            <p className="mg-empty__text">{error} None of the five questions could be worked out. Nothing has changed in your records.</p>
            <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}><RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Try again</button>
          </section>
        ) : allFailed ? (
          <section className="mg-glass mg-empty" data-a="rise" role="alert" style={{ padding: '72px 24px' }}>
            <span className="mg-empty__mark" style={{ color: 'var(--late)', background: 'var(--late-soft)' }}><CircleAlert className="size-6" strokeWidth={1.8} aria-hidden="true" /></span>
            <h2 className="mg-empty__title">Couldn't load insights</h2>
            <p className="mg-empty__text">The server didn't answer, so none of the five questions could be worked out. Nothing has changed in your records.</p>
            <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}><RefreshCw className="size-4" strokeWidth={1.8} aria-hidden="true" />Try again</button>
          </section>
        ) : (
          <>
            <Top d={d} heroRev={heroRev} heroLoading={heroOwn ? loading && !d : heroFetch.loading && !heroFetch.data} owner={owner} />
            <div className="rp-grid">
              <FollowUpsSection {...shared} data={d?.follow_ups} showOwners={showOwners} onTouch={setTouch} />
              <ReceivablesSection {...shared} data={d?.receivables} />
              <EnquiryRiskSection {...shared} data={d?.enquiry_risk} showOwners={showOwners} onTouch={setTouch} />
              <PoPipelineSection {...shared} data={d?.po_pipeline} />
              <RevenueSection
                {...shared}
                data={d?.revenue}
                granularity={filters.granularity}
                horizon={filters.horizon}
                basis={filters.basis}
                onBasis={(b) => set('basis', b, 'cash')}
                onGranularity={(g) => set('granularity', g, 'month')}
                onHorizon={(h) => set('horizon', h, '6')}
              />
            </div>
          </>
        )}
      </div>
      {touch && (
        <TouchDialog
          entity={touch.entity}
          id={touch.id}
          subtitle={touch.sub}
          start={{ channel: 'call', contact_id: null }}
          onClose={() => setTouch(null)}
          onSaved={() => { setTouch(null); refetch(); }}
        />
      )}
    </>
  );
}

const TILE_BADGE = { danger: 'late', warning: 'wait', success: 'ok', info: 'info' };

/** "Needs action now": the cash hero and four tiles, each a link to the list behind it. */
function Top({ d, heroRev, heroLoading, owner }) {
  if (!d) {
    return (
      <section className="rp-top" aria-busy="true" aria-label="Loading">
        <div className="mg-skel" style={{ flex: '1 1 400px', height: 236, borderRadius: 28 }} />
        <div className="mg-skel" style={{ flex: '1.3 1 480px', height: 236, borderRadius: 26 }} />
      </section>
    );
  }
  const f = d.follow_ups; const r = d.receivables; const e = d.enquiry_risk; const p = d.po_pipeline;
  const ok = (s) => s && !s.error;
  const three = (heroRev?.periods || []).slice(0, 3);
  const parts = { received: 0, invoiced: 0, scheduled: 0 };
  for (const m of three) { parts.received += Number(m.received || 0); parts.invoiced += Number(m.invoiced || 0); parts.scheduled += Number(m.scheduled || 0); }
  const firm = heroRev && !heroRev.error ? Number(heroRev.next_three_months ?? parts.received + parts.invoiced + parts.scheduled) : null;
  const share = (v) => (firm ? `${(100 * v) / firm}%` : '0%');
  const span = three.length ? `${three[0].label.split(' ')[0]} to ${three[three.length - 1].label.split(' ')[0]}` : 'the next three months';
  const decisionNear = ok(e) ? (e.by_reason.find((x) => x.reason === 'decision_near')?.count || 0) : 0;
  const tiles = [
    {
      key: 'f', label: 'Overdue follow-ups', to: hrefs.followUps(owner), s: f,
      figure: ok(f) ? number(f.count) : '—', late: ok(f) && f.count > 0,
      foot: ok(f) ? (f.count ? `oldest ${number(f.oldest_days)} days · ${inrFull(f.value_inr)}` : 'none waiting') : 'could not load',
      badge: ok(f) ? (f.count ? { tone: TILE_BADGE[tones.followUps(f)], text: tones.followUps(f) === 'danger' ? 'Late' : 'Due' } : { tone: 'ok', text: 'All clear' }) : null,
    },
    {
      key: 'r', label: 'Overdue invoices', to: '/collections', s: r,
      figure: ok(r) ? inrFull(r.overdue) : '—', late: ok(r) && r.overdue > 0,
      foot: ok(r) ? `${number(r.overdue_count)} invoice${r.overdue_count === 1 ? '' : 's'} · ${inrFull(r.outstanding)} owed` : 'could not load',
      badge: ok(r) ? (r.overdue ? { tone: TILE_BADGE[tones.receivables(r)], text: tones.receivables(r) === 'danger' ? 'Over 60 days' : 'Late' } : { tone: 'ok', text: 'All clear' }) : null,
    },
    {
      key: 'e', label: 'Enquiries at risk', to: hrefs.risk(owner), s: e,
      figure: ok(e) ? number(e.count) : '—', late: ok(e) && e.count > 0 && tones.enquiryRisk(e) === 'danger',
      foot: ok(e) ? (e.count ? `${number(decisionNear)} with a decision near` : 'all in hand') : 'could not load',
      badge: ok(e) ? (e.count ? { tone: TILE_BADGE[tones.enquiryRisk(e)], text: decisionNear ? 'Decision near' : 'Needs handling' } : { tone: 'ok', text: 'All clear' }) : null,
    },
    {
      key: 'p', label: 'Awaiting PO', to: ok(p) && p.awaiting_stage_id ? hrefs.stage(owner, p.awaiting_stage_id) : '/pipeline', s: p,
      figure: ok(p) ? inrFull(p.awaiting_po.value) : '—', late: false,
      foot: ok(p) ? `${number(p.awaiting_po.count)} deal${p.awaiting_po.count === 1 ? '' : 's'} · ${inrFull(p.awaiting_po.weighted)} weighted` : 'could not load',
      badge: ok(p) && p.awaiting_po.count ? { tone: 'info', text: 'To chase' } : null,
    },
  ];
  return (
    <section className="rp-top" aria-label="Needs action now">
      <section className="mg-hero rp-hero" data-a="rise" aria-labelledby="hero-l">
        <div className="mg-hero__label" id="hero-l">Expected, next 3 months</div>
        {firm == null ? (
          heroLoading
            ? <div className="mg-skel" style={{ height: 56, width: '70%', margin: '10px 0', opacity: 0.4 }} />
            : <><div className="mg-hero__figure rp-hero__figure mg-num">—</div><div className="mg-hero__sub">Cash flow could not be worked out just now.</div></>
        ) : (
          <>
            <div className="mg-hero__figure rp-hero__figure mg-num"><span data-count={Math.round(firm)} data-format="inr">{inrFull(firm)}</span></div>
            <div className="mg-hero__sub">Received, invoiced and scheduled, {span}. Cash basis, always.</div>
            <div className="rp-hero__foot">
              <div className="mg-progress" role="img" aria-label={`Received ${inrFull(parts.received)}, invoiced and due ${inrFull(parts.invoiced)}, not yet invoiced ${inrFull(parts.scheduled)}`}>
                <span className="mg-progress__done" style={{ width: share(parts.received) }} />
                <span className="rp-hero__invoiced" style={{ width: share(parts.invoiced) }} />
                <span className="mg-progress__expected" style={{ width: share(parts.scheduled) }} />
              </div>
              <div className="rp-hero__keys">
                <div className="mg-legend">
                  <span><i style={{ background: 'var(--on-hero)' }} />Received <strong className="mg-num">{inrFull(parts.received)}</strong></span>
                  <span><i style={{ background: 'var(--latte)' }} />Invoiced, due <strong className="mg-num">{inrFull(parts.invoiced)}</strong></span>
                  <span><i className="mg-hatch" />Not yet invoiced <strong className="mg-num">{inrFull(parts.scheduled)}</strong></span>
                </div>
                <Link className="rp-hero__go" to="/cashflow">Open cash flow<ArrowRight className="size-3.5" strokeWidth={1.8} aria-hidden="true" /></Link>
              </div>
            </div>
          </>
        )}
      </section>
      <section className="mg-glass mg-strip rp-istrip" data-a="rise" aria-label="Needs action now">
        {tiles.map((t) => (
          <Link key={t.key} className="rp-tile" to={t.to}>
            <span className="rp-tilehead">
              <span className="mg-label">{t.label}</span>
              {t.badge ? <span className={`mg-badge mg-badge--${t.badge.tone}`}>{t.badge.text}</span> : !ok(t.s) ? <span className="mg-badge">Not loaded</span> : null}
            </span>
            <span className={`mg-tile__figure mg-num${!ok(t.s) ? ' is-muted' : t.late ? ' is-late' : ''}`}>{t.figure}</span>
            <span className="mg-tile__foot">{t.foot}</span>
          </Link>
        ))}
      </section>
    </section>
  );
}
