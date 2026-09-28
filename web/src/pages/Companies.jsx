import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ListPage } from '../components/ListPage.jsx';
import { Alert, Badge, Modal, useToast } from '../components/ui.jsx';
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
  const [review, setReview] = useState(null);   // the group being looked at
  const [keepId, setKeepId] = useState(null);  // the spelling that survives
  const [chosen, setChosen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const dups = useFetch(() => api.raw('/companies/duplicates'), [refresh]);
  const groups = dups.data?.data ?? [];

  /**
   * Open a group. A same-name group has nothing to weigh up, so everything
   * starts ticked; a shares-a-brand group starts with nothing ticked,
   * because "Hindalco - Belur" and "Hindalco FRP" are two plants and the
   * whole point of the group is to ask which of these are one client.
   */
  function open(group) {
    setReview(group);
    setKeepId(group.suggested_keep);
    setChosen(new Set(group.certain ? group.members.map((m) => m.id) : []));
  }

  const toggle = (id) => setChosen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Fold every ticked spelling into the chosen one, oldest history last. */
  async function merge() {
    const losers = review.members.filter((m) => m.id !== keepId && chosen.has(m.id));
    if (!losers.length) return;
    setBusy(true);
    try {
      for (const m of losers) await api.action(`/companies/${m.id}/merge`, { into: keepId });
      const keep = review.members.find((m) => m.id === keepId);
      toast(`${losers.length} spelling${losers.length === 1 ? '' : 's'} folded into ${keep.name}`, 'success');
      invalidateLookups();
      setReview(null);
      setRefresh((n) => n + 1);
    } catch (err) {
      // Merges run one at a time, so some may already have happened.
      toast(`${err.message}. Reopen the group to see what is left.`, 'danger');
      setRefresh((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  const keep = review?.members.find((m) => m.id === keepId);
  const losing = review ? review.members.filter((m) => m.id !== keepId && chosen.has(m.id)) : [];

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
        filters={[
          { name: 'sector', label: 'Sector', options: [{ value: '__none__', label: 'Not set' }, ...lookups.sectors] },
          { name: 'contacts', label: 'Contacts', options: [{ value: '0', label: 'None' }] },
        ]}
        banner={groups.length > 0 && (
          <Alert tone="warning">
            <strong>{groups.length} group{groups.length === 1 ? '' : 's'} of companies may be one client spelt more than once.</strong>{' '}
            Open a group to choose which spellings are really the same, and which one to keep.
            <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {groups.slice(0, 8).map((g) => (
                <li key={g.members[0].id} style={{ marginBottom: 4 }}>
                  <Link to={`/companies/${g.members[0].id}`}>{g.members[0].name}</Link>{' '}
                  <span className="muted">+{g.size - 1} more · {g.records} record{g.records === 1 ? '' : 's'}</span>{' '}
                  <Badge tone={g.certain ? 'warning' : 'default'}>{g.confidence}</Badge>{' '}
                  <button type="button" className="btn btn--sm" onClick={() => open(g)}>Review</button>
                </li>
              ))}
              {groups.length > 8 && <li className="muted">and {groups.length - 8} more</li>}
            </ul>
          </Alert>
        )}
      />
      {review && (
        <Modal
          title={review.certain ? 'The same name, spelt differently' : 'Which of these are the same client?'}
          subtitle={review.certain
            ? 'These differ only by capitals and spacing, so there is nothing to weigh up.'
            : 'These share a brand. That does not make them one company — a plant, a unit or a subsidiary is its own client. Tick only the ones that are genuinely the same.'}
          onClose={() => setReview(null)}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setReview(null)}>Cancel</button>
              <button type="button" className="btn btn--danger" disabled={busy || !losing.length} onClick={merge}>
                {busy ? 'Merging…' : losing.length ? `Merge ${losing.length} into ${keep?.name}` : 'Nothing ticked'}
              </button>
            </>
          )}
        >
          <table className="table">
            <thead>
              <tr><th>Merge</th><th>Company</th><th className="right">Records</th><th>Keep this one</th></tr>
            </thead>
            <tbody>
              {review.members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Merge ${m.name}`}
                      checked={m.id === keepId || chosen.has(m.id)}
                      disabled={m.id === keepId}
                      onChange={() => toggle(m.id)}
                    />
                  </td>
                  <td>
                    <Link to={`/companies/${m.id}`}>{m.name}</Link>
                    {m.sector && <div className="small muted">{m.sector}</div>}
                  </td>
                  <td className="right">{m.records}</td>
                  <td>
                    <input
                      type="radio"
                      name="keep"
                      aria-label={`Keep ${m.name}`}
                      checked={m.id === keepId}
                      onChange={() => { setKeepId(m.id); setChosen((prev) => { const n = new Set(prev); n.delete(m.id); return n; }); }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {losing.length > 0 && (
            <Alert tone="danger">
              Every enquiry, quotation, project and contact under{' '}
              <strong>{losing.map((m) => m.name).join(', ')}</strong> moves to{' '}
              <strong>{keep?.name}</strong> and takes that name. {losing.length === 1 ? 'That company is' : 'Those companies are'} then deleted.
              This cannot be undone.
            </Alert>
          )}
        </Modal>
      )}
    </>
  );
}
