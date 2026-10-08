import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileSpreadsheet, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { ago, number, sentence } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Bulk import, Wave 8 — the same shape as Import travel (PR 7): one glass
 * panel, a drop zone with a real "Choose a file" button and a visible focus
 * ring, its drag-over and reading states, a failed read as a banner, the
 * imports list with where each one stands and one button (Review, View or
 * See why), and the reading rules as short bullets.
 *
 * Nothing is written to the live tables until the final review is
 * committed, which is why a draft sitting in this list is harmless.
 */

const ACCEPT = '.xlsx,.xls,.csv';

/** How many rows the importer thinks already exist on the site. */
function duplicates(summary) {
  return Object.values(summary?.steps ?? {}).reduce((n, step) => n + (step.duplicates || 0), 0);
}

function planned(summary) {
  if (!summary?.steps) return null;
  const s = summary.steps;
  const n = (k) => (s[k]?.create || 0);
  return `${number(n('quotation'))} quotations · ${number(n('purchase_order'))} POs · ${number(n('invoice'))} invoices`;
}

/** Where a batch has got to, in the words somebody would use. */
function state(batch) {
  if (batch.status === 'failed') return { tone: 'late', label: 'Could not be read', btn: 'See why' };
  if (batch.status === 'committed') return { tone: 'ok', label: `${number(batch.row_count)} rows in`, btn: 'View' };
  const dupes = duplicates(batch.summary);
  return { tone: 'wait', label: dupes ? `Review · ${number(dupes)} duplicates` : `Review · ${number(batch.row_count)} rows`, btn: 'Review', primary: true };
}

export default function BulkImport() {
  const navigate = useNavigate();
  const toast = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [removing, setRemoving] = useState(false);

  const { data, loading, error: listError, refetch } = useFetch(() => api.raw('/import/batches'), []);
  const batches = data?.data ?? [];

  async function send(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api.upload('/import/batches', form);
      toast('Sheet read — review what was found', 'success');
      navigate(`/import/${result.data.id}`);
    } catch (err) {
      setError({ message: err.message, file: file.name });
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove(batch) {
    setRemoving(true);
    try {
      await api.remove('import/batches', batch.id);
      toast('Draft deleted', 'success');
      setDeleting(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <SettingsPane
        title="Import"
        description="A spreadsheet in, a review out. Nothing is written until you approve the batch."
        actions={<a className="mg-btn" href={api.importTemplateUrl()} download><Download className="size-4" strokeWidth={1.8} aria-hidden="true" />Download the template</a>}
      >
        <section className="mg-glass mg-glass--strong app-import" data-a="rise" aria-label="Import a sales sheet">
          {error && (
            <MoneyBanner tone="late" role="alert" title={`Couldn’t read “${error.file}”.`}
              action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => input.current?.click()}>Choose another file</button>}>
              {' '}{sentence(error.message)} Nothing was saved.
            </MoneyBanner>
          )}

          <div
            className={cn('app-drop', dragging && 'is-over', busy && 'is-busy')}
            onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (!busy) send(e.dataTransfer.files?.[0]); }}
            aria-busy={busy || undefined}
          >
            <span className="app-drop__mark" aria-hidden="true">{busy ? <LoaderCircle className="animate-spin" strokeWidth={1.8} /> : <Upload strokeWidth={1.8} />}</span>
            <b>{busy ? 'Reading the sheet…' : dragging ? 'Let go to read it' : 'Drop an .xlsx or .csv here'}</b>
            <span>{busy ? 'Matching against the site and flagging anything odd. Usually under a minute.' : 'Quotations, projects, purchase orders, payment stages and invoices.'}</span>
            {busy ? (
              <div className="mg-progress mt-2 w-full max-w-[280px]" role="progressbar" aria-label="Reading the sheet"><span className="mg-progress__done set-indet" /></div>
            ) : (
              <label className="mg-btn mg-btn--primary mg-btn--sm app-drop__choose">
                Choose a file
                <input ref={input} id="import-file" type="file" accept={ACCEPT} className="sr-only" disabled={busy} onChange={(e) => send(e.target.files?.[0])} />
              </label>
            )}
            {!busy && <span>.xlsx, .xls or .csv · or drop it anywhere on this box</span>}
          </div>

          <div className="app-import__list">
            <h3 className="mg-label">Earlier imports</h3>
            {listError ? (
              <MoneyBanner tone="late" role="alert" title="Couldn’t load the imports." action={<button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>}>{' '}{listError}</MoneyBanner>
            ) : loading && !batches.length ? (
              <div className="flex flex-col gap-2.5" aria-busy="true" aria-label="Loading the imports">{[0, 1].map((i) => <div key={i} className="mg-skel" style={{ height: 52 }} />)}</div>
            ) : batches.length === 0 ? (
              <p className="app-tabnote">No imports yet. Drop a sheet above to start one. Nothing is written until you approve it.</p>
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
                          {[planned(batch.summary), batch.uploaded_by, ago(batch.created_at), batch.status === 'failed' && batch.error].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      <div className="app-line__end">
                        <Tone tone={look.tone}>{look.label}</Tone>
                        <button type="button" className={cn('mg-btn mg-btn--sm', look.primary && 'mg-btn--primary')} aria-label={`${look.btn}: ${batch.filename}`} onClick={() => navigate(`/import/${batch.id}`)}>{look.btn}</button>
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
            <summary>How it reads your sheet</summary>
            <ul className="mt-2.5 mb-0 flex list-disc flex-col gap-1.5 pl-5 text-[12.5px]/[1.6] text-secondary-text">
              <li>Any sales sheet works: the header row, the tab and the columns are found by their names, and deal stages are read the way people write them (“PO received – 50% advance invoiced” is won).</li>
              <li>Every row becomes a quotation. A won row with a PO also becomes a project, a PO, its payment stages, and any invoice or receipt the sheet shows.</li>
              <li>Duplicates are matched on the reference number, then on client and date. A row that already exists is shown beside its match, never silently skipped.</li>
              <li>ISO proposals are left out, a won deal needs a PO number, a missing PO date becomes the proposal plus seven days, and a missing invoice date the PO plus one. The review shows every stage reading and both rules, and lets you change them.</li>
              <li>Upload the same sheet again whenever the team updates it. Deals it wrote before take what changed; new remarks go on each deal’s timeline, and the next follow-up date becomes a reminder for its salesperson.</li>
            </ul>
          </details>
        </section>
      </SettingsPane>

      {deleting && (
        <ConfirmDialog
          title="Delete this draft?"
          subtitle={`${deleting.filename} · ${state(deleting).label}`}
          message={`The draft from “${deleting.filename}” will be removed. Nothing on the live site changes.`}
          confirmLabel="Delete draft"
          cancelLabel="Keep it"
          busy={removing}
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
