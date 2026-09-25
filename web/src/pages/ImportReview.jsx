import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import {
  Card, DataTable, Badge, Empty, Alert, ErrorState, Modal, Field, Input, Select, Textarea, ConfirmDialog, useToast,
} from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date } from '../lib/format.js';

/**
 * Step-by-step review of one import batch. Each step is one record type,
 * in the order the site itself creates them. Nothing is written until
 * "Complete and commit" on the last step.
 *
 * A yellow row is a duplicate: the record is already on the site. Each one
 * carries a choice, keep the original or update it from the sheet (the
 * default for a deal recognised for certain that changed in the sheet).
 * Choosing on a PO carries to everything under it. Either way, a deal's new
 * remarks, follow-ups and next follow-up date are added to its history.
 */
const STEPS = [
  { key: 'quotation', label: 'Quotations' },
  { key: 'project', label: 'Projects' },
  { key: 'purchase_order', label: 'Purchase orders' },
  { key: 'stage', label: 'Payment stages' },
  { key: 'money', label: 'Invoices & receipts' },
  { key: 'summary', label: 'Summary' },
];

const DUP_CHOICES = [{ value: 'skip', label: 'Keep original' }, { value: 'update', label: 'Update from sheet' }];
// Only for a quotation matched by client and service alone: it may be a different deal.
const NEW_CHOICE = { value: 'create', label: 'Import as new' };

/**
 * How the batch was planned, in words rather than the model id the server
 * stored. Which model read the sheet is an internal detail — it means
 * nothing to whoever is importing, and it changes whenever the importer is
 * retuned. The id stays on the batch row for the record.
 *
 * Without a key the server writes "no AI key: rules only"; anything else is
 * a model that was actually used.
 */
const plannedWith = (aiModel) =>
  aiModel && !aiModel.startsWith('no AI key') ? 'AI-assisted' : 'rules only';

const FIELDS = {
  quotation: [
    { name: 'quotation_no', label: 'Quotation number' },
    { name: 'quotation_date', label: 'Quotation date', type: 'date' },
    { name: 'client_name', label: 'Client' },
    { name: 'contact_person', label: 'Contact person' },
    { name: 'service_quoted', label: 'Service quoted', span: 2 },
    { name: 'sector', label: 'Sector' },
    { name: 'sales_person', label: 'Sales person' },
    { name: 'quotation_value', label: 'Quotation value', type: 'number' },
    { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD'] },
    { name: 'status', label: 'Status', type: 'select', options: ['Submitted', 'Under Negotiation', 'Won - PO Received', 'Lost', 'On Hold'] },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ],
  project: [
    { name: 'project_id', label: 'Project ID' },
    { name: 'primary_service', label: 'Primary service', span: 2 },
    { name: 'apply_onboarding_template', label: 'Standard checklist', type: 'select', options: [{ value: 'true', label: 'Add the 11 steps' }, { value: 'false', label: 'Skip' }] },
  ],
  purchase_order: [
    { name: 'po_number', label: 'PO number' },
    { name: 'po_date', label: 'PO date', type: 'date' },
    { name: 'po_value', label: 'PO value', type: 'number' },
    { name: 'currency', label: 'Currency', type: 'select', options: ['INR', 'EUR', 'USD', 'GBP', 'AED', 'SGD'] },
    { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
    { name: 'actual_delivery_date', label: 'Actual delivery', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ],
  service: [
    { name: 'service', label: 'Service', span: 2 },
    { name: 'service_value', label: 'Value', type: 'number' },
  ],
  stage: [
    { name: 'stage_no', label: 'Stage number', type: 'number' },
    { name: 'stage_name', label: 'Stage name' },
    { name: 'trigger_event', label: 'Trigger', type: 'select', options: ['On PO Registration', 'On Delivery', 'Manual'] },
    { name: 'stage_percent', label: 'Share (0–1)', type: 'number' },
  ],
  invoice: [
    { name: 'invoice_no', label: 'Invoice number' },
    { name: 'invoice_date', label: 'Invoice date', type: 'date' },
  ],
  receipt: [
    { name: 'amount_received', label: 'Amount received', type: 'number' },
    { name: 'payment_received_date', label: 'Received on', type: 'date' },
  ],
};

export default function ImportReview() {
  const { id } = useParams();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commitError, setCommitError] = useState(null);
  const [filters, setFilters] = useState({ status: '', flagged: false, action: '' });

  const { data, loading, error, refetch } = useFetch(() => api.raw(`/import/batches/${id}`), [id]);
  const batch = data?.data;
  const items = batch?.items ?? [];
  const bySeq = useMemo(() => new Map(items.map((it) => [it.seq, it])), [items]);
  const committed = batch?.status === 'committed';

  async function patch(item, body) {
    try {
      await api.update('import/items', item.id, body);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function decideAll(stepKey, action) {
    try {
      await api.action(`/import/batches/${id}/duplicates`, { step: stepKey, action });
      toast(action === 'skip' ? 'Originals kept for every duplicate in this step' : 'Every duplicate in this step will be updated from the sheet', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /** Re-read the sheet with a changed stage reading or rule; the upload stays as it was. */
  async function replan(rules, sheet) {
    try {
      await api.action(`/import/batches/${id}/replan`, sheet ? { rules, sheet } : { rules });
      toast('Sheet read again with your choices', 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function commit() {
    setBusy(true); setCommitError(null);
    try {
      await api.action(`/import/batches/${id}/commit`);
      toast('Committed — the records are live', 'success');
      setConfirm(false);
      refetch();
      setStep(STEPS.length - 1);
    } catch (err) {
      setCommitError(err.message);
      setConfirm(false);
      refetch();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <><PageHeader title="Bulk import" /><div className="page"><ErrorState message={error} onRetry={refetch} /></div></>;
  if (loading || !batch) return <><PageHeader title="Bulk import" /><div className="page"><div className="skeleton" style={{ height: 200 }} /></div></>;

  const current = STEPS[step];
  const stepItems = (key) => items.filter((it) => (key === 'money' ? it.step === 'invoice' || it.step === 'receipt' : it.step === key));
  const counts = Object.fromEntries(STEPS.map((s) => [s.key, s.key === 'summary' ? undefined : stepItems(s.key).length]));
  const dupCounts = Object.fromEntries(STEPS.map((s) => [s.key, s.key === 'summary' ? 0 : stepItems(s.key).filter((it) => it.existing_ref).length]));
  const effectiveIncluded = (it) => it.included && it.parent_included;
  const hasErrors = items.some((it) => effectiveIncluded(it) && it.flags.some((f) => f.level === 'error'));
  const totalDuplicates = items.filter((it) => it.existing_ref).length;
  const toCreate = items.filter((it) => effectiveIncluded(it) && it.action === 'create').length;
  const toReplace = items.filter((it) => effectiveIncluded(it) && it.action === 'update').length;
  const toKeep = items.filter((it) => effectiveIncluded(it) && it.action === 'skip').length;

  const tableProps = (key) => ({
    stepKey: key,
    items: stepItems(key),
    bySeq, filters, setFilters, committed,
    onToggle: (it) => patch(it, { included: !it.included }),
    onDecide: (it, action) => patch(it, { action }),
    onDecideAll: (action) => decideAll(key, action),
    onEdit: (it) => setEditing(it),
  });

  return (
    <>
      <PageHeader
        title={`Import #${batch.id} · ${batch.filename}`}
        subtitle={`${batch.row_count} rows on sheet "${batch.sheet_name}" · ${plannedWith(batch.ai_model)}${committed ? ' · committed ' + new Date(batch.committed_at).toLocaleString() : ''}`}
        actions={<Link className="btn" to="/import">All imports</Link>}
      />
      <div className="page stack">
        {committed && <Alert tone="success">This batch has been committed. Everything below is read-only; the "Written as" column shows what was created.</Alert>}
        {batch.error && !committed && <Alert tone="danger">{batch.error}</Alert>}
        {commitError && <Alert tone="danger">{commitError}</Alert>}
        {batch.mapping?.ai_errors?.length > 0 && <Alert tone="warning">AI review partly unavailable: {batch.mapping.ai_errors.join('; ')}. Rule-based flags still apply.</Alert>}
        {!committed && batch.summary?.skipped > 0 && current.key !== 'summary' && (
          <Alert tone="info">
            <span>
              {batch.summary.skipped} of {batch.row_count} rows were left out.{' '}
              <button type="button" className="underline" onClick={() => setStep(STEPS.length - 1)}>See why on the Summary step</button>,
              where you can also change how any deal stage in the sheet is read.
            </span>
          </Alert>
        )}
        {totalDuplicates > 0 && !committed && (
          <Alert tone="warning">
            {totalDuplicates} record{totalDuplicates === 1 ? ' is' : 's are'} already on the site and shown in yellow. A deal recognised for certain whose stage, value or dates changed in the sheet is updated from it; any other keeps the original. You can change either on each row. A choice made on a purchase order carries to its stages, invoice and receipt. New remarks and follow-ups go to each deal's timeline either way.
          </Alert>
        )}

        <div className="tabs">
          {STEPS.map((s, i) => (
            <button key={s.key} type="button" className={`tab ${i === step ? 'is-active' : ''}`} onClick={() => setStep(i)}>
              {i + 1}. {s.label}
              {counts[s.key] !== undefined && <span className="tab__count">{counts[s.key]}</span>}
              {dupCounts[s.key] > 0 && <span className="tab__count" style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }} title="duplicates">{dupCounts[s.key]} dup</span>}
            </button>
          ))}
        </div>

        {current.key === 'summary' ? (
          <Summary batch={batch} items={items} effectiveIncluded={effectiveIncluded} hasErrors={hasErrors} committed={committed} onCommit={() => setConfirm(true)} onBack={() => setStep(0)} onReplan={replan} />
        ) : (
          <>
            <StepTable {...tableProps(current.key)} />
            {current.key === 'purchase_order' && <StepTable {...tableProps('service')} />}
          </>
        )}

        <div className="import-nav" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>← Back</button>
          {step < STEPS.length - 1
            ? <button type="button" className="btn btn--primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].label} →</button>
            : !committed && <button type="button" className="btn btn--primary" disabled={hasErrors || busy} onClick={() => setConfirm(true)}>Complete and commit</button>}
        </div>
      </div>

      {editing && (
        <EditItem item={editing} fields={FIELDS[editing.step]} onClose={() => setEditing(null)} onSave={async (payload) => { await patch(editing, { payload }); setEditing(null); }} />
      )}
      {confirm && (
        <ConfirmDialog
          title="Commit this import?"
          message={`${toCreate} new record${toCreate === 1 ? '' : 's'} will be written${toReplace ? `, ${toReplace} existing record${toReplace === 1 ? '' : 's'} updated from the sheet` : ''}${toKeep ? `, ${toKeep} duplicate${toKeep === 1 ? '' : 's'} kept as ${toKeep === 1 ? 'it is' : 'they are'}` : ''}. One transaction: if any one fails, nothing is written.`}
          confirmLabel={busy ? 'Committing…' : 'Complete and commit'}
          busy={busy}
          onConfirm={commit}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ table */

function StepTable({ stepKey, items, bySeq, filters, setFilters, committed, onToggle, onDecide, onDecideAll, onEdit }) {
  const rows = items.filter((it) => {
    if (filters.flagged && !it.flags.some((f) => f.code !== 'duplicate')) return false;
    if (filters.action === 'create' && it.existing_ref) return false;
    if (filters.action === 'dup' && !it.existing_ref) return false;
    if (stepKey === 'quotation' && filters.status && it.payload.status !== filters.status) return false;
    return true;
  });
  const dups = items.filter((it) => it.existing_ref).length;

  const parentOf = (it) => (it.parent_seq ? bySeq.get(it.parent_seq) : null);
  const clientOf = (it) => it.source_client || it.payload.client_name || '';
  const dupFlag = (it) => it.flags.find((f) => f.code === 'duplicate');

  const base = [
    {
      key: 'inc', header: '', width: 36,
      render: (it) => (
        <input type="checkbox" checked={it.included} disabled={committed || !it.parent_included} title={!it.parent_included ? 'Its parent is unticked' : 'Include in the commit'} onChange={() => onToggle(it)} />
      ),
    },
    { key: 'source_row', header: 'S.No', width: 60, className: 'mono small' },
  ];
  const tail = [
    {
      key: 'dup', header: 'Duplicate', className: 'wrap',
      render: (it) => {
        const f = dupFlag(it);
        if (!f) return <span className="muted">—</span>;
        return (
          <div>
            <Badge tone="warning">{f.certain === false ? 'Possible duplicate' : 'Duplicate'}</Badge>
            <div className="small" style={{ marginTop: 2 }}>on site as <span className="mono">{it.existing_ref}</span></div>
            <div className="small muted">matched by {f.match}</div>
            {f.certain === false && <div className="small" style={{ color: 'var(--warn-fg)' }}>Not certain: confirm it is the same deal</div>}
          </div>
        );
      },
    },
    { key: 'flags', header: 'Flags', className: 'wrap', render: (it) => <Flags flags={it.flags.filter((f) => f.code !== 'duplicate')} /> },
    { key: 'assumptions', header: 'Assumed', className: 'wrap small muted', render: (it) => it.assumptions.length ? it.assumptions.join(' · ') : '' },
    {
      key: 'action', header: 'Action',
      render: (it) => {
        if (!it.existing_ref) return <Badge tone="success">new</Badge>;
        if (committed) {
          if (it.action === 'create') return <Badge tone="success">imported as new</Badge>;
          return <Badge tone={it.action === 'update' ? 'warning' : 'info'}>{it.action === 'update' ? 'updated from sheet' : 'kept original'}</Badge>;
        }
        // A project follows its quotation's choice.
        if (it.action === 'create' && it.step !== 'quotation') return <Badge tone="success">new, with its quotation</Badge>;
        const uncertain = it.step === 'quotation' && dupFlag(it)?.certain === false;
        return <Select value={it.action} placeholder={null} options={uncertain ? [...DUP_CHOICES, NEW_CHOICE] : DUP_CHOICES} disabled={!it.parent_included} onChange={(e) => onDecide(it, e.target.value)} />;
      },
    },
    committed
      ? { key: 'committed_ref', header: 'Written as', className: 'mono small' }
      : { key: 'edit', header: '', align: 'right', render: (it) => <button type="button" className="btn btn--sm btn--ghost" onClick={() => onEdit(it)}>Edit</button> },
  ];

  const middle = {
    quotation: [
      { key: 'no', header: 'Number', className: 'mono', render: (it) => it.payload.quotation_no },
      { key: 'date', header: 'Date', render: (it) => date(it.payload.quotation_date) },
      { key: 'client', header: 'Client', className: 'strong', render: (it) => <>{it.payload.client_name}<div className="small muted">{it.payload.contact_person}</div></> },
      { key: 'service', header: 'Service', className: 'wrap', render: (it) => it.payload.service_quoted },
      { key: 'value', header: 'Value', align: 'right', render: (it) => money(it.payload.quotation_value, it.payload.currency) },
      { key: 'status', header: 'Status', render: (it) => <Badge>{it.payload.status}</Badge> },
    ],
    project: [
      { key: 'pid', header: 'Project ID', className: 'mono', render: (it) => it.payload.project_id },
      { key: 'client', header: 'Client', className: 'strong', render: clientOf },
      { key: 'service', header: 'Primary service', className: 'wrap', render: (it) => it.payload.primary_service },
      { key: 'from', header: 'From quotation', className: 'mono small', render: (it) => parentOf(it)?.payload.quotation_no },
      { key: 'chk', header: 'Checklist', render: (it) => (it.payload.apply_onboarding_template ? '11 steps' : 'none') },
    ],
    purchase_order: [
      { key: 'po', header: 'PO number', className: 'mono strong', render: (it) => it.payload.po_number },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'pid', header: 'Project', className: 'mono small', render: (it) => it.payload.project_id },
      { key: 'date', header: 'PO date', render: (it) => date(it.payload.po_date) },
      { key: 'value', header: 'Value', align: 'right', render: (it) => money(it.payload.po_value, it.payload.currency) },
      { key: 'terms', header: 'Terms', align: 'right', render: (it) => `${it.payload.payment_terms_days} d` },
      { key: 'deliv', header: 'Delivery', render: (it) => date(it.payload.actual_delivery_date) },
    ],
    service: [
      { key: 'po', header: 'PO number', className: 'mono', render: (it) => it.payload.po_number },
      { key: 'service', header: 'Service line', className: 'wrap', render: (it) => it.payload.service },
      { key: 'value', header: 'Value', align: 'right', render: (it) => money(it.payload.service_value) },
    ],
    stage: [
      { key: 'po', header: 'PO number', className: 'mono', render: (it) => it.payload.po_number },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'n', header: '#', align: 'right', render: (it) => it.payload.stage_no },
      { key: 'name', header: 'Stage', render: (it) => it.payload.stage_name },
      { key: 'trig', header: 'Trigger', render: (it) => it.payload.trigger_event },
      { key: 'pct', header: '%', align: 'right', render: (it) => `${Math.round(it.payload.stage_percent * 100)}%` },
      { key: 'amt', header: 'Amount', align: 'right', render: (it) => { const po = parentOf(it); return po ? money(po.payload.po_value * it.payload.stage_percent, po.payload.currency) : '—'; } },
    ],
    money: [
      { key: 'kind', header: 'Type', render: (it) => <Badge tone={it.step === 'invoice' ? 'info' : 'success'}>{it.step}</Badge> },
      { key: 'po', header: 'PO number', className: 'mono', render: (it) => it.payload.po_number },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'stage', header: 'Stage', render: (it) => parentOf(it)?.payload.stage_name || `stage ${it.payload.stage_no}` },
      { key: 'detail', header: 'Detail', className: 'mono', render: (it) => (it.step === 'invoice' ? it.payload.invoice_no : money(it.payload.amount_received)) },
      { key: 'date', header: 'Date', render: (it) => date(it.step === 'invoice' ? it.payload.invoice_date : it.payload.payment_received_date) },
    ],
  }[stepKey];

  const possible = items.filter((it) => it.existing_ref && dupFlag(it)?.certain === false).length;
  return (
    <Card
      flush
      title={stepKey === 'service' ? 'Service lines' : STEPS.find((s) => s.key === stepKey).label}
      hint={hint(stepKey)}
      actions={
        <div className="card__actions">
          {stepKey === 'quotation' && (
            <Select value={filters.status} placeholder="Status: all" options={['Won - PO Received', 'Under Negotiation', 'Lost', 'On Hold']} onChange={(e) => setFilters({ ...filters, status: e.target.value })} />
          )}
          <Select value={filters.action} placeholder="Show: all" options={[{ value: 'create', label: 'New only' }, { value: 'dup', label: 'Duplicates only' }]} onChange={(e) => setFilters({ ...filters, action: e.target.value })} />
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={filters.flagged} onChange={(e) => setFilters({ ...filters, flagged: e.target.checked })} /> Flagged only
          </label>
          {dups > 0 && !committed && (
            <>
              <button type="button" className="btn btn--sm" onClick={() => onDecideAll('skip')} title="Every duplicate in this step keeps the site's record">Keep all originals</button>
              <button type="button" className="btn btn--sm" onClick={() => onDecideAll('update')} title="Every duplicate in this step takes the sheet's values">Update all from sheet</button>
            </>
          )}
          <span className="small muted">{rows.length} of {items.length}{dups ? ` · ${dups} duplicate${dups === 1 ? '' : 's'}` : ''}</span>
        </div>
      }
    >
      {possible > 0 && (
        <div style={{ padding: '10px 14px 0' }}>
          <Alert tone="warning">
            {possible} possible duplicate{possible === 1 ? ' was' : 's were'} matched only by client name and service
            (and the proposal date, when the sheet has one). This is how Lost, Under Negotiation and On Hold deals are
            matched, because they have no PO number; a quotation number in the sheet makes the match exact. The match
            may be wrong: a client can have two proposals for the same service. Check each one before keeping the
            original: if it is a different deal, choose "Import as new" and it is added with the next quotation number.
          </Alert>
        </div>
      )}
      <DataTable
        rows={rows}
        columns={[...base, ...middle, ...tail]}
        rowClassName={(it) => (it.existing_ref ? 'tr--dup' : '')}
        empty={<Empty title="Nothing in this step" text={items.length ? 'Nothing matches the filters.' : 'The sheet produced no records of this kind.'} />}
      />
    </Card>
  );
}

function hint(stepKey) {
  return {
    quotation: 'One per sheet row. Yellow rows are already on the site, matched by PO number or quotation number; "possible" duplicates matched by client, service and date. Keeping the original only fills its blank fields.',
    project: 'One per won deal with a PO. Registered from its quotation, with the next free project ID. Yellow: the quotation or PO already has a project.',
    purchase_order: 'The PO for each won deal. Dates marked as assumed follow the agreed rules. Yellow: the PO number is already on the site; your choice here carries to its stages, invoice and receipt.',
    service: 'One line per PO saying what it covers, at the PO value.',
    stage: 'The payment split per PO. Read from the remarks where stated, 50/50 otherwise, 100% on delivery where the terms say so. Yellow: that stage number already exists on the PO.',
    money: 'Invoices and receipts the sheet shows, recorded on the advance stage. Yellow: the stage already carries an invoice or a receipt.',
  }[stepKey];
}

function Flags({ flags }) {
  if (!flags.length) return <span className="muted">—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {flags.map((f, i) => (
        <span key={i} title={`${f.message}${f.by === 'ai' ? ' (AI)' : ''}`}>
          <Badge tone={f.level === 'error' ? 'danger' : f.level === 'warn' ? 'warning' : 'info'}>{f.by === 'ai' ? '✦ ' : ''}{f.message}</Badge>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------ summary */

function Summary({ batch, items, effectiveIncluded, hasErrors, committed, onCommit, onBack, onReplan }) {
  const steps = STEPS.filter((s) => s.key !== 'summary' && s.key !== 'money').map((s) => s.key).concat(['service', 'invoice', 'receipt']);
  const count = (key, pred) => items.filter((it) => it.step === key && pred(it)).length;
  const assumptions = items.filter(effectiveIncluded).flatMap((it) => it.assumptions.map((a) => `S.No ${it.source_row}: ${a}`));
  const skipped = batch.summary?.skipped_rows || [];
  const errors = items.filter((it) => effectiveIncluded(it) && it.flags.some((f) => f.level === 'error'));
  const replacing = items.filter((it) => effectiveIncluded(it) && it.action === 'update');
  const tracked = items.filter((it) => it.step === 'quotation' && effectiveIncluded(it) && it.payload?.tracking).map((it) => it.payload.tracking);
  const history = {
    notes: tracked.reduce((n, t) => n + (t.notes?.length || 0), 0),
    deals: tracked.filter((t) => t.notes?.length).length,
    reminders: tracked.filter((t) => t.follow_up).length,
    contacts: tracked.filter((t) => t.last_contacted).length,
    closed: tracked.filter((t) => t.close_follow_up).length,
  };
  const label = { quotation: 'Quotations', project: 'Projects', purchase_order: 'Purchase orders', service: 'Service lines', stage: 'Payment stages', invoice: 'Invoices', receipt: 'Receipts' };
  const stepLabel = { quotation: 'quotation', project: 'project', purchase_order: 'PO', service: 'service line', stage: 'stage', invoice: 'invoice', receipt: 'receipt' };

  return (
    <div className="stack">
      {hasErrors && !committed && (
        <Alert tone="danger">{errors.length} included item(s) still have errors (for example an invoice with no date). Fix them on the earlier steps, or untick them, before committing.</Alert>
      )}
      <Card title="What will be written" hint={committed ? 'What was written' : 'Only ticked items whose parents are also ticked. Duplicates keep the original unless set to update from the sheet.'}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Record</th><th className="num">New</th><th className="num">Keep original</th><th className="num">Update from sheet</th><th className="num">Unticked</th></tr></thead>
            <tbody>
              {steps.map((k) => (
                <tr key={k}>
                  <td>{label[k]}</td>
                  <td className="num">{count(k, (it) => effectiveIncluded(it) && it.action === 'create')}</td>
                  <td className="num">{count(k, (it) => effectiveIncluded(it) && it.action === 'skip')}</td>
                  <td className="num" style={{ color: 'var(--warn-fg)' }}>{count(k, (it) => effectiveIncluded(it) && it.action === 'update')}</td>
                  <td className="num muted">{count(k, (it) => !effectiveIncluded(it))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {replacing.length > 0 && !committed && (
        <Card title={`Existing records updated from the sheet · ${replacing.length}`} hint="The sheet's values replace the tracker's; fields the sheet leaves blank are not touched. Remarks written in the tracker itself are kept on the deal's timeline.">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {replacing.map((it) => {
              const changed = it.flags.find((f) => f.code === 'sheet_changes');
              return <li key={it.id}>S.No {it.source_row}: {stepLabel[it.step]} <span className="mono">{it.existing_ref}</span>{changed ? ` · ${changed.message.replace(/^Updated from the sheet: /, '')}` : ''}</li>;
            })}
          </ul>
        </Card>
      )}

      {history.notes + history.reminders + history.contacts + history.closed > 0 && (
        <Card title="Added to the deals' history" hint={committed ? 'What the sheet added' : "From the sheet's remarks and follow-up columns. Text already on a deal is not added again."}>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {history.notes > 0 && <li>{history.notes} note{history.notes === 1 ? '' : 's'} on {history.deals} deal timeline{history.deals === 1 ? '' : 's'} (remarks and follow-up comments)</li>}
            {history.reminders > 0 && <li>{history.reminders} follow-up reminder{history.reminders === 1 ? '' : 's'} for the salespeople, from the next follow-up dates</li>}
            {history.contacts > 0 && <li>{history.contacts} deal{history.contacts === 1 ? '' : 's'} with a newer last-contact date, from the last follow-up dates</li>}
            {history.closed > 0 && <li>{history.closed} reminder{history.closed === 1 ? '' : 's'} closed because the deal was lost</li>}
          </ul>
        </Card>
      )}

      <SheetReading
        key={JSON.stringify([batch.sheet_name, batch.rules?.stage_map, batch.rules?.won_requires_po, batch.rules?.exclude_iso, batch.rules?.update_from_sheet, batch.summary?.stage_values])}
        batch={batch}
        committed={committed}
        onReplan={onReplan}
      />

      <Card title={`Rows left out · ${skipped.length}`} hint="These never became records. Change a stage reading or a rule above to bring any of them in.">
        {skipped.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>S.No</th><th>Client</th><th>Deal stage in the sheet</th><th>Reason</th></tr></thead>
              <tbody>{skipped.map((s, i) => <tr key={i}><td className="mono small">{s.ref || s.sno}</td><td>{s.client}</td><td className="small">{s.stage}</td><td className="small">{s.reason}</td></tr>)}</tbody>
            </table>
          </div>
        ) : <span className="muted">None</span>}
      </Card>

      <Card title={`Assumptions · ${assumptions.length}`} hint="Every assumed value is also written into the record's Remarks.">
        {assumptions.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul> : <span className="muted">None</span>}
      </Card>

      {!committed && (
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" className="btn" onClick={onBack}>Back to review</button>
          <button type="button" className="btn btn--primary" disabled={hasErrors} onClick={onCommit}>Complete and commit</button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ sheet reading */

// What a stage wording can be read as. The first five are quotation
// statuses; the last two leave the row out.
const STAGE_CHOICES = [
  { value: 'Won - PO Received', label: 'Won - PO Received' },
  { value: 'Under Negotiation', label: 'Under Negotiation' },
  { value: 'Submitted', label: 'Submitted' },
  { value: 'On Hold', label: 'On Hold' },
  { value: 'Lost', label: 'Lost' },
  { value: 'lead', label: 'Early lead: leave out' },
  { value: 'skip', label: 'Leave out' },
];
const isChoice = (v) => STAGE_CHOICES.some((c) => c.value === v);

/**
 * Every deal-stage wording in the sheet, what it was read as, and a way to
 * read it differently — plus the two agreed rules that leave rows out, as
 * switches. "Read again" re-plans the same upload with the choices.
 */
function SheetReading({ batch, committed, onReplan }) {
  const values = batch.summary?.stage_values || [];
  const rules = batch.rules || {};
  const dropped = batch.mapping?.dropped_columns || [];
  const [choice, setChoice] = useState(() => Object.fromEntries(values.map((v) => [v.key, isChoice(v.reading) ? v.reading : ''])));
  const [wonNeedsPo, setWonNeedsPo] = useState(rules.won_requires_po !== false);
  const [excludeIso, setExcludeIso] = useState(rules.exclude_iso !== false);
  const [updateFromSheet, setUpdateFromSheet] = useState(rules.update_from_sheet !== false);
  const sheets = batch.mapping?.sheets || [];
  const [sheet, setSheet] = useState(batch.sheet_name);
  const [busy, setBusy] = useState(false);

  const changed = values.filter((v) => choice[v.key] && choice[v.key] !== v.reading);
  const rulesChanged = wonNeedsPo !== (rules.won_requires_po !== false) || excludeIso !== (rules.exclude_iso !== false)
    || updateFromSheet !== (rules.update_from_sheet !== false);
  const sheetChanged = sheet !== batch.sheet_name;
  const unread = values.filter((v) => !isChoice(v.reading)).length;
  const byAi = values.filter((v) => v.by === 'ai').length;

  async function apply() {
    setBusy(true);
    const stageMap = { ...(rules.stage_map || {}) };
    for (const v of changed) stageMap[v.key] = choice[v.key];
    await onReplan({ stage_map: stageMap, won_requires_po: wonNeedsPo, exclude_iso: excludeIso, update_from_sheet: updateFromSheet }, sheetChanged ? sheet : null);
    setBusy(false);
  }

  const readingLabel = (v) => (v.reading === 'unknown' ? 'Not understood' : STAGE_CHOICES.find((c) => c.value === v.reading)?.label || v.reading);

  return (
    <Card
      title={`How the sheet's deal stages were read · ${values.length}`}
      hint={committed ? 'How the sheet was read when it was committed.' : 'Every wording in the deal-stage column. Change any reading and read the sheet again; nothing is written until you commit.'}
    >
      <div className="stack">
        {unread > 0 && !committed && <Alert tone="warning">{unread} wording{unread === 1 ? ' was' : 's were'} not understood. Choose a reading for {unread === 1 ? 'it' : 'each'}, or its rows stay out.</Alert>}
        {byAi > 0 && !committed && <Alert tone="info">{byAi} wording{byAi === 1 ? ' was' : 's were'} read by the AI (marked ✦), because the rules were unsure of {byAi === 1 ? 'it' : 'them'}. Check {byAi === 1 ? 'it' : 'them'} before you commit.</Alert>}
        {dropped.length > 0 && <Alert tone="info">Left out of the upload entirely, because they hold sign-in details: {dropped.join(', ')}. They were not stored or sent anywhere.</Alert>}
        {sheets.length > 1 && (
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>Read from the tab</span>
            <span style={{ minWidth: 220 }}>
              <Select aria-label="Tab to read" value={sheet} placeholder={null} options={sheets} disabled={committed} onChange={(e) => setSheet(e.target.value)} />
            </span>
            <span className="muted">The tab whose headers look most like a sales sheet was chosen.</span>
          </label>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>In the sheet</th><th className="num">Rows</th><th>Read as</th></tr></thead>
            <tbody>
              {values.map((v) => (
                <tr key={v.key}>
                  <td>
                    {v.value}
                    {v.by === 'admin' && <span className="muted small"> · your reading</span>}
                    {v.by === 'ai' && <span className="muted small"> · ✦ read by the AI</span>}
                  </td>
                  <td className="num">{v.rows}</td>
                  <td style={{ minWidth: 220 }}>
                    {committed
                      ? readingLabel(v)
                      : (
                        <Select
                          aria-label={`Read "${v.value}" as`}
                          value={choice[v.key] || ''}
                          placeholder="Not understood: choose"
                          options={STAGE_CHOICES}
                          onChange={(e) => setChoice((s) => ({ ...s, [v.key]: e.target.value }))}
                        />
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={wonNeedsPo} disabled={committed} onChange={(e) => setWonNeedsPo(e.target.checked)} />
            A won deal needs a PO number to be imported (the rule agreed with the sales lead)
          </label>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={excludeIso} disabled={committed} onChange={(e) => setExcludeIso(e.target.checked)} />
            Leave out ISO proposals
          </label>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={updateFromSheet} disabled={committed} onChange={(e) => setUpdateFromSheet(e.target.checked)} />
            Deals already in the tracker take what changed in the sheet (stage, value, dates), when they are recognised for certain. A won deal is never moved back.
          </label>
        </div>
        {!committed && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn--primary" disabled={busy || (!changed.length && !rulesChanged && !sheetChanged)} onClick={apply}>
              {busy ? 'Reading again…' : `Apply and read again${changed.length ? ` (${changed.length} change${changed.length === 1 ? '' : 's'})` : ''}`}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ edit */

function EditItem({ item, fields, onClose, onSave }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, item.payload[f.name] ?? ''])));
  const [busy, setBusy] = useState(false);
  const set = (name, v) => setValues((s) => ({ ...s, [name]: v }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const payload = {};
    for (const f of fields) {
      let v = values[f.name];
      if (v === '') v = null;
      else if (f.type === 'number') v = Number(v);
      else if (f.type === 'select' && (v === 'true' || v === 'false')) v = v === 'true';
      payload[f.name] = v;
    }
    await onSave(payload);
    setBusy(false);
  }

  return (
    <Modal
      title={`Edit ${item.step.replace('_', ' ')}`}
      subtitle={`S.No ${item.source_row}${item.existing_ref ? ' · duplicate of ' + item.existing_ref : ''}${item.assumptions.length ? ' · assumed: ' + item.assumptions.join('; ') : ''}`}
      onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="edit-item" className="btn btn--primary" disabled={busy}>Save</button></>}
    >
      <form id="edit-item" onSubmit={submit} className="form-grid">
        {fields.map((f) => (
          <div key={f.name} className={f.span === 'all' ? 'span-all' : f.span === 2 ? 'span-2' : ''}>
            <Field label={f.label}>
              {f.type === 'select'
                ? <Select value={String(values[f.name] ?? '')} options={f.options} onChange={(e) => set(f.name, e.target.value)} />
                : f.type === 'textarea'
                  ? <Textarea rows={3} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} />
                  : <Input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} step={f.type === 'number' ? 'any' : undefined} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} />}
            </Field>
          </div>
        ))}
      </form>
    </Modal>
  );
}
