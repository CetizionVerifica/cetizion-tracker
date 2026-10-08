import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { cn } from 'cn';
import { PageHeader } from '../App.jsx';
import { ConfirmDialog, Field, Input, Modal, Select, Textarea, useToast } from '../components/ui.jsx';
import { ListTable, PhoneRow, StateCard } from '../components/daily.jsx';
import { DialogError, MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { SetStrip } from '../components/settings.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';
import { money, date, number, sentence } from '../lib/format.js';

/**
 * Step-by-step review of one import batch (`/import/:id`), Wave 8. Each
 * step is one record type, in the order the site itself creates them.
 * Nothing is written until "Complete and commit" on the last step.
 *
 * A Duplicate row is a record already on the site. Each one carries a
 * choice, keep the original or update it from the sheet (the default for a
 * deal recognised for certain that changed in the sheet). Choosing on a PO
 * carries to everything under it. Either way, a deal's new remarks,
 * follow-ups and next follow-up date are added to its history.
 *
 * Wave 8: one strip of four numbers instead of stacked alerts, a Duplicate
 * badge on phones too, the include box and the choice on each phone row,
 * the edit dialog stays open with the server's reason on a failed save,
 * the commit is a primary button (off while errors remain) that says
 * "Committing N records…", and loading or failing keeps the title.
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
const STATUSES = ['Submitted', 'Under Negotiation', 'Won - PO Received', 'Lost', 'On Hold'];
const STATUS_TONE = { 'Won - PO Received': 'ok', Lost: 'late', 'Under Negotiation': 'wait', 'On Hold': 'plain', Submitted: 'info' };
const NOUN = { quotation: 'quotation', project: 'project', purchase_order: 'purchase order', service: 'service line', stage: 'payment stage', invoice: 'invoice', receipt: 'receipt' };

/**
 * How the batch was planned, in words rather than the model id the server
 * stored. Without a key the server writes "no AI key: rules only"; anything
 * else is a model that was actually used.
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
    { name: 'status', label: 'Status', type: 'select', options: STATUSES },
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

/** The header every state wears: crumbs back to Settings › Data › Import. */
function Head({ title, subtitle }) {
  return (
    <PageHeader
      eyebrow=""
      title={title}
      subtitle={subtitle}
      lead={<nav className="mg-crumbs set-crumbs" aria-label="Breadcrumb"><Link to="/settings">Settings</Link><span aria-hidden="true">›</span><span>Data</span><span aria-hidden="true">›</span><Link to="/settings/import">Import</Link></nav>}
      actions={<Link to="/settings/import" className="mg-btn">All imports</Link>}
    />
  );
}

export default function ImportReview() {
  const { id } = useParams();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [editing, setEditing] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commitError, setCommitError] = useState(null);
  const [filters, setFilters] = useState({ status: '', flagged: false, action: '' });

  const { data, loading, fresh, error, refetch } = useFetch(() => api.raw(`/import/batches/${id}`), [id]);
  const batch = data?.data;
  const items = batch?.items ?? [];
  const bySeq = useMemo(() => new Map(items.map((it) => [it.seq, it])), [items]);
  const committed = batch?.status === 'committed';

  async function patch(item, body, quiet = false) {
    try {
      await api.update('import/items', item.id, body);
      refetch();
      return null;
    } catch (err) {
      if (!quiet) toast(err.message, 'danger');
      return err.message;
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

  if (error) {
    return (
      <>
        <Head title={`Import #${id}`} />
        <div className="app-page">
        <StateCard tone="late" role="alert" title="Couldn’t load this import" text={`${sentence(error)} Nothing has changed; the draft is still there.`}>
          <button type="button" className="mg-btn mg-btn--sm" onClick={refetch}>Try again</button>
        </StateCard>
        </div>
      </>
    );
  }
  if ((loading && !fresh) || !batch) {
    return (
      <>
        <Head title={`Import #${id}`} subtitle="Loading the review…" />
        <div className="app-page" aria-busy="true">
        <section className="mg-glass mg-strip set-strip" aria-label="Loading">{[0, 1, 2, 3].map((i) => <div key={i}><span className="mg-skel" style={{ height: 10, width: '50%' }} /><span className="mg-skel" style={{ height: 26, width: '40%' }} /></div>)}</section>
        <section className="mg-glass mg-panel" aria-label="Loading">{[0, 1, 2, 3].map((i) => <div key={i} className="mg-skel" style={{ height: 44 }} />)}</section>
        </div>
      </>
    );
  }

  const current = STEPS[step];
  const stepItems = (key) => items.filter((it) => (key === 'money' ? it.step === 'invoice' || it.step === 'receipt' : it.step === key));
  const counts = Object.fromEntries(STEPS.map((s) => [s.key, s.key === 'summary' ? undefined : stepItems(s.key).length]));
  const dupCounts = Object.fromEntries(STEPS.map((s) => [s.key, s.key === 'summary' ? 0 : stepItems(s.key).filter((it) => it.existing_ref).length]));
  const effectiveIncluded = (it) => it.included && it.parent_included;
  const isError = (it) => effectiveIncluded(it) && it.flags.some((f) => f.level === 'error');
  const errorCounts = Object.fromEntries(STEPS.map((s) => [s.key, s.key === 'summary' ? 0 : [...stepItems(s.key), ...(s.key === 'purchase_order' ? stepItems('service') : [])].filter(isError).length]));
  const errors = items.filter(isError);
  const hasErrors = errors.length > 0;
  const totalDuplicates = items.filter((it) => it.existing_ref).length;
  const toCreate = items.filter((it) => effectiveIncluded(it) && it.action === 'create').length;
  const toReplace = items.filter((it) => effectiveIncluded(it) && it.action === 'update').length;
  const toKeep = items.filter((it) => effectiveIncluded(it) && it.action === 'skip').length;
  const skipped = batch.summary?.skipped ?? 0;

  /** From the summary to the first step with a row in error, showing only those. */
  const showErrors = () => {
    const first = errors[0];
    const at = first ? STEPS.findIndex((s) => (s.key === 'money' ? ['invoice', 'receipt'].includes(first.step) : s.key === first.step || (s.key === 'purchase_order' && first.step === 'service'))) : -1;
    setFilters({ status: '', flagged: false, action: 'errors' });
    if (at >= 0) setStep(at);
  };

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
      <Head
        title={`Import #${batch.id} · ${batch.filename}`}
        subtitle={`${batch.row_count} rows on sheet "${batch.sheet_name}" · ${plannedWith(batch.ai_model)}${committed ? ` · committed ${new Date(batch.committed_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`}
      />
      <div className="app-page">

      <SetStrip
        label="This batch"
        cells={committed ? [
          { label: 'Written new', figure: number(toCreate), foot: 'quotations, projects, POs and more' },
          { label: 'Updated from the sheet', figure: number(toReplace), foot: 'stage, value or dates changed' },
          { label: 'Kept as they were', figure: number(toKeep), foot: 'duplicates left alone' },
          { label: 'Left out', figure: number(skipped), foot: 'see why on Summary' },
        ] : [
          { label: 'New records', figure: number(toCreate), foot: 'ticked and ready to write' },
          { label: 'Already on the site', figure: number(totalDuplicates), foot: 'shown as Duplicate', tone: totalDuplicates ? 'wait' : undefined },
          { label: 'Left out', figure: number(skipped), foot: 'see why on Summary' },
          { label: 'Need fixing', figure: number(errors.length), foot: errors.length ? 'commit waits for these' : 'nothing in the way', tone: errors.length ? 'late' : undefined },
        ]}
      />

      {committed && <MoneyBanner tone="ok" className="alert" title="This batch has been committed.">{' '}Everything below is read-only; Written as shows what each row became.</MoneyBanner>}
      {batch.error && !committed && (
        <MoneyBanner tone="late" role="alert" title="This batch couldn’t be read." action={<Link to="/settings/import" className="mg-btn mg-btn--sm">Upload a corrected sheet</Link>}>{' '}{batch.error}</MoneyBanner>
      )}
      {commitError && (
        <MoneyBanner tone="late" role="alert" title="The commit failed, so nothing was written." action={!hasErrors && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setConfirm(true)}>Try the commit again</button>}>{' '}{commitError}</MoneyBanner>
      )}
      {batch.mapping?.ai_errors?.length > 0 && <MoneyBanner title="AI review partly unavailable.">{' '}{batch.mapping.ai_errors.join('; ')}. The rule-based checks still apply to every row.</MoneyBanner>}
      {!committed && skipped > 0 && current.key !== 'summary' && (
        <MoneyBanner action={<button type="button" className="mg-btn mg-btn--sm" onClick={() => setStep(STEPS.length - 1)}>See why</button>} title={`${skipped} of ${batch.row_count} rows were left out.`}>
          {' '}The Summary step says why, and lets you change how any deal stage in the sheet is read.
        </MoneyBanner>
      )}
      {totalDuplicates > 0 && !committed && current.key !== 'summary' && (
        <MoneyBanner tone="wait" title={`${totalDuplicates} record${totalDuplicates === 1 ? ' is' : 's are'} already on the site.`}>
          {' '}A deal recognised for certain whose stage, value or dates changed is updated from the sheet; any other keeps the original. Change either on its row. A choice on a PO carries to its stages, invoice and receipt. New remarks and follow-ups go to each deal’s timeline either way.
        </MoneyBanner>
      )}

      <div className="mg-tabs set-steps-tabs" role="tablist" aria-label="Steps" data-a="rise">
        {STEPS.map((s, i) => (
          <button key={s.key} type="button" role="tab" aria-selected={step === i} onClick={() => setStep(i)} title={dupCounts[s.key] ? `${dupCounts[s.key]} already on the site` : undefined}>
            <span>{`${i + 1}. ${s.label}`}</span>
            {counts[s.key] != null && <span className="mg-count">{counts[s.key]}</span>}
            {errorCounts[s.key] > 0 && !committed && <span className="mg-count is-late" aria-label={`${errorCounts[s.key]} to fix`}>{errorCounts[s.key]}</span>}
            {dupCounts[s.key] > 0 && !committed && <span className="set-tab-dup">{dupCounts[s.key]} on site</span>}
          </button>
        ))}
      </div>

      {current.key === 'summary' ? (
        <Summary batch={batch} items={items} errors={errors} effectiveIncluded={effectiveIncluded} hasErrors={hasErrors} committed={committed} onCommit={() => setConfirm(true)} onBack={() => setStep(0)} onReplan={replan} onShowErrors={showErrors} />
      ) : (
        <>
          <StepTable {...tableProps(current.key)} />
          {current.key === 'purchase_order' && <StepTable {...tableProps('service')} />}
          <nav className="flex flex-wrap justify-between gap-3" aria-label="Step" data-a="rise">
            <button type="button" className="mg-btn" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft className="size-4" aria-hidden="true" />Back</button>
            <button type="button" className="mg-btn mg-btn--primary" onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].label}<ArrowRight className="size-4" aria-hidden="true" /></button>
          </nav>
        </>
      )}

      {editing && (
        <EditItem
          item={editing}
          fields={FIELDS[editing.step]}
          onClose={() => setEditing(null)}
          onSave={async (payload) => { const err = await patch(editing, { payload }, true); if (!err) setEditing(null); return err; }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title="Commit this import?"
          subtitle={`Import #${batch.id} · ${batch.filename}`}
          message={`${toCreate} new record${toCreate === 1 ? '' : 's'} will be written${toReplace ? `, ${toReplace} existing record${toReplace === 1 ? '' : 's'} updated from the sheet` : ''}${toKeep ? `, ${toKeep} duplicate${toKeep === 1 ? '' : 's'} kept as ${toKeep === 1 ? 'it is' : 'they are'}` : ''}. It’s one transaction: if any part fails, nothing is written.`}
          tone="neutral"
          confirmLabel="Complete and commit"
          cancelLabel="Not yet"
          busy={busy}
          busyLabel={`Committing ${number(toCreate + toReplace)} records…`}
          onConfirm={commit}
          onClose={() => setConfirm(false)}
        />
      )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ table */

function Flags({ flags }) {
  if (!flags.length) return <span className="text-muted-foreground">—</span>;
  // A flag is a sentence: it wraps inside a bounded column.
  return (
    <span className="flex flex-wrap gap-1" style={{ minWidth: 200, maxWidth: 300 }}>
      {flags.map((f, i) => (
        <span key={i} className={cn('mg-badge set-flag', f.level === 'error' ? 'mg-badge--late' : f.level === 'warn' ? 'mg-badge--wait' : 'mg-badge--info')} title={f.by === 'ai' ? 'Raised by the AI reader' : 'Raised by the rules'}>
          {f.by === 'ai' ? '✦ ' : ''}{f.message}
        </span>
      ))}
    </span>
  );
}

function StepTable({ stepKey, items, bySeq, filters, setFilters, committed, onToggle, onDecide, onDecideAll, onEdit }) {
  const rows = items.filter((it) => {
    if (filters.flagged && !it.flags.some((f) => f.code !== 'duplicate')) return false;
    if (filters.action === 'create' && it.existing_ref) return false;
    if (filters.action === 'dup' && !it.existing_ref) return false;
    if (filters.action === 'errors' && !it.flags.some((f) => f.level === 'error')) return false;
    if (stepKey === 'quotation' && filters.status && it.payload.status !== filters.status) return false;
    return true;
  });
  const dups = items.filter((it) => it.existing_ref).length;
  const filtered = filters.status || filters.flagged || filters.action;

  const parentOf = (it) => (it.parent_seq ? bySeq.get(it.parent_seq) : null);
  const clientOf = (it) => it.source_client || it.payload.client_name || '';
  const dupFlag = (it) => it.flags.find((f) => f.code === 'duplicate');
  const title = stepKey === 'service' ? 'Service lines' : STEPS.find((s) => s.key === stepKey).label;

  const include = (it) => (
    <label className="mg-check" title={!it.parent_included ? 'Its parent is unticked' : 'Include in the commit'}>
      <input type="checkbox" checked={it.included} disabled={committed || !it.parent_included} aria-label={`Include S.No ${it.source_row} in the commit`} onChange={() => onToggle(it)} />
    </label>
  );
  const dupCell = (it) => {
    const f = dupFlag(it);
    if (!f) return <span className="text-muted-foreground">—</span>;
    return (
      <span className="flex flex-col items-start gap-0.5">
        <Tone tone="wait">{f.certain === false ? 'Possible duplicate' : 'Duplicate'}</Tone>
        <span className="set-sub">on site as <b className="text-foreground">{it.existing_ref}</b> · matched by {f.match}</span>
        {f.certain === false && <span className="set-sub font-semibold text-wait">Not certain: confirm it’s the same deal</span>}
      </span>
    );
  };
  const actionCell = (it) => {
    if (!it.existing_ref) return <Tone tone="info">New</Tone>;
    if (committed) {
      if (it.action === 'create') return <span className="text-secondary-text">imported as new</span>;
      return <span className="text-secondary-text">{it.action === 'update' ? 'updated from sheet' : 'kept original'}</span>;
    }
    // A project follows its quotation's choice.
    if (it.action === 'create' && it.step !== 'quotation') return <Tone tone="info">New, with its quotation</Tone>;
    const uncertain = it.step === 'quotation' && dupFlag(it)?.certain === false;
    return (
      <span className="mg-select-wrap block min-w-[170px]">
        <select className="mg-select" aria-label={`What to do with ${it.existing_ref}`} value={it.action} disabled={!it.parent_included} onChange={(e) => onDecide(it, e.target.value)}>
          {(uncertain ? [...DUP_CHOICES, NEW_CHOICE] : DUP_CHOICES).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </span>
    );
  };

  const base = [
    { key: 'inc', header: '', aria: 'Include', width: '44px', render: include },
    { key: 'source_row', header: 'S.No', num: true, width: '56px', render: (it) => <span className="text-muted-foreground">{it.source_row}</span> },
  ];
  const tail = [
    { key: 'dup', header: 'Duplicate', className: 'app-wrap--sm', render: dupCell },
    { key: 'flags', header: 'Flags', render: (it) => <Flags flags={it.flags.filter((f) => f.code !== 'duplicate')} /> },
    { key: 'assumptions', header: 'Assumed', className: 'app-say', render: (it) => (it.assumptions.length ? it.assumptions.join(' · ') : '') },
    { key: 'action', header: 'Action', width: '180px', render: actionCell },
    committed
      ? { key: 'committed_ref', header: 'Written as', className: 'app-say', render: (it) => it.committed_ref }
      : { key: 'edit', header: '', className: 'actions', render: (it) => <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit S.No ${it.source_row}`} onClick={() => onEdit(it)}>Edit</button> },
  ];

  const middle = {
    quotation: [
      { key: 'no', header: 'Quotation', render: (it) => <><b className="whitespace-nowrap">{it.payload.quotation_no}</b><span className="set-sub whitespace-nowrap">{date(it.payload.quotation_date)}</span></> },
      { key: 'client', header: 'Client and service', className: 'app-wrap', render: (it) => <><b>{it.payload.client_name}</b><span className="set-sub">{[it.payload.contact_person, it.payload.service_quoted].filter(Boolean).join(' · ')}</span></> },
      { key: 'value', header: 'Value', num: true, render: (it) => <b className="whitespace-nowrap">{money(it.payload.quotation_value, it.payload.currency)}</b> },
      { key: 'status', header: 'Status', render: (it) => <Tone tone={STATUS_TONE[it.payload.status] || 'plain'}>{it.payload.status}</Tone> },
    ],
    project: [
      { key: 'pid', header: 'Project ID', render: (it) => <b>{it.payload.project_id}</b> },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'service', header: 'Primary service', className: 'app-wrap--sm', render: (it) => it.payload.primary_service },
      { key: 'from', header: 'From quotation', render: (it) => <span className="text-secondary-text">{parentOf(it)?.payload.quotation_no}</span> },
      { key: 'chk', header: 'Checklist', render: (it) => (it.payload.apply_onboarding_template ? '11 steps' : 'None') },
    ],
    purchase_order: [
      { key: 'po', header: 'PO number', render: (it) => <b>{it.payload.po_number}</b> },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'pid', header: 'Project', render: (it) => <span className="text-secondary-text">{it.payload.project_id}</span> },
      { key: 'date', header: 'PO date', num: true, render: (it) => <span className="whitespace-nowrap">{date(it.payload.po_date)}</span> },
      { key: 'value', header: 'Value', num: true, render: (it) => <b className="whitespace-nowrap">{money(it.payload.po_value, it.payload.currency)}</b> },
      { key: 'terms', header: 'Terms', num: true, render: (it) => `${it.payload.payment_terms_days} days` },
      { key: 'deliv', header: 'Delivery', render: (it) => <span className="whitespace-nowrap">{date(it.payload.actual_delivery_date)}</span> },
    ],
    service: [
      { key: 'po', header: 'PO number', render: (it) => <b>{it.payload.po_number}</b> },
      { key: 'service', header: 'Service line', className: 'app-wrap', render: (it) => it.payload.service },
      { key: 'value', header: 'Value', num: true, render: (it) => money(it.payload.service_value) },
    ],
    stage: [
      { key: 'po', header: 'PO number', render: (it) => <b>{it.payload.po_number}</b> },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'n', header: '#', num: true, render: (it) => it.payload.stage_no },
      { key: 'name', header: 'Stage', render: (it) => it.payload.stage_name },
      { key: 'trig', header: 'Trigger', render: (it) => it.payload.trigger_event },
      { key: 'pct', header: '%', num: true, render: (it) => `${Math.round(it.payload.stage_percent * 100)}%` },
      { key: 'amt', header: 'Amount', num: true, render: (it) => { const po = parentOf(it); return po ? money(po.payload.po_value * it.payload.stage_percent, po.payload.currency) : '—'; } },
    ],
    money: [
      { key: 'kind', header: 'Type', render: (it) => <Tone tone={it.step === 'invoice' ? 'info' : 'ok'}>{it.step === 'invoice' ? 'Invoice' : 'Receipt'}</Tone> },
      { key: 'po', header: 'PO number', render: (it) => <b>{it.payload.po_number}</b> },
      { key: 'client', header: 'Client', render: clientOf },
      { key: 'stage', header: 'Stage', render: (it) => parentOf(it)?.payload.stage_name || `stage ${it.payload.stage_no}` },
      { key: 'detail', header: 'Detail', render: (it) => (it.step === 'invoice' ? it.payload.invoice_no : money(it.payload.amount_received)) },
      { key: 'date', header: 'Date', num: true, render: (it) => <span className="whitespace-nowrap">{date(it.step === 'invoice' ? it.payload.invoice_date : it.payload.payment_received_date)}</span> },
    ],
  }[stepKey];

  /** The phone row: what it is, its figure, the duplicate badge, and the controls. */
  const phone = (it) => {
    const p = it.payload;
    const f = dupFlag(it);
    const [t, amount, meta] = {
      quotation: [p.client_name, money(p.quotation_value, p.currency), [p.quotation_no, p.service_quoted, p.status].filter(Boolean).join(' · ')],
      project: [clientOf(it), '', [p.project_id, p.primary_service].filter(Boolean).join(' · ')],
      purchase_order: [p.po_number, money(p.po_value, p.currency), [clientOf(it), date(p.po_date)].filter(Boolean).join(' · ')],
      service: [p.service, money(p.service_value), p.po_number],
      stage: [`${p.po_number} · ${p.stage_name}`, `${Math.round(p.stage_percent * 100)}%`, [clientOf(it), p.trigger_event].filter(Boolean).join(' · ')],
      money: [`${it.step === 'invoice' ? 'Invoice' : 'Receipt'} · ${p.po_number}`, it.step === 'invoice' ? '' : money(p.amount_received), [clientOf(it), it.step === 'invoice' ? p.invoice_no : '', date(it.step === 'invoice' ? p.invoice_date : p.payment_received_date)].filter(Boolean).join(' · ')],
    }[stepKey] || [clientOf(it), '', ''];
    const errs = it.flags.filter((x) => x.code !== 'duplicate');
    return (
      <PhoneRow
        title={t || `S.No ${it.source_row}`}
        amount={amount}
        meta={[`S.No ${it.source_row}`, meta, f && `on site as ${it.existing_ref}`, !it.included && 'not ticked'].filter(Boolean).join(' · ')}
        state={f ? <Tone tone="wait">{f.certain === false ? 'Possible duplicate' : 'Duplicate'}</Tone> : <Tone tone="info">New</Tone>}
        className={it.existing_ref ? 'tr--dup' : undefined}
        wraps
      >
        {f?.certain === false && <span className="mg-row__meta font-semibold text-wait" style={{ gridColumn: '1 / -1' }}>Not certain: confirm it’s the same deal</span>}
        {errs.length > 0 && <span style={{ gridColumn: '1 / -1' }}><Flags flags={errs} /></span>}
        <span className="set-rowacts items-center">
          <label className="mg-check text-[13px]">
            <input type="checkbox" checked={it.included} disabled={committed || !it.parent_included} aria-label={`Include S.No ${it.source_row} in the commit`} onChange={() => onToggle(it)} />
            Include
          </label>
          {it.existing_ref && !committed && !(it.action === 'create' && it.step !== 'quotation') ? actionCell(it) : committed && it.committed_ref ? <span className="text-[12.5px] text-secondary-text">Written as {it.committed_ref}</span> : null}
          {!committed && <button type="button" className="mg-btn mg-btn--sm" aria-label={`Edit S.No ${it.source_row}`} onClick={() => onEdit(it)}>Edit</button>}
        </span>
      </PhoneRow>
    );
  };

  const possible = items.filter((it) => it.existing_ref && dupFlag(it)?.certain === false).length;
  return (
    <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby={`ir-${stepKey}`}>
      <div className="app-panel__head">
        <div className="app-panel__titles"><h2 className="mg-panel__title" id={`ir-${stepKey}`}>{title}</h2><span className="mg-panel__hint">{hint(stepKey)}</span></div>
        {stepKey !== 'service' && (
          <div className="mg-filterbar set-tools" role="group" aria-label="Filters for this step">
            {stepKey === 'quotation' && (
              <span className="mg-select-wrap">
                <select className="mg-select" aria-label="Status in the sheet" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                  <option value="">Any status</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </span>
            )}
            <span className="mg-select-wrap">
              <select className="mg-select" aria-label="Show" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>
                <option value="">Show all</option><option value="create">New only</option><option value="dup">Duplicates only</option><option value="errors">Errors only</option>
              </select>
            </span>
            <label className="mg-check text-[13px]"><input type="checkbox" checked={filters.flagged} onChange={(e) => setFilters({ ...filters, flagged: e.target.checked })} />Flagged only</label>
            <span className="text-[12.5px] text-muted-foreground tabular-nums">{rows.length} of {items.length}{dups ? ` · ${dups} duplicate${dups === 1 ? '' : 's'}` : ''}</span>
            {dups > 0 && !committed && (
              <>
                <button type="button" className="mg-btn mg-btn--sm" title="Every duplicate in this step keeps the site’s record" onClick={() => onDecideAll('skip')}>Keep all originals</button>
                <button type="button" className="mg-btn mg-btn--sm" title="Every duplicate in this step takes the sheet’s values" onClick={() => onDecideAll('update')}>Update all from sheet</button>
              </>
            )}
          </div>
        )}
        {possible > 0 && (
          <MoneyBanner tone="wait" className="basis-full" title={`${possible} possible duplicate${possible === 1 ? ' was' : 's were'} matched only by client name and service.`}>
            {' '}(And the proposal date, when the sheet has one.) This is how Lost, Under Negotiation and On Hold deals are matched, because they have no PO number; a quotation number in the sheet makes the match exact. A client can have two proposals for the same service, so check each one: if it’s a different deal, choose Import as new and it’s added with the next quotation number.
          </MoneyBanner>
        )}
      </div>
      {rows.length === 0 ? (
        <StateCard inPanel tone="plain" title="Nothing in this step" text={items.length ? 'Nothing matches the filters.' : 'The sheet produced no records of this kind.'}>
          {items.length > 0 && filtered && <button type="button" className="mg-btn mg-btn--sm" onClick={() => setFilters({ status: '', flagged: false, action: '' })}>Clear filters</button>}
        </StateCard>
      ) : (
        <ListTable
          label={title}
          rows={rows}
          // A column nothing in this step fills only widens the table.
          columns={[...base, ...middle, ...tail].filter((c) => c.key !== 'assumptions' || items.some((it) => it.assumptions.length))}
          rowClassName={(it) => (it.existing_ref ? 'tr--dup' : '')}
          phone={phone}
          phoneBelow={1180}
        />
      )}
    </section>
  );
}

function hint(stepKey) {
  return {
    quotation: 'One per sheet row. Duplicates are already on the site, matched by PO number or quotation number; possible duplicates by client, service and date. Keeping the original only fills its blank fields.',
    project: 'One per won deal with a PO. Registered from its quotation, with the next free project ID. A duplicate here means the quotation or PO already has a project.',
    purchase_order: 'The PO for each won deal. Dates marked assumed follow the agreed rules. A duplicate means the PO number is already on the site; your choice carries to its stages, invoice and receipt.',
    service: 'One line per PO saying what it covers, at the PO value.',
    stage: 'The payment split per PO: read from the remarks where stated, 50/50 otherwise, 100% on delivery where the terms say so. A duplicate means that stage number already exists on the PO.',
    money: 'Invoices and receipts the sheet shows, recorded on the advance stage. A duplicate means the stage already carries an invoice or a receipt.',
  }[stepKey];
}

/* ------------------------------------------------------------ summary */

function ListCard({ id, title, hint: h, items, empty = 'None' }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  return (
    <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-labelledby={id} style={{ gap: 10 }}>
      <div className="flex flex-col gap-0.5"><h2 className="mg-panel__title" id={id}>{title}</h2>{h && <span className="mg-panel__hint">{h}</span>}</div>
      {items.length === 0 ? <p className="m-0 text-[13px] text-muted-foreground">{empty}</p> : (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((it, i) => <li key={i} className="set-kv text-[13px]">{it.k && <b className="whitespace-nowrap">{it.k}</b>}<span className="min-w-0 flex-[1_1_200px] text-secondary-text">{it.v}</span></li>)}
        </ul>
      )}
      {items.length > 6 && <div><button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${items.length}`}</button></div>}
    </section>
  );
}

function Summary({ batch, items, errors, effectiveIncluded, hasErrors, committed, onCommit, onBack, onReplan, onShowErrors }) {
  const steps = STEPS.filter((s) => s.key !== 'summary' && s.key !== 'money').map((s) => s.key).concat(['service', 'invoice', 'receipt']);
  const count = (key, pred) => items.filter((it) => it.step === key && pred(it)).length;
  const assumptions = items.filter(effectiveIncluded).flatMap((it) => it.assumptions.map((a) => ({ k: `S.No ${it.source_row}`, v: a })));
  const skipped = batch.summary?.skipped_rows || [];
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
  const historyItems = [
    history.notes > 0 && { v: `${history.notes} note${history.notes === 1 ? '' : 's'} on ${history.deals} deal timeline${history.deals === 1 ? '' : 's'} (remarks and follow-up comments)` },
    history.reminders > 0 && { v: `${history.reminders} follow-up reminder${history.reminders === 1 ? '' : 's'} for the salespeople, from the next follow-up dates` },
    history.contacts > 0 && { v: `${history.contacts} deal${history.contacts === 1 ? '' : 's'} with a newer last-contact date, from the last follow-up dates` },
    history.closed > 0 && { v: `${history.closed} reminder${history.closed === 1 ? '' : 's'} closed because the deal was lost` },
  ].filter(Boolean);
  const rows = steps.map((k) => ({ id: k, k }));
  const cnt = (r, pred) => count(r.k, pred);

  return (
    <>
      {hasErrors && !committed && (
        <MoneyBanner tone="late" role="alert" title={`Commit is off until ${errors.length === 1 ? 'this row is' : `these ${errors.length} rows are`} fixed with Edit, or unticked.`}
          action={<button type="button" className="mg-btn mg-btn--sm" onClick={onShowErrors}>Show {errors.length === 1 ? 'it' : 'them'}</button>}>
          <ul className="mt-1.5 mb-0 list-disc pl-5">
            {errors.slice(0, 5).map((it) => (
              <li key={it.id}>S.No {it.source_row}, {NOUN[it.step]}{it.payload.client_name ? ` for ${it.payload.client_name}` : ''}: {it.flags.filter((f) => f.level === 'error').map((f) => f.message).join('; ')}</li>
            ))}
            {errors.length > 5 && <li>and {errors.length - 5} more</li>}
          </ul>
        </MoneyBanner>
      )}
      <div className="set-two">
        <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="ir-ww">
          <div className="app-panel__head"><div className="app-panel__titles"><h2 className="mg-panel__title" id="ir-ww">{committed ? 'What was written' : 'What will be written'}</h2><span className="mg-panel__hint">{committed ? 'Counts as they were committed.' : 'Only ticked items whose parents are ticked too. Duplicates keep the original unless set to update from the sheet.'}</span></div></div>
          <ListTable
            label="What will be written"
            rows={rows}
            columns={[
              { key: 'record', header: 'Record', render: (r) => <b>{label[r.k]}</b> },
              { key: 'new', header: 'New', num: true, render: (r) => <b>{cnt(r, (it) => effectiveIncluded(it) && it.action === 'create')}</b> },
              { key: 'keep', header: 'Keep original', num: true, render: (r) => cnt(r, (it) => effectiveIncluded(it) && it.action === 'skip') },
              { key: 'update', header: 'Update from sheet', num: true, render: (r) => cnt(r, (it) => effectiveIncluded(it) && it.action === 'update') },
              { key: 'off', header: 'Unticked', num: true, render: (r) => <span className="text-muted-foreground">{cnt(r, (it) => !effectiveIncluded(it))}</span> },
            ]}
            phone={(r) => <PhoneRow title={label[r.k]} amount={`${cnt(r, (it) => effectiveIncluded(it) && it.action === 'create')} new`} meta={`${cnt(r, (it) => effectiveIncluded(it) && it.action === 'skip')} kept · ${cnt(r, (it) => effectiveIncluded(it) && it.action === 'update')} updated · ${cnt(r, (it) => !effectiveIncluded(it))} unticked`} />}
          />
        </section>
        <SheetReading
          key={JSON.stringify([batch.sheet_name, batch.rules?.stage_map, batch.rules?.won_requires_po, batch.rules?.exclude_iso, batch.rules?.update_from_sheet, batch.summary?.stage_values])}
          batch={batch}
          committed={committed}
          onReplan={onReplan}
        />
      </div>

      <div className="set-two">
        {replacing.length > 0 && (
          <ListCard id="ir-up" title={`Existing records updated from the sheet · ${replacing.length}`} hint="The sheet’s values replace the tracker’s; fields it leaves blank aren’t touched. Remarks written in the tracker stay on the deal’s timeline."
            items={replacing.map((it) => { const changed = it.flags.find((f) => f.code === 'sheet_changes'); return { k: it.existing_ref, v: `S.No ${it.source_row}, ${stepLabel[it.step]}${changed ? `: ${changed.message.replace(/^Updated from the sheet: /, '')}` : ''}` }; })} />
        )}
        {historyItems.length > 0 && (
          <ListCard id="ir-hi" title={committed ? 'What the sheet added' : 'Added to the deals’ history'} hint="From the remarks and follow-up columns. Text already on a deal isn’t added again." items={historyItems} />
        )}
        <ListCard id="ir-lo" title={`Rows left out · ${skipped.length}`} hint="Not written. Change a stage reading or a rule above to bring any of them in."
          items={skipped.map((s) => ({ k: s.ref ? String(s.ref) : `S.No ${s.sno}`, v: [s.client || '(no client)', s.stage && `“${s.stage}”`, s.reason].filter(Boolean).join(' · ') }))} />
        <ListCard id="ir-am" title={`Assumptions · ${assumptions.length}`} hint="Every assumed value is also written into the record’s remarks." items={assumptions} />
      </div>

      {!committed && (
        <div className="flex flex-wrap items-center justify-end gap-3" data-a="rise">
          {hasErrors && <span className="text-[13px] font-semibold text-late">Fix or untick the {errors.length === 1 ? 'row' : `${errors.length} rows`} with an error to commit</span>}
          <button type="button" className="mg-btn" onClick={onBack}>Back to review</button>
          <button type="button" className="mg-btn mg-btn--primary" disabled={hasErrors} onClick={onCommit}>Complete and commit</button>
        </div>
      )}
    </>
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
 * read it differently — plus the agreed rules that leave rows out, as
 * switches. "Apply and read again" re-plans the same upload with the choices.
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
  const readAs = (v) => (committed ? readingLabel(v) : (
    <span className="mg-select-wrap block min-w-[200px]">
      <select className="mg-select" aria-label={`Read "${v.value}" as`} value={choice[v.key] || ''} onChange={(e) => setChoice((s) => ({ ...s, [v.key]: e.target.value }))}>
        <option value="">Not understood: choose</option>
        {STAGE_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    </span>
  ));

  return (
    <section className="mg-glass mg-glass--strong app-panel" data-a="rise" aria-labelledby="ir-read">
      <div className="app-panel__head">
        <div className="app-panel__titles"><h2 className="mg-panel__title" id="ir-read">How the sheet’s deal stages were read · {values.length}</h2><span className="mg-panel__hint">{committed ? 'How the sheet was read when it was committed.' : 'Every wording in the deal-stage column. Change any reading and read the sheet again; nothing is written until you commit.'}</span></div>
        {unread > 0 && !committed && <MoneyBanner tone="wait" className="basis-full" title={`${unread} wording${unread === 1 ? ' was' : 's were'} not understood.`}>{' '}Choose a reading for {unread === 1 ? 'it' : 'each'}, or its rows stay out.</MoneyBanner>}
        {byAi > 0 && !committed && <MoneyBanner className="basis-full" title={`${byAi} wording${byAi === 1 ? ' was' : 's were'} read by the AI (marked ✦).`}>{' '}The rules were unsure of {byAi === 1 ? 'it' : 'them'}. Check {byAi === 1 ? 'it' : 'them'} before you commit.</MoneyBanner>}
        {dropped.length > 0 && <MoneyBanner className="basis-full" title="Left out of the upload entirely, because they hold sign-in details:">{' '}{dropped.join(', ')}. They weren’t stored or sent anywhere.</MoneyBanner>}
        {sheets.length > 1 && (
          <label className="mg-field basis-full">
            <span className="mg-field__label">Read from the tab</span>
            <span className="mg-select-wrap max-w-[320px]">
              <select className="mg-select" value={sheet} disabled={committed} onChange={(e) => setSheet(e.target.value)}>
                {sheets.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </span>
            <span className="mg-field__hint">The tab whose headers look most like a sales sheet was chosen.</span>
          </label>
        )}
      </div>
      <ListTable
        label="Deal stage readings"
        rows={values.map((v) => ({ ...v, id: v.key }))}
        columns={[
          { key: 'value', header: 'In the sheet', className: 'app-wrap--sm', render: (v) => <><b>“{v.value}”</b>{v.by === 'admin' && <span className="set-sub">Your reading</span>}{v.by === 'ai' && <span className="set-sub">✦ Read by the AI</span>}</> },
          { key: 'rows', header: 'Rows', num: true, render: (v) => v.rows },
          { key: 'reading', header: 'Read as', render: readAs },
        ]}
        phone={(v) => (
          <PhoneRow title={`“${v.value}”`} amount={`${v.rows} rows`} meta={v.by === 'ai' ? '✦ Read by the AI' : v.by === 'admin' ? 'Your reading' : null} wraps>
            <span className="set-rowacts">{readAs(v)}</span>
          </PhoneRow>
        )}
      />
      <div className="flex flex-col gap-3 border-t border-line px-[22px] py-4">
        {[
          ['rule-won-po', wonNeedsPo, setWonNeedsPo, 'A won deal needs a PO number to be imported (the rule agreed with the sales lead)'],
          ['rule-iso', excludeIso, setExcludeIso, 'Leave out ISO proposals'],
          ['rule-update', updateFromSheet, setUpdateFromSheet, 'Deals already in the tracker take what changed in the sheet (stage, value, dates), when they’re recognised for certain. A won deal is never moved back.'],
        ].map(([id, on, set, text]) => (
          <label key={id} className="mg-switch items-start text-[13px]/[1.5] text-secondary-text">
            <input id={id} type="checkbox" role="switch" checked={on} disabled={committed} onChange={(e) => set(e.target.checked)} className="flex-none" />
            <span>{text}</span>
          </label>
        ))}
        {!committed && (
          <div className="flex justify-end">
            <button type="button" className="mg-btn mg-btn--primary" disabled={busy || (!changed.length && !rulesChanged && !sheetChanged)} onClick={apply}>
              {busy ? 'Reading again…' : `Apply and read again${changed.length ? ` (${changed.length} change${changed.length === 1 ? '' : 's'})` : ''}`}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ edit */

/** Edit one row, with that step's own fields; a refused save keeps the dialog open with the reason. */
function EditItem({ item, fields, onClose, onSave }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, item.payload[f.name] ?? ''])));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const set = (name, v) => setValues((s) => ({ ...s, [name]: v }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    const payload = {};
    for (const f of fields) {
      let v = values[f.name];
      if (v === '') v = null;
      else if (f.type === 'number') v = Number(v);
      else if (f.type === 'select' && (v === 'true' || v === 'false')) v = v === 'true';
      payload[f.name] = v;
    }
    const err = await onSave(payload);
    if (err) setFailure(err);
    setBusy(false);
  }

  const who = item.payload.client_name || item.source_client;
  return (
    <Modal
      title={`Edit ${NOUN[item.step] || item.step.replace('_', ' ')}`}
      subtitle={[`S.No ${item.source_row}`, who, item.existing_ref && `duplicate of ${item.existing_ref}`, item.assumptions.length && `assumed: ${item.assumptions.join('; ')}`].filter(Boolean).join(' · ')}
      onClose={onClose}
      footer={<><button type="button" className="mg-btn mg-btn--ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="edit-item" className="mg-btn mg-btn--primary" disabled={busy}>{busy ? 'Saving…' : failure ? 'Try again' : 'Save'}</button></>}
    >
      <form id="edit-item" onSubmit={submit} className="form-grid">
        {failure && <div className="span-all"><DialogError error={`${failure} Your other changes are kept.`} what="this row" /></div>}
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
