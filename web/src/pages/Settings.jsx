import { useState } from 'react';
import { PageHeader } from '../App.jsx';
import { Card, DataTable, Tabs, Badge, Alert, Empty, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { api } from '../lib/api.js';
import { useFetch, useList, invalidateLookups } from '../lib/hooks.js';

const CATALOGUES = {
  services: { resource: 'services', label: 'Service', title: 'Service offerings', hint: 'Offered on quotations and PO service lines' },
  'travel-vendors': { resource: 'travel-vendors', label: 'Travel vendor', title: 'Travel vendors', hint: 'Who trips are booked through' },
  'expense-categories': { resource: 'expense-categories', label: 'Expense category', title: 'Expense categories', hint: 'What employees can claim against' },
};

export default function Settings() {
  const [tab, setTab] = useState('services');

  return (
    <>
      <PageHeader title="Settings" subtitle="The lists and assumptions the rest of the app reads from" />

      <div className="page stack">
        <SettingsValues />

        <Tabs
          active={tab}
          onChange={setTab}
          tabs={Object.entries(CATALOGUES).map(([key, c]) => ({ key, label: c.title }))}
        />

        <Catalogue key={tab} {...CATALOGUES[tab]} />
      </div>
    </>
  );
}

function SettingsValues() {
  const toast = useToast();
  const { data, loading, refetch } = useFetch(() => api.raw('/lookups'));
  const [editing, setEditing] = useState(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const settings = data?.data?.settings || {};
  const rows = Object.entries(settings).map(([key, val]) => ({ id: key, key, value: val }));

  async function save(key) {
    setBusy(true);
    try {
      await api.update('settings', key, { value });
      toast('Setting saved', 'success');
      invalidateLookups();
      setEditing(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card flush title="Assumptions" hint="Changing these changes what the app computes everywhere">
      <Alert>
        <span>
          <strong>Vendor invoice window</strong> drives the "invoice overdue from vendor" flag.
          The default payment terms are only suggestions — actual terms live on each PO.
        </span>
      </Alert>
      <DataTable
        loading={loading}
        rows={rows}
        columns={[
          { key: 'key', header: 'Setting', className: 'mono', render: (r) => r.key.replace(/_/g, ' ') },
          {
            key: 'value',
            header: 'Value',
            render: (r) =>
              editing === r.key ? (
                <input className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus style={{ maxWidth: 280 }} />
              ) : (
                <span className="strong">{r.value}</span>
              ),
          },
          {
            key: 'act',
            header: '',
            align: 'right',
            render: (r) => (
              <div className="table__actions">
                {editing === r.key ? (
                  <>
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => save(r.key)} disabled={busy}>Save</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => { setEditing(r.key); setValue(r.value); }}>Edit</button>
                )}
              </div>
            ),
          },
        ]}
        empty={<Empty title="No settings recorded" />}
      />
    </Card>
  );
}

function Catalogue({ resource, label, title, hint }) {
  const toast = useToast();
  const { rows, loading, refetch } = useList(resource, {});
  const [editing, setEditing] = useState(null);

  async function toggle(row) {
    try {
      await api.update(resource, row.id, { active: !row.active });
      invalidateLookups();
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <>
      <Card
        flush
        title={title}
        hint={hint}
        actions={<button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing('new')}>+ {label}</button>}
      >
        <DataTable
          loading={loading}
          rows={rows}
          columns={[
            { key: 'name', header: 'Name', className: 'strong' },
            { key: 'active', header: 'Status', render: (r) => <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Hidden'}</Badge> },
            {
              key: 'act',
              header: '',
              align: 'right',
              render: (r) => (
                <div className="table__actions">
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(r)}>Rename</button>
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => toggle(r)}>
                    {r.active ? 'Hide' : 'Restore'}
                  </button>
                </div>
              ),
            },
          ]}
          empty={<Empty title={`No ${title.toLowerCase()} yet`} />}
        />
      </Card>

      {editing && (
        <RecordForm
          title={editing === 'new' ? `New ${label.toLowerCase()}` : `Edit ${label.toLowerCase()}`}
          resource={resource}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            invalidateLookups();
            refetch();
          }}
          fields={[
            { name: 'name', label: 'Name', required: true, span: 'all' },
            ...(resource === 'services' ? [{ name: 'sort_order', label: 'Sort order', type: 'number', default: '0' }] : []),
            { name: 'active', label: 'Visible in dropdowns', type: 'boolean', default: 'true' },
          ]}
        />
      )}
    </>
  );
}
