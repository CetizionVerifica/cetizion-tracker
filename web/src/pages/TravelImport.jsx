import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileSpreadsheet, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { count } from '../components/travel.jsx';
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
 *
 * Wave 6: one glass panel; the drop zone has a real Choose button and a
 * visible focus ring, says when it is being dragged over and while it
 * reads; the imports list says where each one stands (to fix, in, could
 * not be read) with one button; the reading rules sit behind "How the
 * import reads a workbook".
 */

const ACCEPT = '.xlsx,.xls,.csv';

function state(batch) {
  if (batch.status === 'failed') return { tone: 'late', label: 'Could not be read', btn: 'See why' };
  if (batch.status === 'committed') return { tone: 'ok', label: `${number(batch.summary?.written?.trip ?? 0)} trips in`, btn: 'View' };
  const red = batch.summary?.red || 0;
  return { tone: 'wait', label: red ? `Review · ${number(red)} to fix` : `Review · ${number(batch.row_count)} rows`, btn: 'Review', primary: true };
}

export default function TravelImport() {
  const navigate = useNavigate();
  const toast = useToast();
  const lookups = useLookups();
  const input = useRef(null);
  const [vendor, setVendor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const { data, loading, error: listError, refetch } = useFetch(() => api.raw('/import/travel'), []);
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
      setError({ message: err.message, file: file.name });
      setBusy(false);
      if (input.current) input.current.value = '';
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
        description="A travel agency's workbook in; trips, legs, agency invoices and credit notes out. Nothing is written until you commit the review."
        actions={
          <div className="flex flex-wrap gap-2">
            <TravelDocumentsUpload />
            <a className="mg-btn mg-btn--ghost" href={api.travelTemplateUrl()} download><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Download the template</a>
          </div>
        }
      >
        <section className="mg-glass mg-glass--strong app-import" aria-label="Import a travel workbook">
          {error && (
            <MoneyBanner tone="late" role="alert" title={`${error.file} couldn't be read.`}
              action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => input.current?.click()}>Choose another file</button>}>
              {error.message} Nothing was saved.
            </MoneyBanner>
          )}

          <label className="mg-field app-import__vendor">
            <span className="mg-field__label">Travel vendor</span>
            <span className="mg-select-wrap">
              <select className="mg-select" value={vendor} onChange={(e) => setVendor(e.target.value)}>
                <option value="">Find from invoice numbers</option>
                {lookups.travel_vendor_list.map((v) => <option key={v.id} value={String(v.id)}>{v.name}</option>)}
              </select>
            </span>
            <span className="mg-field__hint">The whole workbook is from one agency. Left on "Find from invoice numbers", it is found from them.</span>
          </label>

          <div
            className={cn('app-drop', dragging && 'is-over', busy && 'is-busy')}
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) send(e.dataTransfer.files?.[0]); }}
            aria-busy={busy || undefined}
          >
            <span className="app-drop__mark" aria-hidden="true">{busy ? <LoaderCircle className="animate-spin" strokeWidth={1.8} /> : <Upload strokeWidth={1.8} />}</span>
            <b>{busy ? 'Reading the workbook…' : dragging ? 'Drop it to start the review' : 'Drop the travel .xlsx or .csv here'}</b>
            <span>{busy ? 'Every tab, grouped into trips and matched to POs, projects and staff.' : 'Flights, trains, buses, cabs and hotels, one row per leg, any number of monthly tabs.'}</span>
            {!busy && (
              <label className="mg-btn mg-btn--sm app-drop__choose">
                Choose a file
                <input ref={input} id="travel-import-file" type="file" accept={ACCEPT} className="sr-only" onChange={(e) => send(e.target.files?.[0])} />
              </label>
            )}
          </div>

          <div className="app-import__list">
            <h3 className="mg-label">Imports</h3>
            {listError ? (
              <MoneyBanner tone="late" role="alert" title="Couldn't load the imports." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{listError}</MoneyBanner>
            ) : loading && !batches.length ? (
              <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading the imports">{[0, 1].map((i) => <div key={i} className="mg-skel" style={{ height: 52 }} />)}</div>
            ) : batches.length === 0 ? (
              <p className="app-tabnote">No travel imports yet. Drop a workbook above to start one; it waits here as a draft until you commit it.</p>
            ) : (
              <ul className="app-batches">
                {batches.map((batch) => {
                  const look = state(batch);
                  return (
                    <li key={batch.id} className="app-line">
                      <span className={cn('app-line__mark', look.tone === 'late' && 'is-late')}><FileSpreadsheet strokeWidth={1.8} aria-hidden="true" /></span>
                      <div className="app-line__text">
                        <span className={cn('app-line__title', batch.status === 'committed' && 'text-secondary-text')}>{batch.filename}</span>
                        <span className="app-line__meta">
                          {[batch.vendor_name, batch.summary?.trips !== undefined && `${count(batch.summary.trips, 'trip')} · ${count(batch.summary.invoices, 'invoice')}`, batch.uploaded_by, ago(batch.created_at), batch.status === 'failed' && batch.error].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      <div className="app-line__end">
                        <Tone tone={look.tone}>{look.label}</Tone>
                        <button type="button" className={cn('mg-btn mg-btn--sm', look.primary && 'mg-btn--primary')} aria-label={`${look.btn}: ${batch.filename}`} onClick={() => navigate(`/import-travel/${batch.id}`)}>{look.btn}</button>
                        {batch.status !== 'committed' && (
                          <button type="button" className="mg-iconbtn" aria-label={`Delete the draft from ${batch.filename}`} title="Delete the draft" onClick={() => setDeleting(batch)}><Trash2 strokeWidth={1.8} aria-hidden="true" /></button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <details className="app-howto">
            <summary>How the import reads a workbook</summary>
            <p>
              Columns are found by their names, tab by tab, so a column added, repeated or left unnamed in one month does not
              matter; a correction you make is remembered for the vendor. Rows of one person within
              {' '}{lookups.settings?.travel_import_trip_gap_days || 7} days that chain on (out and back, or onward) become one
              trip with its legs. Rows sharing an invoice number become one agency invoice with a line per leg, and a credit or
              cancellation note is matched to the invoice it reverses.
            </p>
            <p>
              Upload the same workbook again as the month fills in. Legs, invoices and notes already in the tracker are
              recognised and kept, or updated from the sheet if you choose; only what is new is added.
            </p>
          </details>
        </section>
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
