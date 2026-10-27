import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, UploadCloud } from 'lucide-react';
import { cn } from 'cn';
import { Alert, ConfirmDialog, useToast } from '../components/ui.jsx';
import { Chip } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { ago, number } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';

/**
 * Bulk import, on C12's shape.
 *
 * "A spreadsheet in, a review out" is the whole promise, and the page had
 * been stating it in a paragraph while showing a file input and an
 * eight-column table. The drop zone is the page now, and what came before
 * is a short list that says, per sheet, whether it still needs a person —
 * because a draft nobody reviewed is the failure mode here, not a failed
 * upload.
 *
 * Nothing is written to the live tables until the final review is
 * committed, which is why a draft sitting in this list is harmless and
 * worth keeping.
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
  if (batch.status === 'failed') return { tone: 'late', label: 'Could not be read' };
  if (batch.status === 'committed') {
    return { tone: 'settled', icon: Check, label: `${number(batch.row_count)} rows in` };
  }
  const dupes = duplicates(batch.summary);
  return { tone: 'waiting', label: dupes ? `Review · ${number(dupes)} duplicates` : `Review · ${number(batch.row_count)} rows` };
}

export default function BulkImport() {
  const navigate = useNavigate();
  const toast = useToast();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState(null);

  const { data, loading, refetch } = useFetch(() => api.raw('/import/batches'), []);
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
      <SettingsPane
        title="Import"
        description="A spreadsheet in, a review out. Nothing is written until you approve the batch."
        actions={
          <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" asChild>
            <a href={api.importTemplateUrl()} download>Download the template</a>
          </Button>
        }
      >

        {error && <Alert tone="danger">{error}</Alert>}

        {/* The label is the drop target, so a click and a drag land in the
            same place and the file input itself never has to be seen. */}
        <label
          htmlFor="import-file"
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
          <div className="mt-3 text-[13px] font-medium text-foreground">
            {busy ? 'Reading the sheet…' : 'Drop an .xlsx or .csv'}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            {busy
              ? 'Matching against the site and flagging anything odd. Usually under a minute.'
              : 'Quotations, projects, purchase orders, payment stages and invoices'}
          </div>
        </label>
        <input
          ref={fileRef}
          id="import-file"
          type="file"
          accept={ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={(e) => send(e.target.files?.[0])}
        />

        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {loading && !batches.length ? (
            <div className="skeleton m-[18px] h-[88px]" />
          ) : batches.length === 0 ? (
            <p className="px-5 py-6 text-[13px]/[1.7] text-secondary-text">
              No imports yet. Drop a sheet above to start one.
            </p>
          ) : batches.map((batch, i) => {
            const look = state(batch);
            const summary = planned(batch.summary);
            return (
              <div
                key={batch.id}
                className={cn('flex flex-wrap items-center gap-3 px-4 py-2.5', i < batches.length - 1 && 'border-b border-border')}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => navigate(`/import/${batch.id}`)}
                >
                  <div className={cn('truncate text-[13px] font-medium', batch.status === 'committed' ? 'text-secondary-text' : 'text-foreground')}>
                    {batch.filename}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">
                    {[summary, batch.uploaded_by, ago(batch.created_at)].filter(Boolean).join(' · ')}
                  </div>
                </button>
                <Chip tone={look.tone} icon={look.icon}>{look.label}</Chip>
                <Button variant="secondary" size="sm" className="h-7 px-3 text-[12.5px]" onClick={() => navigate(`/import/${batch.id}`)}>
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
          Any sales sheet works: the header row, the tab and the columns are found by their names, and deal stages are
          read the way people write them ("PO received – 50% advance invoiced" is won). Duplicates are matched on the
          reference number, then on client and date. A row that already exists is shown beside its match, never silently
          skipped. ISO proposals are left out, a won deal needs a PO number, a missing PO date becomes the proposal plus
          seven days, and a missing invoice date the PO plus one. The review shows every stage reading and both rules,
          and lets you change them.
        </p>
        <p className="max-w-[80ch] text-[11.5px]/[1.6] text-muted-foreground">
          Upload the same sheet again whenever the team updates it. Deals it wrote before are recognised and take what
          changed (stage, value, dates). New remarks and follow-up comments go onto each deal's timeline, without
          repeating what is already there. The last follow-up date becomes the deal's last contact, and the next
          follow-up date a reminder for its salesperson.
        </p>
      </SettingsPane>

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
