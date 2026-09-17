import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Alert, Badge, ConfirmDialog, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useLookups } from '../lib/hooks.js';
import { date, money } from '../lib/format.js';

/**
 * Every client once (#20). A company is created the moment a name is typed
 * on an enquiry, quotation or project; this page is where its spelling,
 * sector and contacts are kept, and where two spellings of one client are
 * folded together.
 */
export default function Companies() {
  const navigate = useNavigate();
  const lookups = useLookups();
  const toast = useToast();
  const [refresh, setRefresh] = useState(0);
  const [merging, setMerging] = useState(null);
  const [busy, setBusy] = useState(false);
  const dups = useFetch(() => api.raw('/companies/duplicates'), [refresh]);
  const pairs = dups.data?.data ?? [];

  async function merge(pair) {
    setBusy(true);
    try {
      const { data } = await api.action(`/companies/${pair.b.id}/merge`, { into: pair.a.id });
      toast(`${data.merged} merged into ${data.into}`, 'success');
      invalidateLookups();
      setMerging(null);
      setRefresh((n) => n + 1);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  const columns = [
    { key: 'name', header: 'Company', className: 'strong', render: (r) => <>{r.name}{r.city && <div className="small muted">{r.city}</div>}</> },
    { key: 'sector', header: 'Sector', render: (r) => r.sector || <span className="muted">—</span> },
    { key: 'contacts', header: 'Contacts', align: 'right' },
    { key: 'enquiries', header: 'Enquiries', align: 'right' },
    { key: 'quotations', header: 'Quotations', align: 'right', render: (r) => <>{r.quotations}{r.won_quotations > 0 && <span className="small muted"> · {r.won_quotations} won</span>}</> },
    { key: 'projects', header: 'Projects', align: 'right' },
    { key: 'po_value_inr', header: 'PO value (INR)', align: 'right', render: (r) => money(r.po_value_inr) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', render: (r) => (r.outstanding > 0 ? <Badge tone="warning">{money(r.outstanding)}</Badge> : <span className="muted">—</span>) },
    { key: 'last_activity', header: 'Last activity', render: (r) => date(r.last_activity) },
  ];

  const fields = [
    { name: 'name', label: 'Company name', required: true, span: 2, hint: 'Renaming here renames the client on every record' },
    { name: 'sector', label: 'Sector', type: 'combo', options: lookups.sectors },
    { name: 'city', label: 'City' },
    { name: 'gstin', label: 'GSTIN' },
    { name: 'website', label: 'Website' },
    { name: 'address', label: 'Address', type: 'textarea', span: 'all' },
    { name: 'notes', label: 'Notes', type: 'textarea', span: 'all' },
  ];

  return (
    <>
      <ListPage
        title="Companies"
        subtitle="Every client once: contacts, sector and everything the tracker holds for them"
        resource="companies"
        columns={columns}
        fields={fields}
        newLabel="Company"
        formTitle="company"
        searchPlaceholder="Search company, sector, city, GSTIN…"
        onRowClick={(row) => navigate(`/companies/${row.id}`)}
        refreshToken={refresh}
        onSaved={() => { invalidateLookups(); setRefresh((n) => n + 1); }}
        filters={[{ name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sectors] }]}
        banner={pairs.length > 0 && (
          <Alert tone="warning">
            <strong>{pairs.length} pair{pairs.length === 1 ? '' : 's'} look like one client spelt twice.</strong> Merging moves every record and contact to the first name and deletes the second.
            <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {pairs.slice(0, 8).map((p) => (
                <li key={`${p.a.id}-${p.b.id}`} style={{ marginBottom: 4 }}>
                  <Link to={`/companies/${p.a.id}`}>{p.a.name}</Link> ({p.a.quotations + p.a.projects + p.a.enquiries} records) and{' '}
                  <Link to={`/companies/${p.b.id}`}>{p.b.name}</Link> ({p.b.quotations + p.b.projects + p.b.enquiries}){' '}
                  <button type="button" className="btn btn--sm" onClick={() => setMerging(p)}>Merge into {p.a.name}</button>
                </li>
              ))}
              {pairs.length > 8 && <li className="muted">and {pairs.length - 8} more</li>}
            </ul>
          </Alert>
        )}
      />
      {merging && (
        <ConfirmDialog
          title={`Merge "${merging.b.name}" into "${merging.a.name}"?`}
          message={`Every enquiry, quotation, project and contact under ${merging.b.name} moves to ${merging.a.name} and takes that name. ${merging.b.name} is then deleted. This cannot be undone.`}
          confirmLabel={busy ? 'Merging…' : 'Merge'}
          busy={busy}
          onConfirm={() => merge(merging)}
          onClose={() => setMerging(null)}
        />
      )}
    </>
  );
}
