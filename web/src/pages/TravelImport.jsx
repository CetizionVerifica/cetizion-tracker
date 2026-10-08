import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, UploadCloud } from 'lucide-react';
import { cn } from 'cn';
import { Alert, ConfirmDialog, Field, Select, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { TravelDocumentsUpload } from '../components/TravelDocumentsUpload.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch, useLookups } from '../lib/hooks.js';

/**
 * The travel import (#196 §5.1): a travel agency's workbook in, a review
 * out — the same promise as the sales import, for the travel desk. Every
 * tab is read; the vendor is chosen once for the whole workbook, or found
 * from its invoice numbers.
 */

const ACCEPT = '.xlsx,.xls,.csv';

function state(batch) {
  if (batch.status === 'failed') return { tone: 'late', label: 'Could not be read' };
  if (batch.status === 'committed') return { tone: 'settled', icon: Check, label: `${number(batch.summary?.written?.trip ?? 0)} trips in` };
  const red = batch.summary?.red || 0;
  return { tone: 'waiting', label: red ? `Review · ${number(red)} to fix` : `Review · ${number(batch.row_count)} rows` };
}

export default function TravelImport() {
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const [vendor, setVendor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const { data, loading, refetch } = useFetch(() => api.raw('/import/travel'), []);
  const batches = data?.data ?? [];

  async function send(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    if (vendor) form.append('vendor_id', vendor);
    try {
      const result = await api.upload('/import/travel', form);
      toast('Workbook read — review what was found', 'success');
      navigate(`/import-travel/${result.data.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove(batch) {
    try {
      await api.remove('import/travel', batch.id);
      toast('Draft deleted', 'success');
      setDeleting(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return (
    <>
      <SettingsPane
        title="Import travel"
        description="A travel agency's workbook in, trips, legs, agency invoices and credit notes out. Nothing is written until you commit the review."
        actions={
          <div className="flex flex-wrap gap-2">
            <TravelDocumentsUpload />
            <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" asChild>
              <a href={api.travelTemplateUrl()} download>Download the template</a>
            </Button>
          </div>
        }
      >
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="max-w-[360px]">
          <Field label="Travel vendor" hint="The whole workbook is from one agency. Left blank, it is found from the invoice numbers.">
            <Select value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Find from invoice numbers"
              options={lookups.travel_vendor_list.map((v) => ({ value: String(v.id), label: v.name }))} />
          </Field>
        </div>

        <label
          htmlFor="travel-import-file"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); send(e.dataTransfer.files?.[0]); }}
          className={cn(
            'block cursor-pointer rounded-lg border border-dashed bg-card px-5 py-7 text-center transition-colors',
            dragging ? 'border-primary bg-primary/[0.04]' : 'border-border-strong hover:border-muted-foreground',
            busy && 'pointer-events-none opacity-60'
          )}
        >
          <UploadCloud className="mx-auto size-[22px] text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
          <div className="mt-3 text-[13px] font-medium text-foreground">{busy ? 'Reading the workbook…' : 'Drop the travel .xlsx or .csv'}</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {busy ? 'Every tab, grouped into trips and matched to POs, projects and staff.' : 'Flights, trains, buses, cabs and hotels, one row per leg, any number of monthly tabs'}
          </div>
        </label>
        <input id="travel-import-file" type="file" accept={ACCEPT} className="sr-only" disabled={busy} onChange={(e) => send(e.target.files?.[0])} />

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {loading && !batches.length ? (
            <div className="skeleton" style={{ height: 88, margin: 18 }} />
          ) : batches.length === 0 ? (
            <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">No travel imports yet. Drop a workbook above to start one.</p>
          ) : batches.map((batch, i) => {
            const look = state(batch);
            return (
              <div key={batch.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-2.5', i < batches.length - 1 && 'border-b border-border')}>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => navigate(`/import-travel/${batch.id}`)}>
                  <div className={cn('truncate text-[13px] font-medium', batch.status === 'committed' ? 'text-secondary-text' : 'text-foreground')}>{batch.filename}</div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {[batch.vendor_name, batch.summary?.trips !== undefined && `${number(batch.summary.trips)} trips · ${number(batch.summary.invoices)} invoices`, batch.uploaded_by, ago(batch.created_at)].filter(Boolean).join(' · ')}
                  </div>
                </button>
                <Chip tone={look.tone} icon={look.icon}>{look.label}</Chip>
                <Button variant="secondary" size="sm" className="h-7 px-3 text-[12.5px]" onClick={() => navigate(`/import-travel/${batch.id}`)}>
                  {batch.status === 'committed' ? 'View' : 'Review'}
                </Button>
                {batch.status !== 'committed' && (
                  <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`Delete the draft from ${batch.filename}`} onClick={() => setDeleting(batch)}>✕</Button>
                )}
              </div>
            );
          })}
        </div>

        <p className="max-w-[80ch] text-[11.5px]/[1.6] text-muted-foreground">
          Columns are found by their names, tab by tab, so a column added, repeated or left unnamed in one month does not
          matter; a correction you make is remembered for the vendor. Rows of one person within
          {' '}{lookups.settings?.travel_import_trip_gap_days || 7} days that chain on (out and back, or onward) become one
          trip with its legs. Rows sharing an invoice number become one agency invoice with a line per leg, and a credit or
          cancellation note is matched to the invoice it reverses.
        </p>
        <p className="max-w-[80ch] text-[11.5px]/[1.6] text-muted-foreground">
          Upload the same workbook again as the month fills in. Legs, invoices and notes already in the tracker are
          recognised and kept, or updated from the sheet if you choose; only what is new is added.
        </p>
      </SettingsPane>

      {deleting && (
        <ConfirmDialog
          title="Delete this draft?"
          message={`The draft from "${deleting.filename}" will be removed. Nothing in the tracker changes.`}
          confirmLabel="Delete draft"
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
