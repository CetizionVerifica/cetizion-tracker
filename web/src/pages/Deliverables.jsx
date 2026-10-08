import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { DELIVERABLE_STATUSES, DELIVERABLE_TYPES, DeliverablesTable } from '../components/Deliverables.jsx';
import { FilterSelect, useEntrance } from '../components/daily.jsx';

/**
 * The certificates and deliverables register (#43): "which clients hold an
 * ISO certificate expiring next quarter" is type + search + expiring.
 */
const EXPIRY = [
  { value: '30', label: 'Expiring in 30 days' }, { value: '90', label: 'Expiring in 90 days' },
  { value: '120', label: 'Expiring in 120 days' }, { value: '365', label: 'Expiring in a year' },
];

export default function Deliverables() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const f = { type: params.get('type') || '', status: params.get('status') || '', expiring: params.get('expiring') || '', q: params.get('q') || '' };
  const put = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const filtered = Object.values(f).some(Boolean);
  const ref = useEntrance(true);

  return (
    <>
      <PageHeader
        title="Certificates"
        subtitle="What each client holds from us, with its dates and file. Expiry dates drive renewals and reminders."
      />
      <div className="app-page" ref={ref}>
        <DeliverablesTable
          params={f}
          title="Register"
          hint="Issued first, soonest expiry at the top. Reminders go out 120, 90 and 30 days before expiry."
          filtered={filtered}
          onClear={() => { setQ(''); setParams({}, { replace: true }); }}
          filters={<>
            <label className="mg-search flex-[1_1_240px]">
              <Search aria-hidden="true" />
              <input className="mg-input h-9" aria-label="Search client, reference or scope" placeholder="Search client, reference, scope…" value={q}
                onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && put('q', q.trim())} onBlur={() => put('q', q.trim())} />
            </label>
            <div className="mg-chiprow flex min-w-0 flex-wrap items-center gap-2">
              <FilterSelect label="Type" value={f.type} onChange={(v) => put('type', v)} placeholder="All types" options={DELIVERABLE_TYPES} />
              <FilterSelect label="Status" value={f.status} onChange={(v) => put('status', v)} placeholder="Any status" options={DELIVERABLE_STATUSES} width={140} />
              <FilterSelect label="Expiry" value={f.expiring} onChange={(v) => put('expiring', v)} placeholder="Any expiry" options={EXPIRY} width={190} />
            </div>
          </>}
        />
      </div>
    </>
  );
}
