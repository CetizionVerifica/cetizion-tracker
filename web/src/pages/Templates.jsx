import { useState } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AlignLeft, ChevronLeft, ChevronRight, ClipboardList, IndianRupee, ListChecks, Plus } from 'lucide-react';
import { cn } from 'cn';
import { ConfirmDialog, useToast } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { FailedCard, ListTable, LoadingPanel, PhoneRow, StateCard } from '../components/daily.jsx';
import { MoneyBanner } from '../components/money.jsx';
import { Tone } from '../components/sales.jsx';
import { RowActions } from '../components/settings.jsx';
import { QuestionnaireBuilder } from '../components/QuestionnaireBuilder.jsx';
import { SettingsPane } from './SettingsArea.jsx';
import { api } from '../lib/api.js';
import { invalidateLookups, useFetch, useList } from '../lib/hooks.js';

/**
 * Settings › Lists › Templates (#26), Wave 8.
 *
 * A chooser, then one kind at a time, each at its own address
 * (/settings/templates/payment, /onboarding, /terms, /questionnaires) with its own crumb.
 * The 100% warning sits on the template that is off; Delete buttons are
 * labelled; onboarding's Owner says "People team (HR)", which is not the
 * HR (travel) sign-in role. The quotation PDF, cover email and overdue
 * reminder are built in code, so they are not rows here.
 */

const TRIGGER = { 'On PO Registration': 'On PO registration', 'On Delivery': 'On delivery', 'On Milestone': 'On milestone', Manual: 'By hand' };
const OWNER = { HR: 'People team (HR)' };

const PAYMENT = {
  key: 'payment',
  icon: IndianRupee,
  label: 'Payment schedules',
  meta: 'offered when a PO is registered',
  hint: 'Each line is a payment stage. Percentages must add up to 100. Credit days left blank: the PO’s payment terms apply.',
  noun: 'payment schedule',
  lineNoun: 'line',
  resource: 'payment-terms-templates',
  lineResource: 'payment-terms-template-lines',
  lineColumns: [
    { key: 'sort_order', header: '#', num: true, width: '48px', render: (l) => <span className="text-muted-foreground">{l.sort_order}</span> },
    { key: 'stage_name', header: 'Stage', render: (l) => <b>{l.stage_name}</b> },
    { key: 'percent', header: '%', num: true, render: (l) => <b>{Number(l.percent)}%</b> },
    { key: 'trigger_event', header: 'Trigger', render: (l) => TRIGGER[l.trigger_event] || l.trigger_event },
    { key: 'credit_days', header: 'Credit days', num: true, render: (l) => l.credit_days ?? <span className="text-muted-foreground">PO terms</span> },
    { key: 'milestone_name', header: 'Milestone', className: 'app-wrap--sm', render: (l) => l.milestone_name || <span className="text-muted-foreground">—</span> },
  ],
  linePhone: (l) => ({ title: `${l.sort_order}. ${l.stage_name}`, amount: `${Number(l.percent)}%`, meta: [TRIGGER[l.trigger_event] || l.trigger_event, `credit ${l.credit_days ?? 'PO terms'}`, l.milestone_name].filter(Boolean).join(' · ') }),
  lineName: (l) => `line ${l.sort_order}, “${l.stage_name}”`,
  lineFields: (templateId, next) => [
    { name: 'template_id', type: 'hidden', default: templateId },
    { name: 'sort_order', label: 'Order', type: 'number', default: next },
    { name: 'stage_name', label: 'Stage name', required: true },
    { name: 'percent', label: 'Percent', type: 'number', required: true, step: '0.5' },
    { name: 'trigger_event', label: 'Trigger', type: 'select', options: Object.entries(TRIGGER).map(([value, label]) => ({ value, label })), default: 'On PO Registration', required: true },
    { name: 'credit_days', label: 'Credit days', type: 'number', hint: 'Blank: the PO’s payment terms.' },
    { name: 'milestone_name', label: 'Milestone', hint: 'For On milestone stages: what has to happen.' },
  ],
  total: (lines) => lines.reduce((n, l) => n + Number(l.percent), 0),
};

const ONBOARDING = {
  key: 'onboarding',
  icon: ListChecks,
  label: 'Onboarding checklists',
  meta: 'the steps a new project starts with',
  hint: 'Each line is a step on a new project’s checklist. Days after start set the step’s target date.',
  noun: 'onboarding checklist',
  lineNoun: 'step',
  resource: 'onboarding-templates',
  lineResource: 'onboarding-template-lines',
  lineColumns: [
    { key: 'step_no', header: '#', num: true, width: '48px', render: (l) => <span className="text-muted-foreground">{l.step_no}</span> },
    { key: 'stage', header: 'Stage', render: (l) => <span className="text-secondary-text">{l.stage || '—'}</span> },
    { key: 'step', header: 'Step', className: 'app-wrap', render: (l) => <b>{l.step}</b> },
    { key: 'owner_role', header: 'Owner', render: (l) => OWNER[l.owner_role] || l.owner_role || '—' },
    { key: 'days_after_start', header: 'Days after start', num: true, render: (l) => l.days_after_start ?? '—' },
  ],
  linePhone: (l) => ({ title: `${l.step_no}. ${l.step}`, amount: l.days_after_start != null ? `day ${l.days_after_start}` : '', meta: [l.stage, OWNER[l.owner_role] || l.owner_role].filter(Boolean).join(' · ') }),
  lineName: (l) => `step ${l.step_no}, “${l.step}”`,
  lineFields: (templateId, next) => [
    { name: 'template_id', type: 'hidden', default: templateId },
    { name: 'step_no', label: 'Step number', type: 'number', required: true, default: next },
    { name: 'stage', label: 'Stage', type: 'select', options: ['Onboarding', 'Execution', 'Delivery', 'Closure'] },
    { name: 'step', label: 'Step', required: true, span: 'all' },
    { name: 'owner_role', label: 'Owner', type: 'select', options: ['Sales', 'Finance', 'Delivery', { value: 'HR', label: 'People team (HR)' }, 'Admin'], hint: 'Who does the step. Not the same as the HR (travel) sign-in role.' },
    { name: 'days_after_start', label: 'Days after start', type: 'number' },
  ],
};

const TERMS = { key: 'terms', icon: AlignLeft, label: 'Default terms', meta: 'Printed on every quotation that doesn’t set its own', hint: 'Printed on every quotation that doesn’t set its own.' };

const QUESTIONNAIRES = { key: 'questionnaires', icon: ClipboardList, label: 'Questionnaires', meta: 'what a client is asked before we quote, one per service', hint: 'What a client is asked before we quote, one form per service. Staff send it from an enquiry; the client fills it in from a link, on any device.' };

const crumbs = [{ label: 'Lists' }, { label: 'Templates', to: '/settings/templates' }];
const back = { to: '/settings/templates', label: 'Templates' };
const allBtn = <Link to="/settings/templates" className="mg-btn"><ChevronLeft className="size-4" aria-hidden="true" />All templates</Link>;

export default function Templates() {
  return (
    <Routes>
      <Route index element={<Chooser />} />
      <Route path="payment" element={<TemplateSet kind={PAYMENT} />} />
      <Route path="onboarding" element={<TemplateSet kind={ONBOARDING} />} />
      <Route path="terms" element={<DefaultTerms />} />
      <Route path="questionnaires" element={<Questionnaires />} />
      <Route path="*" element={<Navigate to="/settings/templates" replace />} />
    </Routes>
  );
}

function Chooser() {
  const payment = useList('payment-terms-templates', { limit: 200 });
  const lines = useList('payment-terms-template-lines', { limit: 1000 });
  const onboarding = useList('onboarding-templates', { limit: 200 });
  const questionnaires = useFetch(() => api.raw('/questionnaires'), []);
  const qRows = questionnaires.data?.data;
  const qDrafts = (qRows || []).filter((q) => q.draft).length;
  const qMeta = questionnaires.error ? 'Couldn’t count them · ' : qRows ? `${qRows.length} questionnaire${qRows.length === 1 ? '' : 's'} · ` : '';
  const off = payment.rows.filter((t) => Math.abs(PAYMENT.total(lines.rows.filter((l) => l.template_id === t.id)) - 100) > 0.01).length;
  // A failed count says so: "0 templates" would read as none set up.
  const meta = (n, kind) => {
    const list = kind === 'payment' ? payment : onboarding;
    if (list.error) return 'Couldn’t count them · ';
    return n === undefined || (list.loading && !list.data) ? '' : `${n} template${n === 1 ? '' : 's'} · `;
  };
  const kinds = [
    { ...PAYMENT, line: `${meta(payment.total, 'payment')}${PAYMENT.meta}`, badge: off ? `${off} need${off === 1 ? 's' : ''} fixing` : null },
    { ...ONBOARDING, line: `${meta(onboarding.total, 'onboarding')}${ONBOARDING.meta}` },
    { ...TERMS, line: TERMS.meta },
    { ...QUESTIONNAIRES, line: `${qMeta}${QUESTIONNAIRES.meta}`, badge: qDrafts ? `${qDrafts} draft${qDrafts === 1 ? '' : 's'}` : null, badgeTone: 'plain' },
  ];
  return (
    <SettingsPane
      title="Templates"
      description="The payment splits and onboarding steps a new order starts from, the terms printed on every quotation, and the questionnaires a client fills in before we quote. Pick the one you came to change."
    >
      <nav className="mg-glass mg-glass--strong set-kinds" data-a="rise" aria-label="Kinds of template">
        {kinds.map((k) => {
          const Icon = k.icon;
          return (
            <Link key={k.key} to={`/settings/templates/${k.key}`} className="set-kind">
              <span className="set-kind__icon"><Icon aria-hidden="true" /></span>
              <span className="set-kind__text"><b>{k.label}</b><small>{k.line}</small></span>
              {k.badge && <Tone tone={k.badgeTone || 'late'}>{k.badge}</Tone>}
              <ChevronRight aria-hidden="true" />
            </Link>
          );
        })}
      </nav>
      <p className="mg-glass set-note" data-a="rise">
        The quotation PDF is laid out in code, and the cover email and overdue reminder are built by the routes that send them, so none of the three is edited here.
      </p>
    </SettingsPane>
  );
}

/** The questionnaire builder (#208), in a pane like the other kinds. */
function Questionnaires() {
  return (
    <QuestionnaireBuilder
      pane={(actions, body) => (
        <SettingsPane title={QUESTIONNAIRES.label} description={QUESTIONNAIRES.hint} crumbs={crumbs} back={back} actions={<>{allBtn}{actions}</>}>
          {body}
        </SettingsPane>
      )}
    />
  );
}

/** The terms printed on every quotation, which live in settings. */
function DefaultTerms() {
  const toast = useToast();
  const { data, loading, error, refetch } = useFetch(() => api.raw('/lookups'));
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  const stored = data?.data?.settings?.quotation_terms_default ?? '';
  const value = draft ?? stored;
  const dirty = draft !== null && draft !== stored;

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

  return (
    <SettingsPane title="Default terms" description={TERMS.hint} crumbs={crumbs} back={back} actions={allBtn}>
      {error ? <FailedCard title="Couldn’t load the default terms" text="The server didn’t answer, so nothing is shown. Nothing has changed. Try again in a moment." onRetry={refetch} />
      : loading && !data ? <LoadingPanel rows={3} />
      : (
        <section className="mg-glass mg-glass--strong mg-panel" data-a="rise" aria-label="Default terms">
          <label className="mg-field">
            <span className="mg-field__label">Default quotation terms</span>
            <textarea className="mg-textarea" rows={9} value={value} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
            <button type="button" className="mg-btn mg-btn--primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save terms'}</button>
            {dirty && !busy && <button type="button" className="mg-btn mg-btn--ghost" onClick={() => setDraft(null)}>Discard</button>}
            <span className={cn('text-[13px]', dirty ? 'font-semibold text-caramel-text' : 'text-secondary-text')}>
              {dirty ? 'The terms have changed. Save, or they’re lost when you leave.' : 'A quotation that already has its own terms keeps them; this is what a new one starts with.'}
            </span>
          </div>
        </section>
      )}
    </SettingsPane>
  );
}

function TemplateSet({ kind }) {
  const { label, hint, noun, lineNoun, resource, lineResource, lineColumns, lineFields, lineName, linePhone, total } = kind;
  const toast = useToast();
  const [open, setOpen] = useState(() => new Set());
  const [editing, setEditing] = useState(null);       // template record | 'new'
  const [line, setLine] = useState(null);             // { template, record | null }
  const [removing, setRemoving] = useState(null);     // { kind: 'template' | 'line', record, template }
  const [busy, setBusy] = useState(false);
  const templates = useFetch(() => api.list(resource, { limit: 200 }), []);
  const lines = useFetch(() => api.list(lineResource, { limit: 1000 }), []);
  const rows = templates.data?.data ?? [];
  const linesOf = (t) => (lines.data?.data ?? []).filter((l) => l.template_id === t.id);
  const refresh = () => { templates.refetch(); lines.refetch(); invalidateLookups(); };
  const isOpen = (t, i) => (open.has(t.id) ? true : open.has(-t.id) ? false : i === 0);
  const toggle = (t, i) => setOpen((s) => { const n = new Set(s); n.delete(t.id); n.delete(-t.id); n.add(isOpen(t, i) ? -t.id : t.id); return n; });

  async function remove() {
    setBusy(true);
    try {
      await api.remove(removing.kind === 'template' ? resource : lineResource, removing.record.id);
      toast(removing.kind === 'template' ? 'Template deleted' : `${lineNoun[0].toUpperCase()}${lineNoun.slice(1)} deleted`, 'success');
      setRemoving(null);
      refresh();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setBusy(false); }
  }

  const headerFields = [
    { name: 'name', label: 'Name', required: true, span: 'all' },
    { name: 'is_default', label: 'Default', type: 'boolean', default: 'false', hint: resource === 'onboarding-templates' ? 'Offered first when a project starts' : 'Offered first when a PO is registered' },
    { name: 'active', label: 'Active', type: 'boolean', default: 'true', hint: 'Inactive templates aren’t offered' },
    { name: 'sort_order', label: 'Order', type: 'number', default: 0, hint: 'Lower comes first in the list.' },
  ];
  const nextNo = (t) => linesOf(t).reduce((n, l) => Math.max(n, Number(l.sort_order ?? l.step_no) || 0), 0) + 1;
  const sumText = (t) => {
    const tl = linesOf(t);
    const count = `${tl.length} ${lineNoun}${tl.length === 1 ? '' : 's'}`;
    if (!total) return { text: count };
    const sum = total(tl);
    const off = Math.abs(sum - 100) > 0.01;
    return { text: `${count} · adds up to ${sum}%${off ? ', not 100%' : ''}`, off, sum };
  };
  const removingSum = removing?.kind === 'line' && total ? total(linesOf(removing.template).filter((l) => l.id !== removing.record.id)) : null;

  return (
    <SettingsPane
      title={label}
      description={hint}
      crumbs={crumbs}
      back={back}
      actions={<>{allBtn}<button type="button" className="mg-btn mg-btn--primary" onClick={() => setEditing('new')}><Plus className="size-4" aria-hidden="true" />Add template</button></>}
    >
      {templates.error ? <FailedCard title={`Couldn’t load the ${label.toLowerCase()}`} text="The server didn’t answer, so nothing is shown. Nothing has changed. Try again in a moment." onRetry={refresh} />
      : templates.loading && !templates.data ? <LoadingPanel rows={3} />
      : rows.length === 0 ? (
        <StateCard tone="plain" title="No templates yet" text="A template is a named set of lines reused every time: the payment split on a new order, or the checklist on a new project.">
          <button type="button" className="mg-btn mg-btn--primary mg-btn--sm" onClick={() => setEditing('new')}>Add template</button>
        </StateCard>
      ) : (
        <section className="mg-glass mg-glass--strong set-tset" data-a="rise" aria-label={label}>
          {rows.map((t, i) => {
            const tl = linesOf(t);
            const s = sumText(t);
            const shown = isOpen(t, i);
            return (
              <div key={t.id} className="set-tpl">
                <div className="set-tpl__head">
                  <div className="set-tpl__title">
                    <div>
                      <h2>{t.name}</h2>
                      {t.is_default && <Tone tone="info">Default</Tone>}
                      {!t.active && <Tone>Inactive</Tone>}
                    </div>
                    <span className={cn('set-tpl__sub', s.off && 'is-late')}>{s.text}</span>
                  </div>
                  <span className="flex flex-wrap gap-1.5">
                    <button type="button" className={cn('mg-btn mg-btn--sm', s.off && 'mg-btn--primary')} aria-label={`Add a ${lineNoun} to ${t.name}`} onClick={() => setLine({ template: t, record: null })}>Add {lineNoun}</button>
                    <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>Edit</button>
                    <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-expanded={shown} aria-label={`${shown ? 'Hide' : 'Show'} the ${lineNoun}s of ${t.name}`} onClick={() => toggle(t, i)}>{shown ? `Hide ${lineNoun}s` : `Show ${lineNoun}s`}</button>
                    <button type="button" className="mg-btn mg-btn--sm mg-btn--ghost" aria-label={`Delete ${t.name}`} onClick={() => setRemoving({ kind: 'template', record: t })}>Delete</button>
                  </span>
                </div>
                {s.off && (
                  <MoneyBanner tone="late" title="Can’t be used to register a PO yet.">
                    {' '}Its lines add up to {s.sum}%. Change a line, or add one for the missing {Math.round((100 - s.sum) * 100) / 100}%.
                  </MoneyBanner>
                )}
                {shown && (
                  tl.length === 0 ? (
                    <div className="set-tpl__lines">
                      <StateCard inPanel bordered={false} tone="plain" title={`No ${lineNoun}s yet`} text={`Add the first ${lineNoun}; the template is used as it stands.`}>
                        <button type="button" className="mg-btn mg-btn--sm" onClick={() => setLine({ template: t, record: null })}>Add {lineNoun}</button>
                      </StateCard>
                    </div>
                  ) : (
                    <div className="set-tpl__lines">
                      <ListTable
                        bordered={false}
                        label={`${lineNoun === 'step' ? 'Steps' : 'Lines'} of ${t.name}`}
                        rows={tl}
                        columns={[...lineColumns, { key: 'act', header: '', className: 'actions', render: (l) => (
                          <RowActions>
                            <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Edit ${lineName(l)}`} onClick={() => setLine({ template: t, record: l })}>Edit</button>
                            <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete ${lineName(l)}`} onClick={() => setRemoving({ kind: 'line', record: l, template: t })}>Delete</button>
                          </RowActions>
                        ) }]}
                        phone={(l) => {
                          const p = linePhone(l);
                          return (
                            <PhoneRow title={p.title} amount={p.amount} meta={p.meta} wraps>
                              <span className="set-rowacts">
                                <button type="button" className="mg-btn mg-btn--sm" aria-label={`Edit ${lineName(l)}`} onClick={() => setLine({ template: t, record: l })}>Edit</button>
                                <button type="button" className="mg-btn mg-btn--ghost mg-btn--sm" aria-label={`Delete ${lineName(l)}`} onClick={() => setRemoving({ kind: 'line', record: l, template: t })}>Delete</button>
                              </span>
                            </PhoneRow>
                          );
                        }}
                      />
                    </div>
                  )
                )}
              </div>
            );
          })}
        </section>
      )}

      {editing && (
        <RecordForm
          title={editing === 'new' ? `New ${noun} template` : 'Edit template'}
          subtitle={editing === 'new' ? `Add its ${lineNoun}s next` : `${editing.name} · ${sumText(editing).text}`}
          submitLabel={editing === 'new' ? 'Add template' : 'Save changes'}
          resource={resource}
          fields={headerFields}
          record={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {line && (
        <RecordForm
          title={line.record ? `Edit ${lineName(line.record)}` : `Add a ${lineNoun} to ${line.template.name}`}
          subtitle={sumText(line.template).text}
          submitLabel={line.record ? 'Save changes' : `Add ${lineNoun}`}
          size="lg"
          resource={lineResource}
          fields={lineFields(line.template.id, nextNo(line.template))}
          record={line.record}
          onClose={() => setLine(null)}
          onSaved={refresh}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={removing.kind === 'template' ? `Delete “${removing.record.name}”?` : `Delete ${lineName(removing.record)}?`}
          subtitle={removing.kind === 'template' ? `${noun[0].toUpperCase()}${noun.slice(1)} · ${sumText(removing.record).text.split(' · ')[0]}` : removing.template.name}
          message={removing.kind === 'template'
            ? `Its ${lineNoun}s go with it. ${resource === 'onboarding-templates' ? 'Projects' : 'POs'} already started from it are not affected.`
            : `The template changes for future ${resource === 'onboarding-templates' ? 'projects' : 'POs'} only.${removingSum != null && Math.abs(removingSum - 100) > 0.01 ? ` Afterwards its lines add up to ${removingSum}%, so add another before it’s used again.` : ''}`}
          confirmLabel={removing.kind === 'template' ? 'Delete template' : `Delete ${lineNoun}`}
          cancelLabel="Keep it"
          onConfirm={remove}
          onClose={() => setRemoving(null)}
          busy={busy}
        />
      )}
    </SettingsPane>
  );
}
