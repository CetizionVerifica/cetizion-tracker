import { Link } from 'react-router-dom';
import { Building2, Check, CreditCard, FileText, FolderKanban, Package, Receipt } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { FailedCard, RefreshButton, StateCard, plural, useEntrance } from '../components/daily.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * What is missing, and where to fix it (#74).
 *
 * The tracker flags a missing value on the record's own page and nowhere
 * else, so people found out when a report looked wrong. Each tile is one
 * check, biggest gap first; its link opens the list filtered to exactly the
 * records it counts. Checks at zero fold into one "All complete" list.
 */
const AREAS = [
  [/^\/companies/, 'Companies', Building2],
  [/^\/quotations/, 'Deals', FileText],
  [/^\/payment-stages/, 'Payment stages', CreditCard],
  [/^\/purchase-orders/, 'Orders', Package],
  [/^\/vendor-invoices/, 'Vendor invoices', Receipt],
  [/^\/projects/, 'Projects', FolderKanban],
];
const areaOf = (link) => AREAS.find(([re]) => re.test(link || '')) || [null, 'Records', FileText];

export default function DataQuality() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/data-quality'));
  const checks = data?.data.checks || [];
  const gaps = checks.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
  const complete = checks.filter((c) => c.count === 0);
  const total = gaps.reduce((n, c) => n + c.count, 0);
  const ref = useEntrance(Boolean(data) || Boolean(error));

  const subtitle = loading && !data ? `Running the checks…`
    : error ? 'What is missing, and where to fix it.'
      : !gaps.length ? 'What is missing, and where to fix it. Nothing is missing right now.'
        : `What is missing, and where to fix it: ${plural(total, 'gap')} across ${plural(gaps.length, 'check')}. Each tile opens the list, filtered to what needs fixing.`;

  return (
    <>
      <PageHeader title="Data quality" subtitle={subtitle} actions={<RefreshButton onClick={refetch} busy={loading} />} />
      <div className="app-page" ref={ref}>
        {error ? (
          <FailedCard title="Couldn’t run the checks" text="The server didn’t answer, so we can’t say what is missing. Try again in a moment." onRetry={refetch} />
        ) : loading && !data ? (
          <div aria-busy="true" aria-label="Running the checks" className="flex flex-wrap gap-4">
            {Array.from({ length: 8 }, (_, i) => (
              <section key={i} className="mg-glass mg-tile min-h-[150px] min-w-[150px] flex-[1_1_calc(25%-12px)]">
                <div className="mg-skel" style={{ height: 12, width: '40%' }} /><div className="mg-skel" style={{ height: 34, width: '30%' }} />
                <div className="mg-skel" style={{ height: 12 }} /><div className="mg-skel" style={{ height: 12, width: '70%' }} />
              </section>
            ))}
          </div>
        ) : (
          <>
            {!gaps.length && <StateCard dashed title="Nothing missing" text={`All ${plural(checks.length, 'check')} are at zero. New gaps show up here, biggest first.`} />}

            {gaps.length > 0 && (
              <section aria-labelledby="gaps-t" className="flex flex-col gap-3">
                <h2 id="gaps-t" className="mg-label m-0" data-a="rise">{gaps.length === 1 ? '1 check needs fixing' : `${gaps.length} checks need fixing, biggest first`}</h2>
                <div className="flex flex-wrap gap-4">
                  {gaps.map((c) => {
                    const [, area, Icon] = areaOf(c.link);
                    return (
                      <Link key={c.key} to={c.link} className="mg-glass mg-tile min-w-[150px] max-w-[440px] flex-[1_1_calc(25%-12px)] text-foreground no-underline" data-a="rise" aria-label={`${c.label}: ${c.count}. Open the list to fix`}>
                        <span className="flex items-center gap-2.5">
                          <span className="app-sq app-sq--sm bg-wait-soft text-wait"><Icon aria-hidden="true" /></span>
                          <span className="mg-label">{area}</span>
                        </span>
                        <span key={c.count} className="mg-tile__figure mg-num text-wait" data-count={c.count}>{c.count}</span>
                        <span className="text-[13px] font-bold leading-[1.35] [text-wrap:pretty]">{c.label}</span>
                        <span className="mg-tile__foot mt-auto font-bold text-caramel-text">Open the list to fix →</span>
                      </Link>
                    );
                  })}
                </div>
              </section>
            )}

            {gaps.length > 0 && complete.length > 0 && (
              <section className="mg-glass mg-panel" data-a="rise" aria-labelledby="done-t">
                <div className="mg-panel__head"><h2 id="done-t" className="mg-panel__title">All complete</h2><span className="mg-badge mg-badge--ok">{complete.length}</span></div>
                <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0">
                  {complete.map((c) => (
                    <li key={c.key} className="flex min-w-0 flex-[1_1_300px] items-center gap-2.5 text-[13px] text-secondary-text">
                      <span className="grid size-[22px] flex-none place-items-center rounded-full bg-ok-soft text-ok"><Check className="size-3.5" strokeWidth={2.4} aria-hidden="true" /></span>
                      {c.label}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}
