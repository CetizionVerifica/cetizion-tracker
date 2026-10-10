import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { ClipboardList, FileText, Flag, FolderKanban, Plane } from 'lucide-react';
import { cn } from 'cn';
import {
  Chip, RailPerson, RecordFlow, RecordMenuItem, RecordPage, RecordRow, RecordSection, RecordStat, flowSteps,
} from '../components/record.jsx';
import { Checklist } from '../components/checklist.jsx';
import { Button } from '../components/ui/button.tsx';
import { ErrorState, useToast, ConfirmDialog } from '../components/ui.jsx';
import { RecordForm } from '../components/RecordForm.jsx';
import { Timeline } from '../components/Timeline.jsx';
import { ProjectProfit } from '../components/ProjectProfit.jsx';
import { ProjectVisits } from './Schedule.jsx';
import { DeliverablesTable } from '../components/Deliverables.jsx';
import { api } from '../lib/api.js';
import { useFetch, useLookups } from '../lib/hooks.js';
import { money, date, number } from '../lib/format.js';
import { poCurrencyFields } from '../lib/poCurrency.js';
import { poRevisionFields } from '../lib/poRevision.js';

/**
 * The project record (C15) — the onboarding checklist is the page, not a
 * tab on it.
 *
 * What was here before: a details card, then five tabs, the first of which
 * was an eleven-column table of purchase orders. The checklist — the only
 * thing on this page that says whether the project is actually moving —
 * was the third tab, behind a click, rendered as a table with five buttons
 * per row.
 *
 * Now the checklist is the column, and four of its eleven steps are not
 * ticked by anyone: the PO register and the payment schedule answer them
 * (see server/src/lib/onboarding.js). Purchase orders become a list that
 * links to the order record, which is where stages belong (C6). The
 * project manager keeps exactly one button, the delivery date, because it
 * is the only fact on this page that moves money.
 */

/** The template's four stages, in order, as the ladder across the top. */
const LIFECYCLE = ['Onboarding', 'Execution', 'Delivery', 'Closure'];

export default function ProjectDetail() {
  const { projectId } = useParams();
  const toast = useToast();
  const lookups = useLookups();
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useFetch(
    () => api.raw(`/projects/${encodeURIComponent(projectId)}/full`),
    [projectId]
  );

  if (error) {
    return (
      <>
        <PageHeader title={projectId} />
        <div className="page"><ErrorState message={error} onRetry={refetch} /></div>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title={projectId} />
        <div className="page"><div className="skeleton h-[200px]" /></div>
      </>
    );
  }

  const {
    project: p, purchase_orders: pos, payment_stages: stages,
    onboarding, onboarding_progress: progress, travel, quotations, milestones = [],
  } = data.data;

  // One currency across every PO on the project, or null when they differ.
  const mixed = p.po_count > 0 && !p.currency;
  const amount = (v) => (mixed ? '—' : money(v, p.currency || 'INR'));

  const close = () => setDialog(null);
  const done = () => { close(); refetch(); };

  async function applyTemplate() {
    setBusy(true);
    try {
      const result = await api.action(`/projects/${encodeURIComponent(projectId)}/onboarding/apply-template`, {
        owner: p.project_manager,
        owner_email: p.project_manager_email,
      });
      toast(result.added ? `Added ${result.added} steps` : 'Checklist already applied', result.added ? 'success' : 'default');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  async function toggleStep(step) {
    const next = step.status === 'Done' ? 'Not Started' : 'Done';
    try {
      await api.update('onboarding', step.id, {
        status: next,
        completed_date: next === 'Done' ? new Date().toISOString().slice(0, 10) : null,
      });
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /** Reaching a milestone makes the stages it triggers billable (#26). */
  async function markMilestone(m, reached) {
    try {
      await api.update('project-milestones', m.id, { reached_on: reached ? new Date().toISOString().slice(0, 10) : null });
      toast(reached ? `${m.name} reached${m.stages.length ? ': its stages can be invoiced' : ''}` : `${m.name} marked not reached`, 'success');
      refetch();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  async function deleteStep(step) {
    setBusy(true);
    try {
      await api.remove('onboarding', step.id);
      toast('Step removed', 'success');
      done();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  // A lifecycle stage is done when every step under it is. Stages the
  // template never used are left out rather than drawn as a gap.
  const used = LIFECYCLE.filter((stage) => onboarding.some((s) => s.stage === stage));
  const ladder = flowSteps(used.map((stage) => {
    const steps = onboarding.filter((s) => s.stage === stage && s.effective_status !== 'N/A');
    return { label: stage, done: steps.length > 0 && steps.every((s) => s.effective_status === 'Done') };
  }));

  // What recording the delivery date would actually do, in money. The
  // design's sentence, computed rather than written: it is the reason the
  // button is the only one on the page.
  const unlocked = stages
    .filter((s) => s.trigger_event === 'On Delivery' && !s.invoice_no)
    .reduce((sum, s) => sum + Number(s.stage_amount || 0), 0);

  const verdict = p.actual_delivery_date
    ? `Delivered ${date(p.actual_delivery_date)}${p.delivery_variance_days > 0 ? `, ${p.delivery_variance_days} days after the plan` : ''}. ${p.balance_due_now > 0 ? `${amount(p.balance_due_now)} is still owed.` : 'Nothing is owed.'}`
    : unlocked > 0
      ? `Recording the delivery date closes the delivery step and makes ${amount(unlocked)} of on-delivery stages billable.`
      : 'Recording the delivery date closes the delivery step. No stage on this project is triggered by delivery, so nothing becomes billable with it.';

  const stepFields = checklistFields(onboarding, lookups);
  const nextStepNo = onboarding.reduce((max, s) => Math.max(max, Number(s.step_no) || 0), 0) + 1;

  return (
    <>
      <RecordPage
        parent="Projects"
        parentTo="/projects"
        title={`${p.project_id} · ${p.client_name}`}
        mark={<FolderKanban className="size-5" strokeWidth={1.75} aria-hidden="true" />}
        facts={[
          p.primary_service,
          p.project_manager && `PM ${p.project_manager}`,
          p.planned_delivery_date && `Planned delivery ${date(p.planned_delivery_date)}`,
          /* The stage, not the money: this project is "In Progress" even
             when an invoice on it is overdue, and colouring the stage red
             for that says the wrong thing twice. Late money is red in the
             figures below, where it belongs. */
          <Chip key="stage" tone={p.actual_delivery_date ? 'settled' : 'plain'}>{p.project_stage}</Chip>,
          ...[...new Set(pos.map((po) => po.partner_name).filter(Boolean))].map((name) => <Chip key={`partner-${name}`}>Through {name}</Chip>),
        ]}
        /* No button in the header: the one move this page offers is in the
           band below, next to the sentence explaining what it will do. Two
           copies of it read as two different buttons. */
        menu={(
          <>
            <RecordMenuItem onSelect={() => setDialog({ type: 'newPo' })}>Add a purchase order</RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'newStep' })}>Add a checklist step</RecordMenuItem>
            <RecordMenuItem onSelect={() => setDialog({ type: 'edit' })}>Edit the project</RecordMenuItem>
          </>
        )}
        flow={(
          <RecordFlow
            steps={ladder}
            verdict={verdict}
            actions={p.actual_delivery_date
              ? <Button variant="secondary" onClick={() => setDialog({ type: 'edit' })}>Edit the project</Button>
              : <Button onClick={() => setDialog({ type: 'edit' })}>Record the delivery date</Button>}
            note={progress?.total
              ? `Onboarding · ${progress.done} of ${progress.total} done${progress.left ? ` · ${progress.left} left` : ''}${progress.waiting ? `, ${progress.waiting} of them with another team` : ''}.`
              : 'No checklist on this project yet.'}
          />
        )}
        stats={(
          <>
            {/* Sums across the project's POs, so they only read in one
                currency. v_projects gives it, or null when the POs disagree
                — then the amount is withheld rather than shown with the
                wrong symbol, and the orders list below shows each properly. */}
            <RecordStat
              label="Contract"
              value={amount(p.total_contract_value)}
              detail={mixed ? 'Orders in different currencies' : `${amount(p.total_invoiced)} invoiced`}
            />
            <RecordStat
              label="Due now"
              value={amount(p.balance_due_now)}
              tone={p.balance_due_now > 0 ? 'late' : 'settled'}
              detail={p.balance_due_now > 0 ? 'Invoiced and unpaid' : p.payment_status}
            />
            <RecordStat
              label="To bill"
              value={amount(p.balance_to_bill)}
              tone={p.balance_to_bill > 0 ? 'waiting' : undefined}
              detail={p.balance_to_bill > 0 ? 'Stages not yet invoiced' : 'Everything is invoiced'}
            />
            <RecordStat
              label="Travel so far"
              value={money(p.total_travel_cost)}
              detail={travel.length ? `${number(travel.length)} trip${travel.length === 1 ? '' : 's'}` : 'Nobody has travelled yet'}
            />
          </>
        )}
        rail={(
          <>
            <RecordSection title="Trips" hint={travel.length ? `${money(p.total_travel_cost)} so far` : undefined}>
              {travel.length === 0
                ? <p className="px-5 py-4 text-[12.5px] text-muted-foreground">No travel recorded against this project.</p>
                : travel.map((t, i) => (
                  <RecordRow
                    key={t.travel_id}
                    icon={Plane}
                    to={`/travel/${encodeURIComponent(t.travel_id)}`}
                    title={`${t.travel_id} · ${t.employee_name}`}
                    chip={t.vendor_invoice_status !== 'Invoiced' ? <Chip tone="waiting">{t.vendor_invoice_status}</Chip> : undefined}
                    amount={money(t.total_travel_cost)}
                    last={i === travel.length - 1}
                  />
                ))}
            </RecordSection>

            <RecordSection title="People">
              <RailPerson name={p.project_manager || 'Not assigned'} detail="Project manager" />
              <RailPerson name={p.sales_person || 'Not recorded'} detail="Sold it" last />
            </RecordSection>

            {quotations.length > 0 && (
              <RecordSection title="Quoted as">
                {quotations.map((q, i) => (
                  <RecordRow
                    key={q.quotation_no}
                    icon={FileText}
                    to={`/quotations/${encodeURIComponent(q.quotation_no)}`}
                    title={q.quotation_no}
                    amount={money(q.quotation_value, q.currency)}
                    last={i === quotations.length - 1}
                  />
                ))}
              </RecordSection>
            )}
          </>
        )}
      >
        <RecordSection
          title="Checklist"
          hint={onboarding.length ? 'The standard eleven, from the template' : undefined}
          action={onboarding.length === 0
            ? <Button size="sm" onClick={applyTemplate} disabled={busy}>Add the standard checklist</Button>
            : <Button variant="secondary" size="sm" onClick={() => setDialog({ type: 'newStep' })}>Add a step</Button>}
        >
          {onboarding.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              Nothing to work through yet. The standard checklist is eleven steps, four of which
              answer themselves from the purchase orders and the payment schedule.
            </p>
          ) : (
            <Checklist
              steps={onboarding}
              onToggle={toggleStep}
              onEdit={(step) => setDialog({ type: 'editStep', row: step })}
              onDelete={(step) => setDialog({ type: 'deleteStep', row: step })}
            />
          )}
        </RecordSection>

        <RecordSection
          title="Milestones"
          hint={milestones.length ? 'Reaching one makes the payment stages it triggers billable' : undefined}
          action={<Button variant="secondary" size="sm" onClick={() => setDialog({ type: 'milestone' })}>Add a milestone</Button>}
        >
          {milestones.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              No milestones. A payment stage triggered On Milestone gets its milestone when the PO is registered; add any other here.
            </p>
          ) : milestones.map((m, i) => {
            const waiting = m.stages.filter((s) => !s.invoice_no).reduce((n, s) => n + Number(s.stage_amount || 0), 0);
            return (
              <div key={m.id} className={cn('flex flex-wrap items-center gap-3 px-5 py-3', i < milestones.length - 1 && 'border-b border-border')}>
                <Flag className="size-4 shrink-0 text-secondary-text" strokeWidth={1.75} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-foreground">{m.name}</div>
                  <div className="text-[12px] text-muted-foreground">
                    {[m.target_date && `Target ${date(m.target_date)}`,
                      m.stages.length ? `Triggers ${m.stages.map((s) => `${s.stage_name} on ${s.po_number}`).join(', ')}` : 'No payment stage waits on it'].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {m.reached_on
                  ? <Chip tone="settled">Reached {date(m.reached_on)}</Chip>
                  : waiting > 0 ? <Chip tone="waiting">{amount(waiting)} waiting on it</Chip> : null}
                <Button variant={m.reached_on ? 'ghost' : 'secondary'} size="sm" onClick={() => markMilestone(m, !m.reached_on)}>
                  {m.reached_on ? 'Not reached' : 'Mark reached'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDialog({ type: 'milestone', row: m })}>Edit</Button>
              </div>
            );
          })}
        </RecordSection>

        <RecordSection
          title="Purchase orders"
          hint={pos.length ? 'Stages, invoices and payments live on the order' : undefined}
          action={<Button variant="secondary" size="sm" onClick={() => setDialog({ type: 'newPo' })}>Add an order</Button>}
        >
          {pos.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-muted-foreground">
              No purchase order yet, so nothing can be invoiced. Register it and the advance stage becomes billable.
            </p>
          ) : pos.map((po, i) => (
            <RecordRow
              key={po.po_number}
              icon={ClipboardList}
              to={`/purchase-orders/${encodeURIComponent(po.po_number)}`}
              title={`${po.po_number} · ${po.stage_count} stage${Number(po.stage_count) === 1 ? '' : 's'}`}
              chip={po.balance_due_now > 0
                ? <Chip tone="late">{money(po.balance_due_now, po.currency)} due</Chip>
                : po.balance_to_bill > 0 ? <Chip tone="waiting">{money(po.balance_to_bill, po.currency)} to bill</Chip>
                  : <Chip tone="settled">Settled</Chip>}
              amount={money(po.po_value, po.currency)}
              last={i === pos.length - 1}
            />
          ))}
        </RecordSection>

        <DeliverablesTable
          params={{ project_id: projectId }}
          preset={{ project_id: projectId }}
          compact
          title="Certificate"
          hint="An expiry date schedules the renewal ninety days before it"
        />
        <ProjectVisits projectId={projectId} />
        <ProjectProfit projectId={projectId} />
        <Timeline entity="project" id={projectId} />
      </RecordPage>

      {dialog?.type === 'milestone' && (
        <RecordForm
          title={dialog.row ? 'Edit milestone' : 'Add a milestone'}
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          resource="project-milestones"
          record={dialog.row || { project_id: p.project_id, sort_order: milestones.length }}
          onClose={close}
          onSaved={refetch}
          fields={[
            { name: 'project_id', type: 'hidden' },
            { name: 'name', label: 'Milestone', required: true, span: 2, placeholder: 'Stage 1 audit complete' },
            { name: 'target_date', label: 'Target date', type: 'date' },
            { name: 'reached_on', label: 'Reached on', type: 'date', hint: 'Blank until it happens' },
          ]}
        />
      )}

      {dialog?.type === 'newStep' && (
        <RecordForm
          title="Add a checklist step"
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          resource="onboarding"
          record={{
            project_id: p.project_id,
            step_no: nextStepNo,
            stage: 'Onboarding',
            status: 'Not Started',
            owner: p.project_manager,
            owner_email: p.project_manager_email,
          }}
          intro="A step you add is yours to tick. The template's money steps read the payment schedule instead."
          onClose={close}
          onSaved={refetch}
          fields={stepFields}
        />
      )}

      {dialog?.type === 'editStep' && (
        <RecordForm
          title="Edit the step"
          subtitle={`Step ${dialog.row.step_no} of ${p.project_id}`}
          resource="onboarding"
          record={dialog.row}
          onClose={close}
          onSaved={refetch}
          fields={stepFields}
        />
      )}

      {dialog?.type === 'deleteStep' && (
        <ConfirmDialog
          title="Remove this step?"
          message={`"${dialog.row.step}" will be removed from ${p.project_id}. The checklist count will recalculate.`}
          confirmLabel="Remove step"
          busy={busy}
          onConfirm={() => deleteStep(dialog.row)}
          onClose={close}
        />
      )}

      {dialog?.type === 'edit' && (
        <RecordForm
          title={p.actual_delivery_date ? 'Edit project' : 'Record the delivery date'}
          resource="projects"
          record={p}
          onClose={close}
          onSaved={refetch}
          intro={p.actual_delivery_date ? undefined : verdict}
          fields={[
            { name: 'actual_delivery_date', label: 'Delivered on', type: 'date' },
            { name: 'client_name', label: 'Client', required: true },
            { name: 'primary_service', label: 'Primary service', type: 'combo', options: lookups.services, span: 2 },
            { name: 'project_manager', label: 'Project manager' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'sales_person', label: 'Sales person' },
            { name: 'planned_start_date', label: 'Planned start', type: 'date' },
            { name: 'planned_delivery_date', label: 'Planned delivery', type: 'date' },
            { name: 'service_request_no', label: 'Service request no.', hint: 'e.g. CV108: how a trip with no PO finds this project' },
            { name: 'percent_complete', label: '% complete', type: 'percent' },
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}

      {dialog?.type === 'newPo' && (
        <RecordForm
          title="New purchase order"
          subtitle={`For ${p.project_id} — ${p.client_name}`}
          resource="purchase-orders"
          record={{
            project_id: p.project_id,
            currency: 'INR',
            payment_terms_days: 30,
            // With one won quotation on the project, that is the order this PO fulfils.
            quotation_no: quotations.filter((q) => q.status === 'Won - PO Received').length === 1
              ? quotations.find((q) => q.status === 'Won - PO Received').quotation_no
              : '',
          }}
          onClose={close}
          onSaved={refetch}
          intro="Once the PO date is set, any stage triggered On PO Registration becomes invoiceable straight away."
          fields={[
            { name: 'po_number', label: 'PO number', required: true },
            { name: 'project_id', label: 'Project', required: true, disabled: true },
            {
              name: 'quotation_no',
              label: 'Won quotation',
              type: 'select',
              options: quotations
                .filter((q) => q.status === 'Won - PO Received')
                .map((q) => ({ value: q.quotation_no, label: `${q.quotation_no} — ${money(q.quotation_value, q.currency)}` })),
              hint: 'The order this PO fulfils; revenue counts the PO against it',
              ...poCurrencyFields(quotations).quotation,
            },
            { name: 'po_date', label: 'PO date', type: 'date' },
            { name: 'po_value', label: 'PO value', type: 'money', required: true },
            { name: 'currency', label: 'Currency', type: 'select', options: lookups.enums?.currency || ['INR'], ...poCurrencyFields(quotations).currency },
            { name: 'payment_terms_days', label: 'Payment terms (days)', type: 'number' },
            { name: 'project_manager_email', label: 'Manager email', type: 'email' },
            { name: 'document_id', label: 'PO document', type: 'document', owner: 'purchase-orders', maxBytes: lookups.limits?.document_max_bytes, span: 2 },
            ...poRevisionFields(lookups.purchase_orders, { projectId: p.project_id }),
            { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
          ]}
        />
      )}
    </>
  );
}

function checklistFields(onboarding, lookups) {
  const stageOptions = Array.from(
    new Set([...LIFECYCLE, ...onboarding.map((s) => s.stage).filter(Boolean)])
  );
  return [
    { name: 'project_id', label: 'Project', required: true, disabled: true },
    { name: 'step_no', label: 'Step number', type: 'number', min: 1, required: true },
    { name: 'stage', label: 'Stage', type: 'combo', options: stageOptions },
    { name: 'status', label: 'Status', type: 'select', options: lookups.enums?.onboarding || ['Not Started', 'In Progress', 'Done', 'N/A'] },
    { name: 'step', label: 'Step', required: true, type: 'textarea', rows: 2, span: 'all' },
    { name: 'owner', label: 'Owner' },
    { name: 'owner_email', label: 'Owner email', type: 'email' },
    { name: 'target_date', label: 'Target date', type: 'date' },
    { name: 'completed_date', label: 'Completed on', type: 'date' },
    { name: 'remarks', label: 'Remarks', type: 'textarea', span: 'all' },
  ];
}
