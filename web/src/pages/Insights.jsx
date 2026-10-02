import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { EnquiryRiskSection } from '../components/insights/EnquiryRiskSection.jsx';
import { FollowUpsSection } from '../components/insights/FollowUpsSection.jsx';
import { PoPipelineSection } from '../components/insights/PoPipelineSection.jsx';
import { ReceivablesSection } from '../components/insights/ReceivablesSection.jsx';
import { RevenueSection } from '../components/insights/RevenueSection.jsx';
import { TouchDialog } from '../components/Timeline.jsx';
import { Alert, Select, Stat } from '../components/ui.jsx';
import { Button } from '../components/ui/button.tsx';
import { Skeleton } from '../components/ui/skeleton.tsx';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useFetch } from '../lib/hooks.js';
import { number } from '../lib/format.js';
import { GRANULARITY_OPTIONS, HORIZON_OPTIONS, hrefs, inr, queryString, readFilters, tones } from '../lib/insights.js';

/**
 * Insights (docs/insights-dashboard-plan.md): five questions, each answered
 * with a chart that clicks through to the records behind it.
 *
 * The filters live in the address bar, so a link carries them. A sales user
 * sees their own records; an admin sees everyone's, or one owner's.
 * Everything is in ₹ at the rate on each record's own date.
 */
export default function Insights() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const { isAdmin } = useAuth();
  const qs = queryString({
    owner: filters.owner,
    granularity: filters.granularity,
    horizon: filters.horizon,
    basis: filters.basis,
  });
  const { data, loading, error, refetch } = useFetch(() => api.raw(`/insights${qs}`), [qs]);
  const d = data?.data;
  const [touch, setTouch] = useState(null);

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
  const shared = { loading, onRetry: refetch, settings: d?.settings, owner, onNavigate: navigate };
  const ownerName = d?.owners?.find((o) => String(o.id) === owner)?.name;

  return (
    <>
      <PageHeader
        title="Insights"
        subtitle={`${ownerName ? `${ownerName}'s records. ` : isAdmin ? 'Everyone\'s records. ' : 'Your records. '}All figures in ₹ at the rate on each record's own date. Every bar opens the list behind it.`}
        actions={(
          <>
            {isAdmin && (
              <Select
                value={owner}
                placeholder={null}
                aria-label="Whose records"
                options={[{ value: '', label: 'Owner: everyone' }, ...(d?.owners || []).map((o) => ({ value: String(o.id), label: `Owner: ${o.name}` }))]}
                onChange={(e) => set('owner', e.target.value, '')}
              />
            )}
            <Select
              value={filters.granularity}
              placeholder={null}
              aria-label="Period"
              options={GRANULARITY_OPTIONS.map((o) => ({ value: o.value, label: `By: ${o.label.toLowerCase()}` }))}
              onChange={(e) => set('granularity', e.target.value, 'month')}
            />
            <Select
              value={filters.horizon}
              placeholder={null}
              aria-label="Months ahead"
              options={HORIZON_OPTIONS.map((h) => ({ value: h, label: `Months: ${h}` }))}
              onChange={(e) => set('horizon', e.target.value, '6')}
            />
            <Button variant="outline" size="sm" onClick={refetch} aria-label="Refresh" disabled={loading}>
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} aria-hidden="true" /> Refresh
            </Button>
          </>
        )}
      />
      <div className="page stack">
        {error && <Alert tone="danger"><span>{error}</span></Alert>}

        <ActionStrip d={d} loading={loading && !d} owner={owner} />

        {/* Two columns when the page itself is wide enough for them, as on
            Reports: a container query, measured on the content box. */}
        <div className="@container">
          <div className="grid gap-x-4 gap-y-8 @3xl:grid-cols-2">
            <FollowUpsSection {...shared} data={d?.follow_ups} showOwners={showOwners} onTouch={setTouch} />
            <ReceivablesSection {...shared} data={d?.receivables} />
            <EnquiryRiskSection {...shared} data={d?.enquiry_risk} showOwners={showOwners} onTouch={setTouch} />
            <PoPipelineSection {...shared} data={d?.po_pipeline} />
            <RevenueSection
              {...shared}
              data={d?.revenue}
              granularity={filters.granularity}
              basis={filters.basis}
              onBasis={(b) => set('basis', b, 'cash')}
            />
          </div>
        </div>
      </div>
      {touch && (
        <TouchDialog
          entity={touch.entity}
          id={touch.id}
          start={{ channel: 'call', contact_id: null }}
          onClose={() => setTouch(null)}
          onSaved={() => { setTouch(null); refetch(); }}
        />
      )}
    </>
  );
}

/** "Needs action now": one tile per question, each a link to the list behind it. */
function ActionStrip({ d, loading, owner }) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => <Skeleton key={i} style={{ height: 84 }} />)}
      </div>
    );
  }
  if (!d) return null;
  const f = d.follow_ups; const r = d.receivables; const e = d.enquiry_risk; const p = d.po_pipeline; const v = d.revenue;
  const ok = (s) => s && !s.error;
  // The next three months of firm money, worked out from the months
  // themselves whatever the period on the chart.
  const firm = ok(v) && v.basis === 'cash' ? v.next_three_months : null;
  return (
    <section aria-label="Needs action now" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Stat
        label="Overdue follow-ups"
        value={ok(f) ? number(f.count) : '—'}
        meta={ok(f) ? (f.count ? `oldest ${number(f.oldest_days)} days · ${inr(f.value_inr)}` : 'none waiting') : 'could not load'}
        tone={ok(f) ? tones.followUps(f) : ''}
        to={hrefs.followUps(owner)}
      />
      <Stat
        label="Overdue invoices"
        value={ok(r) ? inr(r.overdue) : '—'}
        meta={ok(r) ? `${number(r.overdue_count)} invoice${r.overdue_count === 1 ? '' : 's'} · ${inr(r.outstanding)} owed` : 'could not load'}
        tone={ok(r) ? tones.receivables(r) : ''}
        to="/collections"
      />
      <Stat
        label="Enquiries at risk"
        value={ok(e) ? number(e.count) : '—'}
        meta={ok(e) ? (e.count ? `${number(e.by_reason.find((x) => x.reason === 'decision_near')?.count || 0)} with a decision near` : 'all in hand') : 'could not load'}
        tone={ok(e) ? tones.enquiryRisk(e) : ''}
        to={hrefs.risk(owner)}
      />
      <Stat
        label="Awaiting PO"
        value={ok(p) ? inr(p.awaiting_po.value) : '—'}
        meta={ok(p) ? `${number(p.awaiting_po.count)} deal${p.awaiting_po.count === 1 ? '' : 's'} · ${inr(p.awaiting_po.weighted)} weighted` : 'could not load'}
        tone={ok(p) ? tones.awaitingPo(p) : ''}
        to={ok(p) && p.awaiting_stage_id ? hrefs.stage(owner, p.awaiting_stage_id) : '/pipeline'}
      />
      <Stat
        label="Expected, next 3 months"
        value={firm != null ? inr(firm) : '—'}
        meta={firm != null ? 'received, invoiced and scheduled' : ok(v) ? 'on cash basis only' : 'could not load'}
        to="/cashflow"
      />
    </section>
  );
}
