import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Input, Select } from '../components/ui.jsx';
import { DELIVERABLE_TYPES, DeliverablesTable } from '../components/Deliverables.jsx';

/**
 * The certificates and deliverables register (#43): "which clients hold an
 * ISO certificate expiring next quarter" is type + search + expiring.
 */
export default function Deliverables() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const f = { type: params.get('type') || '', status: params.get('status') || '', expiring: params.get('expiring') || '', q: params.get('q') || '' };
  const put = (k, v) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };

  return (
    <>
      <PageHeader
        title="Certificates"
        subtitle="What each client holds from us, with its dates and file. Expiry dates drive renewals and reminders."
        actions={<>
          <Input placeholder="Search client, reference, scope…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && put('q', q.trim())} onBlur={() => put('q', q.trim())} style={{ width: 240 }} />
          <Select value={f.type} placeholder="All types" options={DELIVERABLE_TYPES} onChange={(e) => put('type', e.target.value)} />
          <Select value={f.status} placeholder="Any status" options={['issued', 'draft', 'expired', 'superseded', 'withdrawn']} onChange={(e) => put('status', e.target.value)} />
          <Select value={f.expiring} placeholder="Any expiry" options={[{ value: '30', label: 'Expiring in 30 days' }, { value: '90', label: 'Expiring in 90 days' }, { value: '120', label: 'Expiring in 120 days' }, { value: '365', label: 'Expiring in a year' }]} onChange={(e) => put('expiring', e.target.value)} />
        </>}
      />
      <div className="page stack">
        <DeliverablesTable params={f} title="Register" hint="Issued first, soonest expiry at the top." />
      </div>
    </>
  );
}
