import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Card, DataTable, Badge, Empty, Alert, ConfirmDialog, useToast } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Bulk import — upload a sales sheet, let the importer derive quotations,
 * projects, POs and payments from it, then review step by step before
 * anything reaches the live tables.
 */
export default function BulkImport() {
  const navigate = useNavigate();
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const { data, loading, refetch } = useFetch(() => api.raw('/import/batches'), []);
  const batches = data?.data ?? [];

  async function upload(e) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api.upload('/import/batches', form);
      toast('Sheet read — review what was found', 'success');
      navigate(`/import/${result.data.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove(batch) {
    try {
      await api.remove('import/batches', batch.id);
      toast('Draft deleted', 'success');
      setDeleting(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <>
      <PageHeader title="Bulk import" subtitle="Upload a sheet, review what the importer derived, then commit it in one go" />
      <div className="page stack">
        <Card title="Upload a sheet" hint="Excel or CSV. Nothing is written to the live data until you press Complete and commit on the final review.">
          <form onSubmit={upload} className="stack">
            {error && <Alert tone="danger">{error}</Alert>}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="input"
                style={{ maxWidth: 420 }}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                disabled={busy}
              />
              <button type="submit" className="btn btn--primary" disabled={!file || busy}>
                {busy ? 'Reading the sheet…' : 'Upload and analyse'}
              </button>
            </div>
            {busy && <div className="small muted">Reading rows, matching against the site, and asking the AI to flag anything odd. Usually under a minute.</div>}
            <div className="small muted">
              Rules applied: ISO proposals are left out · won deals need a PO number · missing PO date = proposal + 7 days ·
              missing invoice date = PO + 1 day · missing delivery = PO + 6 months once passed · anything already on the site is shown in yellow for you to keep or replace.
            </div>
          </form>
        </Card>

        <Card flush title="Imports" hint="Drafts stay here until committed. Committed batches are kept as a record.">
          <DataTable
            loading={loading}
            rows={batches}
            onRowClick={(b) => navigate(`/import/${b.id}`)}
            columns={[
              { key: 'id', header: '#', width: 50, className: 'mono' },
              { key: 'filename', header: 'File', className: 'strong' },
              { key: 'sheet_name', header: 'Sheet', className: 'small' },
              { key: 'row_count', header: 'Rows', align: 'right' },
              { key: 'summary', header: 'Planned', className: 'small', render: (b) => planned(b.summary) },
              { key: 'status', header: 'Status', render: (b) => <Badge tone={b.status === 'committed' ? 'success' : b.status === 'failed' ? 'danger' : 'info'}>{b.status}</Badge> },
              { key: 'created_at', header: 'Uploaded', className: 'small', render: (b) => new Date(b.created_at).toLocaleString() },
              { key: 'uploaded_by', header: 'By', className: 'small' },
              {
                key: 'act', header: '', align: 'right',
                render: (b) => (
                  <div className="table__actions">
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => navigate(`/import/${b.id}`)}>{b.status === 'committed' ? 'View' : 'Review'}</button>
                    {b.status !== 'committed' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDeleting(b)}>✕</button>}
                  </div>
                ),
              },
            ]}
            empty={<Empty title="No imports yet" text="Upload a sheet above to start one." />}
          />
        </Card>
      </div>

      {deleting && (
        <ConfirmDialog
          title="Delete this draft?"
          message={`The draft from "${deleting.filename}" will be removed. Nothing on the live site changes.`}
          confirmLabel="Delete draft"
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}

function planned(summary) {
  if (!summary?.steps) return '—';
  const s = summary.steps;
  const n = (k) => (s[k]?.create || 0);
  return `${n('quotation')} quotations · ${n('purchase_order')} POs · ${n('invoice')} invoices`;
}
