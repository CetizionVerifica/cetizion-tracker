import { useState } from 'react';
import { AlignLeft, ChevronLeft, ChevronRight, IndianRupee, ListChecks } from 'lucide-react';
import { cn } from 'cn';
import { Alert, ConfirmDialog, DataTable, Empty, useToast } from '../components/ui.jsx';
import { Chip, RecordSection } from '../components/record.jsx';
import { Button } from '../components/ui/button';
import { Textarea } from '../components/ui/textarea';
import { RecordForm } from '../components/RecordForm.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useList } from '../lib/hooks.js';

/**
 * Admin › Templates (#26), on C12's shape.
 *
 * The design's win here is that the kinds of template stop being one
 * undifferentiated screen: you pick the thing you came to change, then
 * change it. The editors underneath are the ones that were already here
 * and are deliberately not rewritten — nothing was wrong with them except
 * that both were open at once.
 *
 * C12 lists five rows: Quotation PDF, Quotation cover email, Overdue
 * reminder, Default terms and Onboarding checklist. Three of those are
 * not templates in this codebase and are not drawn. The quotation PDF is
 * laid out in `lib/quotationPdf.js`, and the cover email and the overdue
 * reminder are strings built in the route that sends them — editing any
 * of them means building a template system first, not adding a row here.
 * What is real is listed: the two template tables, and the default terms
 * setting that is printed on every quotation.
 */

const ROW = 'flex h-11 w-full items-center gap-3 px-4 text-left transition-colors hover:bg-secondary';
const ROW_BUTTON = 'h-7 px-3 text-[12.5px]';

const PAYMENT = {
  key: 'payment',
  icon: IndianRupee,
  label: 'Payment schedules',
  meta: 'offered when a PO is registered',
  title: 'Payment schedules',
  hint: 'Each line is a payment stage. Percentages must add up to 100. Credit days blank: the PO’s payment terms apply.',
  resource: 'payment-terms-templates',
  lineResource: 'payment-terms-template-lines',
  lineColumns: [
    { key: 'sort_order', header: '#', width: 40 },
    { key: 'stage_name', header: 'Stage', className: 'strong' },
    { key: 'percent', header: '%', align: 'right', render: (l) => `${Number(l.percent)}%` },
    { key: 'trigger_event', header: 'Trigger' },
    { key: 'credit_days', header: 'Credit days', align: 'right', render: (l) => l.credit_days ?? <span className="muted">PO terms</span> },
    { key: 'milestone_name', header: 'Milestone', render: (l) => l.milestone_name || <span className="muted">—</span> },
  ],
  lineFields: (templateId) => [
    { name: 'template_id', type: 'hidden', default: templateId },
    { name: 'sort_order', label: 'Order', type: 'number', default: 1 },
    { name: 'stage_name', label: 'Stage name', required: true },
    { name: 'percent', label: 'Percent', type: 'number', required: true, step: '0.5' },
    { name: 'trigger_event', label: 'Trigger', type: 'select', options: ['On PO Registration', 'On Delivery', 'On Milestone', 'Manual'], default: 'On PO Registration', required: true },
    { name: 'credit_days', label: 'Credit days', type: 'number', hint: 'Blank: the PO payment terms' },
    { name: 'milestone_name', label: 'Milestone', hint: 'For On Milestone stages: what has to happen' },
  ],
  lineCheck: (lines) => {
    const total = lines.reduce((n, l) => n + Number(l.percent), 0);
    return Math.abs(total - 100) > 0.01 ? `Adds up to ${total}%, not 100%` : null;
  },
};

const ONBOARDING = {
  key: 'onboarding',
  icon: ListChecks,
  label: 'Onboarding checklists',
  meta: 'the steps a new project starts with',
  title: 'Onboarding checklists',
  hint: 'Each line is a step on the project’s checklist. Days after start set the step’s target date.',
  resource: 'onboarding-templates',
  lineResource: 'onboarding-template-lines',
  lineColumns: [
    { key: 'step_no', header: '#', width: 40 },
    { key: 'stage', header: 'Stage' },
    { key: 'step', header: 'Step', className: 'wrap strong' },
    { key: 'owner_role', header: 'Owner' },
    { key: 'days_after_start', header: 'Days after start', align: 'right' },
  ],
  lineFields: (templateId) => [
    { name: 'template_id', type: 'hidden', default: templateId },
    { name: 'step_no', label: 'Step number', type: 'number', required: true, default: 1 },
    { name: 'stage', label: 'Stage', type: 'select', options: ['Onboarding', 'Execution', 'Delivery', 'Closure'] },
    { name: 'step', label: 'Step', required: true, span: 2 },
    { name: 'owner_role', label: 'Owner role', type: 'select', options: ['Sales', 'Finance', 'Delivery', 'HR', 'Admin'] },
    { name: 'days_after_start', label: 'Days after start', type: 'number' },
  ],
};

const TERMS = {
  key: 'terms',
  icon: AlignLeft,
  label: 'Default terms',
  meta: 'printed on every quotation',
};

const KINDS = [PAYMENT, ONBOARDING, TERMS];

/** One kind of template, as a row you open. */
function KindRow({ kind, count, last, onOpen }) {
  const Icon = kind.icon;
  return (
    <button type="button" className={cn(ROW, !last && 'border-b border-border')} onClick={onOpen}>
      <Icon className="size-4 shrink-0 text-secondary-text" strokeWidth={1.75} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{kind.label}</span>
      <span className="hidden truncate text-[12px] text-muted-foreground sm:block">
        {count === undefined ? kind.meta : `${count} template${count === 1 ? '' : 's'} · ${kind.meta}`}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export default function Templates() {
  const [open, setOpen] = useState(null);
  const payment = useList('payment-terms-templates', { limit: 200 });
  const onboarding = useList('onboarding-templates', { limit: 200 });
  // useList exposes `rows`/`total`; `data` is the raw envelope.
  const counts = { payment: payment.total, onboarding: onboarding.total };

  return (
    <>
      <SettingsPane
        title={open ? open.label : 'Templates'}
        description={open
          ? open.meta
          : 'The payment splits and onboarding steps a new order starts from, and the terms printed on every quotation. Pick the one you came to change.'}
        actions={open && (
          <Button variant="secondary" size="sm" className="h-8 px-4 text-[13px]" onClick={() => setOpen(null)}>
            <ChevronLeft className="size-3.5" strokeWidth={2} aria-hidden="true" />All templates
          </Button>
        )}
      >
        {open ? (
          open.key === 'terms' ? <DefaultTerms /> : <TemplateSet {...open} />
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {KINDS.map((kind, i) => (
                <KindRow key={kind.key} kind={kind} count={counts[kind.key]} last={i === KINDS.length - 1} onOpen={() => setOpen(kind)} />
              ))}
            </div>

            <p className="max-w-[70ch] text-[11.5px]/[1.6] text-muted-foreground">
              The quotation PDF is laid out in code, and the cover email and overdue reminder are built by the routes
              that send them — none of the three is editable here yet.
            </p>
          </>
        )}
      </SettingsPane>
    </>
  );
}

/** The terms printed on every quotation, which live in settings. */
function DefaultTerms() {
  const toast = useToast();
  const { data, loading, refetch } = useFetch(() => api.raw('/lookups'));
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  const stored = data?.data?.settings?.quotation_terms_default ?? '';
  const value = draft ?? stored;

  async function save() {
    setBusy(true);
    try {
      await api.update('settings', 'quotation_terms_default', { value });
      toast('Terms saved', 'success');
      invalidateLookups();
      setDraft(null);
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="skeleton h-[180px]" />;

  return (
    <RecordSection title="Default terms" hint="printed on every quotation that does not set its own">
      <div className="flex flex-col gap-3 p-5">
        <Textarea rows={6} className="text-[13px]/[1.6]" value={value} onChange={(e) => setDraft(e.target.value)} aria-label="Default quotation terms" />
        <div className="flex items-center gap-3">
          <Button size="sm" className="h-8 px-4 text-[13px]" disabled={busy || draft === null || draft === stored} onClick={save}>
            {busy ? 'Saving…' : 'Save terms'}
          </Button>
          <span className="text-[12px] text-muted-foreground">
            A quotation that already has its own terms keeps them; this is what a new one starts with.
          </span>
        </div>
      </div>
    </RecordSection>
  );
}

function TemplateSet({ title, hint, resource, lineResource, lineColumns, lineFields, lineCheck }) {
  const toast = useToast();
  const [open, setOpen] = useState(null);
  const [editing, setEditing] = useState(null);       // template record | 'new'
  const [line, setLine] = useState(null);             // { templateId, record | null }
  const [removing, setRemoving] = useState(null);     // { kind: 'template' | 'line', record }
  const [busy, setBusy] = useState(false);
  const templates = useFetch(() => api.list(resource, { limit: 200 }), []);
  const lines = useFetch(() => api.list(lineResource, { limit: 1000 }), []);
  const rows = templates.data?.data ?? [];
  const linesOf = (t) => (lines.data?.data ?? []).filter((l) => l.template_id === t.id);
  const refresh = () => { templates.refetch(); lines.refetch(); invalidateLookups(); };

  async function remove() {
    setBusy(true);
    try {
      await api.remove(removing.kind === 'template' ? resource : lineResource, removing.record.id);
      toast('Removed', 'success'); setRemoving(null); refresh();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const headerFields = [
    { name: 'name', label: 'Name', required: true, span: 2 },
    { name: 'is_default', label: 'Default', type: 'boolean', default: 'false', hint: 'Offered first when a PO is registered' },
    { name: 'active', label: 'Active', type: 'boolean', default: 'true' },
    { name: 'sort_order', label: 'Order', type: 'number', default: 0 },
  ];

  return (
    <>
      <RecordSection
        title={title}
        hint={hint}
        action={<Button size="sm" className={ROW_BUTTON} onClick={() => setEditing('new')}>Add template</Button>}
      >
        {templates.loading && !templates.data ? <div className="skeleton" style={{ height: 120, margin: 16 }} />
          : rows.length === 0 ? (
            <Empty
              title="No templates yet"
              text="A template is a named set of lines reused every time — the payment split on a new order, or the checklist on a new project. Add one and it is offered wherever it applies."
              action={<Button size="sm" className={ROW_BUTTON} onClick={() => setEditing('new')}>Add template</Button>}
            />
          ) : rows.map((t, i) => {
          const tl = linesOf(t);
          const problem = lineCheck ? lineCheck(tl) : null;
          const isOpen = open === t.id;
          return (
            <div key={t.id} className={cn(i < rows.length - 1 && 'border-b border-border')}>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-foreground">
                    {t.name}
                    {t.is_default && <Chip tone="info">default</Chip>}
                    {!t.active && <Chip>inactive</Chip>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">
                    {tl.length} line{tl.length === 1 ? '' : 's'}
                    {problem && <> · <span className="text-late">{problem}</span></>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" size="sm" className={ROW_BUTTON} onClick={() => setLine({ templateId: t.id, record: null })}>Add line</Button>
                  <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setEditing(t)}>Edit</Button>
                  <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setOpen(isOpen ? null : t.id)}>{isOpen ? 'Hide lines' : 'Show lines'}</Button>
                  <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`Delete ${t.name}`} onClick={() => setRemoving({ kind: 'template', record: t })}>✕</Button>
                </div>
              </div>
              {isOpen && (
                <DataTable
                  rows={tl}
                  columns={[...lineColumns, {
                    key: 'act', header: '', align: 'right', render: (l) => (
                      <div className="table__actions">
                        <Button variant="ghost" size="sm" className={ROW_BUTTON} onClick={() => setLine({ templateId: t.id, record: l })}>Edit</Button>
                        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Delete line" onClick={() => setRemoving({ kind: 'line', record: l })}>✕</Button>
                      </div>
                    ),
                  }]}
                  empty={<Empty title="No lines yet" action={<Button size="sm" className={ROW_BUTTON} onClick={() => setLine({ templateId: t.id, record: null })}>Add line</Button>} />}
                />
              )}
            </div>
          );
        })}
      </RecordSection>

      {lineCheck && rows.some((t) => lineCheck(linesOf(t))) && (
        <Alert tone="warning"><span>A template whose lines do not add up to 100% cannot be used to register a PO.</span></Alert>
      )}

      {editing && <RecordForm title={editing === 'new' ? `New ${title.toLowerCase().replace(/s$/, '')} template` : 'Edit template'} resource={resource} fields={headerFields} record={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {line && <RecordForm title={line.record ? 'Edit line' : 'Add line'} resource={lineResource} fields={lineFields(line.templateId)} record={line.record} onClose={() => setLine(null)} onSaved={refresh} />}
      {removing && <ConfirmDialog title={removing.kind === 'template' ? `Delete "${removing.record.name}"?` : 'Delete this line?'} message={removing.kind === 'template' ? 'Its lines go with it. POs already registered from it are not affected.' : 'The template changes for future POs only.'} onConfirm={remove} onClose={() => setRemoving(null)} busy={busy} />}
    </>
  );
}
